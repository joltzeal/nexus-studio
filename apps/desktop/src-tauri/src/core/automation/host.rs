// Bundle and helper protocol adapted from ProxyShard/ShardBrowser, MIT,
// commit 99e780e2e685e5b3b5357c5baee8796e10b3ce1e. See engine/LICENSE.upstream.
use super::engine::{self, cdp, host::*, model::Project, runner, wasm};
use super::store::{
    ActionIntent, AutomationStore, RunIntent, invalid, module_path, redact_value, storage_error,
};
use crate::core::browser::provider::{BrowserError, BrowserProviderId, BrowserResult, ProxyMode};
use crate::core::group_store::GroupStore;
use crate::core::window_service::{CreateWindowInput, UpdateWindowInput, WindowService};
use crate::core::window_store::{WindowRecord, WindowSettings};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub struct AutomationService {
    pub store: AutomationStore,
    pub windows: Arc<WindowService>,
    root: PathBuf,
    groups: GroupStore,
    editor_gate: tokio::sync::Mutex<()>,
    editor_sessions: Mutex<HashMap<String, CdpEndpoint>>,
    module_gate: tokio::sync::Mutex<()>,
    verified: Mutex<HashMap<String, EngineCapabilities>>,
    helper_offers: Mutex<HashMap<String, Value>>,
    helper_dismissed: Mutex<HashMap<String, String>>,
    host_jobs: Mutex<HashMap<String, Arc<AtomicUsize>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    pub supported: bool,
    pub reason: String,
    pub features: Vec<String>,
    pub input_mode: String,
}

pub(crate) fn engine_error(error: anyhow::Error) -> BrowserError {
    if let Some(error) = error.downcast_ref::<BrowserError>() {
        return error.clone();
    }
    if engine::host::is_unknown(&error) {
        return BrowserError::new(
            "operation_uncertain",
            "The browser action requires reconciliation",
        );
    }
    // Engine errors can contain scripts, selectors, URLs or form values.
    BrowserError::new(
        "automation_failed",
        "The automation operation failed; inspect its scoped run state",
    )
}

pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> BrowserResult<T> + Send + 'static,
) -> BrowserResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| BrowserError::new("unavailable", "Automation task was interrupted"))?
}

/// Read-only protocol introspection, performed against the Provider-validated
/// browser endpoint. No input or launch is used to infer support.
async fn probe_endpoint(endpoint: &str) -> BrowserResult<EngineCapabilities> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let address = url::Url::parse(endpoint).map_err(|_| invalid("Invalid debugger URL"))?;
    let host = address
        .host_str()
        .ok_or_else(|| invalid("Debugger host missing"))?;
    if !host
        .trim_matches(['[', ']'])
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
    {
        return Err(invalid(
            "Protocol discovery requires a literal loopback endpoint",
        ));
    }
    let port = address
        .port()
        .ok_or_else(|| invalid("Debugger port missing"))?;
    let protocol_url = format!(
        "http://{}:{port}/json/protocol",
        address
            .host()
            .ok_or_else(|| invalid("Debugger host missing"))?
    );
    let protocol = blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|_| BrowserError::new("unavailable", "Protocol discovery client failed"))?;
        let response = client
            .get(protocol_url)
            .send()
            .map_err(|_| BrowserError::new("unavailable", "Browser protocol discovery failed"))?;
        if !response.status().is_success() {
            return Err(BrowserError::new(
                "unavailable",
                "Browser protocol schema is unavailable",
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(storage_error)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(invalid("Browser protocol schema is oversized"));
        }
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| invalid("Invalid browser protocol schema"))
    })
    .await?;
    let endpoint = endpoint.to_owned();
    let live = tokio::time::timeout(std::time::Duration::from_secs(8), async move {
        let (mut socket, _) = tokio_tungstenite::connect_async(&endpoint).await?;
        let requests = [
            json!({"id":1,"method":"Browser.getVersion"}),
            json!({"id":2,"method":"Target.getTargets"}),
        ];
        for request in requests {
            socket.send(Message::Text(request.to_string())).await?;
        }
        let mut version = false;
        let mut session = None;
        let mut domains = HashSet::new();
        while let Some(message) = socket.next().await {
            let message = message?;
            let Message::Text(raw) = message else {
                continue;
            };
            let response: Value = serde_json::from_str(&raw)?;
            if response.get("error").is_some() {
                return Err(anyhow!("Browser protocol introspection rejected"));
            }
            match response["id"].as_u64() {
                Some(1) => {
                    version = response["result"]["protocolVersion"].is_string();
                }
                Some(2) => {
                    let target = response["result"]["targetInfos"]
                        .as_array()
                        .and_then(|targets| targets.iter().find(|target| target["type"] == "page"))
                        .and_then(|target| target["targetId"].as_str())
                        .map(str::to_owned);
                    let target = target
                        .as_ref()
                        .context("No page available for capability verification")?;
                    socket
                        .send(Message::Text(
                            json!({"id":3,"method":"Target.attachToTarget",
                        "params":{"targetId":target,"flatten":true}})
                            .to_string(),
                        ))
                        .await?;
                }
                Some(3) => {
                    let id = response["result"]["sessionId"]
                        .as_str()
                        .context("No introspection session")?
                        .to_owned();
                    session = Some(id.clone());
                    socket
                        .send(Message::Text(
                            json!({"id":4,"method":"Schema.getDomains","sessionId":id}).to_string(),
                        ))
                        .await?;
                }
                Some(4) => {
                    if let Some(entries) = response["result"]["domains"].as_array() {
                        for domain in entries {
                            if let Some(name) = domain["name"].as_str() {
                                domains.insert(name.to_owned());
                            }
                        }
                    }
                    if let Some(session) = session {
                        socket
                            .send(Message::Text(
                                json!({"id":5,"method":"Target.detachFromTarget",
                            "params":{"sessionId":session}})
                                .to_string(),
                            ))
                            .await?;
                    }
                    let _ = socket.close(None).await;
                    return Ok::<_, anyhow::Error>((version, domains));
                }
                _ => {}
            }
        }
        Err(anyhow!("Protocol discovery disconnected"))
    })
    .await
    .map_err(|_| BrowserError::new("unavailable", "Browser capability verification timed out"))?
    .map_err(engine_error)?;
    let protocol_domains = protocol["domains"]
        .as_array()
        .ok_or_else(|| invalid("Protocol domains missing"))?;
    let command = |domain: &str, name: &str| {
        protocol_domains.iter().any(|entry| {
            entry["domain"] == domain
                && entry["commands"]
                    .as_array()
                    .is_some_and(|commands| commands.iter().any(|command| command["name"] == name))
        })
    };
    let standard = live.0
        && ["Page", "DOM", "Runtime"]
            .iter()
            .all(|name| live.1.contains(*name))
        && command("Input", "dispatchMouseEvent")
        && command("Input", "dispatchKeyEvent");
    let native = [
        "createPointer",
        "glideTo",
        "tap",
        "dragTo",
        "wheel",
        "enterText",
        "pressKey",
    ]
    .iter()
    .all(|name| command("Motion", name));
    if !standard && !native {
        return Err(BrowserError::unsupported(
            "This browser exposes no supported automation input protocol",
        ));
    }
    Ok(EngineCapabilities {
        native_shard: native,
        chromium_input: standard,
        script: if native {
            command("Script", "run")
        } else {
            command("Runtime", "evaluate") && command("Page", "createIsolatedWorld")
        },
        traffic: if native {
            command("Traffic", "mount")
        } else {
            command("Fetch", "enable")
                && command("Fetch", "fulfillRequest")
                && command("Network", "enable")
        },
        touch: if native {
            [
                "touchTap",
                "touchLongPress",
                "touchSwipe",
                "touchDrag",
                "pinch",
                "setOrientation",
            ]
            .iter()
            .all(|name| command("Motion", name))
        } else {
            command("Input", "dispatchTouchEvent")
                && command("Emulation", "setDeviceMetricsOverride")
        },
        proxy_hot_swap: native && command("Traffic", "setProxy"),
    })
}

