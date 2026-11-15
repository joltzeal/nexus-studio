use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::dto::*;
use super::gateway::{fields, validate_timestamp};
use super::store::{AgentStore, Job, read_job, validate_lease};
use super::{AgentResult, canonical, conflict, denied, invalid, now_ms, storage_error};
use crate::core::plugin_host::process::PluginErrorPayload;

const DOMAINS: &[&str] = &[
    "identity",
    "session",
    "wallet.available",
    "wallet.pending",
    "bankAccounts",
    "analysis",
];

struct ReservedObservation {
    job_id: String,
    scope_json: String,
    binding_revision: String,
    domains_json: String,
    sequence: Option<i64>,
    record_digest: Option<String>,
}

#[derive(Debug)]
pub(super) struct ObservationIntentError {
    pub(super) error: PluginErrorPayload,
    pub(super) halt_dispatch: bool,
}

impl From<PluginErrorPayload> for ObservationIntentError {
    fn from(error: PluginErrorPayload) -> Self {
        Self {
            error,
            halt_dispatch: false,
        }
    }
}

fn valid_amount(value: &str) -> bool {
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    let (whole, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(a, b)| (a, Some(b)));
    value.len() <= 18
        && !whole.is_empty()
        && whole.len() <= 12
        && whole.bytes().all(|b| b.is_ascii_digit())
        && (whole == "0" || !whole.starts_with('0'))
        && fraction
            .is_none_or(|v| !v.is_empty() && v.len() <= 4 && v.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_mask(value: &str) -> bool {
    let suffix = value.trim_end_matches(|c: char| c.is_ascii_digit());
    let digits = value.len() - suffix.len();
    !value.chars().any(char::is_control)
        && (1..=4).contains(&digits)
        && suffix
            .chars()
            .any(|c| matches!(c, '*' | 'x' | 'X' | '\u{2022}'))
        && suffix
            .chars()
            .all(|c| matches!(c, '*' | 'x' | 'X' | '\u{2022}' | '-') || c.is_whitespace())
}

pub(super) fn initialize(db: &Connection) -> AgentResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_account_reservations(
           operation_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES agent_jobs(id),
           scope_json TEXT NOT NULL,binding_revision TEXT NOT NULL,domains_json TEXT NOT NULL,
           sequence INTEGER,record_digest TEXT,receipt_json TEXT);
         CREATE TABLE IF NOT EXISTS agent_dispatch_halts(
           resource_key TEXT PRIMARY KEY,operation_id TEXT NOT NULL,binding_revision TEXT NOT NULL,
           reason TEXT NOT NULL);",
    )
    .map_err(storage_error)
}

fn string<'a>(value: &'a Value, key: &str) -> AgentResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| invalid("Observation string field is missing"))
}

pub(super) fn project_session(value: &Value, account: &Value, window: &str) -> AgentResult<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    fields(
        value,
        &[
            "windowId",
            "accountId",
            "bindingRevision",
            "observedAt",
            "source",
            "status",
            "reason",
            "platformUserId",
        ],
    )?;
    if value["windowId"].as_str() != Some(window)
        || value["accountId"] != account["accountId"]
        || value["bindingRevision"] != account["bindingRevision"]
        || value["source"] != "official"
    {
        return Err(denied(
            "Session observation belongs to another account/window binding",
        ));
    }
    validate_timestamp(string(value, "observedAt")?)?;
    match value["status"].as_str() {
        Some("authenticated")
            if value["reason"] == "current_user"
                && value["platformUserId"] == account["platformUserId"] => {}
        Some("logged_out")
            if value["reason"] == "current_access_denied"
                && value.get("platformUserId").is_some_and(Value::is_null) => {}
        _ => return Err(invalid("Invalid bound session observation")),
    }
    Ok(value.clone())
}

pub(super) fn binding(job: &Job, input: &Value) -> AgentResult<()> {
    for key in ["operationId", "accountId", "windowId", "bindingRevision"] {
        uuid(string(input, key)?)?;
    }
    if input["accountId"] != job.snapshot.account["accountId"]
        || input["windowId"].as_str() != Some(job.snapshot.window_id.as_str())
        || input["bindingRevision"] != job.snapshot.account["bindingRevision"]
    {
        return Err(denied(
            "Observation is outside the fenced account/window binding",
        ));
    }
    Ok(())
}

