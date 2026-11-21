use crate::core::aliasmode_kernels::{AliasEngine, AliasModeKernelService};
use crate::core::browser::connection_store::BrowserConnection;
use crate::core::browser::provider::automation::{AutomationSession, CdpEndpoint};
use crate::core::browser::provider::{
    ALIASMODE_CONNECTION_ID, BrowserCapabilities, BrowserError, BrowserProvider, BrowserProviderId,
    BrowserResult, CreatedProfile, ObservedProfiles, ProviderGroup, ProviderProbe, ProxyMode,
    RemoteProfile, ResolvedProxy, UpdateEvidence, WindowState,
};
use crate::core::browser::providers::aliasmode_proxy::ProxyRelay;
use crate::core::window_store::WindowRecord;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(75);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWitness {
    operation_id: String,
    window_id: String,
    name: String,
    version: String,
    binary_path: PathBuf,
    engine: String,
    created_at: i64,
    provider_config: Value,
}
impl CreateWitness {
    fn profile(&self) -> RemoteProfile {
        RemoteProfile {
            id: self.window_id.clone(),
            name: self.name.clone(),
            kernel_version: Some(self.version.clone()),
            created_at: Some(self.created_at),
            provider_config: self.provider_config.clone(),
        }
    }
}

struct Session {
    child: Child,
    port: u16,
    state: WindowState,
    _relay: Option<ProxyRelay>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionReceipt {
    pid: u32,
    profile_id: String,
    port: u16,
    engine: String,
}

pub struct AliasModeProvider {
    root: PathBuf,
    pub kernels: Arc<AliasModeKernelService>,
    pub firefox_kernels: Arc<AliasModeKernelService>,
    sessions: Mutex<HashMap<String, Session>>,
    operations: Mutex<()>,
}

impl AliasModeProvider {
    pub fn new(
        root: PathBuf,
        kernels: Arc<AliasModeKernelService>,
        firefox_kernels: Arc<AliasModeKernelService>,
    ) -> Self {
        Self {
            root,
            kernels,
            firefox_kernels,
            sessions: Mutex::new(HashMap::new()),
            operations: Mutex::new(()),
        }
    }

    pub fn kernel(&self, engine: AliasEngine) -> &Arc<AliasModeKernelService> {
        if engine == AliasEngine::Firefox {
            &self.firefox_kernels
        } else {
            &self.kernels
        }
    }

    fn engine(record: &WindowRecord) -> BrowserResult<AliasEngine> {
        AliasEngine::parse(record.settings.alias_engine.as_deref().unwrap_or(""))
            .map_err(|e| BrowserError::new("invalid_config", e))
    }

    fn connection(connection: &BrowserConnection) -> BrowserResult<()> {
        if connection.provider_id != BrowserProviderId::AliasMode
            || connection.id != ALIASMODE_CONNECTION_ID
        {
            return Err(BrowserError::new(
                "scope_mismatch",
                "AliasMode 接入绑定不一致",
            ));
        }
        Ok(())
    }

