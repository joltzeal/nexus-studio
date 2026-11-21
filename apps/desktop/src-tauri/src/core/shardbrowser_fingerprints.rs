// Entry wrapping and preset enrichment follow ProxyShard/ShardBrowser (MIT),
// src-tauri/src/fingerprints.rs and lib.rs at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
use crate::core::browser::connection_store::{BrowserConnection, ConnectionStore};
use crate::core::browser::provider::{
    BrowserError, BrowserProviderId, BrowserResult, SHARDBROWSER_CONNECTION_ID,
};
use crate::core::window_service::WindowService;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
static CUSTOM_WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
pub struct FingerprintEntry {
    pub id: String,
    pub label: String,
    pub platform: String,
    pub chrome: String,
    pub gpu: String,
    pub tag_color: String,
    pub builtin: bool,
    pub payload: Value,
}

fn invalid() -> BrowserError {
    BrowserError::new("invalid_config", "指纹 JSON 结构或文件标识无效")
}

fn storage() -> BrowserError {
    BrowserError::new("storage_failed", "无法读写本机指纹库")
}

fn interrupted(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("task_interrupted", "指纹库任务中断")
}

pub(crate) fn connection(service: &WindowService, id: &str) -> BrowserResult<BrowserConnection> {
    if id != SHARDBROWSER_CONNECTION_ID {
        return Err(BrowserError::new(
            "scope_mismatch",
            "指纹库需要 ShardBrowser 接入",
        ));
    }
    let connection = ConnectionStore::new(service.store.database_path())?.get(id)?;
    if connection.provider_id != BrowserProviderId::ShardBrowser || !connection.enabled {
        return Err(BrowserError::new("unavailable", "ShardBrowser 接入未启用"));
    }
    Ok(connection)
}

fn safe_id(id: &str) -> BrowserResult<()> {
    let first = id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric);
    let device = id.split('.').next().unwrap_or("").to_ascii_uppercase();
    if !first
        || id.len() > 96
        || id.contains("..")
        || id.ends_with('.')
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && device.as_bytes()[3].is_ascii_digit())
    {
        return Err(invalid());
    }
    Ok(())
}

fn custom_dir(service: &WindowService, connection_id: &str) -> BrowserResult<PathBuf> {
    connection(service, connection_id)?;
    let root = service
        .store
        .root()
        .parent()
        .ok_or_else(storage)?
        .join("shardbrowser-fingerprints");
    let dir = root.join(connection_id);
    for path in [&root, &dir] {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err(storage()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::create_dir(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(storage()),
                }
                let metadata = fs::symlink_metadata(path).map_err(|_| storage())?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(storage());
                }
            }
            Err(_) => return Err(storage()),
        }
    }
    Ok(dir)
}

