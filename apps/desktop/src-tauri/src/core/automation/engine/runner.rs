// SPDX-License-Identifier: MIT
// Ported from ProxyShard/ShardBrowser runner.rs at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
// Copyright (c) ProxyShard. See LICENSE.upstream.
//! Runs a project: N browsers in parallel, each walking the block list.
//!
//! Upstream flow and step dispatch, with an explicit scoped host boundary.
//! Native Motion calls are retained. Verified Chromium sessions use the
//! standard Input adapter. Operator-authored script.run remains explicit.

use super::host::{
    self, CreateProfile, EngineHost, Reconciliation, StepCompletion, StepIntent, StepKey,
};
use super::{cdp, model as automation, wasm};
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerState {
    #[serde(default)]
    pub pending_intent: Option<StepIntent>,
    #[serde(default)]
    pub variables: HashMap<String, String>,
    #[serde(default)]
    pub temporary_profiles: Vec<String>,
    pub profile_id: String,
    pub profile_name: String,
    /// 1-based; 0 before the first pass starts.
    pub pass: u32,
    pub step: u32,
    pub steps_total: u32,
    /// "starting" | "running" | "done" | "failed" | "stopped"
    pub status: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunState {
    pub connection_id: String,
    pub run_id: String,
    pub project_id: String,
    pub project_name: String,
    pub started_at: u64,
    pub running: bool,
    pub workers: Vec<WorkerState>,
    pub log: Vec<String>,
}

struct Run {
    state: Mutex<RunState>,
    /// Order snapshot capture and its durable write as one operation.
    persist_gate: tokio::sync::Mutex<()>,
    /// Shared, not a bare flag: a WASM module runs on a blocking thread and
    /// asks `should_stop()`, so the operator's Stop has to reach it there.
    stop: Arc<AtomicBool>,
    /// Interception rules for this project, mounted per profile on first attach.
    rules: Vec<serde_json::Value>,
    /// Every saved project, as they stood when the run started. A sub-flow
    /// resolves out of this rather than re-reading the file per call, and
    /// editing a project mid-run cannot change a call already in flight.
    projects: Vec<automation::Project>,
    /// The space the run started in: its profile steps and starts go there or nowhere.
    host: Arc<dyn EngineHost>,
    modules: wasm::FrozenModules,
    persistence_failed: AtomicBool,
    redactions: Mutex<std::collections::HashSet<String>>,
}

fn runs() -> &'static Mutex<HashMap<String, Arc<Run>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Run>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn run_key(connection_id: &str, run_id: &str) -> String {
    serde_json::to_string(&(connection_id, run_id)).expect("string tuple")
}

pub fn status(connection_id: &str, run_id: &str) -> Option<RunState> {
    let run = runs()
        .lock()
        .ok()?
        .get(&run_key(connection_id, run_id))?
        .clone();
    let state = run.state.lock().ok()?.clone();
    Some(state)
}

/// Fleet is filtered explicitly by connection. Global aggregation is a service operation.
pub fn all(connection_id: &str) -> Vec<RunState> {
    let Ok(registry) = runs().lock() else {
        return Vec::new();
    };
    registry
        .values()
        .filter_map(|run| {
            let state = run.state.lock().ok()?;
            (state.connection_id == connection_id).then(|| state.clone())
        })
        .collect()
}

pub fn stop(connection_id: &str, run_id: &str) -> bool {
    let Ok(registry) = runs().lock() else {
        return false;
    };
    let Some(run) = registry.get(&run_key(connection_id, run_id)) else {
        return false;
    };
    run.stop.store(true, Ordering::Relaxed);
    true
}

fn settled(state: &RunState) -> bool {
    !state.running
        && state.workers.iter().all(|worker| {
            worker.pending_intent.is_none()
                && matches!(worker.status.as_str(), "done" | "stopped" | "failed")
        })
}

fn retire_terminal(run: &Arc<Run>) -> Result<bool> {
    if run.persistence_failed.load(Ordering::Acquire) {
        return Ok(false);
    }
    let mut registry = runs().lock().map_err(|_| anyhow!("runs lock poisoned"))?;
    let state = run
        .state
        .lock()
        .map_err(|_| anyhow!("run state lock poisoned"))?;
    if !settled(&state) {
        return Ok(false);
    }
    let key = run_key(&state.connection_id, &state.run_id);
    if registry
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, run))
    {
        registry.remove(&key);
        return Ok(true);
    }
    Ok(false)
}

/// The service supplies its authoritative, fully reconciled terminal snapshot
/// after all host jobs, browser control and lifecycle intents are settled.
/// Persist it before dropping unresolved in-memory ownership. History remains
/// available from the durable store after registry retirement.
pub async fn retire_recovered(state: RunState) -> Result<bool> {
    if !settled(&state) {
        return Err(anyhow!(
            "recovered run still has pending intents or unfinished workers"
        ));
    }
    let run = runs()
        .lock()
        .map_err(|_| anyhow!("runs lock poisoned"))?
        .get(&run_key(&state.connection_id, &state.run_id))
        .cloned();
    let Some(run) = run else { return Ok(false) };
    let _gate = run.persist_gate.lock().await;
    {
        let current = run
            .state
            .lock()
            .map_err(|_| anyhow!("run state lock poisoned"))?;
        if current.running || current.project_id != state.project_id {
            return Err(anyhow!(
                "recovery cannot retire an active or different project run"
            ));
        }
    }
    if let Err(error) = run.host.persist_state(&state).await {
        run.persistence_failed.store(true, Ordering::Release);
        return Err(error);
    }
    *run.state
        .lock()
        .map_err(|_| anyhow!("run state lock poisoned"))? = state;
    run.persistence_failed.store(false, Ordering::Release);
    retire_terminal(&run)
}

impl Run {
    fn log(&self, line: impl Into<String>) {
        let mut line = line.into();
        if let Ok(secrets) = self.redactions.lock() {
            let mut secrets: Vec<_> = secrets.iter().collect();
            secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
            for secret in secrets {
                line = line.replace(secret, "[redacted]");
            }
        }
        let stamped = format!("[{}] {line}", now());
        if let Ok(mut state) = self.state.lock() {
            state.log.push(stamped);
            if state.log.len() > 2000 {
                state.log.drain(0..500);
            }
        }
    }

    async fn persist(&self) -> Result<()> {
        let _gate = self.persist_gate.lock().await;
        let snapshot = self
            .state
            .lock()
            .map_err(|_| anyhow!("run state lock poisoned"))?
            .clone();
        if let Err(error) = self.host.persist_state(&snapshot).await {
            self.persistence_failed.store(true, Ordering::Release);
            self.log("run state persistence failed; execution suspended");
            return Err(error);
        }
        self.persistence_failed.store(false, Ordering::Release);
        Ok(())
    }

    fn worker<F: FnOnce(&mut WorkerState)>(&self, idx: usize, f: F) {
        if let Ok(mut s) = self.state.lock() {
            if let Some(w) = s.workers.get_mut(idx) {
                f(w);
            }
        }
    }
}

/// Substitutes {{name}} from the worker's own variables.
fn expand(text: &str, vars: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

fn param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params
        .get(name)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// A number a step asks for, with `{{variables}}` resolved first.
///
/// A step writes its numbers as numbers, but the operator can also type
/// `{{delay}}` into one — that is how `var.random` feeds a wait. Without the
/// expansion the string stayed a string, parsing it failed, and the step
/// silently fell back to its default: `var.random` into `wait` did nothing at
/// all, and every `timeout` behaved the same way.
fn param_f64(params: &Value, name: &str, vars: &HashMap<String, String>) -> Option<f64> {
    params
        .get(name)
        .and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => expand(s, vars).trim().parse().ok(),
            _ => None,
        })
        .filter(|number: &f64| number.is_finite())
}

/// Viewport centre of the element a selector matches.
async fn center_of(profile: &str, selector: &str) -> Result<(f64, f64)> {
    // Through the piercing resolver, so a selector recorded inside a shadow
    // root still finds its element on replay.
    let node = *cdp::query_piercing(profile, selector)
        .await?
        .first()
        .ok_or_else(|| anyhow!("no element matches {selector}"))?;

    let box_model = cdp::page_call(profile, "DOM.getBoxModel", json!({ "nodeId": node })).await?;
    let quad = box_model
        .get("model")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .ok_or_else(|| anyhow!("{selector} has no box"))?;
    if quad.len() < 8 {
        return Err(anyhow!("{selector} has no box"));
    }
    let n = |i: usize| quad[i].as_f64().unwrap_or(0.0);
    // The content quad is four corners; the centre is the mean of the x's and
    // the y's, which is right for a rotated element too.
    let x = (n(0) + n(2) + n(4) + n(6)) / 4.0;
    let y = (n(1) + n(3) + n(5) + n(7)) / 4.0;
    Ok((x, y))
}

/// The visible page's size, from the browser. A finger's stroke is bounded by
/// the glass, so a long scroll has to know how much glass there is.
async fn viewport_size(profile: &str) -> Result<(f64, f64)> {
    let metrics = cdp::page_call(profile, "Page.getLayoutMetrics", json!({})).await?;
    let viewport = metrics
        .get("cssVisualViewport")
        .or_else(|| metrics.get("visualViewport"))
        .context("browser returned no viewport metrics")?;
    let width = viewport
        .get("clientWidth")
        .and_then(Value::as_f64)
        .context("no viewport width")?;
    let height = viewport
        .get("clientHeight")
        .and_then(Value::as_f64)
        .context("no viewport height")?;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(anyhow!("invalid viewport dimensions"));
    }
    Ok((width, height))
}

async fn viewport_center(profile: &str) -> Result<(f64, f64)> {
    let (width, height) = viewport_size(profile).await?;
    Ok((width / 2.0, height / 2.0))
}

/// How long an element is given to turn up before the step gives in.
const DEFAULT_WAIT_S: f64 = 5.0;

