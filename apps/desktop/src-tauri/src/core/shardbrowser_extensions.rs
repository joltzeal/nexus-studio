// ShardBrowser extension-library behavior follows ProxyShard/ShardBrowser
// commit 99e780e2e685e5b3b5357c5baee8796e10b3ce1e. Raccoon replaces the
// launcher's file-owned index with a connection-scoped SQLite catalog.
use crate::core::browser::provider::{
    BrowserError, BrowserProviderId, BrowserResult, SHARDBROWSER_CONNECTION_ID, WindowState,
};
use crate::core::database::open_database;
use crate::core::shardbrowser_fingerprints::connection;
use crate::core::window_service::WindowService;
use crate::core::window_store::WindowRecord;
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use quick_xml::NsReader;
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::{Namespace, ResolveResult};
use ring::signature::{self, UnparsedPublicKey, VerificationAlgorithm};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const RECORD_VERSION: u32 = 1;
const DOWNLOAD_MAX: u64 = 256 << 20;
const UNPACK_MAX: u64 = 1 << 30;
const UNPACK_FILES: usize = 100_000;
const MANIFEST_MAX: u64 = 2 << 20;
const ICON_MAX: u64 = 8 << 20;
const SMALL_MAX: usize = 1 << 20;
const STALL: Duration = Duration::from_secs(30);
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const WEBSTORE_UPDATE: &str = "https://clients2.google.com/service/update2/crx";
const GUPDATE_NS: &[u8] = b"http://www.google.com/update2/response";
const ANY_VERSION: &str = "0.0.0.1";
const ALREADY_IN_LIBRARY: &str = "already_in_library";
const CANCELLED: &str = "the update was cancelled";
const LOAD_WAIT_MESSAGE: &str =
    "扩展仍被正在运行或状态未确认的 Profile 使用，已保留更新并等待 Profile 停止";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExtensionSource {
    Webstore { id: String },
    Url { url: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: String,
    pub path: String,
    pub size_bytes: u64,
    pub added_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ExtensionSource>,
}

#[derive(Debug, Default, Serialize)]
pub struct Imported {
    pub added: Vec<ExtensionEntry>,
    pub refused: Vec<ImportRefused>,
}

#[derive(Debug, Serialize)]
pub struct ImportRefused {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionFlag {
    Malware,
    PolicyViolation,
    PotentiallyUws,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionUpdateState {
    Unlinked,
    Unchecked,
    Current,
    Available,
    Downloading,
    Ready,
    Waiting,
    Applying,
    Confirm,
    Failed,
    NeedsEngine,
    IdConflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Download,
    Verify,
    Unpack,
    Apply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    pub received: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtensionHolder {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantKind {
    Permission,
    Host,
    ScriptHost,
    MainWorld,
    Connectable,
    WebResource,
    ManifestVersion,
    Override,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Grant {
    pub kind: GrantKind,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpdateConfirm {
    pub reason: ConfirmReason,
    pub grown: Vec<Grant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Names>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlap: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmReason {
    Permissions,
    Identity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Names {
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtensionUpdate {
    pub id: String,
    pub state: ExtensionUpdateState,
    pub installed: String,
    pub latest: Option<String>,
    pub size: Option<u64>,
    pub first_seen: Option<u64>,
    pub ready_since: Option<u64>,
    pub waiting_on: Vec<ExtensionHolder>,
    pub progress: Option<UpdateProgress>,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
    pub flags: Vec<ExtensionFlag>,
    pub allowlisted: Option<bool>,
    pub skipped: Option<String>,
    pub needs_engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<UpdateConfirm>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum UpdateDone {
    Applied { from: String, to: String },
    Waiting { waiting_on: Vec<ExtensionHolder> },
    Confirm { update: Box<ExtensionUpdate> },
    NeedsEngine { version: String },
    NotServed,
    Current,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kinship {
    Same,
    Unsure,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum LinkDone {
    Linked {
        source: ExtensionSource,
        allowlisted: Option<bool>,
        update: Option<Box<ExtensionUpdate>>,
    },
    Confirm {
        names: Names,
        installed: String,
        store: String,
        overlap: f64,
        kin: Kinship,
        allowlisted: Option<bool>,
        flags: Vec<ExtensionFlag>,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateNews {
    pub fresh: Vec<FreshUpdate>,
    pub flagged: Vec<FlaggedUpdate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FreshUpdate {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlaggedUpdate {
    pub id: String,
    pub name: String,
    pub flags: Vec<ExtensionFlag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredExtension {
    v: u32,
    added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<ExtensionSource>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct UpdateRecord {
    latest: Option<String>,
    size: Option<u64>,
    first_seen: Option<u64>,
    checked_at: Option<u64>,
    flags: Vec<ExtensionFlag>,
    allowlisted: Option<bool>,
    skipped: Option<String>,
    error: Option<String>,
    codebase: Option<String>,
    sha256: Option<String>,
    staged: Option<StagedUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StagedUpdate {
    from: String,
    to: String,
    at: u64,
    approved: bool,
    grown: Vec<Grant>,
    names: Option<Names>,
    overlap: Option<f64>,
    needs_engine: Option<String>,
}

#[derive(Debug, Clone)]
struct LiveExtension {
    entry: ExtensionEntry,
    root: PathBuf,
    manifest: Value,
}

struct RunningUpdate {
    cancel: Arc<AtomicBool>,
    progress: Option<UpdateProgress>,
}

struct UpdateGuard {
    key: String,
    cancel: Arc<AtomicBool>,
}

struct CleanupPath(PathBuf);

impl Drop for CleanupPath {
    fn drop(&mut self) {
        match fs::symlink_metadata(&self.0) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                let _ = fs::remove_dir_all(&self.0);
            }
            Ok(_) => {
                let _ = fs::remove_file(&self.0);
            }
            Err(_) => {}
        }
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = update_registry().lock() {
            running.remove(&self.key);
        }
    }
}

pub fn ensure_schema(db: &mut Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS shardbrowser_extensions(
           connection_id TEXT NOT NULL,
           id TEXT NOT NULL,
           record_json TEXT NOT NULL,
           PRIMARY KEY(connection_id,id),
           FOREIGN KEY(connection_id) REFERENCES browser_connections(id)
         );
         CREATE TABLE IF NOT EXISTS shardbrowser_extension_updates(
           connection_id TEXT NOT NULL,
           extension_id TEXT NOT NULL,
           record_json TEXT NOT NULL,
           PRIMARY KEY(connection_id,extension_id),
           FOREIGN KEY(connection_id,extension_id)
             REFERENCES shardbrowser_extensions(connection_id,id) ON DELETE CASCADE
         );
         CREATE TRIGGER IF NOT EXISTS shardbrowser_profile_extensions_insert
         BEFORE INSERT ON profile_records
         WHEN json_type(NEW.record_json,'$.settings.shardbrowser._meta.extensions') IS NOT NULL
           AND (
             json_type(NEW.record_json,'$.settings.shardbrowser._meta.extensions') <> 'array'
             OR (
               NEW.provider_id <> 'shardbrowser'
               AND json_array_length(NEW.record_json,'$.settings.shardbrowser._meta.extensions') > 0
             )
             OR EXISTS(
               SELECT 1
               FROM json_each(NEW.record_json,'$.settings.shardbrowser._meta.extensions') AS selected
               WHERE typeof(selected.value) <> 'text'
                 OR NOT EXISTS(
                   SELECT 1 FROM shardbrowser_extensions AS library
                   WHERE library.connection_id=NEW.connection_id AND library.id=selected.value
                 )
             )
           )
         BEGIN SELECT RAISE(ABORT,'invalid ShardBrowser extension selection'); END;
         CREATE TRIGGER IF NOT EXISTS shardbrowser_profile_extensions_update
         BEFORE UPDATE OF record_json ON profile_records
         WHEN json_type(NEW.record_json,'$.settings.shardbrowser._meta.extensions') IS NOT NULL
           AND (
             json_type(NEW.record_json,'$.settings.shardbrowser._meta.extensions') <> 'array'
             OR (
               NEW.provider_id <> 'shardbrowser'
               AND json_array_length(NEW.record_json,'$.settings.shardbrowser._meta.extensions') > 0
             )
             OR EXISTS(
               SELECT 1
               FROM json_each(NEW.record_json,'$.settings.shardbrowser._meta.extensions') AS selected
               WHERE typeof(selected.value) <> 'text'
                 OR NOT EXISTS(
                   SELECT 1 FROM shardbrowser_extensions AS library
                   WHERE library.connection_id=NEW.connection_id AND library.id=selected.value
                 )
             )
           )
         BEGIN SELECT RAISE(ABORT,'invalid ShardBrowser extension selection'); END;
         CREATE TRIGGER IF NOT EXISTS shardbrowser_extension_delete_referenced
         BEFORE DELETE ON shardbrowser_extensions
         WHEN EXISTS(
           SELECT 1 FROM profile_records AS profile,
             json_each(profile.record_json,'$.settings.shardbrowser._meta.extensions') AS selected
           WHERE profile.connection_id=OLD.connection_id
             AND profile.provider_id='shardbrowser'
             AND selected.value=OLD.id
         )
           OR EXISTS(
             SELECT 1 FROM browser_operations AS operation,
               json_each(operation.record_json,'$.payload.record.settings.shardbrowser._meta.extensions') AS selected
             WHERE operation.connection_id=OLD.connection_id
               AND operation.phase NOT IN('committed','failed','cancelled')
               AND selected.value=OLD.id
           )
         BEGIN SELECT RAISE(ABORT,'extension is referenced'); END;",
    )
    .map_err(|_| "无法初始化 ShardBrowser 扩展库".to_owned())
}

pub(crate) fn validate_config_shape(config: &Value) -> BrowserResult<Vec<String>> {
    let Some(value) = config.pointer("/_meta/extensions") else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid("扩展选择必须是数组"))?;
    if values.len() > 256 {
        return Err(invalid("一个 Profile 最多选择 256 个扩展"));
    }
    let mut seen = BTreeSet::new();
    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| invalid("扩展标识无效"))?;
        if !seen.insert(id.to_owned()) {
            return Err(invalid("扩展选择不能重复"));
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}

pub(crate) fn validate_profile_selection(
    provider_root: &Path,
    connection_id: &str,
    config: Option<&Value>,
) -> BrowserResult<()> {
    require_shard_connection_id(connection_id)?;
    let Some(config) = config else {
        return Ok(());
    };
    let ids = validate_config_shape(config)?;
    if ids.is_empty() {
        return Ok(());
    }
    let workspace = provider_workspace(provider_root)?;
    let db =
        open_database(&crate::core::workspace_paths::database_path(&workspace)).map_err(storage)?;
    for id in ids {
        let found = db
            .query_row(
                "SELECT 1 FROM shardbrowser_extensions WHERE connection_id=?1 AND id=?2",
                params![connection_id, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?;
        if found.is_none() {
            return Err(BrowserError::new(
                "extension_missing",
                "所选扩展已不在 ShardBrowser 扩展库中，请重新选择",
            ));
        }
    }
    Ok(())
}

pub(crate) fn launch_paths(
    provider_root: &Path,
    connection_id: &str,
    config: Option<&Value>,
) -> BrowserResult<(Vec<PathBuf>, PathBuf)> {
    validate_profile_selection(provider_root, connection_id, config)?;
    let workspace = provider_workspace(provider_root)?;
    let library = library_dir_at(&workspace, connection_id, true)?;
    let ids = config
        .map(validate_config_shape)
        .transpose()?
        .unwrap_or_default();
    let mut paths = Vec::with_capacity(ids.len());
    for id in ids {
        let path = manifest_root(&library.join(&id))?;
        validate_live_root(&library, &path)?;
        paths.push(path);
    }
    Ok((paths, library))
}

pub(crate) fn library_launch_guard() -> BrowserResult<MutexGuard<'static, ()>> {
    library_gate()
        .lock()
        .map_err(|_| storage("扩展库操作锁不可用"))
}

fn command_connection_id(connection_id: Option<String>) -> BrowserResult<String> {
    let connection_id = connection_id.unwrap_or_else(|| SHARDBROWSER_CONNECTION_ID.to_owned());
    require_shard_connection_id(&connection_id)?;
    Ok(connection_id)
}

fn invalid(message: impl Into<String>) -> BrowserError {
    BrowserError::new("invalid_config", message)
}

fn storage(error: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", error.to_string())
}

fn interrupted(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("task_interrupted", "扩展库任务中断，请刷新后检查结果")
}

fn require_shard_connection_id(connection_id: &str) -> BrowserResult<()> {
    if connection_id != SHARDBROWSER_CONNECTION_ID {
        return Err(BrowserError::new(
            "scope_mismatch",
            "扩展库仅属于 ShardBrowser Workspace",
        ));
    }
    Ok(())
}

fn provider_workspace(provider_root: &Path) -> BrowserResult<PathBuf> {
    provider_root
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| storage("ShardBrowser 数据目录无效"))
}

fn service_workspace(service: &WindowService) -> BrowserResult<PathBuf> {
    service
        .store
        .root()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| storage("Raccoon 0.2 数据目录无效"))
}

fn library_dir(service: &WindowService, connection_id: &str) -> BrowserResult<PathBuf> {
    connection(service, connection_id)?;
    library_dir_at(&service_workspace(service)?, connection_id, true)
}

fn library_dir_at(workspace: &Path, connection_id: &str, create: bool) -> BrowserResult<PathBuf> {
    require_shard_connection_id(connection_id)?;
    let root = workspace.join("shardbrowser-extensions");
    let directory = root.join(connection_id);
    if create {
        ensure_directory(&root)?;
        ensure_directory(&directory)?;
        ensure_directory(&directory.join(".staging"))?;
        ensure_directory(&directory.join(".updates"))?;
    }
    let metadata = fs::symlink_metadata(&directory).map_err(storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(storage("ShardBrowser 扩展目录无效"));
    }
    fs::canonicalize(directory).map_err(storage)
}

fn ensure_directory(path: &Path) -> BrowserResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(storage("扩展库目录不是普通目录")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(storage)?;
            let metadata = fs::symlink_metadata(path).map_err(storage)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(storage("扩展库目录创建后状态无效"))
            }
        }
        Err(error) => Err(storage(error)),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn stamp() -> String {
    format!("@{}", now())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn library_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn update_registry() -> &'static Mutex<HashMap<String, RunningUpdate>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, RunningUpdate>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_update(connection_id: &str, id: &str) -> BrowserResult<UpdateGuard> {
    let key = format!("{connection_id}:{id}");
    let cancel = Arc::new(AtomicBool::new(false));
    let mut registry = update_registry()
        .lock()
        .map_err(|_| BrowserError::new("profile_busy", "扩展正在执行其他操作"))?;
    if registry.contains_key(&key) {
        return Err(BrowserError::new(
            "profile_busy",
            "该扩展正在执行其他导入、链接或更新操作",
        ));
    }
    registry.insert(
        key.clone(),
        RunningUpdate {
            cancel: Arc::clone(&cancel),
            progress: None,
        },
    );
    Ok(UpdateGuard { key, cancel })
}

fn set_progress(
    app: &AppHandle,
    connection_id: &str,
    id: &str,
    phase: UpdatePhase,
    received: u64,
    total: u64,
) {
    let key = format!("{connection_id}:{id}");
    let progress = UpdateProgress {
        phase,
        received,
        total,
    };
    if let Ok(mut registry) = update_registry().lock()
        && let Some(running) = registry.get_mut(&key)
    {
        running.progress = Some(progress);
    }
    let _ = app.emit(
        "extension-update:progress",
        json!({ "id": id, "phase": phase, "received": received, "total": total }),
    );
}

fn emit_changed(app: &AppHandle, kind: &str) {
    let _ = app.emit("store-changed", kind);
}

fn manifest_root(directory: &Path) -> BrowserResult<PathBuf> {
    if directory.join("manifest.json").is_file() {
        return fs::canonicalize(directory).map_err(storage);
    }
    let entries = fs::read_dir(directory)
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    let mut subdirectories = Vec::new();
    for entry in entries {
        let kind = entry.file_type().map_err(storage)?;
        if kind.is_symlink() {
            return Err(invalid("扩展包中不能包含符号链接"));
        }
        if kind.is_dir() {
            subdirectories.push(entry.path());
        }
    }
    if subdirectories.len() == 1 && subdirectories[0].join("manifest.json").is_file() {
        return fs::canonicalize(&subdirectories[0]).map_err(storage);
    }
    Err(invalid("扩展包中没有可读取的 manifest.json"))
}

fn validate_live_root(library: &Path, root: &Path) -> BrowserResult<()> {
    let canonical_library = fs::canonicalize(library).map_err(storage)?;
    let canonical_root = fs::canonicalize(root).map_err(storage)?;
    if !canonical_root.starts_with(&canonical_library)
        || canonical_root == canonical_library
        || canonical_root.to_string_lossy().contains(',')
    {
        return Err(storage("扩展解包目录越过了受控扩展库"));
    }
    let metadata = fs::symlink_metadata(&canonical_root).map_err(storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(storage("扩展解包目录无效"));
    }
    validate_tree(&canonical_root).map_err(storage)?;
    read_manifest(&canonical_root).map_err(|error| invalid(format!("{error:#}")))?;
    Ok(())
}

fn validate_tree(root: &Path) -> Result<u64> {
    let mut stack = vec![root.to_path_buf()];
    let mut total = 0u64;
    let mut files = 0usize;
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                bail!("extension trees cannot contain symbolic links");
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                files = files.saturating_add(1);
                if files > UNPACK_FILES {
                    bail!("the extension holds more than {UNPACK_FILES} files");
                }
                total = total.saturating_add(entry.metadata()?.len());
                if total > UNPACK_MAX {
                    bail!("the extension is larger than {} MB", UNPACK_MAX >> 20);
                }
            } else {
                bail!("extension trees can contain only files and directories");
            }
        }
    }
    Ok(total)
}

fn strip_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = bytes.to_vec();
    let (mut index, mut in_string) = (0usize, false);
    while index < bytes.len() {
        if in_string {
            match bytes[index] {
                b'\\' => index = index.saturating_add(1),
                b'"' => in_string = false,
                _ => {}
            }
            index = index.saturating_add(1);
            continue;
        }
        match (bytes[index], bytes.get(index + 1)) {
            (b'"', _) => in_string = true,
            (b'/', Some(b'/')) => {
                let end = bytes[index..]
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(bytes.len(), |offset| index + offset);
                output[index..end].fill(b' ');
                index = end;
                continue;
            }
            (b'/', Some(b'*')) => {
                let end = bytes[index + 2..]
                    .windows(2)
                    .position(|window| window == b"*/")
                    .map_or(bytes.len(), |offset| index + 2 + offset + 2);
                output[index..end].fill(b' ');
                index = end;
                continue;
            }
            _ => {}
        }
        index = index.saturating_add(1);
    }
    String::from_utf8(output).unwrap_or_default()
}

fn read_json(path: &Path, maximum: u64) -> Result<Value> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        bail!("{} is not a permitted regular JSON file", path.display());
    }
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&strip_comments(text.trim_start_matches('\u{feff}')))
        .with_context(|| format!("{} is not readable JSON", path.display()))
}

fn read_manifest(root: &Path) -> Result<Value> {
    let manifest = read_json(&root.join("manifest.json"), MANIFEST_MAX)?;
    let object = manifest
        .as_object()
        .context("manifest.json is not an object")?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .context("manifest.json has no name")?;
    if name.len() > 16 * 1024 {
        bail!("manifest name is too long");
    }
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .context("manifest.json has no version")?;
    Version::parse(version).context("manifest.json has an invalid version")?;
    if !matches!(
        object.get("manifest_version").and_then(Value::as_u64),
        Some(2 | 3)
    ) {
        bail!("manifest_version must be 2 or 3");
    }
    Ok(manifest)
}

fn locale_messages(root: &Path, manifest: &Value) -> Value {
    let Some(locale) = manifest.get("default_locale").and_then(Value::as_str) else {
        return Value::Null;
    };
    if locale.contains('/') || locale.contains('\\') || locale.contains("..") {
        return Value::Null;
    }
    read_json(
        &root.join("_locales").join(locale).join("messages.json"),
        MANIFEST_MAX,
    )
    .unwrap_or(Value::Null)
}

fn resolve_message(raw: &str, messages: &Value) -> String {
    let Some(key) = raw
        .strip_prefix("__MSG_")
        .and_then(|value| value.strip_suffix("__"))
    else {
        return raw.to_owned();
    };
    messages
        .as_object()
        .and_then(|object| {
            object
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        })
        .and_then(|(_, value)| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(raw)
        .to_owned()
}

fn best_icon(root: &Path, manifest: &Value) -> Option<String> {
    fn largest(value: &Value, best: &mut Option<(u64, String)>) {
        let Some(object) = value.as_object() else {
            return;
        };
        for (size, value) in object {
            let Some(relative) = value.as_str() else {
                continue;
            };
            let size = size.parse().unwrap_or(0);
            if best.as_ref().is_none_or(|(current, _)| size > *current) {
                *best = Some((size, relative.to_owned()));
            }
        }
    }
    let mut best = None;
    if let Some(icons) = manifest.get("icons") {
        largest(icons, &mut best);
    }
    if best.is_none() {
        for key in ["action", "browser_action", "page_action"] {
            let Some(icon) = manifest
                .get(key)
                .and_then(|value| value.get("default_icon"))
            else {
                continue;
            };
            if let Some(path) = icon.as_str() {
                best = Some((0, path.to_owned()));
            } else {
                largest(icon, &mut best);
            }
        }
    }
    let (_, relative) = best?;
    let relative = Path::new(relative.trim_start_matches('/'));
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > ICON_MAX {
        return None;
    }
    let canonical = fs::canonicalize(&path).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let bytes = fs::read(&canonical).ok()?;
    let mime = match canonical
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("svg") => "image/svg+xml",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn read_live(library: &Path, id: &str, stored: StoredExtension) -> BrowserResult<LiveExtension> {
    if !valid_id(id) {
        return Err(storage("扩展库记录包含无效标识"));
    }
    let directory = library.join(id);
    let root = manifest_root(&directory)?;
    validate_live_root(library, &root)?;
    let manifest = read_manifest(&root).map_err(|error| invalid(format!("{error:#}")))?;
    let messages = locale_messages(&root, &manifest);
    let field = |key: &str| {
        resolve_message(
            manifest
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default(),
            &messages,
        )
    };
    let name = {
        let value = field("name");
        if value.trim().is_empty() {
            id.to_owned()
        } else {
            value
        }
    };
    let entry = ExtensionEntry {
        id: id.to_owned(),
        name,
        version: field("version"),
        description: field("description"),
        icon: best_icon(&root, &manifest).unwrap_or_default(),
        path: root.to_string_lossy().into_owned(),
        size_bytes: validate_tree(&directory).map_err(storage)?,
        added_at: stored.added_at,
        source: stored.source,
    };
    Ok(LiveExtension {
        entry,
        root,
        manifest,
    })
}

fn list_internal(
    service: &WindowService,
    connection_id: &str,
) -> BrowserResult<Vec<ExtensionEntry>> {
    let library = library_dir(service, connection_id)?;
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    let mut query = db
        .prepare(
            "SELECT id,record_json FROM shardbrowser_extensions
             WHERE connection_id=?1 ORDER BY id",
        )
        .map_err(storage)?;
    let rows = query
        .query_map([connection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage)?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, record) = row.map_err(storage)?;
        let stored: StoredExtension = serde_json::from_str(&record).map_err(storage)?;
        entries.push(read_live(&library, &id, stored)?.entry);
    }
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(entries)
}

fn stored_extension(
    db: &Connection,
    connection_id: &str,
    id: &str,
) -> BrowserResult<StoredExtension> {
    let record = db
        .query_row(
            "SELECT record_json FROM shardbrowser_extensions
             WHERE connection_id=?1 AND id=?2",
            params![connection_id, id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage)?
        .ok_or_else(|| BrowserError::new("not_found", "扩展不在 ShardBrowser 扩展库中"))?;
    serde_json::from_str(&record).map_err(storage)
}

fn update_record(db: &Connection, connection_id: &str, id: &str) -> BrowserResult<UpdateRecord> {
    let record = db
        .query_row(
            "SELECT record_json FROM shardbrowser_extension_updates
             WHERE connection_id=?1 AND extension_id=?2",
            params![connection_id, id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage)?;
    record
        .map(|record| serde_json::from_str(&record).map_err(storage))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn save_update_record(
    db: &Connection,
    connection_id: &str,
    id: &str,
    record: &UpdateRecord,
) -> BrowserResult<()> {
    let body = serde_json::to_string(record).map_err(storage)?;
    db.execute(
        "INSERT INTO shardbrowser_extension_updates(connection_id,extension_id,record_json)
         VALUES(?1,?2,?3)
         ON CONFLICT(connection_id,extension_id) DO UPDATE SET record_json=excluded.record_json",
        params![connection_id, id, body],
    )
    .map_err(storage)?;
    Ok(())
}

fn is_os_litter(name: &std::ffi::OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".DS_Store" | "Thumbs.db" | "desktop.ini" | "__MACOSX")
    )
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if is_os_litter(&entry.file_name()) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            bail!("unpacked extension folders cannot contain symbolic links");
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            bail!("unpacked extension folders can contain only files and directories");
        }
    }
    Ok(())
}

fn unzip_archive(archive: &[u8], destination: &Path) -> Result<()> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(archive)).context("not a zip/crx archive")?;
    if zip.len() > UNPACK_FILES {
        bail!("the archive holds more than {UNPACK_FILES} files");
    }
    let declared = (0..zip.len())
        .filter_map(|index| zip.by_index_raw(index).ok().map(|file| file.size()))
        .fold(0u64, u64::saturating_add);
    if declared > UNPACK_MAX {
        bail!("the extension unpacks to more than {} MB", UNPACK_MAX >> 20);
    }
    let mut total = 0u64;
    for index in 0..zip.len() {
        let file = zip.by_index(index)?;
        if file.is_symlink() {
            bail!("the archive contains a symbolic link");
        }
        let relative = file
            .enclosed_name()
            .context("the archive contains an unsafe path")?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            bail!("the archive contains an unsafe path");
        }
        let target = destination.join(relative);
        if file.is_dir() {
            fs::create_dir_all(target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = fs::File::create(&target)?;
        let remaining = UNPACK_MAX.saturating_sub(total).saturating_add(1);
        total = total.saturating_add(std::io::copy(&mut file.take(remaining), &mut output)?);
        if total > UNPACK_MAX {
            bail!("the extension unpacks to more than {} MB", UNPACK_MAX >> 20);
        }
    }
    Ok(())
}

fn install_from_path(
    service: &WindowService,
    connection_id: &str,
    source: &Path,
    separate: bool,
) -> BrowserResult<ExtensionEntry> {
    let library = library_dir(service, connection_id)?;
    if !source.is_absolute() {
        return Err(invalid("扩展来源必须使用绝对路径"));
    }
    let source_metadata =
        fs::symlink_metadata(source).map_err(|_| invalid("无法读取所选扩展文件或目录"))?;
    if source_metadata.file_type().is_symlink() {
        return Err(invalid("扩展来源不能是符号链接"));
    }
    let canonical = fs::canonicalize(source).map_err(|_| invalid("无法读取所选扩展文件或目录"))?;
    let metadata = fs::symlink_metadata(&canonical).map_err(storage)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let staging = library.join(".staging").join(&id);
    let tree = staging.join("tree");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir(&staging).map_err(storage)?;
    let result = (|| -> BrowserResult<(Option<ExtensionSource>, Option<String>)> {
        if metadata.is_dir() {
            validate_tree(&canonical).map_err(|error| invalid(format!("{error:#}")))?;
            copy_directory(&canonical, &tree).map_err(|error| invalid(format!("{error:#}")))?;
        } else if metadata.is_file() {
            let extension = canonical
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .ok_or_else(|| invalid("仅支持 .crx 和 .zip 扩展包"))?;
            if !matches!(extension.as_str(), "crx" | "zip") || metadata.len() > DOWNLOAD_MAX {
                return Err(invalid("仅支持不超过 256 MB 的 .crx 或 .zip 扩展包"));
            }
            let bytes = fs::read(&canonical).map_err(storage)?;
            fs::create_dir(&tree).map_err(storage)?;
            let verified = if extension == "crx" {
                Some(
                    verify_crx(&bytes, &CrxExpectation::default())
                        .map_err(|error| invalid(format!("CRX3 校验失败：{error}")))?,
                )
            } else {
                None
            };
            let archive = verified
                .as_ref()
                .map(|verified| &bytes[verified.archive_offset..])
                .unwrap_or(bytes.as_slice());
            unzip_archive(archive, &tree).map_err(|error| invalid(format!("{error:#}")))?;
            if let Some(verified) = &verified {
                set_manifest_key(&manifest_root(&tree)?, &verified.developer_key)
                    .map_err(|error| invalid(format!("{error:#}")))?;
            }
        } else {
            return Err(invalid("扩展来源必须是普通文件或目录"));
        }
        let root = manifest_root(&tree)?;
        validate_live_root(&staging, &root)?;
        let key = manifest_key_id(&root);
        let source = key.as_ref().and_then(|id| {
            let store_signed = if metadata.is_file() {
                fs::read(&canonical)
                    .ok()
                    .and_then(|bytes| verify_crx(&bytes, &CrxExpectation::default()).ok())
                    .is_some_and(|verified| verified.proof_keys.contains(&PUBLISHER_KEY_HASH))
            } else {
                true
            };
            store_signed.then(|| ExtensionSource::Webstore { id: id.clone() })
        });
        Ok((source, key))
    })();
    let (source_ref, key_id) = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let _guard = library_launch_guard()?;
    refuse_duplicate(
        service,
        connection_id,
        source_ref.as_ref(),
        key_id.as_deref(),
        separate,
    )?;
    let destination = library.join(&id);
    fs::rename(&tree, &destination).map_err(storage)?;
    let stored = StoredExtension {
        v: RECORD_VERSION,
        added_at: stamp(),
        source: source_ref,
    };
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    let inserted = db.execute(
        "INSERT INTO shardbrowser_extensions(connection_id,id,record_json)
         VALUES(?1,?2,?3)",
        params![
            connection_id,
            id,
            serde_json::to_string(&stored).map_err(storage)?
        ],
    );
    if let Err(error) = inserted {
        let _ = fs::remove_dir_all(&destination);
        let _ = fs::remove_dir_all(&staging);
        return Err(storage(error));
    }
    let _ = fs::remove_dir_all(&staging);
    read_live(&library, &id, stored).map(|live| live.entry)
}

fn refuse_duplicate(
    service: &WindowService,
    connection_id: &str,
    source: Option<&ExtensionSource>,
    key_id: Option<&str>,
    separate: bool,
) -> BrowserResult<()> {
    let library = library_dir(service, connection_id)?;
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    let mut query = db
        .prepare("SELECT id,record_json FROM shardbrowser_extensions WHERE connection_id=?1")
        .map_err(storage)?;
    let rows = query
        .query_map([connection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage)?;
    for row in rows {
        let (id, record) = row.map_err(storage)?;
        let stored: StoredExtension = serde_json::from_str(&record).map_err(storage)?;
        let live = read_live(&library, &id, stored.clone())?;
        let existing_key = manifest_key_id(&live.root);
        let same_key = key_id.is_some() && existing_key.as_deref() == key_id;
        let same_source = source.is_some() && stored.source.as_ref() == source;
        if !same_key && !same_source {
            continue;
        }
        if separate && !same_key {
            continue;
        }
        let detail = json!({
            "entry_id": id,
            "installed": live.entry.version,
            "separate": !same_key
        });
        return Err(BrowserError::new(
            ALREADY_IN_LIBRARY,
            format!("{ALREADY_IN_LIBRARY} {detail}"),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct Version(Vec<u32>);

impl Version {
    fn parse(value: &str) -> Option<Self> {
        let mut parts = Vec::new();
        for (index, part) in value.split('.').enumerate() {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let number = part.parse::<u32>().ok()?;
            if index == 0 && number.to_string() != part {
                return None;
            }
            parts.push(number);
        }
        (1..=4).contains(&parts.len()).then_some(Self(parts))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let length = self.0.len().max(other.0.len());
        let part = |values: &[u32], index: usize| values.get(index).copied().unwrap_or(0);
        (0..length)
            .map(|index| part(&self.0, index).cmp(&part(&other.0, index)))
            .find(|ordering| ordering.is_ne())
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for Version {}

fn newer(candidate: &str, installed: &str) -> bool {
    matches!(
        (Version::parse(candidate), Version::parse(installed)),
        (Some(candidate), Some(installed)) if candidate > installed
    )
}

fn is_chrome_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn id_from_hash(hash: &[u8]) -> String {
    hash.iter()
        .take(16)
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .map(|nibble| char::from(b'a' + nibble))
        .collect()
}

fn id_from_key(key: &[u8]) -> String {
    id_from_hash(&Sha256::digest(key))
}

fn decode_manifest_key(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || text.len() > 100 * 1024 {
        return None;
    }
    let mut body = text.to_owned();
    if text.starts_with("-----BEGIN") {
        let flat = collapse_ascii_whitespace(text);
        let start = flat.get(10..)?.find("KEY-----")? + 10 + "KEY-----".len();
        let end = flat.rfind("-----END")?;
        body = flat.get(start..end)?.to_owned();
        if body.is_empty() {
            return None;
        }
    }
    base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .ok()
}

fn collapse_ascii_whitespace(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut run = None;
    for character in text.chars() {
        if character.is_ascii_whitespace() || character == '\x0b' {
            let line_break = character == '\n' || character == '\r';
            run = Some(run.unwrap_or(false) || line_break);
            continue;
        }
        if let Some(line_break) = run.take()
            && !line_break
            && !output.is_empty()
        {
            output.push(' ');
        }
        output.push(character);
    }
    output
}

fn manifest_key_id(root: &Path) -> Option<String> {
    let manifest = read_manifest(root).ok()?;
    let key = manifest
        .get("key")?
        .as_str()
        .and_then(decode_manifest_key)?;
    Some(id_from_key(&key))
}

fn set_manifest_key(root: &Path, key: &[u8]) -> Result<()> {
    let path = root.join("manifest.json");
    let text = fs::read_to_string(&path)?;
    let plain = strip_comments(text.trim_start_matches('\u{feff}'));
    let mut object = serde_json::from_str::<serde_json::Map<String, Value>>(&plain)
        .context("manifest.json is not a rewritable JSON object")?;
    object.insert(
        "key".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(key)),
    );
    let temporary = root.join(".manifest.raccoon.tmp");
    let result = (|| -> Result<()> {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(serde_json::to_string_pretty(&Value::Object(object))?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

const PUBLISHER_KEY_HASH: [u8; 32] = [
    0x61, 0xf7, 0xf2, 0xa6, 0xbf, 0xcf, 0x74, 0xcd, 0x0b, 0xc1, 0xfe, 0x24, 0x97, 0xcc, 0x9b, 0x04,
    0x25, 0x4c, 0x65, 0x8f, 0x79, 0xf2, 0x14, 0x53, 0x92, 0x86, 0x7e, 0xa8, 0x36, 0x63, 0x67, 0xcf,
];
const MAX_CRX_HEADER: usize = 1 << 20;
const SIGNATURE_CONTEXT: &[u8] = b"CRX3 SignedData\x00";
const ZIP_TOKENS: [&[u8]; 3] = [b"PK\x05\x06", b"PK\x06\x07", b"PK\x06\x06"];

#[derive(Default)]
struct CrxExpectation<'a> {
    id: Option<&'a str>,
    publisher: bool,
    sha256: Option<&'a str>,
    size: Option<u64>,
}

struct VerifiedCrx {
    crx_id: String,
    developer_key: Vec<u8>,
    proof_keys: Vec<[u8; 32]>,
    archive_offset: usize,
}

fn verify_crx(bytes: &[u8], expected: &CrxExpectation<'_>) -> Result<VerifiedCrx> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if let Some(size) = expected.size
        && size != bytes.len() as u64
    {
        bail!(
            "the download is {} bytes, the Web Store said {size}",
            bytes.len()
        );
    }
    if let Some(wanted) = expected.sha256
        && !wanted.eq_ignore_ascii_case(&sha256)
    {
        bail!("the download does not match the Web Store's hash");
    }
    if bytes.len() < 12 || &bytes[..4] != b"Cr24" || bytes[4..8] != 3u32.to_le_bytes() {
        bail!("not a CRX3 package");
    }
    let header_size = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| anyhow!("invalid CRX3 header"))?,
    ) as usize;
    if header_size > MAX_CRX_HEADER || bytes.len().saturating_sub(12) < header_size {
        bail!("the CRX header's size is wrong");
    }
    let header = &bytes[12..12 + header_size];
    if ZIP_TOKENS
        .iter()
        .any(|token| header.windows(4).any(|window| window == *token))
    {
        bail!("the CRX header holds a zip marker");
    }
    let archive_offset = 12 + header_size;
    let (mut proofs, mut signed) = (Vec::new(), &[][..]);
    for (field, data) in protobuf_fields(header).context("the CRX header cannot be read")? {
        match field {
            2 | 3 => {
                let (mut key, mut signature) = (&[][..], &[][..]);
                for (nested, value) in
                    protobuf_fields(data).context("the CRX proof cannot be read")?
                {
                    match nested {
                        1 => key = value,
                        2 => signature = value,
                        _ => {}
                    }
                }
                proofs.push((field == 2, key, signature));
            }
            10000 => signed = data,
            _ => {}
        }
    }
    let declared = protobuf_fields(signed)
        .context("the CRX signed header cannot be read")?
        .into_iter()
        .find_map(|(field, data)| (field == 1 && data.len() == 16).then(|| id_from_hash(data)));
    let mut developer_key = None;
    let mut checks = Vec::new();
    for (rsa, key, signed_value) in proofs {
        if declared.as_deref() == Some(id_from_key(key).as_str()) {
            developer_key = Some(key);
        }
        let (algorithm, raw) = spki(key, rsa).context("a key in the CRX cannot be read")?;
        checks.push((
            algorithm,
            raw,
            signed_value,
            <[u8; 32]>::from(Sha256::digest(key)),
        ));
    }
    let crx_id = declared.context("the CRX is not signed by its developer's key")?;
    let developer_key = developer_key.context("the CRX is not signed by its developer's key")?;
    if expected.publisher
        && !checks
            .iter()
            .any(|(_, _, _, hash)| *hash == PUBLISHER_KEY_HASH)
    {
        bail!("the CRX is not signed by the Web Store");
    }
    let archive = &bytes[archive_offset..];
    let mut message =
        Vec::with_capacity(SIGNATURE_CONTEXT.len() + 4 + signed.len() + archive.len());
    message.extend_from_slice(SIGNATURE_CONTEXT);
    message.extend_from_slice(&(signed.len() as u32).to_le_bytes());
    message.extend_from_slice(signed);
    message.extend_from_slice(archive);
    for (algorithm, raw, signed_value, _) in &checks {
        UnparsedPublicKey::new(*algorithm, raw)
            .verify(&message, signed_value)
            .map_err(|_| anyhow!("the CRX signature does not match its contents"))?;
    }
    if let Some(wanted) = expected.id
        && wanted != crx_id
    {
        bail!("the package is extension {crx_id}, not {wanted}");
    }
    Ok(VerifiedCrx {
        crx_id,
        developer_key: developer_key.to_vec(),
        proof_keys: checks.iter().map(|(_, _, _, hash)| *hash).collect(),
        archive_offset,
    })
}

fn protobuf_fields(mut bytes: &[u8]) -> Option<Vec<(u64, &[u8])>> {
    fn varint(bytes: &mut &[u8]) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let (&byte, rest) = bytes.split_first()?;
            *bytes = rest;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }
    let mut fields = Vec::new();
    while !bytes.is_empty() {
        let tag = varint(&mut bytes)?;
        if tag >> 3 == 0 {
            return None;
        }
        let skip = match tag & 7 {
            0 => {
                varint(&mut bytes)?;
                0
            }
            1 => 8,
            2 => {
                let length = usize::try_from(varint(&mut bytes)?).ok()?;
                fields.push((tag >> 3, bytes.get(..length)?));
                length
            }
            5 => 4,
            _ => return None,
        };
        bytes = bytes.get(skip..)?;
    }
    Some(fields)
}

fn der(bytes: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, bytes) = bytes.split_first()?;
    let (&first, mut bytes) = bytes.split_first()?;
    let length = if first < 0x80 {
        usize::from(first)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || *bytes.first()? == 0 {
            return None;
        }
        let mut length = 0usize;
        for byte in bytes.get(..count)? {
            length = length << 8 | usize::from(*byte);
        }
        bytes = &bytes[count..];
        if length < 0x80 {
            return None;
        }
        length
    };
    Some((tag, bytes.get(..length)?, &bytes[length..]))
}

const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];

fn spki(key: &[u8], rsa: bool) -> Option<(&'static dyn VerificationAlgorithm, &[u8])> {
    let (0x30, body, []) = der(key)? else {
        return None;
    };
    let (0x30, algorithm, rest) = der(body)? else {
        return None;
    };
    let (0x03, bits, []) = der(rest)? else {
        return None;
    };
    let (0x06, oid, parameters) = der(algorithm)? else {
        return None;
    };
    let ([0], raw) = bits.split_at_checked(1)? else {
        return None;
    };
    match (rsa, oid) {
        (true, OID_RSA) if parameters == [0x05, 0x00] => Some((
            &signature::RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY,
            raw,
        )),
        (false, OID_EC) => match der(parameters)? {
            (0x06, OID_P256, []) => Some((&signature::ECDSA_P256_SHA256_ASN1, raw)),
            (0x06, OID_P384, []) => Some((&signature::ECDSA_P384_SHA256_ASN1, raw)),
            _ => None,
        },
        _ => None,
    }
}

fn store_id(raw: &str) -> Option<String> {
    let value = raw.trim();
    if is_chrome_id(value) {
        return Some(value.to_owned());
    }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let path = url.path();
    match url.host_str()? {
        "chromewebstore.google.com" => detail_id(path),
        "chrome.google.com" if path.starts_with("/webstore/") => detail_id(path),
        _ => None,
    }
}

fn detail_id(path: &str) -> Option<String> {
    fn at_start(value: &str) -> Option<&str> {
        value
            .get(..32)
            .filter(|id| is_chrome_id(id) && matches!(value.as_bytes().get(32), None | Some(b'/')))
    }
    let mut from = 0usize;
    while let Some(offset) = path[from..].find("/detail/") {
        let rest = &path[from + offset + "/detail/".len()..];
        if let Some(slash) = rest.find('/').filter(|position| *position > 0)
            && let Some(id) = at_start(&rest[slash + 1..])
        {
            return Some(id.to_owned());
        }
        if let Some(id) = at_start(rest) {
            return Some(id.to_owned());
        }
        from += offset + 1;
    }
    None
}

fn sanitize_direct_source(url: &url::Url) -> String {
    let mut clean = url.clone();
    clean.set_query(None);
    clean.set_fragment(None);
    clean.to_string()
}

fn resolve_import_url(raw: &str) -> BrowserResult<(url::Url, Option<String>, ExtensionSource)> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(invalid("请输入扩展链接或 Chrome Web Store ID"));
    }
    if let Some(id) = store_id(value) {
        let url = url::Url::parse(&format!(
            "{WEBSTORE_UPDATE}?response=redirect&acceptformat=crx3&prodversion={}&x=id%3D{id}%26uc",
            shardx::CHROMIUM_VERSION
        ))
        .map_err(storage)?;
        return Ok((url, Some(id.clone()), ExtensionSource::Webstore { id }));
    }
    let url = url::Url::parse(value).map_err(|_| invalid("扩展下载链接无效"))?;
    validate_https_url(&url, true)?;
    let extension = Path::new(url.path())
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("crx" | "zip")) {
        return Err(invalid("直接下载链接必须指向 .crx 或 .zip 文件"));
    }
    Ok((
        url.clone(),
        None,
        ExtensionSource::Url {
            url: sanitize_direct_source(&url),
        },
    ))
}

fn validate_https_url(url: &url::Url, _direct: bool) -> BrowserResult<()> {
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(invalid("扩展下载仅允许无凭据的 HTTPS 地址"));
    }
    Ok(())
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !ip.is_unspecified()
                && !ip.is_loopback()
                && !ip.is_private()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
                && !(octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                && !(octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                && !(octets[0] == 198 && (18..=19).contains(&octets[1]))
                && !(octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                && !(octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                && octets[0] < 224
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
                && ip
                    .to_ipv4_mapped()
                    .is_none_or(|mapped| public_ip(IpAddr::V4(mapped)))
        }
    }
}

async fn resolved_public_addresses(url: &url::Url) -> BrowserResult<(String, Vec<SocketAddr>)> {
    let host = url
        .host_str()
        .ok_or_else(|| invalid("扩展下载地址缺少主机"))?
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| BrowserError::new("unavailable", "无法解析扩展下载主机"))?
        .filter(|address| public_ip(address.ip()))
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(BrowserError::new(
            "permission_denied",
            "扩展下载地址解析到本机、内网或保留地址，已拒绝访问",
        ));
    }
    Ok((host, addresses))
}

async fn download_file(
    app: &AppHandle,
    connection_id: &str,
    operation_id: &str,
    initial: url::Url,
    destination: &Path,
    cancel: &AtomicBool,
) -> BrowserResult<()> {
    use tokio::io::AsyncWriteExt;
    let mut current = initial;
    for redirects in 0..=5 {
        validate_https_url(&current, false)?;
        let (host, addresses) = resolved_public_addresses(&current).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .user_agent(format!("ShardX-Launcher/{}", env!("CARGO_PKG_VERSION")))
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(storage)?;
        let response = tokio::time::timeout(STALL, client.get(current.clone()).send())
            .await
            .map_err(|_| BrowserError::new("unavailable", "扩展下载服务器没有响应"))?
            .map_err(|_| BrowserError::new("unavailable", "无法下载扩展文件"))?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err(invalid("扩展下载重定向次数过多"));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| invalid("扩展下载重定向缺少目标地址"))?;
            current = current
                .join(location)
                .map_err(|_| invalid("扩展下载重定向地址无效"))?;
            continue;
        }
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Err(BrowserError::new(
                "not_found",
                "Chrome Web Store 中没有此扩展",
            ));
        }
        let mut response = response
            .error_for_status()
            .map_err(|_| BrowserError::new("unavailable", "扩展下载服务器拒绝请求"))?;
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
            })
            .is_some_and(|value| {
                value.starts_with("text/")
                    || value == "application/json"
                    || value.ends_with("+json")
                    || value == "application/xml"
                    || value.ends_with("+xml")
            })
        {
            return Err(invalid("链接返回的内容类型不是扩展文件"));
        }
        let total = response.content_length().unwrap_or(0);
        if total > DOWNLOAD_MAX {
            return Err(invalid("扩展下载文件超过 256 MB"));
        }
        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(storage)?;
        let mut received = 0u64;
        let mut first = None;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = tokio::fs::remove_file(destination).await;
                return Err(BrowserError::new("cancelled", CANCELLED));
            }
            let chunk = tokio::time::timeout(STALL, response.chunk())
                .await
                .map_err(|_| BrowserError::new("unavailable", "扩展下载已停滞"))?
                .map_err(|_| BrowserError::new("unavailable", "扩展下载中断"))?;
            let Some(chunk) = chunk else {
                break;
            };
            received = received.saturating_add(chunk.len() as u64);
            if received > DOWNLOAD_MAX {
                let _ = tokio::fs::remove_file(destination).await;
                return Err(invalid("扩展下载文件超过 256 MB"));
            }
            first = first.or_else(|| chunk.first().copied());
            file.write_all(&chunk).await.map_err(storage)?;
            set_progress(
                app,
                connection_id,
                operation_id,
                UpdatePhase::Download,
                received,
                total,
            );
        }
        file.flush().await.map_err(storage)?;
        if total != 0 && received != total {
            let _ = tokio::fs::remove_file(destination).await;
            return Err(BrowserError::new(
                "unavailable",
                "扩展下载长度与服务器声明不一致",
            ));
        }
        if received < 4 || first == Some(b'<') {
            let _ = tokio::fs::remove_file(destination).await;
            return Err(invalid("链接返回的是网页或空内容，不是扩展文件"));
        }
        return Ok(());
    }
    Err(invalid("扩展下载重定向无效"))
}