    fn profile(&self, id: &str) -> BrowserResult<PathBuf> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| BrowserError::new("invalid_config", "窗口标识无效"))?;
        Ok(self.root.join(id))
    }

    fn witness(&self, operation_id: &str) -> BrowserResult<PathBuf> {
        uuid::Uuid::parse_str(operation_id)
            .map_err(|_| BrowserError::new("invalid_config", "操作标识无效"))?;
        Ok(self
            .root
            .join(".operations")
            .join(format!("{operation_id}.json")))
    }

    fn read_witness(&self, operation_id: &str) -> BrowserResult<Option<CreateWitness>> {
        let path = self.witness(operation_id)?;
        if !path.exists() {
            return Ok(None);
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| uncertain())?;
        if !meta.is_file() || meta.len() > 4096 {
            return Err(uncertain());
        }
        let witness: CreateWitness =
            serde_json::from_slice(&fs::read(path).map_err(|_| uncertain())?)
                .map_err(|_| uncertain())?;
        if witness.operation_id != operation_id
            || uuid::Uuid::parse_str(&witness.window_id).is_err()
            || AliasEngine::parse(&witness.engine).is_err()
            || witness.provider_config
                != json!({"engine":witness.engine,"binaryPath":witness.binary_path})
            || self
                .kernel(AliasEngine::parse(&witness.engine).map_err(|_| uncertain())?)
                .exact_binary(&witness.version)
                .ok()
                .is_none_or(|binary| binary.binary_path != witness.binary_path)
        {
            return Err(uncertain());
        }
        Ok(Some(witness))
    }

    fn finish_create(&self, witness: &CreateWitness) -> BrowserResult<()> {
        let target = self.profile(&witness.window_id)?;
        let staging = self.root.join(".creating").join(&witness.operation_id);
        if target.exists() {
            if fs::symlink_metadata(&target)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
                && target.join("user-data").is_dir()
            {
                return Ok(());
            }
            return Err(uncertain());
        }
        if fs::symlink_metadata(&staging).is_err() {
            return Err(uncertain());
        }
        fs::rename(staging, target).map_err(|_| uncertain())
    }

    fn record(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        verify_binary: bool,
    ) -> BrowserResult<PathBuf> {
        Self::connection(connection)?;
        if record.binding.provider_id != BrowserProviderId::AliasMode
            || record.binding.connection_id != connection.id
            || record.binding.profile_id != record.id
            || record.settings.fingerprint_seed.is_none()
        {
            return Err(BrowserError::new(
                "invalid_config",
                "AliasMode 窗口绑定不完整",
            ));
        }
        let version = record
            .kernel_version
            .as_deref()
            .ok_or_else(|| BrowserError::new("invalid_config", "窗口缺少固定内核版本"))?;
        let engine = Self::engine(record)?;
        if record.provider_config["engine"] != record.settings.alias_engine.as_deref().unwrap_or("")
        {
            return Err(BrowserError::new(
                "invalid_config",
                "窗口浏览器类型绑定不一致",
            ));
        }
        let expected = self
            .kernel(engine)
            .binding_path(version)
            .map_err(|e| BrowserError::new("invalid_config", e))?;
        if record.binary_path.as_ref() != Some(&expected) {
            return Err(BrowserError::new(
                "invalid_config",
                "内核文件与窗口固定绑定不一致",
            ));
        }
        if verify_binary {
            self.kernel(engine)
                .exact_binary(version)
                .map_err(|e| BrowserError::new("invalid_config", e))?;
        }
        let profile = self.profile(&record.id)?;
        if fs::symlink_metadata(&profile)
            .is_ok_and(|meta| !meta.is_dir() || meta.file_type().is_symlink())
        {
            return Err(BrowserError::new("invalid_config", "环境目录无效"));
        }
        Ok(profile)
    }

    fn observe(&self, id: &str) -> BrowserResult<WindowState> {
        let mut sessions = self.sessions.lock().map_err(|_| unavailable())?;
        if let Some(session) = sessions.get_mut(id) {
            match session.child.try_wait() {
                Ok(None) => return Ok(session.state),
                Err(_) => {
                    session.state = WindowState::Unknown;
                    return Ok(WindowState::Unknown);
                }
                Ok(Some(_)) => {
                    sessions.remove(id);
                }
            }
        }
        drop(sessions);
        let profile = self.profile(id)?;
        let data = profile.join("user-data");
        let receipt_path = profile.join(".raccoon-session.json");
        if fs::symlink_metadata(&receipt_path).is_ok() {
            let receipt: SessionReceipt =
                serde_json::from_slice(&fs::read(&receipt_path).map_err(|_| uncertain())?)
                    .map_err(|_| uncertain())?;
            let engine = AliasEngine::parse(&receipt.engine).map_err(|_| uncertain())?;
            if receipt.profile_id != id
                || receipt.pid == 0
                || (engine == AliasEngine::Chromium && receipt.port == 0)
            {
                return Ok(WindowState::Unknown);
            }
            match process_identity(receipt.pid, &data, engine) {
                Some(true) => {
                    if engine == AliasEngine::Firefox {
                        return Ok(WindowState::Running);
                    }
                    let port_file = fs::read_to_string(data.join("DevToolsActivePort"))
                        .map_err(|_| uncertain())?;
                    let mut lines = port_file.lines();
                    let path = lines.next();
                    let debugger = lines.next().unwrap_or("").trim_end();
                    if path.and_then(|raw| raw.parse::<u16>().ok()) != Some(receipt.port)
                        || !CdpEndpoint::from_port(receipt.port)
                            .is_ok_and(|endpoint| endpoint.matches_debugger_path(debugger))
                    {
                        return Ok(WindowState::Unknown);
                    }
                    return Ok(WindowState::Running);
                }
                None => return Ok(WindowState::Unknown),
                Some(false) if pid_alive(receipt.pid) != Some(false) => {
                    return Ok(WindowState::Unknown);
                }
                Some(false) => {}
            }
            if engine == AliasEngine::Chromium
                && let Ok(contents) = fs::read_to_string(data.join("DevToolsActivePort"))
                && let Some(port) = contents.lines().next().and_then(|s| s.parse::<u16>().ok())
                && CdpEndpoint::from_port(port).is_ok()
            {
                return Ok(WindowState::Unknown);
            }
            // The child has exited. Keep ambiguous locks until we can prove
            // they belong to the recorded child and cannot affect another app.
            #[cfg(unix)]
            if engine == AliasEngine::Chromium
                && let Ok(link) = fs::read_link(data.join("SingletonLock"))
                && !link
                    .to_string_lossy()
                    .ends_with(&format!("-{}", receipt.pid))
            {
                return Ok(WindowState::Unknown);
            }
            #[cfg(windows)]
            if engine == AliasEngine::Chromium
                && fs::symlink_metadata(data.join("SingletonLock")).is_ok()
            {
                return Ok(WindowState::Unknown);
            }
            for name in if engine == AliasEngine::Chromium {
                &["SingletonLock", "DevToolsActivePort"][..]
            } else {
                &[][..]
            } {
                let path = data.join(name);
                if fs::symlink_metadata(&path).is_ok() {
                    fs::remove_file(path).map_err(|_| uncertain())?;
                }
            }
            fs::remove_file(receipt_path).map_err(|_| uncertain())?;
        }
        if fs::symlink_metadata(data.join("parent.lock")).is_ok()
            || fs::symlink_metadata(data.join(".parentlock")).is_ok()
            || fs::symlink_metadata(data.join("SingletonLock")).is_ok()
            || data.join("DevToolsActivePort").exists()
        {
            return Ok(WindowState::Unknown);
        }
        Ok(WindowState::Stopped)
    }

    fn require_stopped(&self, id: &str) -> BrowserResult<()> {
        match self.observe(id)? {
            WindowState::Stopped => Ok(()),
            WindowState::Unknown => Err(uncertain()),
            _ => Err(BrowserError::new("profile_busy", "窗口正在运行")),
        }
    }

    fn resolved_proxy(
        record: &WindowRecord,
        resolved: &ResolvedProxy,
    ) -> BrowserResult<Option<String>> {
        if resolved.mode != record.proxy_mode || resolved.mode == ProxyMode::Provider {
            return Err(BrowserError::new(
                "invalid_config",
                "代理模式与窗口绑定不一致",
            ));
        }
        match resolved.mode {
            ProxyMode::Direct if resolved.connection_url.is_none() => Ok(None),
            ProxyMode::Manual | ProxyMode::Plugin => {
                let raw = resolved
                    .connection_url
                    .as_deref()
                    .ok_or_else(missing_proxy)?;
                let url = url::Url::parse(raw).map_err(|_| missing_proxy())?;
                if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
                    || url.host().is_none()
                    || url.port().is_none()
                    || !matches!(url.path(), "" | "/")
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || (url.scheme() == "socks5h"
                        && (!url.username().is_empty() || url.password().is_some()))
                {
                    return Err(missing_proxy());
                }
                Ok(Some(raw.to_string()))
            }
            _ => Err(missing_proxy()),
        }
    }

    fn proxy_location(raw: &str) -> BrowserResult<(String, String)> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(raw).map_err(|_| missing_proxy())?)
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| missing_proxy())?;
        let response = client
            .get("https://ipwho.is/")
            .send()
            .map_err(|_| BrowserError::new("unavailable", "无法通过窗口代理查询出口 IP"))?;
        if !response.status().is_success() {
            return Err(BrowserError::new("unavailable", "代理出口查询失败"));
        }
        let mut bytes = Vec::new();
        response
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > 16 * 1024 {
            return Err(unavailable());
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        let ip = body["ip"]
            .as_str()
            .filter(|ip| ip.parse::<std::net::IpAddr>().is_ok())
            .ok_or_else(unavailable)?;
        let zone = body["timezone"]["id"]
            .as_str()
            .filter(|value| {
                !value.is_empty()
                    && value.len() < 128
                    && value.bytes().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, b'/' | b'_' | b'-' | b'+')
                    })
            })
            .ok_or_else(unavailable)?;
        Ok((ip.into(), zone.into()))
    }

    fn launch(&self, record: &WindowRecord, proxy: &ResolvedProxy) -> BrowserResult<()> {
        if Self::engine(record)? == AliasEngine::Firefox {
            return self.launch_firefox(record, proxy);
        }
        let profile = self.profile(&record.id)?;
        let executable = record.binary_path.as_ref().ok_or_else(unavailable)?;
        let user_data = profile.join("user-data");
        if !user_data.is_dir() {
            return Err(BrowserError::new("invalid_config", "窗口环境目录不存在"));
        }
        let proxy = Self::resolved_proxy(record, proxy)?;
        let geo = if record.settings.geoip {
            proxy.as_deref().map(Self::proxy_location).transpose()?
        } else {
            None
        };
        let mut command = Command::new(executable);
        command.env("GOOGLE_API_KEY", "no");
        command.env("GOOGLE_DEFAULT_CLIENT_ID", "no");
        command.env("GOOGLE_DEFAULT_CLIENT_SECRET", "no");
        command
            .arg(format!("--user-data-dir={}", user_data.display()))
            .arg(format!(
                "--fingerprint={}",
                record.settings.fingerprint_seed.ok_or_else(unavailable)?
            ))
            .arg("--remote-debugging-address=127.0.0.1")
            .arg("--remote-debugging-port=0")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--fingerprint-noise")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "macos")]
        command.arg("--use-mock-keychain");
        let mut relay = None;
        if let Some(proxy) = proxy {
            let url = url::Url::parse(&proxy).map_err(|_| missing_proxy())?;
            let browser_proxy = if matches!(url.scheme(), "socks5" | "socks5h")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                let started = ProxyRelay::start(&url)
                    .map_err(|message| BrowserError::new("invalid_config", message))?;
                let address = started.address();
                relay = Some(started);
                address
            } else {
                let scheme = if url.scheme() == "socks5h" {
                    "socks5"
                } else {
                    url.scheme()
                };
                let host = url.host_str().ok_or_else(missing_proxy)?;
                let host = if host.contains(':') && !host.starts_with('[') {
                    format!("[{host}]")
                } else {
                    host.to_string()
                };
                format!(
                    "{scheme}://{host}:{}",
                    url.port().ok_or_else(missing_proxy)?
                )
            };
            command
                .arg(format!("--proxy-server={browser_proxy}"))
                .arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
        }
        if let Some((ip, zone)) = &geo {
            command.arg(format!("--fingerprint-webrtc-ip={ip}"));
            command.arg(format!("--fingerprint-timezone={zone}"));
        } else if !record.settings.timezone.is_empty() {
            command.arg(format!(
                "--fingerprint-timezone={}",
                record.settings.timezone
            ));
        }
        if !record.settings.locale.is_empty() {
            command.arg(format!("--fingerprint-locale={}", record.settings.locale));
        }
        if let Some(os) = effective_os(&record.settings.operating_system) {
            command.arg(format!("--fingerprint-platform={os}"));
        }
        if let Some(cores) = record.settings.cpu_cores {
            command.arg(format!(
                "--fingerprint-hardware-concurrency={}",
                cores.min(host_cores())
            ));
        }
        if let Some((width, height)) = screen_size(&record.settings.viewport) {
            command.arg(format!("--fingerprint-screen-width={width}"));
            command.arg(format!("--fingerprint-screen-height={height}"));
        }
        match record.settings.viewport.as_str() {
            "1440x900" => {
                command.arg("--window-size=1440,900");
            }
            "1920x1080" => {
                command.arg("--window-size=1920,1080");
            }
            _ => {}
        }
        if !record.settings.start_url.is_empty() {
            command.arg(&record.settings.start_url);
        }
        let mut child = command
            .spawn()
            .map_err(|_| BrowserError::new("unavailable", "无法启动 AliasMode Chromium 内核"))?;
        let started = Instant::now();
        let port = loop {
            if let Ok(contents) = fs::read_to_string(user_data.join("DevToolsActivePort"))
                && let Some((raw_port, debugger)) = contents.split_once('\n')
                && let Ok(port) = raw_port.parse::<u16>()
                && CdpEndpoint::from_port(port)
                    .is_ok_and(|endpoint| endpoint.matches_debugger_path(debugger.trim()))
            {
                break port;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Err(BrowserError::new(
                        "unavailable",
                        format!(
                            "AliasMode Chromium 启动失败（退出码 {}）",
                            status
                                .code()
                                .map_or_else(|| "未知".into(), |code| code.to_string())
                        ),
                    ));
                }
                Err(_) => return Err(uncertain()),
                _ => {}
            }
            if started.elapsed() >= START_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BrowserError::new("unavailable", "浏览器启动超时"));
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let receipt = SessionReceipt {
            pid: child.id(),
            profile_id: record.id.clone(),
            port,
            engine: "chromium".into(),
        };
        let pending = profile.join(format!(".raccoon-session-{}.tmp", child.id()));
        let persist = (|| -> BrowserResult<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&pending)
                .map_err(|_| unavailable())?;
            serde_json::to_writer(&mut file, &receipt).map_err(|_| unavailable())?;
            file.sync_all().map_err(|_| unavailable())?;
            fs::rename(&pending, profile.join(".raccoon-session.json")).map_err(|_| unavailable())
        })();
        if let Err(error) = persist {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(pending);
            return Err(error);
        }
        self.sessions.lock().map_err(|_| unavailable())?.insert(
            record.id.clone(),
            Session {
                child,
                port,
                state: WindowState::Running,
                _relay: relay,
            },
        );
        Ok(())
    }

    fn launch_firefox(&self, record: &WindowRecord, resolved: &ResolvedProxy) -> BrowserResult<()> {
        let profile = self.profile(&record.id)?;
        let data = profile.join("user-data");
        if !data.is_dir() {
            return Err(BrowserError::new("invalid_config", "窗口环境目录不存在"));
        }
        let proxy = Self::resolved_proxy(record, resolved)?;
        let geo = if record.settings.geoip {
            proxy.as_deref().map(Self::proxy_location).transpose()?
        } else {
            None
        };
        let seed = record.settings.fingerprint_seed.ok_or_else(unavailable)?;
        let (width, height) = screen_size(&record.settings.viewport).unwrap_or((1440, 900));
        let os = effective_os(&record.settings.operating_system).ok_or_else(unavailable)?;
        let mut config = json!({
            "screen.width": width, "screen.height": height,
            "screen.availLeft": 0,
            "screen.availTop": if os == "macos" { 25 } else { 0 },
            "screen.availWidth": width,
            "screen.availHeight": height - if os == "macos" { 76 } else if os == "windows" { 48 } else { 0 },
            "window.outerWidth": width.min(1280), "window.outerHeight": height.min(800),
            "aliasmode:canvasSeed": seed, "aliasmode:textSeed": seed.wrapping_mul(2654435761),
            "navigator.hardwareConcurrency": record.settings.cpu_cores.unwrap_or(4).min(host_cores()),
        });
        if let Some((ip, zone)) = &geo {
            config["timezone"] = json!(zone);
            config[if ip.contains(':') {
                "webrtc:ipv6"
            } else {
                "webrtc:ipv4"
            }] = json!(ip);
        } else if !record.settings.timezone.is_empty() {
            config["timezone"] = json!(record.settings.timezone);
        }
        if !record.settings.locale.is_empty() {
            config["locale:all"] = json!(record.settings.locale);
        }
        let mut relay = None;
        let mut prefs = json!({"media.peerconnection.ice.default_address_only": true});
        if let Some(raw) = proxy {
            let url = url::Url::parse(&raw).map_err(|_| missing_proxy())?;
            let started = ProxyRelay::start(&url)
                .map_err(|message| BrowserError::new("invalid_config", message))?;
            let port = started.port();
            prefs["network.proxy.type"] = json!(1);
            prefs["network.proxy.http"] = json!("127.0.0.1");
            prefs["network.proxy.http_port"] = json!(port);
            prefs["network.proxy.ssl"] = json!("127.0.0.1");
            prefs["network.proxy.ssl_port"] = json!(port);
            prefs["network.proxy.no_proxies_on"] = json!("");
            prefs["media.peerconnection.ice.proxy_only"] = json!(true);
            relay = Some(started);
        } else {
            prefs["network.proxy.type"] = json!(0);
        }
        let mut command = Command::new(record.binary_path.as_ref().ok_or_else(unavailable)?);
        for (index, chunk) in ascii_json(&config).as_bytes().chunks(2047).enumerate() {
            command.env(
                format!("CAMOU_CONFIG_{}", index + 1),
                String::from_utf8_lossy(chunk).as_ref(),
            );
        }
        for (index, chunk) in ascii_json(&prefs).as_bytes().chunks(2047).enumerate() {
            command.env(
                format!("CAMOU_PREFS_{}", index + 1),
                String::from_utf8_lossy(chunk).as_ref(),
            );
        }
        command
            .arg("-no-remote")
            .arg("-new-instance")
            .arg("-profile")
            .arg(&data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if !record.settings.start_url.is_empty() {
            command.arg(&record.settings.start_url);
        }
        let mut child = command
            .spawn()
            .map_err(|_| BrowserError::new("unavailable", "无法启动 AliasMode Firefox 内核"))?;
        let started = Instant::now();
        loop {
            if child.try_wait().map_err(|_| uncertain())?.is_some() {
                return Err(BrowserError::new(
                    "unavailable",
                    "AliasMode Firefox 进程提前退出",
                ));
            }
            if process_identity(child.id(), &data, AliasEngine::Firefox) == Some(true)
                && (data.join("parent.lock").exists() || data.join(".parentlock").exists())
            {
                break;
            }
            if started.elapsed() >= START_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BrowserError::new("unavailable", "Firefox 启动超时"));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let receipt = SessionReceipt {
            pid: child.id(),
            profile_id: record.id.clone(),
            port: 0,
            engine: "firefox".into(),
        };
        let pending = profile.join(format!(".raccoon-session-{}.tmp", child.id()));
        let persist = (|| -> BrowserResult<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&pending)
                .map_err(|_| unavailable())?;
            serde_json::to_writer(&mut file, &receipt).map_err(|_| unavailable())?;
            file.sync_all().map_err(|_| unavailable())?;
            fs::rename(&pending, profile.join(".raccoon-session.json")).map_err(|_| unavailable())
        })();
        if let Err(error) = persist {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(pending);
            return Err(error);
        }
        self.sessions.lock().map_err(|_| unavailable())?.insert(
            record.id.clone(),
            Session {
                child,
                port: 0,
                state: WindowState::Running,
                _relay: relay,
            },
        );
        Ok(())
    }
}

