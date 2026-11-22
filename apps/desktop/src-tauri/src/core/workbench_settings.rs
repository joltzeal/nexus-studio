use super::database::open_database;
use super::workspace_paths::{database_path, workspace_root};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDefaults {
    pub timezone: String,
    pub language: String,
    pub webrtc: String,
    pub do_not_track: bool,
    pub maximized: bool,
}

impl Default for ProfileDefaults {
    fn default() -> Self {
        Self {
            timezone: "auto".into(),
            language: "auto".into(),
            webrtc: "auto".into(),
            do_not_track: false,
            maximized: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbenchSettings {
    pub language: String,
    pub start_minimized: bool,
    pub close_behavior: String,
    pub profile_defaults: ProfileDefaults,
}

impl Default for WorkbenchSettings {
    fn default() -> Self {
        Self {
            language: "zh".into(),
            start_minimized: false,
            close_behavior: "exit".into(),
            profile_defaults: ProfileDefaults::default(),
        }
    }
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| workspace_root(&path))
        .map_err(|_| "无法读取工作台目录".into())
}

fn connect(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db = open_database(&database_path(&root(app)?))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS workbench_settings(id INTEGER PRIMARY KEY CHECK(id=1),record_json TEXT NOT NULL)")
        .map_err(|_| "无法初始化工作台设置")?;
    Ok(db)
}

fn validate(value: &WorkbenchSettings) -> Result<(), String> {
    let defaults = &value.profile_defaults;
    if !["zh", "en", "ru"].contains(&value.language.as_str())
        || !["exit", "minimize"].contains(&value.close_behavior.as_str())
        || !["auto", "tcp_only", "block"].contains(&defaults.webrtc.as_str())
        || defaults.timezone.is_empty()
        || defaults.timezone.len() > 80
        || !defaults
            .timezone
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
        || defaults.language.is_empty()
        || defaults.language.len() > 35
        || !defaults
            .language
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("工作台设置格式无效".into());
    }
    Ok(())
}

#[tauri::command]
pub fn workbench_settings_get(app: tauri::AppHandle) -> Result<WorkbenchSettings, String> {
    let text: Option<String> = connect(&app)?
        .query_row(
            "SELECT record_json FROM workbench_settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "无法读取工作台设置")?;
    let value = text
        .map(|text| serde_json::from_str(&text).map_err(|_| "工作台设置已损坏".to_string()))
        .transpose()?
        .unwrap_or_default();
    validate(&value)?;
    Ok(value)
}

#[tauri::command]
pub fn workbench_settings_set(
    app: tauri::AppHandle,
    value: WorkbenchSettings,
) -> Result<WorkbenchSettings, String> {
    validate(&value)?;
    let text = serde_json::to_string(&value).map_err(|_| "无法编码工作台设置")?;
    connect(&app)?.execute("INSERT INTO workbench_settings(id,record_json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json", params![text])
        .map_err(|_| "无法保存工作台设置")?;
    Ok(value)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchInfo {
    version: String,
    platform: String,
    debug: bool,
    data_path: PathBuf,
    database_bytes: u64,
    profiles: u64,
    folders: u64,
    proxies: u64,
}

#[tauri::command]
pub fn workbench_info(app: tauri::AppHandle) -> Result<WorkbenchInfo, String> {
    let data_path = root(&app)?;
    let db = connect(&app)?;
    let (profiles, folders, proxies): (i64, i64, i64) = db.query_row(
        "SELECT (SELECT COUNT(*) FROM profile_records),(SELECT COUNT(*) FROM groups),(SELECT COUNT(*) FROM browser_proxy_library)",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "无法读取工作台统计")?;
    let database_bytes = std::fs::metadata(database_path(&data_path))
        .map_err(|_| "无法读取数据库文件信息")?
        .len();
    Ok(WorkbenchInfo {
        version: app.package_info().version.to_string(),
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
        debug: cfg!(debug_assertions),
        data_path,
        database_bytes,
        profiles: u64::try_from(profiles).map_err(|_| "工作台统计无效")?,
        folders: u64::try_from(folders).map_err(|_| "工作台统计无效")?,
        proxies: u64::try_from(proxies).map_err(|_| "工作台统计无效")?,
    })
}

#[tauri::command]
pub async fn workbench_storage_reveal(app: tauri::AppHandle) -> Result<(), String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer.exe");
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let mut command = std::process::Command::new("xdg-open");
        command
            .arg(root)
            .status()
            .map_err(|_| "无法打开数据目录".to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "无法打开数据目录".to_string())
    })
    .await
    .map_err(|_| "打开目录任务中断".to_string())?
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Err(error) = initialize_tray(app) {
        eprintln!("无法创建系统托盘：{error}");
    }

    // Keep the UI available to report an unreadable preference record.
    let Ok(settings) = workbench_settings_get(app.clone()) else {
        return Ok(());
    };
    if settings.start_minimized
        && let Some(window) = app.get_webview_window("main")
    {
        window.minimize().map_err(|_| "无法最小化应用窗口")?;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
const TRAY_ID: &str = "raccoon-main-tray";

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn initialize_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    const OPEN_MAIN: &str = "raccoon-tray-open-main";
    let icon = app.default_window_icon().ok_or("应用图标不可用")?;
    let open = MenuItem::with_id(app, OPEN_MAIN, "打开主窗口", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&open]).map_err(|error| error.to_string())?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .tooltip(&app.package_info().name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == OPEN_MAIN {
                show_main_window(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        api.prevent_close();
        #[cfg(target_os = "windows")]
        if window.app_handle().tray_by_id(TRAY_ID).is_none() {
            return;
        }
        if let Err(error) = window.hide() {
            eprintln!("无法隐藏应用窗口：{error}");
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    if workbench_settings_get(window.app_handle().clone())
        .is_ok_and(|settings| settings.close_behavior == "minimize")
        && window.minimize().is_ok()
    {
        api.prevent_close();
    }
}
