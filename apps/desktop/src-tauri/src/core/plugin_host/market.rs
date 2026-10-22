use super::manifest::PluginManifest;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MARKET_SCHEMA_VERSION: u32 = 1;
pub const SETTINGS_FILE: &str = "store.json";
pub const CATALOG_NAME: &str = "catalog.json";
pub const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 256;
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(25);
/// How often the background scanner looks for a newer catalog.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// First pass runs shortly after boot so the window paints first.
pub const CHECK_DELAY: Duration = Duration::from_secs(40);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarketError {
    NotConfigured,
    UnsupportedUrl,
    Offline,
    Status(u16),
    TooLarge,
    Malformed,
    Io,
}

impl MarketError {
    pub fn code(&self) -> &str {
        match self {
            MarketError::NotConfigured => "NOT_CONFIGURED",
            MarketError::UnsupportedUrl | MarketError::Malformed => "INVALID_REQUEST",
            MarketError::Status(404) => "NOT_CONFIGURED",
            MarketError::Offline | MarketError::Status(_) | MarketError::TooLarge => "UNAVAILABLE",
            MarketError::Io => "UNAVAILABLE",
        }
    }

    pub fn message(&self) -> String {
        match self {
            MarketError::NotConfigured => "还没有配置插件商店地址".into(),
            MarketError::UnsupportedUrl => "商店地址只支持 http、https 或 file".into(),
            MarketError::Offline => "连不上插件商店，请检查网络或地址".into(),
            MarketError::Status(status) => format!("插件商店返回了 HTTP {status}"),
            MarketError::TooLarge => "商店返回的内容超过大小上限".into(),
            MarketError::Malformed => "商店返回的清单格式不正确".into(),
            MarketError::Io => "无法读写本地商店缓存".into(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreSettings {
    #[serde(default)]
    pub store_url: Option<String>,
    #[serde(default)]
    pub last_checked_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// One published plugin. The manifest is carried verbatim so the host can show
/// name, version and capabilities before downloading anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub manifest: PluginManifest,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub changelog: String,
    pub package: PackageRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRef {
    pub url: String,
    #[serde(default)]
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogDocument {
    schema_version: u32,
    /// Kept as raw values so one malformed row cannot blank the whole store.
    #[serde(default)]
    plugins: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub entries: Vec<Entry>,
}

impl Catalog {
    pub fn parse(bytes: &[u8]) -> Result<Self, MarketError> {
        let document: CatalogDocument =
            serde_json::from_slice(bytes).map_err(|_| MarketError::Malformed)?;
        if document.schema_version != MARKET_SCHEMA_VERSION {
            return Err(MarketError::Malformed);
        }
        if document.plugins.len() > MAX_ENTRIES {
            return Err(MarketError::Malformed);
        }
        let mut entries: Vec<Entry> = Vec::new();
        for value in document.plugins {
            // A single bad row must not blank the whole store, but a row that
            // cannot be validated is dropped rather than trusted.
            let Ok(entry) = serde_json::from_value::<Entry>(value) else {
                continue;
            };
            if entry.manifest.validate().is_err() || entry.package.sha256.len() != 64 {
                continue;
            }
            if entries
                .iter()
                .any(|seen| seen.manifest.id == entry.manifest.id)
            {
                continue;
            }
            entries.push(entry);
        }
        entries.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
        Ok(Catalog { entries })
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.manifest.id == id)
    }
}

/// Settings live in one JSON file next to the registry, written through a
/// temporary file and a rename so a crash cannot leave half a store URL behind.
pub struct MarketStore {
    path: PathBuf,
}

impl MarketStore {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(SETTINGS_FILE),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> StoreSettings {
        let Ok(bytes) = fs::read(&self.path) else {
            return StoreSettings::default();
        };
        if bytes.len() > 64 * 1024 {
            return StoreSettings::default();
        }
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    pub fn save(&self, settings: &StoreSettings) -> Result<(), MarketError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| MarketError::Io)?;
        }
        let bytes = serde_json::to_vec_pretty(settings).map_err(|_| MarketError::Io)?;
        let temporary = self.path.with_extension("json.tmp");
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temporary)
                .map_err(|_| MarketError::Io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
            }
            file.write_all(&bytes).map_err(|_| MarketError::Io)?;
            file.sync_all().map_err(|_| MarketError::Io)?;
        }
        fs::rename(&temporary, &self.path).map_err(|_| MarketError::Io)
    }
}

/// Normalises what the user typed. A bare host is upgraded to https, a missing
/// file name becomes `catalog.json`, and trailing slashes are dropped so the
/// join below stays predictable.
pub fn normalize_store_url(input: &str) -> Result<String, MarketError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(MarketError::NotConfigured);
    }
    if trimmed.len() > 2048 || trimmed.chars().any(char::is_whitespace) {
        return Err(MarketError::UnsupportedUrl);
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let lowered = with_scheme.to_ascii_lowercase();
    let allowed = ["https://", "http://", "file://"];
    if !allowed.iter().any(|scheme| lowered.starts_with(scheme)) {
        return Err(MarketError::UnsupportedUrl);
    }
    let url = url::Url::parse(&with_scheme).map_err(|_| MarketError::UnsupportedUrl)?;
    let path = url.path().trim_end_matches('/').to_string();
    let path = if path.ends_with(".json") {
        path
    } else {
        format!("{path}/{CATALOG_NAME}")
    };
    let mut normalized = url.clone();
    normalized.set_path(&path);
    normalized.set_query(None);
    normalized.set_fragment(None);
    Ok(normalized.to_string())
}

