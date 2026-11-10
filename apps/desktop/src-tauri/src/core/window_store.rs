use super::browser::{
    local_api::verify_identity,
    provider::{BrowserBinding, BrowserProviderId, ProxyMode, RemoteProfile, WindowOrigin},
};
use super::database::{WINDOW_SORT_SEQUENCE, open_database};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowRecord {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub binding: BrowserBinding,
    pub binary_path: Option<PathBuf>,
    pub kernel_version: Option<String>,
    pub proxy: Option<String>,
    pub proxy_plugin: Option<String>,
    pub proxy_endpoint: Option<i64>,
    pub proxy_mode: ProxyMode,
    pub settings: WindowSettings,
    pub origin: WindowOrigin,
    pub provider_config: Value,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    InvalidName,
    InvalidNote,
    InvalidProxy,
    InvalidProxyPlugin,
    InvalidSettings,
    ImmutableBinding,
    InvalidBinary,
    InvalidWindowId,
    CorruptWindow,
    Io,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidName => "窗口名称需要包含 1 至 40 个字符，外部浏览器最多 100 个字符",
            Self::InvalidNote => "备注最多 120 个字符",
            Self::InvalidProxy => "代理地址无效",
            Self::InvalidProxyPlugin => "代理来源和代理池选择不一致",
            Self::InvalidSettings => "浏览器配置无效",
            Self::ImmutableBinding => "窗口绑定、内核和指纹种子不能修改",
            Self::InvalidBinary => "内核绑定无效",
            Self::InvalidWindowId => "窗口标识无效",
            Self::CorruptWindow => "窗口记录损坏或不存在",
            Self::Io => "无法读写窗口数据",
        })
    }
}

pub struct WindowStore {
    root: PathBuf,
}