impl AutomationService {
    pub async fn reconcile_run(
        self: &Arc<Self>,
        connection: String,
        project: String,
        confirmed: bool,
    ) -> BrowserResult<Option<Value>> {
        let records = self.store.recovery_runs(&connection, &project)?;
        if confirmed {
            for record in &records {
                self.store.request_cancel(&record.id)?;
                runner::stop(&connection, &record.id);
            }
            // A returned command does not imply a dispatched browser action ended.
            // Wait for the engine to leave its action future before reviewing it.
            for record in &records {
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
                while runner::status(&connection, &record.id).is_some_and(|state| state.running) {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(BrowserError::new(
                            "operation_pending",
                            "Engine is still stopping its active action",
                        ));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                if self
                    .host_jobs
                    .lock()
                    .map_err(storage_error)?
                    .get(&record.id)
                    .is_some_and(|jobs| jobs.load(Ordering::Acquire) != 0)
                {
                    return Err(BrowserError::new(
                        "operation_pending",
                        "A lifecycle request is still completing",
                    ));
                }
            }
        }
        for record in &records {
            let service = self.clone();
            let run = record.clone();
            let workspace = connection.clone();
            blocking(move || {
                let host = RaccoonHost {
                    service: service.clone(),
                    scope: EngineScope {
                        connection_id: workspace.clone(),
                        run_id: run.id.clone(),
                        project_id: run.project_id.clone(),
                    },
                };
                for intent in service.store.unresolved_steps(&run.id)? {
                    match host.reconcile_lifecycle(&intent) {
                        Ok(Reconciliation::Committed(completion)) => service.store.finish_step(
                            &run.id,
                            &intent.id,
                            "completed",
                            Some(&serde_json::to_value(completion).map_err(storage_error)?),
                            None,
                        )?,
                        Ok(Reconciliation::Failed(_)) => {
                            service.store.review_step(&run.id, &intent.id, "failed")?
                        }
                        _ => {}
                    }
                }
                if confirmed {
                    for (action, phase, _, _) in service.store.actions(&run.id)? {
                        if phase != "intent" { continue; }
                        for operation in service.store.action_operations(&run.id, &action)? {
                            if operation.connection_id != workspace || !["committed", "failed", "cancelled"].contains(&operation.phase.as_str()) {
                                return Err(BrowserError::new("operation_uncertain", "An associated lifecycle operation still needs reconciliation"));
                            }
                        }
                        if let Some(operation) = service.store.browser_operation(&action)? {
                            if operation.connection_id != workspace { return Err(invalid("Lifecycle operation scope mismatch")); }
                            if !["committed", "failed", "cancelled"].contains(&operation.phase.as_str()) {
                                return Err(BrowserError::new("operation_uncertain", "A submitted lifecycle operation must be reconciled before ending this run"));
                            }
                        }
                    }
                    for (profile, owner) in service.store.resources(&run.id)? {
                        if service.windows.store.get(&profile).is_err() && service.store.confirmed_deleted(&workspace, &profile)? {
                            service.store.resource_flag(&run.id, &profile, "released")?;
                            continue;
                        }
                        let state = service.windows.agent_window_snapshot(&profile)?;
                        if state["state"] != "running" && state["state"] != "stopped" {
                            return Err(BrowserError::new(
                                "operation_uncertain",
                                "Browser identity and running state still require inspection",
                            ));
                        }
                        service.windows.reconcile_agent_window(&profile, &owner)?;
                    }
                    for intent in service.store.unresolved_steps(&run.id)? {
                        service.store.review_step(
                            &run.id,
                            &intent.id,
                            "stopped after explicit inspection",
                        )?;
                    }
                }
                Ok(())
            })
            .await?;
            if confirmed {
                for (profile, owner) in self.store.resources(&record.id)? {
                    let resource = self
                        .store
                        .resource(&record.id, &profile)?
                        .ok_or_else(|| invalid("Run resource missing"))?;
                    let worker = resource["worker"]
                        .as_u64()
                        .ok_or_else(|| invalid("Worker ownership missing"))?
                        as usize;
                    cdp::with_scope(
                        EngineScope {
                            connection_id: connection.clone(),
                            run_id: record.id.clone(),
                            project_id: project.clone(),
                        },
                        worker,
                        async {
                            if cdp::is_attached(&profile) {
                                let state = self
                                    .windows
                                    .agent_window_snapshot(&profile)
                                    .map_err(anyhow::Error::from)?;
                                if state["state"] == "stopped" {
                                    cdp::detach(&profile);
                                    Ok(())
                                } else {
                                    cdp::release_recovered(&profile).await
                                }
                            } else {
                                Ok(())
                            }
                        },
                    )
                    .await
                    .map_err(engine_error)?;
                    self.windows.release_agent_window(&profile, &owner)?;
                    self.store.resource_flag(&record.id, &profile, "released")?;
                }
                self.store.settle_interrupted(&record.id)?;
                let settled = self.store.run_by_id(&connection, &record.id)?;
                let state: runner::RunState =
                    serde_json::from_value(settled.state).map_err(storage_error)?;
                runner::retire_recovered(state)
                    .await
                    .map_err(engine_error)?;
            }
        }
        self.project_status(connection, project).await
    }
    pub fn shutdown(&self) {
        if let Ok(runs) = self.store.active_runs() {
            for (connection, run) in runs {
                let _ = self.store.request_cancel(&run);
                runner::stop(&connection, &run);
            }
        }
        let _ = self.store.interrupt_unfinished();
        // Schedule scoped preview cleanup without blocking the native exit callback.
        if let Ok(mut sessions) = self.editor_sessions.lock() {
            let keys = sessions.drain().map(|(key, _)| key).collect::<Vec<_>>();
            for key in keys {
                if let Ok((connection, _, profile)) =
                    serde_json::from_str::<(String, String, String)>(&key)
                {
                    let windows = self.windows.clone();
                    tauri::async_runtime::spawn(async move {
                        if cdp::with_scope(Self::editor_scope(&connection), 0, async {
                            cdp::release_preview(&profile).await
                        })
                        .await
                        .is_ok()
                        {
                            let _ = windows
                                .release_agent_window(&profile, &Self::editor_owner(&connection));
                        }
                    });
                }
            }
        }
        super::helper::shutdown();
    }
    pub async fn list_projects(&self, connection: String) -> BrowserResult<Vec<Project>> {
        let store = self.store.clone();
        blocking(move || store.list(&connection)).await
    }

    pub async fn create_project(&self, connection: String, name: String) -> BrowserResult<Project> {
        let store = self.store.clone();
        blocking(move || store.create(&connection, &name)).await
    }

    pub async fn get_project(&self, connection: String, id: String) -> BrowserResult<Project> {
        let store = self.store.clone();
        blocking(move || store.get(&connection, &id)).await
    }

    pub async fn save_project(
        &self,
        connection: String,
        project: Project,
    ) -> BrowserResult<Project> {
        let store = self.store.clone();
        blocking(move || store.save(&connection, project)).await
    }

    pub async fn delete_project(&self, connection: String, id: String) -> BrowserResult<()> {
        let store = self.store.clone();
        blocking(move || store.delete(&connection, &id)).await
    }

    pub async fn duplicate_project(
        &self,
        connection: String,
        id: String,
    ) -> BrowserResult<Project> {
        let store = self.store.clone();
        blocking(move || store.duplicate(&connection, &id)).await
    }

    pub async fn project_status(
        &self,
        connection: String,
        id: String,
    ) -> BrowserResult<Option<Value>> {
        let store = self.store.clone();
        blocking(move || {
            store.get(&connection, &id)?;
            let pending = store.recovery_runs(&connection, &id)?;
            if let Some(run) = pending.into_iter().next() {
                return Ok(Some(run.state));
            }
            Ok(store.latest_run(&connection, &id)?.map(|run| run.state))
        })
        .await
    }

    pub async fn fleet(&self, connection: String) -> BrowserResult<Vec<Value>> {
        let store = self.store.clone();
        blocking(move || store.fleet(&connection)).await
    }

    pub async fn list_modules(&self, connection: String) -> BrowserResult<Vec<Value>> {
        self.store.require_connection(&connection)?;
        let _gate = self.module_gate.lock().await;
        blocking(move || {
            wasm::list()
                .map_err(engine_error)?
                .into_iter()
                .map(|module| serde_json::to_value(module).map_err(storage_error))
                .collect()
        })
        .await
    }

    pub async fn module_permissions(&self, connection: String, id: String) -> BrowserResult<Value> {
        self.store.require_connection(&connection)?;
        let path = module_path(&self.store.modules_dir, &id)?;
        if !path.is_file() {
            return Err(BrowserError::new(
                "module_missing",
                "Module is not installed",
            ));
        }
        let _gate = self.module_gate.lock().await;
        let store = self.store.clone();
        blocking(move || {
            let digest = wasm::digest(&path);
            let granted = store
                .grant(&connection, &id, &digest)?
                .unwrap_or_else(|| json!(wasm::Grant::default()));
            Ok(json!({"asks":wasm::manifest_of(&id),"granted":granted}))
        })
        .await
    }

    /// Initialize once after WindowService, before exposing automation commands.
    /// `root` is the existing v2 application directory.
    pub fn new(
        database: PathBuf,
        root: PathBuf,
        windows: Arc<WindowService>,
    ) -> BrowserResult<Arc<Self>> {
        wasm::initialize(&root).map_err(engine_error)?;
        let store = AutomationStore::open(database.clone(), root.join("automation-modules"))?;
        store.interrupt_unfinished()?;
        // Unknown browser operations retain their shared WindowService reservation.
        // Releasing them at startup would permit conflicting lifecycle actions.
        for (profile, owner) in store.unreleased_resources()? {
            windows.restore_agent_window(&profile, &owner)?;
        }
        for run in store.unreleased_runs()? {
            if !store.interrupted_pending(&run)? {
                for (profile, owner) in store.resources(&run)? {
                    if windows.release_agent_window(&profile, &owner).is_ok() {
                        store.resource_flag(&run, &profile, "released")?;
                    }
                }
            }
        }
        store.prune_artifacts()?;
        Ok(Arc::new(Self {
            store,
            windows,
            root,
            groups: GroupStore::new(database).map_err(storage_error)?,
            editor_gate: tokio::sync::Mutex::new(()),
            editor_sessions: Mutex::new(HashMap::new()),
            module_gate: tokio::sync::Mutex::new(()),
            verified: Mutex::new(HashMap::new()),
            helper_offers: Mutex::new(HashMap::new()),
            helper_dismissed: Mutex::new(HashMap::new()),
            host_jobs: Mutex::new(HashMap::new()),
        }))
    }

    pub fn require_profile(&self, connection: &str, id: &str) -> BrowserResult<WindowRecord> {
        self.store.require_connection(connection)?;
        let record = self.windows.store.get(id).map_err(storage_error)?;
        if record.binding.connection_id != connection {
            return Err(BrowserError::new(
                "scope_mismatch",
                "Profile belongs to another Workspace",
            ));
        }
        Ok(record)
    }

    fn endpoint(&self, connection: &str, id: &str, owner: &str) -> BrowserResult<CdpEndpoint> {
        let record = self.require_profile(connection, id)?;
        let websocket = self
            .windows
            .automation_cdp_endpoint(connection, id, owner)?;
        let _ = record;
        // A debugger's UUID changes when the browser instance changes.
        let instance_id = format!("{:x}", Sha256::digest(websocket.as_bytes()));
        Ok(CdpEndpoint {
            web_socket_debugger_url: websocket,
            instance_id,
            capabilities: EngineCapabilities::default(),
        })
    }

    async fn verify_endpoint(&self, mut endpoint: CdpEndpoint) -> BrowserResult<CdpEndpoint> {
        if let Some(capabilities) = self
            .verified
            .lock()
            .map_err(storage_error)?
            .get(&endpoint.instance_id)
            .cloned()
        {
            endpoint.capabilities = capabilities;
            return Ok(endpoint);
        }
        let capabilities = probe_endpoint(&endpoint.web_socket_debugger_url).await?;
        self.verified
            .lock()
            .map_err(storage_error)?
            .insert(endpoint.instance_id.clone(), capabilities.clone());
        endpoint.capabilities = capabilities;
        Ok(endpoint)
    }

    pub fn client_capabilities(
        &self,
        connection: &str,
        id: Option<&str>,
    ) -> BrowserResult<ClientCapabilities> {
        let configured = self.windows.automation_connection(connection)?;
        let record = id
            .map(|id| self.require_profile(connection, id))
            .transpose()?;
        if record
            .as_ref()
            .is_some_and(|record| record.settings.alias_engine.as_deref() == Some("firefox"))
        {
            return Ok(ClientCapabilities {
                supported: false,
                reason: "AliasMode Firefox has no implemented automation transport".into(),
                features: Vec::new(),
                input_mode: "unavailable".into(),
            });
        }
        let _ = configured;
        let features = vec!["projects".into(), "runs".into(), "modules".into()];
        let verified = record.as_ref().and_then(|record| {
            self.editor_sessions
                .lock()
                .ok()?
                .get(&Self::editor_scope(connection).resource_key(&record.id))
                .cloned()
        });
        if let Some(endpoint) = verified {
            let mut features = features;
            let capabilities = endpoint.capabilities;
            if capabilities.native_shard || capabilities.chromium_input {
                features.extend(
                    [
                        "navigation",
                        "dom",
                        "pointer",
                        "keyboard",
                        "screenshot",
                        "screencast",
                    ]
                    .map(str::to_owned),
                );
            }
            if capabilities.script {
                features.push("script".into());
            }
            if capabilities.traffic {
                features.push("traffic".into());
            }
            if capabilities.touch {
                features.push("touch".into());
            }
            if capabilities.proxy_hot_swap {
                features.push("proxy-hot-swap".into());
            }
            return Ok(ClientCapabilities {
                supported: true,
                reason: String::new(),
                features,
                input_mode: if capabilities.native_shard {
                    "native-motion"
                } else {
                    "standard-cdp"
                }
                .into(),
            });
        }
        Ok(ClientCapabilities {
            supported: true,
            reason: "Live protocol capabilities are verified when a running Profile is attached"
                .into(),
            features,
            input_mode: "unavailable".into(),
        })
    }

    pub async fn run(
        self: &Arc<Self>,
        connection: String,
        project_id: String,
        operation_id: String,
    ) -> BrowserResult<Value> {
        let _modules = self.module_gate.lock().await;
        let service = self.clone();
        let (record, project, projects, created) = blocking(move || {
            if let Some(existing) = service.store.operation_run(&connection, &operation_id)? {
                if existing.project_id != project_id {
                    return Err(BrowserError::new(
                        "conflict",
                        "operationId already belongs to another project",
                    ));
                }
                return Ok((existing, None, Vec::new(), false));
            }
            if !service
                .store
                .recovery_runs(&connection, &project_id)?
                .is_empty()
            {
                return Err(BrowserError::new(
                    "operation_uncertain",
                    "Reconcile the previous run before starting this project again",
                ));
            }
            let project = service.store.get(&connection, &project_id)?;
            let projects = service.store.list(&connection)?;
            let mut visited = HashSet::new();
            service.validate_tree(&connection, &project, &projects, &mut visited)?;
            let mut identities = std::collections::BTreeMap::new();
            for dependency in projects
                .iter()
                .filter(|project| visited.contains(&project.id))
            {
                identities.extend(service.store.freeze_modules(dependency)?);
            }
            let snapshot =
                json!({"version":1,"project":project,"projects":projects,"modules":identities});
            match service
                .store
                .begin_run(&connection, &project_id, &operation_id, snapshot)?
            {
                RunIntent::Created(record) => Ok((record, Some(project), projects, true)),
                RunIntent::Existing(record) => Ok((record, None, Vec::new(), false)),
            }
        })
        .await?;
        if !created {
            return Ok(record.state);
        }
        let host: Arc<dyn EngineHost> = Arc::new(RaccoonHost {
            service: self.clone(),
            scope: EngineScope {
                connection_id: record.connection_id.clone(),
                run_id: record.id.clone(),
                project_id: record.project_id.clone(),
            },
        });
        if let Err(error) = self.prepare_module_grants(&record.connection_id) {
            self.store.update_run(&record.id, "failed", record.state)?;
            return Err(error);
        }
        match runner::start(
            host,
            project.ok_or_else(|| invalid("Missing run snapshot"))?,
            projects,
        )
        .await
        {
            Ok(state) => {
                if self.store.cancelled(&record.id)? {
                    runner::stop(&record.connection_id, &record.id);
                }
                serde_json::to_value(state).map_err(storage_error)
            }
            Err(error) => {
                let mut state = record.state;
                state["log"] = json!(["Run could not start"]);
                self.store.update_run(&record.id, "failed", state)?;
                Err(engine_error(error))
            }
        }
    }

    fn prepare_module_grants(&self, connection: &str) -> BrowserResult<()> {
        // Every run freezes all installed modules, so materialize grants from
        // the requested connection while holding the service mutation gate.
        for entry in std::fs::read_dir(&self.store.modules_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("wasm") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or_else(|| invalid("Invalid module filename"))?;
            let digest = wasm::digest(&path);
            let grant = self
                .store
                .grant(connection, id, &digest)?
                .unwrap_or_else(|| json!({"decided_for":digest,"call_modules":[],"call_flows":[]}));
            let grant_path = self.store.modules_dir.join(format!("{id}.grant.json"));
            let staging = grant_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staging)
                .map_err(storage_error)?;
            file.write_all(&serde_json::to_vec(&grant).map_err(storage_error)?)
                .map_err(storage_error)?;
            file.sync_all().map_err(storage_error)?;
            // Windows rename cannot replace existing files. These materialized
            // grant files are derived from SQLite and are never read by live runs.
            if grant_path.exists() {
                std::fs::remove_file(&grant_path).map_err(storage_error)?;
            }
            std::fs::rename(staging, grant_path).map_err(storage_error)?;
        }
        Ok(())
    }

