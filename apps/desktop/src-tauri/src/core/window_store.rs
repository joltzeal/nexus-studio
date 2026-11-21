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
    pub alias_engine: Option<String>,
    pub operating_system: String,
    pub cpu_cores: Option<u8>,
    pub start_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shardbrowser: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloakbrowser: Option<CloakFingerprintConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitbrowser: Option<BitBrowserFingerprintConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BitBrowserFingerprintConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ostype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webgl_manufacturer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webgl_render: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "webGLMeta")]
    pub webgl_meta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware_concurrency: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_memory: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_width: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_height: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_pixel_ratio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "webGL")]
    pub webgl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_voices: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "webRTC")]
    pub web_rtc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore_https_errors: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_ip_create_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lng: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_ip_create_display_language: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_languages: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_size_limit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub do_not_track: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_rect_noise_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_scan_protect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_white_list: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_info_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac_addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hostIP")]
    pub host_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_ssl_cipher_suites_flag: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_ssl_cipher_suites: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_plugins: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugins: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_args: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone_offset: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub random_fingerprint: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloakFingerprintConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_fingerprint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware_concurrency: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_memory: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_width: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_quota: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taskbar_height: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webrtc_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noise: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_third_party_cookies: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sapi_voices: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_touch_points: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparent_proxy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparent_proxy_dns: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_cookies: Option<bool>,
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
            alias_engine: None,
            operating_system: "host".into(),
            cpu_cores: None,
            start_url: String::new(),
            shardbrowser: None,
            cloakbrowser: None,
            bitbrowser: None,
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
    #[serde(default)]
    pub proxy_id: Option<String>,
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
    InvalidGroupId,
    GroupNotFound,
    ScopeMismatch,
    DatabaseBusy,
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
            Self::InvalidGroupId => "Folder 标识无效",
            Self::GroupNotFound => "Folder 不存在",
            Self::ScopeMismatch => "Profile 与 Folder 不属于同一 Workspace",
            Self::DatabaseBusy => "本地数据正在写入，请稍后重试",
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
        self.insert_record(record, group, false)
    }

    pub(crate) fn insert_confirmed(
        &self,
        record: &WindowRecord,
        group: Option<&str>,
    ) -> Result<(), StoreError> {
        self.insert_record(record, group, true)
    }

    fn insert_record(
        &self,
        record: &WindowRecord,
        group: Option<&str>,
        confirmed: bool,
    ) -> Result<(), StoreError> {
        self.validate_record(&record.id, record)?;
        let mut db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        if record.binding.provider_id == BrowserProviderId::CloakBrowser {
            fs::create_dir_all(self.user_data_dir(&record.id)?).map_err(|_| StoreError::Io)?;
        }
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Io)?;
        let group = if confirmed {
            group_for_commit(
                &tx,
                record.binding.provider_id,
                &record.binding.connection_id,
                group,
            )?
        } else {
            group.map(str::to_owned)
        };
        tx.execute(
            "INSERT INTO profile_records(id,record_json,group_id) VALUES(?1,?2,?3)",
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
        self.save_record(record, group, false)
    }

    pub(crate) fn save_confirmed(
        &self,
        record: &WindowRecord,
        group: Option<&str>,
    ) -> Result<(), StoreError> {
        self.save_record(record, group, true)
    }

    fn save_record(
        &self,
        record: &WindowRecord,
        group: Option<&str>,
        confirmed: bool,
    ) -> Result<(), StoreError> {
        let previous = self.get(&record.id)?;
        let bitbrowser = previous.binding.provider_id == BrowserProviderId::BitBrowser;
        if previous.binding != record.binding
            || previous.binary_path != record.binary_path
            || (previous.kernel_version != record.kernel_version && !bitbrowser)
            || previous.settings.fingerprint_seed != record.settings.fingerprint_seed
            || previous.settings.alias_engine != record.settings.alias_engine
            || previous.settings.operating_system != record.settings.operating_system
            || previous.settings.cpu_cores != record.settings.cpu_cores
            || previous.created_at != record.created_at
            || previous.sort_order != record.sort_order
        {
            return Err(StoreError::ImmutableBinding);
        }
        self.validate_record(&record.id, record)?;
        let mut db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::Io)?;
        let group = if confirmed {
            group_for_commit(
                &tx,
                record.binding.provider_id,
                &record.binding.connection_id,
                group,
            )?
        } else {
            group.map(str::to_owned)
        };
        let changed = tx
            .execute(
                "UPDATE profile_records SET record_json=?2,group_id=?3 WHERE id=?1",
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
        tx.commit().map_err(|_| StoreError::Io)
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
        if record.binding.provider_id.is_managed() || record.binding.profile_id != remote.id {
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

    pub(crate) fn set_shardbrowser_pin(
        &self,
        id: &str,
        connection_id: &str,
        pinned: bool,
        fallback: Value,
    ) -> Result<bool, StoreError> {
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
            .map_err(|_| StoreError::CorruptWindow)?;
        let mut record: WindowRecord =
            serde_json::from_str(&text).map_err(|_| StoreError::CorruptWindow)?;
        self.validate_record(id, &record)?;
        if record.binding.provider_id != BrowserProviderId::ShardBrowser
            || record.binding.connection_id != connection_id
        {
            return Err(StoreError::ImmutableBinding);
        }
        let config = record.settings.shardbrowser.get_or_insert(fallback);
        let object = config.as_object_mut().ok_or(StoreError::InvalidSettings)?;
        let metadata = object
            .entry("_meta")
            .or_insert_with(|| serde_json::json!({}));
        metadata
            .as_object_mut()
            .ok_or(StoreError::InvalidSettings)?
            .insert("pinned".into(), Value::Bool(pinned));
        // Read the current JSON in this transaction, then update only its
        // fingerprint metadata. Concurrent note/runtime fields stay in place.
        let changed = tx.execute(
            "UPDATE profile_records SET record_json=json_set(record_json,'$.settings.shardbrowser',json(?2)) WHERE id=?1",
            params![id, serde_json::to_string(config).map_err(|_| StoreError::Io)?],
        ).map_err(|_| StoreError::Io)?;
        if changed != 1 {
            return Err(StoreError::CorruptWindow);
        }
        tx.commit().map_err(|_| StoreError::Io)?;
        Ok(pinned)
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

    pub(crate) fn assign_group_for_connection(
        &self,
        connection_id: &str,
        provider_id: BrowserProviderId,
        profile_ids: &[String],
        group_id: Option<&str>,
    ) -> Result<(), StoreError> {
        if connection_id.trim().is_empty() {
            return Err(StoreError::ScopeMismatch);
        }
        if let Some(id) = group_id {
            Uuid::parse_str(id).map_err(|_| StoreError::InvalidGroupId)?;
        }
        for id in profile_ids {
            Uuid::parse_str(id).map_err(|_| StoreError::InvalidWindowId)?;
        }
        let mut db = open_database(&self.database_path()).map_err(|_| StoreError::Io)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_store_error)?;
        if let Some(id) = group_id {
            let exists = tx
                .query_row(
                    "SELECT 1 FROM groups WHERE id=?1 AND connection_id=?2 AND provider_id=?3",
                    params![id, connection_id, provider_id.as_str()],
                    |row| row.get::<_, i32>(0),
                )
                .optional()
                .map_err(sql_store_error)?;
            if exists.is_none() {
                return Err(StoreError::GroupNotFound);
            }
        }
        for id in profile_ids {
            let scope = tx
                .query_row(
                    "SELECT connection_id,provider_id FROM profile_records WHERE id=?1",
                    [id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(sql_store_error)?
                .ok_or(StoreError::CorruptWindow)?;
            if scope.0 != connection_id || scope.1 != provider_id.as_str() {
                return Err(StoreError::ScopeMismatch);
            }
            let changed = tx
                .execute(
                    "UPDATE profile_records SET group_id=?2 WHERE id=?1",
                    params![id, group_id],
                )
                .map_err(sql_store_error)?;
            if changed != 1 {
                return Err(StoreError::CorruptWindow);
            }
        }
        tx.commit().map_err(sql_store_error)
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
        if record.binding.provider_id.is_managed() {
            let alias = record.binding.provider_id == BrowserProviderId::AliasMode;
            let shard = record.binding.provider_id == BrowserProviderId::ShardBrowser;
            if record.binding.profile_id != id
                || record.binding.connection_id != if shard {
                    super::browser::provider::SHARDBROWSER_CONNECTION_ID
                } else if alias {
                    super::browser::provider::ALIASMODE_CONNECTION_ID
                } else {
                    super::browser::provider::BUILTIN_CONNECTION_ID
                }
                || record.binary_path.as_ref().is_none_or(|p| !p.is_absolute())
                || record
                    .kernel_version
                    .as_deref()
                    .is_none_or(|v| if shard {
                        !super::shardbrowser_kernels::ShardKernelService::valid_version(v)
                    } else if alias {
                        if record.settings.alias_engine.as_deref() == Some("firefox") {
                            !super::aliasmode_kernels::AliasModeKernelService::valid_firefox_version(v)
                        } else {
                            !super::aliasmode_kernels::AliasModeKernelService::valid_version(v)
                        }
                    } else { !valid_version(v) })
                || record.settings.fingerprint_seed.is_none()
                || record.proxy_mode == ProxyMode::Provider
            {
                return Err(StoreError::InvalidBinary);
            }
            let folder = if shard {
                self.root.join("shardbrowser").join(id)
            } else if alias {
                self.root.join("aliasmode").join(id)
            } else {
                self.root.join(id)
            };
            if fs::symlink_metadata(&folder).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(StoreError::CorruptWindow);
            }
        } else if record.binary_path.is_some() || record.settings.fingerprint_seed.is_some() {
            return Err(StoreError::InvalidSettings);
        }
        if record.binding.provider_id == BrowserProviderId::AliasMode {
            if !matches!(
                record.settings.alias_engine.as_deref(),
                Some("chromium" | "firefox")
            ) {
                return Err(StoreError::InvalidSettings);
            }
        } else if record.settings.alias_engine.is_some()
            || record.settings.cpu_cores.is_some()
            || record.settings.operating_system != "host"
        {
            return Err(StoreError::InvalidSettings);
        }
        Ok(())
    }

    pub(crate) fn database_path(&self) -> PathBuf {
        super::workspace_paths::database_path(self.root.parent().unwrap_or_else(|| Path::new(".")))
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

/// Resolve Folder deletion inside the transaction committing a confirmed write or recovery.
pub(crate) fn group_for_commit(
    db: &Connection,
    provider_id: BrowserProviderId,
    connection_id: &str,
    group: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let Some(id) = group else { return Ok(None) };
    let binding: Option<(String, String)> = db
        .query_row(
            "SELECT connection_id,provider_id FROM groups WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| StoreError::Io)?;
    match binding {
        None => Ok(None),
        Some((connection, provider))
            if connection == connection_id && provider == provider_id.as_str() =>
        {
            Ok(Some(id.into()))
        }
        Some(_) => Err(StoreError::InvalidSettings),
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
    if record.settings.shardbrowser.is_some()
        && !matches!(
            record.binding.provider_id,
            BrowserProviderId::ShardBrowser
                | BrowserProviderId::CloakBrowser
                | BrowserProviderId::BitBrowser
        )
    {
        return Err(StoreError::InvalidSettings);
    }
    if record.settings.cloakbrowser.is_some()
        && record.binding.provider_id != BrowserProviderId::CloakBrowser
    {
        return Err(StoreError::InvalidSettings);
    }
    if record.settings.bitbrowser.is_some()
        && record.binding.provider_id != BrowserProviderId::BitBrowser
    {
        return Err(StoreError::InvalidSettings);
    }
    if record.binding.provider_id == BrowserProviderId::BitBrowser
        && record.kernel_version.as_deref().is_some_and(|version| {
            version.is_empty()
                || version.len() > 12
                || !version
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
                || version.split('.').any(|part| part.is_empty())
        })
    {
        return Err(StoreError::InvalidSettings);
    }
    if let Some(config) = &record.settings.shardbrowser {
        let extensions = super::shardbrowser_extensions::validate_config_shape(config)
            .map_err(|_| StoreError::InvalidSettings)?;
        if !extensions.is_empty() && record.binding.provider_id != BrowserProviderId::ShardBrowser {
            return Err(StoreError::InvalidSettings);
        }
    }
    let builtin = record.binding.provider_id.is_managed();
    let max_name_length = if builtin { 40 } else { 100 };
    if record.name.trim().is_empty()
        || record.name.chars().count() > max_name_length
        || (!builtin && record.name.chars().any(char::is_control))
    {
        return Err(StoreError::InvalidName);
    }
    validate_settings(&record.settings)?;
    if record.proxy_id.is_some()
        && (record.proxy_mode != ProxyMode::Manual
            || record.proxy.is_some()
            || record.proxy_id.as_deref().is_none_or(|id| {
                id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
            }))
    {
        return Err(StoreError::InvalidProxy);
    }
    match record.proxy_mode {
        ProxyMode::Manual
            if (record.proxy.is_some() || record.proxy_id.is_some())
                && record.proxy_plugin.is_none()
                && record.proxy_endpoint.is_none() =>
        {
            if let Some(proxy) = record.proxy.as_deref() {
                validate_proxy(proxy)?;
            }
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

fn sql_store_error(error: rusqlite::Error) -> StoreError {
    match &error {
        rusqlite::Error::SqliteFailure(inner, _)
            if matches!(
                inner.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            StoreError::DatabaseBusy
        }
        _ => StoreError::Io,
    }
}

pub fn validate_settings(settings: &WindowSettings) -> Result<(), StoreError> {
    if let Some(config) = &settings.shardbrowser {
        shardx::validate_fingerprint_config(config).map_err(|_| StoreError::InvalidSettings)?;
    }
    if let Some(config) = &settings.cloakbrowser {
        validate_cloak_fingerprint(config)?;
    }
    if let Some(config) = &settings.bitbrowser {
        validate_bit_fingerprint(config)?;
    }
    if settings.note.chars().count() > 120
        || !["Vinted", "Poshmark", "其他"].contains(&settings.platform.as_str())
        || !["default", "1440x900", "1920x1080"].contains(&settings.viewport.as_str())
        || settings
            .fingerprint_seed
            .is_some_and(|seed| seed == 0 || seed > 0x7fff_ffff)
        || settings.locale.len() > 64
        || settings.timezone.len() > 128
        || !["host", "windows", "macos", "linux"].contains(&settings.operating_system.as_str())
        || settings
            .cpu_cores
            .is_some_and(|cores| cores == 0 || cores > 64)
        || !matches!(
            settings.alias_engine.as_deref(),
            None | Some("chromium" | "firefox")
        )
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

pub fn validate_cloak_fingerprint(config: &CloakFingerprintConfig) -> Result<(), StoreError> {
    let in_range =
        |value: Option<u64>, low: u64, high: u64| value.is_none_or(|v| (low..=high).contains(&v));
    let platform_version = config.platform_version.as_deref();
    let search_engine = config.search_engine.as_deref();
    let webrtc_ip = config.webrtc_ip.as_deref();
    let transparent_dns = config.transparent_proxy_dns.as_deref();
    if !matches!(
        config.platform.as_deref(),
        None | Some("windows" | "macos" | "linux")
    ) || !matches!(
        config.gpu_vendor.as_deref(),
        None | Some("nvidia" | "intel")
    ) || !in_range(config.hardware_concurrency.map(u64::from), 1, 64)
        || !in_range(config.device_memory.map(u64::from), 1, 64)
        || !in_range(config.screen_width.map(u64::from), 800, 7680)
        || !in_range(config.screen_height.map(u64::from), 600, 4320)
        || !in_range(config.storage_quota.map(u64::from), 1024, 1_048_576)
        || !in_range(config.taskbar_height.map(u64::from), 0, 200)
        || !in_range(config.max_touch_points.map(u64::from), 0, 10)
        || platform_version.is_some_and(|value| {
            value.is_empty()
                || value.len() > 32
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
                || value.split('.').any(|part| part.is_empty())
                || value.starts_with('.')
                || value.ends_with('.')
        })
        || search_engine.is_some_and(|value| {
            value.len() > 512
                || (!matches!(value, "google" | "bing" | "duckduckgo" | "none")
                    && !valid_http_url(value))
        })
        || webrtc_ip.is_some_and(|value| {
            value.len() > 45 || (value != "auto" && value.parse::<std::net::IpAddr>().is_err())
        })
        || transparent_dns
            .is_some_and(|value| value.len() > 512 || (value != "local" && !valid_http_url(value)))
    {
        return Err(StoreError::InvalidSettings);
    }
    Ok(())
}

pub fn validate_bit_fingerprint(config: &BitBrowserFingerprintConfig) -> Result<(), StoreError> {
    let bounded = |value: &str, max: usize| {
        value.chars().count() <= max && !value.chars().any(char::is_control)
    };
    let text_block = |value: &str, max: usize| {
        value.chars().count() <= max
            && !value
                .chars()
                .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    };
    let decimal = |value: &str, low: f64, high: f64| {
        !value.is_empty()
            && value
                .parse::<f64>()
                .is_ok_and(|parsed| parsed.is_finite() && (low..=high).contains(&parsed))
    };
    if !matches!(
        config.core_product.as_deref(),
        None | Some("chrome" | "firefox")
    ) || !matches!(
        config.ostype.as_deref(),
        None | Some("PC" | "Android" | "IOS")
    ) || !matches!(
        config.web_rtc.as_deref(),
        None | Some("0" | "1" | "2" | "3")
    ) || !matches!(config.position.as_deref(), None | Some("0" | "1" | "2"))
        || !matches!(config.resolution_type.as_deref(), None | Some("0" | "1"))
        || !matches!(config.font_type.as_deref(), None | Some("0" | "2"))
        || !matches!(config.do_not_track.as_deref(), None | Some("0" | "1"))
        || !matches!(config.port_scan_protect.as_deref(), None | Some("0" | "1"))
        || [config.os.as_deref(), config.os_version.as_deref()]
            .into_iter()
            .flatten()
            .any(|value| value.is_empty() || !bounded(value, 32))
        || config.version.as_deref().is_some_and(|value| {
            !bounded(value, 32)
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
        })
        || config
            .user_agent
            .as_deref()
            .is_some_and(|value| !bounded(value, 512))
        || [
            config.webgl_manufacturer.as_deref(),
            config.webgl_render.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| !bounded(value, 256))
        || config
            .launch_args
            .as_deref()
            .is_some_and(|value| !bounded(value, 1024))
        || config
            .display_languages
            .as_deref()
            .is_some_and(|value| !bounded(value, 256))
        || config
            .computer_name
            .as_deref()
            .is_some_and(|value| !bounded(value, 64))
        || config
            .mac_addr
            .as_deref()
            .is_some_and(|value| !bounded(value, 64))
        || config
            .host_ip
            .as_deref()
            .is_some_and(|value| !bounded(value, 45) || value.parse::<std::net::IpAddr>().is_err())
        || config
            .disable_ssl_cipher_suites
            .as_deref()
            .is_some_and(|value| !text_block(value, 1024))
        || config
            .plugins
            .as_deref()
            .is_some_and(|value| !text_block(value, 8192))
        || config.port_white_list.as_deref().is_some_and(|value| {
            !bounded(value, 512)
                || value.split(',').any(|part| {
                    let part = part.trim();
                    part.is_empty()
                        || !part.bytes().all(|byte| byte.is_ascii_digit())
                        || part.parse::<u16>().is_err()
                })
        })
        || config
            .lat
            .as_deref()
            .is_some_and(|value| !decimal(value, -90.0, 90.0))
        || config
            .lng
            .as_deref()
            .is_some_and(|value| !decimal(value, -180.0, 180.0))
        || config
            .precision_data
            .as_deref()
            .is_some_and(|value| !decimal(value, 0.0, 1_000_000.0))
        || config.lat.is_some() != config.lng.is_some()
        || config
            .device_pixel_ratio
            .as_deref()
            .is_some_and(|value| !matches!(value, "1" | "1.5" | "2" | "2.5" | "3"))
        || [
            config.canvas.as_deref(),
            config.webgl.as_deref(),
            config.webgl_meta.as_deref(),
            config.audio_context.as_deref(),
            config.media_device.as_deref(),
            config.speech_voices.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| !matches!(value, "0" | "1"))
        || config
            .hardware_concurrency
            .is_some_and(|value| !(1..=64).contains(&value))
        || config
            .device_memory
            .is_some_and(|value| !(1..=8).contains(&value))
        || config
            .resolution_width
            .is_some_and(|value| !(800..=7680).contains(&value))
        || config
            .resolution_height
            .is_some_and(|value| !(600..=4320).contains(&value))
        || config
            .timezone_offset
            .is_some_and(|value| !(-840..=840).contains(&value))
        || config.resolution_width.is_some() != config.resolution_height.is_some()
        || (config.resolution_type.as_deref() == Some("1") && config.resolution_width.is_none())
    {
        return Err(StoreError::InvalidSettings);
    }
    Ok(())
}

fn valid_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
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
