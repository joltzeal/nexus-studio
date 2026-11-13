use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::dto::*;
use super::service::{AgentService, HostGuard, browser_error, verify_publication_reply};
use super::store::Job;
use super::{AgentResult, canonical, denied, host_error, invalid, storage_error};
use crate::core::plugin_host::manifest::Capability;
use crate::core::plugin_host::process::{HostRequest, PluginCaller};

impl AgentService {
    pub(crate) fn handle_host(
        &self,
        caller: PluginCaller,
        request: HostRequest,
    ) -> AgentResult<Value> {
        let started = Instant::now();
        let guard = self.enter_gateway(&caller, &request.scope)?;
        let job = self
            .store
            .validate_lease(&request.scope, &caller.generation)?;
        let payload = &request.payload;
        let scope = &request.scope;
        let generation = &caller.generation;
        match request.method.as_str() {
            "agent.controls.get" => {
                fields(payload, &[])?;
                self.store.controls_get(&job.id)
            }
            "agent.model.acquire" => {
                let input: ModelAcquire = serde_json::from_value(payload.clone())
                    .map_err(|_| invalid("Invalid model permit request"))?;
                self.store.model_acquire(scope, generation, &input)
            }
            "agent.model.complete" => {
                let input: ModelComplete = serde_json::from_value(payload.clone())
                    .map_err(|_| invalid("Invalid model completion receipt"))?;
                self.store.model_complete(scope, generation, &input)
            }
            "agent.browser.execute" => self.browser_execute(
                &caller,
                &job,
                &guard,
                payload,
                started + Duration::from_millis(request.deadline_ms),
            ),
            "agent.artifact.read" => {
                fields(payload, &["artifactId", "offset", "length"])?;
                let id = string(payload, "artifactId")?;
                let offset = integer(payload, "offset")?;
                let length = integer(payload, "length")?;
                let (mime, size, digest) = self.store.artifact(scope, id)?;
                self.artifacts
                    .read(&scope.batch_id, id, (&mime, size, &digest), offset, length)
            }
            "agent.checkpoint.get"
            | "agent.checkpoint.list"
            | "agent.checkpoint.put"
            | "agent.checkpoint.putWrites"
            | "agent.checkpoint.delete" => {
                let allowed: &[&str] = match request.method.as_str() {
                    "agent.checkpoint.get" => &["threadId", "checkpointNs", "checkpointId"],
                    "agent.checkpoint.list" => &[
                        "threadId",
                        "checkpointNs",
                        "checkpointId",
                        "limit",
                        "before",
                        "filter",
                    ],
                    "agent.checkpoint.put" => &[
                        "threadId",
                        "checkpointNs",
                        "checkpointId",
                        "checkpoint",
                        "metadata",
                        "parentConfig",
                        "newVersions",
                    ],
                    "agent.checkpoint.putWrites" => &[
                        "threadId",
                        "checkpointNs",
                        "checkpointId",
                        "taskId",
                        "writes",
                        "taskPath",
                    ],
                    _ => &["threadId"],
                };
                fields(payload, allowed)?;
                if canonical(payload).len() > 512 * 1024 {
                    return Err(invalid("Checkpoint host payload exceeds its budget"));
                }
                self.store
                    .checkpoint(scope, generation, &request.method, payload)
            }
            "agent.action.prepare" => {
                fields(payload, &["operationId", "kind", "digest"])?;
                self.require_dispatching(&job)?;
                self.verify_binding(&job.snapshot)?;
                self.verify_account(&job.snapshot, false)?;
                self.recheck(&caller, scope)?;
                self.store.action_prepare(
                    scope,
                    generation,
                    string(payload, "operationId")?,
                    string(payload, "kind")?,
                    string(payload, "digest")?,
                )
            }
            "agent.action.get" => {
                fields(payload, &["operationId"])?;
                self.store
                    .action_get(scope, string(payload, "operationId")?)
            }
            "agent.action.unknown" => {
                fields(payload, &["operationId"])?;
                self.store
                    .action_unknown(scope, generation, string(payload, "operationId")?)
            }
            "agent.action.confirm" => {
                fields(payload, &["operationId", "result"])?;
                let operation = string(payload, "operationId")?;
                let result = payload
                    .get("result")
                    .ok_or_else(|| invalid("Action confirmation is missing its result"))?;
                let publication = validate_confirmation(&job, operation, result)?;
                self.verify_binding(&job.snapshot)?;
                self.verify_account(&job.snapshot, true)?;
                self.recheck(&caller, scope)?;
                self.store.action_confirm(
                    scope,
                    generation,
                    operation,
                    result,
                    publication.as_ref(),
                )
            }
            "agent.plugin.call" => self.plugin_route(&caller, &job, payload),
            _ => Err(denied("Host method is outside the Agent gateway allowlist")),
        }
    }