    fn validate_tree(
        &self,
        connection: &str,
        project: &Project,
        projects: &[Project],
        visited: &mut HashSet<String>,
    ) -> BrowserResult<()> {
        if !visited.insert(project.id.clone()) {
            return Ok(());
        }
        let issues = self.store.references(connection, project)?;
        if !issues.is_empty() {
            let locations = issues
                .iter()
                .map(|issue| format!("{} ({})", issue.path, issue.kind))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(BrowserError::new(
                "unresolved_references",
                format!("Project {} requires bindings at {locations}", project.id),
            ));
        }
        for block in project
            .blocks
            .iter()
            .filter(|block| block.enabled && block.kind == "flow.call")
        {
            let id = block.params["project"].as_str().unwrap_or("");
            let name = block.params["projectName"].as_str().unwrap_or("");
            if !id.contains("{{") && !name.contains("{{") {
                let target = projects
                    .iter()
                    .find(|project| {
                        if id.is_empty() {
                            project.name == name
                        } else {
                            project.id == id
                        }
                    })
                    .ok_or_else(|| invalid("Subflow is absent from this Workspace"))?;
                self.validate_tree(connection, target, projects, visited)?;
            }
        }
        Ok(())
    }

    pub fn stop(&self, connection: &str, project: &str) -> BrowserResult<()> {
        let record = self.store.latest_run(connection, project)?;
        if let Some(record) = record {
            self.store.request_cancel(&record.id)?;
            if record.phase == "interrupted" {
                if self.store.interrupted_pending(&record.id)? {
                    return Err(BrowserError::new(
                        "operation_uncertain",
                        "Interrupted steps retain their leases until external results are reconciled",
                    ));
                }
                for (profile, owner) in self.store.resources(&record.id)? {
                    self.windows.reconcile_agent_window(&profile, &owner)?;
                    self.windows.release_agent_window(&profile, &owner)?;
                    self.store.resource_flag(&record.id, &profile, "released")?;
                }
                return Ok(());
            }
            if matches!(
                record.phase.as_str(),
                "intent" | "running" | "stopping" | "reconciling"
            ) {
                runner::stop(connection, &record.id);
                self.store
                    .update_run(&record.id, "stopping", record.state)?;
            }
        }
        Ok(())
    }

    pub fn editor_scope(connection: &str) -> EngineScope {
        EngineScope {
            connection_id: connection.into(),
            run_id: "editor".into(),
            project_id: String::new(),
        }
    }

    fn editor_owner(connection: &str) -> String {
        format!(
            "automation-editor:{:x}",
            Sha256::digest(connection.as_bytes())
        )
    }

