use super::super::connection_store::BrowserConnection;
use super::super::provider::automation::{AutomationSession, CdpEndpoint};
use super::super::provider::{
    BrowserCapabilities, BrowserError, BrowserProvider, BrowserProviderId, BrowserResult,
    CreatedProfile, ObservedProfiles, ProviderGroup, ProviderProbe, ProxyMode, RemoteProfile,
    ResolvedProxy, SHARDBROWSER_CONNECTION_ID, UpdateEvidence, WindowState,
};
use crate::core::shardbrowser_kernels::ShardKernelService;
use crate::core::window_store::{WindowRecord, WindowSettings, validate_settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use shardx::{BrowserSession, LaunchOptions, Profile, ScreenStrategy, WebRtcMode};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    window_id: String,
    operation_id: String,
    version: String,
    binary_path: PathBuf,
    profile_sha256: String,
    created_at: i64,
    name: String,
    #[serde(default)]
    fingerprint_seed: Option<u32>,
    #[serde(default)]
    cpu_cores: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    config_sha256: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateIntent {
    window_id: String,
    operation_id: String,
    version: String,
    binary_path: PathBuf,
    fingerprint_seed: u32,
    cpu_cores: Option<u8>,
    created_at: i64,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shardbrowser: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunningReceipt {
    pid: u32,
    profile_id: String,
    binary_path: PathBuf,
    port: u16,
    debugger_path: String,
}

pub struct ShardBrowserProvider {
    root: PathBuf,
    database: Option<PathBuf>,
    pub kernels: Arc<ShardKernelService>,
    sessions: Mutex<HashMap<String, BrowserSession>>,
    operations: Mutex<()>,
}

impl Drop for ShardBrowserProvider {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for session in sessions.values_mut() {
                session.detach();
            }
        }
    }
}

fn unavailable() -> BrowserError {
    BrowserError::new("unavailable", "浏览器暂不可用，请检查内核与窗口状态")
}

fn launch_failure(error: impl std::fmt::Display) -> BrowserError {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("invalid proxy url")
        || message.contains("proxy url missing")
        || message.contains("proxy url must")
        || message.contains("unsupported proxy scheme")
        || message.contains("bad proxy url")
        || message.contains("required proxy is missing")
    {
        return BrowserError::new("invalid_config", "代理配置无效，请重新选择或编辑代理");
    }
    let proxy_network_failure = message.contains("error sending request")
        || message.contains("timed out")
        || message.contains("dns")
        || message.contains("connection refused")
        || message.contains("connection reset")
        || message.contains("auth failed");
    if message.contains("proxy exit identity")
        || proxy_network_failure
            && (message.contains("proxy")
                || message.contains("ipwho.is")
                || message.contains("ip-api"))
    {
        return BrowserError::new(
            "not_submitted",
            "代理出口检测失败，请检查代理地址、账号和网络后重试",
        );
    }
    if message.contains("invalid profile lock directory")
        || message.contains("invalid profile lock file")
    {
        return BrowserError::new(
            "unavailable",
            "Profile 锁记录损坏，请确认浏览器已退出后重新创建 Profile",
        );
    }
    if message.contains("profile is already")
        || message.contains("profile is busy")
        || message.contains("profile has unresolved runtime markers")
        || message.contains("singleton")
    {
        return BrowserError::new("profile_busy", "Profile 已在运行或被其他进程占用");
    }
    if message.contains("cdp endpoint") || message.contains("remote-debugging") {
        return BrowserError::new(
            "unavailable",
            "浏览器进程未能建立自动化连接，请检查内核与 Profile 指纹配置",
        );
    }
    if message.contains("permission denied")
        || message.contains("no such file")
        || message.contains("not found")
    {
        return BrowserError::new("unavailable", "浏览器内核不可执行，请重新安装当前内核");
    }
    BrowserError::new(
        "unavailable",
        "浏览器启动失败，请检查内核、Profile 配置和代理状态",
    )
}

fn uncertain() -> BrowserError {
    BrowserError::new("operation_uncertain", "窗口状态无法确认，请核对浏览器进程")
}

fn validate_supported_settings(settings: &WindowSettings) -> BrowserResult<()> {
    validate_settings(settings)
        .map_err(|_| BrowserError::new("invalid_config", "浏览器配置无效"))?;
    if settings.operating_system != "host" || settings.alias_engine.is_some() {
        return Err(BrowserError::unsupported(
            "ShardBrowser 目前仅支持本机操作系统，不支持 AliasMode 引擎选项",
        ));
    }
    // These strings enter fingerprint JSON and Chromium's locale switch.
    if !settings.timezone.is_empty()
        && (settings.timezone == "auto"
            || !settings
                .timezone
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b)))
    {
        return Err(BrowserError::new("invalid_config", "时区格式无效"));
    }
    if !settings.locale.is_empty()
        && (settings.locale == "auto"
            || !settings
                .locale
                .split('-')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric())))
    {
        return Err(BrowserError::new("invalid_config", "语言格式无效"));
    }
    Ok(())
}