fn entry(id: String, payload: Value, builtin: bool) -> FingerprintEntry {
    let string = |path: &str| {
        payload
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let platform = string("/navigator/platform");
    let tag_color = match platform.as_str() {
        "macOS" => "#8b5cf6",
        "Windows" => "#5dade2",
        "Linux" => "#4ade80",
        p if p.starts_with("Android") || p.starts_with("Linux arm") => "#fb923c",
        _ => "#a78bfa",
    }
    .to_owned();
    FingerprintEntry {
        label: payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned(),
        chrome: string("/client_hints/brand_version"),
        gpu: string("/webgl/renderer"),
        id,
        platform,
        tag_color,
        builtin,
        payload,
    }
}

fn decoded_entry(id: String, mut value: Value, builtin: bool) -> BrowserResult<FingerprintEntry> {
    let wrapper =
        (value.get("id").is_some() && value.get("payload").is_some()).then(|| value.clone());
    if wrapper.is_some() {
        value = value["payload"].take();
    }
    shardx::validate_fingerprint_config(&value).map_err(|_| invalid())?;
    let mut result = entry(id, value, builtin);
    if let Some(wrapper) = wrapper {
        for (key, target) in [
            ("label", &mut result.label),
            ("platform", &mut result.platform),
            ("chrome", &mut result.chrome),
            ("gpu", &mut result.gpu),
            ("tag_color", &mut result.tag_color),
        ] {
            if let Some(text) = wrapper.get(key).and_then(Value::as_str) {
                *target = text.to_owned();
            }
        }
    }
    Ok(result)
}

fn read_directory(
    dir: &Path,
    builtin: bool,
    entries: &mut BTreeMap<String, FingerprintEntry>,
) -> BrowserResult<()> {
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(storage()),
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(storage());
    }
    for item in fs::read_dir(dir).map_err(|_| storage())? {
        let item = item.map_err(|_| storage())?;
        let path = item.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|s| s.to_str()) != Some("json") || safe_id(id).is_err() {
            continue;
        }
        let meta = item.metadata().map_err(|_| storage())?;
        if !item.file_type().map_err(|_| storage())?.is_file() || meta.len() > MAX_CONFIG_BYTES {
            continue;
        }
        let Ok(body) = fs::read(&path) else { continue };
        let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
            continue;
        };
        let Ok(entry) = decoded_entry(id.to_owned(), payload, builtin) else {
            continue;
        };
        entries.entry(id.to_owned()).or_insert(entry);
    }
    Ok(())
}

pub(crate) fn list(
    service: &WindowService,
    connection_id: &str,
) -> BrowserResult<Vec<FingerprintEntry>> {
    connection(service, connection_id)?;
    let mut entries = BTreeMap::new();
    // Pinned runtimes only. Calling SDK list_profiles would install resources.
    for installed in service.shard.kernels.installed().map_err(|_| storage())? {
        let sdk = service
            .shard
            .kernels
            .pinned(&installed.version)
            .map_err(|_| storage())?;
        read_directory(&sdk.runtime.fingerprints_dir(), true, &mut entries)?;
    }
    read_directory(&custom_dir(service, connection_id)?, false, &mut entries)?;
    let mut entries: Vec<_> = entries.into_values().collect();
    entries.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
    Ok(entries)
}

fn import(
    service: &WindowService,
    connection_id: &str,
    json_text: &str,
    id_hint: Option<String>,
) -> BrowserResult<FingerprintEntry> {
    connection(service, connection_id)?;
    if json_text.len() as u64 > MAX_CONFIG_BYTES {
        return Err(invalid());
    }
    let payload: Value = serde_json::from_str(json_text).map_err(|_| invalid())?;
    decoded_entry("import".into(), payload.clone(), false)?;
    let hint = id_hint.filter(|id| !id.trim().is_empty());
    let base = match hint {
        Some(id) => {
            safe_id(&id)?;
            id
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    let _guard = CUSTOM_WRITES.lock().map_err(|_| storage())?;
    let entries = list(service, connection_id)?;
    let id = if entries.iter().any(|item| item.id == base) {
        format!("{}-{}", &base[..base.len().min(48)], uuid::Uuid::new_v4())
    } else {
        base
    };
    safe_id(&id)?;
    let dir = custom_dir(service, connection_id)?;
    let path = dir.join(format!("{id}.json"));
    let temporary = dir.join(format!(".import-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| storage())?;
        file.write_all(&serde_json::to_vec(&payload).map_err(|_| invalid())?)
            .map_err(|_| storage())?;
        file.sync_all().map_err(|_| storage())?;
        // Atomic publication without replacing another writer's file.
        fs::hard_link(&temporary, &path).map_err(|_| storage())?;
        sync_directory(&dir)
    })();
    let _ = fs::remove_file(&temporary);
    result?;
    decoded_entry(id, payload, false)
}

fn sync_directory(path: &Path) -> BrowserResult<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| storage())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn delete(service: &WindowService, connection_id: &str, preset_id: &str) -> BrowserResult<()> {
    safe_id(preset_id)?;
    let _guard = CUSTOM_WRITES.lock().map_err(|_| storage())?;
    let entries = list(service, connection_id)?;
    let item = entries
        .iter()
        .find(|item| item.id == preset_id)
        .ok_or_else(|| BrowserError::new("not_found", "指纹不存在"))?;
    if item.builtin {
        return Err(BrowserError::unsupported("内核自带指纹不能删除"));
    }
    let dir = custom_dir(service, connection_id)?;
    let path = dir.join(format!("{preset_id}.json"));
    let meta = fs::symlink_metadata(&path).map_err(|_| storage())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(storage());
    }
    fs::remove_file(path).map_err(|_| storage())?;
    sync_directory(&dir)
}

