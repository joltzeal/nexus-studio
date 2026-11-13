use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::dto::uuid;
use super::service::AgentService;
use super::sql::read_u64;
use super::store::{AgentStore, strings};
use super::{AgentResult, canonical, conflict, invalid, now_ms, storage_error};

// The same predicate is used by preview and the deletion transaction.
const ELIGIBLE: &str =
    "b.updated_at<?1
     AND EXISTS(SELECT 1 FROM agent_jobs j WHERE j.batch_id=b.id)
     AND NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.batch_id=b.id AND
       (j.state NOT IN ('completed','cancelled','skipped','failed') OR j.actor_owned=1 OR j.updated_at>=?1))
     AND NOT EXISTS(SELECT 1 FROM agent_resources r JOIN agent_jobs j ON j.id=r.job_id WHERE j.batch_id=b.id)
     AND NOT EXISTS(SELECT 1 FROM agent_actions a JOIN agent_jobs j ON j.id=a.job_id
       WHERE j.batch_id=b.id AND a.state IN ('prepared','unknown'))
     AND NOT EXISTS(SELECT 1 FROM agent_publication_outbox o JOIN agent_jobs j ON j.id=o.job_id
       WHERE j.batch_id=b.id AND o.state!='synced')
     AND NOT EXISTS(SELECT 1 FROM agent_model_requests m WHERE m.batch_id=b.id AND m.receipt_json IS NULL AND m.deadline>?2)
     AND NOT EXISTS(SELECT 1 FROM agent_notification_outbox n WHERE n.batch_id=b.id AND n.state='pending')";

fn candidates(db: &Connection, before: &str) -> AgentResult<Vec<String>> {
    strings(
        db,
        &format!("SELECT b.id FROM agent_batches b WHERE {ELIGIBLE} ORDER BY b.id"),
        params![before, now_ms()],
    )
}