    pub async fn attach(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        connection: String,
        id: String,
    ) -> BrowserResult<()> {
        let _gate = self.editor_gate.lock().await;
        let service = self.clone();
        let scope = Self::editor_scope(&connection);
        let key = scope.resource_key(&id);
        let owner = Self::editor_owner(&connection);
        let profile = id.clone();
        let workspace = connection.clone();
        let lease_owner = owner.clone();
        let endpoint = blocking(move || {
            service.require_profile(&workspace, &profile)?;
            service
                .windows
                .acquire_agent_window(&profile, &lease_owner)?;
            match service.endpoint(&workspace, &profile, &lease_owner) {
                Ok(endpoint) => Ok(endpoint),
                Err(error) => {
                    service
                        .windows
                        .release_agent_window(&profile, &lease_owner)?;
                    Err(error)
                }
            }
        })
        .await?;
        let endpoint = match self.verify_endpoint(endpoint).await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                self.windows.release_agent_window(&id, &owner)?;
                return Err(error);
            }
        };
        let frame_app = app.clone();
        let nav_app = app.clone();
        let frame_scope = connection.clone();
        let nav_scope = connection.clone();
        let traffic_scope = connection.clone();
        let traffic_profile = id.clone();
        let attached = cdp::with_scope(scope, 0, async {
            cdp::attach_with(
                id.clone(),
                endpoint.clone(),
                move |frame| {
                    if let Ok(mut payload) = serde_json::to_value(frame) {
                        payload["connection_id"] = json!(frame_scope);
                        let _ = frame_app.emit("automation:frame", payload);
                    }
                },
                move |profile, url| {
                    let _ = nav_app.emit(
                        "automation:navigated",
                        json!({"connection_id":nav_scope,"profile_id":profile,"url":url}),
                    );
                },
                move |method, params| {
                    let event = match method.as_str() {
                        "Traffic.requestPaused" => "automation:traffic-paused",
                        "Traffic.requestObserved" => "automation:traffic-observed",
                        _ => return,
                    };
                    let mut payload = params;
                    payload["connection_id"] = json!(traffic_scope);
                    payload["profile_id"] = json!(traffic_profile);
                    let _ = app.emit(event, payload);
                },
            )
            .await
        })
        .await;
        if let Err(error) = attached {
            self.windows.release_agent_window(&id, &owner)?;
            return Err(engine_error(error));
        }
        self.editor_sessions
            .lock()
            .map_err(storage_error)?
            .insert(key, endpoint);
        Ok(())
    }

    pub async fn detach(&self, connection: &str, id: &str) -> BrowserResult<()> {
        let _gate = self.editor_gate.lock().await;
        self.require_profile(connection, id)?;
        let scope = Self::editor_scope(connection);
        let exists = self
            .editor_sessions
            .lock()
            .map_err(storage_error)?
            .contains_key(&scope.resource_key(id));
        if exists {
            let key = scope.resource_key(id);
            cdp::with_scope(scope, 0, async { cdp::release_preview(id).await })
                .await
                .map_err(engine_error)?;
            self.windows
                .release_agent_window(id, &Self::editor_owner(connection))?;
            self.editor_sessions
                .lock()
                .map_err(storage_error)?
                .remove(&key);
        }
        Ok(())
    }

    pub async fn attached(&self, connection: &str, id: &str) -> BrowserResult<bool> {
        self.require_profile(connection, id)?;
        let scope = Self::editor_scope(connection);
        let endpoint = self
            .editor_sessions
            .lock()
            .map_err(storage_error)?
            .get(&scope.resource_key(id))
            .cloned();
        Ok(match endpoint {
            Some(endpoint) => {
                cdp::with_scope(scope, 0, async {
                    cdp::matches_instance(id, &endpoint.instance_id) && cdp::is_attached(id)
                })
                .await
            }
            None => false,
        })
    }

    pub async fn editor_call(
        self: &Arc<Self>,
        connection: String,
        id: String,
        method: String,
        params: Value,
    ) -> BrowserResult<Value> {
        let _gate = self.editor_gate.lock().await;
        self.validate_editor(&connection, &id).await?;
        cdp::with_scope(Self::editor_scope(&connection), 0, async {
            cdp::page_call(&id, &method, params)
                .await
                .map_err(engine_error)
        })
        .await
    }

    pub async fn validate_editor(
        self: &Arc<Self>,
        connection: &str,
        id: &str,
    ) -> BrowserResult<()> {
        let service = self.clone();
        let workspace = connection.to_owned();
        let profile = id.to_owned();
        let endpoint = blocking(move || {
            service.endpoint(&workspace, &profile, &Self::editor_owner(&workspace))
        })
        .await?;
        let scope = Self::editor_scope(connection);
        let known = self
            .editor_sessions
            .lock()
            .map_err(storage_error)?
            .get(&scope.resource_key(id))
            .cloned()
            .ok_or_else(|| {
                BrowserError::new("not_attached", "Attach this Profile before controlling it")
            })?;
        if known.instance_id != endpoint.instance_id {
            cdp::with_scope(scope, 0, async {
                cdp::detach(id);
            })
            .await;
            return Err(BrowserError::new(
                "instance_changed",
                "Browser instance changed; attach again",
            ));
        }
        Ok(())
    }

    pub async fn screencast(
        self: &Arc<Self>,
        connection: &str,
        id: &str,
        on: bool,
        width: u32,
        height: u32,
    ) -> BrowserResult<()> {
        let _gate = self.editor_gate.lock().await;
        self.validate_editor(connection, id).await?;
        cdp::with_scope(Self::editor_scope(connection), 0, async {
            if on {
                cdp::start_screencast(id, width, height).await
            } else {
                cdp::stop_screencast(id).await
            }
            .map_err(engine_error)
        })
        .await
    }

    pub async fn pick(
        self: &Arc<Self>,
        connection: &str,
        id: &str,
        x: f64,
        y: f64,
    ) -> BrowserResult<Value> {
        let _gate = self.editor_gate.lock().await;
        self.validate_editor(connection, id).await?;
        cdp::with_scope(Self::editor_scope(connection), 0, async {
            serde_json::to_value(cdp::pick_element(id, x, y).await.map_err(engine_error)?)
                .map_err(storage_error)
        })
        .await
    }

    pub async fn grant_module(
        self: &Arc<Self>,
        connection: String,
        id: String,
        modules: Vec<String>,
        flows: Vec<String>,
    ) -> BrowserResult<Value> {
        self.store.require_connection(&connection)?;
        module_path(&self.store.modules_dir, &id)?;
        for target in &modules {
            if target == "*" {
                continue;
            }
            if !module_path(&self.store.modules_dir, target)?.is_file() {
                return Err(invalid("Granted module is missing"));
            }
        }
        for target in &flows {
            if target == "*" {
                continue;
            }
            self.store.get(&connection, target)?;
        }
        let _gate = self.module_gate.lock().await;
        let service = self.clone();
        blocking(move || {
            let digest = wasm::digest(&module_path(&service.store.modules_dir, &id)?);
            if digest.is_empty() {
                return Err(invalid("Module is missing or unreadable"));
            }
            let grant = wasm::Grant {
                decided_for: digest,
                call_modules: modules,
                call_flows: flows,
            };
            let value = serde_json::to_value(&grant).map_err(storage_error)?;
            service
                .store
                .set_grant(&connection, &id, &grant.decided_for, &value)?;
            Ok(value)
        })
        .await
    }

    fn helper_key(connection: &str, profile: &str) -> String {
        json!([connection, profile]).to_string()
    }

    /// The native kernel bus submits its generated offer here. Reports are
    /// instance-scoped and must be invalidated when that bus connection closes.
    pub fn helper_report(
        &self,
        connection: &str,
        profile: &str,
        report: Option<Value>,
    ) -> BrowserResult<()> {
        self.require_profile(connection, profile)?;
        let key = Self::helper_key(connection, profile);
        let mut offers = self.helper_offers.lock().map_err(storage_error)?;
        match report {
            Some(report) => {
                let fields = report["fields"]
                    .as_array()
                    .ok_or_else(|| invalid("Invalid kernel helper report"))?;
                if fields.len() > 500
                    || fields.iter().any(|field| {
                        !field["kind"].is_string()
                            || !field["select"].is_boolean()
                            || field["x"].as_f64().is_none()
                            || field["y"].as_f64().is_none()
                    })
                {
                    return Err(invalid("Invalid kernel helper fields"));
                }
                offers.insert(key, report);
            }
            None => {
                offers.remove(&key);
            }
        }
        Ok(())
    }

    pub async fn helper_fields(
        self: &Arc<Self>,
        _app: tauri::AppHandle,
        connection: &str,
        profile: &str,
    ) -> BrowserResult<Value> {
        self.require_profile(connection, profile)?;
        Ok(self
            .helper_offers
            .lock()
            .map_err(storage_error)?
            .get(&Self::helper_key(connection, profile))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn helper_profiles(
        self: &Arc<Self>,
        _app: tauri::AppHandle,
        connection: &str,
    ) -> BrowserResult<Vec<String>> {
        self.store.require_connection(connection)?;
        let offers = self.helper_offers.lock().map_err(storage_error)?;
        let dismissed = self.helper_dismissed.lock().map_err(storage_error)?;
        let mut profiles = Vec::new();
        for (key, offer) in offers.iter() {
            let binding: Vec<String> = serde_json::from_str(key).map_err(storage_error)?;
            if binding.first().map(String::as_str) == Some(connection)
                && offer["fields"]
                    .as_array()
                    .is_some_and(|fields| !fields.is_empty())
                && dismissed.get(key) != Some(&offer.to_string())
            {
                if let Some(profile) = binding.get(1) {
                    profiles.push(profile.clone());
                }
            }
        }
        Ok(profiles)
    }

    pub async fn helper_fill(
        self: &Arc<Self>,
        _app: tauri::AppHandle,
        connection: &str,
        profile: &str,
    ) -> BrowserResult<usize> {
        let record = self.require_profile(connection, profile)?;
        if record.binding.provider_id != BrowserProviderId::ShardBrowser {
            return Err(BrowserError::unsupported(
                "This Provider has no native generated-person helper protocol",
            ));
        }
        let _gate = self.editor_gate.lock().await;
        let owner = Self::editor_owner(connection);
        self.windows.acquire_agent_window(profile, &owner)?;
        let filled = super::helper::fill(connection, profile);
        let attached = self
            .editor_sessions
            .lock()
            .map_err(storage_error)?
            .contains_key(&Self::editor_scope(connection).resource_key(profile));
        if !attached {
            self.windows.release_agent_window(profile, &owner)?;
        }
        filled
    }

    pub async fn helper_dismiss(
        self: &Arc<Self>,
        _app: tauri::AppHandle,
        connection: &str,
        profile: &str,
    ) -> BrowserResult<()> {
        self.require_profile(connection, profile)?;
        let key = Self::helper_key(connection, profile);
        if let Some(report) = self.helper_offers.lock().map_err(storage_error)?.get(&key) {
            self.helper_dismissed
                .lock()
                .map_err(storage_error)?
                .insert(key, report.to_string());
        }
        Ok(())
    }

    pub async fn launch(
        self: &Arc<Self>,
        connection: String,
        id: String,
        restart: bool,
    ) -> BrowserResult<u32> {
        let _gate = self.editor_gate.lock().await;
        let service = self.clone();
        blocking(move || {
            service.require_profile(&connection, &id)?;
            let owner = Self::editor_owner(&connection);
            service.windows.acquire_agent_window(&id, &owner)?;
            let result = (|| {
                if restart {
                    service
                        .windows
                        .stop_automation_window(&connection, &id, &owner)?;
                }
                service.windows.start_agent_window(&id, &owner)?;
                let endpoint = service.endpoint(&connection, &id, &owner)?;
                let port = url::Url::parse(&endpoint.web_socket_debugger_url)
                    .map_err(|_| invalid("Invalid debugger endpoint"))?
                    .port()
                    .ok_or_else(|| invalid("Debugger endpoint has no port"))?;
                Ok(u32::from(port))
            })();
            // launch does not attach or retain an action controller.
            if !service
                .editor_sessions
                .lock()
                .map_err(storage_error)?
                .contains_key(&Self::editor_scope(&connection).resource_key(&id))
            {
                service.windows.release_agent_window(&id, &owner)?;
            }
            result
        })
        .await
    }

    pub async fn install_module(&self, connection: &str, path: String) -> BrowserResult<Value> {
        self.store.require_connection(connection)?;
        let _gate = self.module_gate.lock().await;
        blocking(move || {
            serde_json::to_value(wasm::install(&path).map_err(engine_error)?).map_err(storage_error)
        })
        .await
    }

    pub async fn remove_module(&self, connection: &str, id: String) -> BrowserResult<()> {
        self.store.require_connection(connection)?;
        let _gate = self.module_gate.lock().await;
        blocking(move || wasm::remove(&id).map_err(engine_error)).await
    }

    pub async fn export_bundle(&self, connection: &str, project: &str) -> BrowserResult<Value> {
        use base64::Engine;
        let _gate = self.module_gate.lock().await;
        let mut bundle = self.store.export(connection, project)?;
        let mut files = Vec::new();
        for id in bundle["modules"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let path = module_path(&self.store.modules_dir, id)?;
            if !path.exists() {
                continue;
            }
            let bytes = std::fs::read(path).map_err(storage_error)?;
            let mut gzip =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gzip.write_all(&bytes).map_err(storage_error)?;
            files.push(json!({"id":id,"wasm":base64::engine::general_purpose::STANDARD.encode(gzip.finish().map_err(storage_error)?)}));
        }
        bundle["module_files"] = json!(files);
        Ok(bundle)
    }

    pub async fn import_bundle(&self, connection: &str, bundle: Value) -> BrowserResult<Project> {
        use base64::Engine;
        self.store.require_connection(connection)?;
        if bundle["format"] != 1
            || bundle
                .get("raccoon")
                .is_some_and(|value| value["version"] != 1)
        {
            return Err(invalid("Unsupported automation bundle version"));
        }
        let _: Project = serde_json::from_value(bundle["project"].clone())
            .map_err(|_| invalid("Invalid bundle project"))?;
        let _gate = self.module_gate.lock().await;
        let mut prepared = Vec::new();
        let mut seen = HashSet::new();
        for file in bundle["module_files"].as_array().into_iter().flatten() {
            let id = file["id"]
                .as_str()
                .ok_or_else(|| invalid("Bundle module id missing"))?;
            let path = module_path(&self.store.modules_dir, id)?;
            if !seen.insert(id.to_owned()) {
                return Err(invalid("Duplicate module in bundle"));
            }
            if path.exists() {
                continue;
            }
            let raw = file["wasm"]
                .as_str()
                .ok_or_else(|| invalid("Bundle module data missing"))?;
            if raw.len() > 48 * 1024 * 1024 {
                return Err(invalid("Bundle module is too large"));
            }
            let gzip = base64::engine::general_purpose::STANDARD
                .decode(raw)
                .map_err(|_| invalid("Invalid module encoding"))?;
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(gzip.as_slice())
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| invalid("Invalid compressed WASM module"))?;
            if bytes.len() > 32 * 1024 * 1024 || !bytes.starts_with(b"\0asm") {
                return Err(invalid("Invalid or oversized WASM module"));
            }
            prepared.push((id.to_owned(), bytes));
        }
        // A unique staging directory preserves module file stems expected by the ABI.
        let staging = self
            .root
            .join("automation-imports")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&staging).map_err(storage_error)?;
        let mut installed = Vec::new();
        let result = (|| {
            for (id, bytes) in prepared {
                let path = module_path(&staging, &id)?;
                std::fs::write(&path, bytes).map_err(storage_error)?;
                wasm::install(&path.to_string_lossy()).map_err(engine_error)?;
                installed.push(id);
            }
            self.store.import(connection, bundle)
        })();
        if result.is_err() {
            for id in installed {
                wasm::remove(&id).map_err(engine_error)?;
            }
        }
        let _ = std::fs::remove_dir_all(staging);
        result
    }
}

