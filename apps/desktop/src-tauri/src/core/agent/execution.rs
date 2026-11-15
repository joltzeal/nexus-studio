use rusqlite::{Connection, OptionalExtension, params};

use super::dto::{AgentMode, Preset};
use super::store::Job;
use super::{AgentResult, canonical, conflict, denied, storage_error};

pub(super) const MAX_PREPARATION_WORKERS: u32 = 3;

// Called inside the schema startup transaction. Persist execution ownership
// separately so preparation can never become a retained browser reservation.
pub(super) fn initialize(db: &Connection) -> AgentResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_execution(
           job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id),mode TEXT NOT NULL
             CHECK(mode IN ('content_preparation','browser')),
           worker_owned INTEGER NOT NULL DEFAULT 0,needs_reprepare INTEGER NOT NULL DEFAULT 0,
           binding_refresh INTEGER NOT NULL DEFAULT 0,reconcile_only INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS agent_content_packages(
           content_key TEXT PRIMARY KEY,package_json TEXT NOT NULL,
           receipt_id TEXT NOT NULL UNIQUE,completed_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS agent_content_receipts(
           job_id TEXT NOT NULL REFERENCES agent_jobs(id),product_id TEXT NOT NULL,
           content_key TEXT NOT NULL,control_revision INTEGER NOT NULL,state TEXT NOT NULL,package_json TEXT NOT NULL,
           receipt_id TEXT NOT NULL,completed_at TEXT NOT NULL,
           invalidation_reason TEXT,PRIMARY KEY(job_id,product_id,content_key,control_revision));
         CREATE TABLE IF NOT EXISTS agent_session_observations(
           window_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,binding_revision TEXT NOT NULL,
           status TEXT NOT NULL,observed_ms INTEGER NOT NULL,operation_id TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS agent_execution_migrations(version INTEGER PRIMARY KEY);
         INSERT OR IGNORE INTO agent_execution(job_id,mode) SELECT id,'browser' FROM agent_jobs;",
    )
    .map_err(storage_error)?;
    let migrated: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_execution_migrations WHERE version=2)",
            [],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    super::recovery::initialize(db, !migrated)?;
    if !migrated {
        // Preserve old action/outbox journals verbatim. Even an unconsumed intent
        // is reconcile-only: upgrading must never grant a fresh submission.
        db.execute_batch(
            "UPDATE agent_jobs SET reconcile_only=1 WHERE batch_id IN(
               SELECT id FROM agent_batches WHERE preset='post_listing')
               AND EXISTS(SELECT 1 FROM agent_actions a WHERE a.job_id=agent_jobs.id);
             UPDATE agent_execution SET reconcile_only=1 WHERE job_id IN(
               SELECT j.id FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id
               WHERE b.preset='post_listing' AND EXISTS(SELECT 1 FROM agent_actions a WHERE a.job_id=j.id));
             UPDATE agent_execution SET mode='content_preparation'
               WHERE job_id IN(SELECT j.id FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id
                 WHERE b.preset='post_listing'
                   AND j.state NOT IN ('completed','cancelled','skipped')
                   AND NOT EXISTS(SELECT 1 FROM agent_actions a WHERE a.job_id=j.id));
             UPDATE agent_jobs SET state='paused',phase='needs_reprepare',
                 message='Content preparation must be confirmed under the current rules',
                 revision=revision+1
               WHERE id IN(SELECT job_id FROM agent_execution WHERE mode='content_preparation');
             UPDATE agent_dispatch SET action='pause'
               WHERE job_id IN(SELECT job_id FROM agent_execution WHERE mode='content_preparation');
             UPDATE agent_actions SET state='unknown' WHERE state='prepared'
               AND job_id IN(SELECT id FROM agent_jobs WHERE reconcile_only=1);
             UPDATE agent_jobs SET scope_json=NULL,plugin_generation=NULL,lease_until=0;
             UPDATE agent_execution SET binding_refresh=1 WHERE job_id IN(
               SELECT id FROM agent_jobs WHERE json_extract(snapshot_json,'$.account.bindingRevision') IS NULL);
             DELETE FROM agent_pending_writes WHERE job_id IN(
               SELECT j.id FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id WHERE b.preset='post_listing');
             DELETE FROM agent_checkpoints WHERE job_id IN(
               SELECT j.id FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id WHERE b.preset='post_listing');
             DELETE FROM agent_checkpoint_retention WHERE job_id IN(
               SELECT j.id FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id WHERE b.preset='post_listing');
             INSERT INTO agent_execution_migrations(version) VALUES(2);",
        )
        .map_err(storage_error)?;
    }
    let normalized: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_execution_migrations WHERE version=3)",
            [],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if !normalized {
        let mut stmt = db
            .prepare("SELECT id,snapshot_json FROM agent_jobs")
            .map_err(storage_error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(stmt);
        for (id, encoded) in rows {
            let mut snapshot: serde_json::Value =
                serde_json::from_str(&encoded).map_err(storage_error)?;
            if let Some(products) = snapshot["products"].as_array_mut() {
                for product in products {
                    if product.get("platformFacts").is_none() {
                        product["platformFacts"] = serde_json::json!({"vinted":[]});
                    }
                }
            }
            if let Some(account) = snapshot["account"].as_object_mut() {
                account.remove("observation");
            }
            let normalized = canonical(&snapshot);
            if normalized != encoded {
                db.execute(
                    "UPDATE agent_jobs SET snapshot_json=?2 WHERE id=?1",
                    params![id, normalized],
                )
                .map_err(storage_error)?;
            }
        }
        db.execute(
            "INSERT INTO agent_execution_migrations(version) VALUES(3)",
            [],
        )
        .map_err(storage_error)?;
    }
    super::recovery::initialize_messages(db)?;
    Ok(())
}

