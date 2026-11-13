mod artifacts;
pub mod commands;
mod controls;
pub mod dto;
mod gateway;
mod items;
mod model_history;
mod models;
mod notifications;
mod preflight;
mod queries;
mod retention;
mod scheduling;
mod schema;
mod service;
mod settings;
mod sql;
mod store;
mod workspace;

pub use commands::*;
pub use service::AgentService;

#[cfg(test)]
mod tests;

use super::plugin_host::process::PluginErrorPayload;
pub type AgentResult<T> = Result<T, PluginErrorPayload>;

pub(crate) fn invalid(message: &str) -> PluginErrorPayload {
    PluginErrorPayload::new("INVALID_REQUEST", message, false)
}

pub(crate) fn denied(message: &str) -> PluginErrorPayload {
    PluginErrorPayload::new("PERMISSION_DENIED", message, false)
}

pub(crate) fn conflict(message: &str) -> PluginErrorPayload {
    PluginErrorPayload::new("CONFLICT", message, false)
}

pub(crate) fn storage_error(_: impl std::fmt::Display) -> PluginErrorPayload {
    PluginErrorPayload::new("UNAVAILABLE", "Agent storage operation failed", false)
}

pub(crate) fn host_error(error: super::plugin_host::HostError) -> PluginErrorPayload {
    PluginErrorPayload::new(error.code(), &error.message(), error.retryable())
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub(crate) fn canonical(value: &serde_json::Value) -> String {
    fn sorted(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(object) => {
                let values: std::collections::BTreeMap<_, _> = object
                    .iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect();
                serde_json::to_value(values).unwrap_or(serde_json::Value::Null)
            }
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.iter().map(sorted).collect())
            }
            _ => value.clone(),
        }
    }
    sorted(value).to_string()
}