    fn enter_gateway(&self, caller: &PluginCaller, scope: &AgentScope) -> AgentResult<HostGuard> {
        validate_scope(scope)?;
        self.host()?
            .validate_agent_caller(caller)
            .map_err(host_error)?;
        let active = self.active.lock().map_err(storage_error)?;
        let actor = active
            .get(&scope.job_id)
            .ok_or_else(|| denied("No active actor owns this job scope"))?;
        if actor.scope != *scope
            || actor.caller != *caller
            || !actor.accepting.load(Ordering::Acquire)
            || actor.graph_done.load(Ordering::Acquire)
        {
            return Err(denied(
                "Host request has a stale actor, process generation, or fencing token",
            ));
        }
        actor.in_flight.fetch_add(1, Ordering::AcqRel);
        Ok(HostGuard(Arc::clone(actor)))
    }

    fn recheck(&self, caller: &PluginCaller, scope: &AgentScope) -> AgentResult<()> {
        self.host()?
            .validate_agent_caller(caller)
            .map_err(host_error)?;
        self.store.validate_lease(scope, &caller.generation)?;
        Ok(())
    }

    fn require_dispatching(&self, job: &Job) -> AgentResult<()> {
        if job.reconcile_only || self.store.job_action(&job.id)? != "run" {
            return Err(denied(
                "Pause, cancellation, or reconciliation prevents new external writes",
            ));
        }
        Ok(())
    }