pub(super) fn owns_browser(db: &Connection, id: &str) -> AgentResult<bool> {
    db.query_row(
        "SELECT actor_owned OR EXISTS(SELECT 1 FROM agent_resources WHERE job_id=?1)
         FROM agent_jobs WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .map_err(storage_error)
}

pub(super) fn clear_checkpoints(db: &Connection, id: &str) -> AgentResult<()> {
    for table in [
        "agent_pending_writes",
        "agent_checkpoints",
        "agent_checkpoint_retention",
    ] {
        db.execute(&format!("DELETE FROM {table} WHERE job_id=?1"), [id])
            .map_err(storage_error)?;
    }
    db.execute(
        "UPDATE agent_dispatch SET progress_json=NULL,retry_json=NULL,next_attempt=0,
        retry_attempt=0,retry_code='' WHERE job_id=?1",
        [id],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(super) fn resume_preparation(db: &Connection, id: &str) -> AgentResult<()> {
    let job = super::store::read_job(db, id)?;
    let (needs, worker, recovery_only): (bool, bool, bool) = db
        .query_row(
            "SELECT needs_reprepare,worker_owned,reconcile_only FROM agent_execution WHERE job_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(storage_error)?;
    if !needs
        || worker
        || recovery_only
        || job.preset != Preset::PostListing
        || owns_browser(db, id)?
        || matches!(
            job.state.as_str(),
            "blocked" | "completed" | "cancelled" | "skipped" | "result_unknown"
        )
        || super::store::uncertain_actions(db, id)?
        || super::store::pending_outbox(db, id)?
    {
        return Ok(());
    }
    db.execute(
        "UPDATE agent_execution SET mode='content_preparation',needs_reprepare=0 WHERE job_id=?1",
        [id],
    )
    .map_err(storage_error)?;
    clear_checkpoints(db, id)?;
    db.execute(
        "UPDATE agent_jobs SET state=CASE WHEN ?2='run' THEN 'queued' ELSE state END,
         phase='needs_reprepare',scope_json=NULL,reconcile_only=0 WHERE id=?1",
        params![id, super::controls::effective_action(db, id)?],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(super) fn require_browser(job: &Job) -> AgentResult<()> {
    if job.mode != AgentMode::Browser {
        return Err(denied(
            "Content preparation has no browser or external action capability",
        ));
    }
    Ok(())
}

pub(super) fn admit_preparation(db: &Connection, job: &Job) -> AgentResult<bool> {
    if job.preset != Preset::PostListing
        || job.reconcile_only
        || owns_browser(db, &job.id)?
        || super::store::uncertain_actions(db, &job.id)?
        || super::store::pending_outbox(db, &job.id)?
    {
        return Err(conflict(
            "Preparation cannot own browser resources or submission recovery",
        ));
    }
    let (action, next): (String, i64) = db
        .query_row(
            "SELECT action,next_attempt FROM agent_dispatch WHERE job_id=?1",
            [&job.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if action != "run" || next > super::now_ms() {
        return Ok(false);
    }
    let (active, batch): (u32, u32) = db
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(j.batch_id=?1),0) FROM agent_execution e
             JOIN agent_jobs j ON j.id=e.job_id WHERE e.worker_owned=1",
            [&job.batch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    let concurrency: u32 = db
        .query_row(
            "SELECT concurrency FROM agent_batches WHERE id=?1",
            [&job.batch_id],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    Ok(active < MAX_PREPARATION_WORKERS && batch < concurrency.min(MAX_PREPARATION_WORKERS))
}

pub(super) fn login_required(db: &Connection, job: &Job) -> AgentResult<bool> {
    let status: Option<String> = db
        .query_row(
            "SELECT status FROM agent_session_observations WHERE window_id=?1 AND account_id=?2
         AND binding_revision=?3",
            params![
                job.snapshot.window_id,
                job.snapshot.account_id()?,
                job.snapshot.account["bindingRevision"]
                    .as_str()
                    .unwrap_or("")
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    Ok(status.as_deref() == Some("logged_out"))
}

impl super::store::AgentStore {
    pub(super) fn form_wait_until(&self, id: &str) -> AgentResult<i64> {
        self.open()?
            .query_row(
                "SELECT CASE WHEN retry_code='WAITING_FOR_FORM' THEN next_attempt ELSE 0 END
            FROM agent_dispatch WHERE job_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(storage_error)
    }
    pub(super) fn job_needs_login(&self, id: &str) -> AgentResult<bool> {
        let db = self.open()?;
        login_required(&db, &super::store::read_job(&db, id)?)
    }
    pub(super) fn requires_binding_refresh(&self, id: &str) -> AgentResult<bool> {
        self.open()?
            .query_row(
                "SELECT binding_refresh FROM agent_execution WHERE job_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(storage_error)
    }
    pub(super) fn refresh_migrated_binding(
        &self,
        id: &str,
        account: &serde_json::Value,
        origin: &str,
    ) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let job = super::store::read_job(&tx, id)?;
        let refresh: bool = tx
            .query_row(
                "SELECT binding_refresh FROM agent_execution WHERE job_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if refresh {
            let mut account = account.clone();
            if account["homepageUrl"] == "" && account.get("platformOrigin").is_none() {
                account["platformOrigin"] = serde_json::json!(origin);
            }
            let (account, checked_origin) = super::service::validate_account(&account)?;
            if job.snapshot.account["accountId"] != account["accountId"]
                || job.snapshot.account["platformUserId"] != account["platformUserId"]
                || job.snapshot.platform_origin != origin
                || checked_origin != origin
            {
                return Err(denied(
                    "Migrated task must retain its independently confirmed account and market",
                ));
            }
            let mut snapshot = serde_json::to_value(&job.snapshot).map_err(storage_error)?;
            snapshot["account"] = account;
            tx.execute(
                "UPDATE agent_jobs SET snapshot_json=?2 WHERE id=?1",
                params![id, super::canonical(&snapshot)],
            )
            .map_err(storage_error)?;
            tx.execute(
                "UPDATE agent_execution SET binding_refresh=0 WHERE job_id=?1",
                [id],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }
    pub(super) fn has_browser_ownership(&self, id: &str) -> AgentResult<bool> {
        owns_browser(&self.open()?, id)
    }
    pub(super) fn needs_reprepare(&self, id: &str) -> AgentResult<bool> {
        self.open()?
            .query_row(
                "SELECT needs_reprepare FROM agent_execution WHERE job_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(storage_error)
    }
    pub(super) fn should_reprepare(&self, id: &str) -> AgentResult<bool> {
        // Recovery keeps the browser actor until its journal and publication
        // outbox settle. The raw flag still fences every new external write.
        self.open()?
            .query_row(
                "SELECT e.needs_reprepare AND NOT j.reconcile_only AND NOT e.reconcile_only
                 AND NOT EXISTS(SELECT 1 FROM agent_actions a WHERE a.job_id=j.id
                   AND a.state IN ('prepared','unknown'))
                 AND NOT EXISTS(SELECT 1 FROM agent_publication_outbox o
                   WHERE o.job_id=j.id AND o.state!='synced')
                 FROM agent_execution e JOIN agent_jobs j ON j.id=e.job_id WHERE j.id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(storage_error)
    }
    pub(super) fn product_approved(
        &self,
        id: &str,
        product: &serde_json::Value,
    ) -> AgentResult<bool> {
        let db = self.open()?;
        let job = super::store::read_job(&db, id)?;
        let product = product
            .as_str()
            .ok_or_else(|| super::invalid("Invalid product ID"))?;
        // A missing/negative receipt is ineligible; storage failures still propagate.
        let (source, revision, _) = super::content::effective_product(&db, &job, product)?;
        let ctx = super::content::context(
            &source,
            &job.settings,
            &job.snapshot.platform_origin,
            &job.instruction,
        )?;
        let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM agent_content_receipts WHERE job_id=?1
            AND product_id=?2 AND content_key=?3 AND control_revision=?4 AND state='approved' AND invalidation_reason IS NULL)",
            params![id,product,ctx["contentKey"].as_str(),super::sql::to_sql_i64(revision)?],|r|r.get(0)).map_err(storage_error)?;
        if exists {
            super::content::approved(&db, &job, product)?;
        }
        Ok(exists)
    }
}