fn effective_os(value: &str) -> Option<&str> {
    if value != "host" {
        return Some(value);
    }
    if cfg!(target_os = "macos") {
        Some("macos")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else {
        None
    }
}
fn host_cores() -> u8 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(64) as u8)
        .unwrap_or(4)
}
fn screen_size(value: &str) -> Option<(u32, u32)> {
    match value {
        "1440x900" => Some((1440, 900)),
        "1920x1080" => Some((1920, 1080)),
        _ => None,
    }
}
fn ascii_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

impl BrowserProvider for AliasModeProvider {
    fn id(&self) -> BrowserProviderId {
        BrowserProviderId::AliasMode
    }
    fn capabilities(&self) -> BrowserCapabilities {
        BrowserCapabilities {
            create: true,
            update: true,
            delete_environment: true,
            attach: false,
            manual_proxy: true,
            proxy_plugin: true,
            geoip: true,
            fingerprint_seed: true,
            kernel_selection: true,
            transfer: false,
        }
    }
    fn probe(&self, connection: &BrowserConnection) -> BrowserResult<ProviderProbe> {
        Self::connection(connection)?;
        let installed = [AliasEngine::Chromium, AliasEngine::Firefox]
            .into_iter()
            .map(|engine| {
                self.kernel(engine)
                    .status()
                    .map(|status| status.installed.len())
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| BrowserError::new("unavailable", e))?;
        Ok(ProviderProbe {
            connected: installed.iter().any(|count| *count > 0),
            message: if installed.iter().all(|count| *count == 0) {
                "请先在实验室下载 AliasMode 内核"
            } else {
                "内核已就绪"
            }
            .into(),
            scope_id: Some(ALIASMODE_CONNECTION_ID.into()),
            capabilities: self.capabilities(),
        })
    }
    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        Self::connection(connection)?;
        Ok(Vec::new())
    }
    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        Self::connection(connection)?;
        Ok(Vec::new())
    }
    fn create_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        operation_id: &str,
    ) -> BrowserResult<CreatedProfile> {
        Self::connection(connection)?;
        let _lock = self
            .operations
            .try_lock()
            .map_err(|_| BrowserError::new("profile_busy", "另一个环境操作正在进行"))?;
        let witness_path = self.witness(operation_id)?;
        if let Some(witness) = self.read_witness(operation_id)? {
            if witness.window_id != record.id
                || witness.name != record.name
                || witness.engine != record.settings.alias_engine.as_deref().unwrap_or("")
                || record
                    .kernel_version
                    .as_deref()
                    .is_some_and(|v| v != witness.version)
            {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "该创建操作已用于另一个窗口",
                ));
            }
            self.finish_create(&witness)?;
            return Ok(CreatedProfile {
                profile_id: witness.window_id,
                kernel_version: Some(witness.version),
                binary_path: Some(witness.binary_path),
                provider_config: witness.provider_config,
            });
        }
        if record.binding.connection_id != connection.id
            || record.binding.provider_id != self.id()
            || record.binding.profile_id != record.id
            || record.settings.fingerprint_seed.is_none()
        {
            return Err(BrowserError::new(
                "invalid_config",
                "AliasMode 窗口配置无效",
            ));
        }
        let engine = Self::engine(record)?;
        let kernels = self.kernel(engine);
        let version = if let Some(version) = &record.kernel_version {
            version.clone()
        } else {
            kernels
                .status()
                .map_err(|e| BrowserError::new("unavailable", e))?
                .installed
                .first()
                .ok_or_else(|| {
                    BrowserError::new("invalid_config", "请先在实验室下载所选浏览器内核")
                })?
                .version
                .clone()
        };
        let binary = kernels
            .exact_binary(&version)
            .map_err(|e| BrowserError::new("invalid_config", e))?;
        let profile = self.profile(&record.id)?;
        if profile.exists() {
            return Err(uncertain());
        }
        fs::create_dir_all(self.root.join(".creating")).map_err(|_| unavailable())?;
        fs::create_dir_all(self.root.join(".operations")).map_err(|_| unavailable())?;
        let staging = self.root.join(".creating").join(operation_id);
        fs::create_dir(&staging).map_err(|_| uncertain())?;
        fs::create_dir(staging.join("user-data")).map_err(|_| uncertain())?;
        let witness = CreateWitness {
            operation_id: operation_id.into(),
            window_id: record.id.clone(),
            name: record.name.clone(),
            version,
            binary_path: binary.binary_path.clone(),
            engine: record
                .settings
                .alias_engine
                .clone()
                .ok_or_else(unavailable)?,
            created_at: record.created_at,
            provider_config: json!({"engine":record.settings.alias_engine,"binaryPath":binary.binary_path}),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(witness_path)
            .map_err(|_| uncertain())?;
        serde_json::to_writer(&mut file, &witness).map_err(|_| uncertain())?;
        file.sync_all().map_err(|_| uncertain())?;
        self.finish_create(&witness)?;
        Ok(CreatedProfile {
            profile_id: record.id.clone(),
            kernel_version: Some(witness.version),
            binary_path: Some(witness.binary_path),
            provider_config: witness.provider_config,
        })
    }
    fn update_profile(
        &self,
        connection: &BrowserConnection,
        old: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<()> {
        self.record(connection, old, false)?;
        self.record(connection, updated, false)?;
        if old.binding != updated.binding
            || old.binary_path != updated.binary_path
            || old.kernel_version != updated.kernel_version
            || old.settings.fingerprint_seed != updated.settings.fingerprint_seed
            || old.settings.alias_engine != updated.settings.alias_engine
            || old.settings.operating_system != updated.settings.operating_system
            || old.settings.cpu_cores != updated.settings.cpu_cores
        {
            return Err(BrowserError::new(
                "invalid_config",
                "内核和浏览器身份创建后不可修改",
            ));
        }
        self.require_stopped(&old.id)
    }
    fn prepare_update_evidence(
        &self,
        _: &WindowRecord,
        _: &WindowRecord,
    ) -> BrowserResult<UpdateEvidence> {
        UpdateEvidence::from_fields(self.id(), &json!({}))
    }
    fn delete_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        let profile = self.record(connection, record, false)?;
        self.require_stopped(&record.id)?;
        match fs::symlink_metadata(&profile) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                fs::remove_dir_all(profile).map_err(|_| unavailable())
            }
            _ => Err(uncertain()),
        }
    }
    fn start_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        proxy: &ResolvedProxy,
    ) -> BrowserResult<()> {
        self.record(connection, record, true)?;
        self.require_stopped(&record.id)?;
        self.launch(record, proxy)
    }
    fn stop_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        self.record(connection, record, false)?;
        let mut sessions = self.sessions.lock().map_err(|_| unavailable())?;
        let Some(session) = sessions.get_mut(&record.id) else {
            drop(sessions);
            match self.observe(&record.id)? {
                WindowState::Stopped => return Ok(()),
                WindowState::Running => {
                    let profile = self.profile(&record.id)?;
                    let receipt: SessionReceipt = serde_json::from_slice(
                        &fs::read(profile.join(".raccoon-session.json"))
                            .map_err(|_| uncertain())?,
                    )
                    .map_err(|_| uncertain())?;
                    let data = profile.join("user-data");
                    if receipt.profile_id != record.id
                        || process_identity(receipt.pid, &data, Self::engine(record)?) != Some(true)
                    {
                        return Err(uncertain());
                    }
                    stop_process(receipt.pid)?;
                    let start = Instant::now();
                    loop {
                        if pid_alive(receipt.pid) == Some(false) {
                            return if self.observe(&record.id)? == WindowState::Stopped {
                                Ok(())
                            } else {
                                Err(uncertain())
                            };
                        }
                        if start.elapsed() >= STOP_TIMEOUT {
                            return Err(uncertain());
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                _ => return Err(uncertain()),
            }
        };
        session.state = WindowState::Stopping;
        #[cfg(unix)]
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &session.child.id().to_string()])
            .status();
        #[cfg(windows)]
        let _ = session.child.kill();
        let start = Instant::now();
        loop {
            match session.child.try_wait() {
                Ok(Some(_)) => {
                    sessions.remove(&record.id);
                    return Ok(());
                }
                Err(_) => return Err(uncertain()),
                Ok(None) if start.elapsed() >= STOP_TIMEOUT => {
                    session.child.kill().map_err(|_| uncertain())?;
                    session.child.wait().map_err(|_| uncertain())?;
                    sessions.remove(&record.id);
                    return Ok(());
                }
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }
    fn observe_profiles(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles> {
        Self::connection(connection)?;
        let mut states = HashMap::new();
        for record in records {
            self.record(connection, record, false)?;
            states.insert(record.binding.profile_id.clone(), self.observe(&record.id)?);
        }
        Ok(ObservedProfiles {
            states,
            profiles: Vec::new(),
        })
    }
    fn reconcile_create(
        &self,
        connection: &BrowserConnection,
        operation_id: &str,
    ) -> BrowserResult<Option<RemoteProfile>> {
        Self::connection(connection)?;
        let _lock = self.operations.try_lock().map_err(|_| uncertain())?;
        let Some(witness) = self.read_witness(operation_id)? else {
            return Ok(None);
        };
        self.finish_create(&witness)?;
        Ok(Some(witness.profile()))
    }
    fn reconcile_update(
        &self,
        connection: &BrowserConnection,
        old: &WindowRecord,
        updated: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool> {
        evidence.validate(self.id())?;
        self.update_profile(connection, old, updated)?;
        Ok(true)
    }
    fn automation_session(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<AutomationSession> {
        self.record(connection, record, false)?;
        if Self::engine(record)? == AliasEngine::Firefox {
            return Err(BrowserError::unsupported("Firefox 窗口不提供自动化"));
        }
        if self.observe(&record.id)? != WindowState::Running {
            return Err(unavailable());
        }
        let port = if let Some(session) = self
            .sessions
            .lock()
            .map_err(|_| unavailable())?
            .get(&record.id)
        {
            session.port
        } else {
            let receipt: SessionReceipt = serde_json::from_slice(
                &fs::read(self.profile(&record.id)?.join(".raccoon-session.json"))
                    .map_err(|_| unavailable())?,
            )
            .map_err(|_| unavailable())?;
            receipt.port
        };
        Ok(AutomationSession::Cdp(CdpEndpoint::from_port(port)?))
    }
}

fn unavailable() -> BrowserError {
    BrowserError::new("unavailable", "AliasMode Chromium 运行环境暂不可用")
}
fn uncertain() -> BrowserError {
    BrowserError::new(
        "operation_uncertain",
        "无法确认浏览器进程或环境目录状态，请关闭浏览器后重试",
    )
}
fn missing_proxy() -> BrowserError {
    BrowserError::new("invalid_config", "所选窗口代理不可用，已阻止浏览器启动")
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> Option<bool> {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .map(|status| status.success())
}

#[cfg(unix)]
fn process_identity(pid: u32, data: &Path, engine: AliasEngine) -> Option<bool> {
    if pid_alive(pid) != Some(true) {
        return Some(false);
    }
    let output = Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8(output.stdout).ok()?;
    Some(if engine == AliasEngine::Firefox {
        command.contains("aliasmode")
            && command.contains("-profile")
            && command.contains(&data.display().to_string())
    } else {
        command.contains("Chromium")
            && command.contains(&format!("--user-data-dir={}", data.display()))
    })
}

#[cfg(unix)]
fn stop_process(pid: u32) -> BrowserResult<()> {
    Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|_| uncertain())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(uncertain())
            }
        })
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> Option<bool> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Id"),
        ])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim() == pid.to_string())
}

#[cfg(windows)]
fn process_identity(pid: u32, data: &Path, engine: AliasEngine) -> Option<bool> {
    if pid_alive(pid) != Some(true) {
        return Some(false);
    }
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    Some(if engine == AliasEngine::Firefox {
        command.contains("aliasmode.exe")
            && command.contains("-profile")
            && command.contains(&data.display().to_string())
    } else {
        command.contains("chrome.exe")
            && command.contains(&format!("--user-data-dir={}", data.display()))
    })
}

#[cfg(windows)]
fn stop_process(pid: u32) -> BrowserResult<()> {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .status()
        .map_err(|_| uncertain())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(uncertain())
            }
        })
}
