use super::group_store::GroupStore;
use super::license_service::LicenseService;
use super::license_store::LicenseStore;
use super::plugin_host::discovery::development_roots;
use super::plugin_host::manifest::Capability;
use super::plugin_host::{HostError, MarketStatusView, PluginHost, PluginView};
use super::runtime_paths::RuntimePaths;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, State};

fn message(error: HostError) -> String {
    error.message()
}

fn capability(value: &str) -> Result<Capability, String> {
    Capability::parse(value).ok_or_else(|| "未知的能力标识".to_string())
}

#[tauri::command]
pub fn plugin_catalog(state: State<'_, Arc<PluginHost>>) -> Result<Vec<PluginView>, String> {
    state.catalog().map_err(message)
}

#[tauri::command]
pub fn plugin_proxy_providers(
    state: State<'_, Arc<PluginHost>>,
) -> Result<Vec<PluginView>, String> {
    state.proxy_providers().map_err(message)
}

#[tauri::command]
pub async fn plugin_install(
    state: State<'_, Arc<PluginHost>>,
    source: String,
) -> Result<PluginView, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.install(&PathBuf::from(source)).map_err(message)
    })
    .await
    .map_err(|_| "插件安装任务中断".to_string())?
}

#[tauri::command]
pub async fn plugin_uninstall(state: State<'_, Arc<PluginHost>>, id: String) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.uninstall(&id).map_err(message))
        .await
        .map_err(|_| "插件卸载任务中断".to_string())?
}

#[tauri::command]
pub fn plugin_market_status(state: State<'_, Arc<PluginHost>>) -> Result<MarketStatusView, String> {
    state.market_status().map_err(message)
}

#[tauri::command]
pub async fn plugin_market_set_store(
    state: State<'_, Arc<PluginHost>>,
    url: Option<String>,
) -> Result<MarketStatusView, String> {
    let state = Arc::clone(&state);
    // The fetch blocks, so it runs off the main thread; the page keeps painting
    // while a slow store is being reached.
    tauri::async_runtime::spawn_blocking(move || state.set_store_url(url).map_err(message))
        .await
        .map_err(|_| "插件商店设置中断".to_string())?
}

#[tauri::command]
pub async fn plugin_market_refresh(
    state: State<'_, Arc<PluginHost>>,
) -> Result<MarketStatusView, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.refresh_market().map_err(message))
        .await
        .map_err(|_| "插件商店检查中断".to_string())?
}

#[tauri::command]
pub async fn plugin_market_install(
    state: State<'_, Arc<PluginHost>>,
    id: String,
) -> Result<PluginView, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.install_from_market(&id).map_err(message))
        .await
        .map_err(|_| "插件下载任务中断".to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallInput {
    pub id: String,
    pub capability: String,
    pub method: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

#[tauri::command]
pub async fn plugin_call(
    state: State<'_, Arc<PluginHost>>,
    input: CallInput,
) -> Result<Value, String> {
    let capability = capability(&input.capability)?;
    let deadline = Duration::from_millis(input.deadline_ms.unwrap_or(30_000).clamp(1_000, 120_000));
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .call(
                &input.id,
                capability,
                &input.method,
                input.payload,
                deadline,
            )
            .map_err(message)
    })
    .await
    .map_err(|_| "插件调用任务中断".to_string())?
}

/// Creates the host and the profile service, sharing one plugin host so window
/// launches are gated by the same process that the plugin page talks to.
pub fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data = app.path().app_data_dir()?;
    let runtime = RuntimePaths::for_app(app).map_err(std::io::Error::other)?;
    let root = app_data.join("plugins");
    let host = Arc::new(
        PluginHost::open_with_node(
            root,
            // A released build installs everything from the plugin store, so
            // there is nothing to discover next to the binary.
            if cfg!(debug_assertions) {
                development_roots()
            } else {
                Vec::new()
            },
            runtime.node.clone(),
        )
        .map_err(|error| std::io::Error::other(error.message()))?,
    );
    app.manage(Arc::clone(&host));
    // Plugins installed in an earlier session start on their own; the
    // supervisor owns restarts, so the app never asks the user to fix a process.
    host.supervise();
    // The store is polled in the background so a new plugin version shows up
    // without the user opening the plugin page.
    host.watch_market();
    let license_store =
        LicenseStore::new(app_data.join("nexus.sqlite")).map_err(std::io::Error::other)?;
    let groups = GroupStore::new(app_data.join("nexus.sqlite")).map_err(std::io::Error::other)?;
    app.manage(groups);
    let license_service = LicenseService::with_runtime(
        license_store.clone(),
        license_store.browser_cache_dir(),
        runtime.clone(),
    );
    let profiles = super::profile_service::ProfileService::with_runtime(
        app_data.join("profiles"),
        Some(Arc::clone(&host)),
        license_store,
        runtime,
    )
    .map_err(std::io::Error::other)?;
    app.manage(Arc::new(profiles));
    app.manage(Arc::new(license_service));
    Ok(())
}
