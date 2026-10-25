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
const INVALID_KERNEL_VERSION: &str = "请填写完整的内核版本号，包含 4 至 5 段数字";

fn valid_kernel_version(version: &str) -> bool {
    version.len() <= 48
        && (4..=5).contains(&version.split('.').count())
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_kernel_version(version: &str) -> Result<(), String> {
    if valid_kernel_version(version) {
        Ok(())
    } else {
        Err(INVALID_KERNEL_VERSION.into())
    }
}

fn display_matches_package(package: &str, display: &str) -> bool {
    valid_kernel_version(package)
        && valid_kernel_version(display)
        && (package == display
            || (display.split('.').count() == 4
                && package
                    .strip_prefix(display)
                    .is_some_and(|tail| tail.starts_with('.'))))
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
    phase: KernelPhase,
    percent: Option<f64>,
    downloaded_mb: Option<f64>,
    total_mb: Option<f64>,
    attempt: Option<u8>,
    version: Option<String>,
    requested_version: Option<String>,
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
    pub(crate) binary_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelRelease {
    pub version: String,
    pub platform: String,
    pub checked_at: String,
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
    pub(crate) fn package_version(&self, binary_path: &Path) -> Option<String> {
        let relative = binary_path
            .strip_prefix(self.license_store.browser_cache_dir())
            .ok()?;
        let directory = relative.components().next()?;
        let name = directory.as_os_str().to_str()?;
        let version = name.strip_prefix("chromium-")?.strip_suffix("-pro")?;
        valid_kernel_version(version).then(|| version.to_owned())
    }

    pub(crate) fn installed(&self) -> Result<Vec<InstalledKernel>, String> {
        Ok(self.status(true)?.inventory.installed)
    }

    fn probe_binary(&self, binary_path: &str) -> Result<PreparedBinary, String> {
        let mut command = self.command("version")?;
        command.arg(binary_path);
        let output = run_preparation(&mut command, Duration::from_secs(20), None)?;
        if !output.status.success() {
            return Err("无法验证本机内核版本，请重新下载该版本后重试".into());
        }
        let binary: PreparedBinary = serde_json::from_slice(last_output_line(&output)?)
            .map_err(|_| "无法识别本机内核版本")?;
        if binary.binary_path != Path::new(binary_path) {
            return Err("本机内核路径校验失败，请重新下载该版本后重试".into());
        }
        Ok(binary)
    }

    pub(crate) fn exact_binary(&self, version: &str) -> Result<PreparedBinary, String> {
        validate_kernel_version(version)?;
        self.license_store.require_key()?;
        if let Some(binary) = self
            .installed()?
            .iter()
            .find(|entry| entry.version == version)
        {
            let prepared = self.probe_binary(&binary.binary_path)?;
            if !display_matches_package(version, &prepared.version) {
                return Err("本机内核与指定版本不一致，请重新下载该版本后重试".into());
            }
            return Ok(prepared);
        }
        let binary = self.prepare(Some(version))?;
        // Chrome's --version can omit the SDK package revision.
        if !display_matches_package(version, &binary.version)
            || !self.installed()?.iter().any(|entry| {
                entry.version == version && Path::new(&entry.binary_path) == binary.binary_path
            })
        {
            return Err("无法取得指定的精确内核版本，请检查激活码和该版本的可用性".into());
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
        if message == INVALID_KERNEL_VERSION {
            return KernelFailure {
                code: "VERSION".into(),
                message,
                retryable: false,
            };
        }
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

    pub fn check_latest(&self) -> Result<KernelRelease, KernelFailure> {
        let mut command = self.command("latest").map_err(KernelFailure::operation)?;
        let output = run_preparation(&mut command, Duration::from_secs(25), None)
            .map_err(KernelFailure::operation)?;
        if !output.status.success() {
            return Err(structured_failure(&String::from_utf8_lossy(&output.stderr))
                .unwrap_or_else(|| {
                    KernelFailure::operation("无法检查最新内核，请检查应用代理或网络后重试")
                }));
        }
        serde_json::from_slice(last_output_line(&output).map_err(KernelFailure::operation)?)
            .map_err(|_| KernelFailure::operation("最新内核版本信息无效，请重新检查"))
    }

    /// Settings downloads and window creation share the same SDK cache and lock.
    pub fn prepare(&self, version: Option<&str>) -> Result<PreparedBinary, String> {
        self.run_prepare("prepare", version)
    }

    pub fn download(&self, version: Option<&str>) -> Result<PreparedBinary, String> {
        self.run_prepare("download", version)
    }

    fn run_prepare(&self, action: &str, version: Option<&str>) -> Result<PreparedBinary, String> {
        if let Some(version) = version {
            validate_kernel_version(version)?;
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "正在准备浏览器内核，请等待完成后重试")?;
        *self.job.lock().map_err(|_| "内核状态不可用")? = KernelJob {
            phase: KernelPhase::Preparing,
            requested_version: version.map(str::to_owned),
            ..KernelJob::default()
        };
        let result = self.prepare_inner(action, version);
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

    fn prepare_inner(&self, action: &str, version: Option<&str>) -> Result<PreparedBinary, String> {
        let key = self.license_store.require_key().inspect_err(|message| {
            if let Ok(mut job) = self.job.lock() {
                job.error = Some(KernelFailure {
                    code: "ACTIVATION".into(),
                    message: message.clone(),
                    retryable: false,
                });
            }
        })?;
        let mut command = self.command(action)?;
        command
            .env("CLOAKBROWSER_AUTO_UPDATE", "true")
            .env("CLOAKBROWSER_LICENSE_KEY", key);
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
    if lower.contains("activation_required") {
        "请先在设置中填写激活码".into()
    } else if lower.contains("profile_engine_unsupported") {
        "窗口绑定的内核已不受支持，请使用最新内核重新创建窗口".into()
    } else if lower.contains("license key is invalid, expired, or missing") {
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
        let error = service.prepare(None).unwrap_err();
        let failure = service.failure(error);
        assert_eq!(failure.code, "ACTIVATION");
        assert!(!failure.retryable);
        assert_eq!(service.job.lock().unwrap().phase, KernelPhase::Failed);
        assert!(!root.path().join("cloakbrowser").exists());
    }

    #[test]
    fn latest_check_is_read_only_and_explicit_download_uses_the_fresh_update_action() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("runner.cjs");
        std::fs::write(
            &script,
            r#"const action=process.argv[2];
if(action==='latest') {
  if(process.env.CLOAKBROWSER_LICENSE_KEY)process.exit(42);
  process.stdout.write(JSON.stringify({version:'155.0.8059.39.2',platform:'darwin-arm64',checkedAt:'2026-10-25T10:00:00.000Z'}));
} else if(action==='download' && process.env.CLOAKBROWSER_LICENSE_KEY) {
  process.stdout.write(JSON.stringify({version:'155.0.8059.39',binary_path:'/synthetic/browser'}));
} else process.exit(43);"#,
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
        let release = service.check_latest().unwrap();
        assert_eq!(release.version, "155.0.8059.39.2");
        assert_eq!(service.job.lock().unwrap().phase, KernelPhase::Idle);
        assert!(!root.path().join("cloakbrowser").exists());
        assert!(service.download(None).unwrap_err().contains("激活码"));
        service
            .license_store
            .save_validated("synthetic-update-key", "free", None)
            .unwrap();
        assert_eq!(service.download(None).unwrap().version, "155.0.8059.39");
        assert_eq!(service.job.lock().unwrap().phase, KernelPhase::Ready);
        service.check_latest().unwrap();
        assert_eq!(service.job.lock().unwrap().phase, KernelPhase::Ready);
    }

    #[test]
    fn latest_check_failure_preserves_download_status_and_safe_error_details() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("runner.cjs");
        std::fs::write(
            &script,
            r#"console.error('private upstream response');
console.error('NEXUS_KERNEL_ERROR ' + JSON.stringify({code:'NETWORK',message:'暂时无法连接内核服务',retryable:true}));
process.exitCode=1;"#,
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
        let error = service.check_latest().unwrap_err();
        assert_eq!(error.code, "NETWORK");
        assert!(error.retryable);
        assert!(!error.message.contains("private"));
        assert_eq!(service.job.lock().unwrap().phase, KernelPhase::Idle);
    }

    #[test]
    fn explicit_download_preserves_the_requested_revision_when_it_fails() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("runner.cjs");
        std::fs::write(
            &script,
            r#"if (process.argv[2] !== 'download' || process.env.CLOAKBROWSER_VERSION !== '154.0.8000.10.4' || !process.env.CLOAKBROWSER_LICENSE_KEY) process.exit(42);
console.error('NEXUS_KERNEL_ERROR ' + JSON.stringify({code:'NETWORK',message:'暂时无法下载该版本，请重试',retryable:true}));
process.exitCode=1;"#,
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
        service
            .license_store
            .save_validated("synthetic-paid-key", "pro", None)
            .unwrap();
        let error = service.download(Some("154.0.8000.10.4")).unwrap_err();
        assert_eq!(service.failure(error).code, "NETWORK");
        let job = service.job.lock().unwrap();
        assert_eq!(job.requested_version.as_deref(), Some("154.0.8000.10.4"));
        assert_eq!(job.phase, KernelPhase::Failed);
    }

    #[test]
    fn invalid_version_is_rejected_before_starting_the_adapter() {
        let root = tempfile::tempdir().unwrap();
        let service = KernelService::new(
            LicenseStore::new(root.path().join("nexus.sqlite")).unwrap(),
            RuntimePaths {
                node: "missing-node".into(),
                browser_script: root.path().join("missing.cjs"),
                network_preload: root.path().join("unused.cjs"),
            },
        );
        for version in [
            "",
            "155",
            "155.0.1.2\n",
            "../155.0.1.2",
            "155..1.2",
            "155.0.1.2.3.4",
        ] {
            let error = service.download(Some(version)).unwrap_err();
            let failure = service.failure(error);
            assert_eq!(failure.code, "VERSION");
            assert!(!failure.retryable);
        }
        assert_eq!(service.job.lock().unwrap().phase, KernelPhase::Idle);
    }

    #[test]
    fn package_metadata_uses_only_a_managed_versioned_directory() {
        let root = tempfile::tempdir().unwrap();
        let service = KernelService::new(
            LicenseStore::new(root.path().join("nexus.sqlite")).unwrap(),
            RuntimePaths {
                node: "node".into(),
                browser_script: root.path().join("unused.cjs"),
                network_preload: root.path().join("unused-preload.cjs"),
            },
        );
        let cache = service.license_store.browser_cache_dir();
        assert_eq!(
            service.package_version(&cache.join("chromium-154.0.8000.10.4-pro/browser")),
            Some("154.0.8000.10.4".into())
        );
        assert_eq!(
            service.package_version(&cache.join("chromium-154.0.8000.10/browser")),
            None
        );
        assert_eq!(
            service.package_version(&cache.join("chromium-unknown-pro/browser")),
            None
        );
        assert_eq!(
            service.package_version(&root.path().join("chromium-154.0.8000.10.4-pro/browser")),
            None
        );
        assert!(super::display_matches_package(
            "154.0.8000.10.4",
            "154.0.8000.10"
        ));
        assert!(!super::display_matches_package(
            "154.0.8000.10.4",
            "154.0.8000.11"
        ));
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
        service
            .license_store
            .save_validated("synthetic-download-key", "free", None)
            .unwrap();
        let error = service.prepare(None).unwrap_err();
        assert_eq!(error, "下载连接被中断（ECONNRESET），请重试。");
        let job = service.job.lock().unwrap().clone();
        assert_eq!(job.phase, KernelPhase::Failed);
        assert_eq!(job.error.unwrap().code, "NETWORK");
        assert!(!root.path().join("profiles").exists());
    }
}
