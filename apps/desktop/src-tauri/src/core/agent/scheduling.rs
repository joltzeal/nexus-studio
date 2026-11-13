use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::dto::*;
use super::sql::{read_optional_u64, read_u64};
use super::store::Job;
use super::{AgentResult, canonical, invalid, now_ms, storage_error};
use crate::core::browser::provider::ProviderCapacity;

pub(super) fn admit(
    db: &Connection,
    job: &Job,
    capacity: Option<&ProviderCapacity>,
) -> AgentResult<bool> {
    let (action, next): (String, i64) = db
        .query_row(
            "SELECT action,next_attempt FROM agent_dispatch WHERE job_id=?1",
            [&job.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if action != "run" || next > now_ms() {
        return Ok(false);
    }
    for resource in job.snapshot.resources()? {
        let until: Option<i64> = db
            .query_row(
                "SELECT until_ms FROM agent_cooldowns WHERE resource_key=?1",
                [resource],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if until.is_some_and(|until| until > now_ms()) {
            return Ok(false);
        }
    }
    let provider = &job.snapshot.provider_id;
    let own_limit = job.settings["execution"]["providerConcurrency"][provider]
        .as_u64()
        .unwrap_or(3);
    let (active, minimum): (u64, Option<u64>) = db
        .query_row(
            "SELECT COUNT(*),MIN(COALESCE(json_extract(b.settings_json,?2),3))
         FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id
         WHERE (j.state='running' OR j.actor_owned=1)
           AND json_extract(j.snapshot_json,'$.providerId')=?1",
            params![
                provider,
                format!("$.execution.providerConcurrency.{provider}")
            ],
            |r| Ok((read_u64(r, 0)?, read_optional_u64(r, 1)?)),
        )
        .map_err(storage_error)?;
    if active >= own_limit.min(minimum.unwrap_or(own_limit)) {
        return Ok(false);
    }
    if let Some(capacity) = capacity {
        let mut occupied: HashSet<String> = capacity.running_profiles.iter().cloned().collect();
        occupied.extend(super::store::strings(
            db,
            "SELECT json_extract(snapshot_json,'$.profileId') FROM agent_jobs
             WHERE (state='running' OR actor_owned=1)
               AND json_extract(snapshot_json,'$.connectionId')=?1",
            [&job.snapshot.connection_id],
        )?);
        occupied.insert(job.snapshot.profile_id.clone());
        if occupied.len() as u64 > u64::from(capacity.max_running) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn record_step(db: &Connection, job: &Job, output: &StepOutput) -> AgentResult<bool> {
    if let Some(progress) = &output.progress {
        let count = job
            .snapshot
            .products
            .len()
            .max(job.snapshot.messages.len())
            .max(1);
        if progress.current_index as usize > count
            || progress.published as usize > count
            || progress.skipped as usize > count
            || progress.published + progress.skipped > count as u32
            || progress.current_product_id.as_ref().is_some_and(|id| {
                job.snapshot
                    .products
                    .get(progress.current_index as usize)
                    .is_none_or(|p| p["id"].as_str() != Some(id.as_str()))
            })
        {
            return Err(invalid(
                "Step progress does not match the immutable assignment",
            ));
        }
        if job.preset == super::dto::Preset::PostListing {
            let confirmed: u32 = db
                .query_row(
                    "SELECT COUNT(DISTINCT json_extract(result_json,'$.productId'))
                FROM agent_actions WHERE job_id=?1 AND kind='listing' AND state='confirmed'",
                    [&job.id],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            if progress.published > confirmed {
                return Err(invalid(
                    "Published progress requires durable confirmation evidence",
                ));
            }
        }
        db.execute(
            "UPDATE agent_dispatch SET progress_json=?2 WHERE job_id=?1",
            params![
                job.id,
                canonical(&serde_json::to_value(progress).map_err(storage_error)?)
            ],
        )
        .map_err(storage_error)?;
    }
    let Some(retry) = &output.retry else {
        db.execute("UPDATE agent_dispatch SET retry_json=NULL,next_attempt=0,retry_attempt=0,retry_code='' WHERE job_id=?1",
            [&job.id]).map_err(storage_error)?;
        return Ok(false);
    };
    let configured = job.settings["execution"]["maxReadRetries"]
        .as_u64()
        .unwrap_or(2);
    let previous: u32 = db
        .query_row(
            "SELECT retry_attempt FROM agent_dispatch WHERE job_id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if output.state != StepState::Continue
        || retry.attempt == 0
        || retry.attempt > retry.max_attempts
        || retry.max_attempts as u64 > configured
        || retry.max_attempts > 5
        || retry.attempt != previous + 1
    {
        return Err(invalid(
            "Retry is outside the configured bounded read policy",
        ));
    }
    text(&retry.code, 1, 100)?;
    if retry
        .code
        .chars()
        .any(|c| !c.is_ascii_uppercase() && !c.is_ascii_digit() && c != '_')
    {
        return Err(invalid("Retry requires a structured error code"));
    }
    let now = now_ms();
    let requested = super::schema::millis(db, &retry.next_attempt_at)?;
    if requested > now + 600_000 || requested < now - 60_000 {
        return Err(invalid(
            "Retry deadline exceeds the bounded scheduling horizon",
        ));
    }
    let base = job.settings["execution"]["retryBaseMs"]
        .as_i64()
        .unwrap_or(2000);
    let mut delay = (base * (1i64 << (retry.attempt - 1))).min(300_000);
    if matches!(
        retry.code.as_str(),
        "RATE_LIMITED" | "PLATFORM_RATE_LIMITED" | "HTTP_429"
    ) {
        delay = delay.max(
            job.settings["execution"]["platformCooldownMs"]
                .as_i64()
                .unwrap_or(30_000),
        );
    }
    let next = requested.max(now + delay);
    let mut stored = serde_json::to_value(retry).map_err(storage_error)?;
    stored["nextAttemptAt"] = json!(super::schema::timestamp(db, next)?);
    db.execute(
        "UPDATE agent_dispatch SET retry_json=?2,next_attempt=?3,retry_attempt=?4,retry_code=?5 WHERE job_id=?1",
        params![job.id,canonical(&stored),next,retry.attempt,retry.code],
    ).map_err(storage_error)?;
    for resource in job
        .snapshot
        .resources()?
        .into_iter()
        .filter(|key| key.starts_with("account:") || key.starts_with("vinted-identity:"))
    {
        db.execute(
            "INSERT INTO agent_cooldowns(resource_key,until_ms) VALUES(?1,?2)
             ON CONFLICT(resource_key) DO UPDATE SET until_ms=MAX(agent_cooldowns.until_ms,excluded.until_ms)",
            params![resource,next],
        ).map_err(storage_error)?;
    }
    Ok(true)
}

pub(super) fn job_view(db: &Connection, id: &str, view: &mut Value) -> AgentResult<()> {
    let (retry, progress, takeover): (Option<String>, Option<String>, String) = db
        .query_row(
            "SELECT retry_json,progress_json,takeover FROM agent_dispatch WHERE job_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(storage_error)?;
    if let Some(value) = retry {
        view["retry"] = serde_json::from_str(&value).map_err(storage_error)?;
    }
    if let Some(value) = progress {
        view["progress"] = serde_json::from_str(&value).map_err(storage_error)?;
    }
    view["takeover"] = json!(takeover);
    Ok(())
}
