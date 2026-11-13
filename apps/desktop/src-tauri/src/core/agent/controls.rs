use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Value, json};

use super::dto::*;
use super::store::{AgentStore, event, pending_outbox, read_job, strings, uncertain_actions};
use super::{AgentResult, conflict, denied, storage_error};

pub(super) fn effective_action(db: &Connection, id: &str) -> AgentResult<String> {
    db.query_row(
        "SELECT CASE WHEN b.control!='run' THEN b.control ELSE d.action END
         FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id
         JOIN agent_dispatch d ON d.job_id=j.id WHERE j.id=?1",
        [id],
        |r| r.get(0),
    )
    .map_err(storage_error)
}

pub(super) fn require_writes(db: &Connection, id: &str) -> AgentResult<()> {
    let job = read_job(db, id)?;
    if effective_action(db, id)? != "run" || job.reconcile_only {
        return Err(denied("Job controls prevent new external writes"));
    }
    Ok(())
}

fn apply(db: &Connection, id: &str, action: ControlAction) -> AgentResult<()> {
    let job = read_job(db, id)?;
    let owned: bool = db
        .query_row(
            "SELECT actor_owned FROM agent_jobs WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if matches!(action, ControlAction::Resume | ControlAction::Reconcile) {
        if job.state == "blocked" {
            return Err(denied(
                "Confirmed account blocks cannot be resumed by job controls",
            ));
        }
        if owned && action == ControlAction::Resume {
            return Err(conflict(
                "The previous actor must finish isolation before resuming",
            ));
        }
    }
    let next = match action {
        ControlAction::Pause => "pause",
        ControlAction::Cancel => "cancel",
        ControlAction::Takeover => "takeover",
        ControlAction::Resume | ControlAction::Reconcile => "run",
    };
    db.execute("DELETE FROM agent_item_continuations WHERE job_id=?1", [id])
        .map_err(storage_error)?;
    db.execute(
        "UPDATE agent_dispatch SET action=?2,control_revision=control_revision+1,control_retry_at=0,
         takeover=CASE WHEN ?2='takeover' THEN 'stopping' WHEN ?2='run' THEN 'none' ELSE takeover END
         WHERE job_id=?1",
        params![id,next],
    ).map_err(storage_error)?;
    let uncertain = uncertain_actions(db, id)?;
    let mutable = !matches!(
        job.state.as_str(),
        "completed" | "blocked" | "cancelled" | "skipped"
    );
    if !owned && mutable {
        let state = match action {
            ControlAction::Resume
                if matches!(job.state.as_str(), "paused" | "review_required" | "failed")
                    && !uncertain =>
            {
                Some("queued")
            }
            ControlAction::Reconcile
                if matches!(job.state.as_str(), "review_required" | "result_unknown") =>
            {
                Some("queued")
            }
            ControlAction::Pause | ControlAction::Takeover if !uncertain => Some("paused"),
            ControlAction::Cancel if !uncertain && !pending_outbox(db, id)? => Some("cancelled"),
            _ => None,
        };
        if let Some(state) = state {
            db.execute(
                "UPDATE agent_jobs SET state=?2,phase=?2,revision=revision+1,
                 reconcile_only=CASE WHEN ?3 THEN ?4 ELSE reconcile_only END,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                params![
                    id,
                    state,
                    matches!(action, ControlAction::Reconcile | ControlAction::Resume),
                    uncertain
                ],
            )
            .map_err(storage_error)?;
        }
    }
    db.execute("UPDATE agent_items SET state='cancelled',reason='' WHERE job_id=?1 AND submitted=0
        AND state NOT IN ('published','skipped') AND EXISTS(SELECT 1 FROM agent_jobs WHERE id=?1 AND state='cancelled')",
        [id]).map_err(storage_error)?;
    // Even an idle job needs the service's provider isolation check before takeover is ready.
    event(db, &job.batch_id, Some(id), "job.control_requested", next)
}

impl AgentStore {
    pub fn stopped_control_jobs(&self) -> AgentResult<Vec<String>> {
        self.stopped_control_jobs_for(None, None)
    }