fn launch_profile(
    mut profile: Profile,
    settings: &WindowSettings,
) -> BrowserResult<(Profile, LaunchOptions)> {
    validate_supported_settings(settings)?;
    if settings.shardbrowser.is_some() {
        let config = &profile.config;
        let mut options = LaunchOptions {
            randomize: false,
            screen_mode: Some(ScreenStrategy::Profile),
            start_url: (!settings.start_url.is_empty()).then(|| settings.start_url.clone()),
            android_media: config
                .pointer("/_meta/android_media")
                .and_then(serde_json::Value::as_bool)
                == Some(true),
            webrtc: match config
                .get("webrtc")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("auto")
            {
                "auto" => Some(WebRtcMode::Auto),
                "block" => Some(WebRtcMode::Block),
                "tcp_only" | "replace" => Some(WebRtcMode::TcpOnly),
                _ => return Err(BrowserError::new("invalid_config", "WebRTC 配置无效")),
            },
            ..Default::default()
        };
        if config
            .get("ui_language")
            .and_then(serde_json::Value::as_str)
            == Some("profile")
            && let Some(language) = config
                .pointer("/navigator/language")
                .and_then(serde_json::Value::as_str)
                .filter(|s| *s != "auto" && !s.is_empty())
        {
            options.extra_args.push(format!("--lang={language}"));
        }
        if let (Some(width), Some(height)) = (
            config
                .pointer("/window/outer_width")
                .and_then(serde_json::Value::as_u64),
            config
                .pointer("/window/outer_height")
                .and_then(serde_json::Value::as_u64),
        ) {
            options
                .extra_args
                .push(format!("--window-size={width},{height}"));
        }
        if let Some(color) = config
            .pointer("/_meta/color")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            options
                .extra_args
                .push(format!("--shardx-profile-pill-color={color}"));
        }
        if config
            .pointer("/window/maximized")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            options.extra_args.push("--start-maximized".into());
        }
        return Ok((profile, options));
    }
    if !profile.config.is_object()
        || !profile
            .config
            .get("navigator")
            .is_some_and(|value| value.is_object())
    {
        return Err(uncertain());
    }
    profile.config["timezone"] = json!(if settings.timezone.is_empty() {
        if settings.geoip { "auto" } else { "UTC" }
    } else {
        &settings.timezone
    });
    let language = if settings.locale.is_empty() {
        if settings.geoip { "auto" } else { "en-US" }
    } else {
        &settings.locale
    };
    profile.config["navigator"]["language"] = json!(language);
    if language != "auto" {
        let base = language.split('-').next().unwrap_or(language);
        let languages = if base == language {
            vec![language]
        } else {
            vec![language, base]
        };
        profile.config["navigator"]["languages"] = json!(languages);
        profile.config["navigator"]["accept_language"] = json!(if base == language {
            language.to_string()
        } else {
            format!("{language},{base};q=0.9")
        });
        profile.config["icu_locale"] = json!(language);
    }
    if settings.geoip {
        profile.config["geolocation"] = json!({"mode":"auto"});
    } else {
        // An inherited auto field must not trigger an implicit direct geo request.
        profile
            .config
            .as_object_mut()
            .ok_or_else(uncertain)?
            .remove("geolocation");
    }
    if let Some(cores) = settings.cpu_cores {
        profile.config["navigator"]["hardware_concurrency"] = json!(cores);
    }
    let mut options = LaunchOptions {
        randomize: false,
        screen_mode: Some(ScreenStrategy::Profile),
        start_url: (!settings.start_url.is_empty()).then(|| settings.start_url.clone()),
        ..Default::default()
    };
    if !settings.locale.is_empty() {
        options
            .extra_args
            .push(format!("--lang={}", settings.locale));
    }
    if settings.viewport != "default" {
        let (width, height) = match settings.viewport.as_str() {
            "1440x900" => (1440, 900),
            "1920x1080" => (1920, 1080),
            _ => return Err(BrowserError::unsupported("不支持的视口尺寸")),
        };
        profile.config["screen"] =
            json!({"width":width,"height":height,"avail_width":width,"avail_height":height});
        profile.config["window"] = json!({"inner_width":width,"inner_height":height,"outer_width":width,"outer_height":height});
        options
            .extra_args
            .push(format!("--window-size={width},{height}"));
    }
    Ok((profile, options))
}

fn config_digest(config: Option<&serde_json::Value>) -> BrowserResult<Option<String>> {
    config
        .map(|value| {
            serde_json::to_vec(value)
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                .map_err(|_| uncertain())
        })
        .transpose()
}

// Apply only editor changes to the frozen identity. Values unchanged since creation
// keep their normalized/seeded form, including the operator's hardware choices.
fn overlay_config(
    frozen: &mut serde_json::Value,
    original: &serde_json::Value,
    edited: &serde_json::Value,
) {
    if original == edited {
        return;
    }
    if let (Some(base), Some(before), Some(after)) = (
        frozen.as_object_mut(),
        original.as_object(),
        edited.as_object(),
    ) {
        for key in before.keys() {
            if !after.contains_key(key) {
                base.remove(key);
            }
        }
        for (key, value) in after {
            match (base.get_mut(key), before.get(key)) {
                (Some(target), Some(previous)) => overlay_config(target, previous, value),
                _ => {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
    } else {
        *frozen = edited.clone();
    }
}

fn sync_directory(path: &Path) -> BrowserResult<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| uncertain())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn write_receipt(path: &Path, value: &impl Serialize) -> BrowserResult<()> {
    let temporary = path.with_file_name(format!(".receipt-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| uncertain())?;
        serde_json::to_writer(&mut file, value).map_err(|_| uncertain())?;
        file.flush().map_err(|_| uncertain())?;
        file.sync_all().map_err(|_| uncertain())?;
        fs::hard_link(&temporary, path).map_err(|_| uncertain())
    })();
    let _ = fs::remove_file(&temporary);
    result?;
    sync_directory(path.parent().ok_or_else(uncertain)?)
}

fn marker_exists(path: &Path) -> BrowserResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(uncertain()),
    }
}

impl ShardBrowserProvider {
    pub fn new(root: PathBuf, kernels: Arc<ShardKernelService>) -> Self {
        Self {
            root,
            database: None,
            kernels,
            sessions: Mutex::new(HashMap::new()),
            operations: Mutex::new(()),
        }
    }

    pub fn with_database(mut self, database: PathBuf) -> Self {
        self.database = Some(database);
        self
    }

    fn check(connection: &BrowserConnection) -> BrowserResult<()> {
        if connection.provider_id != BrowserProviderId::ShardBrowser
            || connection.id != SHARDBROWSER_CONNECTION_ID
        {
            return Err(BrowserError::new("scope_mismatch", "浏览器接入绑定不一致"));
        }
        Ok(())
    }

    fn intent_path(&self, operation_id: &str) -> BrowserResult<PathBuf> {
        uuid::Uuid::parse_str(operation_id)
            .map_err(|_| BrowserError::new("invalid_config", "操作 ID 无效"))?;
        Ok(self.root.join(format!(".create-{operation_id}.json")))
    }