impl WindowStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn user_data_dir(&self, id: &str) -> Result<PathBuf, StoreError> {
        Uuid::parse_str(id).map_err(|_| StoreError::InvalidWindowId)?;
        Ok(self.root.join(id).join("user-data"))
    }

    pub fn insert(&self, record: &WindowRecord, group: Option<&str>) -> Result<(), StoreError> {
        self.validate_record(&record.id, record)?;
        let mut db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        if record.binding.provider_id == BrowserProviderId::CloakBrowser {
            fs::create_dir_all(self.user_data_dir(&record.id)?).map_err(|_| StoreError::Io)?;
        }
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Io)?;
        tx.execute(
            "INSERT INTO profile_records(id,record_json,group_id) VALUES(?1,?2,(SELECT id FROM groups WHERE id=?3))",
            params![
                record.id,
                serde_json::to_string(record).map_err(|_| StoreError::Io)?,
                group
            ],
        )
        .map_err(|_| StoreError::Io)?;
        let changed = tx
            .execute(
                "UPDATE browser_sequences SET value=MAX(value,?2) WHERE name=?1",
                params![WINDOW_SORT_SEQUENCE, record.sort_order],
            )
            .map_err(|_| StoreError::Io)?;
        if changed != 1 {
            return Err(StoreError::Io);
        }
        tx.commit().map_err(|_| StoreError::Io)
    }

    pub fn save(&self, record: &WindowRecord, group: Option<&str>) -> Result<(), StoreError> {
        let previous = self.get(&record.id)?;
        if previous.binding != record.binding
            || previous.binary_path != record.binary_path
            || previous.kernel_version != record.kernel_version
            || previous.settings.fingerprint_seed != record.settings.fingerprint_seed
            || previous.created_at != record.created_at
            || previous.sort_order != record.sort_order
        {
            return Err(StoreError::ImmutableBinding);
        }
        self.validate_record(&record.id, record)?;
        let changed = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .execute(
                "UPDATE profile_records SET record_json=?2,group_id=(SELECT id FROM groups WHERE id=?3) WHERE id=?1",
                params![
                    record.id,
                    serde_json::to_string(record).map_err(|_| StoreError::Io)?,
                    group
                ],
            )
            .map_err(|_| StoreError::Io)?;
        if changed != 1 {
            return Err(StoreError::CorruptWindow);
        }
        Ok(())
    }

    /// The caller guards pending operations and the observation's connection freshness.
    pub(crate) fn refresh_external_metadata(
        &self,
        id: &str,
        remote: &RemoteProfile,
    ) -> Result<WindowRecord, StoreError> {
        Uuid::parse_str(id).map_err(|_| StoreError::InvalidWindowId)?;
        let mut db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Io)?;
        let text: String = tx
            .query_row(
                "SELECT record_json FROM profile_records WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StoreError::Io)?
            .ok_or(StoreError::CorruptWindow)?;
        let mut record: WindowRecord =
            serde_json::from_str(&text).map_err(|_| StoreError::CorruptWindow)?;
        self.validate_record(id, &record)?;
        if record.binding.provider_id == BrowserProviderId::CloakBrowser
            || record.binding.profile_id != remote.id
        {
            return Err(StoreError::ImmutableBinding);
        }
        verify_identity(&record, remote).map_err(|_| StoreError::ImmutableBinding)?;
        record.name = remote.name.clone();
        if let Some(version) = remote.kernel_version.as_ref() {
            record.kernel_version = Some(version.clone());
        }
        record.provider_config = remote.provider_config.clone();
        self.validate_record(id, &record)?;
        let changed = tx
            .execute(
                "UPDATE profile_records SET record_json=?2 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(&record).map_err(|_| StoreError::Io)?
                ],
            )
            .map_err(|_| StoreError::Io)?;
        if changed != 1 {
            return Err(StoreError::CorruptWindow);
        }
        tx.commit().map_err(|_| StoreError::Io)?;
        Ok(record)
    }

    pub fn update_note(&self, id: &str, note: &str) -> Result<String, StoreError> {
        let note = note.trim();
        if note.chars().count() > 120 {
            return Err(StoreError::InvalidNote);
        }
        self.get(id)?;
        let changed=open_database(&self.database_path()).map_err(|_|StoreError::Io)?
            .execute("UPDATE profile_records SET record_json=json_set(record_json,'$.settings.note',?2) WHERE id=?1",params![id,note])
            .map_err(|_|StoreError::Io)?;
        if changed != 1 {
            return Err(StoreError::CorruptWindow);
        }
        Ok(note.into())
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        self.get(id)?;
        open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .execute("DELETE FROM profile_records WHERE id=?1", [id])
            .map_err(|_| StoreError::Io)?;
        Ok(())
    }

    pub fn mark_opened(&self, id: &str) -> Result<(), StoreError> {
        open_database(&self.database_path()).map_err(|_|StoreError::Io)?
            .execute("UPDATE profile_records SET record_json=json_set(record_json,'$.last_opened_at',?2) WHERE id=?1",params![id,now_seconds()])
            .map_err(|_|StoreError::Io)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<WindowRecord, StoreError> {
        Uuid::parse_str(id).map_err(|_| StoreError::InvalidWindowId)?;
        let text: String = open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .query_row(
                "SELECT record_json FROM profile_records WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| StoreError::Io)?
            .ok_or(StoreError::CorruptWindow)?;
        let record = serde_json::from_str(&text).map_err(|_| StoreError::CorruptWindow)?;
        self.validate_record(id, &record)?;
        Ok(record)
    }

    pub fn list(&self) -> Result<Vec<WindowRecord>, StoreError> {
        let db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        let mut query=db.prepare("SELECT id,record_json FROM profile_records ORDER BY CAST(json_extract(record_json,'$.created_at') AS INTEGER) DESC, sort_order DESC, id DESC").map_err(|_|StoreError::Io)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| StoreError::Io)?;
        let mut records = Vec::new();
        for row in rows {
            let (id, text) = row.map_err(|_| StoreError::Io)?;
            let record = serde_json::from_str(&text).map_err(|_| StoreError::CorruptWindow)?;
            self.validate_record(&id, &record)?;
            records.push(record);
        }
        Ok(records)
    }

    pub fn group_id(&self, id: &str) -> Result<Option<String>, StoreError> {
        open_database(&self.database_path())
            .map_err(|_| StoreError::Io)?
            .query_row(
                "SELECT group_id FROM profile_records WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| StoreError::CorruptWindow)
    }

    /// Commits the reservation before any provider request or draft write.
    pub fn reserve_sort_order(&self) -> Result<i64, StoreError> {
        let mut db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Io)?;
        let next = sort_order_high_water(&tx)?
            .checked_add(1)
            .ok_or(StoreError::Io)?;
        let changed = tx
            .execute(
                "UPDATE browser_sequences SET value=?2 WHERE name=?1",
                params![WINDOW_SORT_SEQUENCE, next],
            )
            .map_err(|_| StoreError::Io)?;
        if changed != 1 {
            return Err(StoreError::Io);
        }
        tx.commit().map_err(|_| StoreError::Io)?;
        Ok(next)
    }

    pub(crate) fn validate_record(
        &self,
        id: &str,
        record: &WindowRecord,
    ) -> Result<(), StoreError> {
        if record.schema_version != 2
            || record.id != id
            || Uuid::parse_str(id).is_err()
            || record.binding.connection_id.is_empty()
            || record.binding.profile_id.is_empty()
            || !record.provider_config.is_object()
            || record.created_at < 0
            || record.last_opened_at.is_some_and(|time| time < 0)
            || record.sort_order < 0
        {
            return Err(StoreError::CorruptWindow);
        }
        validate_draft(record)?;
        if record.binding.provider_id == BrowserProviderId::CloakBrowser {
            if record.binding.profile_id != id
                || record.binding.connection_id != super::browser::provider::BUILTIN_CONNECTION_ID
                || record.binary_path.as_ref().is_none_or(|p| !p.is_absolute())
                || record
                    .kernel_version
                    .as_deref()
                    .is_none_or(|v| !valid_version(v))
                || record.settings.fingerprint_seed.is_none()
                || record.proxy_mode == ProxyMode::Provider
            {
                return Err(StoreError::InvalidBinary);
            }
            let folder = self.root.join(id);
            if fs::symlink_metadata(&folder).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(StoreError::CorruptWindow);
            }
        } else if record.binary_path.is_some() || record.settings.fingerprint_seed.is_some() {
            return Err(StoreError::InvalidSettings);
        }
        Ok(())
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
}

