use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::dto::*;
use super::sql::{read_optional_u64, read_u64, to_sql_i64};
use super::store::{AgentStore, read_job, validate_lease};
use super::{AgentResult, canonical, conflict, denied, invalid, now_ms, storage_error};

impl AgentStore {
    pub fn model_acquire(
        &self,
        scope: &AgentScope,
        generation: &str,
        input: &ModelAcquire,
    ) -> AgentResult<Value> {
        uuid(&input.request_id)?;
        if !matches!(input.kind.as_str(), "decision" | "generation") {
            return Err(invalid("Model permits require a frozen endpoint kind"));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        super::controls::require_writes(&tx, &scope.job_id)?;
        let encoded_scope = canonical(&serde_json::to_value(scope).map_err(storage_error)?);
        let existing:Option<(String,String,String,String,i64)>=tx.query_row(
            "SELECT scope_json,generation,kind,state,deadline FROM agent_model_requests WHERE request_id=?1",
            [&input.request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        ).optional().map_err(storage_error)?;
        if let Some((saved, saved_generation, kind, state, deadline)) = existing {
            if saved != encoded_scope
                || saved_generation != generation
                || kind != input.kind
                || state != "active"
                || deadline <= now_ms()
            {
                return Err(conflict(
                    "Model request ID already belongs to another or completed permit",
                ));
            }
            return Ok(json!({"acquired":true,"requestId":input.request_id}));
        }
        let dispatch: String = tx
            .query_row(
                "SELECT d.action FROM agent_dispatch d JOIN agent_jobs j ON j.id=d.job_id
             JOIN agent_batches b ON b.id=j.batch_id WHERE d.job_id=?1 AND b.control='run'",
                [&scope.job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or_else(|| "pause".into());
        if dispatch != "run" {
            return Err(denied("Stopped jobs cannot acquire new model permits"));
        }
        let now = now_ms();
        tx.execute(
            "UPDATE agent_model_requests SET state='unknown' WHERE state='active' AND deadline<=?1",
            [now],
        )
        .map_err(storage_error)?;
        let (requests, spent, unknown): (u64, f64, u64) = tx
            .query_row(
                "SELECT COUNT(*),COALESCE(SUM(cost_usd),0),
               COALESCE(SUM(state!='active' AND cost_usd IS NULL),0)
             FROM agent_model_requests WHERE batch_id=?1",
                [&scope.batch_id],
                |r| Ok((read_u64(r, 0)?, r.get(1)?, read_u64(r, 2)?)),
            )
            .map_err(storage_error)?;
        let max_requests = job.settings["execution"]["maxBatchModelRequests"]
            .as_u64()
            .unwrap_or(10_000);
        let max_cost = job.settings["execution"]["maxBatchCostUsd"].as_f64();
        let mut reason = None;
        let mut wait = 1000i64;
        if requests >= max_requests || max_cost.is_some_and(|limit| spent >= limit || unknown > 0) {
            reason = Some("budget");
        }
        if max_cost.is_some() && reason.is_none() {
            let (pending, deadline): (u64, Option<i64>) = tx
                .query_row(
                    "SELECT COUNT(*),MIN(deadline) FROM agent_model_requests
                 WHERE batch_id=?1 AND receipt_json IS NULL AND deadline>?2",
                    params![scope.batch_id, now],
                    |r| Ok((read_u64(r, 0)?, r.get(1)?)),
                )
                .map_err(storage_error)?;
            // Acquire has no token reservation. A cost budget serializes this batch
            // and gates its next request using completed, known consumption.
            if pending > 0 {
                reason = Some("capacity");
                wait = deadline
                    .unwrap_or(now + 1000)
                    .saturating_sub(now)
                    .clamp(100, 120_000);
            }
        }
        let own_concurrency = job.settings["execution"]["modelConcurrency"]
            .as_u64()
            .unwrap_or(3);
        let own_rate = job.settings["execution"]["modelRequestsPerMinute"]
            .as_u64()
            .unwrap_or(60);
        let (minimum_concurrency,minimum_rate):(Option<u64>,Option<u64>)=tx.query_row(
            "SELECT MIN(COALESCE(json_extract(settings_json,'$.execution.modelConcurrency'),3)),
                    MIN(COALESCE(json_extract(settings_json,'$.execution.modelRequestsPerMinute'),60))
             FROM agent_batches b WHERE EXISTS(SELECT 1 FROM agent_jobs j WHERE j.batch_id=b.id
               AND (j.state IN ('queued','running') OR j.actor_owned=1))",
            [],|r|Ok((read_optional_u64(r, 0)?,read_optional_u64(r, 1)?)),
        ).map_err(storage_error)?;
        let (active, first_deadline): (u64, Option<i64>) = tx
            .query_row(
                "SELECT COUNT(*),MIN(deadline) FROM agent_model_requests
             WHERE receipt_json IS NULL AND deadline>?1",
                [now],
                |r| Ok((read_u64(r, 0)?, r.get(1)?)),
            )
            .map_err(storage_error)?;
        if reason.is_none()
            && active >= own_concurrency.min(minimum_concurrency.unwrap_or(own_concurrency))
        {
            reason = Some("capacity");
            wait = first_deadline
                .unwrap_or(now + 1000)
                .saturating_sub(now)
                .clamp(100, 120_000);
        }
        let (recent, first): (u64, Option<i64>) = tx
            .query_row(
                "SELECT COUNT(*),MIN(acquired_at) FROM agent_model_requests WHERE acquired_at>?1",
                [now - 60_000],
                |r| Ok((read_u64(r, 0)?, r.get(1)?)),
            )
            .map_err(storage_error)?;
        if reason.is_none() && recent >= own_rate.min(minimum_rate.unwrap_or(own_rate)) {
            reason = Some("rate");
            wait = (first.unwrap_or(now) + 60_000 - now).clamp(100, 60_000);
        }
        if let Some(reason) = reason {
            tx.commit().map_err(storage_error)?;
            return Ok(
                json!({"acquired":false,"requestId":input.request_id,"retryAfterMs":wait,"reason":reason}),
            );
        }
        let endpoint = &job.settings[&input.kind];
        if endpoint["baseUrl"].as_str().is_none() || endpoint["model"].as_str().is_none() {
            return Err(invalid("Frozen model endpoint is missing"));
        }
        let digest = format!("{:x}", Sha256::digest(canonical(endpoint).as_bytes()));
        let timeout = job.settings["requestTimeoutMs"]
            .as_i64()
            .unwrap_or(60_000)
            .clamp(5000, 90_000)
            + 30_000;
        tx.execute(
            "INSERT INTO agent_model_requests(request_id,job_id,batch_id,scope_json,generation,kind,
                endpoint_digest,state,acquired_at,deadline)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'active',?8,?9)",
            params![input.request_id,scope.job_id,scope.batch_id,encoded_scope,generation,input.kind,digest,now,now+timeout],
        ).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(json!({"acquired":true,"requestId":input.request_id}))
    }

    pub fn model_complete(
        &self,
        scope: &AgentScope,
        generation: &str,
        input: &ModelComplete,
    ) -> AgentResult<Value> {
        uuid(&input.request_id)?;
        if !matches!(input.outcome.as_str(), "succeeded" | "failed" | "cancelled")
            || input.elapsed_ms > 120_000
            || input.input_tokens.is_some_and(|n| n > 100_000_000)
            || input.output_tokens.is_some_and(|n| n > 100_000_000)
            || input.status.is_some_and(|n| !(100..=599).contains(&n))
        {
            return Err(invalid("Invalid model completion receipt"));
        }
        let encoded = canonical(&serde_json::to_value(input).map_err(storage_error)?);
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let row:Option<(String,String,String,Option<String>)>=tx.query_row(
            "SELECT scope_json,generation,kind,receipt_json FROM agent_model_requests WHERE request_id=?1",
            [&input.request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional().map_err(storage_error)?;
        let Some((saved, saved_generation, kind, receipt)) = row else {
            return Err(denied("Model completion has no acquired permit"));
        };
        if saved != canonical(&serde_json::to_value(scope).map_err(storage_error)?)
            || saved_generation != generation
        {
            return Err(denied("Model permit has another scope or fencing token"));
        }
        if let Some(receipt) = receipt {
            return if receipt == encoded {
                Ok(json!({"recorded":true}))
            } else {
                Err(conflict("Model completion receipt is immutable"))
            };
        }
        let settings = read_job(&tx, &scope.job_id)?.settings;
        let prices = &settings["pricing"][&kind];
        let cost = match (
            input.input_tokens,
            input.output_tokens,
            prices["inputPerMillionUsd"].as_f64(),
            prices["outputPerMillionUsd"].as_f64(),
        ) {
            (Some(input), Some(output), Some(a), Some(b)) => {
                Some((input as f64 * a + output as f64 * b) / 1_000_000.0)
            }
            _ => None,
        };
        tx.execute(
            "UPDATE agent_model_requests SET state=?2,elapsed_ms=?3,input_tokens=?4,output_tokens=?5,
               cost_usd=?6,receipt_json=?7 WHERE request_id=?1 AND receipt_json IS NULL",
            params![input.request_id,input.outcome,to_sql_i64(input.elapsed_ms)?,
                input.input_tokens.map(to_sql_i64).transpose()?,
                input.output_tokens.map(to_sql_i64).transpose()?,cost,encoded],
        ).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(json!({"recorded":true}))
    }

    pub fn usage(&self, id: &str) -> AgentResult<Value> {
        uuid(id)?;
        let db = self.open()?;
        super::store::batch_view(&db, id)?;
        let settings: String = db
            .query_row(
                "SELECT settings_json FROM agent_batches WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        let settings: Value = serde_json::from_str(&settings).map_err(storage_error)?;
        let (requests,succeeded,failed,elapsed,input,output,unknown,cost):(u64,u64,u64,u64,u64,u64,u64,f64)=db.query_row(
            "SELECT COUNT(*),COALESCE(SUM(state='succeeded'),0),COALESCE(SUM(state='failed'),0),
               COALESCE(SUM(elapsed_ms),0),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),
               COALESCE(SUM(input_tokens IS NULL OR output_tokens IS NULL),0),COALESCE(SUM(cost_usd),0)
             FROM agent_model_requests WHERE batch_id=?1",
            [id],|r|Ok((read_u64(r, 0)?,read_u64(r, 1)?,read_u64(r, 2)?,read_u64(r, 3)?,
                read_u64(r, 4)?,read_u64(r, 5)?,read_u64(r, 6)?,r.get(7)?)),
        ).map_err(storage_error)?;
        let unknown_cost: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_model_requests WHERE batch_id=?1 AND cost_usd IS NULL",
                [id],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        let notifications: Vec<String> = super::store::strings(
            &db,
            "SELECT state FROM agent_notification_outbox WHERE batch_id=?1",
            [id],
        )?;
        let notification = if settings["notifications"]["enabled"] != true {
            "disabled"
        } else if notifications.iter().any(|s| s == "pending") {
            "pending"
        } else if notifications.iter().any(|s| s == "failed") {
            "failed"
        } else if notifications.iter().any(|s| s == "sent") {
            "sent"
        } else {
            "none"
        };
        Ok(
            json!({"batchId":id,"requests":requests,"succeeded":succeeded,"failed":failed,
            "elapsedMs":elapsed,"inputTokens":input,"outputTokens":output,"unknownUsage":unknown,
            "estimatedCostUsd":if unknown_cost==0 {Some(cost)}else{None},
            "maxRequests":settings["execution"]["maxBatchModelRequests"].as_u64().unwrap_or(10_000),
            "maxCostUsd":settings["execution"]["maxBatchCostUsd"],"notification":notification}),
        )
    }
}
