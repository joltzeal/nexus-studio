use super::{manifest::PluginManifest, registry::digest};
use crate::core::network_proxy::NetworkProxy;
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MARKET_SCHEMA_VERSION: u32 = 1;
const SIGNED_MARKET_SCHEMA_VERSION: u32 = 2;
pub const SETTINGS_FILE: &str = "store.json";
pub const CATALOG_NAME: &str = "catalog.json";
pub const LEGACY_CATALOG_URL: &str =
    "https://pub-7a28fdded53a4aa1874d914af7aa06ad.r2.dev/catalog.json";
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
    Proxy(String),
    Status(u16),
    TooLarge,
    Malformed,
    Untrusted,
    Io,
}

impl MarketError {
    pub fn code(&self) -> &str {
        match self {
            MarketError::NotConfigured => "NOT_CONFIGURED",
            MarketError::UnsupportedUrl | MarketError::Malformed | MarketError::Untrusted => {
                "INVALID_REQUEST"
            }
            MarketError::Status(404) => "NOT_CONFIGURED",
            MarketError::Offline
            | MarketError::Proxy(_)
            | MarketError::Status(_)
            | MarketError::TooLarge => "UNAVAILABLE",
            MarketError::Io => "UNAVAILABLE",
        }
    }

    pub fn message(&self) -> String {
        match self {
            MarketError::NotConfigured => "还没有配置插件商店地址".into(),
            MarketError::UnsupportedUrl => "商店地址只支持 http、https 或 file".into(),
            MarketError::Offline => "连不上插件商店，请检查网络或地址".into(),
            MarketError::Proxy(reason) => format!("应用代理不可用：{reason}"),
            MarketError::Status(status) => format!("插件商店返回了 HTTP {status}"),
            MarketError::TooLarge => "商店返回的内容超过大小上限".into(),
            MarketError::Malformed => "商店返回的清单格式不正确".into(),
            MarketError::Untrusted => "商店签名无效，或与已信任的商店身份不一致".into(),
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
    #[serde(default)]
    pub signing_pins: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseAuthority {
    pub issuer_id: String,
    pub protocol_version: u8,
    pub base_url: String,
    pub key_id: String,
    pub public_key: String,
}

impl LicenseAuthority {
    pub fn valid(&self) -> bool {
        self.protocol_version == 1
            && valid_identifier(&self.issuer_id)
            && valid_identifier(&self.key_id)
            && key_bytes(&self.public_key).is_some()
            && self.base_url.len() <= 2048
            && url::Url::parse(&self.base_url).is_ok_and(|url| {
                secure_url(&url)
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.origin().ascii_serialization() == self.base_url.trim_end_matches('/')
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketBinding {
    pub catalog_url: String,
    pub identity: String,
    pub authority: Option<LicenseAuthority>,
}

impl MarketBinding {
    pub fn legacy_official(&self) -> bool {
        self.catalog_url == LEGACY_CATALOG_URL
            && self.identity == digest(LEGACY_CATALOG_URL.as_bytes())
            && self.authority.is_none()
    }

    pub fn valid(&self) -> bool {
        self.identity.len() == 64
            && self.identity.bytes().all(|byte| byte.is_ascii_hexdigit())
            && normalize_store_url(&self.catalog_url).as_deref() == Ok(self.catalog_url.as_str())
            && self.authority.as_ref().is_none_or(LicenseAuthority::valid)
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn key_bytes(value: &str) -> Option<[u8; 32]> {
    STANDARD.decode(value).ok()?.try_into().ok()
}

fn secure_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
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
    pub requires_license: Option<bool>,
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
    market: Option<MarketDeclaration>,
    signed: Option<SignedCatalog>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketDeclaration {
    id: String,
    catalog_url: String,
    licensing: Option<LicenseAuthority>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedCatalog {
    public_key: String,
    payload: String,
    signature: String,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub entries: Vec<Entry>,
    pub source_url: String,
    pub identity: String,
    pub signing_pin: Option<String>,
    licensing: Option<LicenseAuthority>,
}

impl Catalog {
    pub fn parse(bytes: &[u8], source_url: &str, pin: Option<&str>) -> Result<Self, MarketError> {
        let outer: CatalogDocument =
            serde_json::from_slice(bytes).map_err(|_| MarketError::Malformed)?;
        let (document, signing_pin) = if let Some(signed) = outer.signed {
            if outer.schema_version != SIGNED_MARKET_SCHEMA_VERSION {
                return Err(MarketError::Malformed);
            }
            let source = url::Url::parse(source_url).map_err(|_| MarketError::Untrusted)?;
            if !secure_url(&source) {
                return Err(MarketError::Untrusted);
            }
            let key = key_bytes(&signed.public_key).ok_or(MarketError::Untrusted)?;
            let payload = STANDARD
                .decode(&signed.payload)
                .map_err(|_| MarketError::Untrusted)?;
            let signature = STANDARD
                .decode(&signed.signature)
                .map_err(|_| MarketError::Untrusted)?;
            UnparsedPublicKey::new(&ED25519, key)
                .verify(&payload, &signature)
                .map_err(|_| MarketError::Untrusted)?;
            let document: CatalogDocument =
                serde_json::from_slice(&payload).map_err(|_| MarketError::Malformed)?;
            let market = document.market.as_ref().ok_or(MarketError::Untrusted)?;
            if market.catalog_url != source_url
                || !valid_identifier(&market.id)
                || market
                    .licensing
                    .as_ref()
                    .is_some_and(|authority| !authority.valid())
            {
                return Err(MarketError::Untrusted);
            }
            let identity = digest(
                format!("{}\n{}\n{}", source_url, market.id, STANDARD.encode(key)).as_bytes(),
            );
            if pin.is_some_and(|pin| pin != identity) {
                return Err(MarketError::Untrusted);
            }
            (document, Some(identity))
        } else {
            if pin.is_some() || outer.market.is_some() {
                return Err(MarketError::Untrusted);
            }
            (outer, None)
        };
        let expected_version = if signing_pin.is_some() {
            SIGNED_MARKET_SCHEMA_VERSION
        } else {
            MARKET_SCHEMA_VERSION
        };
        if document.schema_version != expected_version {
            return Err(MarketError::Malformed);
        }
        if document.plugins.len() > MAX_ENTRIES {
            return Err(MarketError::Malformed);
        }
        let licensing = document.market.and_then(|market| market.licensing);
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
            if source_url != LEGACY_CATALOG_URL
                && super::license::FIRST_PARTY_PLUGIN_IDS.contains(&entry.manifest.id.as_str())
            {
                continue;
            }
            match (signing_pin.is_some(), entry.requires_license) {
                (true, Some(false)) | (false, None) => {}
                (true, Some(true)) if licensing.is_some() => {}
                _ => return Err(MarketError::Malformed),
            }
            if entries
                .iter()
                .any(|seen| seen.manifest.id == entry.manifest.id)
            {
                if signing_pin.is_some() {
                    return Err(MarketError::Malformed);
                }
                continue;
            }
            entries.push(entry);
        }
        entries.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
        Ok(Catalog {
            entries,
            source_url: source_url.into(),
            identity: signing_pin
                .clone()
                .unwrap_or_else(|| digest(source_url.as_bytes())),
            signing_pin,
            licensing,
        })
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.manifest.id == id)
    }

    pub fn binding(&self, entry: &Entry) -> MarketBinding {
        MarketBinding {
            catalog_url: self.source_url.clone(),
            identity: self.identity.clone(),
            authority: self
                .licensing
                .clone()
                .filter(|_| entry.requires_license == Some(true)),
        }
    }

    pub fn selection(&self, entry: &Entry) -> String {
        digest(
            format!(
                "{}\n{}\n{}\n{}",
                self.identity,
                entry.manifest.id,
                entry.manifest.version,
                serde_json::to_string(&(&entry.package, self.binding(entry))).unwrap_or_default(),
            )
            .as_bytes(),
        )
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
        self.load_checked().unwrap_or_default()
    }

    pub fn load_checked(&self) -> Result<StoreSettings, MarketError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoreSettings::default());
            }
            Err(_) => return Err(MarketError::Io),
        };
        if bytes.len() > 64 * 1024 {
            return Err(MarketError::TooLarge);
        }
        serde_json::from_slice(&bytes).map_err(|_| MarketError::Io)
    }

    pub fn save(&self, settings: &StoreSettings) -> Result<(), MarketError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| MarketError::Io)?;
        }
        let bytes = serde_json::to_vec_pretty(settings).map_err(|_| MarketError::Io)?;
        if bytes.len() > 64 * 1024 {
            return Err(MarketError::TooLarge);
        }
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
    fetch_with_proxy(url, limit, &NetworkProxy::default())
}

pub fn fetch_with_proxy(
    url: &str,
    limit: u64,
    proxy: &NetworkProxy,
) -> Result<Vec<u8>, MarketError> {
    fetch_url(url, limit, proxy, true)
}

pub fn fetch_catalog(url: &str, proxy: &NetworkProxy) -> Result<Vec<u8>, MarketError> {
    fetch_url(url, MAX_CATALOG_BYTES, proxy, false)
}

fn fetch_url(
    url: &str,
    limit: u64,
    proxy: &NetworkProxy,
    redirects: bool,
) -> Result<Vec<u8>, MarketError> {
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
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let _ = sender.send(fetch_http(&target, limit, &proxy, redirects));
            });
            receiver.recv().unwrap_or(Err(MarketError::Offline))
        }
        _ => Err(MarketError::UnsupportedUrl),
    }
}

fn fetch_http(
    url: &str,
    limit: u64,
    proxy: &NetworkProxy,
    redirects: bool,
) -> Result<Vec<u8>, MarketError> {
    let endpoint = proxy.resolve().map_err(MarketError::Proxy)?;
    let mut builder = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("Raccoon/", env!("CARGO_PKG_VERSION")));
    if !redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    if let Some(endpoint) = endpoint {
        builder = builder.proxy(reqwest::Proxy::all(endpoint).map_err(|_| MarketError::Offline)?);
    }
    let client = builder.build().map_err(|_| MarketError::Offline)?;
    let response = client.get(url).send().map_err(|_| MarketError::Offline)?;
    if !response.status().is_success() {
        return Err(MarketError::Status(response.status().as_u16()));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(MarketError::TooLarge);
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| MarketError::Offline)?;
    if bytes.len() as u64 > limit {
        return Err(MarketError::TooLarge);
    }
    Ok(bytes)
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