    fn browser_execute(
        &self,
        caller: &PluginCaller,
        job: &Job,
        guard: &HostGuard,
        payload: &Value,
        deadline: Instant,
    ) -> AgentResult<Value> {
        fields(payload, &["operation", "origin", "input", "timeoutMs"])?;
        if canonical(payload).len() > 240 * 1024 {
            return Err(invalid("Browser request exceeds its byte budget"));
        }
        let operation = string(payload, "operation")?;
        if !matches!(
            operation,
            "navigate"
                | "snapshot"
                | "click"
                | "submit"
                | "fill"
                | "select"
                | "upload"
                | "readFields"
                | "request"
        ) {
            return Err(denied("Browser operation is not allowed"));
        }
        if string(payload, "origin")? != job.snapshot.platform_origin {
            return Err(denied(
                "Browser origin does not match the immutable platform scope",
            ));
        }
        let input = payload["input"]
            .as_object()
            .ok_or_else(|| invalid("Browser tool input must be an object"))?;
        if input.contains_key("files") {
            return Err(denied(
                "Caller-selected file paths are forbidden; use artifact IDs",
            ));
        }
        let uncertain = self.store.has_uncertain(&job.id)?;
        let initialize_origin =
            origin_initialization(job, operation, &payload["input"], uncertain)?;
        let safe_read =
            initialize_origin || matches!(operation, "snapshot" | "readFields" | "request");
        if !safe_read {
            self.require_dispatching(job)?;
            if uncertain && operation != "submit" {
                return Err(denied(
                    "An unresolved external action permits only readback tools",
                ));
            }
        }
        if operation == "request" {
            fields(&payload["input"], &["path", "method"])?;
            if payload["input"]["method"] != "GET" {
                return Err(denied("Only same-origin GET requests are allowed"));
            }
        }
        let _tool = guard
            .0
            .tool
            .try_lock()
            .map_err(|_| denied("Another tool is in flight for this actor"))?;
        let mut request = payload.clone();
        if initialize_origin {
            // Runtime may initialize about:blank, but must preserve an existing owned page.
            request["input"]["initializeOrigin"] = json!(true);
        }
        if operation == "upload" {
            fields(&payload["input"], &["target", "artifactIds"])?;
            let ids = input
                .get("artifactIds")
                .and_then(Value::as_array)
                .filter(|ids| !ids.is_empty() && ids.len() <= 12)
                .ok_or_else(|| invalid("Upload requires one to twelve frozen artifacts"))?;
            let mut paths = Vec::with_capacity(ids.len());
            let mut seen = std::collections::HashSet::new();
            for id in ids {
                let id = id
                    .as_str()
                    .ok_or_else(|| invalid("Artifact ID must be a UUID"))?;
                if !seen.insert(id) {
                    return Err(invalid("Upload artifact IDs must be unique"));
                }
                let (mime, size, digest) = self.store.artifact(&guard.0.scope, id)?;
                let path =
                    self.artifacts
                        .resolve(&guard.0.scope.batch_id, id, &mime, size, &digest)?;
                paths.push(
                    path.to_str()
                        .ok_or_else(|| {
                            invalid("Artifact path cannot be passed to the controlled runtime")
                        })?
                        .to_owned(),
                );
            }
            request["input"]
                .as_object_mut()
                .ok_or_else(|| invalid("Invalid upload input"))?
                .remove("artifactIds");
            request["input"]["files"] = json!(paths);
        }
        let timeout = payload
            .get("timeoutMs")
            .map(|v| v.as_u64().ok_or_else(|| invalid("Invalid browser timeout")))
            .transpose()?
            .unwrap_or(30_000);
        if !(1..=120_000).contains(&timeout) {
            return Err(invalid("Invalid browser timeout"));
        }
        self.verify_binding(&job.snapshot)?;
        self.verify_account(&job.snapshot, safe_read)?;
        self.recheck(caller, &guard.0.scope)?;
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if remaining == 0 {
            return Err(invalid("Host deadline elapsed before browser invocation"));
        }
        request["timeoutMs"] = json!(timeout.min(remaining).min(90_000));
        if operation == "submit" {
            fields(&payload["input"], &["target", "operationId"])?;
            self.require_dispatching(job)?;
            self.store.action_submitting(
                &guard.0.scope,
                &caller.generation,
                string(&payload["input"], "operationId")?,
            )?;
        }
        // The provider owns the real browser/context/profile. This gateway never
        // accepts a CDP endpoint, cookie, alternate window, or caller file path.
        let outcome = self
            .windows()?
            .agent_browser_execute(&job.snapshot.window_id, request)
            .map_err(browser_error);
        self.recheck(caller, &guard.0.scope)?;
        outcome
    }