fn sort_order_high_water(db: &Connection) -> Result<i64, StoreError> {
    db.query_row(
        "SELECT MAX(value,
             COALESCE((SELECT MAX(sort_order) FROM profile_records),0),
             COALESCE((SELECT MAX(json_extract(record_json,'$.payload.record.sort_order')) FROM browser_operations),0))
         FROM browser_sequences WHERE name=?1",
        [WINDOW_SORT_SEQUENCE],
        |row| row.get(0),
    )
    .map_err(|_| StoreError::Io)
}

pub fn validate_draft(record: &WindowRecord) -> Result<(), StoreError> {
    let builtin = record.binding.provider_id == BrowserProviderId::CloakBrowser;
    let max_name_length = if builtin { 40 } else { 100 };
    if record.name.trim().is_empty()
        || record.name.chars().count() > max_name_length
        || (!builtin && record.name.chars().any(char::is_control))
    {
        return Err(StoreError::InvalidName);
    }
    validate_settings(&record.settings)?;
    match record.proxy_mode {
        ProxyMode::Manual
            if record.proxy.is_some()
                && record.proxy_plugin.is_none()
                && record.proxy_endpoint.is_none() =>
        {
            validate_proxy(record.proxy.as_deref().ok_or(StoreError::InvalidProxy)?)?;
        }
        ProxyMode::Plugin
            if record.proxy.is_none()
                && record
                    .proxy_plugin
                    .as_deref()
                    .is_some_and(super::plugin_host::manifest::valid_plugin_id)
                && record.proxy_endpoint.is_none_or(|id| id > 0) => {}
        ProxyMode::Direct | ProxyMode::Provider
            if record.proxy.is_none()
                && record.proxy_plugin.is_none()
                && record.proxy_endpoint.is_none() => {}
        _ => return Err(StoreError::InvalidProxyPlugin),
    }
    Ok(())
}

pub fn validate_settings(settings: &WindowSettings) -> Result<(), StoreError> {
    if settings.note.chars().count() > 120
        || !["Vinted", "Poshmark", "其他"].contains(&settings.platform.as_str())
        || !["default", "1440x900", "1920x1080"].contains(&settings.viewport.as_str())
        || settings
            .fingerprint_seed
            .is_some_and(|seed| seed == 0 || seed > 0x7fff_ffff)
        || settings.locale.len() > 64
        || settings.timezone.len() > 128
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

pub fn valid_version(value: &str) -> bool {
    value.len() <= 48
        && (4..=5).contains(&value.split('.').count())
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

fn validate_proxy(server: &str) -> Result<(), StoreError> {
    let url = url::Url::parse(server).map_err(|_| StoreError::InvalidProxy)?;
    if !matches!(url.scheme(), "http" | "https" | "socks5")
        || url.host().is_none()
        || url.port_or_known_default().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(StoreError::InvalidProxy);
    }
    Ok(())
}

pub(crate) fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