fn domains(value: &Value) -> AgentResult<Vec<String>> {
    let values = value
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 6)
        .ok_or_else(|| invalid("Observation domains must be bounded and nonempty"))?;
    let mut result = Vec::new();
    for value in values {
        let domain = value
            .as_str()
            .ok_or_else(|| invalid("Invalid observation domain"))?;
        if !DOMAINS.contains(&domain) || result.iter().any(|s| s == domain) {
            return Err(invalid("Invalid or duplicate observation domain"));
        }
        result.push(domain.to_owned());
    }
    Ok(result)
}

pub(super) fn validate_record(job: &Job, input: &Value) -> AgentResult<Vec<String>> {
    fields(
        input,
        &[
            "operationId",
            "accountId",
            "windowId",
            "bindingRevision",
            "sequence",
            "observedAt",
            "source",
            "current",
            "wallet",
            "bankAccounts",
            "analysis",
            "failures",
        ],
    )?;
    binding(job, input)?;
    if input["sequence"]
        .as_u64()
        .is_none_or(|s| s == 0 || s > 9_007_199_254_740_991)
    {
        return Err(invalid("Observation sequence must be reserved"));
    }
    validate_timestamp(string(input, "observedAt")?)?;
    if !matches!(
        input["source"].as_str(),
        Some("official" | "page" | "model")
    ) {
        return Err(invalid("Invalid observation source"));
    }
    let identity = job.snapshot.account["platformUserId"]
        .as_str()
        .ok_or_else(|| invalid("Bound identity is missing"))?;
    let mut touched = Vec::new();
    if let Some(current) = input.get("current") {
        match current["status"].as_str() {
            Some("authenticated") => {
                fields(
                    current,
                    &[
                        "status",
                        "reason",
                        "platformUserId",
                        "isAccountBanned",
                        "profileUrl",
                    ],
                )?;
                if current["reason"] != "current_user"
                    || current["platformUserId"].as_str() != Some(identity)
                    || current
                        .get("isAccountBanned")
                        .is_some_and(|v| !v.is_boolean())
                {
                    return Err(denied(
                        "Current evidence does not match the bound platform identity",
                    ));
                }
                if let Some(url) = current.get("profileUrl").filter(|v| !v.is_null()) {
                    text(
                        url.as_str()
                            .ok_or_else(|| invalid("Invalid current profile URL"))?,
                        0,
                        2048,
                    )?;
                }
            }
            Some("logged_out") => {
                fields(
                    current,
                    &["status", "reason", "httpStatus", "code", "messageCode"],
                )?;
                if current["reason"] != "current_access_denied"
                    || current["code"].as_i64() != Some(106)
                    || current["messageCode"] != "access_denied"
                    || !matches!(current["httpStatus"].as_u64(), Some(200 | 401 | 403))
                {
                    return Err(invalid(
                        "Logout requires exact verified current access-denied evidence",
                    ));
                }
            }
            _ => return Err(invalid("Invalid current session evidence")),
        }
        touched.extend(["identity".to_owned(), "session".to_owned()]);
    }
    for key in ["wallet", "bankAccounts"] {
        let Some(finance) = input.get(key) else {
            continue;
        };
        if finance["beforePlatformUserId"].as_str() != Some(identity)
            || finance["afterPlatformUserId"].as_str() != Some(identity)
        {
            return Err(denied(
                "Financial evidence requires matching before and after identities",
            ));
        }
        if key == "wallet" {
            fields(
                finance,
                &[
                    "beforePlatformUserId",
                    "afterPlatformUserId",
                    "available",
                    "pending",
                ],
            )?;
            let mut found = false;
            for money_key in ["available", "pending"] {
                if let Some(money) = finance.get(money_key) {
                    found = true;
                    if !money.is_null() {
                        fields(money, &["amount", "currency"])?;
                        let amount = string(money, "amount")?;
                        let currency = string(money, "currency")?;
                        if !valid_amount(amount)
                            || currency.len() != 3
                            || !currency.bytes().all(|b| b.is_ascii_uppercase())
                        {
                            return Err(invalid("Invalid money observation"));
                        }
                    }
                    touched.push(format!("wallet.{money_key}"));
                }
            }
            if !found {
                return Err(invalid("Wallet result has no observed money domain"));
            }
        } else {
            fields(
                finance,
                &["beforePlatformUserId", "afterPlatformUserId", "records"],
            )?;
            let records = finance["records"]
                .as_array()
                .filter(|a| a.len() <= 20)
                .ok_or_else(|| invalid("Bank result must be a complete bounded list"))?;
            let mut ids = std::collections::HashSet::new();
            for record in records {
                fields(
                    record,
                    &[
                        "id",
                        "name",
                        "account_number",
                        "routing_number",
                        "spending_type",
                        "user_id",
                        "hide_name",
                        "is_default",
                    ],
                )?;
                let id = string(record, "id")?;
                let masked = string(record, "account_number")?;
                let routing = string(record, "routing_number")?;
                if id.is_empty()
                    || id.len() > 32
                    || !id.bytes().all(|b| b.is_ascii_digit())
                    || id.starts_with('0')
                    || !ids.insert(id)
                    || record["user_id"].as_str() != Some(identity)
                    || routing.len() != 9
                    || !routing.bytes().all(|b| b.is_ascii_digit())
                    || !record["hide_name"].is_boolean()
                    || !record["is_default"].is_boolean()
                    || masked.is_empty()
                    || masked.len() > 64
                    || !valid_mask(masked)
                {
                    return Err(invalid("Invalid or out-of-scope bank observation"));
                }
                text(string(record, "name")?, 0, 160)?;
                text(string(record, "spending_type")?, 1, 64)?;
            }
            touched.push("bankAccounts".into());
        }
    }
    if (input.get("current").is_some()
        || input.get("wallet").is_some()
        || input.get("bankAccounts").is_some())
        && input["source"] != "official"
    {
        return Err(denied("Official current/financial evidence is required"));
    }
    if let Some(analysis) = input.get("analysis") {
        fields(analysis, &["tags", "summary", "rating"])?;
        if analysis.as_object().is_none_or(|o| o.is_empty()) {
            return Err(invalid("Analysis is empty"));
        }
        if let Some(tags) = analysis.get("tags") {
            let tags = tags
                .as_array()
                .filter(|a| a.len() <= 8)
                .ok_or_else(|| invalid("Invalid analysis tags"))?;
            for tag in tags {
                text(
                    tag.as_str()
                        .ok_or_else(|| invalid("Invalid analysis tag"))?,
                    1,
                    24,
                )?;
            }
        }
        if let Some(summary) = analysis.get("summary") {
            text(
                summary.as_str().ok_or_else(|| invalid("Invalid summary"))?,
                0,
                160,
            )?;
        }
        if analysis.get("rating").is_some_and(|r| {
            r.as_f64()
                .is_none_or(|r| !r.is_finite() || !(0.0..=5.0).contains(&r))
        }) {
            return Err(invalid("Invalid analysis rating"));
        }
        touched.push("analysis".into());
    }
    if let Some(failures) = input.get("failures") {
        let failures = failures
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 6)
            .ok_or_else(|| invalid("Invalid domain failures"))?;
        for failure in failures {
            fields(failure, &["domain", "code"])?;
            let domain = string(failure, "domain")?;
            if !DOMAINS.contains(&domain)
                || !matches!(
                    failure["code"].as_str(),
                    Some("unreadable" | "network_error" | "identity_mismatch" | "invalid_response")
                )
            {
                return Err(invalid("Invalid domain failure"));
            }
            if domain != "analysis" && input["source"] != "official" {
                return Err(denied(
                    "Official evidence is required for account read failures",
                ));
            }
            touched.push(domain.into());
        }
    }
    if touched.is_empty() {
        return Err(invalid("Observation has no result or failure"));
    }
    Ok(touched)
}

