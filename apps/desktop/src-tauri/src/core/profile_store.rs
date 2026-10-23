use super::group_store::open_database;
use super::scheduler::ProfileBinding;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Where a window's traffic goes. One of the three, never two: a manual server
/// and a plugin endpoint in the same record would make the launch ambiguous.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxySource {
    pub server: Option<String>,
    pub plugin: Option<String>,
    /// One row of the plugin's inventory; `None` follows its default.
    pub endpoint: Option<i64>,
}

impl ProxySource {
    pub fn direct() -> Self {
        Self::default()
    }

    pub fn server(server: String) -> Self {
        Self {
            server: Some(server),
            ..Self::default()
        }
    }

    pub fn plugin(plugin: String, endpoint: Option<i64>) -> Self {
        Self {
            plugin: Some(plugin),
            endpoint,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PreparedBinary {
    pub version: String,
    pub binary_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WindowSettings {
    pub platform: String,
    pub note: String,
    pub geoip: bool,
    pub timezone: String,
    pub locale: String,
    pub viewport: String,
    pub fingerprint_seed: Option<u32>,
    pub start_url: String,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            platform: "其他".into(),
            note: String::new(),
            geoip: true,
            timezone: String::new(),
            locale: String::new(),
            viewport: "default".into(),
            fingerprint_seed: None,
            start_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileRecord {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub binding: ProfileBinding,
    pub binary_path: PathBuf,
    pub proxy: Option<String>,
    /// When set, the window requires a proxy resolved by this plugin and must
    /// never fall back to a direct connection.
    #[serde(default)]
    pub proxy_plugin: Option<String>,
    /// One row of the proxy plugin's inventory. `None` keeps the window on the
    /// plugin's default endpoint, which is what records written before this
    /// field existed imply.
    #[serde(default)]
    pub proxy_endpoint: Option<i64>,
    #[serde(default)]
    pub settings: WindowSettings,
    /// Unix seconds. Records written before this field existed read as 0.
    #[serde(default)]
    pub created_at: i64,
    /// Unix seconds of the last successful launch; `None` means never opened.
    #[serde(default)]
    pub last_opened_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    InvalidName,
    InvalidNote,
    InvalidProxy,
    InvalidProxyPlugin,
    InvalidSettings,
    ImmutableFingerprint,
    InvalidBinary,
    InvalidProfileId,
    CorruptProfile,
    Io,
}

pub struct ProfileStore {
    root: PathBuf,
}

impl ProfileStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn record_path(&self, id: &str) -> Result<PathBuf, StoreError> {
        Uuid::parse_str(id).map_err(|_| StoreError::InvalidProfileId)?;
        Ok(self.root.join(id).join("profile.json"))
    }

    pub fn user_data_dir(&self, id: &str) -> Result<PathBuf, StoreError> {
        Uuid::parse_str(id).map_err(|_| StoreError::InvalidProfileId)?;
        Ok(self.root.join(id).join("user-data"))
    }

    pub fn create(
        &self,
        name: &str,
        proxy: Option<String>,
        binary: PreparedBinary,
    ) -> Result<ProfileRecord, StoreError> {
        self.create_with_settings(name, proxy, None, WindowSettings::default(), binary)
    }

    pub fn create_with_settings(
        &self,
        name: &str,
        proxy: Option<String>,
        proxy_plugin: Option<String>,
        settings: WindowSettings,
        binary: PreparedBinary,
    ) -> Result<ProfileRecord, StoreError> {
        self.create_with_group(
            name,
            ProxySource {
                server: proxy,
                plugin: proxy_plugin,
                endpoint: None,
            },
            settings,
            binary,
            None,
        )
    }

    pub fn create_with_group(
        &self,
        name: &str,
        proxy: ProxySource,
        settings: WindowSettings,
        binary: PreparedBinary,
        group_id: Option<&str>,
    ) -> Result<ProfileRecord, StoreError> {
        if name.trim().is_empty() || name.trim().chars().count() > 40 {
            return Err(StoreError::InvalidName);
        }
        if let Some(ref server) = proxy.server {
            validate_proxy(server)?;
        }
        validate_proxy_plugin(&proxy.server, &proxy.plugin, proxy.endpoint)?;
        validate_settings(&settings, proxy.server.is_some() || proxy.plugin.is_some())?;
        if let Some(group_id) = group_id {
            Uuid::parse_str(group_id).map_err(|_| StoreError::InvalidSettings)?;
        }
        if !valid_version(&binary.version)
            || !binary.binary_path.is_absolute()
            || !binary.binary_path.is_file()
        {
            return Err(StoreError::InvalidBinary);
        }
        fs::create_dir_all(&self.root).map_err(|_| StoreError::Io)?;
        let id = Uuid::new_v4().to_string();
        let folder = self.root.join(&id);
        fs::create_dir(&folder).map_err(|_| StoreError::Io)?;
        let record = ProfileRecord {
            schema_version: 1,
            id: id.clone(),
            name: name.trim().to_owned(),
            binding: ProfileBinding {
                profile_id: id,
                channel_id: format!("cloak:{}", binary.version),
                channel_version: binary.version,
            },
            binary_path: binary.binary_path,
            proxy: proxy.server,
            proxy_plugin: proxy.plugin,
            proxy_endpoint: proxy.endpoint,
            settings,
            created_at: now_seconds(),
            last_opened_at: None,
        };
        let result = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .execute(
                "INSERT INTO profile_records (id, record_json, group_id) VALUES (?1, ?2, ?3)",
                params![
                    record.id,
                    serde_json::to_string(&record).map_err(|_| StoreError::Io)?,
                    group_id
                ],
            );
        if result.is_err() {
            let _ = fs::remove_dir(&folder);
            return Err(StoreError::Io);
        }
        Ok(record)
    }

    pub fn update(
        &self,
        id: &str,
        name: &str,
        proxy: ProxySource,
        settings: WindowSettings,
    ) -> Result<ProfileRecord, StoreError> {
        let group_id = self.group_id(id)?;
        self.update_with_group(id, name, proxy, settings, group_id.as_deref())
    }

    pub fn update_with_group(
        &self,
        id: &str,
        name: &str,
        proxy: ProxySource,
        settings: WindowSettings,
        group_id: Option<&str>,
    ) -> Result<ProfileRecord, StoreError> {
        if name.trim().is_empty() || name.trim().chars().count() > 40 {
            return Err(StoreError::InvalidName);
        }
        if let Some(ref server) = proxy.server {
            validate_proxy(server)?;
        }
        validate_proxy_plugin(&proxy.server, &proxy.plugin, proxy.endpoint)?;
        validate_settings(&settings, proxy.server.is_some() || proxy.plugin.is_some())?;
        if let Some(group_id) = group_id {
            Uuid::parse_str(group_id).map_err(|_| StoreError::InvalidSettings)?;
        }
        let mut record = self.get(id)?;
        if record.settings.fingerprint_seed != settings.fingerprint_seed {
            return Err(StoreError::ImmutableFingerprint);
        }
        record.name = name.trim().to_owned();
        record.proxy = proxy.server;
        record.proxy_plugin = proxy.plugin;
        record.proxy_endpoint = proxy.endpoint;
        record.settings = settings;
        let changed = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .execute(
                "UPDATE profile_records SET record_json = ?2, group_id = ?3 WHERE id = ?1",
                params![
                    id,
                    serde_json::to_string(&record).map_err(|_| StoreError::Io)?,
                    group_id
                ],
            )
            .map_err(|_| StoreError::Io)?;
        if changed == 0 {
            return Err(StoreError::CorruptProfile);
        }
        Ok(record)
    }

    pub fn update_note(&self, id: &str, note: &str) -> Result<String, StoreError> {
        let note = note.trim();
        if note.chars().count() > 120 {
            return Err(StoreError::InvalidNote);
        }
        self.get(id)?;
        // Patch the latest JSON in SQLite, never replace it with a UI snapshot.
        let changed = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .execute(
                "UPDATE profile_records
                 SET record_json = json_set(record_json, '$.settings.note', ?2)
                 WHERE id = ?1",
                params![id, note],
            )
            .map_err(|_| StoreError::Io)?;
        if changed == 0 {
            return Err(StoreError::CorruptProfile);
        }
        Ok(note.to_owned())
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        self.get(id)?;
        // Move data out of the active path first so a failed SQL write can be rolled back.
        let folder = self.root.join(id);
        let removed = self.root.join(format!(".deleting-{id}"));
        fs::rename(&folder, &removed).map_err(|_| StoreError::Io)?;
        let result = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)
            .and_then(|db| {
                db.execute("DELETE FROM profile_records WHERE id = ?1", [id])
                    .map_err(|_| StoreError::Io)
            });
        if result.is_err() {
            let _ = fs::rename(&removed, &folder);
            return Err(StoreError::Io);
        }
        fs::remove_dir_all(removed).map_err(|_| StoreError::Io)
    }

    /// Records a successful launch. The timestamp is display data only, so a
    /// failed write must never fail the launch itself.
    pub fn mark_opened(&self, id: &str) -> Result<(), StoreError> {
        let mut record = self.get(id)?;
        record.last_opened_at = Some(now_seconds());
        open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .execute(
                "UPDATE profile_records SET record_json = ?2 WHERE id = ?1",
                params![
                    id,
                    serde_json::to_string(&record).map_err(|_| StoreError::Io)?
                ],
            )
            .map_err(|_| StoreError::Io)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<ProfileRecord, StoreError> {
        self.migrate_legacy()?;
        reject_symlink(&self.root.join(id))?;
        let json: String = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .query_row(
                "SELECT record_json FROM profile_records WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StoreError::Io)?
            .ok_or(StoreError::CorruptProfile)?;
        let record: ProfileRecord =
            serde_json::from_str(&json).map_err(|_| StoreError::CorruptProfile)?;
        self.validate_record(id, &record)?;
        Ok(record)
    }

    pub(crate) fn validate_record(
        &self,
        id: &str,
        record: &ProfileRecord,
    ) -> Result<(), StoreError> {
        if record.schema_version != 1
            || record.id != id
            || record.binding.profile_id != id
            || !valid_version(&record.binding.channel_version)
            || record.binding.channel_id != format!("cloak:{}", record.binding.channel_version)
            || !record.binary_path.is_absolute()
            || record
                .proxy
                .as_deref()
                .is_some_and(|server| validate_proxy(server).is_err())
            || validate_proxy_plugin(&record.proxy, &record.proxy_plugin, record.proxy_endpoint)
                .is_err()
            || validate_settings(
                &record.settings,
                record.proxy.is_some() || record.proxy_plugin.is_some(),
            )
            .is_err()
        {
            return Err(StoreError::CorruptProfile);
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ProfileRecord>, StoreError> {
        self.migrate_legacy()?;
        let mut records = Vec::new();
        let db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        let mut query = db
            .prepare("SELECT id, record_json FROM profile_records ORDER BY rowid DESC")
            .map_err(|_| StoreError::Io)?;
        let rows = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| StoreError::Io)?;
        for row in rows {
            let (id, json) = row.map_err(|_| StoreError::Io)?;
            let record = serde_json::from_str(&json).map_err(|_| StoreError::CorruptProfile)?;
            self.validate_record(&id, &record)?;
            reject_symlink(&self.root.join(&id))?;
            records.push(record);
        }
        // Stable sorting preserves insertion order for same-second timestamps.
        records.sort_by_key(|record| std::cmp::Reverse(record.created_at));
        Ok(records)
    }

    pub fn group_id(&self, id: &str) -> Result<Option<String>, StoreError> {
        Uuid::parse_str(id).map_err(|_| StoreError::InvalidProfileId)?;
        self.migrate_legacy()?;
        open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .query_row(
                "SELECT group_id FROM profile_records WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| StoreError::CorruptProfile)
    }

    pub(crate) fn database_path(&self) -> PathBuf {
        self.root
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("nexus.sqlite")
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn migrate_legacy(&self) -> Result<(), StoreError> {
        if !self.root.exists() {
            return Ok(());
        }
        let db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        for entry in fs::read_dir(&self.root).map_err(|_| StoreError::Io)? {
            let entry = entry.map_err(|_| StoreError::Io)?;
            if !entry.file_type().map_err(|_| StoreError::Io)?.is_dir() {
                continue;
            }
            let id = entry
                .file_name()
                .into_string()
                .map_err(|_| StoreError::CorruptProfile)?;
            if id.starts_with(".deleting-") {
                continue;
            }
            Uuid::parse_str(&id).map_err(|_| StoreError::CorruptProfile)?;
            reject_symlink(&entry.path())?;
            let path = entry.path().join("profile.json");
            if path.exists() {
                reject_symlink(&path)?;
                let mut bytes = Vec::new();
                File::open(&path)
                    .map_err(|_| StoreError::CorruptProfile)?
                    .take(16 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| StoreError::Io)?;
                if bytes.len() > 16 * 1024 {
                    return Err(StoreError::CorruptProfile);
                }
                let record: ProfileRecord =
                    serde_json::from_slice(&bytes).map_err(|_| StoreError::CorruptProfile)?;
                self.validate_record(&id, &record)?;
                db.execute(
                    "INSERT OR IGNORE INTO profile_records (id, record_json) VALUES (?1, ?2)",
                    params![
                        id,
                        serde_json::to_string(&record).map_err(|_| StoreError::Io)?
                    ],
                )
                .map_err(|_| StoreError::Io)?;
                fs::remove_file(path).map_err(|_| StoreError::Io)?;
            } else {
                let exists: Option<i32> = db
                    .query_row(
                        "SELECT 1 FROM profile_records WHERE id = ?1",
                        [&id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| StoreError::Io)?;
                if exists.is_none() {
                    return Err(StoreError::CorruptProfile);
                }
            }
        }
        Ok(())
    }
}

fn validate_settings(settings: &WindowSettings, _has_proxy: bool) -> Result<(), StoreError> {
    if !matches!(settings.platform.as_str(), "Vinted" | "Poshmark" | "其他")
        || settings.note.chars().count() > 120
        || settings.timezone.len() > 64
        || settings.locale.len() > 35
        || !matches!(
            settings.viewport.as_str(),
            "default" | "1440x900" | "1920x1080"
        )
        || settings.fingerprint_seed == Some(0)
        || settings
            .fingerprint_seed
            .is_some_and(|seed| seed > 2_147_483_647)
        || settings.start_url.len() > 2048
    {
        return Err(StoreError::InvalidSettings);
    }
    if !settings.start_url.is_empty() {
        let url = url::Url::parse(&settings.start_url).map_err(|_| StoreError::InvalidSettings)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(StoreError::InvalidSettings);
        }
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), StoreError> {
    if fs::symlink_metadata(path)
        .map_err(|_| StoreError::CorruptProfile)?
        .file_type()
        .is_symlink()
    {
        return Err(StoreError::CorruptProfile);
    }
    Ok(())
}

fn valid_version(version: &str) -> bool {
    version.len() <= 48
        && version.split('.').count() >= 4
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// A window takes its proxy either from a manual server or from a plugin, not
/// both: two sources would make the launch snapshot ambiguous. A pinned
/// endpoint only makes sense with the plugin that owns the inventory.
fn validate_proxy_plugin(
    proxy: &Option<String>,
    proxy_plugin: &Option<String>,
    proxy_endpoint: Option<i64>,
) -> Result<(), StoreError> {
    if proxy_endpoint.is_some() && proxy_plugin.is_none() {
        return Err(StoreError::InvalidProxyPlugin);
    }
    if proxy_endpoint.is_some_and(|id| id < 1) {
        return Err(StoreError::InvalidProxyPlugin);
    }
    match proxy_plugin {
        None => Ok(()),
        Some(id) => {
            if proxy.is_some() || !super::plugin_host::manifest::valid_plugin_id(id) {
                return Err(StoreError::InvalidProxyPlugin);
            }
            Ok(())
        }
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn validate_proxy(server: &str) -> Result<(), StoreError> {
    let parsed = url::Url::parse(server).map_err(|_| StoreError::InvalidProxy)?;
    let authority = server
        .split_once("://")
        .map(|(_, tail)| tail.trim_end_matches('/'))
        .ok_or(StoreError::InvalidProxy)?;
    let explicit_port = authority
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .is_some_and(|port| port > 0);
    if !matches!(parsed.scheme(), "http" | "socks5")
        || parsed.host().is_none()
        || !explicit_port
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(StoreError::InvalidProxy);
    }
    Ok(())
}