/// Base used to resolve relative package URLs: everything up to the directory
/// that holds `catalog.json`.
pub fn store_base(catalog_url: &str) -> String {
    match catalog_url.rfind('/') {
        Some(index) => catalog_url[..=index].to_string(),
        None => catalog_url.to_string(),
    }
}

pub fn resolve_package_url(base: &str, reference: &str) -> String {
    let lowered = reference.to_ascii_lowercase();
    if lowered.starts_with("https://")
        || lowered.starts_with("http://")
        || lowered.starts_with("file://")
    {
        return reference.to_string();
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        reference.trim_start_matches('/')
    )
}

/// Reads a URL into memory with a hard size ceiling. `file://` is supported so a
/// local folder can be used as a store while developing.
pub fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, MarketError> {
    let parsed = url::Url::parse(url).map_err(|_| MarketError::UnsupportedUrl)?;
    match parsed.scheme() {
        "file" => {
            let path = parsed
                .to_file_path()
                .map_err(|_| MarketError::UnsupportedUrl)?;
            let metadata = fs::metadata(&path).map_err(|_| MarketError::Status(404))?;
            if metadata.len() > limit {
                return Err(MarketError::TooLarge);
            }
            fs::read(&path).map_err(|_| MarketError::Status(404))
        }
        "http" | "https" => {
            // reqwest's blocking client owns a private runtime. Running it on a
            // thread of its own keeps it clear of the app's async runtime, where
            // dropping such a client can panic.
            let (sender, receiver) = std::sync::mpsc::channel();
            let target = url.to_string();
            std::thread::spawn(move || {
                let _ = sender.send(fetch_http(&target, limit));
            });
            receiver.recv().unwrap_or(Err(MarketError::Offline))
        }
        _ => Err(MarketError::UnsupportedUrl),
    }
}

fn fetch_http(url: &str, limit: u64) -> Result<Vec<u8>, MarketError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("NexusStudio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| MarketError::Offline)?;
    let response = client.get(url).send().map_err(|_| MarketError::Offline)?;
    if !response.status().is_success() {
        return Err(MarketError::Status(response.status().as_u16()));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(MarketError::TooLarge);
    }
    let bytes = response.bytes().map_err(|_| MarketError::Offline)?;
    if bytes.len() as u64 > limit {
        return Err(MarketError::TooLarge);
    }
    Ok(bytes.to_vec())
}

pub fn now_timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

pub fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let left = semver::Version::parse(left).ok()?;
    let right = semver::Version::parse(right).ok()?;
    Some(left.cmp(&right))
}