    fn plugin_route(
        &self,
        caller: &PluginCaller,
        job: &Job,
        payload: &Value,
    ) -> AgentResult<Value> {
        fields(payload, &["pluginId", "capability", "method", "payload"])?;
        let plugin = string(payload, "pluginId")?;
        let capability = string(payload, "capability")?;
        let method = string(payload, "method")?;
        let input = payload
            .get("payload")
            .ok_or_else(|| invalid("Plugin route payload is missing"))?;
        if canonical(input).len() > 32 * 1024 {
            return Err(invalid("Cross-plugin input exceeds its budget"));
        }
        let scope = job
            .scope
            .as_ref()
            .ok_or_else(|| denied("Job has no active lease"))?;
        match (plugin, capability, method) {
            ("studio.vinted-accounts", "account.pool", "vinted.accounts.agent.snapshot") => {
                fields(input, &["windowId"])?;
                if input["windowId"].as_str() != Some(scope.window_id.as_str()) {
                    return Err(denied("Account snapshot belongs to another window"));
                }
                let (account, origin) = self.account_snapshot(&scope.window_id)?;
                if account["accountId"] != job.snapshot.account["accountId"]
                    || account["platformUserId"] != job.snapshot.account["platformUserId"]
                    || origin != job.snapshot.platform_origin
                {
                    return Err(denied("Account identity changed after job creation"));
                }
                Ok(json!({"windowId":scope.window_id,"account":account}))
            }
            ("studio.vinted-accounts", "account.pool", "vinted.accounts.observations.record") => {
                fields(
                    input,
                    &[
                        "operationId",
                        "accountId",
                        "windowId",
                        "observedAt",
                        "source",
                        "platformUserId",
                        "status",
                        "tags",
                        "summary",
                        "rating",
                        "balance",
                    ],
                )?;
                uuid(string(input, "operationId")?)?;
                if input["windowId"].as_str() != Some(scope.window_id.as_str())
                    || input["accountId"].as_str() != Some(scope.account_id.as_str())
                    || input
                        .get("platformUserId")
                        .is_some_and(|id| id != &job.snapshot.account["platformUserId"])
                {
                    return Err(denied(
                        "Observation is outside the bound account/window identity",
                    ));
                }
                self.verify_binding(&job.snapshot)?;
                self.verify_account(&job.snapshot, true)?;
                self.recheck(caller, scope)?;
                let reply = self
                    .host()?
                    .call(
                        plugin,
                        Capability::AccountPool,
                        method,
                        input.clone(),
                        Duration::from_secs(30),
                    )
                    .map_err(host_error)?;
                if reply["operationId"] != input["operationId"]
                    || reply["accountId"] != input["accountId"]
                    || reply["storageDurable"] != true
                    || reply["applied"].as_bool().is_none()
                {
                    return Err(invalid(
                        "Account plugin did not acknowledge the observation receipt",
                    ));
                }
                Ok(reply)
            }
            ("studio.products", "product.catalog", "products.publications.record") => {
                let operation = self.store.require_publication(scope, input)?;
                self.verify_binding(&job.snapshot)?;
                self.verify_account(&job.snapshot, true)?;
                self.recheck(caller, scope)?;
                match self
                    .host()?
                    .call(
                        plugin,
                        Capability::ProductCatalog,
                        method,
                        input.clone(),
                        Duration::from_secs(30),
                    )
                    .map_err(host_error)
                    .and_then(|reply| {
                        verify_publication_reply(&reply, input)?;
                        Ok(reply)
                    }) {
                    Ok(reply) => {
                        self.store.outbox_result(&operation, None)?;
                        Ok(reply)
                    }
                    Err(error) => {
                        self.store.outbox_result(
                            &operation,
                            Some((
                                &error.code,
                                !matches!(
                                    error.code.as_str(),
                                    "CONFLICT" | "INVALID_REQUEST" | "NOT_FOUND"
                                ),
                            )),
                        )?;
                        Err(error)
                    }
                }
            }
            _ => Err(denied(
                "Cross-plugin method, target, or capability is outside the allowlist",
            )),
        }
    }
}

pub(super) fn origin_initialization(
    job: &Job,
    operation: &str,
    input: &Value,
    uncertain: bool,
) -> AgentResult<bool> {
    if input.get("initializeOrigin").is_some() {
        return Err(denied(
            "Origin initialization is reserved for the native gateway",
        ));
    }
    if operation != "navigate" || !(job.reconcile_only || uncertain) {
        return Ok(false);
    }
    fields(input, &["url"])?;
    if input["url"].as_str() != Some(format!("{}/", job.snapshot.platform_origin).as_str()) {
        return Err(denied(
            "Reconciliation can only initialize the frozen platform origin root",
        ));
    }
    Ok(true)
}

pub(crate) fn fields(value: &Value, allowed: &[&str]) -> AgentResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Host payload must be an object"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("Unknown host payload field"));
    }
    Ok(())
}

fn string<'a>(value: &'a Value, key: &str) -> AgentResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Required host payload string is missing"))
}
fn integer(value: &Value, key: &str) -> AgentResult<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("Required host payload integer is missing"))
}

