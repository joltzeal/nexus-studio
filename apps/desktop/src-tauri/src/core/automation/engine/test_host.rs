//! Controlled host for runner branch and reconciliation tests. No real Provider.

use super::{host::*, model::Project, runner::RunState, wasm};
use anyhow::anyhow;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};

pub fn module_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        std::env::temp_dir().join(format!("raccoon-engine-unit-{}", std::process::id()))
    })
    .clone()
}

pub fn initialize_modules() {
    wasm::initialize(module_root()).expect("test module root");
}

pub struct TestHost {
    pub block_first_persist: std::sync::atomic::AtomicBool,
    pub persist_entered: tokio::sync::Notify,
    pub persist_resume: tokio::sync::Notify,
    pub persisted_states: Mutex<Vec<RunState>>,
    scope: EngineScope,
    root: PathBuf,
    pub creates: AtomicUsize,
    pub reconciles: AtomicUsize,
    pub failures: AtomicUsize,
    pub completed: Mutex<Vec<String>>,
    pub resolutions: Mutex<VecDeque<Reconciliation>>,
    pub unknown_create: bool,
    pub persist_failures: AtomicUsize,
}

impl TestHost {
    pub fn new() -> Self {
        Self {
            block_first_persist: std::sync::atomic::AtomicBool::new(false),
            persist_entered: tokio::sync::Notify::new(),
            persist_resume: tokio::sync::Notify::new(),
            persisted_states: Mutex::new(Vec::new()),
            scope: EngineScope {
                connection_id: "connection-a".into(),
                run_id: "run-a".into(),
                project_id: "caller".into(),
            },
            root: module_root(),
            creates: AtomicUsize::new(0),
            reconciles: AtomicUsize::new(0),
            failures: AtomicUsize::new(0),
            completed: Mutex::new(Vec::new()),
            resolutions: Mutex::new(VecDeque::new()),
            unknown_create: false,
            persist_failures: AtomicUsize::new(0),
        }
    }
}

fn refused<'a, T: Send + 'a>() -> BoxFuture<'a, T> {
    Box::pin(async { Err(anyhow!("test host has no real Provider")) })
}

impl EngineHost for TestHost {
    fn scope(&self) -> &EngineScope {
        &self.scope
    }
    fn data_root(&self) -> &Path {
        &self.root
    }
    fn begin_run<'a>(
        &'a self,
        _: &'a Project,
        _: &'a [Project],
        _: &'a Value,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn persist_state<'a>(&'a self, state: &'a RunState) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if self.block_first_persist.swap(false, Ordering::SeqCst) {
                self.persist_entered.notify_one();
                self.persist_resume.notified().await;
            }
            if self
                .persist_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                    count.checked_sub(1)
                })
                .is_ok()
            {
                return Err(anyhow!("controlled durable write failure"));
            }
            self.persisted_states.lock().unwrap().push(state.clone());
            Ok(())
        })
    }
    fn allocate_step<'a>(&'a self, key: &'a StepKey, _: &'a Value) -> BoxFuture<'a, StepIntent> {
        Box::pin(async move {
            Ok(StepIntent {
                id: format!("{}-{}", key.worker, key.sequence),
                key: key.clone(),
            })
        })
    }
    fn complete_step<'a>(
        &'a self,
        intent: &'a StepIntent,
        _: &'a StepCompletion,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.completed.lock().unwrap().push(intent.id.clone());
            Ok(())
        })
    }
    fn fail_step<'a>(&'a self, _: &'a StepIntent, _: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async {
            self.failures.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
    fn mark_unknown<'a>(&'a self, _: &'a StepIntent, _: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn reconcile<'a>(&'a self, _: &'a StepIntent) -> BoxFuture<'a, Reconciliation> {
        Box::pin(async {
            self.reconciles.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .resolutions
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Reconciliation::Pending))
        })
    }
    fn create_profile<'a>(
        &'a self,
        _: &'a StepIntent,
        _: CreateProfile,
    ) -> BoxFuture<'a, HostProfile> {
        Box::pin(async {
            self.creates.fetch_add(1, Ordering::SeqCst);
            if self.unknown_create {
                return Err(outcome_unknown("controlled create timeout"));
            }
            Ok(HostProfile {
                id: "raccoon-profile".into(),
                name: "controlled".into(),
                mobile: false,
                temporary: true,
                data: json!({}),
            })
        })
    }
    fn use_profile<'a>(&'a self, _: &'a StepIntent, _: &'a str) -> BoxFuture<'a, HostProfile> {
        refused()
    }
    fn read_profile<'a>(&'a self, _: &'a str) -> BoxFuture<'a, HostProfile> {
        refused()
    }
    fn keep_profile<'a>(
        &'a self,
        _: &'a StepIntent,
        _: &'a str,
        _: Option<String>,
    ) -> BoxFuture<'a, ()> {
        refused()
    }
    fn delete_profile<'a>(&'a self, _: &'a StepIntent, _: &'a str, _: bool) -> BoxFuture<'a, ()> {
        refused()
    }
    fn start_profile<'a>(&'a self, _: &'a StepIntent, _: &'a str) -> BoxFuture<'a, CdpEndpoint> {
        refused()
    }
    fn stop_profile<'a>(&'a self, _: &'a StepIntent, _: &'a str) -> BoxFuture<'a, ()> {
        refused()
    }
    fn resolve_cdp<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Option<CdpEndpoint>> {
        refused()
    }
    fn capabilities<'a>(&'a self, _: &'a str) -> BoxFuture<'a, EngineCapabilities> {
        refused()
    }
    fn set_proxy<'a>(&'a self, _: &'a StepIntent, _: &'a str, _: &'a str) -> BoxFuture<'a, ()> {
        refused()
    }
    fn resolve_proxy<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Option<String>> {
        refused()
    }
    fn autofill<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, String> {
        refused()
    }
    fn release_profile<'a>(&'a self, _: usize, _: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[test]
fn host_is_object_safe() {
    let host: std::sync::Arc<dyn EngineHost> = std::sync::Arc::new(TestHost::new());
    assert_eq!(host.scope().connection_id, "connection-a");
}

#[test]
fn connection_run_resource_keys_are_unambiguous() {
    let host = TestHost::new();
    let mut other = host.scope().clone();
    other.connection_id = "connection-b".into();
    assert_ne!(
        host.scope().resource_key("profile"),
        other.resource_key("profile")
    );
    other = host.scope().clone();
    other.run_id = "run-b".into();
    assert_ne!(
        host.scope().resource_key("profile"),
        other.resource_key("profile")
    );
}

#[test]
fn contextual_unknown_error_preserves_typed_identity() {
    let error = outcome_unknown("unknown").context("nested module action");
    assert!(is_unknown(&error));
    assert!(!is_unknown(&anyhow!("confirmed failure")));
}