#[derive(Clone)]
pub struct RaccoonHost {
    service: Arc<AutomationService>,
    scope: EngineScope,
}

impl RaccoonHost {
    async fn offload<T: Send + 'static>(
        &self,
        work: impl FnOnce(Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let counter = self
            .service
            .host_jobs
            .lock()
            .map_err(storage_error)?
            .entry(self.scope.run_id.clone())
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone();
        counter.fetch_add(1, Ordering::AcqRel);
        struct Job(Arc<AtomicUsize>);
        impl Drop for Job {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let host = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _job = Job(counter);
            work(host)
        })
        .await
        .map_err(|_| anyhow!("Automation host task interrupted"))?
    }
    fn reconcile_lifecycle(&self, intent: &StepIntent) -> Result<Reconciliation> {
        let method = match intent.key.kind.as_str() {
            "profile.create" | "profile.temp" => "create",
            "profile.keep" => "keep",
            "profile.delete" => "delete",
            "proxy.set" => "set_proxy",
            // A page action can contain a successful lazy start followed by an
            // unconfirmed page write. Confirming the start alone cannot confirm it.
            _ => return Ok(Reconciliation::Pending),
        };
        let input = self
            .service
            .store
            .step_input(&self.scope.run_id, &intent.id)?;
        let actions = self.service.store.actions(&self.scope.run_id)?;
        let persisted_target = if method == "delete" {
            actions.iter().find_map(|(action, _, payload, _)| {
                let target = payload["id"].as_str()?;
                (action == &self.action_id(intent, method, target)).then(|| target.to_owned())
            })
        } else {
            None
        };
        let profile = if method == "create" {
            String::new()
        } else if method == "delete" {
            persisted_target.unwrap_or_else(|| {
                input["params"]["id"]
                    .as_str()
                    .filter(|id| !id.contains("{{") && !id.is_empty())
                    .or_else(|| input["profile"]["id"].as_str())
                    .unwrap_or("")
                    .to_owned()
            })
        } else {
            input["profile"]["id"].as_str().unwrap_or("").to_owned()
        };
        let id = self.action_id(intent, method, &profile);
        let action = actions.into_iter().find(|(action, _, _, _)| action == &id);
        let Some((_, phase, payload, result)) = action else {
            return Ok(Reconciliation::Pending);
        };
        if phase == "failed" {
            return Ok(Reconciliation::Failed(
                "Lifecycle operation was rejected before submission".into(),
            ));
        }
        let mut result = result;
        if phase != "completed" {
            if method != "create" {
                let mut operations = self
                    .service
                    .store
                    .action_operations(&self.scope.run_id, &id)?;
                if operations.is_empty() && !profile.is_empty() {
                    let all = self
                        .service
                        .store
                        .profile_operations(&self.scope.connection_id, &profile)?;
                    let baseline =
                        self.service
                            .store
                            .operation_baseline(&self.scope.run_id, &id, &[])?;
                    for operation in all
                        .into_iter()
                        .filter(|operation| !baseline.contains(&operation.id))
                    {
                        self.service.store.link_operation(
                            &self.scope.run_id,
                            &id,
                            &operation.id,
                        )?;
                        operations.push(operation);
                    }
                }
                if operations.is_empty() {
                    return Ok(Reconciliation::Pending);
                }
                if operations.iter().any(|operation| {
                    operation.connection_id != self.scope.connection_id
                        || operation.window_id != profile
                }) {
                    return Err(anyhow!("Lifecycle binding changed"));
                }
                if operations
                    .iter()
                    .any(|operation| matches!(operation.phase.as_str(), "failed" | "cancelled"))
                {
                    return Ok(Reconciliation::Failed(
                        "Lifecycle operation was confirmed unsuccessful".into(),
                    ));
                }
                if operations
                    .iter()
                    .any(|operation| operation.phase != "committed")
                {
                    for operation in operations.iter().filter(|operation| {
                        operation.phase != "committed"
                            && matches!(
                                operation.kind.as_str(),
                                "update" | "delete" | "start" | "stop"
                            )
                    }) {
                        self.service.windows.reconcile_automation_operation(
                            &self.scope.connection_id,
                            &operation.id,
                            &self.owner(intent.key.worker),
                        )?;
                    }
                    operations = self
                        .service
                        .store
                        .action_operations(&self.scope.run_id, &id)?;
                    if operations
                        .iter()
                        .any(|operation| matches!(operation.phase.as_str(), "failed" | "cancelled"))
                    {
                        return Ok(Reconciliation::Failed(
                            "Lifecycle operation was confirmed unsuccessful".into(),
                        ));
                    }
                    if operations
                        .iter()
                        .any(|operation| operation.phase != "committed")
                    {
                        return Ok(Reconciliation::Pending);
                    }
                }
                if method == "keep" {
                    self.service
                        .store
                        .resource_flag(&self.scope.run_id, &profile, "retained")?;
                }
                self.service
                    .store
                    .complete_action(&self.scope.run_id, &id, &Value::Null)?;
            } else {
                let Some(operation) = self.service.store.browser_operation(&id)? else {
                    return Ok(Reconciliation::Pending);
                };
                if operation.connection_id != self.scope.connection_id {
                    return Err(anyhow!("Lifecycle operation scope mismatch"));
                }
                if operation.phase != "committed" {
                    // WindowService only reads/reconciles this operation. It never resends create.
                    match self.service.windows.reconcile_automation_operation(
                        &self.scope.connection_id,
                        &id,
                        &self.owner(intent.key.worker),
                    ) {
                        Ok(_) => {}
                        Err(_) => return Ok(Reconciliation::Pending),
                    }
                }
                let Some(operation) = self.service.store.browser_operation(&id)? else {
                    return Ok(Reconciliation::Pending);
                };
                if operation.phase == "failed" || operation.phase == "cancelled" {
                    return Ok(Reconciliation::Failed(
                        "Profile creation was confirmed unsuccessful".into(),
                    ));
                }
                if operation.phase != "committed" {
                    return Ok(Reconciliation::Pending);
                }
                let profile = self.bind(
                    intent.key.worker,
                    &operation.window_id,
                    payload["temporary"] == true,
                )?;
                let value = serde_json::to_value(profile)?;
                self.service
                    .store
                    .complete_action(&self.scope.run_id, &id, &value)?;
                result = Some(value);
            }
        }
        let mut completion = StepCompletion {
            flow: "next".into(),
            variables: serde_json::from_value(input["variables"].clone()).unwrap_or_default(),
            profile_id: input["profile"]["id"].as_str().unwrap_or("").into(),
            temporary: input["profile"]["temporary"].as_bool().unwrap_or(false),
            mobile: input["profile"]["mobile"].as_bool().unwrap_or(false),
            temporary_profiles: serde_json::from_value(input["temporary_profiles"].clone())
                .unwrap_or_default(),
        };
        if method == "create" {
            let made: HostProfile =
                serde_json::from_value(result.context("Created Profile result missing")?)?;
            completion.profile_id = made.id.clone();
            completion.temporary = made.temporary;
            completion.mobile = made.mobile;
            if made.temporary && !completion.temporary_profiles.contains(&made.id) {
                completion.temporary_profiles.push(made.id.clone());
            }
            if let Some(into) = input["params"]["into"]
                .as_str()
                .filter(|name| !name.is_empty())
            {
                completion.variables.insert(into.into(), made.id);
            }
        } else if method == "keep" {
            completion.temporary = false;
        } else if method == "delete" && completion.profile_id == profile {
            completion.profile_id.clear();
            completion.temporary = false;
            completion.mobile = false;
        }
        // The engine calls complete_step after accepting this confirmed result.
        Ok(Reconciliation::Committed(completion))
    }

    fn owner(&self, worker: usize) -> String {
        format!("automation:{}:{worker}", self.scope.run_id)
    }

    fn action_id(&self, intent: &StepIntent, method: &str, profile: &str) -> String {
        let body = json!([self.scope.run_id, intent.id, method, profile]).to_string();
        let digest = Sha256::digest(body.as_bytes());
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        uuid::Uuid::from_bytes(bytes).to_string()
    }

    fn resource(&self, id: &str, worker: usize) -> BrowserResult<Value> {
        self.service
            .require_profile(&self.scope.connection_id, id)?;
        let resource = self
            .service
            .store
            .resource(&self.scope.run_id, id)?
            .ok_or_else(|| {
                BrowserError::new("permission_denied", "Run does not own this Profile")
            })?;
        if resource["worker"].as_u64() != Some(worker as u64) || resource["released"] == true {
            return Err(BrowserError::new(
                "profile_busy",
                "This worker does not control the Profile",
            ));
        }
        Ok(resource)
    }

    fn reacquire_resource(&self, id: &str, worker: usize) -> BrowserResult<Value> {
        let resource = self
            .service
            .store
            .resource(&self.scope.run_id, id)?
            .ok_or_else(|| BrowserError::new("permission_denied", "Run resource is missing"))?;
        if resource["worker"].as_u64() != Some(worker as u64) {
            return Err(BrowserError::new(
                "profile_busy",
                "Another worker controls this Profile",
            ));
        }
        if resource["released"] == true {
            self.bind(worker, id, resource["temporary"] == true)?;
        }
        self.resource(id, worker)
    }

    fn profile(&self, id: &str) -> BrowserResult<HostProfile> {
        let record = self
            .service
            .require_profile(&self.scope.connection_id, id)?;
        let resource = self.service.store.resource(&self.scope.run_id, id)?;
        let data = serde_json::to_value(&record).map_err(storage_error)?;
        let fingerprint = record
            .settings
            .shardbrowser
            .as_ref()
            .unwrap_or(&record.provider_config);
        let mobile = fingerprint
            .pointer("/client_hints/mobile")
            .and_then(Value::as_bool)
            == Some(true)
            || fingerprint
                .pointer("/navigator/user_agent_data/mobile")
                .and_then(Value::as_bool)
                == Some(true)
            || [
                "/client_hints/platform",
                "/navigator/user_agent",
                "/_meta/platform",
                "/browserFingerPrint/ua",
                "/fingerprint_config/ua",
            ]
            .iter()
            .filter_map(|path| fingerprint.pointer(path).and_then(Value::as_str))
            .any(|value| {
                let value = value.to_ascii_lowercase();
                value.contains("android") || value.contains("iphone") || value.contains("ipad")
            });
        Ok(HostProfile {
            id: record.id,
            name: record.name,
            mobile,
            temporary: resource.as_ref().is_some_and(|resource| {
                resource["temporary"] == true && resource["retained"] != true
            }),
            data,
        })
    }

    fn bind(&self, worker: usize, id: &str, temporary: bool) -> BrowserResult<HostProfile> {
        self.service
            .require_profile(&self.scope.connection_id, id)?;
        let owner = self.owner(worker);
        self.service.windows.acquire_agent_window(id, &owner)?;
        if let Err(error) =
            self.service
                .store
                .own_resource(&self.scope.run_id, id, worker, &owner, temporary)
        {
            self.service.windows.release_agent_window(id, &owner)?;
            return Err(error);
        }
        self.profile(id)
    }

    fn update_input(&self, id: &str) -> BrowserResult<UpdateWindowInput> {
        let record = self
            .service
            .require_profile(&self.scope.connection_id, id)?;
        let group_id = self
            .service
            .windows
            .store
            .group_id(id)
            .map_err(storage_error)?;
        Ok(UpdateWindowInput {
            id: record.id,
            name: record.name,
            proxy_mode: record.proxy_mode,
            proxy: record.proxy,
            proxy_id: record.proxy_id,
            proxy_plugin: record.proxy_plugin,
            proxy_endpoint: record.proxy_endpoint,
            settings: record.settings,
            group_id,
        })
    }

    fn folder(&self, folder: &str) -> BrowserResult<Option<String>> {
        if folder.is_empty() {
            return Ok(None);
        }
        let folders = self
            .service
            .groups
            .list_for_connection(&self.scope.connection_id)
            .map_err(storage_error)?;
        if let Some(found) = folders
            .into_iter()
            .find(|candidate| candidate.id == folder || candidate.name == folder)
        {
            return Ok(Some(found.id));
        }
        if uuid::Uuid::parse_str(folder).is_ok() {
            return Err(invalid("Folder UUID is absent from this Workspace"));
        }
        match self
            .service
            .groups
            .create_for_connection(&self.scope.connection_id, folder, "")
        {
            Ok(created) => Ok(Some(created.id)),
            Err(error) => {
                // A parallel worker may have committed the same named folder.
                let existing = self
                    .service
                    .groups
                    .list_for_connection(&self.scope.connection_id)
                    .map_err(storage_error)?;
                existing
                    .into_iter()
                    .find(|candidate| candidate.name == folder)
                    .map(|folder| Some(folder.id))
                    .ok_or_else(|| storage_error(error))
            }
        }
    }

    /// A dispatched mutation has only one durable attempt. Any unresolved failure
    /// suspends the worker through OutcomeUnknown before upstream retry branching.
    fn mutate<T: serde::de::DeserializeOwned + Serialize>(
        &self,
        intent: &StepIntent,
        method: &str,
        profile: &str,
        payload: Value,
        action: impl FnOnce(&str) -> BrowserResult<T>,
    ) -> Result<T> {
        if intent.key.kind != "engine.cleanup"
            && self.service.store.cancelled(&self.scope.run_id)?
        {
            return Err(BrowserError::new(
                "not_submitted",
                "Run was cancelled before lifecycle submission",
            )
            .into());
        }
        let id = self.action_id(intent, method, profile);
        let before = if profile.is_empty() {
            Vec::new()
        } else {
            self.service
                .store
                .profile_operations(&self.scope.connection_id, profile)?
                .into_iter()
                .map(|operation| operation.id)
                .collect::<Vec<_>>()
        };
        let baseline = self
            .service
            .store
            .operation_baseline(&self.scope.run_id, &id, &before)?;
        self.service
            .store
            .link_action(&self.scope.run_id, &id, &intent.id)?;
        match self
            .service
            .store
            .begin_action(&self.scope.run_id, &id, &payload)
        {
            Ok(ActionIntent::Completed(value)) => return Ok(serde_json::from_value(value)?),
            Ok(ActionIntent::New) => {}
            Ok(ActionIntent::Rejected(error)) => return Err(error.into()),
            Err(error) if error.code == "operation_uncertain" => {
                return Err(outcome_unknown(error));
            }
            Err(error) => return Err(error.into()),
        }
        let result = action(&id);
        if !profile.is_empty() {
            for operation in self
                .service
                .store
                .profile_operations(&self.scope.connection_id, profile)?
            {
                if !baseline.contains(&operation.id) {
                    self.service
                        .store
                        .link_operation(&self.scope.run_id, &id, &operation.id)
                        .map_err(outcome_unknown)?;
                }
            }
        }
        match result {
            Ok(result) => {
                let value = serde_json::to_value(&result)?;
                self.service
                    .store
                    .complete_action(&self.scope.run_id, &id, &value)
                    .map_err(outcome_unknown)?;
                Ok(result)
            }
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "invalid_config"
                        | "unsupported"
                        | "auth_required"
                        | "permission_denied"
                        | "not_submitted"
                        | "rate_limited"
                        | "profile_busy"
                        | "profile_missing"
                ) =>
            {
                self.service
                    .store
                    .reject_action(&self.scope.run_id, &id, &error)?;
                Err(error.into())
            }
            Err(error) => Err(outcome_unknown(error)),
        }
    }
}

