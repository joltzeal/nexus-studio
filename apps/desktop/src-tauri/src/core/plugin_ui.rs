use super::plugin_host::manifest::{PluginUiService, valid_plugin_id, valid_ui_id};
use super::plugin_host::process::PluginErrorPayload;
use super::plugin_host::{PluginHost, PluginView};
use super::plugin_service::webview_method_capability;
use super::window_service::WindowService;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{State, Webview};
use uuid::Uuid;

const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const COMMAND_DEADLINE: Duration = Duration::from_secs(120);
const CALL_DEADLINE: Duration = Duration::from_secs(30);
const MAX_MEDIATION_ROUNDS: usize = 16;
const MAX_JSON_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct UiScope {
    plugin_id: String,
    view_id: String,
    connection_id: String,
    profile_ids: Vec<String>,
    identity: String,
}

#[derive(Clone)]
struct Session {
    scope: UiScope,
    owner: String,
    touched: Instant,
    busy: bool,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn error(message: &str) -> PluginErrorPayload {
    PluginErrorPayload::new("INVALID_REQUEST", message, false)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UiInput {
    operation: String,
    plugin_id: String,
    view_id: String,
    profile_id: String,
    connection_id: String,
    session_id: Option<String>,
    revision: Option<String>,
    action_id: Option<String>,
    #[serde(default)]
    values: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiResult {
    session_id: String,
    view: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum TaskOperation {
    Poll,
    Cancel,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UiTaskInput {
    plugin_id: String,
    view_id: String,
    profile_id: String,
    connection_id: String,
    identity: String,
    task_id: String,
    operation: TaskOperation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UiProfilesInput {
    plugin_id: String,
    view_id: String,
    connection_id: String,
    profile_ids: Vec<String>,
    identity: String,
}

#[derive(Clone, Serialize)]
struct ServiceAvailability {
    available: bool,
    identity: Option<String>,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ServiceRequest {
    id: String,
    service_id: String,
    method: String,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceRequestBatch {
    kind: String,
    requests: Vec<ServiceRequest>,
}

struct CachedServiceResult {
    request: ServiceRequest,
    result: Value,
    identity: Option<String>,
}

fn plugin_identity(view: &PluginView) -> Option<String> {
    view.runtime_generation
        .as_ref()
        .filter(|generation| !generation.is_empty() && !view.installation.is_empty())
        .map(|generation| format!("{}:{generation}", view.installation))
}

fn valid_scope(
    plugin_id: &str,
    view_id: &str,
    connection_id: &str,
    profile_ids: &[String],
) -> bool {
    let mut seen = HashSet::new();
    valid_plugin_id(plugin_id)
        && valid_ui_id(view_id)
        && !connection_id.is_empty()
        && connection_id.len() <= 512
        && profile_ids.len() <= 200
        && profile_ids.iter().all(|id| {
            Uuid::parse_str(id)
                .ok()
                .is_some_and(|uuid| seen.insert(uuid))
        })
}

fn scope(
    host: &PluginHost,
    plugin_id: String,
    view_id: String,
    connection_id: String,
    profile_ids: Vec<String>,
    expected_identity: Option<&str>,
) -> Result<UiScope, PluginErrorPayload> {
    if !valid_scope(&plugin_id, &view_id, &connection_id, &profile_ids) {
        return Err(error("插件界面作用域无效"));
    }
    let view = host.view_of(&plugin_id).map_err(|_| error("插件不可用"))?;
    let identity = plugin_identity(&view).ok_or_else(|| error("插件进程不可用"))?;
    if identity.len() > 512 || expected_identity.is_some_and(|expected| expected != identity) {
        return Err(error("插件状态已变化，请重试"));
    }
    Ok(UiScope {
        plugin_id,
        view_id,
        connection_id,
        profile_ids,
        identity,
    })
}

fn declaration(host: &PluginHost, scope: &UiScope) -> Result<PluginView, PluginErrorPayload> {
    let view = host
        .view_of(&scope.plugin_id)
        .map_err(|_| error("插件已不可用，请重试"))?;
    let ui = view
        .ui
        .as_ref()
        .ok_or_else(|| error("插件没有声明 Profile 面板"))?;
    let entry = ui
        .profile_table
        .as_ref()
        .ok_or_else(|| error("插件没有声明 Profile 面板"))?;
    if !view.enabled
        || view.state != "running"
        || ui.protocol_version != 1
        || entry.view_id != scope.view_id
        || !view
            .capabilities
            .iter()
            .any(|item| item == entry.capability.as_str())
        || !view
            .granted
            .iter()
            .any(|item| item == entry.capability.as_str())
        || plugin_identity(&view).as_deref() != Some(scope.identity.as_str())
    {
        return Err(error("插件状态已变化，请重试"));
    }
    Ok(view)
}

fn profiles(windows: &WindowService, scope: &UiScope) -> Result<(), PluginErrorPayload> {
    for profile_id in &scope.profile_ids {
        let record = windows
            .store
            .get(profile_id)
            .map_err(|_| error("Profile 已不可用"))?;
        if record.binding.connection_id != scope.connection_id
            || super::workbench_trash::is_trashed(&windows.store.database_path(), profile_id)
                .map_err(|_| error("无法核对 Profile"))?
        {
            return Err(error("Profile 不属于当前 Workspace"));
        }
    }
    Ok(())
}

fn check_scope(
    host: &PluginHost,
    windows: &WindowService,
    scope: &UiScope,
    method: &str,
    session_id: Option<&str>,
) -> Result<PluginView, PluginErrorPayload> {
    profiles(windows, scope)?;
    let view = declaration(host, scope)?;
    if !view.methods.iter().any(|entry| entry == method) {
        return Err(error("插件未声明请求的界面方法"));
    }
    if let Some(session_id) = session_id
        && !sessions()
            .lock()
            .map_err(|_| error("插件面板会话不可用"))?
            .contains_key(session_id)
    {
        return Err(error("插件面板已关闭"));
    }
    Ok(view)
}

/// Only inspect host-owned metadata. Availability never starts a process or calls a plugin.
fn service_identity(
    host: &PluginHost,
    scope: &UiScope,
    service: &PluginUiService,
) -> Result<String, &'static str> {
    if service.plugin_id == scope.plugin_id
        || !valid_plugin_id(&service.plugin_id)
        || service.methods.is_empty()
        || service.methods.iter().any(|method| {
            !valid_ui_id(method) || webview_method_capability(service.capability, method).is_err()
        })
    {
        return Err("SERVICE_METHOD_NOT_ALLOWED");
    }
    let target = host
        .view_of(&service.plugin_id)
        .map_err(|_| "SERVICE_UNAVAILABLE")?;
    if !target.enabled
        || target.state != "running"
        || !target
            .capabilities
            .iter()
            .any(|item| item == service.capability.as_str())
        || !target
            .granted
            .iter()
            .any(|item| item == service.capability.as_str())
        || service
            .methods
            .iter()
            .any(|method| !target.methods.contains(method))
    {
        return Err("SERVICE_UNAVAILABLE");
    }
    plugin_identity(&target)
        .filter(|identity| identity.len() <= 512)
        .ok_or("SERVICE_UNAVAILABLE")
}

fn availability(
    host: &PluginHost,
    scope: &UiScope,
    services: &[PluginUiService],
) -> BTreeMap<String, ServiceAvailability> {
    services
        .iter()
        .map(|service| {
            let identity = service_identity(host, scope, service).ok();
            (
                service.id.clone(),
                ServiceAvailability {
                    available: identity.is_some(),
                    identity,
                },
            )
        })
        .collect()
}

fn bounded_json(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_JSON_BYTES)
}

fn service_results(cached: &BTreeMap<String, CachedServiceResult>) -> Value {
    Value::Object(
        cached
            .iter()
            .map(|(id, result)| (id.clone(), result.result.clone()))
            .collect(),
    )
}

fn service_requests(value: &Value) -> Result<Option<Vec<ServiceRequest>>, PluginErrorPayload> {
    if value.get("kind").and_then(Value::as_str) != Some("service-request") {
        return Ok(None);
    }
    let batch: ServiceRequestBatch =
        serde_json::from_value(value.clone()).map_err(|_| error("插件服务请求无效"))?;
    let mut seen = HashSet::new();
    if batch.kind != "service-request"
        || batch.requests.is_empty()
        || batch.requests.len() > 8
        || batch.requests.iter().any(|request| {
            !valid_ui_id(&request.id)
                || !valid_ui_id(&request.service_id)
                || !valid_ui_id(&request.method)
                || !seen.insert(request.id.clone())
        })
    {
        return Err(error("插件服务请求无效"));
    }
    Ok(Some(batch.requests))
}

fn remaining(started: Instant) -> Result<Duration, PluginErrorPayload> {
    COMMAND_DEADLINE
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .map(|remaining| remaining.min(CALL_DEADLINE))
        .ok_or_else(|| PluginErrorPayload::new("TIMEOUT", "插件界面调用超过截止时间", false))
}

fn check_cached_results(
    host: &PluginHost,
    scope: &UiScope,
    services: &[PluginUiService],
    cached: &BTreeMap<String, CachedServiceResult>,
) -> Result<(), PluginErrorPayload> {
    for result in cached.values() {
        let Some(identity) = &result.identity else {
            continue;
        };
        let current = services
            .iter()
            .find(|service| service.id == result.request.service_id)
            .and_then(|service| service_identity(host, scope, service).ok());
        if current.as_deref() != Some(identity.as_str()) {
            return Err(error("服务插件状态已变化，请重试"));
        }
    }
    Ok(())
}

fn service_failure(request: ServiceRequest, code: &'static str) -> CachedServiceResult {
    CachedServiceResult {
        request,
        result: json!({"ok":false,"code":code}),
        identity: None,
    }
}

struct UiCall<'a> {
    scope: &'a UiScope,
    method: &'a str,
    session_id: Option<&'a str>,
    started: Instant,
}

fn resolve_service(
    host: &PluginHost,
    windows: &WindowService,
    call: &UiCall<'_>,
    services: &[PluginUiService],
    available: &BTreeMap<String, ServiceAvailability>,
    request: ServiceRequest,
) -> Result<CachedServiceResult, PluginErrorPayload> {
    let UiCall {
        scope,
        method,
        session_id,
        started,
    } = *call;
    check_scope(host, windows, scope, method, session_id)?;
    let Some(service) = services
        .iter()
        .find(|service| service.id == request.service_id)
    else {
        return Ok(service_failure(request, "SERVICE_NOT_DECLARED"));
    };
    if !service.methods.contains(&request.method)
        || webview_method_capability(service.capability, &request.method).is_err()
    {
        return Ok(service_failure(request, "SERVICE_METHOD_NOT_ALLOWED"));
    }
    let identity = match service_identity(host, scope, service) {
        Ok(identity) => identity,
        Err(code) => return Ok(service_failure(request, code)),
    };
    if available
        .get(&service.id)
        .and_then(|entry| entry.identity.as_deref())
        != Some(identity.as_str())
    {
        return Ok(service_failure(request, "SERVICE_CHANGED"));
    }
    let result = host.call_generation(
        &service.plugin_id,
        &identity,
        service.capability,
        &request.method,
        request.payload.clone(),
        remaining(started)?,
    );
    remaining(started)?;
    check_scope(host, windows, scope, method, session_id)?;
    if service_identity(host, scope, service).as_deref() != Ok(identity.as_str()) {
        return Ok(service_failure(request, "SERVICE_CHANGED"));
    }
    match result {
        Ok(value) if bounded_json(&value) => Ok(CachedServiceResult {
            request,
            result: json!({"ok":true,"value":value,"identity":identity}),
            identity: Some(identity),
        }),
        Ok(_) => Ok(service_failure(request, "SERVICE_RESULT_TOO_LARGE")),
        Err(_) => Ok(service_failure(request, "SERVICE_CALL_FAILED")),
    }
}

fn mediated_call(
    host: &PluginHost,
    windows: &WindowService,
    scope: &UiScope,
    method: &str,
    payload: Value,
    session_id: Option<&str>,
) -> Result<Value, PluginErrorPayload> {
    let started = Instant::now();
    let view = check_scope(host, windows, scope, method, session_id)?;
    let ui = view
        .ui
        .as_ref()
        .ok_or_else(|| error("插件没有声明 Profile 面板"))?;
    let services = &ui.services;
    let entry = ui
        .profile_table
        .as_ref()
        .ok_or_else(|| error("插件没有声明 Profile 面板"))?;
    let available = availability(host, scope, services);
    let call = UiCall {
        scope,
        method,
        session_id,
        started,
    };
    let mut cached: BTreeMap<String, CachedServiceResult> = BTreeMap::new();
    for round in 0..MAX_MEDIATION_ROUNDS {
        check_scope(host, windows, scope, method, session_id)?;
        check_cached_results(host, scope, services, &cached)?;
        let mut next = payload.clone();
        let object = next
            .as_object_mut()
            .ok_or_else(|| error("插件界面请求无效"))?;
        object.insert("services".into(), json!(available));
        object.insert("serviceResults".into(), service_results(&cached));
        if !bounded_json(&next) {
            return Err(error("插件界面请求超过大小限制"));
        }
        let result = host
            .call_generation(
                &scope.plugin_id,
                &scope.identity,
                entry.capability,
                method,
                next,
                remaining(started)?,
            )
            .map_err(|_| PluginErrorPayload::new("UNAVAILABLE", "插件界面调用失败", true))?;
        remaining(started)?;
        check_scope(host, windows, scope, method, session_id)?;
        check_cached_results(host, scope, services, &cached)?;
        if !bounded_json(&result) {
            return Err(error("插件界面结果超过大小限制"));
        }
        let Some(requests) = service_requests(&result)? else {
            remaining(started)?;
            return Ok(result);
        };
        if round + 1 == MAX_MEDIATION_ROUNDS {
            return Err(error("插件服务请求轮数超过限制"));
        }
        for request in requests {
            check_scope(host, windows, scope, method, session_id)?;
            check_cached_results(host, scope, services, &cached)?;
            if let Some(previous) = cached.get(&request.id) {
                if previous.request != request {
                    return Err(error("插件服务请求标识被重复使用"));
                }
                continue;
            }
            let id = request.id.clone();
            let result = resolve_service(host, windows, &call, services, &available, request)?;
            cached.insert(id, result);
            if !bounded_json(&service_results(&cached)) {
                return Err(error("插件服务结果超过大小限制"));
            }
        }
    }
    Err(error("插件服务请求轮数超过限制"))
}

#[tauri::command]
pub async fn plugin_ui_command(
    webview: Webview,
    host: State<'_, Arc<PluginHost>>,
    windows: State<'_, Arc<WindowService>>,
    input: UiInput,
) -> Result<UiResult, PluginErrorPayload> {
    if !matches!(input.operation.as_str(), "open" | "dispatch" | "close")
        || !valid_scope(
            &input.plugin_id,
            &input.view_id,
            &input.connection_id,
            std::slice::from_ref(&input.profile_id),
        )
        || input.values.len() > 30
        || input
            .values
            .iter()
            .any(|(key, value)| !valid_ui_id(key) || value.len() > 32768)
        || input
            .revision
            .as_ref()
            .is_some_and(|revision| revision.len() > 128)
        || input
            .action_id
            .as_ref()
            .is_some_and(|action| !valid_ui_id(action))
    {
        return Err(error("插件面板请求无效"));
    }
    let owner = webview.label().to_string();
    let host = Arc::clone(&host);
    let windows = Arc::clone(&windows);
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = if input.operation == "open" {
            Uuid::new_v4().to_string()
        } else {
            input
                .session_id
                .clone()
                .filter(|id| Uuid::parse_str(id).is_ok())
                .ok_or_else(|| error("插件面板会话标识无效"))?
        };
        let session = if input.operation == "open" {
            Session {
                scope: scope(
                    &host,
                    input.plugin_id.clone(),
                    input.view_id.clone(),
                    input.connection_id.clone(),
                    vec![input.profile_id.clone()],
                    None,
                )?,
                owner: owner.clone(),
                touched: Instant::now(),
                busy: true,
            }
        } else {
            let mut all = sessions()
                .lock()
                .map_err(|_| error("插件面板会话不可用"))?;
            let current = all
                .get_mut(&session_id)
                .ok_or_else(|| error("面板会话已失效，请重新打开"))?;
            if current.owner != owner
                || current.scope.plugin_id != input.plugin_id
                || current.scope.view_id != input.view_id
                || current.scope.profile_ids != [input.profile_id.clone()]
                || current.scope.connection_id != input.connection_id
            {
                return Err(error("插件面板作用域不匹配"));
            }
            let session = current.clone();
            if input.operation == "close" {
                all.remove(&session_id);
                drop(all);
                // Task lifetime is independent of this panel session.
                if let Ok(view) = declaration(&host, &session.scope)
                    && let Some(entry) = view.ui.and_then(|ui| ui.profile_table)
                {
                    let _ = host.call_generation(
                        &session.scope.plugin_id,
                        &session.scope.identity,
                        entry.capability,
                        "ui.view.close",
                        json!({"sessionId":session_id}),
                        Duration::from_secs(5),
                    );
                }
                return Ok(UiResult {
                    session_id,
                    view: Value::Null,
                });
            }
            if current.busy || current.touched.elapsed() > SESSION_TTL {
                return Err(error("面板正在处理或已过期，请稍后重试"));
            }
            current.busy = true;
            current.touched = Instant::now();
            session
        };
        let outcome = (|| {
            profiles(&windows, &session.scope)?;
            declaration(&host, &session.scope)?;
            if input.operation == "open" {
                let mut all = sessions()
                    .lock()
                    .map_err(|_| error("插件面板会话不可用"))?;
                all.retain(|_, item| item.touched.elapsed() < SESSION_TTL);
                if all.len() >= 64 {
                    return Err(error("插件面板会话过多"));
                }
                all.insert(session_id.clone(), session.clone());
            }
            let payload = if input.operation == "open" {
                json!({"sessionId":session_id,"viewId":session.scope.view_id,
                    "context":{"profileId":input.profile_id,"connectionId":session.scope.connection_id}})
            } else {
                json!({"sessionId":session_id,"revision":input.revision,
                    "actionId":input.action_id,"values":input.values})
            };
            let method = if input.operation == "open" {
                "ui.view.open"
            } else {
                "ui.view.dispatch"
            };
            let result = mediated_call(
                &host,
                &windows,
                &session.scope,
                method,
                payload,
                Some(&session_id),
            )?;
            Ok(UiResult {
                session_id: session_id.clone(),
                view: result,
            })
        })();
        if let Ok(mut all) = sessions().lock() {
            if outcome.is_err() && input.operation == "open" {
                all.remove(&session_id);
            } else if let Some(item) = all.get_mut(&session_id) {
                item.busy = false;
            }
        }
        outcome
    })
    .await
    .map_err(|_| error("插件面板任务中断"))?
}

#[tauri::command]
pub async fn plugin_ui_task_command(
    host: State<'_, Arc<PluginHost>>,
    windows: State<'_, Arc<WindowService>>,
    input: UiTaskInput,
) -> Result<Value, PluginErrorPayload> {
    if !valid_ui_id(&input.task_id) || input.identity.len() > 512 {
        return Err(error("插件任务请求无效"));
    }
    let host = Arc::clone(&host);
    let windows = Arc::clone(&windows);
    tauri::async_runtime::spawn_blocking(move || {
        let scope = scope(
            &host,
            input.plugin_id,
            input.view_id,
            input.connection_id,
            vec![input.profile_id.clone()],
            Some(&input.identity),
        )?;
        let method = match input.operation {
            TaskOperation::Poll => "ui.tasks.poll",
            TaskOperation::Cancel => "ui.tasks.cancel",
        };
        mediated_call(
            &host,
            &windows,
            &scope,
            method,
            json!({"taskId":input.task_id,"pollId":Uuid::new_v4().to_string(),
                "context":{"profileId":input.profile_id,"connectionId":scope.connection_id}}),
            None,
        )
    })
    .await
    .map_err(|_| error("插件任务调用中断"))?
}

#[tauri::command]
pub async fn plugin_ui_profiles(
    host: State<'_, Arc<PluginHost>>,
    windows: State<'_, Arc<WindowService>>,
    input: UiProfilesInput,
) -> Result<Value, PluginErrorPayload> {
    if input.identity.len() > 512 {
        return Err(error("插件状态请求无效"));
    }
    let host = Arc::clone(&host);
    let windows = Arc::clone(&windows);
    tauri::async_runtime::spawn_blocking(move || {
        let scope = scope(
            &host,
            input.plugin_id,
            input.view_id,
            input.connection_id,
            input.profile_ids,
            Some(&input.identity),
        )?;
        mediated_call(
            &host,
            &windows,
            &scope,
            "ui.profile.status",
            json!({"profileIds":scope.profile_ids,
                "context":{"connectionId":scope.connection_id}}),
            None,
        )
    })
    .await
    .map_err(|_| error("插件状态调用中断"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_continuations_reject_duplicate_and_unknown_request_fields() {
        let request =
            json!({"id":"first","serviceId":"catalog","method":"items.list","payload":{}});
        assert!(
            service_requests(
                &json!({"kind":"service-request","requests":[request.clone(),request]})
            )
            .is_err()
        );
        assert!(service_requests(&json!({"kind":"service-request","requests":[{
            "id":"first","serviceId":"catalog","method":"items.list","payload":{},"pluginId":"other.plugin"
        }]})).is_err());
    }

    #[test]
    fn service_continuations_require_a_bounded_nonempty_batch() {
        assert!(service_requests(&json!({"kind":"service-request","requests":[]})).is_err());
        let requests: Vec<_> = (0..9)
            .map(|index| json!({"id":format!("item-{index}"),"serviceId":"catalog","method":"items.list","payload":{}}))
            .collect();
        assert!(service_requests(&json!({"kind":"service-request","requests":requests})).is_err());
        assert!(
            service_requests(&json!({"protocolVersion":1}))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn profile_scopes_require_unique_uuids_and_a_bounded_batch() {
        let id = Uuid::new_v4().to_string();
        assert!(valid_scope(
            "example.panel",
            "details",
            "workspace",
            std::slice::from_ref(&id)
        ));
        assert!(!valid_scope(
            "example.panel",
            "details",
            "workspace",
            &[id.clone(), id]
        ));
        assert!(!valid_scope(
            "example.panel",
            "details",
            "workspace",
            &["provider-profile".into()]
        ));
        let ids: Vec<_> = (0..201).map(|_| Uuid::new_v4().to_string()).collect();
        assert!(!valid_scope("example.panel", "details", "workspace", &ids));
    }

    #[test]
    fn json_size_and_total_command_deadline_are_bounded() {
        assert!(!bounded_json(&json!("x".repeat(MAX_JSON_BYTES))));
        assert!(bounded_json(&json!({"items":[]})));
        assert!(remaining(Instant::now() - COMMAND_DEADLINE).is_err());
    }

    #[test]
    fn service_failure_never_includes_a_target_message() {
        let request = ServiceRequest {
            id: "first".into(),
            service_id: "catalog".into(),
            method: "items.list".into(),
            payload: json!({"private":"fixture"}),
        };
        let failure = service_failure(request, "SERVICE_CALL_FAILED");
        assert_eq!(
            failure.result,
            json!({"ok":false,"code":"SERVICE_CALL_FAILED"})
        );
        assert!(failure.identity.is_none());
    }
}
