use super::license_store::LicenseStore;
use super::network_proxy::NetworkProxyStore;
use super::profile_store::PreparedBinary;
use super::runtime_paths::RuntimePaths;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PREPARATION_TIMEOUT: Duration = Duration::from_secs(12 * 60);
const PROGRESS_PREFIX: &str = "NEXUS_KERNEL_PROGRESS ";
const ERROR_PREFIX: &str = "NEXUS_KERNEL_ERROR ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KernelKind {
    Base,
    Latest,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KernelPhase {
    #[default]
    Idle,
    Preparing,
    Downloading,
    Verifying,
    Extracting,
    Retrying,
    Ready,
    Failed,
}

impl KernelPhase {
    fn active(&self) -> bool {
        matches!(
            self,
            Self::Preparing
                | Self::Downloading
                | Self::Verifying
                | Self::Extracting
                | Self::Retrying
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelFailure {
    code: String,
    message: String,
    retryable: bool,
}

impl KernelFailure {
    pub(super) fn operation(message: impl Into<String>) -> Self {
        Self {
            code: "PREPARATION".into(),
            message: message.into(),
            retryable: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KernelProgress {
    phase: KernelPhase,
    percent: Option<f64>,
    downloaded_mb: Option<f64>,
    total_mb: Option<f64>,
    attempt: Option<u8>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelJob {
    kind: Option<KernelKind>,
    phase: KernelPhase,
    percent: Option<f64>,
    downloaded_mb: Option<f64>,
    total_mb: Option<f64>,
    attempt: Option<u8>,
    version: Option<String>,
    error: Option<KernelFailure>,
}

impl KernelJob {
    fn apply(&mut self, progress: KernelProgress) {
        if !self.phase.active() || !progress.phase.active() {
            return;
        }
        self.phase = progress.phase;
        self.percent = progress
            .percent
            .filter(|value| (0.0..=100.0).contains(value));
        self.downloaded_mb = progress
            .downloaded_mb
            .filter(|value| value.is_finite() && *value >= 0.0);
        self.total_mb = progress
            .total_mb
            .filter(|value| value.is_finite() && *value > 0.0);
        if progress.attempt.is_some() {
            self.attempt = progress.attempt;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledKernel {
    pub(crate) version: String,
    pub(crate) kind: KernelKind,
    pub(crate) binary_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KernelInventory {
    cache_dir: String,
    platform: String,
    installed: Vec<InstalledKernel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStatus {
    #[serde(flatten)]
    inventory: KernelInventory,
    activation_configured: bool,
    download: KernelJob,
}

pub struct KernelService {
    runtime: RuntimePaths,
    license_store: LicenseStore,
    network: Option<NetworkProxyStore>,
    operation: Mutex<()>,
    job: Arc<Mutex<KernelJob>>,
    inventory: Mutex<Option<KernelInventory>>,
}

impl KernelService {
    pub(crate) fn installed(&self) -> Result<Vec<InstalledKernel>, String> {
        Ok(self.status(true)?.inventory.installed)
    }

    fn probe_binary(&self, binary_path: &str) -> Result<PreparedBinary, String> {
        let mut command = self.command("version")?;
        command.arg(binary_path);
        let output = run_preparation(&mut command, Duration::from_secs(20), None)?;
        if !output.status.success() {
            return Err("无法验证本机内核版本，导入已停止".into());
        }
        let binary: PreparedBinary = serde_json::from_slice(last_output_line(&output)?)
            .map_err(|_| "无法识别本机内核版本")?;
        if binary.binary_path != Path::new(binary_path) {
            return Err("本机内核路径校验失败，导入已停止".into());
        }
        Ok(binary)
    }

    pub(crate) fn exact_binary(
        &self,
        version: &str,
        kind: KernelKind,
    ) -> Result<PreparedBinary, String> {
        if let Some(binary) = self
            .installed()?
            .iter()
            .find(|entry| entry.version == version && entry.kind == kind)
        {
            return self.probe_binary(&binary.binary_path);
        }
        let binary = self.prepare(kind, Some(version))?;
        // Chrome's --version can omit the SDK package revision.
        if !self.installed()?.iter().any(|entry| {
            entry.version == version
                && entry.kind == kind
                && Path::new(&entry.binary_path) == binary.binary_path
        }) {
            return Err(
                "无法取得窗口原有的精确内核版本，导入已停止；请检查激活码和版本可用性".into(),
            );
        }
        Ok(binary)
    }

    pub fn new(license_store: LicenseStore, runtime: RuntimePaths) -> Self {
        Self {
            license_store,
            runtime,
            network: None,
            operation: Mutex::new(()),
            job: Arc::new(Mutex::new(KernelJob::default())),
            inventory: Mutex::new(None),
        }
    }

    pub fn with_network(mut self, network: NetworkProxyStore) -> Self {
        self.network = Some(network);
        self
    }

    pub fn failure(&self, message: String) -> KernelFailure {
        self.job
            .lock()
            .ok()
            .and_then(|job| job.error.clone())
            .filter(|error| error.message == message)
            .unwrap_or_else(|| KernelFailure::operation(message))
    }

    fn command(&self, action: &str) -> Result<Command, String> {
        if !self.runtime.browser_script.is_file() {
            return Err("安装包缺少浏览器适配器，请重新安装应用".into());
        }
        let mut command = Command::new(&self.runtime.node);
        if action != "inventory"
            && action != "version"
            && let Some(network) = &self.network
        {
            network
                .get()?
                .apply_to_node(&mut command, &self.runtime.network_preload)?;
        }
        command
            .arg(&self.runtime.browser_script)
            .arg(action)
            .env(
                "CLOAKBROWSER_CACHE_DIR",
                self.license_store.browser_cache_dir(),
            )
            .env_remove("CLOAKBROWSER_LICENSE_KEY")
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL")
            .env_remove("CLOAKBROWSER_SKIP_CHECKSUM");
        Ok(command)
    }

    pub fn status(&self, refresh: bool) -> Result<KernelStatus, String> {
        let inventory = {
            let mut inventory = self.inventory.lock().map_err(|_| "内核状态不可用")?;
            if refresh || inventory.is_none() {
                let mut command = self.command("inventory")?;
                let output = run_preparation(&mut command, Duration::from_secs(20), None)?;
                if !output.status.success() {
                    return Err("无法读取本地内核，请刷新后重试".into());
                }
                *inventory = Some(
                    serde_json::from_slice(last_output_line(&output)?)
                        .map_err(|_| "无法识别本地内核信息")?,
                );
            }
            inventory.clone().ok_or("无法读取本地内核")?
        };
        Ok(KernelStatus {
            inventory,
            activation_configured: self.license_store.license_key()?.is_some(),
            download: self.job.lock().map_err(|_| "内核状态不可用")?.clone(),
        })
    }

    /// Settings downloads and window creation share the same SDK cache and lock.
    pub fn prepare(
        &self,
        kind: KernelKind,
        version: Option<&str>,
    ) -> Result<PreparedBinary, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "正在准备浏览器内核，请等待完成后重试")?;
        *self.job.lock().map_err(|_| "内核状态不可用")? = KernelJob {
            kind: Some(kind),
            phase: KernelPhase::Preparing,
            ..KernelJob::default()
        };
        let result = self.prepare_inner(kind, version);
        let mut job = self.job.lock().map_err(|_| "内核状态不可用")?;
        match &result {
            Ok(binary) => {
                job.phase = KernelPhase::Ready;
                job.version = Some(binary.version.clone());
                job.percent = None;
                job.error = None;
            }
            Err(message) => {
                job.phase = KernelPhase::Failed;
                // The message is produced by this service or our structured Node protocol.
                job.error.get_or_insert(KernelFailure {
                    code: "PREPARATION".into(),
                    message: message.clone(),
                    retryable: true,
                });
            }
        }
        drop(job);
        *self.inventory.lock().map_err(|_| "内核状态不可用")? = None;
        result
    }

    fn prepare_inner(
        &self,
        kind: KernelKind,
        version: Option<&str>,
    ) -> Result<PreparedBinary, String> {
        let mut command = self.command("prepare")?;
        command.env(
            "CLOAKBROWSER_AUTO_UPDATE",
            if kind == KernelKind::Latest {
                "true"
            } else {
                "false"
            },
        );
        if kind == KernelKind::Latest {
            let key = self
                .license_store
                .license_key()?
                .ok_or("请先在设置中填写激活码，再下载新版内核")?;
            command.env("CLOAKBROWSER_LICENSE_KEY", key);
        }
        if let Some(version) = version {
            command.env("CLOAKBROWSER_VERSION", version);
        }
        let output = run_preparation(
            &mut command,
            PREPARATION_TIMEOUT,
            Some(Arc::clone(&self.job)),
        )?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            if let Some(failure) = structured_failure(&detail) {
                let message = failure.message.clone();
                self.job.lock().map_err(|_| "内核状态不可用")?.error = Some(failure);
                return Err(message);
            }
            return Err(sanitize_kernel_error(&detail));
        }
        serde_json::from_slice(last_output_line(&output)?)
            .map_err(|_| "无法识别浏览器内核信息".into())
    }
}

fn last_output_line(output: &Output) -> Result<&[u8], String> {
    output
        .stdout
        .split(|byte| *byte == b'\n')
        .rev()
        .find(|line| !line.iter().all(u8::is_ascii_whitespace))
        .ok_or_else(|| "无法识别浏览器内核信息".into())
}

pub(super) fn run_preparation(
    command: &mut Command,
    timeout: Duration,
    progress: Option<Arc<Mutex<KernelJob>>>,
) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动内核准备进程，请重新安装应用")?;
    let stdout = child.stdout.take().ok_or("无法读取内核准备结果")?;
    let stderr = child.stderr.take().ok_or("无法读取内核准备错误")?;
    // Both streams must drain during downloads, otherwise full pipes block Node.
    let out_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stdout = stdout;
        let mut buffer = [0; 4096];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let remaining = (64 * 1024usize).saturating_sub(bytes.len());
                    bytes.extend_from_slice(&buffer[..length.min(remaining)]);
                }
            }
        }
        bytes
    });
    let err_reader = std::thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(progress) = &progress
                && let Some(json) = line.strip_prefix(PROGRESS_PREFIX)
                && let Ok(update) = serde_json::from_str::<KernelProgress>(json)
                && let Ok(mut job) = progress.lock()
            {
                job.apply(update);
            }
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 32 * 1024 {
                let boundary = tail
                    .char_indices()
                    .find(|(index, _)| *index >= tail.len() - 16 * 1024)
                    .map_or(tail.len(), |(index, _)| index);
                tail.drain(..boundary);
            }
        }
        tail.into_bytes()
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => break Err("内核准备超时，请检查应用代理或网络后重试".to_string()),
            Err(_) => break Err("无法等待内核准备进程".to_string()),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(Output {
        status: status?,
        stdout,
        stderr,
    })
}

fn structured_failure(detail: &str) -> Option<KernelFailure> {
    detail.lines().rev().find_map(|line| {
        let json = line.strip_prefix(ERROR_PREFIX)?;
        let failure: KernelFailure = serde_json::from_str(json).ok()?;
        (!failure.code.is_empty()
            && failure.message.len() <= 1024
            && !failure.message.chars().any(char::is_control))
        .then_some(failure)
    })
}

pub(super) fn sanitize_kernel_error(detail: &str) -> String {
    if let Some(failure) = structured_failure(detail) {
        return failure.message;
    }
    let lower = detail.to_ascii_lowercase();
    if lower.contains("license key is invalid, expired, or missing") {
        "浏览器未接受当前激活码（错误 77），请在设置中重新校验".into()
    } else if lower.contains("license key is invalid") {
        "激活服务未接受此激活码，请在设置中重新校验".into()
    } else if lower.contains("could not be validated")
        || lower.contains("couldn't verify")
        || lower.contains("license server unreachable")
    {
        "无法连接激活服务，请检查应用代理或网络后重试".into()
    } else if lower.contains("session limit") {
        "同时打开的窗口已达上限，请先关闭其他窗口".into()
    } else if lower.contains("profile_engine_mismatch") {
        "窗口绑定的内核版本不匹配，请恢复原有内核文件".into()
    } else if lower.contains("profile_launch_timeout") {
        "窗口启动超时，请检查所选代理及其网络连接后重试".into()
    } else if lower.contains("portable_state") || lower.contains("profile_restore") {
        "窗口的 Cookie 或站点数据恢复失败，原迁移文件已保留，请检查内核版本后重试".into()
    } else if lower.contains("profile_proxy_missing") {
        "所选代理缺少连接信息，请检查代理插件配置".into()
    } else if lower.contains("browser_runtime_dependency_missing") {
        "代理环境组件缺失，请更新或重新安装应用".into()
    } else if lower.contains("profile_proxy_bridge_failed")
        || lower.contains("err_no_supported_proxies")
    {
        "所选代理连接失败，请检查地址、协议和账号密码后重试".into()
    } else if lower.contains("profile_geo_proxy_connect_failed") {
        "在线 IP 查询无法连接所选代理，请检查代理地址、协议和账号密码".into()
    } else if lower.contains("profile_geo_online_unavailable") {
        "自动匹配失败：在线 IP 信息服务暂不可用，请稍后重试，或关闭自动匹配后使用手动时区和语言"
            .into()
    } else {
        "浏览器内核准备失败，请在设置的「浏览器内核」中重新下载".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_rejection_does_not_invent_an_expiry_reason() {
        assert_eq!(
            sanitize_kernel_error(
                "CloakBrowser Pro: license key is invalid or expired (plan=free)."
            ),
            "激活服务未接受此激活码，请在设置中重新校验"
        );
        assert_eq!(
            sanitize_kernel_error(
                "CloakBrowser Pro: license key is invalid, expired, or missing. Check CLOAKBROWSER_LICENSE_KEY."
            ),
            "浏览器未接受当前激活码（错误 77），请在设置中重新校验"
        );
        assert!(!sanitize_kernel_error("TLS certificate invalid or expired").contains("激活码"));
    }

    #[test]
    fn launch_timeout_and_restore_failure_do_not_suggest_redownloading_a_valid_kernel() {
        assert_eq!(
            sanitize_kernel_error("PROFILE_LAUNCH_TIMEOUT"),
            "窗口启动超时，请检查所选代理及其网络连接后重试"
        );
        assert!(sanitize_kernel_error("PORTABLE_STATE_INVALID").contains("站点数据恢复失败"));
        assert!(sanitize_kernel_error("PROFILE_PROXY_MISSING").contains("代理缺少连接信息"));
        for detail in [
            "PROFILE_PROXY_BRIDGE_FAILED socks5://user:synthetic-secret@host:1080",
            "PROFILE_GEO_PROXY_CONNECT_FAILED",
        ] {
            let message = sanitize_kernel_error(detail);
            assert!(message.contains("代理"));
            assert!(!message.contains("重新下载"));
            assert!(!message.contains("synthetic-secret"));
        }
        assert!(
            sanitize_kernel_error("BROWSER_RUNTIME_DEPENDENCY_MISSING").contains("重新安装应用")
        );
        assert!(
            sanitize_kernel_error("PROFILE_GEO_PROXY_CONNECT_FAILED").contains("无法连接所选代理")
        );
        assert!(
            sanitize_kernel_error("PROFILE_GEO_ONLINE_UNAVAILABLE").contains("在线 IP 信息服务")
        );
    }

    #[test]
    fn progress_only_changes_an_active_job_and_rejects_invalid_percent() {
        let mut job = KernelJob {
            phase: KernelPhase::Preparing,
            ..KernelJob::default()
        };
        let update = || KernelProgress {
            phase: KernelPhase::Downloading,
            percent: Some(900.0),
            downloaded_mb: Some(12.0),
            total_mb: Some(100.0),
            attempt: None,
        };
        job.apply(update());
        assert_eq!(job.phase, KernelPhase::Downloading);
        assert_eq!(job.percent, None);
        job.phase = KernelPhase::Failed;
        job.apply(update());
        assert_eq!(job.phase, KernelPhase::Failed);
    }

    #[test]
    fn a_new_machine_reports_empty_cache_without_downloading() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("runner.cjs");
        std::fs::write(
            &script,
            r#"if (process.argv[2] !== 'inventory') process.exit(42);
process.stdout.write(JSON.stringify({cacheDir: process.env.CLOAKBROWSER_CACHE_DIR, platform:'test-platform', installed:[]}) + '\n');"#,
        )
        .unwrap();
        let service = KernelService::new(
            LicenseStore::new(root.path().join("nexus.sqlite")).unwrap(),
            RuntimePaths {
                node: "node".into(),
                browser_script: script,
                network_preload: root.path().join("unused.cjs"),
            },
        );
        let status = service.status(false).unwrap();
        assert!(status.inventory.installed.is_empty());
        assert!(!status.activation_configured);
        assert_eq!(status.download.phase, KernelPhase::Idle);
        assert!(!root.path().join("cloakbrowser").exists());
    }

    #[test]
    fn prepare_failure_keeps_safe_details_and_never_creates_a_profile() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("runner.cjs");
        std::fs::write(
            &script,
            r#"console.error('cb_secret must not reach UI');
console.error('NEXUS_KERNEL_ERROR ' + JSON.stringify({code:'NETWORK',message:'下载连接被中断（ECONNRESET），请重试。',retryable:true}));
process.exitCode = 1;"#,
        )
        .unwrap();
        let service = KernelService::new(
            LicenseStore::new(root.path().join("nexus.sqlite")).unwrap(),
            RuntimePaths {
                node: "node".into(),
                browser_script: script,
                network_preload: root.path().join("unused.cjs"),
            },
        );
        let error = service.prepare(KernelKind::Base, None).unwrap_err();
        assert_eq!(error, "下载连接被中断（ECONNRESET），请重试。");
        let job = service.job.lock().unwrap().clone();
        assert_eq!(job.phase, KernelPhase::Failed);
        assert_eq!(job.error.unwrap().code, "NETWORK");
        assert!(!root.path().join("profiles").exists());
    }
}