fn collect_secrets(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let (Some(names), Some(params)) = (
                object.get("secrets").and_then(Value::as_array),
                object.get("params"),
            ) {
                for name in names.iter().filter_map(Value::as_str) {
                    if let Some(secret) = params
                        .get(name)
                        .and_then(Value::as_str)
                        .filter(|secret| !secret.is_empty())
                    {
                        secrets.push(secret.into());
                        if let Some(variable) = secret
                            .strip_prefix("{{")
                            .and_then(|value| value.strip_suffix("}}"))
                        {
                            secrets.push(format!("{{{{{variable}}}}}"));
                        }
                    }
                }
            }
            for (key, value) in object {
                let name = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    name.as_str(),
                    "password"
                        | "passwd"
                        | "secret"
                        | "token"
                        | "apikey"
                        | "authorization"
                        | "proxyauthorization"
                        | "cookie"
                        | "setcookie"
                        | "value"
                ) {
                    if let Some(secret) = value.as_str().filter(|secret| !secret.is_empty()) {
                        secrets.push(secret.into());
                    }
                }
                collect_secrets(value, secrets);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_secrets(value, secrets);
            }
        }
        Value::String(value) => {
            if let Ok(url) = url::Url::parse(value) {
                if !url.username().is_empty() {
                    secrets.push(url.username().into());
                }
                if let Some(password) = url.password().filter(|password| !password.is_empty()) {
                    secrets.push(password.into());
                }
            }
        }
        _ => {}
    }
}

