use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use super::artifacts::Artifacts;
use super::dto::*;
use super::store::{AgentStore, Job};
use super::{AgentResult, canonical, conflict, denied, host_error, invalid, storage_error};
use crate::core::plugin_host::PluginHost;
use crate::core::plugin_host::manifest::Capability;
use crate::core::plugin_host::process::{HostRequest, PluginCaller, PluginErrorPayload};
use crate::core::window_service::WindowService;

const MAX_GLOBAL_ACTORS: usize = 10;
const MAX_JOB_DURATION: Duration = Duration::from_secs(24 * 60 * 60);

pub struct AgentService {
    pub(crate) store: AgentStore,
    pub(crate) artifacts: Artifacts,
    pub(crate) host: Weak<PluginHost>,
    pub(crate) windows: Weak<WindowService>,
    pub(crate) active: Mutex<HashMap<String, Arc<ActiveActor>>>,
    isolating: Mutex<HashSet<String>>,
    dispatch_cursor: Mutex<Option<(String, String)>>,
    running: AtomicBool,
    shutdown_started: AtomicBool,
}

pub(crate) struct ActiveActor {
    pub scope: AgentScope,
    pub caller: PluginCaller,
    pub accepting: AtomicBool,
    pub in_flight: AtomicUsize,
    pub graph_done: AtomicBool,
    reserved: AtomicBool,
    releasing: AtomicBool,
    pub tool: Mutex<()>,
    started: Instant,
    heartbeat_at: Mutex<Instant>,
}

pub(crate) struct HostGuard(pub Arc<ActiveActor>);
impl Drop for HostGuard {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}

struct IsolationGuard<'a> {
    service: &'a AgentService,
    id: String,
}
impl Drop for IsolationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.service.isolating.lock() {
            jobs.remove(&self.id);
        }
    }
}

impl AgentService {
    #[cfg(test)]
    pub(crate) fn gateway_fixture(
        store: AgentStore,
        artifacts: Artifacts,
        host: &Arc<PluginHost>,
        caller: &PluginCaller,
        scope: &AgentScope,
    ) -> Arc<Self> {
        let actor = Arc::new(ActiveActor {
            scope: scope.clone(),
            caller: caller.clone(),
            accepting: AtomicBool::new(true),
            in_flight: AtomicUsize::new(0),
            graph_done: AtomicBool::new(false),
            reserved: AtomicBool::new(false),
            releasing: AtomicBool::new(false),
            tool: Mutex::new(()),
            started: Instant::now(),
            heartbeat_at: Mutex::new(Instant::now()),
        });
        Arc::new(Self {
            store,
            artifacts,
            host: Arc::downgrade(host),
            windows: Weak::new(),
            active: Mutex::new(HashMap::from([(scope.job_id.clone(), actor)])),
            isolating: Mutex::new(HashSet::new()),
            dispatch_cursor: Mutex::new(None),
            running: AtomicBool::new(false),
            shutdown_started: AtomicBool::new(false),
        })
    }

    pub fn new(
        database: std::path::PathBuf,
        artifacts: std::path::PathBuf,
        host: &Arc<PluginHost>,
        windows: &Arc<WindowService>,
    ) -> AgentResult<Arc<Self>> {
        let store = AgentStore::new(database)?;
        store.recover()?;
        let artifacts = Artifacts::new(artifacts)?;
        // Manual window commands must see retained owners before setup exposes
        // WindowService. Restoring a reservation never starts or resets a browser.
        for (window_id, owner) in store.retained_window_owners()? {
            windows
                .restore_agent_window(&window_id, &owner)
                .map_err(browser_error)?;
        }
        Ok(Arc::new(Self {
            store,
            artifacts,
            host: Arc::downgrade(host),
            windows: Arc::downgrade(windows),
            active: Mutex::new(HashMap::new()),
            isolating: Mutex::new(HashSet::new()),
            dispatch_cursor: Mutex::new(None),
            running: AtomicBool::new(false),
            shutdown_started: AtomicBool::new(false),
        }))
    }