pub(super) fn strong_stop(input: &Value) -> Option<&'static str> {
    if input["current"]["status"] == "authenticated" && input["current"]["isAccountBanned"] == true
    {
        Some("blocked")
    } else if input["current"]["status"] == "logged_out" {
        Some("login_required")
    } else {
        None
    }
}

impl AgentStore {
    pub(super) fn reserve_observation(
        &self,
        scope: &AgentScope,
        generation: &str,
        input: &Value,
        reply: Option<&Value>,
    ) -> AgentResult<()> {
        fields(
            input,
            &[
                "operationId",
                "accountId",
                "windowId",
                "bindingRevision",
                "domains",
            ],
        )?;
        let values = domains(&input["domains"])?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        super::execution::require_browser(&job)?;
        binding(&job, input)?;
        let encoded = canonical(&json!(scope));
        let existing:Option<(String,String,String)>=tx.query_row(
            "SELECT scope_json,binding_revision,domains_json FROM agent_account_reservations WHERE operation_id=?1",
            [string(input,"operationId")?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(storage_error)?;
        if let Some((saved, binding, domains)) = existing {
            if saved != encoded
                || binding != string(input, "bindingRevision")?
                || domains != canonical(&json!(values))
            {
                return Err(conflict(
                    "Observation reservation has another fenced scope or domain set",
                ));
            }
        } else {
            tx.execute("INSERT INTO agent_account_reservations(operation_id,job_id,scope_json,binding_revision,domains_json)
                VALUES(?1,?2,?3,?4,?5)",params![string(input,"operationId")?,job.id,encoded,
                    string(input,"bindingRevision")?,canonical(&json!(values))]).map_err(storage_error)?;
        }
        if let Some(reply) = reply {
            fields(
                reply,
                &[
                    "operationId",
                    "accountId",
                    "windowId",
                    "bindingRevision",
                    "sequence",
                    "storageDurable",
                ],
            )?;
            binding(&job, reply)?;
            if reply["operationId"] != input["operationId"]
                || reply["storageDurable"] != true
                || reply["sequence"]
                    .as_u64()
                    .is_none_or(|s| s == 0 || s > 9_007_199_254_740_991)
            {
                return Err(invalid(
                    "Account plugin did not durably reserve observation ordering",
                ));
            }
            let seq = super::sql::to_sql_i64(
                reply["sequence"]
                    .as_u64()
                    .ok_or_else(|| invalid("Invalid observation sequence"))?,
            )?;
            let changed=tx.execute("UPDATE agent_account_reservations SET sequence=?2 WHERE operation_id=?1 AND (sequence IS NULL OR sequence=?2)",
                params![string(input,"operationId")?,seq]).map_err(storage_error)?;
            if changed != 1 {
                return Err(conflict("Reserved sequence is immutable"));
            }
        }
        tx.commit().map_err(storage_error)
    }

    pub(super) fn observation_record_intent(
        &self,
        scope: &AgentScope,
        generation: &str,
        input: &Value,
    ) -> Result<(), ObservationIntentError> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        super::execution::require_browser(&job)?;
        let touched = validate_record(&job, input)?;
        if super::schema::millis(&tx, string(input, "observedAt")?)? > now_ms() + 5000 {
            return Err(invalid("Observation time is in the future").into());
        }
        let row: Option<ReservedObservation> = tx
            .query_row(
                "SELECT job_id,scope_json,binding_revision,domains_json,sequence,record_digest
             FROM agent_account_reservations WHERE operation_id=?1",
                [string(input, "operationId")?],
                |r| {
                    Ok(ReservedObservation {
                        job_id: r.get(0)?,
                        scope_json: r.get(1)?,
                        binding_revision: r.get(2)?,
                        domains_json: r.get(3)?,
                        sequence: r.get(4)?,
                        record_digest: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(storage_error)?;
        let Some(reservation) = row else {
            return Err(denied("Observation must reserve before collection").into());
        };
        let ReservedObservation {
            job_id: reserved_job,
            scope_json: saved,
            binding_revision: revision,
            domains_json: allowed,
            sequence,
            record_digest: old_digest,
        } = reservation;
        let allowed: Vec<String> = serde_json::from_str(&allowed).map_err(storage_error)?;
        let digest = format!("{:x}", Sha256::digest(canonical(input).as_bytes()));
        if reserved_job != job.id
            || saved != canonical(&json!(scope))
            || input["bindingRevision"].as_str() != Some(revision.as_str())
            || sequence.is_none()
            || input["sequence"].as_i64() != sequence
            || touched.iter().any(|d| !allowed.contains(d))
            || old_digest.is_some_and(|old| old != digest)
        {
            return Err(denied(
                "Observation differs from its fenced reservation or immutable record intent",
            )
            .into());
        }
        let stop = strong_stop(input);
        // Authorization and persistence share one transaction. Only storage
        // failures after reservation validation may trigger the in-memory stop.
        let persist = (|| {
            tx.execute(
                "UPDATE agent_account_reservations SET record_digest=?2 WHERE operation_id=?1",
                params![string(input, "operationId")?, digest],
            )
            .map_err(storage_error)?;
            if let Some(reason) = stop {
                halt(&tx, &job, input, reason)?;
            }
            tx.commit().map_err(storage_error)
        })();
        persist.map_err(|error| ObservationIntentError {
            halt_dispatch: stop.is_some() && error.code == "UNAVAILABLE",
            error,
        })
    }

    pub(super) fn observation_recorded(
        &self,
        scope: &AgentScope,
        generation: &str,
        input: &Value,
        reply: &Value,
    ) -> AgentResult<()> {
        fields(
            reply,
            &["operationId", "accountId", "applied", "storageDurable"],
        )?;
        if reply["operationId"] != input["operationId"]
            || reply["accountId"] != input["accountId"]
            || reply["storageDurable"] != true
            || !reply["applied"].is_boolean()
        {
            return Err(invalid(
                "Account plugin did not acknowledge a durable observation",
            ));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        let digest = format!("{:x}", Sha256::digest(canonical(input).as_bytes()));
        let intent:Option<(String,String,Option<String>)>=tx.query_row(
            "SELECT scope_json,record_digest,receipt_json FROM agent_account_reservations WHERE operation_id=?1",
            [string(input,"operationId")?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(storage_error)?;
        if intent.as_ref().is_none_or(|(saved, expected, receipt)| {
            saved != &canonical(&json!(scope))
                || expected != &digest
                || receipt
                    .as_ref()
                    .is_some_and(|saved| saved != &canonical(reply))
        }) {
            return Err(conflict(
                "Observation receipt differs from its fenced immutable intent",
            ));
        }
        if reply["applied"] == true && input.get("current").is_some() {
            let sequence = input["sequence"]
                .as_i64()
                .ok_or_else(|| invalid("Missing reserved sequence"))?;
            tx.execute("INSERT INTO agent_session_observations(window_id,account_id,binding_revision,status,observed_ms,operation_id)
                VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(window_id) DO UPDATE SET account_id=excluded.account_id,
                binding_revision=excluded.binding_revision,status=excluded.status,observed_ms=excluded.observed_ms,
                operation_id=excluded.operation_id WHERE excluded.binding_revision!=agent_session_observations.binding_revision
                  OR excluded.observed_ms>=agent_session_observations.observed_ms",
                params![scope.window_id,scope.account_id,input["bindingRevision"].as_str(),
                    input["current"]["status"].as_str(),sequence,input["operationId"].as_str()]).map_err(storage_error)?;
            // A new authenticated collection can clear only this window's login halt.
            if input["current"]["status"] == "authenticated"
                && input["current"]["isAccountBanned"] != true
            {
                tx.execute("DELETE FROM agent_dispatch_halts WHERE resource_key=?1 AND reason='login_required'
                    AND binding_revision=?2 AND EXISTS(SELECT 1 FROM agent_session_observations s
                      WHERE s.window_id=?3 AND s.binding_revision=?2 AND s.operation_id=?4 AND s.status='authenticated')",
                    params![format!("window:{}",scope.window_id),input["bindingRevision"].as_str(),
                        scope.window_id,input["operationId"].as_str()]).map_err(storage_error)?;
            }
        }
        tx.execute(
            "UPDATE agent_account_reservations SET receipt_json=?2 WHERE operation_id=?1",
            params![input["operationId"].as_str(), canonical(reply)],
        )
        .map_err(storage_error)?;
        if reply["applied"] == true
            && let Some(reason) = strong_stop(input)
        {
            halt(&tx, &job, input, reason)?;
        }
        tx.commit().map_err(storage_error)
    }

    pub(super) fn require_dispatch_writes(&self, id: &str) -> AgentResult<()> {
        super::controls::require_writes(&self.open()?, id)
    }
}

fn halt(db: &Connection, job: &Job, input: &Value, reason: &str) -> AgentResult<()> {
    let superseded: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_session_observations
        WHERE window_id=?1 AND binding_revision=?2 AND observed_ms>?3)",
            params![
                job.snapshot.window_id,
                input["bindingRevision"].as_str(),
                input["sequence"].as_i64()
            ],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if superseded {
        return Ok(());
    }
    let keys = if reason == "blocked" {
        vec![
            format!("account:{}", job.snapshot.account_id()?),
            format!(
                "vinted-identity:{}",
                job.snapshot.account["platformUserId"]
                    .as_str()
                    .unwrap_or("")
                    .trim_start_matches('0')
            ),
        ]
    } else {
        vec![format!("window:{}", job.snapshot.window_id)]
    };
    for key in keys {
        db.execute("INSERT INTO agent_dispatch_halts(resource_key,operation_id,binding_revision,reason)
            VALUES(?1,?2,?3,?4) ON CONFLICT(resource_key) DO UPDATE SET operation_id=excluded.operation_id,
            binding_revision=excluded.binding_revision,reason=excluded.reason",
            params![key,input["operationId"].as_str(),input["bindingRevision"].as_str(),reason]).map_err(storage_error)?;
    }
    Ok(())
}

pub(super) fn require_no_halt(db: &Connection, job: &Job) -> AgentResult<()> {
    for key in job.snapshot.resources()? {
        let stopped: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_dispatch_halts WHERE resource_key=?1
                   AND (?1 NOT LIKE 'window:%' OR binding_revision=?2))",
                params![key, job.snapshot.account["bindingRevision"].as_str()],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if stopped {
            return Err(denied("Account/window observation halted external writes"));
        }
    }
    Ok(())
}