/// The element's centre, waiting for it to appear.
///
/// Every step that names an element goes through here. Asking once and failing
/// is wrong on any page worth automating: the click that follows a navigation
/// arrives while the page is still building itself, and the element it wants
/// is a few hundred milliseconds away.
async fn center_waiting(profile: &str, selector: &str, timeout_s: f64) -> Result<(f64, f64)> {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout_s.clamp(0.0, 600.0));
    loop {
        match center_of(profile, selector).await {
            Ok(p) => return Ok(p),
            Err(e) => {
                if host::is_unknown(&e) {
                    return Err(e);
                }
                // Reported at the moment of giving up, so the message says what
                // was actually wrong and not merely that the wait ran out.
                if Instant::now() >= deadline {
                    return Err(anyhow!(
                        "{selector} did not turn up within {}s ({e})",
                        tidy(timeout_s)
                    ));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The wait a step asks for, or the default.
fn wait_for(p: &Value, vars: &HashMap<String, String>) -> f64 {
    param_f64(p, "timeout", vars)
        .filter(|v| *v >= 0.0)
        .unwrap_or(DEFAULT_WAIT_S)
}

async fn exists(profile: &str, selector: &str) -> Result<bool> {
    Ok(!cdp::query_piercing(profile, selector).await?.is_empty())
}

async fn click_at(profile: &str, x: f64, y: f64, button: &str) -> Result<()> {
    cdp::page_call(profile, "Motion.createPointer", json!({ "x": x, "y": y })).await?;
    cdp::page_call(profile, "Motion.glideTo", json!({ "x": x, "y": y })).await?;
    let clicks = if button == "double" { 2 } else { 1 };
    let b = if button == "right" { "right" } else { "left" };
    cdp::page_call(
        profile,
        "Motion.tap",
        json!({ "button": b, "clickCount": clicks }),
    )
    .await?;
    Ok(())
}

/// One frame of a chain of calls: a module block, or a saved project called as
/// a sub-flow.
///
/// Named rather than counted so a loop can be reported as the loop it is. A
/// module that calls itself reaches the depth bound in four hops and would
/// otherwise always be told the wrong thing.
#[derive(Clone, PartialEq)]
pub enum Frame {
    Module(String),
    Flow(String),
}

impl Frame {
    fn name(&self) -> String {
        match self {
            Frame::Module(id) => format!("module \"{id}\""),
            Frame::Flow(id) => format!("flow \"{id}\""),
        }
    }
}

/// What a worker's whole chain of calls shares.
///
/// One per worker, reborrowed down every nested frame. Not a process global:
/// the recursion spans several blocking threads and several WASM stores at
/// once, and two workers must never share a counter.
pub struct CallCtx {
    worker: usize,
    pass: u32,
    sequence: u64,
    active_intent: Option<StepIntent>,
    module_root: Option<std::path::PathBuf>,
    depth: u8,
    stack: Vec<Frame>,
    /// Actions the current chain has spent. Reset when a chain starts, not per
    /// pass: a project that calls a module block ten times gets ten budgets,
    /// exactly as it does today, while a module that nests cannot multiply its
    /// own by calling through another one.
    actions: u32,
    /// Every temporary profile this worker made. Cleanup used to look only at
    /// whatever was FINALLY bound, so a graph that made two orphaned the first.
    temps: Vec<String>,
    /// Variables a module wrote.
    ///
    /// Refusing a module `script.run` is not enough on its own: it can write a
    /// variable instead and wait for a block the OPERATOR wrote to interpolate
    /// it — `script.run source="{{payload}}"` runs the module's text without
    /// the module ever asking for the block. So where a value came from travels
    /// with its name, and the three steps that turn a value into running code
    /// refuse one that came from a module.
    tainted: std::collections::HashSet<String>,
}

/// What `enter` took away, put back by `leave`. A value rather than a guard:
/// a guard would borrow the context that the callee also needs.
#[derive(Debug)]
struct Saved {
    depth: u8,
    stack_len: usize,
}

/// Four frames of nesting. Deep enough for a module that calls a helper that
/// calls a flow; shallow enough that a runaway is reported rather than felt.
const MAX_CALL_DEPTH: u8 = 4;
/// What one chain may ask the runner to do. The same 5000 a single module has
/// always had — now shared by everything it calls, so nesting cannot multiply it.
const MAX_CHAIN_ACTIONS: u32 = 5000;

impl CallCtx {
    fn new() -> Self {
        Self {
            worker: 0,
            pass: 0,
            sequence: 0,
            active_intent: None,
            module_root: None,
            depth: 0,
            stack: Vec::new(),
            actions: 0,
            temps: Vec::new(),
            tainted: std::collections::HashSet::new(),
        }
    }

    fn intent(&self) -> Result<&StepIntent> {
        self.active_intent
            .as_ref()
            .context("step intent has not been allocated")
    }

    fn resource_key(&self, run: &Run, family: &str, name: &str) -> String {
        format!(
            "{}:{}:{}",
            run.host.scope().resource_key(family),
            self.worker,
            name
        )
    }

    fn enter(&mut self, frame: Frame) -> Result<Saved> {
        if let Some(at) = self.stack.iter().position(|f| *f == frame) {
            let mut chain: Vec<String> = self.stack[at..].iter().map(Frame::name).collect();
            chain.push(frame.name());
            return Err(anyhow!(
                "that call goes round in a circle: {}",
                chain.join(" → ")
            ));
        }
        if self.depth >= MAX_CALL_DEPTH {
            let chain: Vec<String> = self.stack.iter().map(Frame::name).collect();
            return Err(anyhow!(
                "a call may be {MAX_CALL_DEPTH} deep and this is one more: {} → {}",
                chain.join(" → "),
                frame.name()
            ));
        }
        let saved = Saved {
            depth: self.depth,
            stack_len: self.stack.len(),
        };
        if self.depth == 0 {
            self.actions = 0;
        }
        self.depth += 1;
        self.stack.push(frame);
        Ok(saved)
    }

    /// The module this work is being done for, if any.
    ///
    /// Any frame, not only the top one: a module decides when to call a flow
    /// and what to pass into it, so a flow doing `goto {{url}}` is the module's
    /// reach with one step in between.
    fn on_behalf_of(&self) -> Option<&str> {
        self.stack.iter().find_map(|f| match f {
            Frame::Module(id) => Some(id.as_str()),
            Frame::Flow(_) => None,
        })
    }

    /// Whether the frame currently on top may call `target`.
    ///
    /// At depth 0 there is no caller: the operator placed the block themselves,
    /// and the whole point of the block library is that they may. Deeper, the
    /// decision belongs to what the operator granted the CALLING module — a
    /// module that was never granted anything calls nothing, which is what
    /// makes this safe to add to a contract that already shipped.
    fn may_call(&self, target: &Frame) -> Result<()> {
        let Some(Frame::Module(caller)) = self.stack.last() else {
            // Either depth 0, or the caller is a flow — operator-authored
            // blocks, which are trusted exactly as they are when run directly.
            return Ok(());
        };
        let grant = wasm::with_snapshot(self.module_root.as_deref(), || wasm::grant_for(caller));
        let (allowed, what) = match target {
            Frame::Module(id) => (
                grant.call_modules.iter().any(|m| m == id),
                format!("module \"{id}\""),
            ),
            // "*" is a module that asked to run any project and was granted
            // exactly that by the operator (Modules: "run any of your projects").
            Frame::Flow(id) => (
                grant.call_flows.iter().any(|f| f == id || f == "*"),
                "that flow".to_string(),
            ),
        };
        if allowed {
            return Ok(());
        }
        Err(anyhow!(
            "\"{caller}\" was not given permission to call {what} — grant it in Modules"
        ))
    }

    fn leave(&mut self, saved: Saved) {
        self.depth = saved.depth;
        self.stack.truncate(saved.stack_len);
    }

    /// Charges one action to the whole chain.
    fn charge(&mut self) -> Result<()> {
        self.actions += 1;
        if self.actions > MAX_CHAIN_ACTIONS {
            return Err(anyhow!(
                "this chain of calls asked for more than {MAX_CHAIN_ACTIONS} actions"
            ));
        }
        Ok(())
    }

    /// Marks what a module wrote, so a later block cannot run it as code.
    fn mark_from_module(&mut self, names: impl IntoIterator<Item = String>) {
        if self.on_behalf_of().is_some() {
            self.tainted.extend(names);
        }
    }

    /// Refuses a step that would turn a module's text into running code.
    ///
    /// The raw parameters are searched, not the expanded ones: by the time a
    /// value is substituted it is indistinguishable from one the operator typed,
    /// which is the whole point of the attack.
    fn refuse_laundering(&self, block: &automation::Block) -> Result<()> {
        const SINKS: [&str; 3] = ["script.run", "traffic.editResponse", "traffic.fulfill"];
        if self.tainted.is_empty() || !SINKS.contains(&block.kind.as_str()) {
            return Ok(());
        }
        let raw = block.params.to_string();
        for name in &self.tainted {
            if raw.contains(&format!("{{{{{name}}}}}")) {
                return Err(anyhow!(
                    "\"{}\" would run the value of \"{name}\", and a module wrote that — \
                     a module's text is never code",
                    block.kind
                ));
            }
        }
        Ok(())
    }

    fn remember_temp(&mut self, id: &str) {
        if !id.is_empty() && !self.temps.iter().any(|t| t == id) {
            self.temps.push(id.to_string());
        }
    }
}

/// A profile the graph made, and whether it goes away at the end.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Bound {
    pub id: String,
    pub temporary: bool,
    /// Phone/tablet fingerprint. Decided once, when the profile is bound: the
    /// core refuses a pointer on such a profile, so every step that would have
    /// used one has to reach for a finger instead.
    pub mobile: bool,
}

/// Whether a profile id claims a handset, by the same rule the core uses.
/// Brings the window forward before a touch. The core refuses a gesture aimed
/// at a background window, and the failure looks like the gesture simply
/// missing.
async fn touch_front(profile: &str) {
    let _ = cdp::page_call(profile, "Page.bringToFront", json!({})).await;
}

/// Arithmetic on variables. Values that are not numbers are an error rather
/// than a silent zero — a total that quietly counted a failed read as nothing
/// is worse than one that stopped.
fn arithmetic(op: &str, a: f64, b: f64) -> Result<f64> {
    Ok(match op {
        "+" | "sum" | "add" => a + b,
        "-" | "sub" => a - b,
        "*" | "mul" => a * b,
        "/" | "div" => {
            if b == 0.0 {
                return Err(anyhow!("cannot divide by zero"));
            }
            a / b
        }
        "%" | "mod" => {
            if b == 0.0 {
                return Err(anyhow!("cannot take a remainder by zero"));
            }
            a % b
        }
        "min" => a.min(b),
        "max" => a.max(b),
        other => return Err(anyhow!("unknown operation \"{other}\"")),
    })
}

/// Variable names are ASCII on purpose. `{{имя}}` and `{{name}}` look alike in
/// a list and substitute differently, and a project shared between people is
/// read by someone whose keyboard may not make the first one at all.
fn check_var_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("a variable needs a name"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
    {
        return Err(anyhow!(
            "\"{name}\" — a variable name may only use English letters, digits, _ and ."
        ));
    }
    Ok(name.to_string())
}

fn as_number(vars: &HashMap<String, String>, raw: &str) -> Result<f64> {
    let expanded = expand(raw, vars);
    expanded
        .trim()
        .parse::<f64>()
        .map_err(|_| anyhow!("\"{expanded}\" is not a number"))
}

/// Trims a float that came out whole, so a count reads 3 and not 3.
fn tidy(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Brings up the bound profile's browser if it is not already connected.
///
/// Lazily, because the graph decides which profile there is: a project that
/// starts by making a temporary profile has nothing to launch until that block
/// has run.
async fn ensure_browser(bound: &Bound, run: &Run, ctx: &CallCtx) -> Result<()> {
    // Re-read the trusted receipt on every action. A replaced process must not
    // inherit an old socket or lease just because the Profile UUID is equal.
    let endpoint = match run.host.resolve_cdp(&bound.id).await? {
        Some(endpoint) => endpoint,
        None => {
            cdp::record_effect();
            run.host.start_profile(ctx.intent()?, &bound.id).await?
        }
    };
    if cdp::matches_instance(&bound.id, &endpoint.instance_id) {
        cdp::mark_run(&bound.id);
        return Ok(());
    }
    cdp::detach(&bound.id);
    cdp::attach(bound.id.clone(), endpoint, |_| {}).await?;
    if !run.rules.is_empty() {
        // A missing interception capability must fail before navigation.
        cdp::page_call(
            &bound.id,
            "Traffic.mount",
            json!({
                "rules": serde_json::to_string(&run.rules)?
            }),
        )
        .await?;
    }
    Ok(())
}

/// What a block did. `EndPass` ends the rest of this pass; `Else` is a
/// condition that came out false — it takes the block's "when it fails" branch
/// without being an error.
#[derive(Debug)]
enum Flow {
    Cancelled,
    Next,
    EndPass,
    Else,
}

/// Compares two values for an `if` block. Numbers are compared as numbers when
/// both parse; otherwise as text. `b` is ignored for the empty/not-empty tests.
fn cond_holds(a: &str, op: &str, b: &str) -> bool {
    let nums = a
        .trim()
        .parse::<f64>()
        .ok()
        .zip(b.trim().parse::<f64>().ok());
    match op {
        "=" | "==" | "equals" => a == b,
        "≠" | "!=" | "not equals" => a != b,
        "contains" => a.contains(b),
        "not contains" => !a.contains(b),
        "starts with" => a.starts_with(b),
        "ends with" => a.ends_with(b),
        "is empty" => a.trim().is_empty(),
        "is not empty" => !a.trim().is_empty(),
        ">" => nums.map(|(x, y)| x > y).unwrap_or(false),
        ">=" => nums.map(|(x, y)| x >= y).unwrap_or(false),
        "<" => nums.map(|(x, y)| x < y).unwrap_or(false),
        "<=" => nums.map(|(x, y)| x <= y).unwrap_or(false),
        _ => false,
    }
}

/// Every bit of text under a node, in document order.
///
/// Walked here rather than asked of the page, because asking means running a
/// function in it and this feature's whole point is that it never does. Script
/// and style bodies are skipped: they are text to the DOM and not to a person.
fn gather_text(node: &Value, out: &mut String) {
    let name = node
        .get("nodeName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    if matches!(name.as_str(), "SCRIPT" | "STYLE" | "NOSCRIPT" | "TEMPLATE") {
        return;
    }
    if node.get("nodeType").and_then(|t| t.as_i64()) == Some(3) {
        if let Some(v) = node.get("nodeValue").and_then(|v| v.as_str()) {
            out.push_str(v);
            out.push(' ');
        }
    }
    for key in ["children", "shadowRoots", "contentDocument"] {
        match node.get(key) {
            Some(Value::Array(kids)) => {
                for kid in kids {
                    gather_text(kid, out);
                }
            }
            Some(one @ Value::Object(_)) => gather_text(one, out),
            _ => {}
        }
    }
}

/// The text under the first element a selector matches.
async fn element_text(profile: &str, selector: &str) -> Result<String> {
    let node = *cdp::query_piercing(profile, selector)
        .await?
        .first()
        .ok_or_else(|| anyhow!("no element matches {selector}"))?;
    let described = cdp::page_call(
        profile,
        "DOM.describeNode",
        json!({ "nodeId": node, "depth": -1, "pierce": true }),
    )
    .await?;
    let mut text = String::new();
    if let Some(node) = described.get("node") {
        gather_text(node, &mut text);
    }
    Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Where the page is now. Empty when the browser will not say.
async fn current_url(profile: &str) -> Result<String> {
    let hist = cdp::page_call(profile, "Page.getNavigationHistory", json!({})).await?;
    let idx = hist
        .get("currentIndex")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Ok(hist
        .get("entries")
        .and_then(|e| e.as_array())
        .and_then(|e| e.get(idx.max(0) as usize))
        .and_then(|e| e.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Waits for a navigation to settle. Primarily the load event — but an instant
/// synthetic response (a `fulfill` rule) can fire it before the watcher gets to
/// poll, so also finish when document.readyState reaches "complete" at a URL
/// that is no longer `before`. Returns on either, or when the window closes (a
/// slow page still gets the whole timeout).
async fn await_load(
    profile: &str,
    wait: Option<cdp::EventWait>,
    before: &str,
    timeout: Duration,
) -> Result<()> {
    let pid = profile.to_string();
    let was = before.to_string();
    let poll = async move {
        loop {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let rs = cdp::page_call(
                &pid,
                "Runtime.evaluate",
                json!({ "expression": "document.readyState", "returnByValue": true }),
            )
            .await?;
            if rs.pointer("/result/value").and_then(Value::as_str) == Some("complete")
                && current_url(&pid).await? != was
            {
                return Ok::<(), anyhow::Error>(());
            }
        }
    };
    match wait {
        Some(w) => {
            tokio::select! {
                _ = w.until("Page.loadEventFired", timeout) => {}
                result = poll => { result?; }
                _ = tokio::time::sleep(timeout) => {}
            }
        }
        None => {
            if let Ok(result) = tokio::time::timeout(timeout, poll).await {
                result?;
            }
        }
    }
    Ok(())
}

/// "Name: value" lines → the header-op array the core's Traffic rules take.
fn traffic_headers(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() {
                return None;
            }
            let (n, v) = l.split_once(':')?;
            Some(json!({ "name": n.trim(), "value": v.trim() }))
        })
        .collect()
}

/// The match half of a Traffic rule from a block's url/method/resource params.
fn traffic_match(p: &Value, vars: &HashMap<String, String>) -> Value {
    let mut m = serde_json::Map::new();
    for key in ["url", "host", "method", "resource"] {
        if let Some(raw) = param(p, key) {
            let v = expand(raw, vars);
            let v = v.trim();
            if !v.is_empty() && v != "any" {
                m.insert(key.to_string(), json!(v));
            }
        }
    }
    Value::Object(m)
}

/// Builds one Traffic rule ({match, action}) from a traffic.* block's params.
fn build_traffic_rule(kind: &str, p: &Value, vars: &HashMap<String, String>) -> Result<Value> {
    let g = |k: &str| param(p, k).map(|s| expand(s, vars)).unwrap_or_default();
    let mut a = serde_json::Map::new();
    match kind {
        "traffic.block" => {
            a.insert("type".into(), json!("block"));
            let reason = g("reason");
            if !reason.trim().is_empty() {
                a.insert("blockReason".into(), json!(reason.trim()));
            }
        }
        "traffic.redirect" => {
            let to = g("to");
            if to.trim().is_empty() {
                return Err(anyhow!("redirect needs a target address"));
            }
            a.insert("type".into(), json!("redirect"));
            a.insert("setUrl".into(), json!(to.trim()));
        }
        "traffic.setHeaders" => {
            a.insert("type".into(), json!("modify"));
            let hs = traffic_headers(&g("headers"));
            if !hs.is_empty() {
                a.insert("setHeaders".into(), json!(hs));
            }
            let body = g("setBody");
            if !body.is_empty() {
                a.insert("setBody".into(), json!(body));
            }
            let method = g("setMethod");
            if !method.trim().is_empty() {
                a.insert("setMethod".into(), json!(method.trim()));
            }
        }
        "traffic.editResponse" => {
            a.insert("type".into(), json!("modify"));
            if let Some(n) = param_f64(p, "status", vars) {
                a.insert("setStatus".into(), json!(n as i64));
            }
            let hs = traffic_headers(&g("responseHeaders"));
            if !hs.is_empty() {
                a.insert("setResponseHeaders".into(), json!(hs));
            }
            let body = g("responseBody");
            if !body.is_empty() {
                a.insert("setResponseBody".into(), json!(body));
            }
        }
        "traffic.fulfill" => {
            a.insert("type".into(), json!("fulfill"));
            if let Some(n) = param_f64(p, "status", vars) {
                a.insert("status".into(), json!(n as i64));
            }
            let hs = traffic_headers(&g("responseHeaders"));
            if !hs.is_empty() {
                a.insert("responseHeaders".into(), json!(hs));
            }
            let body = g("responseBody");
            if !body.is_empty() {
                a.insert("responseBody".into(), json!(body));
            }
        }
        _ => return Err(anyhow!("unknown traffic rule kind {kind}")),
    }
    Ok(json!({ "match": traffic_match(p, vars), "action": Value::Object(a) }))
}

/// How a sub-flow ended.
enum WalkEnd {
    /// It reached the end, or a step said Stop after succeeding, or the pass
    /// was ended from inside. All three mean "the flow finished".
    Ran,
    /// A step failed and its "when it fails" edge was Stop, so the failure is
    /// the flow's. The CALLER's own edge then decides what that means.
    Failed(anyhow::Error),
    /// The operator stopped the run while the flow was running.
    Stopped,
}

/// Walks a saved project's blocks as a sub-flow.
///
/// Deliberately not the worker's own loop: that one owns the worker's status,
/// its pass counter and its retry table, and a sub-flow borrowing them would
/// mark the CALLER's worker failed for a failure the caller may well handle.
/// The branch rules are the same; the bookkeeping is not.
async fn walk_flow(
    steps: &[automation::Block],
    entry: usize,
    bound: &mut Bound,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
) -> WalkEnd {
    let mut at = entry;
    let mut retries: HashMap<usize, u32> = HashMap::new();
    let mut hops: u32 = 0;

    while at < steps.len() {
        if run.stop.load(Ordering::Relaxed) {
            return WalkEnd::Stopped;
        }
        hops += 1;
        if hops > 10_000 {
            return WalkEnd::Failed(anyhow!("this flow jumped 10000 times without finishing"));
        }

        let block = &steps[at];
        let outcome = Box::pin(run_block(bound, block, vars, run, ctx)).await;
        if outcome
            .as_ref()
            .err()
            .map(host::is_unknown)
            .unwrap_or(false)
        {
            return WalkEnd::Failed(outcome.err().expect("unknown outcome"));
        }
        let branch = match &outcome {
            Ok(Flow::Next) => block.on_done.clone(),
            Ok(Flow::Cancelled) => return WalkEnd::Stopped,
            Ok(Flow::EndPass) => automation::Branch::EndPass,
            Ok(Flow::Else) => block.on_fail.clone(),
            Err(_e) => {
                run.log(format!(
                    "flow step {} failed; inspect durable intent",
                    at + 1
                ));
                block.on_fail.clone()
            }
        };

        match branch {
            automation::Branch::Next => {
                retries.remove(&at);
                at += 1;
            }
            automation::Branch::Stop => {
                return match outcome {
                    Err(e) => WalkEnd::Failed(e),
                    // Stop after a step that worked is how a flow says "done",
                    // not how it says "something went wrong".
                    _ => WalkEnd::Ran,
                };
            }
            automation::Branch::EndPass => return WalkEnd::Ran,
            automation::Branch::Goto(target) => {
                retries.remove(&at);
                match steps.iter().position(|b| b.id == target) {
                    Some(next) => at = next,
                    None => at += 1,
                }
            }
            automation::Branch::Retry(times) => {
                let used = retries.entry(at).or_insert(0);
                if *used < times {
                    *used += 1;
                    tokio::time::sleep(Duration::from_millis(600)).await;
                } else {
                    retries.remove(&at);
                    at += 1;
                }
            }
        }
    }
    WalkEnd::Ran
}

/// Reads a "name=value, other={{var}}" list into pairs, expanded.
fn name_value_list(raw: &str, vars: &HashMap<String, String>) -> Vec<(String, String)> {
    raw.split(|c| c == ',' || c == '\n')
        .filter_map(|part| part.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), expand(v.trim(), vars)))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

fn name_list(raw: &str) -> Vec<String> {
    raw.split(|c| c == ',' || c == '\n')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Finds the project a `flow.call` names.
///
/// By id first and by name second, and never silently: an id is not portable
/// because import mints a fresh one, and a name is not unique because nothing
/// stops two projects sharing one. Both are stored so a bundle that travelled
/// still resolves, and an ambiguous or missing name is an error rather than a
/// guess — the wrong guess here runs somebody else's graph against a live
/// profile.
fn resolve_flow(run: &Run, id: &str, name: &str) -> Result<automation::Project> {
    if !id.is_empty() {
        if let Some(p) = run.projects.iter().find(|p| p.id == id) {
            return Ok(p.clone());
        }
    }
    if !name.is_empty() {
        let mut hits = run.projects.iter().filter(|p| p.name == name);
        match (hits.next(), hits.next()) {
            (Some(p), None) => return Ok(p.clone()),
            (Some(_), Some(_)) => {
                return Err(anyhow!(
                    "more than one project is called \"{name}\" — the call cannot tell which"
                ));
            }
            _ => {}
        }
    }
    Err(anyhow!(
        "the flow this step calls is not on this machine{}",
        if name.is_empty() {
            String::new()
        } else {
            format!(" (\"{name}\")")
        }
    ))
}

/// Runs a resolved project as a sub-flow. The frame is already entered.
async fn call_flow(
    bound: &mut Bound,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
    callee: &automation::Project,
    p: &Value,
) -> Result<Flow> {
    let mut steps: Vec<automation::Block> = callee
        .blocks
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();
    if steps.is_empty() {
        return Err(anyhow!("\"{}\" has no steps to run", callee.name));
    }
    // Same order the project runs in on its own: down the visual stack, by
    // column then height.
    steps.sort_by(|a, b| {
        let ca = (a.x / 40.0).round() as i64;
        let cb = (b.x / 40.0).round() as i64;
        ca.cmp(&cb)
            .then(a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal))
    });

    // Where to start. A named entry is a block id — usually a flow.entry
    // marker, but any block will do. An entry that no longer exists is an
    // error, never a silent fall back to the top: running somebody's whole
    // graph when they asked for one piece of it is the worst available answer.
    let wanted_entry = expand(param(p, "entry").unwrap_or(""), vars);
    let entry = if wanted_entry.is_empty() {
        steps
            .iter()
            .position(|b| b.id == callee.run.start)
            .unwrap_or(0)
    } else {
        steps
            .iter()
            .position(|b| {
                b.id == wanted_entry
                    || (b.kind == "flow.entry"
                        && param(&b.params, "name")
                            .map(|n| n == wanted_entry)
                            .unwrap_or(false))
            })
            .ok_or_else(|| anyhow!("\"{}\" has no entry called \"{wanted_entry}\"", callee.name))?
    };

    // Variables. Shared by default, because they are the run's and a sub-flow
    // is a piece of the same run. Naming anything in "in" switches to a private
    // map: the flow then sees only what was handed to it, and only the names in
    // "out" come back. That is the shape a caller wants when the flow is a
    // reusable piece rather than an inlined section.
    let given = name_value_list(param(p, "in").unwrap_or(""), vars);
    let wanted_out = name_list(param(p, "out").unwrap_or(""));
    let isolated = !given.is_empty() || !wanted_out.is_empty();

    let mut inner_vars = if isolated {
        let mut m: HashMap<String, String> = HashMap::new();
        // The two the runner itself sets travel with the worker, not with the
        // graph, so a flow that logs "pass 3" is not lying.
        for k in ["thread", "pass"] {
            if let Some(v) = vars.get(k) {
                m.insert(k.to_string(), v.clone());
            }
        }
        for (k, v) in given {
            m.insert(check_var_name(&k)?, v);
        }
        m
    } else {
        vars.clone()
    };

    run.log(format!(
        "entering flow \"{}\"{}",
        callee.name,
        if wanted_entry.is_empty() {
            String::new()
        } else {
            format!(" at {wanted_entry}")
        }
    ));
    let end = Box::pin(walk_flow(&steps, entry, bound, &mut inner_vars, run, ctx)).await;

    // The outcome first. A flow that failed has no promises to keep, and
    // checking them here would report "finished without setting X" over the top
    // of the reason it actually stopped.
    match end {
        WalkEnd::Failed(e) => return Err(e),
        // The operator stopped the run; ending this pass is how that travels
        // back up through however many frames are above.
        WalkEnd::Stopped => return Ok(Flow::EndPass),
        WalkEnd::Ran => {}
    }

    if isolated {
        for name in wanted_out {
            match inner_vars.get(&name) {
                Some(v) => {
                    vars.insert(check_var_name(&name)?, v.clone());
                }
                // Silence here would read as "the flow returned an empty
                // string", which is a different and much harder bug to find.
                None => {
                    return Err(anyhow!(
                        "\"{}\" finished without setting \"{name}\"",
                        callee.name
                    ));
                }
            }
        }
    } else {
        *vars = inner_vars;
    }

    run.log(format!("left flow \"{}\"", callee.name));
    Ok(Flow::Next)
}

/// All recursive actions cross the same intent and reconciliation boundary.
async fn run_block(
    bound: &mut Bound,
    block: &automation::Block,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
) -> Result<Flow> {
    if let Ok(mut secrets) = run.redactions.lock() {
        for name in block.secrets.iter().map(String::as_str).chain([
            "password", "token", "secret", "proxy", "headers", "body", "text", "value",
        ]) {
            if let Some(value) = block.params.get(name).and_then(Value::as_str) {
                let value = expand(value, vars);
                if !value.is_empty() {
                    secrets.insert(value);
                }
            }
        }
    }
    ctx.sequence += 1;
    let key = StepKey {
        worker: ctx.worker,
        pass: ctx.pass,
        sequence: ctx.sequence,
        block_id: block.id.clone(),
        kind: block.kind.clone(),
        call_stack: ctx.stack.iter().map(Frame::name).collect(),
    };
    let inputs = json!({ "params": block.params, "variables": vars,
        "profile": bound, "temporary_profiles": ctx.temps });
    let intent = loop {
        match run.host.allocate_step(&key, &inputs).await {
            Ok(intent) => break intent,
            Err(_) => {
                run.worker(ctx.worker, |worker| {
                    worker.status = "persistence_error".into()
                });
                if run.stop.load(Ordering::Relaxed) {
                    return Err(host::outcome_unknown("intent allocation interrupted"));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };
    let previous = ctx.active_intent.replace(intent.clone());
    run.worker(ctx.worker, |worker| {
        worker.pending_intent = Some(intent.clone());
        worker.variables = vars.clone();
        worker.temporary_profiles = ctx.temps.clone();
    });
    let result = execute_intent(bound, block, vars, run, ctx, &intent).await;
    ctx.active_intent = previous;
    result
}

async fn persist_until_saved(run: &Run, worker: usize) -> Result<()> {
    loop {
        match run.persist().await {
            Ok(()) => return Ok(()),
            Err(_) => {
                run.worker(worker, |worker| worker.status = "persistence_error".into());
                if run.stop.load(Ordering::Relaxed) {
                    return Err(host::outcome_unknown("state persistence interrupted"));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

async fn execute_intent(
    bound: &mut Bound,
    block: &automation::Block,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
    intent: &StepIntent,
) -> Result<Flow> {
    persist_until_saved(run, ctx.worker).await?;
    let mut result = {
        let writes = Arc::new(AtomicBool::new(false));
        let action = Box::pin(cdp::track_action(
            writes.clone(),
            run_block_inner(bound, block, vars, run, ctx),
        ));
        tokio::pin!(action);
        loop {
            tokio::select! {
                result = &mut action => break result,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if run.stop.load(Ordering::Relaxed) && block.kind != "engine.cleanup"
                        && block.kind != "flow.call" && !block.kind.starts_with("module:") {
                        break if writes.load(Ordering::Acquire) {
                            Err(host::outcome_unknown("step cancelled after side-effect dispatch; result requires reconciliation"))
                        } else { Ok(Flow::Cancelled) };
                    }
                }
            }
        }
    };
    if result.as_ref().err().map(host::is_unknown).unwrap_or(false) {
        let child_pending = run
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .workers
                    .get(ctx.worker)
                    .and_then(|worker| worker.pending_intent.as_ref())
                    .map(|pending| pending.id != intent.id)
            })
            .unwrap_or(false);
        if child_pending {
            // The deepest action already owns the reconciliation record. An
            // enclosing flow/module must preserve its identity when unwinding.
            return result;
        }
        run.worker(ctx.worker, |worker| {
            worker.status = "reconciling".into();
            worker.note = format!("outcome unknown for intent {}", intent.id);
        });
        let reason = "step result requires reconciliation";
        loop {
            // A failed write never authorizes a new attempt.
            if run.host.mark_unknown(intent, reason).await.is_ok() {
                break;
            }
            if run.stop.load(Ordering::Relaxed) {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        persist_until_saved(run, ctx.worker).await?;
        loop {
            if run.stop.load(Ordering::Relaxed) {
                return result;
            }
            match run.host.reconcile(intent).await {
                Ok(Reconciliation::Committed(completion)) => {
                    *vars = completion.variables;
                    *bound = Bound {
                        id: completion.profile_id,
                        temporary: completion.temporary,
                        mobile: completion.mobile,
                    };
                    ctx.temps = completion.temporary_profiles;
                    result = match completion.flow.as_str() {
                        "next" => Ok(Flow::Next),
                        "else" => Ok(Flow::Else),
                        "end_pass" => Ok(Flow::EndPass),
                        "cancelled" => Ok(Flow::Cancelled),
                        _ => return Err(host::outcome_unknown("invalid reconciled flow result")),
                    };
                    break;
                }
                Ok(Reconciliation::Retryable(reason) | Reconciliation::Failed(reason)) => {
                    result = Err(anyhow!(reason));
                    break;
                }
                Ok(Reconciliation::Pending) | Err(_) => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }
    match &result {
        Ok(flow) => {
            let completion = StepCompletion {
                flow: match flow {
                    Flow::Cancelled => "cancelled",
                    Flow::Next => "next",
                    Flow::Else => "else",
                    Flow::EndPass => "end_pass",
                }
                .into(),
                variables: vars.clone(),
                profile_id: bound.id.clone(),
                temporary: bound.temporary,
                mobile: bound.mobile,
                temporary_profiles: ctx.temps.clone(),
            };
            loop {
                if run.host.complete_step(intent, &completion).await.is_ok() {
                    break;
                }
                run.worker(ctx.worker, |worker| {
                    worker.status = "persistence_error".into()
                });
                if run.stop.load(Ordering::Relaxed) {
                    return Err(host::outcome_unknown(
                        "completed action awaits durable result",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        Err(_) => loop {
            if run
                .host
                .fail_step(intent, "step failed with confirmed outcome")
                .await
                .is_ok()
            {
                break;
            }
            run.worker(ctx.worker, |worker| {
                worker.status = "persistence_error".into()
            });
            if run.stop.load(Ordering::Relaxed) {
                return Err(host::outcome_unknown("failed action awaits durable result"));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        },
    }
    run.worker(ctx.worker, |worker| {
        worker.status = "running".into();
        worker.pending_intent = None;
        worker.variables = vars.clone();
        worker.temporary_profiles = ctx.temps.clone();
        worker.profile_id = bound.id.clone();
    });
    persist_until_saved(run, ctx.worker).await?;
    result
}

async fn run_block_inner(
    bound: &mut Bound,
    block: &automation::Block,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
) -> Result<Flow> {
    const BUILTIN_KINDS: &[&str] = &[
        "stop",
        "count",
        "back",
        "clear",
        "click",
        "db.close",
        "db.exec",
        "db.open",
        "db.query",
        "doubleClick",
        "drag",
        "engine.cleanup",
        "file.append",
        "file.readLine",
        "flow.call",
        "flow.entry",
        "forward",
        "goto",
        "hover",
        "http.endSession",
        "http.request",
        "if.exists",
        "if.text",
        "if.url",
        "if.value",
        "ifExists",
        "log",
        "press",
        "profile.create",
        "profile.delete",
        "profile.keep",
        "profile.read",
        "profile.temp",
        "profile.use",
        "proxy.generate",
        "proxy.residential",
        "proxy.set",
        "proxy.swap",
        "readAttribute",
        "readText",
        "reload",
        "rightClick",
        "screen.rotate",
        "screenshot",
        "script.run",
        "scroll",
        "setVar",
        "swipe",
        "touch.drag",
        "touch.longPress",
        "touch.pinch",
        "touch.swipe",
        "touch.tap",
        "traffic.block",
        "traffic.editResponse",
        "traffic.fulfill",
        "traffic.observe",
        "traffic.redirect",
        "traffic.setHeaders",
        "type",
        "var.autofill",
        "var.math",
        "var.random",
        "var.set",
        "wait",
        "waitFor",
        "waitGone",
        "waitLoad",
        "waitText",
        "waitUrl",
    ];
    if !BUILTIN_KINDS.contains(&block.kind.as_str()) && !block.kind.starts_with("module:") {
        return Err(anyhow!("unknown automation step {}", block.kind));
    }
    let p = &block.params;
    if let Some(into) = param(p, "into") {
        check_var_name(into)?;
    }
    static FILE_OPERATIONS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _file_guard = if matches!(block.kind.as_str(), "file.readLine" | "file.append") {
        Some(
            FILE_OPERATIONS
                .get_or_init(|| tokio::sync::Mutex::new(()))
                .lock()
                .await,
        )
    } else {
        None
    };

    // Before anything is interpreted: when this work is a module's, the places
    // where the block vocabulary is itself an escape are refused. One check,
    // here, because every page action in this file is inside this function or a
    // helper it calls — see modguard.
    if let Some(module) = ctx.on_behalf_of() {
        let data_dir = wasm::data_dir(module)?;
        super::modguard::check(module, &block.kind, p, vars, &data_dir)?;
    }
    ctx.refuse_laundering(block)?;

    // A profile or proxy step reads and writes the space the run started in, or none.
    if block.kind.starts_with("profile.") || block.kind.starts_with("proxy.") {
        // Host checks immutable connection ownership for every operation.
    }

    // Profile, proxy, variable and file blocks touch no page, so they run
    // before the "is a browser attached" check below.
    match block.kind.as_str() {
        "engine.cleanup" => {
            if ctx.on_behalf_of().is_some() {
                return Err(anyhow!("modules cannot invoke internal cleanup"));
            }
            if !bound.id.is_empty() {
                cdp::record_effect();
                run.host.stop_profile(ctx.intent()?, &bound.id).await?;
                cdp::detach(&bound.id);
                run.host.release_profile(ctx.worker, &bound.id).await?;
            }
            for id in ctx.temps.clone() {
                if id != bound.id {
                    cdp::record_effect();
                    run.host.stop_profile(ctx.intent()?, &id).await?;
                    cdp::detach(&id);
                }
                cdp::record_effect();
                run.host.delete_profile(ctx.intent()?, &id, true).await?;
                run.host.release_profile(ctx.worker, &id).await?;
                ctx.temps.retain(|temp| temp != &id);
            }
            return Ok(Flow::Next);
        }
        "profile.create" | "profile.temp" => {
            let temporary = block.kind == "profile.temp";
            let name = expand(param(p, "name").unwrap_or(""), vars);
            let folder = expand(
                param(p, "folder").unwrap_or(if temporary { "" } else { "Automation" }),
                vars,
            );
            let platform = param(p, "platform").map(|s| expand(s, vars));
            let inline = param(p, "proxy").map(|s| expand(s, vars));
            cdp::record_effect();
            let made = run
                .host
                .create_profile(
                    ctx.intent()?,
                    CreateProfile {
                        name: name.clone(),
                        folder,
                        platform,
                        inline_proxy: inline.clone(),
                        temporary,
                    },
                )
                .await?;
            let id = made.id;
            run.log(format!(
                "{} profile {id}{}",
                if temporary {
                    "made a temporary"
                } else {
                    "made"
                },
                if inline.is_some() {
                    " with a proxy"
                } else {
                    ""
                }
            ));
            // Switching profiles means the old browser is no longer this
            // worker's; let go of it rather than leaving a stale connection.
            if !bound.id.is_empty() && bound.id != id {
                cdp::detach(&bound.id);
                run.host.release_profile(ctx.worker, &bound.id).await?;
            }
            // Remembered, not just bound: cleanup used to look at whatever was
            // FINALLY bound, so a graph that made a second temporary profile
            // left the first one behind for ever.
            if temporary {
                ctx.remember_temp(&id);
            }
            *bound = Bound {
                id: id.clone(),
                temporary,
                mobile: made.mobile,
            };
            if let Some(into) = param(p, "into") {
                vars.insert(check_var_name(into)?, id);
            }
            return Ok(Flow::Next);
        }
        "profile.use" => {
            let id = expand(param(p, "id").context("no profile id")?, vars);
            let selected = run.host.use_profile(ctx.intent()?, &id).await?;
            if !bound.id.is_empty() && bound.id != id {
                cdp::detach(&bound.id);
                run.host.release_profile(ctx.worker, &bound.id).await?;
            }
            *bound = Bound {
                mobile: selected.mobile,
                id,
                temporary: selected.temporary,
            };
            return Ok(Flow::Next);
        }
        "profile.keep" => {
            // A temporary profile the operator decided to hold on to.
            if bound.id.is_empty() {
                return Err(anyhow!("no profile to keep"));
            }
            let folder = param(p, "folder").map(|value| expand(value, vars));
            cdp::record_effect();
            run.host
                .keep_profile(ctx.intent()?, &bound.id, folder)
                .await?;
            ctx.temps.retain(|id| id != &bound.id);
            bound.temporary = false;
            run.log(format!("kept profile {}", bound.id));
            return Ok(Flow::Next);
        }
        "profile.delete" => {
            let id = param(p, "id")
                .map(|s| expand(s, vars))
                .unwrap_or_else(|| bound.id.clone());
            if id.is_empty() {
                return Err(anyhow!("no profile to delete"));
            }
            cdp::record_effect();
            run.host.stop_profile(ctx.intent()?, &id).await?;
            cdp::detach(&id);
            cdp::record_effect();
            run.host.delete_profile(ctx.intent()?, &id, false).await?;
            run.host.release_profile(ctx.worker, &id).await?;
            ctx.temps.retain(|temp| temp != &id);
            run.log(format!("deleted profile {id}"));
            if bound.id == id {
                *bound = Bound::default();
            }
            return Ok(Flow::Next);
        }
        "proxy.set" => {
            if bound.id.is_empty() {
                return Err(anyhow!("no profile to give a proxy to"));
            }
            let line = expand(param(p, "proxy").context("no proxy")?, vars);
            cdp::record_effect();
            run.host.set_proxy(ctx.intent()?, &bound.id, &line).await?;
            run.log("attached a proxy to the profile");
            return Ok(Flow::Next);
        }
        "proxy.generate" | "proxy.residential" => {
            return Err(anyhow!(
                "{} requires the proprietary ProxyShard service, which is not configured in Raccoon",
                block.kind
            ));
        }
        "profile.read" => {
            if bound.id.is_empty() {
                return Err(anyhow!("no profile to read from"));
            }
            let path = expand(param(p, "path").context("no field")?, vars);
            let whole = run.host.read_profile(&bound.id).await?.data;
            // A dotted path into the profile as it is stored, so everything it
            // carries is reachable: navigator.user_agent, screen.width,
            // timezone.id, client_hints.platform_version, _meta.folder.
            let mut cur = &whole;
            for part in path.split('.') {
                cur = cur
                    .get(part)
                    .ok_or_else(|| anyhow!("this profile has no \"{path}\""))?;
            }
            let value = match cur {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            if let Some(into) = param(p, "into") {
                vars.insert(check_var_name(into)?, value);
            }
            return Ok(Flow::Next);
        }
        "var.autofill" => {
            if bound.id.is_empty() {
                return Err(anyhow!("no profile to read a person from"));
            }
            let field = expand(param(p, "field").context("no field")?, vars);
            let value = run.host.autofill(&bound.id, &field).await?;
            if let Some(into) = param(p, "into") {
                vars.insert(check_var_name(into)?, value);
            }
            return Ok(Flow::Next);
        }
        // "setVar" is what this step was called before the var.* group; projects
        // saved then still carry it, and a module may still emit it.
        "var.set" | "setVar" => {
            let name = check_var_name(param(p, "name").context("no name")?)?;
            vars.insert(name, expand(param(p, "value").unwrap_or(""), vars));
            return Ok(Flow::Next);
        }
        "var.math" => {
            let op = param(p, "op").unwrap_or("+");
            let a = as_number(vars, param(p, "a").unwrap_or("0"))?;
            let b = as_number(vars, param(p, "b").unwrap_or("0"))?;
            let out = tidy(arithmetic(op, a, b)?);
            let into = check_var_name(param(p, "into").context("no name to save into")?)?;
            run.log("calculated a variable");
            vars.insert(into, out);
            return Ok(Flow::Next);
        }
        "http.request" => {
            let url = expand(param(p, "url").context("no address")?, vars);
            let method = param(p, "method").unwrap_or("GET").to_string();
            let into = check_var_name(param(p, "into").context("no name to save into")?)?;
            // "Name: value" per line, the way a request is written down.
            let headers: Vec<(String, String)> = expand(param(p, "headers").unwrap_or(""), vars)
                .lines()
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                .filter(|(k, _)| !k.is_empty())
                .collect();
            let body = param(p, "body")
                .map(|b| expand(b, vars))
                .filter(|b| !b.is_empty());
            let fingerprint = param(p, "fingerprint").map(|f| expand(f, vars));
            let session =
                param(p, "session").map(|x| ctx.resource_key(run, "requests", &expand(x, vars)));

            // Out through the profile's own proxy unless told otherwise: a
            // call that leaves on the host address beside a browser that did
            // not is two visitors, and the site can see both.
            let via = param(p, "via").unwrap_or("profile");
            let proxy = match via {
                "host" => None,
                "profile" if !bound.id.is_empty() => run.host.resolve_proxy(&bound.id).await?,
                "profile" => return Err(anyhow!("HTTP via=profile requires a bound Profile")),
                other => Some(expand(other, vars)),
            };

            let out = super::requests::send(super::requests::Request {
                method,
                url: url.clone(),
                headers,
                body,
                fingerprint,
                session,
                proxy,
                timeout_s: param_f64(p, "timeout", vars).unwrap_or(30.0),
            })
            .await?;

            let status = out.get("status").and_then(|v| v.as_u64()).unwrap_or(0);
            run.log(format!("HTTP response status {status}"));
            // Three names off one: the body under the name asked for, and the
            // status and headers beside it, because a step that answered only
            // with the body would need a second request to check it worked.
            vars.insert(format!("{into}_status"), status.to_string());
            vars.insert(
                format!("{into}_headers"),
                out.get("headers")
                    .map(|h| h.to_string())
                    .unwrap_or_default(),
            );
            vars.insert(
                into,
                out.get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            );
            return Ok(Flow::Next);
        }
        "http.endSession" => {
            let name = ctx.resource_key(
                run,
                "requests",
                &expand(param(p, "session").context("no session to end")?, vars),
            );
            super::requests::drop_session(&name);
            run.log(format!("session {name} forgotten"));
            return Ok(Flow::Next);
        }
        "var.random" => {
            let into = check_var_name(param(p, "into").context("no name to save into")?)?;
            let list = expand(param(p, "list").unwrap_or(""), vars);
            let picked = if !list.trim().is_empty() {
                // A list wins over the range: an operator who filled both meant
                // the list, which is the more specific of the two.
                let items: Vec<&str> = list
                    .split(&[',', '\n'][..])
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                if items.is_empty() {
                    return Err(anyhow!("the list is empty"));
                }
                let i = (uuid::Uuid::new_v4().as_bytes()[0] as usize) % items.len();
                items[i].to_string()
            } else {
                let lo = as_number(vars, param(p, "min").unwrap_or("0"))?;
                let hi = as_number(vars, param(p, "max").unwrap_or("100"))?;
                let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                // 16 bits of the uuid is plenty for a wait or an index and
                // keeps this free of another dependency.
                let b = uuid::Uuid::new_v4();
                let raw = u16::from_le_bytes([b.as_bytes()[0], b.as_bytes()[1]]) as f64 / 65535.0;
                tidy(lo + (hi - lo) * raw)
            };
            run.log("selected a variable value");
            vars.insert(into, picked);
            return Ok(Flow::Next);
        }
        "file.readLine" => {
            let path = expand(param(p, "path").context("no file")?, vars);
            let into = check_var_name(param(p, "into").context("no name to save into")?)?;
            let text = std::fs::read_to_string(&path).with_context(|| format!("read {path}"))?;
            let mut lines = text.lines();
            let line = loop {
                match lines.next() {
                    Some(l) if l.trim().is_empty() => continue,
                    Some(l) => break l.trim().to_string(),
                    None => return Err(anyhow!("{path} has no lines left")),
                }
            };
            // Taking a line means taking it: a list of accounts read without
            // removal hands the same one to every thread, which is how a run
            // ends up logging into a single account forty times over. The file
            // is rewritten whole because these lists are small and a partial
            // rewrite that dies halfway loses the lot.
            if param(p, "take").map(|v| v != "keep").unwrap_or(true) {
                cdp::record_effect();
                let mut rest: Vec<&str> = Vec::new();
                let mut dropped = false;
                for l in text.lines() {
                    if !dropped && l.trim() == line {
                        dropped = true;
                        continue;
                    }
                    rest.push(l);
                }
                std::fs::write(&path, rest.join("\n")).map_err(host::outcome_unknown)?;
            }
            vars.insert(into, line);
            return Ok(Flow::Next);
        }
        "file.append" => {
            let path = expand(param(p, "path").context("no file")?, vars);
            let line = expand(param(p, "line").unwrap_or(""), vars);
            use std::io::Write;
            if let Some(dir) = std::path::Path::new(&path).parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .with_context(|| format!("open {path}"))?;
            cdp::record_effect();
            writeln!(f, "{line}").map_err(host::outcome_unknown)?;
            return Ok(Flow::Next);
        }
        "db.open" => {
            let name = ctx.resource_key(
                run,
                "db",
                &expand(param(p, "name").unwrap_or("default"), vars),
            );
            let driver = expand(param(p, "driver").unwrap_or("sqlite"), vars);
            // "path" for SQLite, "target" (connection string) for the rest —
            // accept either field so the palette can label it per driver.
            let target = param(p, "target")
                .or_else(|| param(p, "path"))
                .map(|s| expand(s, vars))
                .unwrap_or_default();
            let database = param(p, "database").map(|s| expand(s, vars));
            tokio::task::spawn_blocking(move || {
                super::db::open(&name, &driver, &target, database.as_deref())
            })
            .await
            .map_err(|e| anyhow!("db task failed: {e}"))??;
            run.log("opened a database");
            return Ok(Flow::Next);
        }
        "db.exec" => {
            let name = ctx.resource_key(
                run,
                "db",
                &expand(param(p, "name").unwrap_or("default"), vars),
            );
            let sql = expand(param(p, "sql").context("no sql")?, vars);
            cdp::record_effect();
            let out = tokio::task::spawn_blocking(move || super::db::exec(&name, &sql))
                .await
                .map_err(host::outcome_unknown)??;
            if let Some(into) = param(p, "into") {
                let changes = out
                    .get("changes")
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                vars.insert(check_var_name(into)?, changes);
            }
            return Ok(Flow::Next);
        }
        "db.query" => {
            let name = ctx.resource_key(
                run,
                "db",
                &expand(param(p, "name").unwrap_or("default"), vars),
            );
            let sql = expand(param(p, "sql").context("no sql")?, vars);
            cdp::record_effect();
            let (cols, rows) = tokio::task::spawn_blocking(move || super::db::query(&name, &sql))
                .await
                .map_err(host::outcome_unknown)??;
            let n = rows.len();
            let mode = param(p, "mode")
                .map(|s| expand(s, vars))
                .unwrap_or_else(|| "rows".into());
            let value = match mode.as_str() {
                "count" => n.to_string(),
                "value" => rows
                    .first()
                    .and_then(|r| r.as_object())
                    .and_then(|o| cols.first().and_then(|c| o.get(c)))
                    .map(super::db::scalar_to_string)
                    .unwrap_or_default(),
                "row" => rows
                    .first()
                    .map(|r| r.to_string())
                    .unwrap_or_else(|| "null".into()),
                _ => serde_json::Value::Array(rows).to_string(),
            };
            if let Some(into) = param(p, "into") {
                vars.insert(check_var_name(into)?, value);
            }
            run.log(format!("query returned {n} row(s)"));
            return Ok(Flow::Next);
        }
        "db.close" => {
            let name = ctx.resource_key(
                run,
                "db",
                &expand(param(p, "name").unwrap_or("default"), vars),
            );
            tokio::task::spawn_blocking(move || super::db::close(&name))
                .await
                .map_err(host::outcome_unknown)?;
            return Ok(Flow::Next);
        }
        "if.value" => {
            // Compares two values (variables, text, numbers). True takes "when
            // it works"; false takes "when it fails" (the else branch).
            let a = expand(param(p, "a").unwrap_or(""), vars);
            let op = param(p, "op")
                .map(|s| expand(s, vars))
                .unwrap_or_else(|| "=".into());
            let b = expand(param(p, "b").unwrap_or(""), vars);
            let holds = cond_holds(&a, &op, &b);
            run.log(if holds {
                "condition matched"
            } else {
                "condition did not match"
            });
            return Ok(if holds { Flow::Next } else { Flow::Else });
        }
        // A marker, not a step: it names a place in a project that something
        // else can call into. Running past it does nothing, so a project runs
        // standalone exactly as it did before anyone called it.
        "flow.entry" => return Ok(Flow::Next),
        // Runs a saved project as a piece of this one.
        //
        // Above the browser check on purpose: the first thing a called flow
        // usually does is make its own profile, and a sub-flow that could only
        // be called once a browser existed would be useless for the one job
        // everybody wants it for.
        "flow.call" => {
            let wanted_id = expand(param(p, "project").unwrap_or(""), vars);
            let wanted_name = expand(param(p, "projectName").unwrap_or(""), vars);
            let callee = resolve_flow(run, &wanted_id, &wanted_name)?;
            ctx.may_call(&Frame::Flow(callee.id.clone()))?;

            // Enter before anything else: depth, loops and the shared action
            // budget are all decided here, and `leave` has to run on every path
            // out, including an error.
            let saved = ctx.enter(Frame::Flow(callee.id.clone()))?;
            let result = call_flow(bound, vars, run, ctx, &callee, p).await;
            ctx.leave(saved);
            return result;
        }
        _ => {}
    }

    // Everything below drives a page, so there must be a browser by now. A
    // profile block has to be reached before this one — put it above this step
    // in the stack (the run follows the stack top-to-bottom).
    if bound.id.is_empty() {
        return Err(anyhow!(
            "this step needs a profile — put a profile block above it"
        ));
    }
    ensure_browser(bound, run, ctx).await?;
    let profile = bound.id.as_str();

    match block.kind.as_str() {
        "goto" => {
            let url = expand(param(p, "url").context("no address")?, vars);
            let before = current_url(profile).await?;
            let wait = cdp::watch(profile);
            cdp::page_call(profile, "Page.navigate", json!({ "url": url })).await?;
            await_load(profile, wait, &before, Duration::from_secs(30)).await?;
        }
        "proxy.swap" => {
            // Hot-swap the profile's proxy through the core, no restart. Empty
            // proxy = direct. Full URL scheme://user:pass@host:port.
            let proxy = param(p, "proxy")
                .map(|s| expand(s, vars))
                .unwrap_or_default();
            let args = if proxy.trim().is_empty() {
                json!({})
            } else {
                json!({ "proxy": proxy })
            };
            cdp::page_call(profile, "Traffic.setProxy", args).await?;
            run.log("swapped the proxy");
            return Ok(Flow::Next);
        }
        "script.run" => {
            // Inject the operator's JS through the core's Script domain (isolated
            // world by default), not a page-visible CDP evaluate. Source comes
            // inline or from a file.
            let file = param(p, "file")
                .map(|s| expand(s, vars))
                .unwrap_or_default();
            let source = if !file.trim().is_empty() {
                std::fs::read_to_string(file.trim())
                    .with_context(|| format!("reading script {}", file.trim()))?
            } else {
                expand(param(p, "source").unwrap_or(""), vars)
            };
            if source.trim().is_empty() {
                return Err(anyhow!("script.run has no source and no file"));
            }
            let mut args = json!({ "source": source });
            if param(p, "world").map(|s| expand(s, vars)).as_deref() == Some("main") {
                args["world"] = json!("main");
            }
            let out = cdp::page_call(profile, "Script.run", args).await?;
            let result = out
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("null")
                .to_string();
            if let Some(into) = param(p, "into") {
                vars.insert(check_var_name(into)?, result);
            }
            run.log("ran a script");
        }
        "traffic.observe" => {
            // Start (or stop) capturing requests so the Traffic tab can show
            // them. On by default; pass "off" to stop.
            let on = param(p, "enabled").map(|s| expand(s, vars)).as_deref() != Some("off");
            cdp::page_call(profile, "Traffic.observe", json!({ "enabled": on })).await?;
            run.log(if on {
                "watching requests"
            } else {
                "stopped watching requests"
            });
            return Ok(Flow::Next);
        }
        "traffic.block"
        | "traffic.redirect"
        | "traffic.setHeaders"
        | "traffic.editResponse"
        | "traffic.fulfill" => {
            // Mount one interception rule live, at this point in the flow. It
            // takes effect for requests made after it — put it before the step
            // that triggers them. Adds to whatever the project already mounts.
            let rule = build_traffic_rule(&block.kind, p, vars)?;
            let rules_json = serde_json::to_string(&vec![rule]).unwrap_or_else(|_| "[]".into());
            cdp::page_call(profile, "Traffic.mount", json!({ "rules": rules_json })).await?;
            run.log("mounted an interception rule");
            return Ok(Flow::Next);
        }
        "reload" => {
            let wait = cdp::watch(profile);
            cdp::page_call(profile, "Page.reload", json!({})).await?;
            if let Some(w) = wait {
                w.until("Page.loadEventFired", Duration::from_secs(30))
                    .await;
            }
        }
        "back" | "forward" => {
            let hist = cdp::page_call(profile, "Page.getNavigationHistory", json!({})).await?;
            let idx = hist
                .get("currentIndex")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let entries = hist
                .get("entries")
                .and_then(|e| e.as_array())
                .cloned()
                .unwrap_or_default();
            let want = if block.kind == "back" {
                idx - 1
            } else {
                idx + 1
            };
            if want < 0 || want as usize >= entries.len() {
                run.log(format!("{}: nowhere to go", block.kind));
                return Ok(Flow::Next);
            }
            let id = entries[want as usize]
                .get("id")
                .cloned()
                .unwrap_or(Value::Null);
            cdp::page_call(
                profile,
                "Page.navigateToHistoryEntry",
                json!({ "entryId": id }),
            )
            .await?;
        }
        "waitLoad" => {
            let secs = param_f64(p, "timeout", vars).unwrap_or(30.0);
            if let Some(w) = cdp::watch(profile) {
                w.until(
                    "Page.loadEventFired",
                    Duration::from_secs_f64(secs.clamp(0.0, 3600.0)),
                )
                .await;
            }
        }
        // Gestures with no desktop twin. Refused on a desktop profile rather
        // than approximated: the core will not deliver a touch to a window
        // that reports no touchscreen, and a silent no-op would look like the
        // step worked.
        "touch.tap" | "touch.longPress" | "touch.swipe" | "touch.drag" | "touch.pinch" => {
            if !bound.mobile {
                return Err(anyhow!(
                    "\"{}\" is a finger gesture and this profile has no touchscreen — \
                     bind a phone profile, or use the Pointer steps",
                    block.kind
                ));
            }
            let (x, y) = match param(p, "selector") {
                Some(sel) if !sel.trim().is_empty() => {
                    center_waiting(profile, &expand(sel, vars), wait_for(p, vars)).await?
                }
                _ => match (param_f64(p, "x", vars), param_f64(p, "y", vars)) {
                    (Some(x), Some(y)) => (x, y),
                    _ => viewport_center(profile).await?,
                },
            };
            touch_front(profile).await;
            if block.kind == "touch.drag" {
                let to = expand(param(p, "to").context("no element to drag onto")?, vars);
                let (tx, ty) = center_waiting(profile, &to, wait_for(p, vars)).await?;
                let mut args = json!({ "fromX": x, "fromY": y, "toX": tx, "toY": ty });
                if let Some(hold) = param_f64(p, "holdMs", vars) {
                    args["holdMs"] = json!(hold);
                }
                cdp::page_call(profile, "Motion.touchDrag", args).await?;
                return Ok(Flow::Next);
            }
            match block.kind.as_str() {
                "touch.tap" => {
                    let taps = param_f64(p, "tapCount", vars)
                        .unwrap_or(1.0)
                        .clamp(1.0, 3.0) as i64;
                    cdp::page_call(
                        profile,
                        "Motion.touchTap",
                        json!({ "x": x, "y": y, "tapCount": taps }),
                    )
                    .await?;
                }
                "touch.longPress" => {
                    cdp::page_call(profile, "Motion.touchLongPress", json!({ "x": x, "y": y }))
                        .await?;
                }
                "touch.swipe" => {
                    let dx = param_f64(p, "dx", vars).unwrap_or(0.0);
                    let dy = param_f64(p, "dy", vars).unwrap_or(0.0);
                    if dx == 0.0 && dy == 0.0 {
                        return Err(anyhow!("a swipe of nothing goes nowhere — set how far"));
                    }
                    cdp::page_call(
                        profile,
                        "Motion.touchSwipe",
                        json!({ "fromX": x, "fromY": y,
                                           "toX": x + dx, "toY": y + dy }),
                    )
                    .await?;
                }
                _ => {
                    let scale = param_f64(p, "scale", vars).unwrap_or(2.0);
                    if scale <= 0.0 {
                        return Err(anyhow!("a pinch scales by a positive factor"));
                    }
                    cdp::page_call(
                        profile,
                        "Motion.pinch",
                        json!({ "x": x, "y": y, "scale": scale }),
                    )
                    .await?;
                }
            }
        }
        // Turning the handset. Physical and refused on a desktop profile:
        // the two screen numbers are traded only for a phone, so elsewhere the
        // angle would move while screen.width stood still.
        "screen.rotate" => {
            if !bound.mobile {
                return Err(anyhow!(
                    "only a phone profile can be turned — this one claims a desktop screen"
                ));
            }
            let angle = param_f64(p, "angle", vars).unwrap_or(90.0) as i64;
            if !matches!(angle, 0 | 90 | 180 | 270) {
                return Err(anyhow!(
                    "a screen turns to 0, 90, 180 or 270 degrees, not {angle}"
                ));
            }
            let mut args = json!({ "angle": angle });
            if let Some(ms) = param_f64(p, "turnMs", vars) {
                args["turnMs"] = json!(ms);
            }
            let r = cdp::page_call(profile, "Motion.setOrientation", args).await?;
            // Optional, unlike readText's: the turn is the point, and the name
            // is only for a project that branches on portrait vs landscape.
            if let Some(into) = param(p, "into").filter(|s| !s.trim().is_empty()) {
                let t = r
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                vars.insert(check_var_name(into)?, t);
            }
        }
        "click" | "doubleClick" | "rightClick" | "hover" => {
            let (x, y) = match param(p, "selector") {
                Some(sel) => center_waiting(profile, &expand(sel, vars), wait_for(p, vars)).await?,
                None => (
                    param_f64(p, "x", vars).context("no target")?,
                    param_f64(p, "y", vars).context("no target")?,
                ),
            };
            // One palette, two bodies: the operator says WHAT, the runner picks
            // WHAT WITH from the bound profile. The core refuses a pointer on a
            // handset outright, so on such a profile every one of these has to
            // reach for a finger.
            if bound.mobile {
                match block.kind.as_str() {
                    // A phone has no cursor and nothing to hover with. Refused
                    // loudly rather than skipped: a project whose menu opens on
                    // hover must stop, not pretend it worked.
                    "hover" => {
                        return Err(anyhow!(
                            "this profile is a phone and has no cursor — replace \"hover\"                              with a tap or a long press"
                        ));
                    }
                    // The phone's context menu IS a long press.
                    "rightClick" => {
                        touch_front(profile).await;
                        cdp::page_call(profile, "Motion.touchLongPress", json!({ "x": x, "y": y }))
                            .await?;
                    }
                    other => {
                        touch_front(profile).await;
                        let taps = if other == "doubleClick" { 2 } else { 1 };
                        cdp::page_call(
                            profile,
                            "Motion.touchTap",
                            json!({ "x": x, "y": y, "tapCount": taps }),
                        )
                        .await?;
                    }
                }
            } else if block.kind == "hover" {
                cdp::page_call(profile, "Motion.createPointer", json!({ "x": x, "y": y })).await?;
                cdp::page_call(profile, "Motion.glideTo", json!({ "x": x, "y": y })).await?;
            } else {
                let b = match block.kind.as_str() {
                    "doubleClick" => "double",
                    "rightClick" => "right",
                    _ => "left",
                };
                click_at(profile, x, y, b).await?;
            }
        }
        "drag" | "swipe" => {
            let from = expand(param(p, "selector").unwrap_or(""), vars);
            // The starting point: an element if one is named, otherwise the
            // middle of the viewport, which is what a swipe on a page means.
            let (x0, y0) = if from.trim().is_empty() {
                viewport_center(profile).await?
            } else {
                center_waiting(profile, &from, wait_for(p, vars)).await?
            };
            let (x1, y1) = if block.kind == "drag" {
                let to = expand(param(p, "to").context("no element to drag onto")?, vars);
                center_waiting(profile, &to, wait_for(p, vars)).await?
            } else {
                let dx = param_f64(p, "dx", vars).unwrap_or(0.0);
                let dy = param_f64(p, "dy", vars).unwrap_or(0.0);
                if dx == 0.0 && dy == 0.0 {
                    return Err(anyhow!("a swipe of nothing goes nowhere — set how far"));
                }
                (x0 + dx, y0 + dy)
            };
            if bound.mobile {
                touch_front(profile).await;
                // A drag is a HOLD and then a move; a swipe is not. Sending one
                // for the other scrolls a sortable list instead of picking a
                // card up, so they are different commands here too.
                if block.kind == "drag" {
                    let mut args = json!({ "fromX": x0, "fromY": y0, "toX": x1, "toY": y1 });
                    if let Some(hold) = param_f64(p, "holdMs", vars) {
                        args["holdMs"] = json!(hold);
                    }
                    cdp::page_call(profile, "Motion.touchDrag", args).await?;
                } else {
                    cdp::page_call(
                        profile,
                        "Motion.touchSwipe",
                        json!({ "fromX": x0, "fromY": y0, "toX": x1, "toY": y1 }),
                    )
                    .await?;
                }
                return Ok(Flow::Next);
            }
            let button = param(p, "button").unwrap_or("left");
            cdp::page_call(profile, "Motion.createPointer", json!({ "x": x0, "y": y0 })).await?;
            // Glide to the start first: the press has to land on the thing
            // being dragged, and createPointer only says where the hand is.
            cdp::page_call(profile, "Motion.glideTo", json!({ "x": x0, "y": y0 })).await?;
            cdp::page_call(
                profile,
                "Motion.dragTo",
                json!({ "x": x1, "y": y1, "button": button }),
            )
            .await?;
        }
        "scroll" => {
            let dy = param_f64(p, "deltaY", vars).unwrap_or(0.0);
            let dx = param_f64(p, "deltaX", vars).unwrap_or(0.0);
            if dx == 0.0 && dy == 0.0 {
                return Ok(Flow::Next);
            }
            // A wheel scrolls whatever is under the pointer, so where the
            // pointer is decides WHICH scroller moves. Over an element when one
            // is named, otherwise the middle of the actual viewport — a fixed
            // 400,400 landed outside a small window and inside a sidebar in a
            // wide one.
            let (px, py) = match param(p, "selector") {
                Some(sel) => center_waiting(profile, &expand(sel, vars), wait_for(p, vars)).await?,
                None => viewport_center(profile).await?,
            };
            if bound.mobile {
                // A finger scrolls by dragging the content, so it travels
                // AGAINST the scroll — and it cannot travel further than the
                // glass. Long scrolls are cut into strokes, the way a hand
                // swipes several times.
                touch_front(profile).await;
                let (vw, vh) = viewport_size(profile).await?;
                let max_x = (vw * 0.6).max(40.0);
                let max_y = (vh * 0.6).max(40.0);
                let mut left_x = dx;
                let mut left_y = dy;
                // A ceiling on the strokes, so a runaway parameter cannot pin
                // the worker to one step for ever.
                for _ in 0..40 {
                    if left_x.abs() < 1.0 && left_y.abs() < 1.0 {
                        break;
                    }
                    let step_x = left_x.clamp(-max_x, max_x);
                    let step_y = left_y.clamp(-max_y, max_y);
                    cdp::page_call(
                        profile,
                        "Motion.touchSwipe",
                        json!({ "fromX": px, "fromY": py,
                                "toX": px - step_x, "toY": py - step_y,
                                // A replayed scroll must land the distance it
                                // was given; a flick adds a fling on top.
                                "flick": false }),
                    )
                    .await?;
                    left_x -= step_x;
                    left_y -= step_y;
                    tokio::time::sleep(Duration::from_millis(120)).await;
                }
                return Ok(Flow::Next);
            }
            cdp::page_call(profile, "Motion.createPointer", json!({ "x": px, "y": py })).await?;
            let mut args = json!({ "deltaY": dy });
            if dx != 0.0 {
                args["deltaX"] = json!(dx);
            }
            cdp::page_call(profile, "Motion.wheel", args).await?;
        }
        "type" => {
            if let Some(sel) = param(p, "selector") {
                let (x, y) = center_waiting(profile, &expand(sel, vars), wait_for(p, vars)).await?;
                if bound.mobile {
                    touch_front(profile).await;
                    cdp::page_call(profile, "Motion.touchTap", json!({ "x": x, "y": y })).await?;
                } else {
                    click_at(profile, x, y, "left").await?;
                }
            }
            let text = expand(param(p, "text").unwrap_or(""), vars);
            if !text.is_empty() {
                cdp::page_call(profile, "Motion.enterText", json!({ "text": text })).await?;
            }
        }
        "press" => {
            let key = expand(param(p, "key").context("no key")?, vars);
            let mods: Vec<String> = param(p, "modifiers")
                .map(|m| {
                    m.split(|c: char| c == ',' || c == '+')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if bound.mobile && !mods.is_empty() {
                // A soft keyboard has no Control, Alt or Command. A chord sent
                // to one is a key combination the device cannot produce.
                return Err(anyhow!(
                    "a phone's keyboard has no modifier keys — \"{}\" cannot be pressed with {}",
                    key,
                    mods.join("+")
                ));
            }
            let mut args = json!({ "key": key });
            if !mods.is_empty() {
                args["modifiers"] = json!(mods);
            }
            cdp::page_call(profile, "Motion.pressKey", args).await?;
        }
        "clear" => {
            if let Some(sel) = param(p, "selector") {
                let (x, y) = center_waiting(profile, &expand(sel, vars), wait_for(p, vars)).await?;
                if bound.mobile {
                    touch_front(profile).await;
                    cdp::page_call(profile, "Motion.touchTap", json!({ "x": x, "y": y })).await?;
                } else {
                    click_at(profile, x, y, "left").await?;
                }
            }
            if bound.mobile {
                // Select-all is Accel+A, and a phone has neither key. A finger
                // clears a field by holding Backspace, so that is what this
                // does — bounded, because a field of unknown length must not
                // become an unbounded loop.
                let len = param_f64(p, "count", vars)
                    .unwrap_or(120.0)
                    .clamp(1.0, 200.0) as usize;
                for _ in 0..len {
                    cdp::page_call(profile, "Motion.pressKey", json!({ "key": "Backspace" }))
                        .await?;
                }
            } else {
                cdp::page_call(
                    profile,
                    "Motion.pressKey",
                    json!({ "key": "a", "modifiers": ["Accel"] }),
                )
                .await?;
                cdp::page_call(profile, "Motion.pressKey", json!({ "key": "Backspace" })).await?;
            }
        }
        "wait" => {
            let secs = param_f64(p, "seconds", vars)
                .unwrap_or(1.0)
                .clamp(0.0, 3600.0);
            tokio::time::sleep(Duration::from_secs_f64(secs.clamp(0.0, 3600.0))).await;
        }
        "waitFor" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let secs = param_f64(p, "timeout", vars).unwrap_or(15.0);
            let deadline = Instant::now() + Duration::from_secs_f64(secs.clamp(0.0, 3600.0));
            loop {
                if exists(profile, &sel).await? {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(anyhow!("{sel} never showed up"));
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        "ifExists" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            if !exists(profile, &sel).await? {
                run.log(format!(
                    "{sel} is not there — skipping the rest of this pass"
                ));
                return Ok(Flow::EndPass);
            }
        }
        "if.exists" => {
            // Branching check: element there → "when it works"; missing → the
            // else branch ("when it fails").
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let there = exists(profile, &sel).await?;
            run.log(format!(
                "if {sel} exists → {}",
                if there { "yes" } else { "no (else)" }
            ));
            return Ok(if there { Flow::Next } else { Flow::Else });
        }
        "if.text" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let op = param(p, "op")
                .map(|s| expand(s, vars))
                .unwrap_or_else(|| "contains".into());
            let want = expand(param(p, "text").unwrap_or(""), vars);
            let txt = if exists(profile, &sel).await? {
                element_text(profile, &sel).await?
            } else {
                String::new()
            };
            let holds = cond_holds(&txt, &op, &want);
            run.log(format!(
                "if {sel} text {op} {want:?} → {}",
                if holds { "yes" } else { "no (else)" }
            ));
            return Ok(if holds { Flow::Next } else { Flow::Else });
        }
        "if.url" => {
            let op = param(p, "op")
                .map(|s| expand(s, vars))
                .unwrap_or_else(|| "contains".into());
            let want = expand(param(p, "text").unwrap_or(""), vars);
            let url = current_url(profile).await?;
            let holds = cond_holds(&url, &op, &want);
            run.log(format!(
                "if address {op} {want:?} → {}",
                if holds { "yes" } else { "no (else)" }
            ));
            return Ok(if holds { Flow::Next } else { Flow::Else });
        }
        "stop" => return Ok(Flow::EndPass),
        "log" => run.log(expand(param(p, "text").unwrap_or(""), vars)),
        "waitGone" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let deadline =
                Instant::now() + Duration::from_secs_f64(wait_for(p, vars).clamp(0.1, 3600.0));
            loop {
                if !exists(profile, &sel).await? {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(anyhow!("{sel} is still there"));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        "waitText" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let want = expand(param(p, "text").context("no text to wait for")?, vars);
            let deadline =
                Instant::now() + Duration::from_secs_f64(wait_for(p, vars).clamp(0.1, 3600.0));
            loop {
                if exists(profile, &sel).await? {
                    let text = element_text(profile, &sel).await?;
                    if text.to_lowercase().contains(&want.to_lowercase()) {
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    return Err(anyhow!("{sel} never said \"{want}\""));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        "waitUrl" => {
            let want = expand(param(p, "url").context("no address to wait for")?, vars);
            let deadline =
                Instant::now() + Duration::from_secs_f64(wait_for(p, vars).clamp(0.1, 3600.0));
            loop {
                if current_url(profile).await?.contains(&want) {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(anyhow!("the address never became \"{want}\""));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        "count" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let into = check_var_name(param(p, "into").context("no name to save into")?)?;
            let n = cdp::query_piercing(profile, &sel).await?.len();
            run.log(format!("{into} = {n}"));
            vars.insert(into, n.to_string());
        }
        "readAttribute" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            let name = expand(param(p, "name").context("no attribute")?, vars);
            let into = check_var_name(param(p, "into").context("no name to save into")?)?;
            center_waiting(profile, &sel, wait_for(p, vars)).await?;
            let node = *cdp::query_piercing(profile, &sel)
                .await?
                .first()
                .ok_or_else(|| anyhow!("no element matches {sel}"))?;
            let got =
                cdp::page_call(profile, "DOM.getAttributes", json!({ "nodeId": node })).await?;
            // Attributes arrive as one flat list: name, value, name, value.
            let flat: Vec<String> = got
                .get("attributes")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let value = flat
                .chunks(2)
                .find(|c| {
                    c.first()
                        .map(|n| n.eq_ignore_ascii_case(&name))
                        .unwrap_or(false)
                })
                .and_then(|c| c.get(1).cloned())
                .ok_or_else(|| anyhow!("{sel} has no attribute \"{name}\""))?;
            vars.insert(into, value);
        }
        "screenshot" => {
            let shot = cdp::page_call(profile, "Page.captureScreenshot", json!({})).await?;
            let b64 = shot
                .get("data")
                .and_then(|v| v.as_str())
                .context("the browser returned no picture")?;
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| anyhow!("unreadable picture: {e}"))?;
            let path = match param(p, "path")
                .map(|s| expand(s, vars))
                .filter(|s| !s.trim().is_empty())
            {
                Some(p) => std::path::PathBuf::from(p),
                // Beside the run logs, so evidence and log sit together.
                None => run
                    .host
                    .data_root()
                    .to_path_buf()
                    .join("automation-runs")
                    .join(&run.host.scope().connection_id)
                    .join(&run.host.scope().run_id)
                    .join(format!("{}-{}-{}.png", profile, ctx.worker, ctx.sequence)),
            };
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
            run.log(format!("picture saved to {}", path.display()));
        }
        "readText" => {
            let sel = expand(param(p, "selector").context("no element")?, vars);
            // An empty selector used to resolve to the document itself, which
            // read the whole page under the name of one element.
            if sel.trim().is_empty() {
                return Err(anyhow!("no element to read"));
            }
            // Same wait as a click: the text is usually the thing that arrives
            // last.
            center_waiting(profile, &sel, wait_for(p, vars)).await?;
            let node = *cdp::query_piercing(profile, &sel)
                .await?
                .first()
                .ok_or_else(|| anyhow!("no element matches {sel}"))?;
            // The whole subtree, shadow roots included. The old version took
            // the first direct text child and nothing else, so <div>Hello
            // <b>World</b></div> came back as "Hello" and <div><span>Hello
            // </span></div> came back empty.
            let described = cdp::page_call(
                profile,
                "DOM.describeNode",
                json!({ "nodeId": node, "depth": -1, "pierce": true }),
            )
            .await?;
            let mut text = String::new();
            if let Some(node) = described.get("node") {
                gather_text(node, &mut text);
            }
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            // Required, not optional: without a name the step reads the page
            // and throws the answer away, which looks exactly like a step that
            // did not run.
            let into = param(p, "into")
                .filter(|s| !s.trim().is_empty())
                .context("no name to save the text into")?;
            vars.insert(check_var_name(into)?, text);
        }
        // A block a module contributed. The module never touches the page: it
        // is given the step's parameters and the run's variables, and answers
        // with primitive actions the runner then performs itself. So a
        // third-party module lives inside the same guarantee as everything
        // else — its clicks are still Motion clicks.
        other if other.starts_with("module:") => {
            let rest = other.trim_start_matches("module:");
            let (module_id, block_name) = rest.split_once(':').unwrap_or((rest, ""));
            return Box::pin(drive_module(
                bound, vars, run, ctx, module_id, block_name, p,
            ))
            .await;
        }
        other => return Err(anyhow!("unknown automation step {other}")),
    }
    Ok(Flow::Next)
}

/// Runs one block a module contributed, start to finish.
///
/// Extracted from `run_block`'s `module:` arm so it can be entered from inside
/// itself: a module asking for `module:other:block` lands here again, one frame
/// deeper. That is sound because the outer module is parked in `rrx.recv()`
/// while this runs — it physically cannot ask for a second action — so the
/// borrows the nested frame needs are free.
///
/// This wrapper owns the frame. `leave` has to happen on every path out,
/// including the several that are a bare `?`, so the inner function's result is
/// held rather than returned straight through.
async fn drive_module(
    bound: &mut Bound,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
    module_id: &str,
    block_name: &str,
    params: &Value,
) -> Result<Flow> {
    // A module id reaches this from inside another module's request, so it is
    // not trusted text: it becomes a path. Same rule install() applies.
    if module_id.is_empty()
        || !module_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(anyhow!(
            "\"{module_id}\" is not a module name — letters, digits, - and _ only"
        ));
    }
    ctx.may_call(&Frame::Module(module_id.to_string()))?;
    let saved = ctx.enter(Frame::Module(module_id.to_string()))?;
    let result = Box::pin(drive_module_inner(
        bound,
        vars,
        run,
        ctx,
        &module_id.to_string(),
        block_name,
        params,
    ))
    .await;
    ctx.leave(saved);
    result
}

async fn drive_module_inner(
    bound: &mut Bound,
    vars: &mut HashMap<String, String>,
    run: &Run,
    ctx: &mut CallCtx,
    module_id: &str,
    block_name: &str,
    params: &Value,
) -> Result<Flow> {
    let input = json!({
        "block": block_name,
        "params": params,
        "vars": vars,
    });
    let module_id = module_id.to_string();
    let frozen_root = run.modules.root.clone();
    let out = if wasm::with_snapshot(Some(&frozen_root), || wasm::is_v2(&module_id)) {
        // A v2 module DRIVES: it runs on a blocking thread and asks for
        // one action at a time, and this loop performs each with the
        // runner's own state and answers. That is the whole difference
        // from v1 — the module can see what its action did and decide
        // what to do next, instead of handing over a finished plan.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        // The operator's Stop, so a module in a long loop actually
        // leaves; `abort` is this call's own, for its action budget.
        let stop = run.stop.clone();
        let abort = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let snapshot = vars.clone();
        let id = module_id.clone();
        let flag = stop.clone();
        let abort_flag = abort.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            wasm::with_snapshot(Some(&frozen_root), || {
                wasm::run_step(&id, &input, snapshot, tx, flag, abort_flag)
            })
        });
        let done = loop {
            tokio::select! {
                Some(req) = rx.recv() => {
                    ctx.mark_from_module(req.vars.keys().cloned().collect::<Vec<_>>());
                    for (k, v) in req.vars {
                        vars.insert(k, v);
                    }
                    let mut reply = wasm::ActionReply {
                        vars: vars.clone(),
                        ..Default::default()
                    };
                    // Charged to the whole CHAIN, not to this frame: a module
                    // that calls a module would otherwise multiply its budget
                    // by nesting.
                    if let Err(e) = ctx.charge() {
                        reply.error = e.to_string();
                        abort.store(true, std::sync::atomic::Ordering::Relaxed);
                    } else {
                        let kind = req.action.get("kind").and_then(|k| k.as_str())
                            .unwrap_or("").to_string();
                        if kind.is_empty() {
                            reply.error = "an action without a kind".into();
                        } else {
                            let inner = automation::Block {
                                id: String::new(),
                                kind,
                                label: String::new(),
                                params: req.action,
                                enabled: true,
                                secrets: Vec::new(),
                                x: 0.0,
                                y: 0.0,
                                on_done: automation::Branch::Next,
                                on_fail: automation::Branch::Stop,
                            };
                            match Box::pin(run_block(bound, &inner, vars, run, ctx)).await {
                                Ok(Flow::Cancelled) => {
                                    abort.store(true, Ordering::Relaxed);
                                    reply.error = "run stopped".into();
                                }
                                Ok(Flow::Else) => {
                                    reply.ok = true;
                                    reply.flow = "else".into();
                                }
                                Ok(_) => {
                                    reply.ok = true;
                                    reply.flow = "next".into();
                                }
                                Err(e) if host::is_unknown(&e) => {
                                    abort.store(true, Ordering::Relaxed);
                                    return Err(e);
                                }
                                Err(e) => reply.error = e.to_string(),
                            }
                        }
                        reply.vars = vars.clone();
                    }
                    // A module that stopped waiting is not an error:
                    // it may simply have given up on the answer.
                    let _ = req.reply.send(reply);
                }
                finished = &mut task => break finished,
            }
        };
        done.map_err(|e| anyhow!("module panicked: {e}"))??
    } else {
        tokio::task::spawn_blocking(move || {
            wasm::with_snapshot(Some(&frozen_root), || wasm::run_block(&module_id, &input))
        })
        .await
        .map_err(|e| anyhow!("module panicked: {e}"))??
    };

    // The module's own lines, from its own call. They used to come
    // from a process-global sink, which mixed them between workers.
    for line in out.logs {
        run.log(line);
    }
    if !out.error.is_empty() {
        return Err(anyhow!(out.error));
    }
    ctx.mark_from_module(out.vars.keys().cloned().collect::<Vec<_>>());
    for (k, v) in out.vars {
        vars.insert(k, v);
    }
    // Bounded: a module that returned a thousand clicks is a bug, and
    // running them would be indistinguishable from an attack.
    if out.actions.len() > 200 {
        return Err(anyhow!(
            "the module asked for {} actions",
            out.actions.len()
        ));
    }
    for action in out.actions {
        let kind = action
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .to_string();
        if kind.starts_with("module:") {
            return Err(anyhow!("a module may not call another module"));
        }
        let inner = automation::Block {
            id: String::new(),
            kind,
            label: String::new(),
            params: action,
            enabled: true,
            secrets: Vec::new(),
            x: 0.0,
            y: 0.0,
            on_done: automation::Branch::Next,
            on_fail: automation::Branch::Stop,
        };
        Box::pin(run_block(bound, &inner, vars, run, ctx)).await?;
    }

    Ok(Flow::Next)
}

async fn run_worker(
    run: Arc<Run>,
    idx: usize,
    seed_profile: Option<String>,
    project: automation::Project,
    deadline: Option<Instant>,
) {
    let mut steps: Vec<automation::Block> = project
        .blocks
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();
    // The run follows the visual stack top-to-bottom (by column, then height),
    // not the order the blocks happen to sit in the list. A card dragged above
    // another therefore runs before it, which is what the canvas shows.
    // "next" means the card below; explicit gotos still jump anywhere.
    steps.sort_by(|a, b| {
        let ca = (a.x / 40.0).round() as i64;
        let cb = (b.x / 40.0).round() as i64;
        ca.cmp(&cb)
            .then(a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal))
    });

    run.worker(idx, |w| {
        w.status = "running".into();
        w.steps_total = steps.len() as u32;
    });

    // A profile the graph makes, or one the operator named. Either way it is
    // the worker's, and a temporary one is cleaned up when the worker is done.
    let seed_id = seed_profile.unwrap_or_default();
    let mut bound = Bound {
        mobile: if seed_id.is_empty() {
            false
        } else {
            run.host
                .read_profile(&seed_id)
                .await
                .map(|p| p.mobile)
                .unwrap_or(false)
        },
        id: seed_id,
        temporary: false,
    };
    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("thread".into(), (idx + 1).to_string());
    let mut ctx = CallCtx::new();
    ctx.worker = idx;
    ctx.module_root = Some(run.modules.root.clone());

    let endless = project.run.loops == 0;
    let mut pass: u32 = 0;

    // Where the graph begins. An explicit start block, or the first one.
    let entry = steps
        .iter()
        .position(|b| b.id == project.run.start)
        .unwrap_or(0);

    loop {
        if run.stop.load(Ordering::Relaxed) {
            run.worker(idx, |w| w.status = "stopped".into());
            break;
        }
        if !endless && pass >= project.run.loops {
            run.worker(idx, |w| w.status = "done".into());
            break;
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                run.worker(idx, |w| w.status = "done".into());
                break;
            }
        }
        pass += 1;
        ctx.pass = pass;
        vars.insert("pass".into(), pass.to_string());
        run.worker(idx, |w| {
            w.pass = pass;
            w.step = 0;
        });

        // Branch-driven, not a for-loop over the list: each step says where to
        // go next, and "where" can be backwards or across the canvas.
        let mut at: usize = entry;
        let mut retries: HashMap<usize, u32> = HashMap::new();
        let mut hops: u32 = 0;
        let mut end_run = false;

        while at < steps.len() {
            if run.stop.load(Ordering::Relaxed) {
                break;
            }
            // A graph that loops through itself forever is a mistake, not a
            // feature; this bounds one pass without bounding a real loop.
            hops += 1;
            if hops > 100_000 {
                run.log("too many jumps in one pass — stopping");
                end_run = true;
                break;
            }

            let block = &steps[at];
            run.worker(idx, |w| {
                w.step = at as u32 + 1;
                w.note = block.label.clone();
            });

            let outcome = run_block(&mut bound, block, &mut vars, &run, &mut ctx).await;
            if outcome
                .as_ref()
                .err()
                .map(host::is_unknown)
                .unwrap_or(false)
            {
                run.worker(idx, |worker| worker.status = "reconciling".into());
                let _ = run.persist().await;
                return;
            }
            let branch = match &outcome {
                Ok(Flow::Next) => block.on_done.clone(),
                Ok(Flow::Cancelled) => {
                    run.worker(idx, |worker| worker.status = "stopped".into());
                    end_run = true;
                    break;
                }
                Ok(Flow::EndPass) => automation::Branch::EndPass,
                // A false condition is not a failure — it just takes the "when
                // it fails" branch (the else path).
                Ok(Flow::Else) => block.on_fail.clone(),
                Err(_e) => {
                    run.log(format!("step {} failed; inspect durable intent", at + 1));
                    block.on_fail.clone()
                }
            };

            match branch {
                automation::Branch::Next => {
                    retries.remove(&at);
                    at += 1;
                }
                automation::Branch::Stop => {
                    if outcome.is_err() {
                        run.worker(idx, |w| {
                            w.status = "failed".into();
                            w.note = format!("step {}", at + 1);
                        });
                        end_run = true;
                        break;
                    }
                    at = steps.len();
                }
                automation::Branch::EndPass => break,
                automation::Branch::Goto(target) => {
                    retries.remove(&at);
                    match steps.iter().position(|b| b.id == target) {
                        Some(next) => at = next,
                        // The block it pointed at is gone; carrying on is safer
                        // than stopping a long run over a stale connection.
                        None => at += 1,
                    }
                }
                automation::Branch::Retry(times) => {
                    let used = retries.entry(at).or_insert(0);
                    if *used < times {
                        *used += 1;
                        run.log(format!("retry {} of {} on step {}", *used, times, at + 1));
                        tokio::time::sleep(Duration::from_millis(600)).await;
                    } else {
                        retries.remove(&at);
                        at += 1;
                    }
                }
            }
        }

        if end_run {
            break;
        }
    }

    // Cleanup also uses durable step keys. Unknown cleanup pauses this worker.
    let terminal_status = run
        .state
        .lock()
        .ok()
        .and_then(|state| state.workers.get(idx).map(|worker| worker.status.clone()));
    let cleanup = automation::Block {
        id: "__cleanup".into(),
        kind: "engine.cleanup".into(),
        label: String::new(),
        params: json!({}),
        enabled: true,
        x: 0.0,
        y: 0.0,
        secrets: Vec::new(),
        on_done: automation::Branch::Next,
        on_fail: automation::Branch::Stop,
    };
    let cleanup_result = run_block(&mut bound, &cleanup, &mut vars, &run, &mut ctx).await;
    if cleanup_result.is_ok() {
        if let Some(status) = terminal_status {
            run.worker(idx, |worker| worker.status = status);
        }
    }
    if let Err(_error) = cleanup_result {
        run.log("cleanup needs attention; inspect durable intent");
        run.worker(idx, |worker| {
            worker.status = "interrupted".into();
        });
    }
    let _ = run.persist().await;
}

/// The caller supplies a connection-validated immutable snapshot. Repeated run
/// identity returns the original run. begin_run is the durable idempotency gate.
pub async fn start(
    host: Arc<dyn EngineHost>,
    project: automation::Project,
    projects: Vec<automation::Project>,
) -> Result<RunState> {
    static ADMISSION: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _admission = ADMISSION
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let scope = host.scope().clone();
    if scope.connection_id.is_empty() || scope.run_id.is_empty() || scope.project_id != project.id {
        return Err(anyhow!("invalid engine scope or project identity"));
    }
    if let Some(state) = status(&scope.connection_id, &scope.run_id) {
        return Ok(state);
    }
    if project.blocks.iter().all(|block| !block.enabled) {
        return Err(anyhow!("the project has no steps to run"));
    }
    if !project.run.hours.is_finite() || project.run.hours < 0.0 {
        return Err(anyhow!("run hours must be finite and non-negative"));
    }
    if all(&scope.connection_id)
        .iter()
        .any(|state| state.project_id == project.id && state.running)
    {
        return Err(anyhow!(
            "that project is already running in this connection"
        ));
    }
    let modules = wasm::freeze(&scope.resource_key("modules"))?;
    if !projects.iter().any(|candidate| {
        candidate.id == project.id
            && serde_json::to_value(candidate).ok() == serde_json::to_value(&project).ok()
    }) {
        return Err(anyhow!(
            "project differs from the submitted immutable project snapshot"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if projects.iter().any(|candidate| !seen.insert(&candidate.id)) {
        return Err(anyhow!("duplicate project identities in snapshot"));
    }
    host.begin_run(&project, &projects, &modules.identities)
        .await?;
    let threads = project.run.threads.clamp(1, 64) as usize;
    let run = Arc::new(Run {
        state: Mutex::new(RunState {
            connection_id: scope.connection_id.clone(),
            run_id: scope.run_id.clone(),
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            started_at: now(),
            running: true,
            workers: (0..threads)
                .map(|index| WorkerState {
                    pending_intent: None,
                    variables: HashMap::new(),
                    temporary_profiles: Vec::new(),
                    profile_id: String::new(),
                    profile_name: format!("thread {}", index + 1),
                    pass: 0,
                    step: 0,
                    steps_total: 0,
                    status: "queued".into(),
                    note: String::new(),
                })
                .collect(),
            log: Vec::new(),
        }),
        stop: Arc::new(AtomicBool::new(false)),
        rules: project.rules.clone(),
        projects,
        host,
        modules,
        persistence_failed: AtomicBool::new(false),
        persist_gate: tokio::sync::Mutex::new(()),
        redactions: Mutex::new(std::collections::HashSet::new()),
    });
    run.log(format!("started project {}", project.id));
    run.persist().await?;
    {
        let mut registry = runs().lock().map_err(|_| anyhow!("runs lock poisoned"))?;
        if let Some(existing) = registry.get(&run_key(&scope.connection_id, &scope.run_id)) {
            return Ok(existing
                .state
                .lock()
                .map_err(|_| anyhow!("state lock poisoned"))?
                .clone());
        }
        if registry.values().any(|existing| {
            existing
                .state
                .lock()
                .map(|state| {
                    state.connection_id == scope.connection_id
                        && state.project_id == project.id
                        && state.running
                })
                .unwrap_or(true)
        }) {
            return Err(anyhow!(
                "that project is already running in this connection"
            ));
        }
        registry.insert(run_key(&scope.connection_id, &scope.run_id), run.clone());
    }
    let initial = run
        .state
        .lock()
        .map_err(|_| anyhow!("state lock poisoned"))?
        .clone();
    let deadline = if project.run.loops == 0 && project.run.hours > 0.0 {
        Instant::now().checked_add(
            Duration::try_from_secs_f64(project.run.hours * 3600.0)
                .map_err(|_| anyhow!("run duration is too large"))?,
        )
    } else {
        None
    };
    tokio::spawn(async move {
        let mut handles = Vec::new();
        for idx in 0..threads {
            let run = run.clone();
            let project = project.clone();
            let scope = scope.clone();
            handles.push(tokio::spawn(cdp::with_scope(scope, idx, async move {
                run_worker(run, idx, None, project, deadline).await;
            })));
        }
        for handle in handles {
            if let Err(error) = handle.await {
                run.log(format!("worker task interrupted: {error}"));
                if let Ok(mut state) = run.state.lock() {
                    for worker in &mut state.workers {
                        if !matches!(worker.status.as_str(), "done" | "stopped" | "failed") {
                            worker.status = "interrupted".into();
                        }
                    }
                }
            }
        }
        if let Ok(mut state) = run.state.lock() {
            state.running = false;
        }
        super::requests::drop_scope(&run.host.scope().resource_key("requests"));
        let database_scope = run.host.scope().resource_key("db");
        if tokio::task::spawn_blocking(move || super::db::drop_scope(&database_scope))
            .await
            .is_err()
        {
            run.log("database cleanup task interrupted");
        }
        run.log("finished");
        if let Err(error) = run.persist().await {
            run.log(format!("final state needs persistence: {error}"));
        } else if let Err(error) = retire_terminal(&run) {
            run.log(format!("terminal registry retirement failed: {error}"));
        }
    });
    Ok(initial)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(kind: &str, params: serde_json::Value) -> automation::Block {
        automation::Block {
            id: format!("{kind}-1"),
            kind: kind.into(),
            label: String::new(),
            params,
            enabled: true,
            secrets: Vec::new(),
            x: 0.0,
            y: 0.0,
            on_done: automation::Branch::Next,
            on_fail: automation::Branch::Stop,
        }
    }

    fn project(id: &str, name: &str, blocks: Vec<automation::Block>) -> automation::Project {
        automation::Project {
            id: id.into(),
            name: name.into(),
            notes: String::new(),
            blocks,
            run: automation::RunSettings::default(),
            rules: Vec::new(),
            created_at: 0,
            updated_at: 0,
            revision: None,
        }
    }

    fn a_run(projects: Vec<automation::Project>) -> Run {
        Run {
            state: Mutex::new(RunState {
                connection_id: "connection-a".into(),
                run_id: "run-a".into(),
                project_id: "caller".into(),
                project_name: "caller".into(),
                started_at: 0,
                running: true,
                workers: vec![WorkerState {
                    pending_intent: None,
                    variables: HashMap::new(),
                    temporary_profiles: Vec::new(),
                    profile_id: String::new(),
                    profile_name: "worker".into(),
                    pass: 0,
                    step: 0,
                    steps_total: 0,
                    status: "running".into(),
                    note: String::new(),
                }],
                log: Vec::new(),
            }),
            stop: Arc::new(AtomicBool::new(false)),
            rules: Vec::new(),
            projects,
            host: Arc::new(super::super::test_host::TestHost::new()),
            modules: wasm::FrozenModules {
                root: super::super::test_host::module_root(),
                identities: json!({}),
            },
            persistence_failed: AtomicBool::new(false),
            persist_gate: tokio::sync::Mutex::new(()),
            redactions: Mutex::new(std::collections::HashSet::new()),
        }
    }

    #[test]
    fn a_chain_is_bounded_and_a_loop_is_named() {
        let mut ctx = CallCtx::new();
        let mut saved = Vec::new();
        for i in 0..MAX_CALL_DEPTH {
            saved.push(
                ctx.enter(Frame::Module(format!("m{i}")))
                    .expect("within depth"),
            );
        }
        let too_deep = ctx
            .enter(Frame::Module("m9".into()))
            .unwrap_err()
            .to_string();
        assert!(too_deep.contains("deep"), "{too_deep}");

        // A repeat is reported as the loop it is, not as depth.
        let mut ctx = CallCtx::new();
        let _ = ctx.enter(Frame::Module("a".into())).unwrap();
        let _ = ctx.enter(Frame::Flow("f".into())).unwrap();
        let loop_err = ctx
            .enter(Frame::Module("a".into()))
            .unwrap_err()
            .to_string();
        assert!(loop_err.contains("circle"), "{loop_err}");
        assert!(loop_err.contains("\"a\""), "{loop_err}");
    }

    #[test]
    fn leaving_a_frame_puts_the_stack_back() {
        let mut ctx = CallCtx::new();
        let outer = ctx.enter(Frame::Module("a".into())).unwrap();
        {
            let inner = ctx.enter(Frame::Module("b".into())).unwrap();
            assert_eq!(ctx.depth, 2);
            ctx.leave(inner);
        }
        assert_eq!(ctx.depth, 1);
        // b is gone, so calling it again is not a loop.
        let again = ctx.enter(Frame::Module("b".into())).unwrap();
        ctx.leave(again);
        ctx.leave(outer);
        assert_eq!(ctx.depth, 0);
        assert!(ctx.stack.is_empty());
    }

    #[test]
    fn the_action_budget_is_per_chain_and_resets_with_it() {
        let mut ctx = CallCtx::new();
        let first = ctx.enter(Frame::Module("a".into())).unwrap();
        for _ in 0..MAX_CHAIN_ACTIONS {
            ctx.charge().expect("within budget");
        }
        assert!(ctx.charge().is_err(), "the chain must run out");
        ctx.leave(first);
        // The next placed block is a new chain and gets its own budget, exactly
        // as a module block does today.
        let second = ctx.enter(Frame::Module("a".into())).unwrap();
        assert!(ctx.charge().is_ok());
        ctx.leave(second);
    }

    #[test]
    fn a_flow_resolves_by_id_then_by_a_unique_name() {
        let run = a_run(vec![
            project("id-1", "Warm up", Vec::new()),
            project("id-2", "Twin", Vec::new()),
            project("id-3", "Twin", Vec::new()),
        ]);
        assert_eq!(resolve_flow(&run, "id-1", "").unwrap().id, "id-1");
        // An id that travelled falls back to the name.
        assert_eq!(resolve_flow(&run, "gone", "Warm up").unwrap().id, "id-1");
        // Two of a name is refused rather than guessed.
        let ambiguous = resolve_flow(&run, "", "Twin").unwrap_err().to_string();
        assert!(ambiguous.contains("more than one"), "{ambiguous}");
        assert!(resolve_flow(&run, "", "Nothing").is_err());
    }

    /// The whole sub-flow path, with blocks that touch no page: a called flow
    /// runs, sets a variable, and hands back only what the caller asked for.
    #[tokio::test]
    async fn a_flow_runs_and_returns_what_was_asked_for() {
        super::super::test_host::initialize_modules();
        let callee = project(
            "flow-1",
            "Sets a token",
            vec![
                block("flow.entry", json!({ "name": "start" })),
                block(
                    "var.set",
                    json!({ "name": "token", "value": "abc-{{seed}}" }),
                ),
                block(
                    "var.set",
                    json!({ "name": "private", "value": "not yours" }),
                ),
            ],
        );
        // Lay them out down one column, the order a project runs in.
        let mut callee = callee;
        for (i, b) in callee.blocks.iter_mut().enumerate() {
            b.y = i as f64 * 60.0;
        }
        let run = a_run(vec![callee]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("outer".into(), "kept".into());

        let call = block(
            "flow.call",
            json!({ "project": "flow-1", "in": "seed=42", "out": "token" }),
        );
        let flow = run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .expect("the flow runs");
        assert!(matches!(flow, Flow::Next));
        assert_eq!(vars.get("token").map(String::as_str), Some("abc-42"));
        // Named in "in"/"out" means isolated: the caller keeps its own map and
        // the flow's other variables do not leak into it.
        assert_eq!(vars.get("outer").map(String::as_str), Some("kept"));
        assert!(vars.get("private").is_none());
        assert!(vars.get("seed").is_none());
        // The frame was left.
        assert_eq!(ctx.depth, 0);
    }

    #[tokio::test]
    async fn a_flow_that_never_sets_an_asked_for_variable_is_an_error() {
        super::super::test_host::initialize_modules();
        // var.set, not log: log sits below the runner's browser check, so a
        // flow made of it would fail for the wrong reason.
        let mut callee = project(
            "flow-2",
            "Sets nothing",
            vec![block(
                "var.set",
                json!({ "name": "other", "value": "hello" }),
            )],
        );
        callee.blocks[0].y = 0.0;
        let run = a_run(vec![callee]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let call = block("flow.call", json!({ "project": "flow-2", "out": "token" }));
        let err = run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("without setting"), "{err}");
        assert_eq!(
            ctx.depth, 0,
            "the frame must be left even on the error path"
        );
    }

    #[tokio::test]
    async fn a_flow_calling_itself_is_refused_as_a_loop() {
        super::super::test_host::initialize_modules();
        let mut callee = project(
            "flow-3",
            "Recursive",
            vec![block("flow.call", json!({ "project": "flow-3" }))],
        );
        callee.blocks[0].y = 0.0;
        // Its own failure edge is Stop, so the loop refusal comes back out.
        let run = a_run(vec![callee]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let call = block("flow.call", json!({ "project": "flow-3" }));
        let err = run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("circle"), "{err}");
        assert_eq!(ctx.depth, 0);
    }

    #[tokio::test]
    async fn an_entry_that_is_gone_is_an_error_not_a_run_from_the_top() {
        super::super::test_host::initialize_modules();
        let mut callee = project(
            "flow-4",
            "Has one entry",
            vec![
                block("var.set", json!({ "name": "ran", "value": "yes" })),
                block("flow.entry", json!({ "name": "later" })),
            ],
        );
        callee.blocks[0].y = 0.0;
        callee.blocks[1].y = 60.0;
        let run = a_run(vec![callee]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let call = block(
            "flow.call",
            json!({ "project": "flow-4", "entry": "missing" }),
        );
        let err = run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("no entry called"), "{err}");
        assert!(vars.get("ran").is_none(), "nothing may have run");
    }

    #[tokio::test]
    async fn a_named_entry_starts_below_it() {
        super::super::test_host::initialize_modules();
        let mut callee = project(
            "flow-5",
            "Two halves",
            vec![
                block("var.set", json!({ "name": "first", "value": "ran" })),
                block("flow.entry", json!({ "name": "second" })),
                block("var.set", json!({ "name": "second_ran", "value": "yes" })),
            ],
        );
        for (i, b) in callee.blocks.iter_mut().enumerate() {
            b.y = i as f64 * 60.0;
        }
        let run = a_run(vec![callee]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let call = block(
            "flow.call",
            json!({ "project": "flow-5", "entry": "second" }),
        );
        run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap();
        assert_eq!(vars.get("second_ran").map(String::as_str), Some("yes"));
        assert!(
            vars.get("first").is_none(),
            "the half above the entry must not run"
        );
    }

    /// The guard fires through the real path, not only in its own tests: a
    /// module frame anywhere in the chain is enough.
    #[tokio::test]
    async fn a_module_cannot_navigate_off_the_web() {
        super::super::test_host::initialize_modules();
        let run = a_run(Vec::new());
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let go = block("goto", json!({ "url": "file:///etc/passwd" }));

        // The operator placed it themselves: their block, their call.
        let their_own = run_block(&mut bound, &go, &mut vars, &run, &mut ctx).await;
        assert!(
            their_own
                .unwrap_err()
                .to_string()
                .contains("needs a profile"),
            "an operator's goto must get as far as the browser check"
        );

        // The same block, asked for by a module.
        let frame = ctx.enter(Frame::Module("scraper".into())).unwrap();
        let refused = run_block(&mut bound, &go, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        ctx.leave(frame);
        assert!(refused.contains("http and https"), "{refused}");
    }

    /// A module may not call a flow it was not granted, and nothing about the
    /// call's own parameters changes that.
    #[tokio::test]
    async fn an_ungranted_flow_is_refused() {
        super::super::test_host::initialize_modules();
        let run = a_run(vec![project("flow-7", "Someone else's", Vec::new())]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let frame = ctx.enter(Frame::Module("scraper".into())).unwrap();
        let call = block("flow.call", json!({ "project": "flow-7" }));
        let refused = run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        ctx.leave(frame);
        assert!(refused.contains("permission"), "{refused}");
        assert!(refused.contains("scraper"), "{refused}");
    }

    /// And once inside a flow the module WAS granted, the guard still applies:
    /// the module chose the flow and what went into it, so a flow doing
    /// `goto {{url}}` is the module's reach with one step in between.
    #[tokio::test]
    async fn the_guard_reaches_through_a_flow() {
        super::super::test_host::initialize_modules();
        let run = a_run(Vec::new());
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        // The two frames a granted call would have pushed.
        let outer = ctx.enter(Frame::Module("scraper".into())).unwrap();
        let inner = ctx.enter(Frame::Flow("flow-7".into())).unwrap();
        let go = block("goto", json!({ "url": "file:///etc/passwd" }));
        let refused = run_block(&mut bound, &go, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        ctx.leave(inner);
        ctx.leave(outer);
        assert!(refused.contains("http and https"), "{refused}");
    }

    /// The laundering path: a module writes a variable and waits for a block
    /// the OPERATOR wrote to run it.
    #[tokio::test]
    async fn a_modules_text_cannot_become_code_through_a_variable() {
        super::super::test_host::initialize_modules();
        let run = a_run(Vec::new());
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();

        // The operator's own variable is fine, whatever is in it.
        vars.insert("payload".into(), "fetch('/x')".into());
        let sink = block("script.run", json!({ "source": "{{payload}}" }));
        let theirs = run_block(&mut bound, &sink, &mut vars, &run, &mut ctx).await;
        assert!(
            theirs.unwrap_err().to_string().contains("needs a profile"),
            "the operator's own variable must get as far as the browser check"
        );

        // The same name, written by a module.
        let frame = ctx.enter(Frame::Module("formatter".into())).unwrap();
        ctx.mark_from_module(vec!["payload".to_string()]);
        ctx.leave(frame);
        let refused = run_block(&mut bound, &sink, &mut vars, &run, &mut ctx)
            .await
            .unwrap_err()
            .to_string();
        assert!(refused.contains("a module wrote that"), "{refused}");

        // A different variable in the same sink is untouched.
        vars.insert("clean".into(), "1".into());
        let other = block("script.run", json!({ "source": "{{clean}}" }));
        let ok_again = run_block(&mut bound, &other, &mut vars, &run, &mut ctx).await;
        assert!(
            ok_again
                .unwrap_err()
                .to_string()
                .contains("needs a profile")
        );

        // And a block that is not a sink does not care.
        let harmless = block("type", json!({ "text": "{{payload}}" }));
        let typed = run_block(&mut bound, &harmless, &mut vars, &run, &mut ctx).await;
        assert!(typed.unwrap_err().to_string().contains("needs a profile"));
    }

    #[tokio::test]
    async fn without_in_or_out_a_flow_shares_the_run_s_variables() {
        super::super::test_host::initialize_modules();
        let mut callee = project(
            "flow-6",
            "Shares",
            vec![block(
                "var.set",
                json!({ "name": "added", "value": "{{outer}}!" }),
            )],
        );
        callee.blocks[0].y = 0.0;
        let run = a_run(vec![callee]);
        let mut ctx = CallCtx::new();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        vars.insert("outer".into(), "hi".into());
        let call = block("flow.call", json!({ "project": "flow-6" }));
        run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap();
        assert_eq!(vars.get("added").map(String::as_str), Some("hi!"));
    }
    #[tokio::test]
    async fn terminal_registry_retirement_releases_host_and_keeps_durable_history() {
        let host = Arc::new(super::super::test_host::TestHost::new());
        let mut run = a_run(Vec::new());
        run.host = host.clone();
        let id = uuid::Uuid::new_v4().to_string();
        {
            let state = run.state.get_mut().unwrap();
            state.run_id = id.clone();
            state.running = false;
            state.workers[0].status = "done".into();
        }
        let run = Arc::new(run);
        let weak = Arc::downgrade(&run);
        runs()
            .lock()
            .unwrap()
            .insert(run_key("connection-a", &id), run.clone());
        run.persist().await.unwrap();
        assert!(retire_terminal(&run).unwrap());
        assert!(status("connection-a", &id).is_none());
        assert_eq!(
            host.persisted_states.lock().unwrap().last().unwrap().run_id,
            id
        );
        drop(run);
        assert!(weak.upgrade().is_none());
    }

    #[tokio::test]
    async fn unresolved_registry_requires_durable_explicit_recovery_before_retirement() {
        let host = Arc::new(super::super::test_host::TestHost::new());
        let mut run = a_run(Vec::new());
        run.host = host.clone();
        let id = uuid::Uuid::new_v4().to_string();
        {
            let state = run.state.get_mut().unwrap();
            state.run_id = id.clone();
            state.running = false;
            state.workers[0].status = "reconciling".into();
            state.workers[0].pending_intent = Some(StepIntent {
                id: "unresolved".into(),
                key: StepKey {
                    worker: 0,
                    pass: 1,
                    sequence: 1,
                    block_id: "create".into(),
                    kind: "profile.temp".into(),
                    call_stack: Vec::new(),
                },
            });
        }
        let run = Arc::new(run);
        runs()
            .lock()
            .unwrap()
            .insert(run_key("connection-a", &id), run.clone());
        run.persist().await.unwrap();
        assert!(!retire_terminal(&run).unwrap());
        let mut recovered = status("connection-a", &id).unwrap();
        assert!(retire_recovered(recovered.clone()).await.is_err());
        recovered.workers[0].status = "stopped".into();
        recovered.workers[0].pending_intent = None;
        host.persist_failures.store(1, Ordering::SeqCst);
        assert!(retire_recovered(recovered.clone()).await.is_err());
        assert!(
            status("connection-a", &id).unwrap().workers[0]
                .pending_intent
                .is_some()
        );
        assert!(retire_recovered(recovered).await.unwrap());
        assert!(status("connection-a", &id).is_none());
    }

    #[tokio::test]
    async fn persistence_gate_orders_capture_and_write_through_terminal_state() {
        let host = Arc::new(super::super::test_host::TestHost::new());
        host.block_first_persist.store(true, Ordering::SeqCst);
        let mut run = a_run(Vec::new());
        run.host = host.clone();
        let run = Arc::new(run);
        let first_run = run.clone();
        let first = tokio::spawn(async move { first_run.persist().await });
        tokio::time::timeout(Duration::from_secs(5), host.persist_entered.notified())
            .await
            .expect("first persistence reached host");

        run.worker(0, |worker| worker.step = 1);
        let mut second = Box::pin(run.persist());
        // Poll the competing persist while the first host write is blocked.
        // It must await the gate before either capturing or writing its state.
        let waiting = std::future::poll_fn(|context| {
            std::task::Poll::Ready(std::future::Future::poll(second.as_mut(), context).is_pending())
        })
        .await;
        assert!(waiting);
        assert!(host.persisted_states.lock().unwrap().is_empty());

        {
            let mut state = run.state.lock().unwrap();
            state.running = false;
            state.workers[0].status = "done".into();
            state.workers[0].step = 2;
        }
        host.persist_resume.notify_one();
        first.await.unwrap().unwrap();
        second.await.unwrap();

        let states = host.persisted_states.lock().unwrap();
        assert_eq!(states.len(), 2);
        assert!(states[0].running);
        assert_eq!(states[0].workers[0].step, 0);
        assert!(!states[1].running);
        assert_eq!(states[1].workers[0].status, "done");
        assert_eq!(states[1].workers[0].step, 2);
    }

    #[tokio::test]
    async fn unknown_create_reconciles_without_following_retry_or_creating_twice() {
        let mut host = super::super::test_host::TestHost::new();
        host.unknown_create = true;
        host.resolutions.lock().unwrap().extend([
            Reconciliation::Pending,
            Reconciliation::Committed(StepCompletion {
                flow: "next".into(),
                variables: HashMap::from([("created".into(), "profile-confirmed".into())]),
                profile_id: "profile-confirmed".into(),
                temporary: true,
                mobile: false,
                temporary_profiles: vec!["profile-confirmed".into()],
            }),
        ]);
        let host = Arc::new(host);
        let mut run = a_run(Vec::new());
        run.host = host.clone();
        let mut create = block("profile.temp", json!({ "into": "created" }));
        create.on_fail = automation::Branch::Retry(10);
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let mut ctx = CallCtx::new();
        let result = run_block(&mut bound, &create, &mut vars, &run, &mut ctx)
            .await
            .unwrap();
        assert!(matches!(result, Flow::Next));
        assert_eq!(host.creates.load(Ordering::SeqCst), 1);
        assert_eq!(host.reconciles.load(Ordering::SeqCst), 2);
        assert_eq!(host.failures.load(Ordering::SeqCst), 0);
        assert_eq!(bound.id, "profile-confirmed");
        assert_eq!(ctx.temps, vec!["profile-confirmed"]);
        assert_eq!(host.completed.lock().unwrap().as_slice(), &["0-1"]);
    }

    #[tokio::test]
    async fn nested_flow_waits_for_original_create_before_returning_variables() {
        let mut host = super::super::test_host::TestHost::new();
        host.unknown_create = true;
        host.resolutions
            .lock()
            .unwrap()
            .push_back(Reconciliation::Committed(StepCompletion {
                flow: "next".into(),
                variables: HashMap::from([("profile".into(), "profile-confirmed".into())]),
                profile_id: "profile-confirmed".into(),
                temporary: false,
                mobile: false,
                temporary_profiles: Vec::new(),
            }));
        let host = Arc::new(host);
        let callee = project(
            "nested",
            "Nested",
            vec![block("profile.create", json!({ "into": "profile" }))],
        );
        let mut run = a_run(vec![callee]);
        run.host = host.clone();
        let call = block(
            "flow.call",
            json!({ "project": "nested", "out": "profile" }),
        );
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let mut ctx = CallCtx::new();
        run_block(&mut bound, &call, &mut vars, &run, &mut ctx)
            .await
            .unwrap();
        assert_eq!(host.creates.load(Ordering::SeqCst), 1);
        assert_eq!(
            vars.get("profile").map(String::as_str),
            Some("profile-confirmed")
        );
        assert_eq!(ctx.depth, 0);
    }

    #[tokio::test]
    async fn persistence_failure_blocks_dispatch_until_snapshot_is_saved() {
        let host = Arc::new(super::super::test_host::TestHost::new());
        host.persist_failures.store(1, Ordering::SeqCst);
        let mut run = a_run(Vec::new());
        run.host = host.clone();
        let create = block("profile.temp", json!({}));
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let mut ctx = CallCtx::new();
        run_block(&mut bound, &create, &mut vars, &run, &mut ctx)
            .await
            .unwrap();
        assert_eq!(host.persist_failures.load(Ordering::SeqCst), 0);
        assert_eq!(host.creates.load(Ordering::SeqCst), 1);
        assert!(!run.persistence_failed.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn unknown_step_fails_before_browser_start() {
        let run = a_run(Vec::new());
        let mut bound = Bound {
            id: "would-start-browser".into(),
            ..Bound::default()
        };
        let mut vars = HashMap::new();
        let mut ctx = CallCtx::new();
        let error = run_block(
            &mut bound,
            &block("unrecognized.imported", json!({})),
            &mut vars,
            &run,
            &mut ctx,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("unknown automation step"));
        assert!(!host::is_unknown(&error));
    }

    #[tokio::test]
    async fn invalid_output_variable_is_rejected_before_profile_creation() {
        let host = Arc::new(super::super::test_host::TestHost::new());
        let mut run = a_run(Vec::new());
        run.host = host.clone();
        let mut bound = Bound::default();
        let mut vars = HashMap::new();
        let mut ctx = CallCtx::new();
        assert!(
            run_block(
                &mut bound,
                &block("profile.create", json!({ "into": "invalid-name" })),
                &mut vars,
                &run,
                &mut ctx
            )
            .await
            .is_err()
        );
        assert_eq!(host.creates.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn successful_nested_write_does_not_taint_confirmed_parent_failure() {
        let result: Result<()> = cdp::track_action(Arc::new(AtomicBool::new(false)), async {
            cdp::track_action(Arc::new(AtomicBool::new(false)), async {
                cdp::record_effect();
                Ok(())
            })
            .await?;
            Err(anyhow!("confirmed later failure"))
        })
        .await;
        assert!(!host::is_unknown(&result.unwrap_err()));
    }
}
