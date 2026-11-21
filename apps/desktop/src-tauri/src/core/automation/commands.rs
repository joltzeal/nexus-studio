use super::engine::{model::Project, requests, wasm};
use super::host::{AutomationService, ClientCapabilities, blocking, engine_error};
use super::store::{invalid, storage_error};
use crate::core::browser::provider::BrowserResult;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

type AutomationState<'a> = State<'a, Arc<AutomationService>>;

#[tauri::command]
pub async fn browser_automation_available(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<bool> {
    state.store.require_connection(&connection_id)?;
    Ok(true)
}

#[tauri::command]
pub async fn browser_automation_capabilities(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: Option<String>,
) -> BrowserResult<ClientCapabilities> {
    let service = state.inner().clone();
    blocking(move || service.client_capabilities(&connection_id, profile_id.as_deref())).await
}

#[tauri::command]
pub async fn browser_automation_list(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<Vec<Project>> {
    let store = state.store.clone();
    blocking(move || store.list(&connection_id)).await
}

#[tauri::command]
pub async fn browser_automation_create(
    state: AutomationState<'_>,
    connection_id: String,
    name: String,
    epoch: Option<u64>,
) -> BrowserResult<Project> {
    let _ = epoch;
    let store = state.store.clone();
    blocking(move || store.create(&connection_id, &name)).await
}

#[tauri::command]
pub async fn browser_automation_save(
    state: AutomationState<'_>,
    connection_id: String,
    project: Project,
    epoch: Option<u64>,
) -> BrowserResult<Project> {
    let _ = epoch;
    let store = state.store.clone();
    blocking(move || store.save(&connection_id, project)).await
}

#[tauri::command]
pub async fn browser_automation_delete(
    state: AutomationState<'_>,
    connection_id: String,
    id: String,
    epoch: Option<u64>,
) -> BrowserResult<()> {
    let _ = epoch;
    let store = state.store.clone();
    blocking(move || store.delete(&connection_id, &id)).await
}

#[tauri::command]
pub async fn browser_automation_duplicate(
    state: AutomationState<'_>,
    connection_id: String,
    id: String,
    epoch: Option<u64>,
) -> BrowserResult<Project> {
    let _ = epoch;
    let store = state.store.clone();
    blocking(move || store.duplicate(&connection_id, &id)).await
}

#[tauri::command]
pub async fn browser_automation_attach(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
) -> BrowserResult<()> {
    state
        .inner()
        .clone()
        .attach(app, connection_id, profile_id)
        .await
}

#[tauri::command]
pub async fn browser_automation_detach(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
) -> BrowserResult<()> {
    state.detach(&connection_id, &profile_id).await
}

#[tauri::command]
pub async fn browser_automation_attached(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
) -> BrowserResult<bool> {
    state.attached(&connection_id, &profile_id).await
}

#[tauri::command]
pub async fn browser_automation_screencast(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
    on: bool,
    width: u32,
    height: u32,
) -> BrowserResult<()> {
    if on && (width == 0 || height == 0 || width > 16384 || height > 16384) {
        return Err(invalid("Invalid screencast dimensions"));
    }
    state
        .inner()
        .clone()
        .screencast(&connection_id, &profile_id, on, width, height)
        .await
}

#[tauri::command]
pub async fn browser_automation_call(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
    method: String,
    params: Value,
) -> BrowserResult<Value> {
    if method.is_empty() || method.len() > 200 || !params.is_object() {
        return Err(invalid("Invalid CDP method or parameters"));
    }
    state
        .inner()
        .clone()
        .editor_call(connection_id, profile_id, method, params)
        .await
}

#[tauri::command]
pub async fn browser_automation_launch(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
    restart: Option<bool>,
) -> BrowserResult<u32> {
    state
        .inner()
        .clone()
        .launch(connection_id, profile_id, restart.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn browser_automation_pick(
    state: AutomationState<'_>,
    connection_id: String,
    profile_id: String,
    x: f64,
    y: f64,
) -> BrowserResult<Value> {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err(invalid("Invalid viewport coordinates"));
    }
    state
        .inner()
        .clone()
        .pick(&connection_id, &profile_id, x, y)
        .await
}

#[tauri::command]
pub async fn browser_automation_run(
    state: AutomationState<'_>,
    connection_id: String,
    project_id: String,
    operation_id: String,
) -> BrowserResult<Value> {
    state
        .inner()
        .clone()
        .run(connection_id, project_id, operation_id)
        .await
}

#[tauri::command]
pub async fn browser_automation_run_stop(
    state: AutomationState<'_>,
    connection_id: String,
    project_id: String,
) -> BrowserResult<()> {
    let service = state.inner().clone();
    blocking(move || service.stop(&connection_id, &project_id)).await
}

#[tauri::command]
pub async fn browser_automation_run_status(
    state: AutomationState<'_>,
    connection_id: String,
    project_id: String,
) -> BrowserResult<Option<Value>> {
    state.project_status(connection_id, project_id).await
}

#[tauri::command]
pub async fn browser_automation_run_reconcile(
    state: AutomationState<'_>,
    connection_id: String,
    project_id: String,
    confirmed: bool,
) -> BrowserResult<Option<Value>> {
    state
        .inner()
        .clone()
        .reconcile_run(connection_id, project_id, confirmed)
        .await
}

#[tauri::command]
pub async fn browser_automation_fleet(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<Vec<Value>> {
    let store = state.store.clone();
    blocking(move || store.fleet(&connection_id)).await
}

#[tauri::command]
pub async fn browser_automation_fleet_window(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<()> {
    state.store.require_connection(&connection_id)?;
    let scope = url::form_urlencoded::byte_serialize(connection_id.as_bytes()).collect::<String>();
    let label = panel_label("fleet", &connection_id);
    if let Some(window) = app.get_webview_window(&label) {
        let mut url = window.url().map_err(storage_error)?;
        url.set_fragment(Some(&format!("/?fleet=1&connectionId={scope}")));
        window.navigate(url).map_err(storage_error)?;
        window.show().map_err(storage_error)?;
        return window.set_focus().map_err(storage_error);
    }
    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html#/?fleet=1&connectionId={scope}").into()),
    )
    .title("Raccoon Fleet")
    .inner_size(460.0, 420.0)
    .min_inner_size(360.0, 240.0)
    .always_on_top(true)
    .build()
    .map_err(storage_error)?;
    Ok(())
}

#[tauri::command]
pub async fn browser_automation_tls_fingerprints(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<Vec<String>> {
    state.store.require_connection(&connection_id)?;
    Ok(requests::fingerprints())
}

#[tauri::command]
pub async fn browser_automation_modules(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<Vec<Value>> {
    state.list_modules(connection_id).await
}

#[tauri::command]
pub async fn browser_automation_module_permissions(
    state: AutomationState<'_>,
    connection_id: String,
    id: String,
) -> BrowserResult<Value> {
    state.module_permissions(connection_id, id).await
}

#[tauri::command]
pub async fn browser_automation_module_grant(
    state: AutomationState<'_>,
    connection_id: String,
    id: String,
    modules: Vec<String>,
    flows: Vec<String>,
) -> BrowserResult<()> {
    state
        .inner()
        .clone()
        .grant_module(connection_id, id, modules, flows)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn browser_automation_module_install(
    state: AutomationState<'_>,
    connection_id: String,
    path: String,
) -> BrowserResult<Value> {
    state.install_module(&connection_id, path).await
}

#[tauri::command]
pub async fn browser_automation_module_remove(
    state: AutomationState<'_>,
    connection_id: String,
    id: String,
) -> BrowserResult<()> {
    state.remove_module(&connection_id, id).await
}

#[tauri::command]
pub async fn browser_automation_modules_dir(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<String> {
    state.store.require_connection(&connection_id)?;
    wasm::modules_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(engine_error)
}

#[tauri::command]
pub async fn browser_automation_export(
    state: AutomationState<'_>,
    connection_id: String,
    project_id: String,
) -> BrowserResult<Value> {
    state.export_bundle(&connection_id, &project_id).await
}

#[tauri::command]
pub async fn browser_automation_import(
    state: AutomationState<'_>,
    connection_id: String,
    bundle: Value,
    epoch: Option<u64>,
) -> BrowserResult<Project> {
    let _ = epoch;
    state.import_bundle(&connection_id, bundle).await
}

#[tauri::command]
pub async fn browser_automation_display(
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<Value> {
    state.store.require_connection(&connection_id)?;
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE")
                .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"));
        let placement = !wayland || std::env::var_os("DISPLAY").is_some();
        Ok(
            json!({"server":if wayland {"wayland"} else {"x11"},"limited":wayland,
            "note":if wayland {"Wayland limits native panel positioning and always-on-top placement"} else {""},
            "browser_placement":placement,"panels":!wayland}),
        )
    }
    #[cfg(not(target_os = "linux"))]
    Ok(json!({"server":"native","limited":false,"note":"","browser_placement":true,"panels":true}))
}

#[tauri::command]
pub async fn browser_automation_helper_fields(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
    profile: String,
) -> BrowserResult<Value> {
    state
        .inner()
        .clone()
        .helper_fields(app, &connection_id, &profile)
        .await
}

#[tauri::command]
pub async fn browser_automation_helper_fill(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
    profile: String,
) -> BrowserResult<usize> {
    state
        .inner()
        .clone()
        .helper_fill(app, &connection_id, &profile)
        .await
}

#[tauri::command]
pub async fn browser_automation_helper_profiles(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<Vec<String>> {
    state
        .inner()
        .clone()
        .helper_profiles(app, &connection_id)
        .await
}

#[tauri::command]
pub async fn browser_automation_helper_show(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
    profile: String,
) -> BrowserResult<()> {
    state.require_profile(&connection_id, &profile)?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("helperPanel", &profile)
        .append_pair("connectionId", &connection_id)
        .finish();
    let label = panel_label("helper", &connection_id);
    if let Some(window) = app.get_webview_window(&label) {
        let mut url = window.url().map_err(storage_error)?;
        url.set_fragment(Some(&format!("/?{query}")));
        window.navigate(url).map_err(storage_error)?;
        return window.show().map_err(storage_error);
    }
    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html#/?{query}").into()),
    )
    .title("Raccoon Helper")
    .inner_size(300.0, 150.0)
    .resizable(false)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .focused(false)
    .build()
    .map_err(storage_error)?;
    Ok(())
}

#[tauri::command]
pub async fn browser_automation_helper_close(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
) -> BrowserResult<()> {
    state.store.require_connection(&connection_id)?;
    let label = panel_label("helper", &connection_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(storage_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_automation_helper_dismiss(
    app: tauri::AppHandle,
    state: AutomationState<'_>,
    connection_id: String,
    profile: String,
) -> BrowserResult<()> {
    state
        .inner()
        .clone()
        .helper_dismiss(app.clone(), &connection_id, &profile)
        .await?;
    let label = panel_label("helper", &connection_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(storage_error)?;
    }
    Ok(())
}

fn panel_label(kind: &str, connection: &str) -> String {
    format!(
        "automation-{kind}-{:x}",
        Sha256::digest(connection.as_bytes())
    )
}