fn sanitize_strings(value: &mut Value, secrets: &[String]) {
    match value {
        Value::Object(object) => {
            for value in object.values_mut() {
                sanitize_strings(value, secrets);
            }
        }
        Value::Array(values) => {
            for value in values {
                sanitize_strings(value, secrets);
            }
        }
        Value::String(text) => {
            for secret in secrets {
                if !secret.is_empty() {
                    *text = text.replace(secret, "[redacted]");
                }
            }
        }
        _ => {}
    }
}

impl EngineHost for RaccoonHost {
    fn scope(&self) -> &EngineScope {
        &self.scope
    }
    fn data_root(&self) -> &Path {
        &self.service.root
    }

    fn begin_run<'a>(
        &'a self,
        project: &'a Project,
        projects: &'a [Project],
        modules: &'a Value,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let run = self
                .service
                .store
                .latest_run(&self.scope.connection_id, &self.scope.project_id)?
                .context("run intent missing")?;
            if run.id != self.scope.run_id
                || run.snapshot["project"] != serde_json::to_value(project)?
                || run.snapshot["projects"] != serde_json::to_value(projects)?
            {
                return Err(anyhow!("run snapshot or connection mismatch"));
            }
            if let Some(expected) = run.snapshot["modules"].as_object() {
                for (id, digest) in expected {
                    if modules.get(format!("{id}.wasm")) != Some(digest) {
                        return Err(anyhow!("WASM module differs from the persisted run intent"));
                    }
                }
            }
            let mut snapshot = run.snapshot;
            snapshot["engine_modules"] = modules.clone();
            self.service.store.seal_snapshot(&run.id, &snapshot)?;
            Ok(())
        })
    }

    fn persist_state<'a>(&'a self, state: &'a runner::RunState) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if state.connection_id != self.scope.connection_id
                || state.run_id != self.scope.run_id
                || state.project_id != self.scope.project_id
            {
                return Err(anyhow!("run state scope mismatch"));
            }
            let run = self
                .service
                .store
                .run_by_id(&self.scope.connection_id, &self.scope.run_id)?;
            if matches!(run.phase.as_str(), "completed" | "failed" | "cancelled")
                && !state.running
                && state.workers.iter().all(|worker| {
                    worker.pending_intent.is_none()
                        && matches!(worker.status.as_str(), "done" | "stopped" | "failed")
                })
                && self.service.store.resources(&self.scope.run_id)?.is_empty()
                && !self.service.store.interrupted_pending(&self.scope.run_id)?
            {
                let saved: runner::RunState = serde_json::from_value(run.state.clone())?;
                if serde_json::to_value(saved)? == serde_json::to_value(state)? {
                    return Ok(());
                }
            }
            let phase = if !state.running
                && (state.workers.iter().any(|worker| {
                    matches!(
                        worker.status.as_str(),
                        "reconciling" | "interrupted" | "persistence_error"
                    )
                }) || self.service.store.interrupted_pending(&self.scope.run_id)?)
            {
                "interrupted"
            } else if state.running {
                if state
                    .workers
                    .iter()
                    .any(|worker| worker.status == "reconciling")
                {
                    "reconciling"
                } else {
                    "running"
                }
            } else if state.workers.iter().any(|worker| worker.status == "failed") {
                "failed"
            } else if state
                .workers
                .iter()
                .any(|worker| worker.status == "stopped")
            {
                "cancelled"
            } else {
                "completed"
            };
            let mut persisted = serde_json::to_value(state)?;
            // Variables and step completions remain in dedicated private records.
            // Ordinary status/log responses carry no form values or arbitrary engine errors.
            if let Some(workers) = persisted["workers"].as_array_mut() {
                for worker in workers {
                    if let Some(object) = worker.as_object_mut() {
                        object.remove("variables");
                    }
                    if worker["status"] == "persistence_error" {
                        worker["status"] = json!("interrupted");
                    }
                    if worker["status"] == "failed" || worker["status"] == "reconciling" {
                        worker["note"] =
                            json!("Step requires inspection of its persisted operation intent");
                    }
                }
            }
            // Keep useful logs while removing every declared or observed secret.
            let mut secrets = Vec::new();
            collect_secrets(&run.snapshot, &mut secrets);
            if let Some(projects) = run.snapshot["projects"].as_array() {
                for project in projects {
                    if let Some(blocks) = project["blocks"].as_array() {
                        for block in blocks {
                            for name in block["secrets"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                            {
                                if let Some(reference) = block["params"][name]
                                    .as_str()
                                    .and_then(|value| value.strip_prefix("{{"))
                                    .and_then(|value| value.strip_suffix("}}"))
                                {
                                    for worker in &state.workers {
                                        if let Some(value) = worker
                                            .variables
                                            .get(reference)
                                            .filter(|value| !value.is_empty())
                                        {
                                            secrets.push(value.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for (_, _, payload, result) in self.service.store.actions(&self.scope.run_id)? {
                collect_secrets(&payload, &mut secrets);
                if let Some(result) = result {
                    collect_secrets(&result, &mut secrets);
                }
            }
            if let Some(workers) = persisted["workers"].as_array_mut() {
                for worker in workers {
                    if let Some(note) = worker.get_mut("note") {
                        sanitize_strings(note, &secrets);
                    }
                }
            }
            sanitize_strings(&mut persisted["log"], &secrets);
            redact_value(&mut persisted);
            self.service
                .store
                .update_run(&self.scope.run_id, phase, persisted)?;
            if matches!(phase, "completed" | "failed" | "cancelled") {
                self.service.store.prune_artifacts()?;
            }
            Ok(())
        })
    }

    fn allocate_step<'a>(
        &'a self,
        key: &'a StepKey,
        params: &'a Value,
    ) -> BoxFuture<'a, StepIntent> {
        Box::pin(async move {
            if key.kind != "engine.cleanup" && self.service.store.cancelled(&self.scope.run_id)? {
                return Err(anyhow!(
                    "Run cancellation was requested before step dispatch"
                ));
            }
            let id = self.service.store.allocate_step(
                &self.scope.run_id,
                &serde_json::to_value(key)?,
                params,
            )?;
            Ok(StepIntent {
                id,
                key: key.clone(),
            })
        })
    }

    fn complete_step<'a>(
        &'a self,
        intent: &'a StepIntent,
        result: &'a StepCompletion,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.service.store.finish_step(
                &self.scope.run_id,
                &intent.id,
                "completed",
                Some(&serde_json::to_value(result)?),
                None,
            )?;
            Ok(())
        })
    }

    fn fail_step<'a>(&'a self, intent: &'a StepIntent, _error: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.service.store.finish_step(
                &self.scope.run_id,
                &intent.id,
                "failed",
                None,
                Some("Step failed"),
            )?;
            Ok(())
        })
    }

    fn mark_unknown<'a>(&'a self, intent: &'a StepIntent, _reason: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.service.store.finish_step(
                &self.scope.run_id,
                &intent.id,
                "unknown",
                None,
                Some("Awaiting operation reconciliation"),
            )?;
            Ok(())
        })
    }

    fn reconcile<'a>(&'a self, intent: &'a StepIntent) -> BoxFuture<'a, Reconciliation> {
        Box::pin(async move {
            let intent = intent.clone();
            self.offload(move |host| {
                let (phase, completion) = host
                    .service
                    .store
                    .step_result(&host.scope.run_id, &intent.id)?;
                Ok(match (phase.as_str(), completion) {
                    ("completed", Some(completion)) => {
                        Reconciliation::Committed(serde_json::from_value(completion)?)
                    }
                    ("failed", _) => {
                        Reconciliation::Failed("Step failed with a confirmed result".into())
                    }
                    _ => host.reconcile_lifecycle(&intent)?,
                })
            })
            .await
        })
    }

    fn create_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        input: CreateProfile,
    ) -> BoxFuture<'a, HostProfile> {
        Box::pin(async move {
            let intent = intent.clone();
            self.offload(move |host| {
                let intent = &intent;
                let proxy_id = input
                    .inline_proxy
                    .as_deref()
                    .map(|proxy| {
                        host.service
                            .windows
                            .save_inline_proxy(proxy, Some(&host.action_id(intent, "create", "")))
                    })
                    .transpose()?;
                let folder = host.folder(&input.folder)?;
                let payload = json!({
                    "name": &input.name,
                    "folder": &input.folder,
                    "platform": &input.platform,
                    "proxyId": &proxy_id,
                    "temporary": input.temporary,
                });
                let proxy_mode = if proxy_id.is_some() {
                    ProxyMode::Manual
                } else {
                    ProxyMode::Direct
                };
                let mut settings = WindowSettings::default();
                if let Some(platform) = input.platform.filter(|platform| !platform.is_empty()) {
                    let connection = host
                        .service
                        .windows
                        .automation_connection(&host.scope.connection_id)?;
                    if connection.provider_id == BrowserProviderId::ShardBrowser {
                        let wanted = match platform.as_str() {
                            "windows" => "Windows",
                            "macos" => "macOS",
                            "linux" => "Linux",
                            "android" => "Android",
                            _ => {
                                return Err(
                                    invalid("Unsupported automation Profile platform").into()
                                );
                            }
                        };
                        let entries = crate::core::shardbrowser_fingerprints::list(
                            &host.service.windows,
                            &host.scope.connection_id,
                        )?;
                        let matching = entries
                            .iter()
                            .filter(|entry| {
                                entry.platform.eq_ignore_ascii_case(wanted)
                                    || wanted == "Android"
                                        && (entry.platform.starts_with("Android")
                                            || entry.platform.starts_with("Linux arm"))
                            })
                            .collect::<Vec<_>>();
                        if matching.is_empty() {
                            return Err(BrowserError::unsupported(
                                "No installed fingerprint template matches this platform",
                            )
                            .into());
                        }
                        let bytes = uuid::Uuid::new_v4();
                        let index = usize::from(bytes.as_bytes()[0]) % matching.len();
                        settings.shardbrowser = Some(matching[index].payload.clone());
                        // Kernel identity is taken from the validated fingerprint payload.
                        settings.operating_system = "host".into();
                    } else if platform == "android" {
                        return Err(BrowserError::unsupported(
                            "This Provider has no implemented Android profile creation mapping",
                        )
                        .into());
                    } else {
                        settings.operating_system = platform;
                    }
                }
                let created: HostProfile =
                    host.mutate(intent, "create", "", payload, |operation_id| {
                        let window = host.service.windows.create(CreateWindowInput {
                            operation_id: operation_id.into(),
                            connection_id: host.scope.connection_id.clone(),
                            name: if input.name.is_empty() {
                                "Automation Profile".into()
                            } else {
                                input.name
                            },
                            proxy_mode,
                            proxy: None,
                            proxy_id,
                            proxy_plugin: None,
                            proxy_endpoint: None,
                            settings,
                            group_id: folder,
                            kernel_version: None,
                        })?;
                        host.bind(intent.key.worker, &window.id, input.temporary)
                    })?;
                Ok(created)
            })
            .await
        })
    }

    fn use_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
    ) -> BoxFuture<'a, HostProfile> {
        Box::pin(async move {
            let intent = intent.clone();
            let id = id.to_owned();
            self.offload(move |host| {
                let intent = &intent;
                let id = id.as_str();
                Ok(host.bind(intent.key.worker, id, false)?)
            })
            .await
        })
    }

    fn read_profile<'a>(&'a self, id: &'a str) -> BoxFuture<'a, HostProfile> {
        Box::pin(async move {
            let id = id.to_owned();
            self.offload(move |host| {
                let id = id.as_str();
                Ok(host.profile(id)?)
            })
            .await
        })
    }

    fn keep_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
        folder: Option<String>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let intent = intent.clone();
            let id = id.to_owned();
            self.offload(move |host| {
                let intent = &intent;
                let id = id.as_str();
                host.resource(id, intent.key.worker)?;
                let mut input = host.update_input(id)?;
                if let Some(folder) = folder {
                    input.group_id = host.folder(&folder)?;
                }
                host.mutate(intent, "keep", id, json!({"folder":input.group_id}), |_| {
                    host.service.windows.update_automation_window(
                        &host.scope.connection_id,
                        &host.owner(intent.key.worker),
                        input,
                    )?;
                    host.service
                        .store
                        .resource_flag(&host.scope.run_id, id, "retained")
                })
            })
            .await
        })
    }

    fn delete_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
        temporary_only: bool,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let intent = intent.clone();
            let id = id.to_owned();
            self.offload(move |host| {
                let intent = &intent;
                let id = id.as_str();
                if intent.key.kind == "profile.delete"
                    && host
                        .service
                        .store
                        .resource(&host.scope.run_id, id)?
                        .is_none()
                {
                    host.bind(intent.key.worker, id, false)?;
                }
                let resource = host.reacquire_resource(id, intent.key.worker)?;
                if temporary_only && (resource["temporary"] != true || resource["retained"] == true)
                {
                    return Ok(());
                }
                host.mutate(
                    intent,
                    "delete",
                    id,
                    json!({"id":id,"temporary_only":temporary_only}),
                    |_| {
                        host.service.windows.delete_automation_window(
                            &host.scope.connection_id,
                            id,
                            &host.owner(intent.key.worker),
                            true,
                        )?;
                        Ok(())
                    },
                )
            })
            .await
        })
    }

    fn start_profile<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
    ) -> BoxFuture<'a, CdpEndpoint> {
        Box::pin(async move {
            let step = intent.clone();
            let profile = id.to_owned();
            let endpoint = self
                .offload(move |host| {
                    let id = profile.as_str();
                    let intent = &step;
                    host.resource(id, intent.key.worker)?;
                    host.mutate(intent, "start", id, json!({"id":id}), |_| {
                        let state = host.service.windows.agent_window_snapshot(id)?;
                        let was_running = state["state"] == "running";
                        host.service
                            .windows
                            .start_agent_window(id, &host.owner(intent.key.worker))?;
                        if !was_running {
                            host.service
                                .store
                                .resource_flag(&host.scope.run_id, id, "started")?;
                        }
                        host.service.endpoint(
                            &host.scope.connection_id,
                            id,
                            &host.owner(intent.key.worker),
                        )
                    })
                })
                .await?;
            Ok(self.service.verify_endpoint(endpoint).await?)
        })
    }

    fn stop_profile<'a>(&'a self, intent: &'a StepIntent, id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let intent = intent.clone();
            let id = id.to_owned();
            self.offload(move |host| {
                let intent = &intent;
                let id = id.as_str();
                if intent.key.kind == "profile.delete"
                    && host
                        .service
                        .store
                        .resource(&host.scope.run_id, id)?
                        .is_none()
                {
                    host.bind(intent.key.worker, id, false)?;
                }
                let resource = host.reacquire_resource(id, intent.key.worker)?;
                if resource["started"] != true && intent.key.kind != "profile.delete" {
                    return Ok(());
                }
                host.mutate(intent, "stop", id, json!({"id":id}), |_| {
                    host.service.windows.stop_automation_window(
                        &host.scope.connection_id,
                        id,
                        &host.owner(intent.key.worker),
                    )
                })
            })
            .await
        })
    }

    fn resolve_cdp<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Option<CdpEndpoint>> {
        Box::pin(async move {
            let profile = id.to_owned();
            let endpoint = self
                .offload(move |host| {
                    let id = profile.as_str();
                    host.service
                        .require_profile(&host.scope.connection_id, id)?;
                    let state = host.service.windows.agent_window_snapshot(id)?;
                    if state["state"] == "stopped" {
                        return Ok(None);
                    }
                    if state["state"] != "running" {
                        return Err(BrowserError::new(
                            "unavailable",
                            "Profile state is unknown or transitioning",
                        )
                        .into());
                    }
                    let resource = host
                        .service
                        .store
                        .resource(&host.scope.run_id, id)?
                        .context("Profile lease missing")?;
                    if resource["released"] == true {
                        return Err(anyhow!("Profile lease released"));
                    }
                    let owner = resource["owner"]
                        .as_str()
                        .context("Profile owner missing")?;
                    match host.service.endpoint(&host.scope.connection_id, id, owner) {
                        Ok(endpoint) => Ok(Some(endpoint)),
                        Err(error) => Err(error.into()),
                    }
                })
                .await?;
            match endpoint {
                Some(endpoint) => Ok(Some(self.service.verify_endpoint(endpoint).await?)),
                None => Ok(None),
            }
        })
    }

    fn capabilities<'a>(&'a self, id: &'a str) -> BoxFuture<'a, EngineCapabilities> {
        Box::pin(async move {
            let endpoint = self
                .resolve_cdp(id)
                .await?
                .context("Browser has no active automation session")?;
            Ok(endpoint.capabilities)
        })
    }

    fn set_proxy<'a>(
        &'a self,
        intent: &'a StepIntent,
        id: &'a str,
        proxy: &'a str,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let intent = intent.clone();
            let id = id.to_owned();
            let proxy = proxy.to_owned();
            self.offload(move |host| {
                let intent = &intent;
                let id = id.as_str();
                let proxy = proxy.as_str();
                host.resource(id, intent.key.worker)?;
                let mut input = host.update_input(id)?;
                input.proxy_mode = if proxy.is_empty() {
                    ProxyMode::Direct
                } else {
                    ProxyMode::Manual
                };
                input.proxy = (!proxy.is_empty()).then(|| proxy.to_owned());
                input.proxy_id = None;
                input.proxy_plugin = None;
                input.proxy_endpoint = None;
                host.mutate(
                    intent,
                    "set_proxy",
                    id,
                    json!({"id":id,"proxy":proxy}),
                    |_| {
                        host.service.windows.update_automation_window(
                            &host.scope.connection_id,
                            &host.owner(intent.key.worker),
                            input,
                        )
                    },
                )
            })
            .await
        })
    }

    fn resolve_proxy<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let id = id.to_owned();
            self.offload(move |host| {
                let id = id.as_str();
                let resource = host
                    .service
                    .store
                    .resource(&host.scope.run_id, id)?
                    .context("Profile lease missing")?;
                let owner = resource["owner"]
                    .as_str()
                    .context("Profile owner missing")?;
                Ok(host.service.windows.resolve_automation_proxy(
                    &host.scope.connection_id,
                    id,
                    owner,
                )?)
            })
            .await
        })
    }

    fn autofill<'a>(&'a self, id: &'a str, field: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async move {
            self.service
                .require_profile(&self.scope.connection_id, id)?;
            let key = AutomationService::helper_key(&self.scope.connection_id, id);
            let offers = self.service.helper_offers.lock().map_err(storage_error)?;
            let offer = offers.get(&key).context(
                "The fill helper has nothing to offer yet; open a page with a form first",
            )?;
            offer["fields"]
                .as_array()
                .and_then(|fields| fields.iter().find(|entry| entry["kind"] == field))
                .and_then(|entry| entry["value"].as_str())
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("This helper offer has no requested person field"))
        })
    }

    fn release_profile<'a>(&'a self, worker: usize, id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let id = id.to_owned();
            self.offload(move |host| {
                let id = id.as_str();
                let resource = host
                    .service
                    .store
                    .resource(&host.scope.run_id, id)?
                    .context("Run resource missing")?;
                if resource["worker"].as_u64() != Some(worker as u64) {
                    return Err(anyhow!("Resource belongs to another worker"));
                }
                if resource["released"] == true {
                    return Ok(());
                }
                if host.service.store.pending_actions(&host.scope.run_id)? {
                    return Err(outcome_unknown(
                        "Pending actions retain their Profile reservation",
                    ));
                }
                host.service
                    .windows
                    .release_agent_window(id, &host.owner(worker))?;
                if resource["released"] != true {
                    host.service
                        .store
                        .resource_flag(&host.scope.run_id, id, "released")?;
                }
                Ok(())
            })
            .await
        })
    }
}

/// Convenience initializer for the application's existing setup hook.
pub fn initialize(app: &mut tauri::App) -> Result<()> {
    let root = crate::core::workspace_paths::workspace_root(&app.path().app_data_dir()?);
    let database = crate::core::workspace_paths::database_path(&root);
    let windows = app.state::<Arc<WindowService>>().inner().clone();
    let service = AutomationService::new(database, root, windows)?;
    super::helper::initialize(&service)?;
    app.manage(service);
    Ok(())
}