pub(crate) fn validate_confirmation(
    job: &Job,
    operation: &str,
    result: &Value,
) -> AgentResult<Option<Value>> {
    uuid(operation)?;
    let snapshot = &job.snapshot;
    match result["kind"].as_str() {
        Some("listing") => {
            fields(
                result,
                &[
                    "kind",
                    "productId",
                    "productRevision",
                    "listingId",
                    "listingUrl",
                    "publishedAt",
                    "windowId",
                    "windowName",
                    "platform",
                ],
            )?;
            let product_id = string(result, "productId")?;
            uuid(product_id)?;
            let product = snapshot
                .products
                .iter()
                .find(|product| product["id"].as_str() == Some(product_id))
                .ok_or_else(|| denied("Confirmed publication refers to an unassigned product"))?;
            if job.preset != Preset::PostListing
                || result["productRevision"] != product["revision"]
                || result["windowId"].as_str() != Some(snapshot.window_id.as_str())
                || result["windowName"].as_str() != Some(snapshot.window_name.as_str())
                || result["platform"] != "vinted"
            {
                return Err(denied(
                    "Publication receipt does not match the immutable product/window binding",
                ));
            }
            let id = string(result, "listingId")?;
            if id.is_empty()
                || id.len() > 32
                || !id.bytes().all(|b| b.is_ascii_digit())
                || id.starts_with('0')
            {
                return Err(invalid(
                    "Listing identity must be a positive numeric platform ID",
                ));
            }
            let url_text = string(result, "listingUrl")?;
            text(url_text, 1, 2048)?;
            let url =
                url::Url::parse(url_text).map_err(|_| invalid("Invalid confirmed listing URL"))?;
            let path_id = url
                .path()
                .strip_prefix("/items/")
                .and_then(|part| part.trim_end_matches('/').split('-').next());
            if url.origin().ascii_serialization() != snapshot.platform_origin
                || path_id != Some(id)
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url_text
                    .chars()
                    .any(|ch| ch.is_whitespace() || ch.is_control())
                || url_text.contains('\\')
                || url
                    .path()
                    .trim_end_matches('/')
                    .trim_start_matches("/items/")
                    .contains('/')
            {
                return Err(denied(
                    "Confirmed listing URL is outside the bound site or listing identity",
                ));
            }
            validate_timestamp(string(result, "publishedAt")?)?;
            let mut payload = result.clone();
            payload
                .as_object_mut()
                .ok_or_else(|| invalid("Invalid listing result"))?
                .remove("kind");
            payload["operationId"] = json!(operation);
            Ok(Some(payload))
        }
        Some("message") => {
            fields(
                result,
                &["kind", "conversationId", "text", "confirmedAt", "evidence"],
            )?;
            let conversation = string(result, "conversationId")?;
            let text = string(result, "text")?;
            if job.preset != Preset::Message
                || !snapshot
                    .messages
                    .iter()
                    .any(|message| message.conversation_id == conversation && message.text == text)
            {
                return Err(denied(
                    "Confirmed message differs from its assigned conversation or text",
                ));
            }
            validate_timestamp(string(result, "confirmedAt")?)?;
            let evidence = &result["evidence"];
            fields(evidence, &["messageId", "sentAt"])?;
            let message_id = string(evidence, "messageId")?;
            if message_id.is_empty()
                || message_id.len() > 32
                || message_id.starts_with('0')
                || !message_id.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(invalid(
                    "Message evidence requires a positive numeric platform message ID",
                ));
            }
            validate_timestamp(string(evidence, "sentAt")?)?;
            Ok(None)
        }
        _ => Err(invalid("Unknown external action confirmation kind")),
    }
}

pub(super) fn validate_timestamp(value: &str) -> AgentResult<()> {
    text(value, 20, 64)?;
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return Err(invalid("Confirmation time must be an ISO timestamp"));
    }
    let number = |start: usize, end: usize| -> Option<u32> {
        let part = bytes.get(start..end)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = number(0, 4).ok_or_else(|| invalid("Invalid timestamp year"))?;
    let month = number(5, 7).ok_or_else(|| invalid("Invalid timestamp month"))?;
    let day = number(8, 10).ok_or_else(|| invalid("Invalid timestamp day"))?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if day == 0
        || day > max_day
        || number(11, 13).is_none_or(|value| value > 23)
        || number(14, 16).is_none_or(|value| value > 59)
        || number(17, 19).is_none_or(|value| value > 59)
    {
        return Err(invalid("Invalid confirmation timestamp"));
    }
    let mut zone = 19;
    if bytes.get(zone) == Some(&b'.') {
        zone += 1;
        let first = zone;
        while bytes.get(zone).is_some_and(u8::is_ascii_digit) {
            zone += 1;
        }
        if zone == first {
            return Err(invalid("Invalid timestamp fraction"));
        }
    }
    if &bytes[zone..] == b"Z" {
        return Ok(());
    }
    if matches!(bytes.get(zone), Some(b'+' | b'-'))
        && bytes.len() == zone + 6
        && bytes.get(zone + 3) == Some(&b':')
        && number(zone + 1, zone + 3).is_some_and(|v| v <= 23)
        && number(zone + 4, zone + 6).is_some_and(|v| v <= 59)
    {
        return Ok(());
    }
    Err(invalid(
        "Confirmation timestamp requires an explicit timezone",
    ))
}
