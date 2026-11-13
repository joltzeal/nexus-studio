use super::group_store::GroupStore;
use super::license_service::LicenseService;
use super::license_store::LicenseStore;
use super::network_proxy::NetworkProxyStore;
use super::plugin_host::discovery::development_roots;
use super::plugin_host::manifest::Capability;
use super::plugin_host::process::PluginErrorPayload;
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

fn call_failure(error: HostError) -> PluginErrorPayload {
    PluginErrorPayload::new(error.code(), &error.message(), error.retryable())
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
) -> Result<Value, PluginErrorPayload> {
    let capability = webview_capability(&input)
        .map_err(|message| PluginErrorPayload::new("PERMISSION_DENIED", &message, false))?;
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
            .map_err(call_failure)
    })
    .await
    .map_err(|_| PluginErrorPayload::new("UNAVAILABLE", "插件调用任务中断", true))?
}

fn webview_capability(input: &CallInput) -> Result<Capability, String> {
    let capability = capability(&input.capability)?;
    if input.method == "window.detach" {
        return Err("窗口关联清理仅供原生窗口删除流程调用".into());
    }
    if matches!(
        input.method.as_str(),
        "salesAgent.jobs.step"
            | "salesAgent.notifications.send"
            | "products.publications.record"
            | "vinted.accounts.observations.record"
    ) {
        return Err("Agent execution and confirmed observations/publications require the native scoped gateway".into());
    }
    if capability == Capability::SalesAgent
        && !matches!(
            input.method.as_str(),
            "salesAgent.settings.get"
                | "salesAgent.settings.save"
                | "salesAgent.models.test"
                | "configuration.export"
                | "configuration.validate"
                | "configuration.import"
        )
    {
        return Err("Ecom Agent method is not available through the WebView".into());
    }
    if capability == Capability::ProxyProvider && input.method == "proxy.resolve" {
        return Err("代理连接解析仅供原生窗口启动调用".into());
    }
    let configuration = matches!(
        input.method.as_str(),
        "configuration.export" | "configuration.validate" | "configuration.import"
    );
    if input.method.starts_with("transfer.")
        || (capability == Capability::WindowSync && !configuration)
    {
        return Err("窗口迁移与同步只能通过窗口管理调用".into());
    }
    Ok(capability)
}

/// Creates the host and the window service, sharing one plugin host so window
/// launches are gated by the same process that the plugin page talks to.
pub fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data)?;
    let instance_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(app_data.join("workspace.lock"))?;
    instance_lock
        .try_lock()
        .map_err(|_| std::io::Error::other("此工作区已在另一个 Raccoon 实例中打开"))?;
    app.manage(WorkspaceLock(instance_lock));
    let runtime = RuntimePaths::for_app(app).map_err(std::io::Error::other)?;
    let root = app_data.join("plugins");
    let network =
        NetworkProxyStore::new(app_data.join("nexus.sqlite")).map_err(std::io::Error::other)?;
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
        .map_err(|error| std::io::Error::other(error.message()))?
        .with_network(network.clone(), runtime.network_preload.clone()),
    );
    app.manage(network.clone());
    app.manage(Arc::clone(&host));
    // Plugins installed in an earlier session start on their own; the
    // supervisor owns restarts, so the app never asks the user to fix a process.
    host.supervise();
    // The store is polled in the background so a new plugin version shows up
    // without the user opening the plugin page.
    host.watch_market();
    // Native recovery precedes window loading. Plugin receipts are retried
    // through the transfer status command after the UI can open.
    super::transfer_service::recover_pending(&app_data).map_err(std::io::Error::other)?;
    let license_store =
        LicenseStore::new(app_data.join("nexus.sqlite")).map_err(std::io::Error::other)?;
    let groups = GroupStore::new(app_data.join("nexus.sqlite")).map_err(std::io::Error::other)?;
    app.manage(groups);
    let license_service = LicenseService::with_runtime(
        license_store.clone(),
        license_store.browser_cache_dir(),
        runtime.clone(),
    )
    .with_network(network.clone());
    let windows = super::window_service::WindowService::with_runtime(
        app_data.join("profiles"),
        Some(Arc::clone(&host)),
        license_store,
        runtime,
    )
    .map_err(std::io::Error::other)?
    .with_network(network);
    let windows = Arc::new(windows);
    let agent = super::agent::AgentService::new(
        app_data.join("nexus.sqlite"),
        app_data.join("agent").join("artifacts"),
        &host,
        &windows,
    )
    .map_err(|error| std::io::Error::other(error.message))?;
    agent
        .register_gateway()
        .map_err(|error| std::io::Error::other(error.message))?;
    let transfer = super::transfer_service::TransferService::new(
        Arc::clone(&windows),
        Arc::clone(&host),
        app_data.join("transfers"),
    )
    .map_err(std::io::Error::other)?;
    windows.watch_sessions();
    app.manage(windows);
    app.manage(Arc::new(transfer));
    app.manage(Arc::new(license_service));
    agent.start();
    app.manage(agent);
    Ok(())
}

/// Retains the operating-system lock for the application lifetime.
struct WorkspaceLock(#[allow(dead_code)] std::fs::File);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(method: &str, capability: &str) -> CallInput {
        CallInput {
            id: "studio.vinted-accounts".into(),
            capability: capability.into(),
            method: method.into(),
            payload: json!({"windowId":"fixture-window"}),
            deadline_ms: None,
        }
    }

    #[test]
    fn generic_webview_rpc_rejects_the_host_private_window_cleanup_hook() {
        for capability in ["account.pool", "proxy.provider"] {
            assert!(webview_capability(&input("window.detach", capability)).is_err());
        }
        assert!(webview_capability(&input("vinted.accounts.unbind", "account.pool")).is_ok());
    }

    #[test]
    fn generic_webview_rpc_keeps_transfer_and_proxy_resolution_private() {
        assert!(webview_capability(&input("proxy.resolve", "proxy.provider")).is_err());
        assert!(webview_capability(&input("transfer.export", "account.pool")).is_err());
        assert!(webview_capability(&input("sync.offer", "window.sync")).is_err());
        for method in [
            "configuration.export",
            "configuration.validate",
            "configuration.import",
        ] {
            assert!(webview_capability(&input(method, "window.sync")).is_ok());
        }
        assert!(webview_capability(&input("configuration.sync.offer", "window.sync")).is_err());
    }

    #[test]
    fn webview_rpc_cannot_forge_agent_steps_observations_or_publications() {
        for capability in [
            "sales.agent",
            "account.pool",
            "product.catalog",
            "proxy.provider",
        ] {
            for method in [
                "salesAgent.jobs.step",
                "salesAgent.notifications.send",
                "vinted.accounts.observations.record",
                "products.publications.record",
            ] {
                assert!(webview_capability(&input(method, capability)).is_err());
            }
        }
        assert!(webview_capability(&input("salesAgent.settings.get", "sales.agent")).is_ok());
    }

    #[test]
    fn webview_call_preserves_structured_plugin_failure() {
        use super::super::plugin_host::process::ProcessError;

        let failure = call_failure(HostError::Process(ProcessError::Plugin(
            PluginErrorPayload::new("PERMISSION_DENIED", "Missing mail permission", false),
        )));
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            json!({
                "code": "PERMISSION_DENIED",
                "message": "Missing mail permission",
                "retryable": false
            })
        );
        let missing = call_failure(HostError::NotInstalled);
        assert_eq!(missing.code, "NOT_CONFIGURED");
        assert!(!missing.retryable);
    }
}