    fn recover_create(&self, operation_id: &str) -> BrowserResult<Option<Receipt>> {
        let path = self.intent_path(operation_id)?;
        if !marker_exists(&path)? {
            return Ok(None);
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| uncertain())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4 * 1024 * 1024 + 4096 {
            return Err(uncertain());
        }
        let intent: CreateIntent =
            serde_json::from_slice(&fs::read(&path).map_err(|_| uncertain())?)
                .map_err(|_| uncertain())?;
        if intent.operation_id != operation_id
            || intent.fingerprint_seed == 0
            || intent.fingerprint_seed > 0x7fff_ffff
        {
            return Err(uncertain());
        }
        let folder = self.folder(&intent.window_id)?;
        if let Some(receipt) = self.receipt(&intent.window_id)? {
            if receipt.operation_id != operation_id
                || receipt.version != intent.version
                || receipt.binary_path != intent.binary_path
                || receipt.fingerprint_seed != Some(intent.fingerprint_seed)
                || receipt.cpu_cores != intent.cpu_cores
                || receipt.config_sha256 != config_digest(intent.shardbrowser.as_ref())?
                || receipt.profile_sha256 != self.profile_digest(&intent.window_id)?
            {
                return Err(uncertain());
            }
            if self
                .kernels
                .pinned(&receipt.version)
                .map_err(|_| uncertain())?
                .runtime
                .binary_path()
                != receipt.binary_path
            {
                return Err(uncertain());
            }
            return Ok(Some(receipt));
        }
        // Recovery accepts a fully written identity. Truncation stays uncertain.
        self.profile_digest(&intent.window_id)?;
        let profile = fs::read(folder.join("profile.json")).map_err(|_| uncertain())?;
        let config: serde_json::Value =
            serde_json::from_slice(&profile).map_err(|_| uncertain())?;
        if !config.is_object()
            || !config
                .get("navigator")
                .is_some_and(|value| value.is_object())
            || self
                .kernels
                .pinned(&intent.version)
                .map_err(|_| uncertain())?
                .runtime
                .binary_path()
                != intent.binary_path
        {
            return Err(uncertain());
        }
        let receipt = Receipt {
            window_id: intent.window_id,
            operation_id: intent.operation_id,
            version: intent.version,
            binary_path: intent.binary_path,
            fingerprint_seed: Some(intent.fingerprint_seed),
            cpu_cores: intent.cpu_cores,
            config_sha256: config_digest(intent.shardbrowser.as_ref())?,
            profile_sha256: format!("{:x}", Sha256::digest(&profile)),
            created_at: intent.created_at,
            name: intent.name,
        };
        write_receipt(&folder.join("create.json"), &receipt)?;
        Ok(Some(receipt))
    }

