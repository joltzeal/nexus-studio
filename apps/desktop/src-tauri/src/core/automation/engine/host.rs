//! Explicit service boundary for the MIT-licensed upstream engine port.
//!
//! Every host instance is bound immutably to one connection and run. Profile
//! identifiers are Raccoon UUIDs. No method may consult an active Workspace.
//! A host validates ownership, Provider capabilities, leases, required proxies,
//! immutable launch receipts and durable operation intents before dispatch.

use super::{model::Project, runner::RunState};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, future::Future, path::Path, pin::Pin};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineScope {
    pub connection_id: String,
    pub run_id: String,
    pub project_id: String,
}

impl EngineScope {
    /// Unambiguous keys even when identifiers contain punctuation.
    pub fn resource_key(&self, resource: &str) -> String {
        serde_json::to_string(&(&self.connection_id, &self.run_id, resource))
            .expect("string tuple serialization")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineCapabilities {
    /// Verified ShardBrowser Motion/Traffic/Script domains.
    pub native_shard: bool,
    /// Standard Input/Runtime/DOM/Page adaptation was verified for this instance.
    pub chromium_input: bool,
    pub script: bool,
    pub traffic: bool,
    pub touch: bool,
    pub proxy_hot_swap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpEndpoint {
    pub web_socket_debugger_url: String,
    /// Stable process/launch receipt identity, verified by the host.
    pub instance_id: String,
    pub capabilities: EngineCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub mobile: bool,
    pub temporary: bool,
    /// Full Provider-normalized data for dotted-path profile.read.
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProfile {
    pub name: String,
    pub folder: String,
    pub platform: Option<String>,
    pub inline_proxy: Option<String>,
    pub temporary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepKey {
    pub worker: usize,
    pub pass: u32,
    /// Monotonic within the worker, including module actions and flow calls.
    pub sequence: u64,
    pub block_id: String,
    pub kind: String,
    pub call_stack: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepIntent {
    pub id: String,
    pub key: StepKey,
}

/// Everything needed to continue after confirmation without repeating a step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepCompletion {
    /// "next", "else", "end_pass" or "cancelled".
    pub flow: String,
    pub variables: HashMap<String, String>,
    pub profile_id: String,
    pub temporary: bool,
    pub mobile: bool,
    pub temporary_profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Reconciliation {
    Pending,
    Committed(StepCompletion),
    /// Only after proving the previous action was not committed or failed.
    Retryable(String),
    Failed(String),
}

/// Preserve this typed error through anyhow contexts. It suspends the worker
/// before branch interpretation, including inside WASM actions and subflows.
#[derive(Debug)]
pub struct OutcomeUnknown(pub String);

impl std::fmt::Display for OutcomeUnknown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for OutcomeUnknown {}

pub fn outcome_unknown(error: impl std::fmt::Display) -> anyhow::Error {
    OutcomeUnknown(error.to_string()).into()
}

pub fn is_unknown(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<OutcomeUnknown>())
}

/// Object-safe async boundary. Required methods intentionally have no success
/// defaults. Profile lifecycle calls must derive distinct durable operation
/// keys from (run, intent.id, method, profile), including lazy start and cleanup.
///
/// begin_run must validate the entire project snapshot belongs to scope(),
/// validate references, and persist the immutable snapshot before returning.
/// State persistence failure must be returned, never reported as saved.
pub trait EngineHost: Send + Sync + 'static {
    fn scope(&self) -> &EngineScope;
    fn data_root(&self) -> &Path;
    fn begin_run<'a>(
        &'a self,
        project: &'a Project,
        projects: &'a [Project],
        modules: &'a Value,
    ) -> BoxFuture<'a, ()>;
    fn persist_state<'a>(&'a self, state: &'a RunState) -> BoxFuture<'a, ()>;
    /// Allocate or look up a stable key, persisting intent before side effects.
    fn allocate_step<'a>(
        &'a self,
        key: &'a StepKey,
        params: &'a Value,
    ) -> BoxFuture<'a, StepIntent>;
    fn complete_step<'a>(
        &'a self,
        intent: &'a StepIntent,
        result: &'a StepCompletion,
    ) -> BoxFuture<'a, ()>;
    fn fail_step<'a>(&'a self, intent: &'a StepIntent, error: &'a str) -> BoxFuture<'a, ()>;
    fn mark_unknown<'a>(&'a self, intent: &'a StepIntent, reason: &'a str) -> BoxFuture<'a, ()>;
    /// Read/reconcile the original operation. Must never resend it.
    fn reconcile<'a>(&'a self, intent: &'a StepIntent) -> BoxFuture<'a, Reconciliation>;
    fn create_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        input: CreateProfile,
    ) -> BoxFuture<'a, HostProfile>;
    /// Acquire or validate this run/worker's exclusive action lease.
    fn use_profile<'a>(&'a self, intent: &'a StepIntent, id: &'a str)
    -> BoxFuture<'a, HostProfile>;
    fn read_profile<'a>(&'a self, id: &'a str) -> BoxFuture<'a, HostProfile>;
    fn keep_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
        folder: Option<String>,
    ) -> BoxFuture<'a, ()>;
    /// Removes only a temporary record still owned by this run when temporary_only.
    fn delete_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
        temporary_only: bool,
    ) -> BoxFuture<'a, ()>;
    fn start_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
    ) -> BoxFuture<'a, CdpEndpoint>;
    /// Cleanup calls may only stop instances acquired/started by this run.
    fn stop_profile<'a>(&'a self, intent: &'a StepIntent, id: &'a str) -> BoxFuture<'a, ()>;
    fn resolve_cdp<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Option<CdpEndpoint>>;
    fn capabilities<'a>(&'a self, id: &'a str) -> BoxFuture<'a, EngineCapabilities>;
    fn set_proxy<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
        proxy: &'a str,
    ) -> BoxFuture<'a, ()>;
    /// Fail if required proxy resolution fails. None explicitly means direct.
    fn resolve_proxy<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Option<String>>;
    /// Upstream helper person fields, scoped to the Profile.
    fn autofill<'a>(&'a self, id: &'a str, field: &'a str) -> BoxFuture<'a, String>;
    /// Release only this worker's lease when changing profiles or finishing.
    fn release_profile<'a>(&'a self, worker: usize, id: &'a str) -> BoxFuture<'a, ()>;
}