    pub fn register_gateway(self: &Arc<Self>) -> AgentResult<()> {
        let weak = Arc::downgrade(self);
        self.host()?
            .register_host_handler(Arc::new(move |caller, request: HostRequest| {
                let service = weak
                    .upgrade()
                    .ok_or_else(|| denied("Agent coordinator is unavailable"))?;
                service.handle_host(caller, request)
            }))
            .map_err(host_error)
    }

    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            loop {
                let Some(service) = weak.upgrade() else { break };
                if !service.running.load(Ordering::Acquire) {
                    break;
                }
                service.cleanup_actors();
                service.dispatch();
                drop(service);
                thread::sleep(Duration::from_millis(250));
            }
        });
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            loop {
                let Some(service) = weak.upgrade() else { break };
                if !service.running.load(Ordering::Acquire) {
                    break;
                }
                service.flush_outbox();
                drop(service);
                thread::sleep(Duration::from_millis(1000));
            }
        });
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            loop {
                let Some(service) = weak.upgrade() else { break };
                if !service.running.load(Ordering::Acquire) {
                    break;
                }
                service.heartbeat_actors();
                drop(service);
                thread::sleep(Duration::from_secs(1));
            }
        });
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            loop {
                let Some(service) = weak.upgrade() else { break };
                if !service.running.load(Ordering::Acquire) {
                    break;
                }
                service.settle_idle_controls();
                drop(service);
                thread::sleep(Duration::from_millis(250));
            }
        });
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            let mut last_retention = Instant::now();
            loop {
                let Some(service) = weak.upgrade() else { break };
                if !service.running.load(Ordering::Acquire) {
                    break;
                }
                service.flush_notifications();
                if last_retention.elapsed() >= Duration::from_secs(60) {
                    service.auto_retention();
                    last_retention = Instant::now();
                }
                drop(service);
                thread::sleep(Duration::from_secs(1));
            }
        });
    }

    pub(crate) fn host(&self) -> AgentResult<Arc<PluginHost>> {
        self.host
            .upgrade()
            .ok_or_else(|| denied("Plugin host is unavailable"))
    }

    pub(crate) fn windows(&self) -> AgentResult<Arc<WindowService>> {
        self.windows
            .upgrade()
            .ok_or_else(|| denied("Browser window service is unavailable"))
    }

    pub fn create(&self, mut input: BatchCreateInput) -> AgentResult<Value> {
        if self.shutdown_started.load(Ordering::Acquire) {
            return Err(denied("Application is shutting down"));
        }
        normalize_create(&mut input)?;
        validate_create(&input)?;
        let body = canonical(&serde_json::to_value(&input).map_err(storage_error)?);
        if let Some(id) = self.store.find_operation(&input.operation_id, &body)? {
            return self.store.batch_view(&id);
        }
        let host = self.host()?;
        host.agent_caller().map_err(host_error)?;
        let settings_reply = host
            .call(
                "studio.sales-agent",
                Capability::SalesAgent,
                "salesAgent.settings.get",
                json!({}),
                Duration::from_secs(30),
            )
            .map_err(host_error)?;
        let settings = validate_settings(&settings_reply["settings"])?;
        let windows = self.windows()?;
        let batch_id = Uuid::new_v4().to_string();
        self.artifacts.begin(&batch_id)?;
        let prepared = (|| {
            let deadline = Instant::now() + Duration::from_secs(10 * 60);
            let mut snapshots = Vec::with_capacity(input.assignments.len());
            let mut total_bytes = 0;
            let mut identities = HashSet::new();
            for assignment in &input.assignments {
                if Instant::now() >= deadline {
                    return Err(invalid("Batch snapshot deadline exceeded"));
                }
                let window = parse_window(
                    windows
                        .agent_window_snapshot(&assignment.window_id)
                        .map_err(browser_error)?,
                )?;
                if window.id != assignment.window_id
                    || matches!(
                        window.state.as_str(),
                        "unknown" | "missing" | "starting" | "stopping"
                    )
                {
                    return Err(conflict(
                        "Window availability must be known before creating a job",
                    ));
                }
                let (account, platform_origin) = self.account_snapshot(&assignment.window_id)?;
                if account["status"] == "blocked" {
                    return Err(denied("Confirmed blocked accounts cannot start Agent jobs"));
                }
                let identity = account["platformUserId"]
                    .as_str()
                    .ok_or_else(|| invalid("Account platform identity is missing"))?
                    .trim_start_matches('0')
                    .to_owned();
                if !identities.insert(identity) {
                    return Err(conflict(
                        "Two windows are bound to the same platform account",
                    ));
                }
                let mut products = Vec::with_capacity(assignment.product_ids.len());
                for id in &assignment.product_ids {
                    let mut product = self.read_product(id)?;
                    let revision = product["revision"].clone();
                    let original = product.clone();
                    if let Some(overrides) = assignment
                        .overrides
                        .iter()
                        .find(|value| value.product_id == *id)
                    {
                        let overrides = serde_json::to_value(overrides).map_err(storage_error)?;
                        for (key, value) in overrides
                            .as_object()
                            .ok_or_else(|| invalid("Invalid overrides"))?
                        {
                            if key != "productId" {
                                product[key] = value.clone();
                            }
                        }
                    }
                    validate_listing_product(&product)?;
                    let images = product["images"]
                        .as_array()
                        .cloned()
                        .ok_or_else(|| invalid("Product images are missing"))?;
                    let mut frozen = Vec::with_capacity(images.len());
                    let mut seen = HashSet::new();
                    for image in images {
                        if !seen.insert(image["id"].as_str().unwrap_or("").to_owned()) {
                            return Err(invalid("Duplicate product image ID"));
                        }
                        frozen.push(self.artifacts.freeze(
                            &host,
                            &batch_id,
                            &image,
                            &mut total_bytes,
                            deadline,
                        )?);
                    }
                    let current = self.read_product(id)?;
                    if current["revision"] != revision
                        || canonical(&current) != canonical(&original)
                    {
                        return Err(conflict(
                            "Product revision changed while freezing its execution snapshot",
                        ));
                    }
                    product["images"] = json!(frozen);
                    products.push(product);
                }
                let snapshot = JobSnapshot {
                    window_id: window.id,
                    window_name: window.name,
                    provider_id: window.provider_id,
                    connection_id: window.connection_id,
                    profile_id: window.profile_id,
                    platform_origin,
                    account,
                    products,
                    messages: assignment.messages.clone(),
                };
                if canonical(&json!({"snapshot":snapshot,"settings":settings})).len() > 800 * 1024 {
                    return Err(invalid(
                        "Job snapshot and settings exceed 800 KiB; split the assignments",
                    ));
                }
                snapshots.push((Uuid::new_v4().to_string(), snapshot));
            }
            // Bindings and accounts are checked again after slow image copies, before any DB write.
            for (_, snapshot) in &snapshots {
                self.verify_binding(snapshot)?;
                self.verify_account(snapshot, false)?;
            }
            self.artifacts.seal(&batch_id)?;
            self.store.create(&batch_id, &input, &snapshots, &settings)
        })();
        match prepared {
            Ok(id) => {
                if id != batch_id {
                    self.artifacts.discard(&batch_id);
                }
                self.store.batch_view(&id)
            }
            Err(error) => {
                self.artifacts.discard(&batch_id);
                Err(error)
            }
        }
    }

    pub fn list(&self, input: PageInput) -> AgentResult<Value> {
        self.store.list(&input)
    }
    pub fn get(&self, input: BatchGetInput) -> AgentResult<Value> {
        self.store.get(&input)
    }
    pub fn events(&self, input: EventsInput) -> AgentResult<Value> {
        self.store.events(&input)
    }

    pub fn control(&self, input: ControlInput) -> AgentResult<Value> {
        uuid(&input.batch_id)?;
        if input.action == ControlAction::Reconcile {
            self.store.begin_reconcile(&input.batch_id)?;
            for job in self.store.retained_jobs(&input.batch_id)? {
                let _isolation = self.begin_isolation(&job.id)?;
                self.isolate_retained(&job, true)?;
            }
        }
        self.store.control(&input)?;
        self.settle_controls(
            self.store
                .stopped_control_jobs_for(Some(&input.batch_id), None)?,
        )?;
        self.store.batch_view(&input.batch_id)
    }

    pub fn job_control(&self, id: &str, action: ControlAction) -> AgentResult<Value> {
        if action == ControlAction::Reconcile {
            self.store.control_job(id, ControlAction::Pause)?;
            let _isolation = self.begin_isolation(id)?;
            self.isolate_retained(&self.store.job(id)?, true)?;
        }
        self.store.control_job(id, action)?;
        self.settle_controls(self.store.stopped_control_jobs_for(None, Some(id))?)?;
        self.store.job_view(id)
    }

    fn begin_isolation(&self, id: &str) -> AgentResult<IsolationGuard<'_>> {
        let active = self.active.lock().map_err(storage_error)?;
        if active.contains_key(id)
            || !self
                .isolating
                .lock()
                .map_err(storage_error)?
                .insert(id.to_owned())
        {
            return Err(conflict(
                "The previous actor or isolation operation must settle first",
            ));
        }
        Ok(IsolationGuard {
            service: self,
            id: id.to_owned(),
        })
    }

    fn isolate_retained(&self, job: &Job, reconcile: bool) -> AgentResult<()> {
        let windows = self.windows()?;
        windows
            .restore_agent_window(&job.snapshot.window_id, &job.id)
            .map_err(browser_error)?;
        if reconcile {
            windows
                .reconcile_agent_window(&job.snapshot.window_id, &job.id)
                .map_err(browser_error)?;
        }
        windows
            .quiesce_agent_window(&job.snapshot.window_id, &job.id)
            .map_err(browser_error)?;
        self.store.actor_stopped(&job.id, false)
    }

    fn settle_idle_controls(&self) {
        let _ = self
            .store
            .stopped_control_jobs()
            .and_then(|ids| self.settle_controls(ids));
    }

    fn settle_controls(&self, ids: Vec<String>) -> AgentResult<()> {
        let mut first_error = None;
        for id in ids {
            let Ok(_isolation) = self.begin_isolation(&id) else {
                continue;
            };
            let result = (|| {
                let job = self.store.job(&id)?;
                let action = self.store.job_action(&id)?;
                if action == "run" {
                    return self.isolate_retained(&job, false);
                }
                if action == "takeover" {
                    self.verify_account(&job.snapshot, false)?;
                }
                self.isolate_retained(&job, false)?;
                let _active = self.active.lock().map_err(storage_error)?;
                if self.store.job_action(&id)? != action {
                    return Ok(());
                }
                if !matches!(
                    job.state.as_str(),
                    "completed" | "blocked" | "cancelled" | "skipped"
                ) {
                    self.store.settle_control(&id, action == "cancel")?;
                }
                let job = self.store.job(&id)?;
                let release = !self.store.has_uncertain(&id)?
                    && !matches!(
                        job.state.as_str(),
                        "running" | "review_required" | "result_unknown" | "blocked"
                    );
                self.store.actor_stopped(&id, release)?;
                if release {
                    self.windows()?
                        .release_agent_window(&job.snapshot.window_id, &id)
                        .map_err(browser_error)?;
                }
                self.store.takeover_settled(&id, release)
            })();
            if let Err(error) = result {
                let _ = self.store.control_isolation_failed(&id);
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(crate) fn account_snapshot(&self, window_id: &str) -> AgentResult<(Value, String)> {
        let reply = self
            .host()?
            .call(
                "studio.vinted-accounts",
                Capability::AccountPool,
                "vinted.accounts.agent.snapshot",
                json!({"windowId":window_id}),
                Duration::from_secs(20),
            )
            .map_err(host_error)?;
        if reply["windowId"].as_str() != Some(window_id) {
            return Err(denied("Account snapshot belongs to another window"));
        }
        validate_account(&reply["account"])
    }

    pub(crate) fn verify_account(
        &self,
        snapshot: &JobSnapshot,
        read_only: bool,
    ) -> AgentResult<()> {
        let (current, origin) = self.account_snapshot(&snapshot.window_id)?;
        if current["accountId"] != snapshot.account["accountId"]
            || current["platformUserId"] != snapshot.account["platformUserId"]
            || origin != snapshot.platform_origin
        {
            return Err(denied(
                "Bound platform account identity changed after the job was created",
            ));
        }
        if !read_only && current["status"] == "blocked" {
            return Err(denied(
                "Confirmed blocked accounts cannot perform browser writes",
            ));
        }
        Ok(())
    }

    pub(crate) fn verify_binding(&self, snapshot: &JobSnapshot) -> AgentResult<()> {
        let current = parse_window(
            self.windows()?
                .agent_window_snapshot(&snapshot.window_id)
                .map_err(browser_error)?,
        )?;
        if !snapshot.binding_matches(&current) {
            return Err(denied(
                "Immutable window binding no longer matches the job snapshot",
            ));
        }
        if matches!(current.state.as_str(), "unknown" | "missing" | "stopping") {
            return Err(denied(
                "Browser state is unknown or its profile is not visible",
            ));
        }
        Ok(())
    }

    pub(super) fn read_product(&self, id: &str) -> AgentResult<Value> {
        let reply = self
            .host()?
            .call(
                "studio.products",
                Capability::ProductCatalog,
                "products.get",
                json!({"id":id}),
                Duration::from_secs(20),
            )
            .map_err(host_error)?;
        let product = reply["product"].clone();
        if product["id"].as_str() != Some(id)
            || product["revision"]
                .as_u64()
                .is_none_or(|revision| revision == 0)
            || product["status"] != "ready"
            || product["publicationCount"].as_u64() != Some(0)
            || !product.get("latestPublication").is_some_and(Value::is_null)
        {
            return Err(invalid(
                "Product is not ready, is already published, or has an invalid revision",
            ));
        }
        Ok(product)
    }

    fn dispatch(self: &Arc<Self>) {
        let ids = {
            let Ok(mut cursor) = self.dispatch_cursor.lock() else {
                return;
            };
            let Ok(ids) = self.store.queued_page(&mut cursor) else {
                return;
            };
            ids
        };
        for id in ids {
            if !self.running.load(Ordering::Acquire) {
                break;
            }
            let Ok(mut active) = self.active.lock() else {
                return;
            };
            if active.len() >= MAX_GLOBAL_ACTORS {
                break;
            }
            if active.contains_key(&id) {
                continue;
            }
            let Ok(host) = self.host() else { return };
            // No host process is launched until there is queued work. A missing
            // configuration leaves durable queued intent for a later supervisor pass.
            drop(active);
            let caller = match host.agent_caller() {
                Ok(caller) => caller,
                Err(_) => return,
            };
            let capacity = match self.store.job(&id).and_then(|job| {
                self.windows()?
                    .agent_provider_capacity(&job.snapshot.window_id)
                    .map_err(browser_error)
            }) {
                Ok(value) => value,
                Err(_) => continue,
            };
            active = match self.active.lock() {
                Ok(active) => active,
                Err(_) => return,
            };
            if active.len() >= MAX_GLOBAL_ACTORS
                || active.contains_key(&id)
                || self
                    .isolating
                    .lock()
                    .map_or(true, |jobs| jobs.contains(&id))
            {
                continue;
            }
            let job =
                match self
                    .store
                    .claim_with_capacity(&id, &caller.generation, capacity.as_ref())
                {
                    Ok(Some(job)) => job,
                    _ => continue,
                };
            let Some(scope) = job.scope.clone() else {
                continue;
            };
            let actor = Arc::new(ActiveActor {
                scope,
                caller,
                accepting: AtomicBool::new(true),
                in_flight: AtomicUsize::new(0),
                graph_done: AtomicBool::new(false),
                tool: Mutex::new(()),
                started: Instant::now(),
                reserved: AtomicBool::new(false),
                releasing: AtomicBool::new(false),
                heartbeat_at: Mutex::new(Instant::now()),
            });
            active.insert(id, Arc::clone(&actor));
            drop(active);
            let service = Arc::clone(self);
            thread::spawn(move || service.run_job(job, actor));
        }
    }

    fn run_job(self: Arc<Self>, mut job: Job, actor: Arc<ActiveActor>) {
        let (step_budget, time_budget) = job_budgets(&job);
        let result = (|| {
            let windows = self.windows()?;
            windows
                .acquire_agent_window(&job.snapshot.window_id, &job.id)
                .map_err(browser_error)?;
            actor.reserved.store(true, Ordering::Release);
            self.verify_binding(&job.snapshot)?;
            self.verify_account(&job.snapshot, job.reconcile_only)?;
            if !job.reconcile_only {
                for product in &job.snapshot.products {
                    if self.store.product_confirmed(&job.id, &product["id"])? {
                        continue;
                    }
                    let current = self.read_product(
                        product["id"]
                            .as_str()
                            .ok_or_else(|| invalid("Invalid frozen product identity"))?,
                    )?;
                    if current["revision"] != product["revision"] {
                        return Err(conflict(
                            "An unsubmitted product changed while its job was queued",
                        ));
                    }
                }
            }
            windows
                .start_agent_window(&job.snapshot.window_id, &job.id)
                .map_err(browser_error)?;
            self.store
                .heartbeat(&actor.scope, &actor.caller.generation)?;
            loop {
                let control = self.store.job_action(&job.id)?;
                if !self.running.load(Ordering::Acquire) {
                    return Err(denied("Application is shutting down"));
                }
                if control != "run" {
                    self.store.settle_control(&job.id, control == "cancel")?;
                    return Ok(());
                }
                if actor.started.elapsed() > time_budget || job.steps as u64 >= step_budget {
                    return Err(invalid("Agent job reached its bounded step or time budget"));
                }
                self.host()?
                    .validate_agent_caller(&actor.caller)
                    .map_err(host_error)?;
                self.store
                    .heartbeat(&actor.scope, &actor.caller.generation)?;
                let input = json!({"scope":actor.scope,"snapshot":job.snapshot,"preset":job.preset,
                    "instruction":job.instruction,"settings":job.settings});
                if canonical(&input).len() > 900 * 1024 {
                    return Err(invalid("Graph step request exceeds the protocol budget"));
                }
                let output = self
                    .host()?
                    .call_agent_generation(
                        &actor.caller,
                        "salesAgent.jobs.step",
                        input,
                        Duration::from_millis(STEP_DEADLINE_MS),
                    )
                    .map_err(host_error)?;
                let mut output: StepOutput = serde_json::from_value(output)
                    .map_err(|_| invalid("Invalid bounded graph step response"))?;
                for endpoint in ["decision", "generation"] {
                    if let Some(secret) = job.settings[endpoint]["apiKey"]
                        .as_str()
                        .filter(|key| !key.is_empty())
                    {
                        output.phase = output.phase.replace(secret, "[REDACTED]");
                        if let Some(message) = output.message.as_mut() {
                            *message = message.replace(secret, "[REDACTED]");
                        }
                        for item in &mut output.item_updates {
                            item.reason = item.reason.replace(secret, "[REDACTED]");
                            if let Some(title) = item.title.as_mut() {
                                *title = title.replace(secret, "[REDACTED]");
                            }
                            if let Some(description) = item.description.as_mut() {
                                *description = description.replace(secret, "[REDACTED]");
                            }
                        }
                    }
                }
                output.phase =
                    crate::core::plugin_host::process::scrub_url_credentials(&output.phase);
                if let Some(message) = output.message.as_mut() {
                    *message = crate::core::plugin_host::process::scrub_url_credentials(message);
                }
                for item in &mut output.item_updates {
                    item.reason =
                        crate::core::plugin_host::process::scrub_url_credentials(&item.reason);
                }
                self.store
                    .mark_step(&actor.scope, &actor.caller.generation, &output)?;
                job = self.store.job(&job.id)?;
                if job.state != "running" {
                    return Ok(());
                }
                // The graph is invoked for one durable step at a time. A pending
                // reverse call must settle before the next step can use this actor.
                while actor.in_flight.load(Ordering::Acquire) > 0 {
                    if !self.running.load(Ordering::Acquire) {
                        return Err(denied("Application is shutting down"));
                    }
                    if actor.started.elapsed() > time_budget {
                        return Err(invalid("Host request did not settle"));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        })();
        if let Ok(_active) = self.active.lock() {
            actor.accepting.store(false, Ordering::Release);
        }
        if result.is_err() {
            let _ = self.store.interrupt(&job.id, "execution_interrupted");
        }
        actor.graph_done.store(true, Ordering::Release);
        self.cleanup_actors();
    }

    fn cleanup_actors(&self) {
        let actors: Vec<Arc<ActiveActor>> = match self.active.lock() {
            Ok(active) => active
                .values()
                .filter(|actor| {
                    actor.graph_done.load(Ordering::Acquire)
                        && actor.in_flight.load(Ordering::Acquire) == 0
                })
                .cloned()
                .collect(),
            Err(_) => return,
        };
        for actor in actors {
            // The accepting bit prevents a delayed host request from entering after
            // this drain check. Provider release may fail until its own actor settles.
            if actor.accepting.load(Ordering::Acquire) {
                continue;
            }
            if actor.releasing.swap(true, Ordering::AcqRel) {
                continue;
            }
            let Ok(windows) = self.windows() else {
                actor.releasing.store(false, Ordering::Release);
                continue;
            };
            if !actor.reserved.load(Ordering::Acquire)
                && windows
                    .restore_agent_window(&actor.scope.window_id, &actor.scope.job_id)
                    .is_err()
            {
                actor.releasing.store(false, Ordering::Release);
                continue;
            }
            actor.reserved.store(true, Ordering::Release);
            if windows
                .quiesce_agent_window(&actor.scope.window_id, &actor.scope.job_id)
                .is_err()
            {
                actor.releasing.store(false, Ordering::Release);
                continue;
            }
            let Ok(mut job) = self.store.job(&actor.scope.job_id) else {
                actor.releasing.store(false, Ordering::Release);
                continue;
            };
            let Ok(control) = self.store.job_action(&job.id) else {
                actor.releasing.store(false, Ordering::Release);
                continue;
            };
            if control != "run"
                && !matches!(
                    job.state.as_str(),
                    "completed" | "blocked" | "cancelled" | "skipped"
                )
            {
                if self
                    .store
                    .settle_control(&job.id, control == "cancel")
                    .is_err()
                {
                    actor.releasing.store(false, Ordering::Release);
                    continue;
                }
                let Ok(updated) = self.store.job(&job.id) else {
                    actor.releasing.store(false, Ordering::Release);
                    continue;
                };
                job = updated;
            }
            let Ok(uncertain) = self.store.has_uncertain(&job.id) else {
                actor.releasing.store(false, Ordering::Release);
                continue;
            };
            let release = !uncertain
                && (control != "takeover" || self.verify_account(&job.snapshot, false).is_ok())
                && !matches!(
                    job.state.as_str(),
                    "running" | "review_required" | "result_unknown" | "blocked"
                );
            let Ok(mut active) = self.active.lock() else {
                actor.releasing.store(false, Ordering::Release);
                continue;
            };
            if self.store.actor_stopped(&job.id, release).is_err() {
                actor.releasing.store(false, Ordering::Release);
                continue;
            }
            if release {
                if windows
                    .release_agent_window(&actor.scope.window_id, &actor.scope.job_id)
                    .is_err()
                {
                    actor.releasing.store(false, Ordering::Release);
                    continue;
                }
                actor.reserved.store(false, Ordering::Release);
            }
            let _ = self.store.takeover_settled(&job.id, release);
            active.remove(&job.id);
        }
    }

    fn heartbeat_actors(&self) {
        let actors: Vec<_> = match self.active.lock() {
            Ok(active) => active.values().cloned().collect(),
            Err(_) => return,
        };
        for actor in actors {
            if !actor.accepting.load(Ordering::Acquire) || actor.graph_done.load(Ordering::Acquire)
            {
                continue;
            }
            let Ok(mut renewed) = actor.heartbeat_at.lock() else {
                continue;
            };
            if renewed.elapsed() < Duration::from_secs(15) {
                continue;
            }
            // Renewal runs independently of a bounded graph RPC or provider start.
            // Failed renewal never frees the actor's resources.
            let result = self.host().and_then(|host| {
                host.validate_agent_caller(&actor.caller)
                    .map_err(host_error)?;
                self.store.heartbeat(&actor.scope, &actor.caller.generation)
            });
            if result.is_err() {
                actor.accepting.store(false, Ordering::Release);
            }
            *renewed = Instant::now();
        }
    }

    fn flush_outbox(&self) {
        let Ok(items) = self.store.due_outbox() else {
            return;
        };
        for item in items {
            if !self.running.load(Ordering::Acquire) {
                break;
            }
            let result = self
                .host()
                .and_then(|host| {
                    host.call(
                        "studio.products",
                        Capability::ProductCatalog,
                        "products.publications.record",
                        item.payload.clone(),
                        Duration::from_secs(30),
                    )
                    .map_err(host_error)
                })
                .and_then(|reply| verify_publication_reply(&reply, &item.payload));
            let error = result.as_ref().err().map(|error| {
                (
                    error.code.as_str(),
                    !matches!(
                        error.code.as_str(),
                        "CONFLICT" | "INVALID_REQUEST" | "NOT_FOUND"
                    ),
                )
            });
            let _ = self.store.outbox_result(&item.operation_id, error);
        }
    }

    pub fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.running.store(false, Ordering::Release);
        let actors: Vec<Arc<ActiveActor>> = self
            .active
            .lock()
            .map(|active| {
                for actor in active.values() {
                    actor.accepting.store(false, Ordering::Release);
                }
                active.values().cloned().collect()
            })
            .unwrap_or_default();
        for actor in actors {
            actor.accepting.store(false, Ordering::Release);
            let _ = self
                .store
                .interrupt(&actor.scope.job_id, "application_shutdown");
        }
        // Do not wait for a possibly disconnected browser on the event-loop thread.
        // Durable locks survive exit; startup recovery requires explicit reconciliation.
    }
}

pub(crate) fn job_budgets(job: &Job) -> (u64, Duration) {
    let per_item = job.settings["maxStepsPerItem"].as_u64().unwrap_or(30)
        + 2 * job.settings["maxCopyRewrites"].as_u64().unwrap_or(2)
        + 20;
    let image_steps: u64 = job
        .snapshot
        .products
        .iter()
        .map(|product| product["images"].as_array().map_or(0, Vec::len) as u64)
        .sum();
    let items = job
        .snapshot
        .products
        .len()
        .max(job.snapshot.messages.len())
        .max(1) as u64;
    // Reserve graph transitions, reviews and bounded browser plans per item;
    // the absolute limits still force unusually expensive work into review.
    let steps = (per_item * items + image_steps + 10).min(u64::from(MAX_STEPS));
    let per_step_ms = job.settings["requestTimeoutMs"].as_u64().unwrap_or(60_000) + 30_000;
    let millis = steps
        .saturating_mul(per_step_ms)
        .clamp(30 * 60 * 1000, MAX_JOB_DURATION.as_millis() as u64);
    (steps, Duration::from_millis(millis))
}

pub(crate) fn browser_error(_: crate::core::browser::provider::BrowserError) -> PluginErrorPayload {
    PluginErrorPayload::new(
        "UNAVAILABLE",
        "Browser provider could not validate or control the assigned window",
        false,
    )
}

pub(crate) fn parse_window(value: Value) -> AgentResult<WindowSnapshot> {
    let window: WindowSnapshot =
        serde_json::from_value(value).map_err(|_| invalid("Invalid window snapshot"))?;
    uuid(&window.id)?;
    text(&window.name, 0, 200)?;
    text(&window.connection_id, 1, 200)?;
    text(&window.profile_id, 1, 200)?;
    if !matches!(
        window.provider_id.as_str(),
        "cloakbrowser" | "adspower" | "bitbrowser"
    ) {
        return Err(invalid("Unsupported browser provider"));
    }
    Ok(window)
}

pub(crate) fn validate_account(value: &Value) -> AgentResult<(Value, String)> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Window has no bound platform account"))?;
    let id = object
        .get("accountId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Account ID is missing"))?;
    uuid(id)?;
    let account = object
        .get("account")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Account name is missing"))?;
    text(account, 0, 320)?;
    let status = value["status"]
        .as_str()
        .ok_or_else(|| invalid("Account status is missing"))?;
    if !matches!(status, "active" | "pending" | "limited" | "blocked") {
        return Err(invalid("Invalid account status"));
    }
    let homepage = value["homepageUrl"]
        .as_str()
        .ok_or_else(|| invalid("Account homepage is missing"))?;
    text(homepage, 1, 2048)?;
    if homepage
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
        || homepage.contains('\\')
    {
        return Err(invalid("Invalid account homepage URL"));
    }
    let url = url::Url::parse(homepage).map_err(|_| invalid("Invalid account homepage URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| invalid("Invalid account homepage host"))?;
    let suffix = host
        .strip_prefix("www.vinted.")
        .ok_or_else(|| invalid("Account homepage requires an exact www.vinted site"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || ![
            "com", "co.uk", "fr", "de", "it", "es", "nl", "be", "at", "pl", "pt", "cz", "sk", "lt",
            "lu", "se", "dk", "fi", "hr", "hu", "ro", "gr", "ie",
        ]
        .contains(&suffix)
    {
        return Err(invalid(
            "Account homepage is outside the supported HTTPS Vinted origins",
        ));
    }
    let member = url
        .path()
        .strip_prefix("/member/")
        .ok_or_else(|| invalid("Account homepage must identify a numeric member"))?;
    let member = member.strip_suffix('/').unwrap_or(member);
    let numeric = member.split('-').next().unwrap_or("");
    if member.contains('/')
        || numeric.is_empty()
        || numeric.len() > 32
        || !numeric.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid("Account homepage must identify a numeric member"));
    }
    let identity = value["platformUserId"]
        .as_str()
        .ok_or_else(|| invalid("Account platform identity must be known"))?;
    if identity != numeric {
        return Err(denied(
            "Account platform identity does not match its homepage",
        ));
    }
    let mut snapshot = json!({"accountId":id,"account":account,"status":status,"homepageUrl":homepage,"platformUserId":identity});
    if let Some(observation) = value.get("observation") {
        if canonical(observation).len() > 16 * 1024 {
            return Err(invalid("Account observation exceeds its snapshot budget"));
        }
        snapshot["observation"] = observation.clone();
    }
    Ok((snapshot, url.origin().ascii_serialization()))
}

pub(super) fn validate_listing_product(product: &Value) -> AgentResult<()> {
    for (key, max) in [
        ("name", 200),
        ("title", 500),
        ("description", 6000),
        ("condition", 120),
    ] {
        let value = product[key]
            .as_str()
            .ok_or_else(|| invalid("Required product text is missing"))?;
        text(value, 1, max)?;
        if value.trim().is_empty() {
            return Err(invalid("Required listing fields cannot be blank"));
        }
    }
    for (key, max) in [("brand", 120), ("size", 120), ("category", 200)] {
        text(product[key].as_str().unwrap_or(""), 0, max)?;
    }
    if product["price"]
        .as_f64()
        .is_none_or(|value| !value.is_finite() || value <= 0.0 || value > 100_000_000.0)
        || !matches!(product["currency"].as_str(), Some("USD" | "GBP" | "EUR"))
        || product["images"]
            .as_array()
            .is_none_or(|images| images.is_empty() || images.len() > 12)
    {
        return Err(invalid("Product price, currency or image count is invalid"));
    }
    Ok(())
}

fn normalize_create(input: &mut BatchCreateInput) -> AgentResult<()> {
    fn id(value: &mut String) -> AgentResult<()> {
        *value = Uuid::parse_str(value)
            .map_err(|_| invalid("Expected a UUID"))?
            .to_string();
        Ok(())
    }
    id(&mut input.operation_id)?;
    input.instruction = input.instruction.trim().to_owned();
    for assignment in &mut input.assignments {
        id(&mut assignment.window_id)?;
        for value in &mut assignment.product_ids {
            id(value)?;
        }
        for item in &mut assignment.overrides {
            id(&mut item.product_id)?;
            for value in [
                &mut item.title,
                &mut item.description,
                &mut item.category,
                &mut item.condition,
                &mut item.brand,
                &mut item.size,
            ]
            .into_iter()
            .flatten()
            {
                *value = value.trim().to_owned();
            }
        }
        for message in &mut assignment.messages {
            message.text = message.text.trim().to_owned();
        }
    }
    Ok(())
}

pub(crate) use super::settings::validate_settings;

pub(crate) fn verify_publication_reply(reply: &Value, payload: &Value) -> AgentResult<()> {
    if reply["product"]["id"] != payload["productId"]
        || reply["alreadyRecorded"].as_bool().is_none()
        || reply["product"]["publicationCount"]
            .as_u64()
            .is_none_or(|count| count == 0)
    {
        return Err(invalid(
            "Product plugin did not acknowledge the publication receipt",
        ));
    }
    Ok(())
}