impl AgentStore {
    pub fn retention_preview(&self, days: u32) -> AgentResult<Value> {
        if !(1..=3650).contains(&days) {
            return Err(invalid("Retention days must be between 1 and 3650"));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let before = super::schema::timestamp(&tx, now_ms() - i64::from(days) * 86_400_000)?;
        let ids = candidates(&tx, &before)?;
        let old: u64 = tx
            .query_row(
                "SELECT COUNT(*) FROM agent_batches WHERE updated_at<?1",
                [&before],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        let bytes:u64=tx.query_row(
            "SELECT COALESCE(SUM(size),0) FROM agent_artifacts WHERE batch_id IN(SELECT value FROM json_each(?1))",
            [canonical(&json!(ids))],|r|read_u64(r, 0),
        ).map_err(storage_error)?;
        let token = Uuid::new_v4().to_string();
        tx.execute(
            "DELETE FROM agent_retention_previews WHERE created_at<?1",
            [now_ms() - 900_000],
        )
        .map_err(storage_error)?;
        tx.execute("INSERT INTO agent_retention_previews(token,before_at,batch_ids_json,created_at) VALUES(?1,?2,?3,?4)",
            params![token,before,canonical(&json!(ids)),now_ms()]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(
            json!({"before":before,"batches":ids.len(),"protected":old.saturating_sub(ids.len() as u64),
            "artifactBytes":bytes,"token":token}),
        )
    }

    pub fn retention_delete(&self, token: &str) -> AgentResult<u64> {
        uuid(token)?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let row:Option<(String,String,i64)>=tx.query_row(
            "SELECT before_at,batch_ids_json,created_at FROM agent_retention_previews WHERE token=?1",
            [token],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(storage_error)?;
        let Some((before, encoded, created)) = row else {
            return Err(conflict("Retention preview expired or was consumed"));
        };
        if now_ms() - created > 900_000 {
            return Err(conflict("Retention preview expired; request a new preview"));
        }
        let ids: Vec<String> = serde_json::from_str(&encoded).map_err(storage_error)?;
        let safe: std::collections::HashSet<_> = candidates(&tx, &before)?.into_iter().collect();
        if ids.iter().any(|id| !safe.contains(id)) {
            return Err(conflict(
                "Execution state changed since preview; no batches were deleted",
            ));
        }
        for id in &ids {
            let body: String = tx
                .query_row(
                    "SELECT canonical_body FROM agent_batches WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            tx.execute(
                "INSERT INTO agent_archived_batches(operation_id,batch_id,body_sha256)
                 SELECT operation_id,id,?2 FROM agent_batches WHERE id=?1",
                params![id, format!("{:x}", Sha256::digest(body.as_bytes()))],
            )
            .map_err(storage_error)?;
            tx.execute(
                "INSERT OR IGNORE INTO agent_archived_publications(operation_id,product_id,result_json)
                 SELECT a.operation_id,json_extract(a.result_json,'$.productId'),a.result_json
                 FROM agent_actions a JOIN agent_jobs j ON j.id=a.job_id
                 WHERE j.batch_id=?1 AND a.kind='listing' AND a.state='confirmed'",
                [id],
            ).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO agent_artifact_cleanup(batch_id,bytes)
                 SELECT ?1,COALESCE(SUM(size),0) FROM agent_artifacts WHERE batch_id=?1",
                [id],
            )
            .map_err(storage_error)?;
            for table in [
                "agent_pending_writes",
                "agent_checkpoint_retention",
                "agent_checkpoints",
                "agent_events",
                "agent_artifacts",
                "agent_product_assignments",
                "agent_publication_outbox",
                "agent_actions",
                "agent_model_requests",
                "agent_item_continuations",
                "agent_items",
                "agent_dispatch",
            ] {
                tx.execute(&format!("DELETE FROM {table} WHERE job_id IN(SELECT id FROM agent_jobs WHERE batch_id=?1)"),
                    [id]).map_err(storage_error)?;
            }
            // Events may be batch scoped without a job.
            tx.execute("DELETE FROM agent_events WHERE batch_id=?1", [id])
                .map_err(storage_error)?;
            tx.execute(
                "DELETE FROM agent_notification_outbox WHERE batch_id=?1",
                [id],
            )
            .map_err(storage_error)?;
            tx.execute("DELETE FROM agent_jobs WHERE batch_id=?1", [id])
                .map_err(storage_error)?;
            tx.execute("DELETE FROM agent_batches WHERE id=?1", [id])
                .map_err(storage_error)?;
        }
        tx.execute(
            "DELETE FROM agent_retention_previews WHERE token=?1",
            [token],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(ids.len() as u64)
    }

    pub fn artifact_cleanup(&self) -> AgentResult<Vec<(String, u64)>> {
        let db = self.open()?;
        let mut stmt = db
            .prepare(
                "SELECT batch_id,bytes FROM agent_artifact_cleanup ORDER BY batch_id LIMIT 100",
            )
            .map_err(storage_error)?;
        let result = stmt
            .query_map([], |r| Ok((r.get(0)?, read_u64(r, 1)?)))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        Ok(result)
    }
    pub fn artifact_cleaned(&self, id: &str) -> AgentResult<()> {
        self.open()?
            .execute("DELETE FROM agent_artifact_cleanup WHERE batch_id=?1", [id])
            .map_err(storage_error)?;
        Ok(())
    }
}

impl AgentService {
    pub fn retention_clean(&self, token: &str) -> AgentResult<Value> {
        let count = self.store.retention_delete(token)?;
        let bytes = self.clean_artifacts();
        Ok(json!({"deletedBatches":count,"freedBytes":bytes}))
    }

    pub(super) fn clean_artifacts(&self) -> u64 {
        let mut freed = 0u64;
        if let Ok(items) = self.store.artifact_cleanup() {
            for (id, _) in items {
                if let Ok(bytes) = self.artifacts.remove_retained_batch(&id) {
                    if self.store.artifact_cleaned(&id).is_ok() {
                        freed = freed.saturating_add(bytes);
                    }
                }
            }
        }
        freed
    }

    pub(super) fn auto_retention(&self) {
        self.clean_artifacts();
        let settings = self.host().and_then(|host| {
            host.call(
                "studio.sales-agent",
                crate::core::plugin_host::manifest::Capability::SalesAgent,
                "salesAgent.settings.get",
                json!({}),
                std::time::Duration::from_secs(10),
            )
            .map_err(super::host_error)
        });
        let Ok(settings) = settings else { return };
        // User policy is read fresh; disabled installations perform no history deletion.
        if settings["settings"]["retention"]["enabled"] != true {
            return;
        }
        let Some(days) = settings["settings"]["retention"]["days"]
            .as_u64()
            .and_then(|d| u32::try_from(d).ok())
        else {
            return;
        };
        if let Ok(preview) = self.store.retention_preview(days) {
            if let Some(token) = preview["token"].as_str() {
                let _ = self.retention_clean(token);
            }
        }
    }
}