#[derive(Debug, Clone)]
enum StoreAnswer {
    Update {
        version: String,
        codebase: String,
        sha256: Option<String>,
        size: Option<u64>,
    },
    NoUpdate,
    Unknown(String),
    Error(String),
}

#[derive(Debug, Clone)]
struct StoreAppAnswer {
    id: String,
    answer: StoreAnswer,
    flags: Vec<ExtensionFlag>,
    allowlisted: Option<bool>,
}

fn update_check_urls(items: &[(String, String)]) -> Vec<url::Url> {
    const URL_BUDGET: usize = 2000;
    let head = format!(
        "{WEBSTORE_UPDATE}?response=updatecheck&acceptformat=crx3&prodversion={}",
        shardx::CHROMIUM_VERSION
    );
    let mut current = head.clone();
    let mut output = Vec::new();
    for (id, version) in items {
        if !is_chrome_id(id) || Version::parse(version).is_none() {
            continue;
        }
        let value = format!("id={id}&v={version}&uc");
        let encoded = url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
        let addition = format!("&x={encoded}");
        if current.len() > head.len() && current.len() + addition.len() > URL_BUDGET {
            if let Ok(url) = url::Url::parse(&current) {
                output.push(url);
            }
            current = head.clone();
        }
        current.push_str(&addition);
    }
    if current.len() > head.len()
        && let Ok(url) = url::Url::parse(&current)
    {
        output.push(url);
    }
    output
}