#[tauri::command]
pub async fn shardbrowser_fingerprint_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<Vec<FingerprintEntry>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || list(&state, &connection_id))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_fingerprint_import(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    json_text: String,
    id_hint: Option<String>,
) -> BrowserResult<FingerprintEntry> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        import(&state, &connection_id, &json_text, id_hint)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_fingerprint_delete(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    preset_id: String,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || delete(&state, &connection_id, &preset_id))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_fingerprint_dir(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        custom_dir(&state, &connection_id).map(|dir| dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_fingerprint_reveal(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let directory = custom_dir(&state, &connection_id)?;
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/open")
            .arg("--")
            .arg(&directory)
            .status();
        #[cfg(target_os = "windows")]
        let status = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe")
                .arg(&directory)
                .creation_flags(0x0800_0000)
                .status()
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let status = std::process::Command::new("xdg-open")
            .arg(&directory)
            .status();
        status
            .map_err(|_| storage())?
            .success()
            .then_some(())
            .ok_or_else(storage)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_fingerprint_enrich_picks(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    preset_id: String,
) -> BrowserResult<Value> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        safe_id(&preset_id)?;
        let selected = list(&state, &connection_id)?
            .into_iter()
            .find(|item| item.id == preset_id)
            .ok_or_else(|| BrowserError::new("not_found", "指纹不存在"))?;
        let mut payload = selected.payload;
        shardx::randomize_platform_version(&mut payload);
        shardx::randomize_hardware(&mut payload, Some(&preset_id));
        let nav = &payload["navigator"];
        let mut picks = serde_json::Map::new();
        for key in ["hardware_concurrency", "device_memory", "platform_version"] {
            if let Some(value) = nav.get(key).filter(|value| !value.is_null()) {
                picks.insert(key.to_owned(), value.clone());
            }
        }
        Ok(Value::Object(picks))
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_profile_config(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    id: String,
) -> BrowserResult<Value> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let connection = connection(&state, &connection_id)?;
        let record = state
            .store
            .get(&id)
            .map_err(|_| BrowserError::new("not_found", "Profile 不存在"))?;
        if record.binding.connection_id != connection_id
            || record.binding.provider_id != BrowserProviderId::ShardBrowser
        {
            return Err(BrowserError::new("scope_mismatch", "Profile 不属于此接入"));
        }
        state
            .shard
            .editable_profile(&connection, &record)
            .map(|profile| profile.config)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
pub async fn shardbrowser_host_hardware(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<Value> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        connection(&state, &connection_id)?;
        let os = if cfg!(target_os = "macos") { "macOS" } else if cfg!(target_os = "windows") { "Windows" } else { "Linux" };
        Ok(json!({ "os": os, "cores": shardx::host_logical_cores(), "memory_gb": shardx::host_ram_bucket_gb() }))
    }).await.map_err(interrupted)?
}

#[tauri::command]
pub fn shardbrowser_host_screen(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    window: tauri::WebviewWindow,
) -> BrowserResult<Option<(i64, i64, f64)>> {
    connection(&state, &connection_id)?;
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    Ok(monitor.and_then(|monitor| {
        let scale = monitor.scale_factor();
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        let size = monitor.size();
        let width = (f64::from(size.width) / scale).round() as i64;
        let height = (f64::from(size.height) / scale).round() as i64;
        (width > 0 && height > 0).then_some((width, height, scale))
    }))
}