    fn folder(&self, id: &str) -> BrowserResult<PathBuf> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| BrowserError::new("invalid_config", "窗口 ID 无效"))?;
        let folder = self.root.join(id);
        if marker_exists(&folder)? {
            let meta = fs::symlink_metadata(&folder).map_err(|_| uncertain())?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(uncertain());
            }
        }
        Ok(folder)
    }

    fn receipt(&self, id: &str) -> BrowserResult<Option<Receipt>> {
        let path = self.folder(id)?.join("create.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Ok(meta) if meta.is_file() && meta.len() <= 4096 => {
                let receipt: Receipt =
                    serde_json::from_slice(&fs::read(path).map_err(|_| uncertain())?)
                        .map_err(|_| uncertain())?;
                if receipt.window_id != id
                    || uuid::Uuid::parse_str(&receipt.operation_id).is_err()
                    || receipt.profile_sha256.len() != 64
                    || !receipt
                        .profile_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(uncertain());
                }
                Ok(Some(receipt))
            }
            _ => Err(uncertain()),
        }
    }

    fn profile_digest(&self, id: &str) -> BrowserResult<String> {
        let folder = self.folder(id)?;
        let path = folder.join("profile.json");
        let meta = fs::symlink_metadata(&path).map_err(|_| uncertain())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4 * 1024 * 1024 {
            return Err(uncertain());
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(fs::read(path).map_err(|_| uncertain())?)
        ))
    }

    fn remote(receipt: Receipt) -> RemoteProfile {
        RemoteProfile {
            id: receipt.window_id,
            name: receipt.name,
            kernel_version: Some(receipt.version),
            created_at: Some(receipt.created_at),
            provider_config: json!({"managed":true,"binaryPath":receipt.binary_path}),
        }
    }

    fn record(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<(PathBuf, String)> {
        Self::check(connection)?;
        validate_supported_settings(&record.settings)?;
        if record.binding.provider_id != BrowserProviderId::ShardBrowser
            || record.binding.connection_id != connection.id
            || record.binding.profile_id != record.id
            || record.settings.fingerprint_seed.is_none()
        {
            return Err(BrowserError::new("invalid_config", "窗口绑定无效"));
        }
        let version = record.kernel_version.as_deref().ok_or_else(unavailable)?;
        let sdk = self.kernels.pinned(version).map_err(|_| unavailable())?;
        if record.binary_path.as_ref() != Some(&sdk.runtime.binary_path()) {
            return Err(unavailable());
        }
        let folder = self.folder(&record.id)?;
        let receipt = self.receipt(&record.id)?.ok_or_else(uncertain)?;
        if receipt.version != version
            || (receipt.config_sha256.is_some() && record.settings.shardbrowser.is_none())
            || receipt.binary_path != sdk.runtime.binary_path()
            || receipt.profile_sha256 != self.profile_digest(&record.id)?
            || receipt
                .fingerprint_seed
                .is_some_and(|seed| Some(seed) != record.settings.fingerprint_seed)
            || receipt.cpu_cores != record.settings.cpu_cores
        {
            return Err(uncertain());
        }
        Ok((folder, version.to_string()))
    }

    pub(crate) fn profile_config(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<serde_json::Value> {
        let (folder, _) = self.record(connection, record)?;
        let config = serde_json::from_slice(
            &fs::read(folder.join("profile.json")).map_err(|_| uncertain())?,
        )
        .map_err(|_| uncertain())?;
        shardx::validate_fingerprint_config(&config).map_err(|_| uncertain())?;
        Ok(config)
    }

    pub(crate) fn export_cookies(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<Vec<crate::core::shardbrowser_profiles::Cookie>> {
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let (folder, _) = self.record(connection, record)?;
        if !matches!(
            self.state(&record.id)?,
            WindowState::Stopped | WindowState::Running
        ) {
            return Err(uncertain());
        }
        crate::core::shardbrowser_profiles::export(&folder)
    }

    pub(crate) fn with_profile_cdp<T>(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        access: impl FnOnce(crate::core::shardbrowser_profiles::CdpInfo) -> BrowserResult<T>,
    ) -> BrowserResult<T> {
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let (folder, _) = self.record(connection, record)?;
        if self.state(&record.id)? != WindowState::Running {
            return Err(BrowserError::new("unavailable", "请先启动 Profile"));
        }
        let receipt: RunningReceipt = serde_json::from_slice(
            &fs::read(folder.join("running.json")).map_err(|_| uncertain())?,
        )
        .map_err(|_| uncertain())?;
        let endpoint = CdpEndpoint::from_port(receipt.port)?;
        if !endpoint.matches_debugger_path(&receipt.debugger_path) {
            return Err(uncertain());
        }
        access(crate::core::shardbrowser_profiles::CdpInfo {
            port: receipt.port,
            http_url: format!("http://127.0.0.1:{}", receipt.port),
            web_socket_debugger_url: format!(
                "ws://127.0.0.1:{}{}",
                receipt.port, receipt.debugger_path
            ),
        })
    }

    pub(crate) fn import_cookies(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        cookies: &[crate::core::shardbrowser_profiles::Cookie],
    ) -> BrowserResult<usize> {
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let (folder, version) = self.record(connection, record)?;
        self.stopped(&record.id)?;
        let sdk = self
            .kernels
            .pinned_with_profiles(&version, Some(self.root.clone()))
            .map_err(|_| unavailable())?;
        let _profile_lock = sdk
            .lock_stopped_profile(&record.id)
            .map_err(|_| uncertain())?;
        crate::core::shardbrowser_profiles::import(&folder, cookies)
    }

    pub(crate) fn editable_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<Profile> {
        let mut config = self.profile_config(connection, record)?;
        if let Some(edited) = &record.settings.shardbrowser {
            let receipt = self.receipt(&record.id)?.ok_or_else(uncertain)?;
            if let Some(expected) = &receipt.config_sha256 {
                let path = self.intent_path(&receipt.operation_id)?;
                let metadata = fs::symlink_metadata(&path).map_err(|_| uncertain())?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > 4 * 1024 * 1024 + 4096
                {
                    return Err(uncertain());
                }
                let intent: CreateIntent =
                    serde_json::from_slice(&fs::read(path).map_err(|_| uncertain())?)
                        .map_err(|_| uncertain())?;
                if intent.window_id != record.id
                    || intent.operation_id != receipt.operation_id
                    || config_digest(intent.shardbrowser.as_ref())?.as_ref() != Some(expected)
                {
                    return Err(uncertain());
                }
                overlay_config(
                    &mut config,
                    intent.shardbrowser.as_ref().ok_or_else(uncertain)?,
                    edited,
                );
            } else {
                // Profiles created before the full editor already have a frozen identity.
                let original = config.clone();
                overlay_config(&mut config, &original, edited);
            }
            let obj = config.as_object_mut().ok_or_else(uncertain)?;
            if !obj.get("_meta").is_some_and(serde_json::Value::is_object) {
                obj.insert("_meta".into(), json!({}));
            }
            config["_meta"]["id"] = json!(record.id);
            // Normalize changed snapshots only. An untouched identity is already frozen.
            let frozen = self.profile_config(connection, record)?;
            if config != frozen {
                let version = record.kernel_version.as_deref().ok_or_else(unavailable)?;
                let sdk = self.kernels.pinned(version).map_err(|_| unavailable())?;
                // Seed-0 sentinels resolve to the same identity on every edit. No hardware draws.
                config = sdk
                    .normalize_pinned_profile_config(config, &record.id)
                    .map_err(|_| BrowserError::new("invalid_config", "指纹配置无效"))?
                    .config;
            }
        }
        shardx::validate_fingerprint_config(&config)
            .map_err(|_| BrowserError::new("invalid_config", "指纹配置无效"))?;
        Ok(Profile::new(config, Some(record.id.clone())))
    }

    pub(crate) fn with_extension_library_lock<T>(
        &self,
        action: impl FnOnce() -> BrowserResult<T>,
    ) -> BrowserResult<T> {
        let _operations_guard = self.operations.lock().map_err(|_| unavailable())?;
        let _library_guard = crate::core::shardbrowser_extensions::library_launch_guard()?;
        action()
    }

    pub(crate) fn extension_profile_state_locked(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<WindowState> {
        self.record(connection, record)?;
        self.state(&record.id)
    }

    fn state(&self, id: &str) -> BrowserResult<WindowState> {
        let folder = self.folder(id)?;
        let running = folder.join("running.json");
        if !marker_exists(&running)? {
            if self
                .sessions
                .lock()
                .map_err(|_| unavailable())?
                .contains_key(id)
            {
                return Ok(WindowState::Unknown);
            }
            if marker_exists(&folder.join("DevToolsActivePort"))?
                || marker_exists(&folder.join("SingletonLock"))?
            {
                return Ok(WindowState::Unknown);
            }
            return Ok(WindowState::Stopped);
        }
        let meta = fs::symlink_metadata(&running).map_err(|_| uncertain())?;
        if !meta.is_file() || meta.len() > 4096 {
            return Ok(WindowState::Unknown);
        }
        let receipt: RunningReceipt =
            serde_json::from_slice(&fs::read(&running).map_err(|_| uncertain())?)
                .map_err(|_| uncertain())?;
        if receipt.profile_id != id || receipt.pid == 0 || receipt.port == 0 {
            return Ok(WindowState::Unknown);
        }
        let created = self.receipt(id)?;
        if created
            .as_ref()
            .is_none_or(|created| created.binary_path != receipt.binary_path)
        {
            return Ok(WindowState::Unknown);
        }
        let exited = {
            let mut sessions = self.sessions.lock().map_err(|_| unavailable())?;
            match sessions.get_mut(id) {
                Some(session) => session.exited().map_err(|_| uncertain())?,
                None => None,
            }
        };
        match process_identity(receipt.pid, &folder, &receipt.binary_path) {
            Some(true) => {
                let endpoint = CdpEndpoint::from_port(receipt.port);
                if endpoint
                    .is_ok_and(|endpoint| endpoint.matches_debugger_path(&receipt.debugger_path))
                {
                    return Ok(WindowState::Running);
                }
                Ok(WindowState::Unknown)
            }
            Some(false) if exited.unwrap_or(pid_alive(receipt.pid) == Some(false)) => {
                self.clear_stale_markers(&folder, receipt.pid)?;
                fs::remove_file(running).map_err(|_| uncertain())?;
                sync_directory(&folder)?;
                if let Some(mut session) =
                    self.sessions.lock().map_err(|_| unavailable())?.remove(id)
                {
                    session.detach();
                }
                Ok(WindowState::Stopped)
            }
            _ => Ok(WindowState::Unknown),
        }
    }

    fn stopped(&self, id: &str) -> BrowserResult<()> {
        match self.state(id)? {
            WindowState::Stopped => Ok(()),
            WindowState::Unknown => Err(uncertain()),
            _ => Err(BrowserError::new("profile_busy", "请先停止窗口")),
        }
    }

    fn clear_stale_markers(&self, folder: &Path, pid: u32) -> BrowserResult<()> {
        #[cfg(unix)]
        match fs::symlink_metadata(folder.join("SingletonLock")) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = fs::read_link(folder.join("SingletonLock")).map_err(|_| uncertain())?;
                if !link.to_string_lossy().ends_with(&format!("-{pid}")) {
                    return Err(uncertain());
                }
            }
            Ok(_) => return Err(uncertain()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(uncertain()),
        }
        #[cfg(windows)]
        if folder.join("SingletonLock").exists() {
            return Err(uncertain());
        }
        for name in ["SingletonLock", "DevToolsActivePort"] {
            match fs::remove_file(folder.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(uncertain()),
            }
        }
        Ok(())
    }
}

impl BrowserProvider for ShardBrowserProvider {
    fn id(&self) -> BrowserProviderId {
        BrowserProviderId::ShardBrowser
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
        Self::check(connection)?;
        let ready = !self
            .kernels
            .installed()
            .map_err(|_| unavailable())?
            .is_empty();
        Ok(ProviderProbe {
            connected: ready,
            message: if ready {
                "内核已就绪"
            } else {
                "请在实验室下载内核"
            }
            .into(),
            scope_id: Some(SHARDBROWSER_CONNECTION_ID.into()),
            capabilities: self.capabilities(),
        })
    }
    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        Self::check(connection)?;
        Ok(Vec::new())
    }
    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        Self::check(connection)?;
        Ok(Vec::new())
    }
    fn create_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        operation_id: &str,
    ) -> BrowserResult<CreatedProfile> {
        Self::check(connection)?;
        validate_supported_settings(&record.settings)?;
        if record.settings.fingerprint_seed.is_none() {
            return Err(BrowserError::new("invalid_config", "缺少指纹种子"));
        }
        if record.binding.provider_id != self.id()
            || record.binding.connection_id != connection.id
            || record.binding.profile_id != record.id
            || record.proxy_mode == ProxyMode::Provider
        {
            return Err(BrowserError::new(
                "invalid_config",
                "窗口绑定或代理来源无效",
            ));
        }
        uuid::Uuid::parse_str(operation_id)
            .map_err(|_| BrowserError::new("invalid_config", "操作 ID 无效"))?;
        crate::core::shardbrowser_extensions::validate_profile_selection(
            &self.root,
            &connection.id,
            record.settings.shardbrowser.as_ref(),
        )?;
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let folder = self.folder(&record.id)?;
        if marker_exists(&self.intent_path(operation_id)?)? {
            let receipt = self.recover_create(operation_id)?.ok_or_else(uncertain)?;
            if receipt.window_id != record.id
                || receipt.fingerprint_seed != record.settings.fingerprint_seed
                || receipt.cpu_cores != record.settings.cpu_cores
                || receipt.config_sha256 != config_digest(record.settings.shardbrowser.as_ref())?
                || record
                    .kernel_version
                    .as_ref()
                    .is_some_and(|version| version != &receipt.version)
            {
                return Err(uncertain());
            }
            return Ok(CreatedProfile {
                profile_id: record.id.clone(),
                kernel_version: Some(receipt.version),
                binary_path: Some(receipt.binary_path),
                provider_config: json!({"managed":true}),
            });
        }
        if let Some(receipt) = self.receipt(&record.id)? {
            if receipt.operation_id == operation_id
                && receipt
                    .fingerprint_seed
                    .is_none_or(|seed| Some(seed) == record.settings.fingerprint_seed)
                && receipt.cpu_cores == record.settings.cpu_cores
                && receipt.config_sha256 == config_digest(record.settings.shardbrowser.as_ref())?
                && receipt.version == record.kernel_version.as_deref().unwrap_or(&receipt.version)
                && receipt.profile_sha256 == self.profile_digest(&record.id)?
                && receipt.binary_path
                    == self
                        .kernels
                        .pinned(&receipt.version)
                        .map_err(|_| uncertain())?
                        .runtime
                        .binary_path()
            {
                return Ok(CreatedProfile {
                    profile_id: record.id.clone(),
                    kernel_version: Some(receipt.version),
                    binary_path: Some(receipt.binary_path),
                    provider_config: json!({"managed":true}),
                });
            }
            return Err(uncertain());
        }
        if folder.exists() {
            return Err(uncertain());
        }
        let installed = self.kernels.installed().map_err(|_| unavailable())?;
        let selected = if let Some(version) = record.kernel_version.as_deref() {
            installed.into_iter().find(|entry| entry.version == version)
        } else {
            installed.into_iter().next()
        }
        .ok_or_else(|| BrowserError::new("invalid_config", "请先在实验室下载浏览器内核"))?;
        let sdk = self
            .kernels
            .pinned_with_profiles(&selected.version, Some(self.root.clone()))
            .map_err(|_| unavailable())?;
        fs::create_dir_all(&self.root).map_err(|_| unavailable())?;
        let intent = CreateIntent {
            window_id: record.id.clone(),
            operation_id: operation_id.into(),
            version: selected.version.clone(),
            binary_path: selected.binary_path.clone(),
            fingerprint_seed: record.settings.fingerprint_seed.ok_or_else(unavailable)?,
            cpu_cores: record.settings.cpu_cores,
            created_at: record.created_at,
            name: record.name.clone(),
            shardbrowser: record.settings.shardbrowser.clone(),
        };
        // The intent survives a crash between freezing profile.json and writing create.json.
        write_receipt(&self.intent_path(operation_id)?, &intent)?;
        // SDK owns exclusive directory creation. A partial identity is never rerolled.
        let seed = record.settings.fingerprint_seed.ok_or_else(unavailable)?;
        match &record.settings.shardbrowser {
            Some(config) => sdk.create_pinned_profile_config(config.clone(), &record.id, seed),
            None => sdk.create_pinned_profile(None, &record.id, seed),
        }
        .map_err(|_| uncertain())?;
        let receipt = Receipt {
            window_id: record.id.clone(),
            operation_id: operation_id.into(),
            version: selected.version.clone(),
            binary_path: selected.binary_path.clone(),
            profile_sha256: self.profile_digest(&record.id)?,
            created_at: record.created_at,
            name: record.name.clone(),
            fingerprint_seed: record.settings.fingerprint_seed,
            cpu_cores: record.settings.cpu_cores,
            config_sha256: config_digest(record.settings.shardbrowser.as_ref())?,
        };
        write_receipt(&folder.join("create.json"), &receipt)?;
        Ok(CreatedProfile {
            profile_id: record.id.clone(),
            kernel_version: Some(selected.version),
            binary_path: Some(selected.binary_path),
            provider_config: json!({"managed":true}),
        })
    }
    fn update_profile(
        &self,
        connection: &BrowserConnection,
        before: &WindowRecord,
        after: &WindowRecord,
    ) -> BrowserResult<()> {
        crate::core::shardbrowser_extensions::validate_profile_selection(
            &self.root,
            &connection.id,
            after.settings.shardbrowser.as_ref(),
        )?;
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        self.record(connection, before)?;
        self.record(connection, after)?;
        if before.settings.shardbrowser.is_some() && after.settings.shardbrowser.is_none() {
            return Err(BrowserError::new("invalid_config", "完整指纹配置不能移除"));
        }
        self.editable_profile(connection, after)?;
        if before.binding != after.binding
            || before.kernel_version != after.kernel_version
            || before.id != after.id
            || before.binary_path != after.binary_path
            || before.settings.fingerprint_seed != after.settings.fingerprint_seed
            || before.settings.cpu_cores != after.settings.cpu_cores
            || before.settings.operating_system != after.settings.operating_system
            || before.settings.alias_engine != after.settings.alias_engine
        {
            return Err(BrowserError::new(
                "invalid_config",
                "浏览器身份创建后不可修改",
            ));
        }
        self.stopped(&before.id)
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
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let (folder, _) = self.record(connection, record)?;
        self.stopped(&record.id)?;
        let meta = fs::symlink_metadata(&folder).map_err(|_| uncertain())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(uncertain());
        }
        let sdk = self
            .kernels
            .pinned_with_profiles(
                record.kernel_version.as_deref().ok_or_else(unavailable)?,
                Some(self.root.clone()),
            )
            .map_err(|_| unavailable())?;
        sdk.delete_profile(&record.id).map_err(|_| uncertain())?;
        sync_directory(&self.root)
    }
    fn start_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        proxy: &ResolvedProxy,
    ) -> BrowserResult<()> {
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let _library_guard = crate::core::shardbrowser_extensions::library_launch_guard()?;
        let (folder, version) = self.record(connection, record)?;
        self.stopped(&record.id)?;
        if proxy.mode != record.proxy_mode || proxy.mode == ProxyMode::Provider {
            return Err(BrowserError::new("invalid_config", "窗口代理来源无效"));
        }
        let address = match proxy.mode {
            ProxyMode::Direct if proxy.connection_url.is_none() => None,
            ProxyMode::Manual | ProxyMode::Plugin => Some(
                proxy
                    .connection_url
                    .clone()
                    .ok_or_else(|| BrowserError::new("invalid_config", "代理未就绪，已阻止启动"))?,
            ),
            _ => {
                return Err(BrowserError::new(
                    "invalid_config",
                    "代理未就绪，已阻止启动",
                ));
            }
        };
        let sdk = self
            .kernels
            .pinned_with_profiles(&version, Some(self.root.clone()))
            .map_err(|_| unavailable())?;
        let profile = self.editable_profile(connection, record)?;
        if let Some(database) = &self.database {
            let _profile_lock = sdk
                .lock_stopped_profile(&record.id)
                .map_err(|_| uncertain())?;
            crate::core::shardbrowser_bookmarks::apply_for_profile(
                database,
                &connection.id,
                &record.id,
                &folder,
            )?;
        }
        let (profile, mut options) = launch_profile(profile, &record.settings)?;
        let (extensions, extension_library) = crate::core::shardbrowser_extensions::launch_paths(
            &self.root,
            &connection.id,
            record.settings.shardbrowser.as_ref(),
        )?;
        options.extensions = extensions;
        options.extension_library = Some(extension_library);
        options
            .extra_args
            .extend(crate::core::automation::helper::launch_args(
                &connection.id,
                &record.id,
            )?);
        options.proxy = address;
        options.require_proxy_geo = proxy.mode != ProxyMode::Direct;
        if proxy.mode != ProxyMode::Direct {
            options.quic = Some(false);
            if options.webrtc != Some(WebRtcMode::Block) {
                options.webrtc = Some(WebRtcMode::TcpOnly);
            }
        }
        options.user_data_dir = Some(self.root.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| unavailable())?;
        let mut session = runtime
            .block_on(sdk.launch_pinned_cdp(profile, options))
            .map_err(launch_failure)?;
        let persist = (|| {
            if session.user_data_dir != folder {
                return Err(uncertain());
            }
            let url = url::Url::parse(session.cdp_url.as_deref().ok_or_else(unavailable)?)
                .map_err(|_| unavailable())?;
            let port = url.port().ok_or_else(unavailable)?;
            let endpoint = CdpEndpoint::from_port(port)?;
            if !endpoint.matches_debugger_path(url.path()) {
                return Err(unavailable());
            }
            let receipt = RunningReceipt {
                pid: session.pid,
                profile_id: record.id.clone(),
                binary_path: record.binary_path.clone().ok_or_else(unavailable)?,
                port,
                debugger_path: url.path().into(),
            };
            write_receipt(&folder.join("running.json"), &receipt)?;
            Ok(())
        })();
        if let Err(error) = persist {
            if runtime.block_on(session.stop()).is_ok() && pid_alive(session.pid) == Some(false) {
                let _ = fs::remove_file(folder.join("running.json"));
                let _ = self.clear_stale_markers(&folder, session.pid);
            }
            return Err(error);
        }
        self.sessions
            .lock()
            .map_err(|_| unavailable())?
            .insert(record.id.clone(), session);
        Ok(())
    }
    fn stop_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let (folder, _) = self.record(connection, record)?;
        if self.state(&record.id)? == WindowState::Stopped {
            return Ok(());
        }
        if self.state(&record.id)? != WindowState::Running {
            return Err(uncertain());
        }
        let mut sessions = self.sessions.lock().map_err(|_| unavailable())?;
        if let Some(session) = sessions.get_mut(&record.id) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| unavailable())?;
            runtime.block_on(session.stop()).map_err(|_| uncertain())?;
        } else {
            let receipt: RunningReceipt = serde_json::from_slice(
                &fs::read(folder.join("running.json")).map_err(|_| uncertain())?,
            )
            .map_err(|_| uncertain())?;
            if process_identity(receipt.pid, &folder, &receipt.binary_path) != Some(true) {
                return Err(uncertain());
            }
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| unavailable())?;
            let websocket = format!("ws://127.0.0.1:{}{}", receipt.port, receipt.debugger_path);
            runtime.block_on(shardx::request_browser_close(&websocket));
            let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while pid_alive(receipt.pid) != Some(false) && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if pid_alive(receipt.pid) != Some(false) {
                if process_identity(receipt.pid, &folder, &receipt.binary_path) != Some(true) {
                    return Err(uncertain());
                }
                stop_process(receipt.pid)?;
            }
        }
        drop(sessions);
        let until = std::time::Instant::now() + std::time::Duration::from_secs(12);
        while pid_alive_from_receipt(&folder) {
            if std::time::Instant::now() >= until {
                return Err(uncertain());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if self.state(&record.id)? == WindowState::Stopped {
            Ok(())
        } else {
            Err(uncertain())
        }
    }
    fn observe_profiles(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles> {
        Self::check(connection)?;
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let mut states = HashMap::new();
        for record in records {
            self.record(connection, record)?;
            states.insert(record.id.clone(), self.state(&record.id)?);
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
        Self::check(connection)?;
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        if let Some(receipt) = self.recover_create(operation_id)? {
            return Ok(Some(Self::remote(receipt)));
        }
        if !self.root.try_exists().map_err(|_| uncertain())? {
            return Ok(None);
        }
        for entry in fs::read_dir(&self.root).map_err(|_| uncertain())? {
            let entry = entry.map_err(|_| uncertain())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            if let Some(receipt) = self.receipt(&id)?
                && receipt.operation_id == operation_id
            {
                if receipt.profile_sha256 != self.profile_digest(&receipt.window_id)?
                    || self
                        .kernels
                        .pinned(&receipt.version)
                        .map_err(|_| uncertain())?
                        .runtime
                        .binary_path()
                        != receipt.binary_path
                {
                    return Err(uncertain());
                }
                return Ok(Some(Self::remote(receipt)));
            }
        }
        Ok(None)
    }
    fn reconcile_update(
        &self,
        connection: &BrowserConnection,
        before: &WindowRecord,
        after: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool> {
        evidence.validate(self.id())?;
        self.update_profile(connection, before, after)?;
        Ok(true)
    }
    fn reconcile_delete(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<bool> {
        Self::check(connection)?;
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        if record.binding.provider_id != self.id()
            || record.binding.connection_id != connection.id
            || record.binding.profile_id != record.id
        {
            return Err(BrowserError::new("scope_mismatch", "窗口绑定无效"));
        }
        Ok(!marker_exists(&self.folder(&record.id)?)?)
    }
    fn automation_session(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<AutomationSession> {
        let _guard = self.operations.lock().map_err(|_| unavailable())?;
        let (folder, _) = self.record(connection, record)?;
        if self.state(&record.id)? != WindowState::Running {
            return Err(unavailable());
        }
        let receipt: RunningReceipt = serde_json::from_slice(
            &fs::read(folder.join("running.json")).map_err(|_| unavailable())?,
        )
        .map_err(|_| unavailable())?;
        Ok(AutomationSession::Cdp(CdpEndpoint::from_port(
            receipt.port,
        )?))
    }
}

fn pid_alive_from_receipt(folder: &Path) -> bool {
    fs::read(folder.join("running.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RunningReceipt>(&bytes).ok())
        .and_then(|receipt| pid_alive(receipt.pid))
        .unwrap_or(true)
}
fn pid_alive(pid: u32) -> Option<bool> {
    Some(shardx::process_alive(pid))
}
fn command_matches(line: &str, folder: &Path, binary: &Path) -> bool {
    let binary = binary.to_string_lossy();
    let line = line.trim();
    let executable = line
        .strip_prefix(binary.as_ref())
        .is_some_and(|tail| tail.starts_with(' '))
        || line
            .strip_prefix(&format!("\"{binary}\""))
            .is_some_and(|tail| tail.starts_with(' '));
    let argument = format!("--user-data-dir={}", folder.display());
    let directory = line.match_indices(&argument).any(|(offset, _)| {
        let prefix = &line[..offset];
        let tail = &line[offset + argument.len()..];
        (prefix.ends_with(' ') || prefix.ends_with('"'))
            && (tail.is_empty() || tail.starts_with(' ') || tail.starts_with('"'))
    });
    executable && directory
}

#[cfg(unix)]
fn process_identity(pid: u32, folder: &Path, binary: &Path) -> Option<bool> {
    if pid_alive(pid) != Some(true) {
        return Some(false);
    }
    let output = Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    let line = String::from_utf8(output.stdout).ok()?;
    Some(output.status.success() && command_matches(&line, folder, binary))
}
#[cfg(windows)]
fn process_identity(pid: u32, folder: &Path, binary: &Path) -> Option<bool> {
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
    let line = String::from_utf8(output.stdout).ok()?;
    Some(output.status.success() && command_matches(&line, folder, binary))
}
#[cfg(unix)]
fn stop_process(pid: u32) -> BrowserResult<()> {
    let status = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|_| uncertain())?;
    if status.success() {
        Ok(())
    } else {
        Err(uncertain())
    }
}
#[cfg(windows)]
fn stop_process(pid: u32) -> BrowserResult<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .status()
        .map_err(|_| uncertain())?;
    if status.success() {
        Ok(())
    } else {
        Err(uncertain())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Profile {
        Profile::new(
            json!({"navigator":{"platform":"macOS","language":"auto"},"timezone":"auto","geolocation":{"mode":"auto"}}),
            Some("fixture".into()),
        )
    }

    #[test]
    fn launch_maps_supported_fields_without_changing_saved_identity() {
        let saved = profile();
        let settings = WindowSettings {
            geoip: false,
            timezone: "Europe/Paris".into(),
            locale: "fr-FR".into(),
            viewport: "1440x900".into(),
            cpu_cores: Some(12),
            start_url: "https://example.com/".into(),
            ..Default::default()
        };
        let (launched, options) = launch_profile(saved.clone(), &settings).unwrap();
        assert_eq!(saved.config["timezone"], "auto");
        assert_eq!(launched.config["timezone"], "Europe/Paris");
        assert_eq!(launched.config["navigator"]["language"], "fr-FR");
        assert_eq!(
            launched.config["navigator"]["languages"],
            json!(["fr-FR", "fr"])
        );
        assert_eq!(launched.config["navigator"]["hardware_concurrency"], 12);
        assert_eq!(launched.config["window"]["inner_width"], 1440);
        assert_eq!(launched.config["window"]["inner_height"], 900);
        assert!(launched.config.get("geolocation").is_none());
        assert_eq!(options.screen_mode, Some(ScreenStrategy::Profile));
        assert_eq!(options.start_url.as_deref(), Some("https://example.com/"));
        assert!(!options.randomize);
    }

    #[test]
    fn automatic_matching_and_offline_defaults_are_explicit() {
        let (automatic, _) = launch_profile(profile(), &WindowSettings::default()).unwrap();
        assert_eq!(automatic.config["timezone"], "auto");
        assert_eq!(automatic.config["navigator"]["language"], "auto");
        let (offline, _) = launch_profile(
            profile(),
            &WindowSettings {
                geoip: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(offline.config["timezone"], "UTC");
        assert_eq!(offline.config["navigator"]["language"], "en-US");
    }

    #[test]
    fn unsupported_and_invalid_settings_fail_before_launch() {
        for os in ["windows", "macos", "linux"] {
            assert_eq!(
                launch_profile(
                    profile(),
                    &WindowSettings {
                        operating_system: os.into(),
                        ..Default::default()
                    }
                )
                .err()
                .unwrap()
                .code,
                "unsupported"
            );
        }
        for settings in [
            WindowSettings {
                locale: "en-US --proxy-server=direct".into(),
                ..Default::default()
            },
            WindowSettings {
                start_url: "file:///private/secret".into(),
                ..Default::default()
            },
            WindowSettings {
                cpu_cores: Some(0),
                ..Default::default()
            },
            WindowSettings {
                alias_engine: Some("firefox".into()),
                ..Default::default()
            },
        ] {
            assert!(launch_profile(profile(), &settings).is_err());
        }
    }

    #[test]
    fn restart_identity_requires_executable_and_complete_profile_argument() {
        let binary = Path::new("/Applications/Shard Browser/browser");
        let folder = Path::new("/profiles/abc");
        assert!(command_matches(
            "/Applications/Shard Browser/browser --user-data-dir=/profiles/abc --no-first-run",
            folder,
            binary
        ));
        assert!(command_matches(
            "\"/Applications/Shard Browser/browser\" \"--user-data-dir=/profiles/abc\"",
            folder,
            binary
        ));
        assert!(!command_matches(
            "/other --text=/Applications/Shard Browser/browser --user-data-dir=/profiles/abc",
            folder,
            binary
        ));
        assert!(!command_matches(
            "/Applications/Shard Browser/browser --user-data-dir=/profiles/abcdef",
            folder,
            binary
        ));
    }

    #[cfg(unix)]
    #[test]
    fn confirmed_exit_clears_receipt_and_dangling_lock_but_missing_evidence_stays_unknown() {
        let root = std::env::temp_dir().join(format!("raccoon-state-{}", uuid::Uuid::new_v4()));
        let provider = ShardBrowserProvider::new(
            root.join("profiles"),
            Arc::new(ShardKernelService::new(root.join("kernels"), None)),
        );
        let id = uuid::Uuid::new_v4().to_string();
        let folder = provider.folder(&id).unwrap();
        fs::create_dir_all(&folder).unwrap();
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        std::os::unix::fs::symlink(format!("host-{pid}"), folder.join("SingletonLock")).unwrap();
        assert_eq!(provider.state(&id).unwrap(), WindowState::Unknown);
        let binary = root.join("browser");
        write_receipt(
            &folder.join("create.json"),
            &Receipt {
                window_id: id.clone(),
                operation_id: uuid::Uuid::new_v4().to_string(),
                version: "157.0.8103.39".into(),
                binary_path: binary.clone(),
                profile_sha256: "a".repeat(64),
                created_at: 1,
                name: "fixture".into(),
                fingerprint_seed: Some(123),
                cpu_cores: None,
                config_sha256: None,
            },
        )
        .unwrap();
        write_receipt(
            &folder.join("running.json"),
            &RunningReceipt {
                pid,
                profile_id: id.clone(),
                binary_path: binary,
                port: 12345,
                debugger_path: "/devtools/browser/fixture".into(),
            },
        )
        .unwrap();
        assert_eq!(provider.state(&id).unwrap(), WindowState::Stopped);
        assert!(!marker_exists(&folder.join("SingletonLock")).unwrap());
        assert!(!marker_exists(&folder.join("running.json")).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_refuses_incomplete_or_mismatched_evidence() {
        let root = std::env::temp_dir().join(format!("raccoon-recovery-{}", uuid::Uuid::new_v4()));
        let kernels = Arc::new(ShardKernelService::new(root.join("kernels"), None));
        let provider = ShardBrowserProvider::new(root.join("profiles"), kernels);
        let id = uuid::Uuid::new_v4().to_string();
        let operation = uuid::Uuid::new_v4().to_string();
        fs::create_dir_all(provider.folder(&id).unwrap()).unwrap();
        assert!(provider.recover_create(&operation).unwrap().is_none());
        let intent = CreateIntent {
            window_id: id.clone(),
            operation_id: operation.clone(),
            version: "157.0.8103.39".into(),
            binary_path: root.join("browser"),
            fingerprint_seed: 123,
            cpu_cores: None,
            created_at: 1,
            name: "test".into(),
            shardbrowser: None,
        };
        write_receipt(&provider.intent_path(&operation).unwrap(), &intent).unwrap();
        assert!(provider.recover_create(&operation).is_err());
        fs::write(
            provider.folder(&id).unwrap().join("profile.json"),
            b"{truncated",
        )
        .unwrap();
        assert!(provider.recover_create(&operation).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn receipts_publish_complete_json_and_never_replace_evidence() {
        let root = std::env::temp_dir().join(format!("raccoon-receipt-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("create.json");
        write_receipt(&path, &json!({"operation":1})).unwrap();
        assert!(write_receipt(&path, &json!({"operation":2})).is_err());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
            json!({"operation":1})
        );
        fs::remove_dir_all(root).unwrap();
    }
}