async fn get_small(url: url::Url) -> BrowserResult<Vec<u8>> {
    validate_https_url(&url, false)?;
    let (host, addresses) = resolved_public_addresses(&url).await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(CHECK_TIMEOUT)
        .user_agent(format!("ShardX-Launcher/{}", env!("CARGO_PKG_VERSION")))
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(storage)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| BrowserError::new("unavailable", "Chrome Web Store 更新检查失败"))?;
    if !response.status().is_success() {
        return Err(BrowserError::new(
            "unavailable",
            format!("Chrome Web Store 更新检查返回 {}", response.status()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > SMALL_MAX as u64)
    {
        return Err(invalid("Chrome Web Store 更新响应过大"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| BrowserError::new("unavailable", "Chrome Web Store 更新响应中断"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > SMALL_MAX {
            return Err(invalid("Chrome Web Store 更新响应过大"));
        }
    }
    Ok(body)
}

type XmlAttributes = Vec<(String, String)>;

fn xml_attributes(reader: &NsReader<&[u8]>, element: &BytesStart<'_>) -> XmlAttributes {
    element
        .attributes()
        .flatten()
        .filter_map(|attribute| {
            let key = String::from_utf8(attribute.key.local_name().as_ref().to_vec()).ok()?;
            let value = attribute
                .decode_and_unescape_value(reader.decoder())
                .ok()?
                .into_owned();
            Some((key, value))
        })
        .collect()
}

fn xml_attribute(reader: &NsReader<&[u8]>, element: &BytesStart<'_>, key: &str) -> Option<String> {
    xml_attributes(reader, element)
        .into_iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn parse_update_response(body: &[u8]) -> Result<Vec<StoreAppAnswer>> {
    let text = std::str::from_utf8(body).context("Web Store response is not UTF-8")?;
    let mut reader = NsReader::from_str(text);
    let (mut depth, mut root) = (0usize, false);
    let mut applications = Vec::new();
    let mut application: Option<(String, String, Vec<XmlAttributes>)> = None;
    loop {
        let (namespace, event) = reader
            .read_resolved_event()
            .context("Web Store response is not XML")?;
        let in_namespace = matches!(
            namespace,
            ResolveResult::Bound(Namespace(value)) if value == GUPDATE_NS
        );
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                let empty = matches!(event, Event::Empty(_));
                let name = element.local_name().as_ref().to_vec();
                match depth {
                    0 => {
                        if !in_namespace
                            || name != b"gupdate"
                            || xml_attribute(&reader, element, "protocol").as_deref() != Some("2.0")
                        {
                            bail!("not a gupdate response");
                        }
                        root = true;
                    }
                    1 if in_namespace && name == b"app" => {
                        application = Some((
                            xml_attribute(&reader, element, "appid").unwrap_or_default(),
                            xml_attribute(&reader, element, "status").unwrap_or_default(),
                            Vec::new(),
                        ));
                    }
                    2 if in_namespace && name == b"updatecheck" => {
                        if let Some((_, _, checks)) = application.as_mut() {
                            checks.push(xml_attributes(&reader, element));
                        }
                    }
                    _ => {}
                }
                if empty {
                    if depth == 1
                        && let Some(application) = application.take()
                    {
                        applications.push(finish_update_answer(application));
                    }
                } else {
                    depth = depth.saturating_add(1);
                }
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if depth == 1
                    && let Some(application) = application.take()
                {
                    applications.push(finish_update_answer(application));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root || depth != 0 {
        bail!("incomplete gupdate response");
    }
    Ok(applications
        .into_iter()
        .filter(|answer| !answer.id.is_empty())
        .collect())
}

fn finish_update_answer(
    (id, status, checks): (String, String, Vec<XmlAttributes>),
) -> StoreAppAnswer {
    let mut output = StoreAppAnswer {
        id,
        answer: StoreAnswer::NoUpdate,
        flags: Vec::new(),
        allowlisted: None,
    };
    if !status.is_empty() && status != "ok" {
        output.answer = StoreAnswer::Unknown(status);
        return output;
    }
    let [check] = checks.as_slice() else {
        output.answer = StoreAnswer::Error(if checks.is_empty() {
            "no updatecheck".into()
        } else {
            "several updatecheck".into()
        });
        return output;
    };
    let value = |key: &str| {
        check
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    for (key, flag) in [
        ("_malware", ExtensionFlag::Malware),
        ("_policy_violation", ExtensionFlag::PolicyViolation),
        ("_potentially_uws", ExtensionFlag::PotentiallyUws),
    ] {
        if value(key) == Some("true") {
            output.flags.push(flag);
        }
    }
    output.allowlisted = match value("_esbAllowlist") {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    output.answer = match value("status").unwrap_or_default() {
        "noupdate" => StoreAnswer::NoUpdate,
        "ok" | "" => parse_update_attributes(check),
        other => StoreAnswer::Error(format!("updatecheck status {other}")),
    };
    output
}

fn parse_update_attributes(attributes: &XmlAttributes) -> StoreAnswer {
    let value = |key: &str| {
        attributes
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    let codebase = value("codebase").unwrap_or_default();
    let url = match url::Url::parse(codebase) {
        Ok(url)
            if url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none() =>
        {
            url
        }
        _ => return StoreAnswer::Error("bad codebase".into()),
    };
    let version = value("version").unwrap_or_default();
    if Version::parse(version).is_none() {
        return StoreAnswer::Error(format!("bad version {version:?}"));
    }
    let sha256 = match value("hash_sha256") {
        None | Some("") => None,
        Some(hash) if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            Some(hash.to_ascii_lowercase())
        }
        Some(_) => return StoreAnswer::Error("bad hash_sha256".into()),
    };
    let size = value("size").and_then(|size| size.parse().ok());
    StoreAnswer::Update {
        version: version.into(),
        codebase: url.to_string(),
        sha256,
        size,
    }
}

async fn ask_store(items: &[(String, String)]) -> BrowserResult<Vec<StoreAppAnswer>> {
    let urls = update_check_urls(items);
    if urls.is_empty() {
        return Err(invalid("没有可用于 Web Store 更新检查的扩展"));
    }
    let mut answers = Vec::new();
    for url in urls {
        let body = get_small(url).await?;
        answers.extend(
            parse_update_response(&body)
                .map_err(|error| BrowserError::new("invalid_response", format!("{error:#}")))?,
        );
    }
    Ok(answers)
}

fn store_answer_for<'a>(
    answers: &'a [StoreAppAnswer],
    id: &str,
) -> BrowserResult<&'a StoreAppAnswer> {
    answers
        .iter()
        .find(|answer| answer.id == id)
        .ok_or_else(|| {
            BrowserError::new(
                "invalid_response",
                "Chrome Web Store 没有返回此扩展的更新结果",
            )
        })
}

fn apply_store_answer(
    record: &mut UpdateRecord,
    answer: &StoreAppAnswer,
    installed: &str,
    checked_at: u64,
) {
    record.flags = answer.flags.clone();
    record.allowlisted = answer.allowlisted;
    record.checked_at = Some(checked_at);
    match &answer.answer {
        StoreAnswer::Update {
            version,
            codebase,
            sha256,
            size,
        } if newer(version, installed) => {
            if record.latest.as_deref() != Some(version) {
                record.first_seen = Some(checked_at);
            }
            record.latest = Some(version.clone());
            record.size = *size;
            record.codebase = Some(codebase.clone());
            record.sha256 = sha256.clone();
            record.error = None;
        }
        StoreAnswer::Update { .. } | StoreAnswer::NoUpdate => {
            record.latest = None;
            record.size = None;
            record.first_seen = None;
            record.codebase = None;
            record.sha256 = None;
            record.error = None;
        }
        StoreAnswer::Unknown(status) => {
            record.latest = None;
            record.size = None;
            record.codebase = None;
            record.sha256 = None;
            record.error = Some(format!("Chrome Web Store 不认识此扩展（{status}）"));
        }
        StoreAnswer::Error(error) => {
            record.error = Some(format!("Chrome Web Store 返回无法读取：{error}"));
        }
    }
}

fn selected_ids(record: &WindowRecord) -> BrowserResult<Vec<String>> {
    record
        .settings
        .shardbrowser
        .as_ref()
        .map(validate_config_shape)
        .transpose()
        .map(Option::unwrap_or_default)
}

fn extension_holders(
    service: &WindowService,
    connection_id: &str,
    extension_id: &str,
) -> BrowserResult<Vec<ExtensionHolder>> {
    let connection = connection(service, connection_id)?;
    service.shard.with_extension_library_lock(|| {
        extension_holders_locked(service, &connection, connection_id, extension_id)
    })
}

fn extension_holders_locked(
    service: &WindowService,
    connection: &crate::core::browser::connection_store::BrowserConnection,
    connection_id: &str,
    extension_id: &str,
) -> BrowserResult<Vec<ExtensionHolder>> {
    let mut holders = Vec::new();
    for record in service.store.list().map_err(storage)? {
        if record.binding.provider_id != BrowserProviderId::ShardBrowser
            || record.binding.connection_id != connection_id
            || !selected_ids(&record)?.iter().any(|id| id == extension_id)
        {
            continue;
        }
        let state = service
            .shard
            .extension_profile_state_locked(connection, &record)?;
        if state != WindowState::Stopped {
            holders.push(ExtensionHolder {
                id: record.id,
                name: record.name,
            });
        }
    }
    holders.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(holders)
}

fn running_progress(connection_id: &str, id: &str) -> Option<Option<UpdateProgress>> {
    update_registry()
        .lock()
        .ok()?
        .get(&format!("{connection_id}:{id}"))
        .map(|running| running.progress)
}

fn staged_root(library: &Path, id: &str) -> PathBuf {
    library.join(".updates").join(id).join("tree")
}

fn update_view(
    service: &WindowService,
    connection_id: &str,
    library: &Path,
    id: &str,
) -> BrowserResult<ExtensionUpdate> {
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    let stored = stored_extension(&db, connection_id, id)?;
    let live = read_live(library, id, stored.clone())?;
    let record = update_record(&db, connection_id, id)?;
    let mut output = ExtensionUpdate {
        id: id.to_owned(),
        state: ExtensionUpdateState::Current,
        installed: live.entry.version.clone(),
        latest: record.latest.clone(),
        size: record.size,
        first_seen: record.first_seen,
        ready_since: record.staged.as_ref().map(|stage| stage.at),
        waiting_on: Vec::new(),
        progress: None,
        error: record.error.clone(),
        checked_at: record.checked_at,
        flags: record.flags.clone(),
        allowlisted: record.allowlisted,
        skipped: record.skipped.clone(),
        needs_engine: record
            .staged
            .as_ref()
            .and_then(|stage| stage.needs_engine.clone()),
        confirm: None,
    };
    output.state = if let Some(progress) = running_progress(connection_id, id) {
        output.progress = progress;
        if progress.is_some_and(|progress| progress.phase == UpdatePhase::Apply) {
            ExtensionUpdateState::Applying
        } else {
            ExtensionUpdateState::Downloading
        }
    } else if let Some(stage) = &record.staged {
        if stage.needs_engine.is_some() {
            ExtensionUpdateState::NeedsEngine
        } else if !stage.approved && (!stage.grown.is_empty() || stage.names.is_some()) {
            output.confirm = Some(UpdateConfirm {
                reason: if stage.names.is_some() {
                    ConfirmReason::Identity
                } else {
                    ConfirmReason::Permissions
                },
                grown: stage.grown.clone(),
                names: stage.names.clone(),
                overlap: stage.overlap,
            });
            ExtensionUpdateState::Confirm
        } else {
            output.waiting_on = extension_holders(service, connection_id, id)?;
            if output.waiting_on.is_empty() {
                ExtensionUpdateState::Ready
            } else {
                ExtensionUpdateState::Waiting
            }
        }
    } else if !matches!(stored.source, Some(ExtensionSource::Webstore { .. })) {
        ExtensionUpdateState::Unlinked
    } else if record.error.is_some() {
        ExtensionUpdateState::Failed
    } else if record
        .latest
        .as_deref()
        .is_some_and(|latest| newer(latest, &live.entry.version))
        && record.skipped.as_deref() != record.latest.as_deref()
    {
        ExtensionUpdateState::Available
    } else if record.checked_at.is_none() {
        ExtensionUpdateState::Unchecked
    } else {
        ExtensionUpdateState::Current
    };
    Ok(output)
}

fn updates_internal(
    service: &WindowService,
    connection_id: &str,
) -> BrowserResult<Vec<ExtensionUpdate>> {
    let library = library_dir(service, connection_id)?;
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    let mut query = db
        .prepare(
            "SELECT id FROM shardbrowser_extensions
             WHERE connection_id=?1 ORDER BY id",
        )
        .map_err(storage)?;
    let ids = query
        .query_map([connection_id], |row| row.get::<_, String>(0))
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    ids.into_iter()
        .map(|id| update_view(service, connection_id, &library, &id))
        .collect()
}

async fn check_updates_internal(
    service: Arc<WindowService>,
    connection_id: String,
) -> BrowserResult<(Vec<ExtensionUpdate>, UpdateNews)> {
    connection(&service, &connection_id)?;
    let library = library_dir(&service, &connection_id)?;
    let db_path = service.store.database_path();
    let linked = {
        let db = open_database(&db_path).map_err(storage)?;
        let mut query = db
            .prepare(
                "SELECT id,record_json FROM shardbrowser_extensions
                 WHERE connection_id=?1 ORDER BY id",
            )
            .map_err(storage)?;
        let rows = query
            .query_map([&connection_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage)?;
        let mut linked = Vec::new();
        for row in rows {
            let (id, body) = row.map_err(storage)?;
            let stored: StoredExtension = serde_json::from_str(&body).map_err(storage)?;
            let Some(ExtensionSource::Webstore { id: store_id }) = &stored.source else {
                continue;
            };
            let store_id = store_id.clone();
            let live = read_live(&library, &id, stored)?;
            linked.push((id, store_id, live.entry.name, live.entry.version));
        }
        linked
    };
    if linked.is_empty() {
        return Ok((
            updates_internal(&service, &connection_id)?,
            UpdateNews::default(),
        ));
    }
    let questions = linked
        .iter()
        .map(|(_, store_id, _, version)| (store_id.clone(), version.clone()))
        .collect::<Vec<_>>();
    let answers = ask_store(&questions).await?;
    let checked_at = now();
    let mut news = UpdateNews::default();
    let db = open_database(&db_path).map_err(storage)?;
    for (id, store_id, name, installed) in linked {
        let answer = store_answer_for(&answers, &store_id)?;
        let mut record = update_record(&db, &connection_id, &id)?;
        let prior_latest = record.latest.clone();
        let prior_flags = record.flags.clone();
        apply_store_answer(&mut record, answer, &installed, checked_at);
        if record.flags.is_empty()
            && record.latest.is_some()
            && record.latest != prior_latest
            && record.skipped != record.latest
        {
            news.fresh.push(FreshUpdate {
                id: id.clone(),
                name: name.clone(),
                version: record.latest.clone().unwrap_or_default(),
            });
        }
        if !record.flags.is_empty() && record.flags != prior_flags {
            news.flagged.push(FlaggedUpdate {
                id: id.clone(),
                name,
                flags: record.flags.clone(),
            });
        }
        save_update_record(&db, &connection_id, &id, &record)?;
    }
    Ok((updates_internal(&service, &connection_id)?, news))
}

fn remove_profile_references(
    transaction: &rusqlite::Transaction<'_>,
    connection_id: &str,
    extension_id: &str,
) -> BrowserResult<()> {
    let mut query = transaction
        .prepare(
            "SELECT id,record_json FROM profile_records
             WHERE connection_id=?1 AND provider_id='shardbrowser'",
        )
        .map_err(storage)?;
    let rows = query
        .query_map([connection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    drop(query);
    for (id, body) in rows {
        let mut record: WindowRecord = serde_json::from_str(&body).map_err(storage)?;
        let Some(config) = record.settings.shardbrowser.as_mut() else {
            continue;
        };
        let Some(values) = config
            .pointer_mut("/_meta/extensions")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let before = values.len();
        values.retain(|value| value.as_str() != Some(extension_id));
        if values.len() == before {
            continue;
        }
        transaction
            .execute(
                "UPDATE profile_records SET record_json=?2 WHERE id=?1",
                params![id, serde_json::to_string(&record).map_err(storage)?],
            )
            .map_err(storage)?;
    }
    Ok(())
}

fn delete_internal(service: &WindowService, connection_id: &str, id: &str) -> BrowserResult<()> {
    if !valid_id(id) {
        return Err(invalid("扩展标识无效"));
    }
    let library = library_dir(service, connection_id)?;
    let connection = connection(service, connection_id)?;
    service.shard.with_extension_library_lock(|| {
        let holders = extension_holders_locked(service, &connection, connection_id, id)?;
        if !holders.is_empty() {
            return Err(BrowserError::new(
                "profile_busy",
                format!(
                    "扩展仍被运行中的 Profile 使用：{}。请停止后再删除",
                    holders
                        .iter()
                        .map(|holder| holder.name.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                ),
            ));
        }
        let db_path = service.store.database_path();
        let mut db = open_database(&db_path).map_err(storage)?;
        stored_extension(&db, connection_id, id)?;
        let live = library.join(id);
        let metadata = fs::symlink_metadata(&live).map_err(storage)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(storage("扩展解包目录无效"));
        }
        let tombstone = library.join(format!(".{id}.delete-{}", uuid::Uuid::new_v4().simple()));
        fs::rename(&live, &tombstone).map_err(storage)?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let changed = (|| -> BrowserResult<()> {
            remove_profile_references(&transaction, connection_id, id)?;
            transaction
                .execute(
                    "DELETE FROM shardbrowser_extensions WHERE connection_id=?1 AND id=?2",
                    params![connection_id, id],
                )
                .map_err(storage)?;
            transaction.commit().map_err(storage)
        })();
        if let Err(error) = changed {
            let _ = fs::rename(&tombstone, &live);
            return Err(error);
        }
        let _ = fs::remove_dir_all(library.join(".updates").join(id));
        fs::remove_dir_all(tombstone).map_err(storage)
    })
}

async fn import_url_internal(
    app: AppHandle,
    service: Arc<WindowService>,
    connection_id: String,
    raw: String,
    separate: bool,
) -> BrowserResult<ExtensionEntry> {
    connection(&service, &connection_id)?;
    let library = library_dir(&service, &connection_id)?;
    let (url, expected_id, source) = resolve_import_url(&raw)?;
    if let Some(store_id) = expected_id.as_deref() {
        refuse_duplicate(
            &service,
            &connection_id,
            Some(&ExtensionSource::Webstore {
                id: store_id.to_owned(),
            }),
            Some(store_id),
            separate,
        )?;
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let operation = begin_update(&connection_id, &id)?;
    let staging = library.join(".staging").join(&id);
    let staging_cleanup = CleanupPath(staging.clone());
    let package = staging.join("package");
    let tree = staging.join("tree");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir(&staging).map_err(storage)?;
    download_file(&app, &connection_id, &id, url, &package, &operation.cancel).await?;
    set_progress(&app, &connection_id, &id, UpdatePhase::Verify, 0, 0);
    let bytes = fs::read(&package).map_err(storage)?;
    let verified = if bytes.starts_with(b"Cr24") {
        Some(
            verify_crx(
                &bytes,
                &CrxExpectation {
                    id: expected_id.as_deref(),
                    publisher: expected_id.is_some(),
                    sha256: None,
                    size: None,
                },
            )
            .map_err(|error| invalid(format!("CRX3 校验失败：{error:#}")))?,
        )
    } else if expected_id.is_some() {
        return Err(invalid("Chrome Web Store 没有返回 CRX3 扩展包"));
    } else {
        None
    };
    fs::create_dir(&tree).map_err(storage)?;
    set_progress(&app, &connection_id, &id, UpdatePhase::Unpack, 0, 0);
    let archive = verified
        .as_ref()
        .map(|verified| &bytes[verified.archive_offset..])
        .unwrap_or(bytes.as_slice());
    unzip_archive(archive, &tree).map_err(|error| invalid(format!("{error:#}")))?;
    let root = manifest_root(&tree)?;
    if let Some(verified) = &verified {
        set_manifest_key(&root, &verified.developer_key)
            .map_err(|error| invalid(format!("{error:#}")))?;
    }
    validate_live_root(&staging, &root)?;
    let key = manifest_key_id(&root);
    let _guard = library_launch_guard()?;
    refuse_duplicate(
        &service,
        &connection_id,
        Some(&source),
        key.as_deref(),
        separate,
    )?;
    let destination = library.join(&id);
    fs::rename(&tree, &destination).map_err(storage)?;
    let stored = StoredExtension {
        v: RECORD_VERSION,
        added_at: stamp(),
        source: Some(source),
    };
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    if let Err(error) = db.execute(
        "INSERT INTO shardbrowser_extensions(connection_id,id,record_json)
         VALUES(?1,?2,?3)",
        params![
            connection_id,
            id,
            serde_json::to_string(&stored).map_err(storage)?
        ],
    ) {
        let _ = fs::remove_dir_all(&destination);
        return Err(storage(error));
    }
    drop(staging_cleanup);
    drop(operation);
    emit_changed(&app, "extensions");
    read_live(&library, &id, stored).map(|live| live.entry)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Default)]
struct Access {
    apis: BTreeSet<String>,
    hosts: BTreeSet<String>,
    scripts: BTreeSet<String>,
    main_world: BTreeSet<String>,
    connectable: BTreeSet<String>,
    resources: BTreeSet<String>,
}

impl Access {
    fn from_manifest(manifest: &Value) -> Self {
        let mut access = Self::default();
        for permission in strings(manifest.get("permissions")) {
            if permission == "<all_urls>" || permission.contains("://") {
                access.hosts.insert(permission);
            } else {
                access.apis.insert(permission);
            }
        }
        access
            .hosts
            .extend(strings(manifest.get("host_permissions")));
        for script in manifest
            .get("content_scripts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let matches = strings(script.get("matches"));
            if script.get("world").and_then(Value::as_str) == Some("MAIN") {
                access.main_world.extend(matches.iter().cloned());
            }
            access.scripts.extend(matches);
        }
        let connectable = manifest.get("externally_connectable");
        access
            .connectable
            .extend(strings(connectable.and_then(|value| value.get("matches"))));
        access.connectable.extend(
            strings(connectable.and_then(|value| value.get("ids")))
                .into_iter()
                .map(|id| format!("extension:{id}")),
        );
        for resource in manifest
            .get("web_accessible_resources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if resource.is_string() {
                access.resources.insert("<all_urls>".into());
            } else {
                access.resources.extend(strings(resource.get("matches")));
            }
        }
        access
    }
}

fn access_covers(old: &str, new: &str) -> bool {
    match old {
        "<all_urls>" => !new.starts_with("extension:"),
        "*://*/*" => ["http://", "https://", "*://"]
            .iter()
            .any(|prefix| new.starts_with(prefix)),
        "https://*/*" => new.starts_with("https://"),
        "http://*/*" => new.starts_with("http://"),
        "extension:*" => new.starts_with("extension:"),
        _ => old == new,
    }
}

fn permission_growth(old: &Value, new: &Value) -> Vec<Grant> {
    const OVERRIDES: [&str; 8] = [
        "chrome_settings_overrides.search_provider",
        "chrome_settings_overrides.homepage",
        "chrome_settings_overrides.startup_pages",
        "chrome_url_overrides.newtab",
        "chrome_url_overrides.bookmarks",
        "chrome_url_overrides.history",
        "devtools_page",
        "omnibox",
    ];
    let old_access = Access::from_manifest(old);
    let new_access = Access::from_manifest(new);
    let mut output = BTreeSet::new();
    let mut add = |kind: GrantKind,
                   old_values: &BTreeSet<String>,
                   new_values: &BTreeSet<String>,
                   sites: bool| {
        for value in new_values.difference(old_values) {
            if !sites
                || !old_values
                    .iter()
                    .any(|old_value| access_covers(old_value, value))
            {
                output.insert(Grant {
                    kind: kind.clone(),
                    value: value.clone(),
                });
            }
        }
    };
    add(
        GrantKind::Permission,
        &old_access.apis,
        &new_access.apis,
        false,
    );
    add(GrantKind::Host, &old_access.hosts, &new_access.hosts, true);
    add(
        GrantKind::ScriptHost,
        &old_access.scripts,
        &new_access.scripts,
        true,
    );
    add(
        GrantKind::MainWorld,
        &old_access.main_world,
        &new_access.main_world,
        true,
    );
    add(
        GrantKind::Connectable,
        &old_access.connectable,
        &new_access.connectable,
        true,
    );
    add(
        GrantKind::WebResource,
        &old_access.resources,
        &new_access.resources,
        true,
    );
    let manifest_version = |manifest: &Value| {
        manifest
            .get("manifest_version")
            .map(Value::to_string)
            .unwrap_or_default()
    };
    if manifest_version(old) != manifest_version(new) {
        output.insert(Grant {
            kind: GrantKind::ManifestVersion,
            value: manifest_version(new),
        });
    }
    for key in OVERRIDES {
        let at = |manifest: &Value| {
            key.split('.')
                .try_fold(manifest, |value, part| value.get(part))
                .filter(|value| !value.is_null())
                .cloned()
        };
        let (old_value, new_value) = (at(old), at(new));
        let setting = key.starts_with("chrome_settings_overrides.");
        if new_value.is_some() && (old_value.is_none() || (setting && old_value != new_value)) {
            output.insert(Grant {
                kind: GrantKind::Override,
                value: key.to_owned(),
            });
        }
    }
    output.into_iter().collect()
}

fn file_overlap(old_root: &Path, new_root: &Path) -> Result<f64> {
    fn walk(root: &Path, relative: PathBuf, output: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(root.join(&relative))? {
            let entry = entry?;
            if is_os_litter(&entry.file_name()) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                bail!("extension trees cannot contain symbolic links");
            }
            let child = relative.join(entry.file_name());
            if kind.is_dir() {
                walk(root, child, output)?;
            } else if kind.is_file() {
                output.push(child);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(old_root, PathBuf::new(), &mut files)?;
    files.retain(|relative| {
        let top = relative
            .components()
            .next()
            .map(|component| component.as_os_str().to_string_lossy())
            .unwrap_or_default();
        relative.as_os_str() != "manifest.json"
            && relative.as_os_str() != ".added"
            && top != "_metadata"
    });
    if files.is_empty() {
        return Ok(0.0);
    }
    let digest = |path: &Path| fs::read(path).ok().map(Sha256::digest);
    let same = files
        .iter()
        .filter(|relative| {
            let candidate = new_root.join(relative);
            candidate.is_file()
                && digest(&candidate)
                    .is_some_and(|value| Some(value) == digest(&old_root.join(relative)))
        })
        .count();
    Ok(same as f64 / files.len() as f64)
}

struct StoreUpdatePackage<'a> {
    path: &'a Path,
    store_id: &'a str,
    version: &'a str,
    sha256: Option<&'a str>,
    size: Option<u64>,
}

fn stage_update(
    app: &AppHandle,
    service: &WindowService,
    connection_id: &str,
    id: &str,
    package: &StoreUpdatePackage<'_>,
) -> BrowserResult<StagedUpdate> {
    let library = library_dir(service, connection_id)?;
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    let stored = stored_extension(&db, connection_id, id)?;
    let live = read_live(&library, id, stored)?;
    let stage = library.join(".updates").join(id);
    let cleanup = CleanupPath(stage.clone());
    let next = stage.join("tree");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir(&stage).map_err(storage)?;
    let bytes = fs::read(package.path).map_err(storage)?;
    set_progress(
        app,
        connection_id,
        id,
        UpdatePhase::Verify,
        0,
        package.size.unwrap_or(0),
    );
    let verified = verify_crx(
        &bytes,
        &CrxExpectation {
            id: Some(package.store_id),
            publisher: true,
            sha256: package.sha256,
            size: package.size,
        },
    )
    .map_err(|error| invalid(format!("扩展更新包校验失败：{error:#}")))?;
    if verified.crx_id != package.store_id || !verified.proof_keys.contains(&PUBLISHER_KEY_HASH) {
        return Err(invalid("扩展更新包身份校验失败"));
    }
    fs::create_dir(&next).map_err(storage)?;
    set_progress(
        app,
        connection_id,
        id,
        UpdatePhase::Unpack,
        0,
        package.size.unwrap_or(0),
    );
    unzip_archive(&bytes[verified.archive_offset..], &next)
        .map_err(|error| invalid(format!("{error:#}")))?;
    let next_root = manifest_root(&next)?;
    set_manifest_key(&next_root, &verified.developer_key)
        .map_err(|error| invalid(format!("{error:#}")))?;
    validate_live_root(&stage, &next_root)?;
    let next_manifest = read_manifest(&next_root).map_err(|error| invalid(format!("{error:#}")))?;
    let next_version = next_manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if next_version != package.version || !newer(next_version, &live.entry.version) {
        return Err(invalid("扩展更新包版本与 Web Store 更新记录不一致"));
    }
    let grown = permission_growth(&live.manifest, &next_manifest);
    let overlap = file_overlap(&live.root, &next_root).map_err(storage)?;
    let old_name = live.entry.name;
    let next_messages = locale_messages(&next_root, &next_manifest);
    let new_name = resolve_message(
        next_manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        &next_messages,
    );
    let same_name = old_name.eq_ignore_ascii_case(&new_name);
    let names = if overlap >= 0.5 || (same_name && overlap >= 0.1) {
        None
    } else if overlap < 0.05 {
        return Err(invalid("Web Store 更新包与已安装扩展不是同一扩展"));
    } else {
        Some(Names {
            old: old_name,
            new: new_name,
        })
    };
    let needs_engine = next_manifest
        .get("minimum_chrome_version")
        .and_then(Value::as_str)
        .filter(|minimum| newer(minimum, shardx::CHROMIUM_VERSION))
        .map(str::to_owned);
    let staged = StagedUpdate {
        from: live.entry.version,
        to: package.version.to_owned(),
        at: now(),
        approved: grown.is_empty() && names.is_none() && needs_engine.is_none(),
        grown,
        names,
        overlap: Some(overlap),
        needs_engine,
    };
    std::mem::forget(cleanup);
    Ok(staged)
}

fn apply_staged_update(
    app: &AppHandle,
    service: &WindowService,
    connection_id: &str,
    id: &str,
) -> BrowserResult<UpdateDone> {
    let library = library_dir(service, connection_id)?;
    {
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        let staged = update_record(&db, connection_id, id)?
            .staged
            .ok_or_else(|| invalid("扩展没有待应用的更新"))?;
        if let Some(version) = staged.needs_engine {
            return Ok(UpdateDone::NeedsEngine { version });
        }
        if !staged.approved {
            return Ok(UpdateDone::Confirm {
                update: Box::new(update_view(service, connection_id, &library, id)?),
            });
        }
    }
    let connection = connection(service, connection_id)?;
    service.shard.with_extension_library_lock(|| {
        let holders = extension_holders_locked(service, &connection, connection_id, id)?;
        if !holders.is_empty() {
            return Ok(UpdateDone::Waiting {
                waiting_on: holders,
            });
        }
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        let mut record = update_record(&db, connection_id, id)?;
        let staged = record
            .staged
            .clone()
            .ok_or_else(|| invalid("扩展没有待应用的更新"))?;
        if !staged.approved || staged.needs_engine.is_some() {
            return Err(invalid("待应用扩展更新状态已发生变化"));
        }
        let next = staged_root(&library, id);
        let next_manifest_root = manifest_root(&next)?;
        validate_live_root(&library.join(".updates").join(id), &next_manifest_root)?;
        let live = library.join(id);
        let previous = library.join(format!(".{id}.previous-{}", uuid::Uuid::new_v4().simple()));
        set_progress(app, connection_id, id, UpdatePhase::Apply, 0, 0);
        fs::rename(&live, &previous).map_err(storage)?;
        if let Err(error) = fs::rename(&next, &live) {
            let _ = fs::rename(&previous, &live);
            return Err(storage(error));
        }
        record.latest = None;
        record.size = None;
        record.first_seen = None;
        record.error = None;
        record.codebase = None;
        record.sha256 = None;
        record.staged = None;
        if let Err(error) = save_update_record(&db, connection_id, id, &record) {
            let failed = library.join(format!(".{id}.failed-{}", uuid::Uuid::new_v4().simple()));
            let _ = fs::rename(&live, &failed);
            let _ = fs::rename(&previous, &live);
            let _ = fs::remove_dir_all(failed);
            return Err(error);
        }
        let _ = fs::remove_dir_all(previous);
        let _ = fs::remove_dir_all(library.join(".updates").join(id));
        emit_changed(app, "extensions");
        emit_changed(app, "extension-updates");
        Ok(UpdateDone::Applied {
            from: staged.from,
            to: staged.to,
        })
    })
}

async fn update_internal(
    app: AppHandle,
    service: Arc<WindowService>,
    connection_id: String,
    id: String,
    confirmed: bool,
) -> BrowserResult<UpdateDone> {
    connection(&service, &connection_id)?;
    if !valid_id(&id) {
        return Err(invalid("扩展标识无效"));
    }
    let operation = begin_update(&connection_id, &id)?;
    let library = library_dir(&service, &connection_id)?;
    let (store_id, live, mut record) = {
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        let stored = stored_extension(&db, &connection_id, &id)?;
        let ExtensionSource::Webstore { id: store_id } = stored
            .source
            .clone()
            .ok_or_else(|| BrowserError::new("unlinked", "扩展尚未链接 Chrome Web Store"))?
        else {
            return Err(BrowserError::new(
                "unlinked",
                "直接下载来源无法自动更新，请先链接 Chrome Web Store",
            ));
        };
        let live = read_live(&library, &id, stored)?;
        let record = update_record(&db, &connection_id, &id)?;
        (store_id, live, record)
    };
    if !record.flags.is_empty() {
        return Err(BrowserError::new(
            "permission_denied",
            "Chrome Web Store 已将此扩展标记为有害，更新已阻止",
        ));
    }
    if let Some(stage) = record.staged.as_mut() {
        if let Some(version) = stage.needs_engine.clone() {
            return Ok(UpdateDone::NeedsEngine { version });
        }
        if !stage.approved && confirmed {
            stage.approved = true;
            let db = open_database(&service.store.database_path()).map_err(storage)?;
            save_update_record(&db, &connection_id, &id, &record)?;
            return apply_staged_update(&app, &service, &connection_id, &id);
        }
        if !stage.approved {
            return Ok(UpdateDone::Confirm {
                update: Box::new(update_view(&service, &connection_id, &library, &id)?),
            });
        }
        return apply_staged_update(&app, &service, &connection_id, &id);
    }
    let answers = ask_store(&[(store_id.clone(), live.entry.version.clone())]).await?;
    let answer = store_answer_for(&answers, &store_id)?;
    let previously_available = record
        .latest
        .as_deref()
        .is_some_and(|latest| newer(latest, &live.entry.version));
    apply_store_answer(&mut record, answer, &live.entry.version, now());
    {
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        save_update_record(&db, &connection_id, &id, &record)?;
    }
    if !record.flags.is_empty() {
        return Err(BrowserError::new(
            "permission_denied",
            "Chrome Web Store 已将此扩展标记为有害，更新已阻止",
        ));
    }
    let (version, codebase, sha256, size) = match &answer.answer {
        StoreAnswer::Update {
            version,
            codebase,
            sha256,
            size,
        } if newer(version, &live.entry.version) => {
            (version.clone(), codebase.clone(), sha256.clone(), *size)
        }
        StoreAnswer::Update { .. } | StoreAnswer::NoUpdate => {
            return Ok(if previously_available {
                UpdateDone::NotServed
            } else {
                UpdateDone::Current
            });
        }
        StoreAnswer::Unknown(_) => {
            return Err(BrowserError::new(
                "not_found",
                "Chrome Web Store 中没有此扩展",
            ));
        }
        StoreAnswer::Error(error) => {
            return Err(BrowserError::new(
                "invalid_response",
                format!("Chrome Web Store 更新响应无法读取：{error}"),
            ));
        }
    };
    let package = library.join(".updates").join(format!(".{id}.part"));
    let package_cleanup = CleanupPath(package.clone());
    let url = url::Url::parse(&codebase).map_err(|_| invalid("Web Store 更新地址无效"))?;
    download_file(&app, &connection_id, &id, url, &package, &operation.cancel).await?;
    if operation.cancel.load(Ordering::SeqCst) {
        return Err(BrowserError::new("cancelled", CANCELLED));
    }
    let staged = stage_update(
        &app,
        &service,
        &connection_id,
        &id,
        &StoreUpdatePackage {
            path: &package,
            store_id: &store_id,
            version: &version,
            sha256: sha256.as_deref(),
            size,
        },
    )?;
    if operation.cancel.load(Ordering::SeqCst) {
        let _ = fs::remove_dir_all(library.join(".updates").join(&id));
        return Err(BrowserError::new("cancelled", CANCELLED));
    }
    drop(package_cleanup);
    record.staged = Some(staged.clone());
    {
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        save_update_record(&db, &connection_id, &id, &record)?;
    }
    if let Some(version) = staged.needs_engine {
        return Ok(UpdateDone::NeedsEngine { version });
    }
    if !staged.approved {
        return Ok(UpdateDone::Confirm {
            update: Box::new(update_view(&service, &connection_id, &library, &id)?),
        });
    }
    apply_staged_update(&app, &service, &connection_id, &id)
}

async fn link_source_internal(
    app: AppHandle,
    service: Arc<WindowService>,
    connection_id: String,
    id: String,
    raw: String,
    confirmed: bool,
) -> BrowserResult<LinkDone> {
    connection(&service, &connection_id)?;
    let store_id =
        store_id(&raw).ok_or_else(|| invalid("链接来源必须是 Chrome Web Store 页面或扩展 ID"))?;
    let operation = begin_update(&connection_id, &id)?;
    let library = library_dir(&service, &connection_id)?;
    let mut stored = {
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        stored_extension(&db, &connection_id, &id)?
    };
    let live = read_live(&library, &id, stored.clone())?;
    match &stored.source {
        Some(ExtensionSource::Webstore { id: current }) if current == &store_id => {
            let db = open_database(&service.store.database_path()).map_err(storage)?;
            return Ok(LinkDone::Linked {
                source: ExtensionSource::Webstore { id: store_id },
                allowlisted: update_record(&db, &connection_id, &id)?.allowlisted,
                update: Some(Box::new(update_view(
                    &service,
                    &connection_id,
                    &library,
                    &id,
                )?)),
            });
        }
        Some(ExtensionSource::Webstore { id: current }) => {
            return Err(invalid(format!(
                "扩展已链接到另一个 Web Store 项目 {current}"
            )));
        }
        _ => {}
    }
    if let Some(key_id) = manifest_key_id(&live.root) {
        if key_id != store_id {
            return Err(invalid(format!(
                "扩展 manifest key 对应 {key_id}，与所选 Web Store 项目不同"
            )));
        }
        stored.source = Some(ExtensionSource::Webstore {
            id: store_id.clone(),
        });
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        db.execute(
            "UPDATE shardbrowser_extensions SET record_json=?3
             WHERE connection_id=?1 AND id=?2",
            params![
                connection_id,
                id,
                serde_json::to_string(&stored).map_err(storage)?
            ],
        )
        .map_err(storage)?;
        emit_changed(&app, "extensions");
        return Ok(LinkDone::Linked {
            source: ExtensionSource::Webstore { id: store_id },
            allowlisted: None,
            update: Some(Box::new(update_view(
                &service,
                &connection_id,
                &library,
                &id,
            )?)),
        });
    }
    let answers = ask_store(&[(store_id.clone(), ANY_VERSION.into())]).await?;
    let answer = store_answer_for(&answers, &store_id)?;
    let (version, codebase, sha256, size) = match &answer.answer {
        StoreAnswer::Update {
            version,
            codebase,
            sha256,
            size,
        } => (version.clone(), codebase.clone(), sha256.clone(), *size),
        StoreAnswer::Unknown(_) => {
            return Err(BrowserError::new(
                "not_found",
                "Chrome Web Store 中没有此扩展",
            ));
        }
        StoreAnswer::NoUpdate => {
            return Err(BrowserError::new(
                "unavailable",
                "Chrome Web Store 当前没有提供可用于比对的扩展包",
            ));
        }
        StoreAnswer::Error(error) => {
            return Err(BrowserError::new("invalid_response", error.clone()));
        }
    };
    let package = library.join(".updates").join(format!(".{id}.link.part"));
    let package_cleanup = CleanupPath(package.clone());
    download_file(
        &app,
        &connection_id,
        &id,
        url::Url::parse(&codebase).map_err(|_| invalid("Web Store 更新地址无效"))?,
        &package,
        &operation.cancel,
    )
    .await?;
    if operation.cancel.load(Ordering::SeqCst) {
        return Err(BrowserError::new("cancelled", CANCELLED));
    }
    let bytes = fs::read(&package).map_err(storage)?;
    let verified = verify_crx(
        &bytes,
        &CrxExpectation {
            id: Some(&store_id),
            publisher: true,
            sha256: sha256.as_deref(),
            size,
        },
    )
    .map_err(|error| invalid(format!("Web Store 扩展包校验失败：{error:#}")))?;
    let compare = library.join(".updates").join(format!(".{id}.compare"));
    let compare_cleanup = CleanupPath(compare.clone());
    let _ = fs::remove_dir_all(&compare);
    fs::create_dir(&compare).map_err(storage)?;
    unzip_archive(&bytes[verified.archive_offset..], &compare)
        .map_err(|error| invalid(format!("{error:#}")))?;
    if operation.cancel.load(Ordering::SeqCst) {
        return Err(BrowserError::new("cancelled", CANCELLED));
    }
    let compare_root = manifest_root(&compare)?;
    set_manifest_key(&compare_root, &verified.developer_key)
        .map_err(|error| invalid(format!("{error:#}")))?;
    let compare_manifest =
        read_manifest(&compare_root).map_err(|error| invalid(format!("{error:#}")))?;
    let overlap = file_overlap(&live.root, &compare_root).map_err(storage)?;
    let messages = locale_messages(&compare_root, &compare_manifest);
    let store_name = resolve_message(
        compare_manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        &messages,
    );
    let same_name = live.entry.name.eq_ignore_ascii_case(&store_name);
    let kin = if overlap >= 0.5 || (same_name && overlap >= 0.1) {
        Kinship::Same
    } else if overlap >= 0.05 {
        Kinship::Unsure
    } else {
        return Err(invalid(format!(
            "比对结果显示不是同一扩展，只有 {}% 文件一致",
            (overlap * 100.0).round()
        )));
    };
    let names = Names {
        old: live.entry.name.clone(),
        new: store_name,
    };
    if !confirmed {
        return Ok(LinkDone::Confirm {
            names,
            installed: live.entry.version,
            store: version,
            overlap,
            kin,
            allowlisted: answer.allowlisted,
            flags: answer.flags.clone(),
        });
    }
    stored.source = Some(ExtensionSource::Webstore {
        id: store_id.clone(),
    });
    let db = open_database(&service.store.database_path()).map_err(storage)?;
    db.execute(
        "UPDATE shardbrowser_extensions SET record_json=?3
         WHERE connection_id=?1 AND id=?2",
        params![
            connection_id,
            id,
            serde_json::to_string(&stored).map_err(storage)?
        ],
    )
    .map_err(storage)?;
    let mut update = update_record(&db, &connection_id, &id)?;
    apply_store_answer(&mut update, answer, &live.entry.version, now());
    save_update_record(&db, &connection_id, &id, &update)?;
    drop(package_cleanup);
    drop(compare_cleanup);
    emit_changed(&app, "extensions");
    emit_changed(&app, "extension-updates");
    Ok(LinkDone::Linked {
        source: ExtensionSource::Webstore { id: store_id },
        allowlisted: answer.allowlisted,
        update: Some(Box::new(update_view(
            &service,
            &connection_id,
            &library,
            &id,
        )?)),
    })
}

#[tauri::command]
pub async fn shardbrowser_extension_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
) -> BrowserResult<Vec<ExtensionEntry>> {
    let connection_id = command_connection_id(connection_id)?;
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || list_internal(&state, &connection_id))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_extension_import(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    paths: Vec<String>,
    separate: Option<bool>,
) -> BrowserResult<Imported> {
    let connection_id = command_connection_id(connection_id)?;
    connection(&state, &connection_id)?;
    if paths.is_empty() || paths.len() > 64 {
        return Err(invalid("请选择 1 至 64 个扩展文件或一个解包目录"));
    }
    let state = Arc::clone(&state);
    let separate = separate.unwrap_or(false);
    let imported = tauri::async_runtime::spawn_blocking(move || {
        let mut imported = Imported::default();
        for path in paths {
            match install_from_path(&state, &connection_id, Path::new(&path), separate) {
                Ok(entry) => imported.added.push(entry),
                Err(error) => imported.refused.push(ImportRefused {
                    path,
                    error: error.message,
                }),
            }
        }
        imported
    })
    .await
    .map_err(interrupted)?;
    if !imported.added.is_empty() {
        emit_changed(&app, "extensions");
    }
    Ok(imported)
}

#[tauri::command]
pub async fn shardbrowser_extension_import_url(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    url: String,
    separate: Option<bool>,
) -> BrowserResult<ExtensionEntry> {
    let connection_id = command_connection_id(connection_id)?;
    import_url_internal(
        app,
        Arc::clone(&state),
        connection_id,
        url,
        separate.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn shardbrowser_extension_delete(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    id: String,
) -> BrowserResult<()> {
    let connection_id = command_connection_id(connection_id)?;
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || delete_internal(&state, &connection_id, &id))
        .await
        .map_err(interrupted)??;
    emit_changed(&app, "extensions");
    emit_changed(&app, "extension-updates");
    Ok(())
}

#[tauri::command]
pub async fn shardbrowser_extension_updates(
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
) -> BrowserResult<Vec<ExtensionUpdate>> {
    let connection_id = command_connection_id(connection_id)?;
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || updates_internal(&state, &connection_id))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_extension_updates_check(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
) -> BrowserResult<Vec<ExtensionUpdate>> {
    let connection_id = command_connection_id(connection_id)?;
    let (updates, news) = check_updates_internal(Arc::clone(&state), connection_id).await?;
    emit_changed(&app, "extension-updates");
    if !news.fresh.is_empty() || !news.flagged.is_empty() {
        let _ = app.emit("extension-updates:news", news);
    }
    Ok(updates)
}

#[tauri::command]
pub async fn shardbrowser_extension_update(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    id: String,
    confirmed: Option<bool>,
) -> BrowserResult<UpdateDone> {
    let connection_id = command_connection_id(connection_id)?;
    update_internal(
        app,
        Arc::clone(&state),
        connection_id,
        id,
        confirmed.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn shardbrowser_extension_link_source(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    id: String,
    link: String,
    confirmed: Option<bool>,
) -> BrowserResult<LinkDone> {
    let connection_id = command_connection_id(connection_id)?;
    link_source_internal(
        app,
        Arc::clone(&state),
        connection_id,
        id,
        link,
        confirmed.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn shardbrowser_extension_update_cancel(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    id: String,
) -> BrowserResult<()> {
    let connection_id = command_connection_id(connection_id)?;
    connection(&state, &connection_id)?;
    if !valid_id(&id) {
        return Err(invalid("扩展标识无效"));
    }
    let key = format!("{connection_id}:{id}");
    let signalled = update_registry()
        .lock()
        .map_err(|_| storage("扩展更新状态不可用"))?
        .get(&key)
        .map(|running| running.cancel.store(true, Ordering::SeqCst))
        .is_some();
    if !signalled {
        let library = library_dir(&state, &connection_id)?;
        let connection = connection(&state, &connection_id)?;
        state.shard.with_extension_library_lock(|| {
            let holders = extension_holders_locked(&state, &connection, &connection_id, &id)?;
            if !holders.is_empty() {
                return Err(BrowserError::new("profile_busy", LOAD_WAIT_MESSAGE));
            }
            let db = open_database(&state.store.database_path()).map_err(storage)?;
            let mut record = update_record(&db, &connection_id, &id)?;
            record.staged = None;
            save_update_record(&db, &connection_id, &id, &record)?;
            let _ = fs::remove_dir_all(library.join(".updates").join(&id));
            Ok(())
        })?;
    }
    emit_changed(&app, "extension-updates");
    Ok(())
}

#[tauri::command]
pub async fn shardbrowser_extension_update_skip(
    app: AppHandle,
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
    id: String,
    version: String,
) -> BrowserResult<()> {
    let connection_id = command_connection_id(connection_id)?;
    connection(&state, &connection_id)?;
    if !valid_id(&id) || Version::parse(&version).is_none() {
        return Err(invalid("扩展标识或跳过版本无效"));
    }
    if update_registry()
        .lock()
        .map_err(|_| storage("扩展更新状态不可用"))?
        .contains_key(&format!("{connection_id}:{id}"))
    {
        return Err(BrowserError::new("profile_busy", "扩展正在更新，请先取消"));
    }
    let library = library_dir(&state, &connection_id)?;
    let connection = connection(&state, &connection_id)?;
    state.shard.with_extension_library_lock(|| {
        let holders = extension_holders_locked(&state, &connection, &connection_id, &id)?;
        if !holders.is_empty() {
            return Err(BrowserError::new("profile_busy", LOAD_WAIT_MESSAGE));
        }
        let db = open_database(&state.store.database_path()).map_err(storage)?;
        let mut record = update_record(&db, &connection_id, &id)?;
        record.skipped = Some(version.clone());
        if record
            .staged
            .as_ref()
            .is_some_and(|staged| staged.to == version)
        {
            record.staged = None;
            let _ = fs::remove_dir_all(library.join(".updates").join(&id));
        }
        save_update_record(&db, &connection_id, &id, &record)
    })?;
    emit_changed(&app, "extension-updates");
    Ok(())
}
