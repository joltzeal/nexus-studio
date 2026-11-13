use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use super::AgentService;
use super::dto::*;
use crate::core::plugin_host::process::PluginErrorPayload;

fn interrupted() -> PluginErrorPayload {
    PluginErrorPayload::new("UNAVAILABLE", "Agent command was interrupted", false)
}

#[tauri::command]
pub async fn sales_agent_batch_create(
    state: State<'_, Arc<AgentService>>,
    input: BatchCreateInput,
) -> Result<Value, PluginErrorPayload> {
    let service = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || service.create(input))
        .await
        .map_err(|_| interrupted())?
}

#[tauri::command]
pub async fn sales_agent_batch_list(
    state: State<'_, Arc<AgentService>>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    let service = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        service.list(PageInput {
            page: page.unwrap_or(1),
            page_size: page_size.unwrap_or(20),
        })
    })
    .await
    .map_err(|_| interrupted())?
}

#[tauri::command]
pub async fn sales_agent_batch_get(
    state: State<'_, Arc<AgentService>>,
    id: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    let service = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        service.get(BatchGetInput {
            batch_id: id,
            page: page.unwrap_or(1),
            page_size: page_size.unwrap_or(20),
        })
    })
    .await
    .map_err(|_| interrupted())?
}

#[tauri::command]
pub async fn sales_agent_batch_control(
    state: State<'_, Arc<AgentService>>,
    id: String,
    action: ControlAction,
) -> Result<Value, PluginErrorPayload> {
    let service = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        service.control(ControlInput {
            batch_id: id,
            action,
        })
    })
    .await
    .map_err(|_| interrupted())?
}

#[tauri::command]
pub async fn sales_agent_events(
    state: State<'_, Arc<AgentService>>,
    id: String,
    cursor: Option<u64>,
    limit: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    let service = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        service.events(EventsInput {
            batch_id: id,
            cursor: cursor.unwrap_or(0),
            limit: limit.unwrap_or(100),
        })
    })
    .await
    .map_err(|_| interrupted())?
}

async fn run_agent<F>(
    state: State<'_, Arc<AgentService>>,
    work: F,
) -> Result<Value, PluginErrorPayload>
where
    F: FnOnce(Arc<AgentService>) -> Result<Value, PluginErrorPayload> + Send + 'static,
{
    let service = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || work(service))
        .await
        .map_err(|_| interrupted())?
}

#[tauri::command]
pub async fn sales_agent_preflight(
    state: State<'_, Arc<AgentService>>,
    input: BatchCreateInput,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.preflight(input)).await
}

#[tauri::command]
pub async fn sales_agent_job_control(
    state: State<'_, Arc<AgentService>>,
    id: String,
    action: ControlAction,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.job_control(&id, action)).await
}

#[tauri::command]
pub async fn sales_agent_items(
    state: State<'_, Arc<AgentService>>,
    id: String,
    page: Option<u32>,
    page_size: Option<u32>,
    attention_only: Option<bool>,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        s.store.items(
            &id,
            page.unwrap_or(1),
            page_size.unwrap_or(20),
            attention_only.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn sales_agent_item_control(
    state: State<'_, Arc<AgentService>>,
    job_id: String,
    product_id: String,
    action: String,
    r#override: Option<Value>,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        s.store.item_control(&ItemControlInput {
            job_id,
            product_id,
            action,
            r#override,
        })
    })
    .await
}

#[tauri::command]
pub async fn sales_agent_artifact_preview(
    state: State<'_, Arc<AgentService>>,
    job_id: String,
    artifact_id: String,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.artifact_preview(&job_id, &artifact_id)).await
}

#[tauri::command]
pub async fn sales_agent_workspace_list(
    state: State<'_, Arc<AgentService>>,
    kind: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        s.store
            .workspace_list(kind.as_deref(), page.unwrap_or(1), page_size.unwrap_or(20))
    })
    .await
}

#[tauri::command]
pub async fn sales_agent_workspace_get(
    state: State<'_, Arc<AgentService>>,
    id: String,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.store.workspace_get(&id)).await
}

#[tauri::command]
pub async fn sales_agent_workspace_save(
    state: State<'_, Arc<AgentService>>,
    input: WorkspaceSave,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.store.workspace_save(&input)).await
}

#[tauri::command]
pub async fn sales_agent_workspace_delete(
    state: State<'_, Arc<AgentService>>,
    id: String,
    expected_revision: u64,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        s.store.workspace_delete(&id, expected_revision)
    })
    .await
}

#[tauri::command]
pub async fn sales_agent_usage(
    state: State<'_, Arc<AgentService>>,
    id: String,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.store.usage(&id)).await
}

#[tauri::command]
pub async fn sales_agent_model_requests(
    state: State<'_, Arc<AgentService>>,
    id: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        s.store
            .model_requests(&id, page.unwrap_or(1), page_size.unwrap_or(20))
    })
    .await
}

#[tauri::command]
pub async fn sales_agent_retention_preview(
    state: State<'_, Arc<AgentService>>,
    days: u32,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.store.retention_preview(days)).await
}

#[tauri::command]
pub async fn sales_agent_retention_clean(
    state: State<'_, Arc<AgentService>>,
    token: String,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| s.retention_clean(&token)).await
}

#[tauri::command]
pub async fn sales_agent_attention(
    state: State<'_, Arc<AgentService>>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        s.store
            .related("attention", "", page.unwrap_or(1), page_size.unwrap_or(20))
    })
    .await
}

#[tauri::command]
pub async fn sales_agent_related(
    state: State<'_, Arc<AgentService>>,
    kind: String,
    id: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Value, PluginErrorPayload> {
    run_agent(state, move |s| {
        if !matches!(kind.as_str(), "product" | "window" | "account") {
            return Err(super::invalid("Unsupported execution relation"));
        }
        s.store
            .related(&kind, &id, page.unwrap_or(1), page_size.unwrap_or(20))
    })
    .await
}