    pub(super) fn stopped_control_jobs_for(
        &self,
        batch_id: Option<&str>,
        job_id: Option<&str>,
    ) -> AgentResult<Vec<String>> {
        strings(&self.open()?,
            "SELECT j.id FROM agent_jobs j JOIN agent_dispatch d ON d.job_id=j.id
             JOIN agent_batches b ON b.id=j.batch_id
             WHERE (((d.action IN ('pause','cancel','takeover') OR b.control IN ('pause','cancel','takeover'))
               AND (j.actor_owned=1 OR EXISTS(SELECT 1 FROM agent_resources r WHERE r.job_id=j.id)
                    OR d.takeover IN ('stopping','blocked')))
               OR (j.state='review_required' AND j.reconcile_only=0 AND b.control='run' AND d.action='run'
                 AND EXISTS(SELECT 1 FROM agent_item_continuations c JOIN agent_items i
                   ON i.job_id=c.job_id AND i.product_id=c.product_id
                   WHERE c.job_id=j.id AND i.control_revision=c.revision AND i.control_revision>i.observed_revision
                     AND i.submitted=0 AND i.operation_id IS NULL)
                 AND NOT EXISTS(SELECT 1 FROM agent_actions WHERE job_id=j.id AND state IN ('prepared','unknown'))
                 AND NOT EXISTS(SELECT 1 FROM agent_publication_outbox WHERE job_id=j.id AND state!='synced')))
              AND d.control_retry_at<=?1
              AND (?2 IS NULL OR j.batch_id=?2) AND (?3 IS NULL OR j.id=?3)
              ORDER BY j.updated_at,j.id
              LIMIT CASE WHEN ?2 IS NULL AND ?3 IS NULL THEN 20 ELSE 100 END",
              params![super::now_ms(),batch_id,job_id])
    }

    pub fn job_action(&self, id: &str) -> AgentResult<String> {
        effective_action(&self.open()?, id)
    }

    pub fn control_jobs(&self, input: &ControlInput) -> AgentResult<()> {
        uuid(&input.batch_id)?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        super::store::require_batch(&tx, &input.batch_id)?;
        let next = match input.action {
            ControlAction::Pause => "pause",
            ControlAction::Cancel => "cancel",
            ControlAction::Takeover => "takeover",
            ControlAction::Resume | ControlAction::Reconcile => "run",
        };
        let ids = strings(
            &tx,
            "SELECT id FROM agent_jobs WHERE batch_id=?1",
            [&input.batch_id],
        )?;
        for id in ids {
            // Batch resume/reconcile keeps blocked and terminal jobs as durable facts.
            let job = read_job(&tx, &id)?;
            if matches!(
                input.action,
                ControlAction::Resume | ControlAction::Reconcile
            ) && (job.state == "blocked"
                || (input.action == ControlAction::Resume
                    && tx
                        .query_row(
                            "SELECT actor_owned FROM agent_jobs WHERE id=?1",
                            [&id],
                            |r| r.get::<_, bool>(0),
                        )
                        .map_err(storage_error)?))
            {
                continue;
            }
            apply(&tx, &id, input.action)?;
        }
        tx.execute(
            "UPDATE agent_batches SET control=?2,revision=revision+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![input.batch_id, next],
        )
        .map_err(storage_error)?;
        event(&tx, &input.batch_id, None, "batch.control_requested", next)?;
        tx.commit().map_err(storage_error)
    }

    pub fn control_job(&self, id: &str, action: ControlAction) -> AgentResult<()> {
        uuid(id)?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        apply(&tx, id, action)?;
        tx.commit().map_err(storage_error)
    }

    pub fn control_isolation_failed(&self, id: &str) -> AgentResult<()> {
        self.open()?
            .execute(
                "UPDATE agent_dispatch SET control_retry_at=?2,
            takeover=CASE WHEN action='takeover' THEN 'blocked' ELSE takeover END WHERE job_id=?1",
                params![id, super::now_ms() + 30_000],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn takeover_settled(&self, id: &str, released: bool) -> AgentResult<()> {
        if released {
            let db = self.open()?;
            let blocked:bool=db.query_row("SELECT actor_owned OR state IN ('blocked','result_unknown','running')
                OR EXISTS(SELECT 1 FROM agent_resources WHERE job_id=?1)
                OR EXISTS(SELECT 1 FROM agent_actions WHERE job_id=?1 AND state IN ('prepared','unknown'))
                FROM agent_jobs WHERE id=?1",[id],|r|r.get(0)).map_err(storage_error)?;
            if blocked {
                return Err(conflict(
                    "Takeover requires confirmed actor quiescence and released ownership",
                ));
            }
        }
        self.open()?
            .execute(
                "UPDATE agent_dispatch SET takeover=CASE WHEN action='takeover' THEN ?2 ELSE takeover END,
             control_retry_at=9223372036854775807 WHERE job_id=?1",
                params![id, if released { "ready" } else { "blocked" }],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn job_view(&self, id: &str) -> AgentResult<Value> {
        uuid(id)?;
        let db = self.open()?;
        job_view(&db, id)
    }
}

pub(super) fn job_view(db: &Connection, id: &str) -> AgentResult<Value> {
    let job = read_job(db, id)?;
    let (phase, message, created, updated): (String, String, String, String) = db
        .query_row(
            "SELECT phase,message,created_at,updated_at FROM agent_jobs WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(storage_error)?;
    let mut view = json!({"id":id,"windowId":job.snapshot.window_id,"windowName":job.snapshot.window_name,
        "accountId":job.snapshot.account_id()?,"account":job.snapshot.account["account"],
        "state":job.state,"phase":phase,"message":message,"productCount":job.snapshot.products.len(),
        "createdAt":created,"updatedAt":updated});
    super::scheduling::job_view(db, id, &mut view)?;
    Ok(view)
}
