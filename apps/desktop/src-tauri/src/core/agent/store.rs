use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::dto::*;
use super::sql::{read_u64, to_sql_i64};
use super::{AgentResult, canonical, conflict, denied, invalid, now_ms, storage_error};
use crate::core::database::open_database;

const RETAINED_CHECKPOINTS: i64 = 8;

#[derive(Clone)]
pub struct AgentStore {
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub batch_id: String,
    pub preset: Preset,
    pub instruction: String,
    pub settings: Value,
    pub snapshot: JobSnapshot,
    pub state: String,
    pub scope: Option<AgentScope>,
    pub generation: Option<String>,
    pub reconcile_only: bool,
    pub steps: u32,
}

#[derive(Debug, Clone)]
pub struct OutboxItem {
    pub operation_id: String,
    pub payload: Value,
}

impl AgentStore {
    pub fn new(path: PathBuf) -> AgentResult<Self> {
        let store = Self { path };
        let db = store.open()?;
        db.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS agent_batches(
               id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,canonical_body TEXT NOT NULL,
               preset TEXT NOT NULL,instruction TEXT NOT NULL,concurrency INTEGER NOT NULL CHECK(concurrency BETWEEN 1 AND 10),
               settings_json TEXT NOT NULL,control TEXT NOT NULL DEFAULT 'run',
               revision INTEGER NOT NULL DEFAULT 1,
               created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
             CREATE TABLE IF NOT EXISTS agent_jobs(
               id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES agent_batches(id),snapshot_json TEXT NOT NULL,
               state TEXT NOT NULL,phase TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',
               scope_json TEXT,plugin_generation TEXT,fence INTEGER NOT NULL DEFAULT 0,
               lease_until INTEGER NOT NULL DEFAULT 0,reconcile_only INTEGER NOT NULL DEFAULT 0,
               actor_owned INTEGER NOT NULL DEFAULT 0,steps INTEGER NOT NULL DEFAULT 0,
               revision INTEGER NOT NULL DEFAULT 1,
               created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
             CREATE INDEX IF NOT EXISTS agent_jobs_queue ON agent_jobs(state,batch_id);
             CREATE TABLE IF NOT EXISTS agent_fence_sequence(
               id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
             INSERT OR IGNORE INTO agent_fence_sequence(id,value) VALUES(1,0);
             CREATE TABLE IF NOT EXISTS agent_resources(
               resource_key TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES agent_jobs(id),
               lease_id TEXT NOT NULL,fence INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS agent_product_assignments(
               batch_id TEXT NOT NULL REFERENCES agent_batches(id),product_id TEXT NOT NULL,
               job_id TEXT NOT NULL REFERENCES agent_jobs(id),PRIMARY KEY(batch_id,product_id));
             CREATE INDEX IF NOT EXISTS agent_product_assignments_product ON agent_product_assignments(product_id,job_id);
             CREATE TABLE IF NOT EXISTS agent_events(
               sequence INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL REFERENCES agent_batches(id),
               job_id TEXT REFERENCES agent_jobs(id),kind TEXT NOT NULL,message TEXT NOT NULL,
               job_revision INTEGER,
               created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
             CREATE INDEX IF NOT EXISTS agent_events_batch ON agent_events(batch_id,sequence);
             CREATE TABLE IF NOT EXISTS agent_artifacts(
               id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES agent_batches(id),
               job_id TEXT NOT NULL REFERENCES agent_jobs(id),mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS agent_checkpoints(
               sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES agent_jobs(id),
               namespace TEXT NOT NULL,checkpoint_id TEXT NOT NULL,tuple_json TEXT NOT NULL,new_versions_json TEXT NOT NULL,
               UNIQUE(job_id,namespace,checkpoint_id));
             CREATE TABLE IF NOT EXISTS agent_pending_writes(
               job_id TEXT NOT NULL,namespace TEXT NOT NULL,checkpoint_id TEXT NOT NULL,
               task_id TEXT NOT NULL,write_index INTEGER NOT NULL,channel TEXT NOT NULL,value_json TEXT NOT NULL,
               task_path TEXT NOT NULL DEFAULT '',
               PRIMARY KEY(job_id,namespace,checkpoint_id,task_id,write_index),
               FOREIGN KEY(job_id) REFERENCES agent_jobs(id));
              CREATE TABLE IF NOT EXISTS agent_checkpoint_retention(
                job_id TEXT NOT NULL REFERENCES agent_jobs(id),namespace TEXT NOT NULL,
                compacted_before TEXT NOT NULL,PRIMARY KEY(job_id,namespace));
             CREATE TABLE IF NOT EXISTS agent_actions(
               operation_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES agent_jobs(id),
               kind TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,
               submitted INTEGER NOT NULL DEFAULT 0,result_json TEXT,
               created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
             CREATE INDEX IF NOT EXISTS agent_actions_job ON agent_actions(job_id,state);
             CREATE INDEX IF NOT EXISTS agent_confirmed_product ON agent_actions(json_extract(result_json,'$.productId'))
               WHERE kind='listing' AND state='confirmed';
             CREATE TABLE IF NOT EXISTS agent_publication_outbox(
               operation_id TEXT PRIMARY KEY REFERENCES agent_actions(operation_id),
               job_id TEXT NOT NULL REFERENCES agent_jobs(id),payload_json TEXT NOT NULL,state TEXT NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
               last_error TEXT NOT NULL DEFAULT '');
             COMMIT;",
        ).map_err(storage_error)?;
        super::schema::initialize(&db)?;
        Ok(store)
    }

    pub(super) fn open(&self) -> AgentResult<Connection> {
        open_database(&self.path).map_err(storage_error)
    }

    pub fn find_operation(&self, operation_id: &str, body: &str) -> AgentResult<Option<String>> {
        let row: Option<(String, String)> = self
            .open()?
            .query_row(
                "SELECT id,canonical_body FROM agent_batches WHERE operation_id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        match row {
            Some((id, stored)) if stored == body => Ok(Some(id)),
            Some(_) => Err(conflict(
                "Operation ID already belongs to a different batch body",
            )),
            None => {
                require_new_operation(&self.open()?, operation_id, body)?;
                Ok(None)
            }
        }
    }

    pub fn create(
        &self,
        batch_id: &str,
        input: &BatchCreateInput,
        snapshots: &[(String, JobSnapshot)],
        settings: &Value,
    ) -> AgentResult<String> {
        uuid(batch_id)?;
        validate_create(input)?;
        let body = canonical(&serde_json::to_value(input).map_err(storage_error)?);
        if snapshots.len() != input.assignments.len() {
            return Err(invalid("Batch snapshots do not cover its assignments"));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT id,canonical_body FROM agent_batches WHERE operation_id=?1",
                [&input.operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((id, stored)) = existing {
            if stored != body {
                return Err(conflict("Operation ID has different batch content"));
            }
            return Ok(id);
        }
        require_new_operation(&tx, &input.operation_id, &body)?;
        for product_id in input
            .assignments
            .iter()
            .flat_map(|assignment| &assignment.product_ids)
        {
            let assigned: bool = tx.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM agent_product_assignments a JOIN agent_jobs j ON j.id=a.job_id
                    WHERE a.product_id=?1 AND
                      (j.actor_owned=1 OR j.state NOT IN ('completed','blocked','failed','cancelled','skipped')
                       OR EXISTS(SELECT 1 FROM agent_resources retained WHERE retained.job_id=j.id)
                       OR EXISTS(SELECT 1 FROM agent_actions uncertain WHERE uncertain.job_id=j.id
                                 AND uncertain.state IN ('prepared','unknown'))))
                 OR EXISTS(SELECT 1 FROM agent_actions confirmed WHERE confirmed.kind='listing'
                    AND confirmed.state='confirmed' AND json_extract(confirmed.result_json,'$.productId')=?1)
                 OR EXISTS(SELECT 1 FROM agent_archived_publications WHERE product_id=?1)",
                [product_id], |row| row.get(0),
            ).map_err(storage_error)?;
            if assigned {
                return Err(conflict(
                    "Product already has an in-flight assignment or a confirmed local publication",
                ));
            }
        }
        tx.execute(
            "INSERT INTO agent_batches(id,operation_id,canonical_body,preset,instruction,concurrency,settings_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![batch_id,input.operation_id,body,preset_name(input.preset),input.instruction,
                input.concurrency,canonical(settings)],
        ).map_err(storage_error)?;
        let mut accounts = std::collections::HashSet::new();
        let mut identities = std::collections::HashSet::new();
        for ((job_id, snapshot), assignment) in snapshots.iter().zip(&input.assignments) {
            uuid(job_id)?;
            let resources = snapshot.resources()?;
            if snapshot.window_id != assignment.window_id
                || snapshot.products.len() != assignment.product_ids.len()
                || snapshot
                    .products
                    .iter()
                    .zip(&assignment.product_ids)
                    .any(|(product, id)| product["id"].as_str() != Some(id.as_str()))
                || !accounts.insert(resources[1].clone())
                || !identities.insert(resources[2].clone())
            {
                return Err(conflict(
                    "Each active batch job requires a distinct bound account",
                ));
            }
            tx.execute(
                "INSERT INTO agent_jobs(id,batch_id,snapshot_json,state,phase) VALUES(?1,?2,?3,'queued','queued')",
                params![job_id,batch_id,canonical(&serde_json::to_value(snapshot).map_err(storage_error)?)],
            ).map_err(storage_error)?;
            tx.execute("INSERT INTO agent_dispatch(job_id) VALUES(?1)", [job_id])
                .map_err(storage_error)?;
            for product in &snapshot.products {
                let id = product["id"]
                    .as_str()
                    .ok_or_else(|| invalid("Invalid product snapshot"))?;
                tx.execute(
                    "INSERT INTO agent_product_assignments(batch_id,product_id,job_id) VALUES(?1,?2,?3)",
                    params![batch_id,id,job_id],
                ).map_err(|_| conflict("Product is already assigned in this batch"))?;
                tx.execute(
                    "INSERT INTO agent_items(job_id,product_id,ordinal,title,description)
                     VALUES(?1,?2,?3,?4,?5)",
                    params![
                        job_id,
                        id,
                        i64::try_from(
                            snapshot
                                .products
                                .iter()
                                .position(|p| p["id"] == product["id"])
                                .unwrap_or(0)
                        )
                        .map_err(storage_error)?,
                        product["title"].as_str(),
                        product["description"].as_str()
                    ],
                )
                .map_err(storage_error)?;
                let images = product["images"]
                    .as_array()
                    .ok_or_else(|| invalid("Invalid image snapshot"))?;
                for image in images {
                    tx.execute(
                        "INSERT INTO agent_artifacts(id,batch_id,job_id,mime,size,sha256) VALUES(?1,?2,?3,?4,?5,?6)",
                        params![image["artifactId"].as_str(),batch_id,job_id,image["mime"].as_str(),
                            image["bytes"].as_u64().map(to_sql_i64).transpose()?,image["sha256"].as_str()],
                    ).map_err(storage_error)?;
                }
            }
        }
        event(
            &tx,
            batch_id,
            None,
            "batch.created",
            "Batch intent and immutable snapshots saved",
        )?;
        tx.commit().map_err(storage_error)?;
        Ok(batch_id.to_owned())
    }

    pub fn list(&self, input: &PageInput) -> AgentResult<Value> {
        validate_page(input.page, input.page_size)?;
        let db = self.open()?;
        let total: u64 = db
            .query_row("SELECT COUNT(*) FROM agent_batches", [], |r| read_u64(r, 0))
            .map_err(storage_error)?;
        let ids = strings(
            &db,
            "SELECT id FROM agent_batches ORDER BY created_at DESC,id DESC LIMIT ?1 OFFSET ?2",
            params![
                input.page_size,
                to_sql_i64(u64::from(input.page - 1) * u64::from(input.page_size))?
            ],
        )?;
        let items = ids
            .iter()
            .map(|id| batch_view(&db, id))
            .collect::<AgentResult<Vec<_>>>()?;
        Ok(json!({"items":items,"total":total,"page":input.page,"pageSize":input.page_size}))
    }

    pub fn batch_view(&self, id: &str) -> AgentResult<Value> {
        batch_view(&self.open()?, id)
    }

    pub fn get(&self, input: &BatchGetInput) -> AgentResult<Value> {
        uuid(&input.batch_id)?;
        validate_page(input.page, input.page_size)?;
        let db = self.open()?;
        let batch = batch_view(&db, &input.batch_id)?;
        let total: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_jobs WHERE batch_id=?1",
                [&input.batch_id],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        let mut statement = db
            .prepare(
                "SELECT id,snapshot_json,state,phase,message,created_at,updated_at
             FROM agent_jobs WHERE batch_id=?1 ORDER BY created_at,id LIMIT ?2 OFFSET ?3",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(
                params![
                    input.batch_id,
                    input.page_size,
                    to_sql_i64(u64::from(input.page - 1) * u64::from(input.page_size))?
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let mut jobs = Vec::with_capacity(rows.len());
        for (id, _, _, _, _, _, _) in rows {
            jobs.push(super::controls::job_view(&db, &id)?);
        }
        Ok(
            json!({"batch":batch,"jobs":jobs,"total":total,"page":input.page,"pageSize":input.page_size}),
        )
    }

    pub fn events(&self, input: &EventsInput) -> AgentResult<Value> {
        uuid(&input.batch_id)?;
        if input.limit == 0 || input.limit > 100 || input.cursor > 9_007_199_254_740_991 {
            return Err(invalid("Invalid event pagination"));
        }
        let db = self.open()?;
        require_batch(&db, &input.batch_id)?;
        let mut query = db
            .prepare(
                "SELECT sequence,batch_id,job_id,kind,message,created_at FROM agent_events
             WHERE batch_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3",
            )
            .map_err(storage_error)?;
        let mut items = query
            .query_map(
                params![input.batch_id, to_sql_i64(input.cursor)?, input.limit + 1],
                |row| {
                    Ok(
                        json!({"sequence":read_u64(row, 0)?,"batchId":row.get::<_,String>(1)?,
                "jobId":row.get::<_,Option<String>>(2)?,"kind":row.get::<_,String>(3)?,
                "message":row.get::<_,String>(4)?,"createdAt":row.get::<_,String>(5)?}),
                    )
                },
            )
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let has_more = items.len() > input.limit as usize;
        items.truncate(input.limit as usize);
        let cursor = items
            .last()
            .and_then(|value| value["sequence"].as_u64())
            .unwrap_or(input.cursor);
        Ok(json!({"items":items,"cursor":cursor,"hasMore":has_more}))
    }

    pub fn job(&self, id: &str) -> AgentResult<Job> {
        read_job(&self.open()?, id)
    }

    /// A restart revokes every old scope but never declares its browser stopped.
    pub fn recover(&self) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let ids = strings(
            &tx,
            "SELECT id FROM agent_jobs WHERE state='running' OR actor_owned=1",
            [],
        )?;
        for id in ids {
            tx.execute(
                "UPDATE agent_actions SET state='unknown' WHERE job_id=?1 AND state='prepared'",
                [&id],
            )
            .map_err(storage_error)?;
            let job = read_job(&tx, &id)?;
            let uncertain = uncertain_actions(&tx, &id)?;
            tx.execute(
                "UPDATE agent_jobs SET state=?2,phase='restart_reconcile',plugin_generation=NULL,
                 lease_until=0,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id=?1",
                params![
                    id,
                    if uncertain {
                        "result_unknown"
                    } else {
                        "review_required"
                    }
                ],
            )
            .map_err(storage_error)?;
            event(
                &tx,
                &job.batch_id,
                Some(&id),
                "job.interrupted",
                "Application stopped; reconcile the retained browser ownership",
            )?;
        }
        tx.commit().map_err(storage_error)
    }

    pub fn retained_window_owners(&self) -> AgentResult<Vec<(String, String)>> {
        let db = self.open()?;
        let ids = strings(
            &db,
            "SELECT id FROM agent_jobs WHERE actor_owned=1
             OR EXISTS(SELECT 1 FROM agent_resources r WHERE r.job_id=agent_jobs.id)
             ORDER BY id",
            [],
        )?;
        let mut owners = Vec::with_capacity(ids.len());
        let mut windows = std::collections::HashSet::new();
        for id in ids {
            let job = read_job(&db, &id)?;
            uuid(&job.snapshot.window_id)?;
            if !windows.insert(job.snapshot.window_id.clone()) {
                return Err(conflict("Retained jobs have conflicting window ownership"));
            }
            owners.push((job.snapshot.window_id, id));
        }
        Ok(owners)
    }

    pub fn queued(&self) -> AgentResult<Vec<String>> {
        self.queued_page(&mut None)
    }

    pub(super) fn queued_page(
        &self,
        after: &mut Option<(String, String)>,
    ) -> AgentResult<Vec<String>> {
        let db = self.open()?;
        let mut statement = db.prepare(
            "SELECT j.id,j.updated_at FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id
             JOIN agent_dispatch d ON d.job_id=j.id
             WHERE j.state='queued' AND j.actor_owned=0 AND b.control='run' AND d.action='run'
               AND d.next_attempt<=?1
               AND NOT EXISTS(SELECT 1 FROM agent_cooldowns c WHERE c.until_ms>?1 AND c.resource_key IN(
                 'account:'||json_extract(j.snapshot_json,'$.account.accountId'),
                 'vinted-identity:'||ltrim(json_extract(j.snapshot_json,'$.account.platformUserId'),'0')))
               AND (?2 IS NULL OR (j.updated_at,j.id)>(?2,?3))
             ORDER BY j.updated_at,j.id LIMIT 100",
        ).map_err(storage_error)?;
        let mut query =
            |position: Option<&(String, String)>| -> AgentResult<Vec<(String, String)>> {
                statement
                    .query_map(
                        params![
                            now_ms(),
                            position.map(|p| p.0.as_str()),
                            position.map(|p| p.1.as_str())
                        ],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(storage_error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(storage_error)
            };
        let mut rows = query(after.as_ref())?;
        if rows.is_empty() && after.is_some() {
            rows = query(None)?;
        }
        // Advance even when provider/resource admission later defers every row.
        // A bounded pass must not retry the same first hundred jobs forever.
        *after = rows
            .last()
            .map(|(id, updated)| (updated.clone(), id.clone()));
        Ok(rows.into_iter().map(|(id, _)| id).collect())
    }

    pub fn claim(&self, id: &str, generation: &str) -> AgentResult<Option<Job>> {
        self.claim_with_capacity(id, generation, None)
    }

    pub fn claim_with_capacity(
        &self,
        id: &str,
        generation: &str,
        capacity: Option<&crate::core::browser::provider::ProviderCapacity>,
    ) -> AgentResult<Option<Job>> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let job = read_job(&tx, id)?;
        let (control, concurrency): (String, u32) = tx
            .query_row(
                "SELECT control,concurrency FROM agent_batches WHERE id=?1",
                [&job.batch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(storage_error)?;
        let running: u32 = tx
            .query_row(
                "SELECT COUNT(*) FROM agent_jobs WHERE batch_id=?1 AND state='running'",
                [&job.batch_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let owned: bool = tx
            .query_row(
                "SELECT actor_owned FROM agent_jobs WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let global_limit: u32 = tx
            .query_row(
                "SELECT COALESCE(MIN(concurrency),3) FROM agent_batches b WHERE
             EXISTS(SELECT 1 FROM agent_jobs j WHERE j.batch_id=b.id AND
                 (j.state='running' OR j.actor_owned=1 OR (b.control='run' AND j.state='queued')))",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let global_active: u32 = tx
            .query_row(
                "SELECT COUNT(*) FROM agent_jobs WHERE state='running' OR actor_owned=1",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if job.state != "queued"
            || owned
            || control != "run"
            || running >= concurrency
            || global_active >= global_limit.min(10)
            || !super::scheduling::admit(&tx, &job, capacity)?
        {
            return Ok(None);
        }
        let resources = job.snapshot.resources()?;
        for resource in &resources {
            let holder: Option<String> = tx
                .query_row(
                    "SELECT job_id FROM agent_resources WHERE resource_key=?1",
                    [resource],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage_error)?;
            if holder.is_some_and(|holder| holder != id) {
                return Ok(None);
            }
        }
        let fence: u64 = tx
            .query_row(
                "SELECT value+1 FROM agent_fence_sequence WHERE id=1",
                [],
                |row| read_u64(row, 0),
            )
            .map_err(storage_error)?;
        let scope = AgentScope {
            batch_id: job.batch_id.clone(),
            job_id: id.to_owned(),
            window_id: job.snapshot.window_id.clone(),
            account_id: job.snapshot.account_id()?.to_owned(),
            lease_id: Uuid::new_v4().to_string(),
            fence,
        };
        validate_scope(&scope)?;
        tx.execute(
            "UPDATE agent_fence_sequence SET value=?1 WHERE id=1",
            [to_sql_i64(fence)?],
        )
        .map_err(storage_error)?;
        for resource in &resources {
            tx.execute(
                "INSERT INTO agent_resources(resource_key,job_id,lease_id,fence) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(resource_key) DO UPDATE SET lease_id=excluded.lease_id,fence=excluded.fence
                 WHERE agent_resources.job_id=excluded.job_id",
                params![resource,id,scope.lease_id,to_sql_i64(fence)?],
            ).map_err(storage_error)?;
        }
        tx.execute(
            "UPDATE agent_jobs SET state='running',phase='starting',scope_json=?2,plugin_generation=?3,
             fence=?4,lease_until=?5,actor_owned=1,revision=revision+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![id,canonical(&serde_json::to_value(&scope).map_err(storage_error)?),
                generation,to_sql_i64(fence)?,now_ms()+LEASE_MS],
        ).map_err(storage_error)?;
        tx.execute(
            "UPDATE agent_items SET observed_revision=0 WHERE job_id=?1",
            [id],
        )
        .map_err(storage_error)?;
        event(
            &tx,
            &job.batch_id,
            Some(id),
            "job.claimed",
            "Exclusive browser resources claimed",
        )?;
        let claimed = read_job(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(Some(claimed))
    }

    pub fn validate_lease(&self, scope: &AgentScope, generation: &str) -> AgentResult<Job> {
        let db = self.open()?;
        validate_lease(&db, scope, generation)?;
        read_job(&db, &scope.job_id)
    }

    pub fn heartbeat(&self, scope: &AgentScope, generation: &str) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        tx.execute(
            "UPDATE agent_jobs SET lease_until=?2 WHERE id=?1",
            params![scope.job_id, now_ms() + LEASE_MS],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)
    }

    pub fn batch_control(&self, batch_id: &str) -> AgentResult<String> {
        self.open()?
            .query_row(
                "SELECT control FROM agent_batches WHERE id=?1",
                [batch_id],
                |r| r.get(0),
            )
            .map_err(storage_error)
    }

    pub fn control(&self, input: &ControlInput) -> AgentResult<()> {
        self.control_jobs(input)
    }

    pub fn begin_reconcile(&self, batch_id: &str) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        require_batch(&tx, batch_id)?;
        tx.execute(
            "UPDATE agent_batches SET control='pause' WHERE id=?1",
            [batch_id],
        )
        .map_err(storage_error)?;
        event(
            &tx,
            batch_id,
            None,
            "batch.reconcile_preparing",
            "Dispatch suspended while retained actors are isolated",
        )?;
        tx.commit().map_err(storage_error)
    }

    pub fn mark_step(
        &self,
        scope: &AgentScope,
        generation: &str,
        output: &StepOutput,
    ) -> AgentResult<()> {
        text(&output.phase, 1, 100)?;
        if let Some(message) = &output.message {
            text(message, 0, 1000)?;
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let mut state = output.state.as_str();
        if uncertain_actions(&tx, &scope.job_id)?
            && !matches!(output.state, StepState::Continue | StepState::ResultUnknown)
        {
            state = "result_unknown";
        } else if pending_outbox(&tx, &scope.job_id)?
            && matches!(output.state, StepState::Completed | StepState::SyncPending)
        {
            state = "sync_pending";
        } else if output.state == StepState::SyncPending {
            state = "queued";
        }
        let fatal_sync:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_publication_outbox WHERE job_id=?1 AND state='review_required')",
            [&scope.job_id],|row|row.get(0)).map_err(storage_error)?;
        if fatal_sync && !uncertain_actions(&tx, &scope.job_id)? {
            state = "review_required";
        }
        let job = read_job(&tx, &scope.job_id)?;
        super::items::record_updates(&tx, &job, output)?;
        let retry = super::scheduling::record_step(&tx, &job, output)?;
        if retry {
            state = if uncertain_actions(&tx, &job.id)? {
                "result_unknown"
            } else {
                "queued"
            };
        }
        if job.reconcile_only && state == "running" && !uncertain_actions(&tx, &scope.job_id)? {
            state = "paused";
        }
        tx.execute(
            "UPDATE agent_jobs SET state=?2,phase=?3,message=?4,steps=steps+1,revision=revision+1,
             reconcile_only=CASE WHEN ?2='paused' THEN 0 ELSE reconcile_only END,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![
                scope.job_id,
                state,
                output.phase,
                output.message.clone().unwrap_or_default()
            ],
        )
        .map_err(storage_error)?;
        if state == "blocked" {
            tx.execute("UPDATE agent_items SET state='failed',reason='账号已确认受限，后续操作已停止'
                WHERE job_id=?1 AND submitted=0 AND state NOT IN ('published','skipped','cancelled')",
                [&scope.job_id]).map_err(storage_error)?;
        }
        event(&tx, &scope.batch_id, Some(&scope.job_id), "job.step", state)?;
        tx.commit().map_err(storage_error)
    }

    pub fn interrupt(&self, id: &str, phase: &str) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let job = read_job(&tx, id)?;
        tx.execute(
            "UPDATE agent_actions SET state='unknown' WHERE job_id=?1 AND state='prepared'",
            [id],
        )
        .map_err(storage_error)?;
        let state = if uncertain_actions(&tx, id)? {
            "result_unknown"
        } else {
            "review_required"
        };
        tx.execute(
            "UPDATE agent_jobs SET state=?2,phase=?3,message='',plugin_generation=NULL,lease_until=0,
             revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![id,state,phase],
        ).map_err(storage_error)?;
        event(
            &tx,
            &job.batch_id,
            Some(id),
            "job.interrupted",
            "Execution interrupted; retained resources require reconciliation",
        )?;
        tx.commit().map_err(storage_error)
    }

    pub fn settle_control(&self, id: &str, _cancelled: bool) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let job = read_job(&tx, id)?;
        let action = super::controls::effective_action(&tx, id)?;
        if action == "run" {
            return Ok(());
        }
        tx.execute(
            "UPDATE agent_actions SET state='unknown' WHERE job_id=?1 AND state='prepared'",
            [id],
        )
        .map_err(storage_error)?;
        let state = if job.state == "blocked" {
            "blocked"
        } else if uncertain_actions(&tx, id)? {
            "result_unknown"
        } else if pending_outbox(&tx, id)? {
            "sync_pending"
        } else if action == "cancel" {
            "cancelled"
        } else {
            "paused"
        };
        tx.execute(
            "UPDATE agent_jobs SET state=?2,phase=?2,revision=revision+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![id, state],
        )
        .map_err(storage_error)?;
        if state == "cancelled" {
            tx.execute(
                "UPDATE agent_items SET state='cancelled',reason='' WHERE job_id=?1
                AND submitted=0 AND state NOT IN ('published','skipped')",
                [id],
            )
            .map_err(storage_error)?;
        }
        event(&tx, &job.batch_id, Some(id), "job.stopped", state)?;
        tx.commit().map_err(storage_error)
    }

    /// Call only after the WindowService actor has stopped and all host handlers drained.
    pub fn actor_stopped(&self, id: &str, release_resources: bool) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let job = read_job(&tx, id)?;
        if release_resources
            && (uncertain_actions(&tx, id)?
                || matches!(
                    job.state.as_str(),
                    "running" | "review_required" | "result_unknown" | "blocked"
                ))
        {
            return Err(conflict("Uncertain jobs must retain their resource locks"));
        }
        tx.execute(
            "UPDATE agent_jobs SET actor_owned=0,plugin_generation=NULL,lease_until=0 WHERE id=?1",
            [id],
        )
        .map_err(storage_error)?;
        if release_resources {
            tx.execute("DELETE FROM agent_resources WHERE job_id=?1", [id])
                .map_err(storage_error)?;
        }
        super::items::continue_after_item_control(&tx, id)?;
        tx.commit().map_err(storage_error)
    }

    pub fn retained_jobs(&self, batch_id: &str) -> AgentResult<Vec<Job>> {
        let db = self.open()?;
        let ids = strings(
            &db,
            "SELECT id FROM agent_jobs WHERE batch_id=?1 AND (actor_owned=1
             OR state IN ('review_required','result_unknown')
             OR EXISTS(SELECT 1 FROM agent_resources r WHERE r.job_id=agent_jobs.id))",
            [batch_id],
        )?;
        ids.iter().map(|id| read_job(&db, id)).collect()
    }

    pub fn action_prepare(
        &self,
        scope: &AgentScope,
        generation: &str,
        operation_id: &str,
        kind: &str,
        digest: &str,
    ) -> AgentResult<Value> {
        uuid(operation_id)?;
        if !matches!(kind, "listing" | "message")
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("Invalid external action intent"));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        if (kind == "listing" && job.preset != Preset::PostListing)
            || (kind == "message" && job.preset != Preset::Message)
        {
            return Err(denied("External action does not belong to this job preset"));
        }
        let existing: Option<(String,String,String,String,Option<String>)> = tx.query_row(
            "SELECT job_id,kind,digest,state,result_json FROM agent_actions WHERE operation_id=?1",
            [operation_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).optional().map_err(storage_error)?;
        if let Some((job_id, saved_kind, saved_digest, state, result)) = existing {
            if job_id != scope.job_id || saved_kind != kind || saved_digest != digest {
                return Err(conflict(
                    "Action operation ID has different content or ownership",
                ));
            }
            let mut reply = json!({"state":state,"fresh":false});
            if let Some(result) = result {
                reply["result"] = serde_json::from_str(&result).map_err(storage_error)?;
            }
            return Ok(reply);
        }
        super::controls::require_writes(&tx, &scope.job_id)?;
        super::items::prepare_item(&tx, &job, operation_id, kind)?;
        if job.reconcile_only || uncertain_actions(&tx, &scope.job_id)? {
            return Err(denied(
                "Reconciliation cannot prepare or resubmit an external write",
            ));
        }
        let count: u32 = tx
            .query_row(
                "SELECT COUNT(*) FROM agent_actions WHERE job_id=?1",
                [&scope.job_id],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if count >= 100 {
            return Err(invalid("External action budget exhausted"));
        }
        tx.execute(
            "INSERT INTO agent_actions(operation_id,job_id,kind,digest,state) VALUES(?1,?2,?3,?4,'prepared')",
            params![operation_id,scope.job_id,kind,digest],
        ).map_err(storage_error)?;
        event(
            &tx,
            &scope.batch_id,
            Some(&scope.job_id),
            "action.prepared",
            "External write intent saved",
        )?;
        tx.commit().map_err(storage_error)?;
        Ok(json!({"state":"prepared","fresh":true}))
    }

    /// Consumes the single submission entitlement durably before browser invocation.
    pub fn action_submitting(
        &self,
        scope: &AgentScope,
        generation: &str,
        operation_id: &str,
    ) -> AgentResult<()> {
        uuid(operation_id)?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        super::controls::require_writes(&tx, &scope.job_id)?;
        super::items::submit_item(&tx, &job, operation_id)?;
        if job.reconcile_only {
            return Err(denied("Reconciliation cannot submit an external write"));
        }
        let changed = tx
            .execute(
                "UPDATE agent_actions SET submitted=1,state='unknown',
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE operation_id=?1 AND job_id=?2 AND state='prepared' AND submitted=0",
                params![operation_id, scope.job_id],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(denied(
                "Action was already submitted or has no fresh prepared intent",
            ));
        }
        event(
            &tx,
            &scope.batch_id,
            Some(&scope.job_id),
            "action.submitting",
            "External submission started; result must be confirmed",
        )?;
        tx.commit().map_err(storage_error)
    }

    pub fn action_get(&self, scope: &AgentScope, operation_id: &str) -> AgentResult<Value> {
        uuid(operation_id)?;
        let row: Option<(String, String, Option<String>)> = self
            .open()?
            .query_row(
                "SELECT job_id,state,result_json FROM agent_actions WHERE operation_id=?1",
                [operation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let Some((job, state, result)) = row else {
            return Ok(json!({"state":"missing"}));
        };
        if job != scope.job_id {
            return Err(denied("Action belongs to another job"));
        }
        let mut value = json!({"state":state});
        if let Some(result) = result {
            value["result"] = serde_json::from_str(&result).map_err(storage_error)?;
        }
        Ok(value)
    }

    pub fn action_unknown(
        &self,
        scope: &AgentScope,
        generation: &str,
        operation_id: &str,
    ) -> AgentResult<Value> {
        uuid(operation_id)?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        if tx.execute(
            "UPDATE agent_actions SET state=CASE WHEN state='confirmed' THEN state ELSE 'unknown' END
             WHERE operation_id=?1 AND job_id=?2",params![operation_id,scope.job_id],
        ).map_err(storage_error)?!=1 { return Err(denied("No action intent belongs to this job")); }
        tx.execute(
            "UPDATE agent_items SET state='result_unknown' WHERE job_id=?1 AND operation_id=?2",
            params![scope.job_id, operation_id],
        )
        .map_err(storage_error)?;
        event(
            &tx,
            &scope.batch_id,
            Some(&scope.job_id),
            "action.unknown",
            "External action requires readback before further writes",
        )?;
        tx.commit().map_err(storage_error)?;
        Ok(json!({"recorded":true}))
    }

    pub fn action_confirm(
        &self,
        scope: &AgentScope,
        generation: &str,
        operation_id: &str,
        result: &Value,
        publication: Option<&Value>,
    ) -> AgentResult<Value> {
        uuid(operation_id)?;
        let encoded = canonical(result);
        if encoded.len() > 32 * 1024 {
            return Err(invalid("Action receipt exceeds its size budget"));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let row: Option<(String, String, String, Option<String>)> = tx
            .query_row(
                "SELECT job_id,kind,state,result_json FROM agent_actions WHERE operation_id=?1",
                [operation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let Some((job, kind, state, stored)) = row else {
            return Err(denied("Action has no durable intent"));
        };
        if job != scope.job_id || result["kind"].as_str() != Some(kind.as_str()) {
            return Err(denied(
                "Action receipt belongs to another job or action kind",
            ));
        }
        if state == "confirmed" {
            if stored.as_deref() != Some(encoded.as_str()) {
                return Err(conflict("Confirmed action receipt is immutable"));
            }
            return Ok(json!({"confirmed":true}));
        }
        if (kind == "listing") != publication.is_some() {
            return Err(invalid(
                "Listing confirmation requires a publication receipt",
            ));
        }
        if kind == "listing" {
            let assigned:bool=tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_items WHERE job_id=?1 AND operation_id=?2 AND product_id=?3)",
                params![scope.job_id,operation_id,result["productId"].as_str()],|r|r.get(0),
            ).map_err(storage_error)?;
            if !assigned {
                return Err(denied(
                    "Listing receipt does not match the product bound to its intent",
                ));
            }
        }
        tx.execute(
            "UPDATE agent_actions SET state='confirmed',result_json=?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE operation_id=?1",params![operation_id,encoded],
        ).map_err(storage_error)?;
        tx.execute("UPDATE agent_items SET submitted=1,state='sync_pending' WHERE job_id=?1 AND operation_id=?2",
            params![scope.job_id,operation_id]).map_err(storage_error)?;
        if let Some(payload) = publication {
            tx.execute(
                "INSERT INTO agent_publication_outbox(operation_id,job_id,payload_json,state)
                 VALUES(?1,?2,?3,'pending')",
                params![operation_id, scope.job_id, canonical(payload)],
            )
            .map_err(storage_error)?;
        }
        event(
            &tx,
            &scope.batch_id,
            Some(&scope.job_id),
            "action.confirmed",
            "External result confirmed and publication receipt saved",
        )?;
        tx.commit().map_err(storage_error)?;
        Ok(json!({"confirmed":true}))
    }

    pub fn due_outbox(&self) -> AgentResult<Vec<OutboxItem>> {
        let db = self.open()?;
        let mut query=db.prepare(
            "SELECT operation_id,payload_json FROM agent_publication_outbox
             WHERE state='pending' AND next_attempt<=?1 ORDER BY next_attempt,operation_id LIMIT 10"
        ).map_err(storage_error)?;
        let rows = query
            .query_map([now_ms()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        rows.into_iter()
            .map(|(operation_id, text)| {
                Ok(OutboxItem {
                    operation_id,
                    payload: serde_json::from_str(&text).map_err(storage_error)?,
                })
            })
            .collect()
    }

    pub fn require_publication(&self, scope: &AgentScope, payload: &Value) -> AgentResult<String> {
        let operation = payload["operationId"]
            .as_str()
            .ok_or_else(|| invalid("Publication operation ID is missing"))?;
        uuid(operation)?;
        let row: Option<(String,String,String)> = self.open()?.query_row(
            "SELECT o.job_id,o.payload_json,a.state FROM agent_publication_outbox o JOIN agent_actions a
             ON a.operation_id=o.operation_id WHERE o.operation_id=?1",[operation],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(storage_error)?;
        let Some((job, stored, state)) = row else {
            return Err(denied(
                "Publication has no confirmed action and outbox receipt",
            ));
        };
        if job != scope.job_id || state != "confirmed" || stored != canonical(payload) {
            return Err(denied(
                "Publication does not match the confirmed immutable receipt",
            ));
        }
        Ok(operation.to_owned())
    }

    pub fn outbox_result(
        &self,
        operation_id: &str,
        error: Option<(&str, bool)>,
    ) -> AgentResult<()> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let (job_id, attempts, state): (String, u32, String) = tx
            .query_row(
                "SELECT job_id,attempts,state FROM agent_publication_outbox WHERE operation_id=?1",
                [operation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(storage_error)?;
        // A late failure from a concurrent idempotent sync cannot undo its receipt.
        if state == "synced" {
            return Ok(());
        }
        let job = read_job(&tx, &job_id)?;
        if let Some((code, retryable)) = error {
            let next = now_ms() + ((1_i64 << attempts.min(8)) * 1000).min(300_000);
            tx.execute(
                "UPDATE agent_publication_outbox SET attempts=attempts+1,next_attempt=?2,last_error=?3,
                 state=CASE WHEN state='synced' THEN state ELSE ?4 END WHERE operation_id=?1",
                params![operation_id,next,code,if retryable {"pending"} else {"review_required"}],
            ).map_err(storage_error)?;
            tx.execute(
                "UPDATE agent_items SET state=?3,reason=?4 WHERE job_id=?1 AND operation_id=?2",
                params![
                    job_id,
                    operation_id,
                    if retryable {
                        "sync_pending"
                    } else {
                        "review_required"
                    },
                    code
                ],
            )
            .map_err(storage_error)?;
            if !retryable {
                tx.execute(
                    "UPDATE agent_jobs SET state='review_required',phase='publication_sync_conflict'
                     WHERE id=?1 AND state='sync_pending'",[&job_id],
                ).map_err(storage_error)?;
            }
        } else {
            tx.execute("UPDATE agent_publication_outbox SET state='synced',last_error='' WHERE operation_id=?1",
                [operation_id]).map_err(storage_error)?;
            if !pending_outbox(&tx, &job_id)? && !uncertain_actions(&tx, &job_id)? {
                tx.execute(
                    "UPDATE agent_jobs SET state=CASE
                         WHEN (SELECT control FROM agent_batches WHERE id=batch_id)='run' THEN 'queued'
                         WHEN (SELECT control FROM agent_batches WHERE id=batch_id)='cancel' THEN 'cancelled'
                         ELSE 'paused' END,phase='publication_synced',
                     updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND state='sync_pending'",
                    [&job_id],
                ).map_err(storage_error)?;
            }
            tx.execute("UPDATE agent_items SET state='published',reason='' WHERE job_id=?1 AND operation_id=?2",
                params![job_id,operation_id]).map_err(storage_error)?;
            event(
                &tx,
                &job.batch_id,
                Some(&job_id),
                "publication.synced",
                "Confirmed publication recorded by the product plugin",
            )?;
        }
        tx.commit().map_err(storage_error)
    }

    pub fn has_uncertain(&self, id: &str) -> AgentResult<bool> {
        uncertain_actions(&self.open()?, id)
    }

    pub fn product_confirmed(&self, job_id: &str, product_id: &Value) -> AgentResult<bool> {
        self.open()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_actions WHERE job_id=?1
                 AND kind='listing' AND state='confirmed'
                 AND json_extract(result_json,'$.productId')=?2)",
                params![job_id, product_id.as_str()],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    pub fn artifact(&self, scope: &AgentScope, id: &str) -> AgentResult<(String, u64, String)> {
        uuid(id)?;
        self.open()?.query_row(
            "SELECT mime,size,sha256 FROM agent_artifacts WHERE id=?1 AND job_id=?2 AND batch_id=?3",
            params![id,scope.job_id,scope.batch_id],|r|Ok((r.get(0)?,read_u64(r, 1)?,r.get(2)?)),
        ).optional().map_err(storage_error)?.ok_or_else(||denied("Artifact is outside this job scope"))
    }

    pub fn checkpoint(
        &self,
        scope: &AgentScope,
        generation: &str,
        method: &str,
        payload: &Value,
    ) -> AgentResult<Value> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        if matches!(
            method,
            "agent.checkpoint.put" | "agent.checkpoint.putWrites"
        ) {
            let job = read_job(&tx, &scope.job_id)?;
            if private_checkpoint_data(payload, &job.settings) {
                return Err(invalid(
                    "Checkpoints must contain plain workflow state without model keys or image bytes",
                ));
            }
        }
        let thread = payload["threadId"]
            .as_str()
            .ok_or_else(|| invalid("Checkpoint thread is missing"))?;
        if thread != scope.job_id {
            return Err(denied("Checkpoint thread belongs to another job"));
        }
        if method == "agent.checkpoint.delete" {
            tx.execute("DELETE FROM agent_pending_writes WHERE job_id=?1", [thread])
                .map_err(storage_error)?;
            tx.execute("DELETE FROM agent_checkpoints WHERE job_id=?1", [thread])
                .map_err(storage_error)?;
            tx.execute(
                "DELETE FROM agent_checkpoint_retention WHERE job_id=?1",
                [thread],
            )
            .map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
            return Ok(json!({"deleted":true}));
        }
        if payload["checkpointNs"].as_str() != Some("") {
            return Err(denied(
                "Only the current job's root checkpoint namespace is allowed",
            ));
        }
        match method {
            "agent.checkpoint.get" => {
                let id = optional_checkpoint_id(payload.get("checkpointId"))?;
                let row:Option<(String,String)>=if let Some(id)=id{
                    tx.query_row("SELECT checkpoint_id,tuple_json FROM agent_checkpoints WHERE job_id=?1 AND namespace='' AND checkpoint_id=?2",
                        params![thread,id],|r|Ok((r.get(0)?,r.get(1)?))).optional()
                }else{
                    tx.query_row("SELECT checkpoint_id,tuple_json FROM agent_checkpoints WHERE job_id=?1 AND namespace='' ORDER BY checkpoint_id DESC LIMIT 1",
                        [thread],|r|Ok((r.get(0)?,r.get(1)?))).optional()
                }.map_err(storage_error)?;
                if let Some((id, tuple)) = row {
                    checkpoint_tuple(&tx, thread, &id, &tuple)
                } else {
                    Ok(Value::Null)
                }
            }
            "agent.checkpoint.list" => {
                let limit = payload["limit"].as_u64().unwrap_or(50);
                if !(1..=50).contains(&limit) {
                    return Err(invalid("Invalid checkpoint list size"));
                }
                let before = payload
                    .get("before")
                    .filter(|v| !v.is_null())
                    .map(|config| checkpoint_config_id(config, thread))
                    .transpose()?
                    .flatten();
                let only = optional_checkpoint_id(payload.get("checkpointId"))?;
                let mut query=tx.prepare(
                    "SELECT checkpoint_id,tuple_json FROM agent_checkpoints WHERE job_id=?1 AND namespace=''
                     AND (?2 IS NULL OR checkpoint_id<?2) AND (?3 IS NULL OR checkpoint_id=?3)
                     ORDER BY checkpoint_id DESC"
                ).map_err(storage_error)?;
                let rows = query
                    .query_map(params![thread, before, only], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })
                    .map_err(storage_error)?;
                let mut tuples = Vec::new();
                let mut bytes = 0usize;
                for row in rows {
                    let (id, tuple) = row.map_err(storage_error)?;
                    let tuple = checkpoint_tuple(&tx, thread, &id, &tuple)?;
                    if let Some(filter) = payload.get("filter") {
                        let filter = filter
                            .as_object()
                            .ok_or_else(|| invalid("Checkpoint filter must be an object"))?;
                        if !filter
                            .iter()
                            .all(|(key, value)| tuple["metadata"].get(key) == Some(value))
                        {
                            continue;
                        }
                    }
                    let size = canonical(&tuple).len();
                    if bytes + size > 700 * 1024 && !tuples.is_empty() {
                        break;
                    }
                    bytes += size;
                    tuples.push(tuple);
                    if tuples.len() >= limit as usize {
                        break;
                    }
                }
                Ok(json!(tuples))
            }
            "agent.checkpoint.put" => {
                let checkpoint = &payload["checkpoint"];
                let id = checkpoint["id"]
                    .as_str()
                    .ok_or_else(|| invalid("Checkpoint ID is missing"))?;
                checkpoint_id(id)?;
                if checkpoint["v"].as_u64().is_none()
                    || !checkpoint["channel_values"].is_object()
                    || !payload["metadata"].is_object()
                    || !payload["newVersions"].is_object()
                {
                    return Err(invalid("Invalid LangGraph checkpoint tuple"));
                }
                let config = graph_config(thread, id);
                let mut tuple = json!({"config":config,"checkpoint":checkpoint,"metadata":payload["metadata"],"pendingWrites":[]});
                if let Some(parent) = payload.get("parentConfig").filter(|v| !v.is_null()) {
                    if let Some(parent_id) = checkpoint_config_id(parent, thread)? {
                        tuple["parentConfig"] = graph_config(thread, &parent_id);
                    }
                }
                let encoded = canonical(&tuple);
                let versions = canonical(&payload["newVersions"]);
                if encoded.len() + versions.len() > MAX_CHECKPOINT_BYTES {
                    return Err(invalid("Checkpoint exceeds the storage budget"));
                }
                require_retained_checkpoint(&tx, thread, id)?;
                let existing:Option<(String,String)>=tx.query_row(
                    "SELECT tuple_json,new_versions_json FROM agent_checkpoints WHERE job_id=?1 AND namespace='' AND checkpoint_id=?2",
                    params![thread,id],|r|Ok((r.get(0)?,r.get(1)?)),
                ).optional().map_err(storage_error)?;
                if let Some((stored, stored_versions)) = existing {
                    if stored != encoded || stored_versions != versions {
                        return Err(conflict("Checkpoint ID already has different content"));
                    }
                } else {
                    tx.execute(
                        "INSERT INTO agent_checkpoints(job_id,namespace,checkpoint_id,tuple_json,new_versions_json) VALUES(?1,'',?2,?3,?4)",
                        params![thread,id,encoded,versions],
                    ).map_err(storage_error)?;
                }
                compact_checkpoint_history(&tx, thread, id)?;
                let (count, bytes): (u64, u64) = tx.query_row(
                    "SELECT COUNT(*),COALESCE(SUM(length(CAST(tuple_json AS BLOB))+length(CAST(new_versions_json AS BLOB))),0)
                     FROM agent_checkpoints WHERE job_id=?1",
                    [thread], |row| Ok((read_u64(row, 0)?, read_u64(row, 1)?)),
                ).map_err(storage_error)?;
                if count > 30_100 || bytes > 128 * 1024 * 1024 {
                    return Err(invalid(
                        "Unconsumed checkpoint history exceeds its per-job storage budget",
                    ));
                }
                tx.commit().map_err(storage_error)?;
                Ok(config)
            }
            "agent.checkpoint.putWrites" => {
                let id = payload["checkpointId"]
                    .as_str()
                    .ok_or_else(|| invalid("Pending writes require a checkpoint ID"))?;
                checkpoint_id(id)?;
                let task = payload["taskId"]
                    .as_str()
                    .ok_or_else(|| invalid("Pending writes require a task ID"))?;
                text(task, 1, 200)?;
                let task_path = payload["taskPath"].as_str().unwrap_or("");
                text(task_path, 0, 1000)?;
                let writes = payload["writes"]
                    .as_array()
                    .ok_or_else(|| invalid("Pending writes must be an array"))?;
                if writes.len() > 256 || canonical(&payload["writes"]).len() > 128 * 1024 {
                    return Err(invalid("Pending writes exceed their budget"));
                }
                require_retained_checkpoint(&tx, thread, id)?;
                for (index, write) in writes.iter().enumerate() {
                    let pair = write
                        .as_array()
                        .filter(|v| v.len() == 2)
                        .ok_or_else(|| invalid("Invalid pending write tuple"))?;
                    let channel = pair[0]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid pending write channel"))?;
                    text(channel, 1, 200)?;
                    let special = match channel {
                        "__error__" => Some(-1),
                        "__scheduled__" => Some(-2),
                        "__interrupt__" => Some(-3),
                        "__resume__" => Some(-4),
                        _ => None,
                    };
                    let index = special.unwrap_or(i64::try_from(index).map_err(storage_error)?);
                    let sql = if special.is_some() {
                        "INSERT INTO agent_pending_writes(job_id,namespace,checkpoint_id,task_id,write_index,channel,value_json,task_path)
                         VALUES(?1,'',?2,?3,?4,?5,?6,?7) ON CONFLICT(job_id,namespace,checkpoint_id,task_id,write_index)
                         DO UPDATE SET channel=excluded.channel,value_json=excluded.value_json,task_path=excluded.task_path"
                    } else {
                        "INSERT OR IGNORE INTO agent_pending_writes(job_id,namespace,checkpoint_id,task_id,write_index,channel,value_json,task_path)
                         VALUES(?1,'',?2,?3,?4,?5,?6,?7)"
                    };
                    tx.execute(
                        sql,
                        params![
                            thread,
                            id,
                            task,
                            index,
                            channel,
                            canonical(&pair[1]),
                            task_path
                        ],
                    )
                    .map_err(storage_error)?;
                }
                compact_checkpoint_history(&tx, thread, id)?;
                let(count,bytes):(u64,u64)=tx.query_row(
                    "SELECT COUNT(*),COALESCE(SUM(length(CAST(value_json AS BLOB))),0) FROM agent_pending_writes WHERE job_id=?1",
                    [thread],|row|Ok((read_u64(row, 0)?,read_u64(row, 1)?)),
                ).map_err(storage_error)?;
                if count > 100_000 || bytes > 32 * 1024 * 1024 {
                    return Err(invalid(
                        "Pending write history exceeds its per-job storage budget",
                    ));
                }
                tx.commit().map_err(storage_error)?;
                Ok(json!({"saved":true}))
            }
            _ => Err(denied("Unknown checkpoint method")),
        }
    }
}

fn require_retained_checkpoint(db: &Connection, thread: &str, id: &str) -> AgentResult<()> {
    // Early task writes and the protected out-of-order save may predate the boundary.
    // Discarded IDs have neither record and cannot be recreated by a delayed request.
    let compacted: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_checkpoint_retention
             WHERE job_id=?1 AND namespace='' AND ?2<compacted_before
               AND NOT EXISTS(SELECT 1 FROM agent_checkpoints
                 WHERE job_id=?1 AND namespace='' AND checkpoint_id=?2)
               AND NOT EXISTS(SELECT 1 FROM agent_pending_writes
                 WHERE job_id=?1 AND namespace='' AND checkpoint_id=?2))",
            params![thread, id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if compacted {
        return Err(conflict("Checkpoint belongs to compacted workflow history"));
    }
    Ok(())
}

fn compact_checkpoint_history(db: &Connection, thread: &str, current: &str) -> AgentResult<()> {
    // The Agent graph saves complete channel state. Older consumed snapshots and their
    // task writes are unnecessary for resuming the latest eight checkpoints.
    let cutoff: Option<String> = db
        .query_row(
            "SELECT checkpoint_id FROM agent_checkpoints WHERE job_id=?1 AND namespace=''
             ORDER BY checkpoint_id DESC LIMIT 1 OFFSET ?2",
            params![thread, RETAINED_CHECKPOINTS - 1],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(cutoff) = cutoff else {
        return Ok(());
    };
    let consumed: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_checkpoints
             WHERE job_id=?1 AND namespace='' AND checkpoint_id<?2 AND checkpoint_id<>?3)",
            params![thread, cutoff, current],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !consumed {
        return Ok(());
    }
    // Only delete writes attached to a snapshot being pruned. Writes arriving before
    // put survive independently, and the current save is protected even if out of order.
    db.execute(
        "DELETE FROM agent_pending_writes WHERE job_id=?1 AND namespace=''
         AND checkpoint_id IN(SELECT checkpoint_id FROM agent_checkpoints
           WHERE job_id=?1 AND namespace='' AND checkpoint_id<?2 AND checkpoint_id<>?3)",
        params![thread, cutoff, current],
    )
    .map_err(storage_error)?;
    db.execute(
        "DELETE FROM agent_checkpoints
         WHERE job_id=?1 AND namespace='' AND checkpoint_id<?2 AND checkpoint_id<>?3",
        params![thread, cutoff, current],
    )
    .map_err(storage_error)?;
    // Keep a bounded, durable boundary so delayed saves cannot resurrect discarded
    // history. All three mutations share the caller's save transaction.
    db.execute(
        "INSERT INTO agent_checkpoint_retention(job_id,namespace,compacted_before) VALUES(?1,'',?2)
         ON CONFLICT(job_id,namespace) DO UPDATE SET
           compacted_before=MAX(agent_checkpoint_retention.compacted_before,excluded.compacted_before)",
        params![thread, cutoff],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(super) fn strings<P: rusqlite::Params>(
    db: &Connection,
    sql: &str,
    params: P,
) -> AgentResult<Vec<String>> {
    let mut query = db.prepare(sql).map_err(storage_error)?;
    let rows = query
        .query_map(params, |row| row.get(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    Ok(rows)
}

pub(super) fn require_batch(db: &Connection, id: &str) -> AgentResult<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_batches WHERE id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if !exists {
        return Err(invalid("Agent batch was not found"));
    }
    Ok(())
}

fn require_new_operation(db: &Connection, id: &str, body: &str) -> AgentResult<()> {
    let digest: Option<String> = db
        .query_row(
            "SELECT body_sha256 FROM agent_archived_batches WHERE operation_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(saved) = digest {
        return Err(conflict(
            if saved == format!("{:x}", Sha256::digest(body.as_bytes())) {
                "This operation already ended and its history was cleaned; archived operations cannot be replayed"
            } else {
                "Operation ID belongs to a different archived batch body"
            },
        ));
    }
    Ok(())
}

pub(super) fn batch_view(db: &Connection, id: &str) -> AgentResult<Value> {
    let row=db.query_row(
        "SELECT preset,instruction,concurrency,control,created_at,updated_at FROM agent_batches WHERE id=?1",
        [id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,u32>(2)?,
            r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)),
    ).optional().map_err(storage_error)?.ok_or_else(||invalid("Agent batch was not found"))?;
    let(total,completed,attention,running,queued,cancelled):(u64,u64,u64,u64,u64,u64)=db.query_row(
        "SELECT COUNT(*),COALESCE(SUM(state IN ('completed','skipped')),0),
         COALESCE(SUM(state IN ('blocked','review_required','result_unknown','sync_pending','failed')),0),
         COALESCE(SUM(state='running'),0),COALESCE(SUM(state='queued'),0),
         COALESCE(SUM(state='cancelled'),0) FROM agent_jobs WHERE batch_id=?1",
        [id],|r|Ok((read_u64(r, 0)?,read_u64(r, 1)?,read_u64(r, 2)?,
            read_u64(r, 3)?,read_u64(r, 4)?,read_u64(r, 5)?)),
    ).map_err(storage_error)?;
    let state = if running > 0 {
        "running"
    } else if attention > 0 {
        "needs_attention"
    } else if row.3 == "cancel" && cancelled + completed == total {
        "cancelled"
    } else if completed == total {
        "completed"
    } else if row.3 == "pause" {
        "paused"
    } else if queued > 0 {
        "queued"
    } else {
        "paused"
    };
    Ok(
        json!({"id":id,"preset":row.0,"instruction":row.1,"concurrency":row.2,"state":state,
        "total":total,"completed":completed,"attention":attention,"createdAt":row.4,"updatedAt":row.5}),
    )
}

pub(super) fn read_job(db: &Connection, id: &str) -> AgentResult<Job> {
    let row=db.query_row(
        "SELECT j.batch_id,b.preset,b.instruction,b.settings_json,j.snapshot_json,j.state,j.scope_json,
         j.plugin_generation,j.reconcile_only,j.steps FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id WHERE j.id=?1",
        [id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
            r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,
            r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,bool>(8)?,r.get::<_,u32>(9)?)),
    ).optional().map_err(storage_error)?.ok_or_else(||invalid("Agent job was not found"))?;
    Ok(Job {
        id: id.to_owned(),
        batch_id: row.0,
        preset: serde_json::from_value(json!(row.1)).map_err(storage_error)?,
        instruction: row.2,
        settings: serde_json::from_str(&row.3).map_err(storage_error)?,
        snapshot: serde_json::from_str(&row.4).map_err(storage_error)?,
        state: row.5,
        scope: row
            .6
            .map(|text| serde_json::from_str(&text))
            .transpose()
            .map_err(storage_error)?,
        generation: row.7,
        reconcile_only: row.8,
        steps: row.9,
    })
}

pub(super) fn validate_lease(
    db: &Connection,
    scope: &AgentScope,
    generation: &str,
) -> AgentResult<()> {
    validate_scope(scope)?;
    let job = read_job(db, &scope.job_id)?;
    let (until, owned): (i64, bool) = db
        .query_row(
            "SELECT lease_until,actor_owned FROM agent_jobs WHERE id=?1",
            [&scope.job_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if job.batch_id != scope.batch_id
        || job.snapshot.window_id != scope.window_id
        || job.snapshot.account_id()? != scope.account_id
        || job.scope.as_ref() != Some(scope)
        || job.generation.as_deref() != Some(generation)
        || !owned
        || until < now_ms()
        || job.state != "running"
    {
        return Err(denied(
            "Agent lease is expired, stale, stopped, or outside the requested scope",
        ));
    }
    for key in job.snapshot.resources()? {
        let valid:bool=db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_resources WHERE resource_key=?1 AND job_id=?2 AND lease_id=?3 AND fence=?4)",
            params![key,scope.job_id,scope.lease_id,to_sql_i64(scope.fence)?],|r|r.get(0),
        ).map_err(storage_error)?;
        if !valid {
            return Err(denied("Agent does not own every required resource"));
        }
    }
    Ok(())
}

pub(super) fn uncertain_actions(db: &Connection, id: &str) -> AgentResult<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM agent_actions WHERE job_id=?1 AND state IN ('prepared','unknown'))",
        [id],|r|r.get(0)).map_err(storage_error)
}

pub(super) fn pending_outbox(db: &Connection, id: &str) -> AgentResult<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_publication_outbox WHERE job_id=?1 AND state!='synced')",
        [id],
        |r| r.get(0),
    )
    .map_err(storage_error)
}

pub(super) fn event(
    db: &Connection,
    batch: &str,
    job: Option<&str>,
    kind: &str,
    message: &str,
) -> AgentResult<()> {
    db.execute(
        "INSERT INTO agent_events(batch_id,job_id,kind,message,job_revision)
        VALUES(?1,?2,?3,?4,(SELECT revision FROM agent_jobs WHERE id=?2))",
        params![batch, job, kind, message],
    )
    .map_err(storage_error)?;
    db.execute("UPDATE agent_batches SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [batch]).map_err(storage_error)?;
    Ok(())
}

fn preset_name(preset: Preset) -> &'static str {
    match preset {
        Preset::InspectAccounts => "inspect_accounts",
        Preset::PostListing => "post_listing",
        Preset::Message => "message",
    }
}

fn checkpoint_id(id: &str) -> AgentResult<()> {
    text(id, 1, 200)
}
fn optional_checkpoint_id(value: Option<&Value>) -> AgentResult<Option<String>> {
    value
        .map(|value| {
            let id = value
                .as_str()
                .ok_or_else(|| invalid("Invalid checkpoint ID"))?;
            checkpoint_id(id)?;
            Ok(id.to_owned())
        })
        .transpose()
}

fn graph_config(thread: &str, id: &str) -> Value {
    json!({"configurable":{"thread_id":thread,"checkpoint_ns":"","checkpoint_id":id}})
}

fn checkpoint_config_id(value: &Value, thread: &str) -> AgentResult<Option<String>> {
    let config = &value["configurable"];
    if config["thread_id"].as_str() != Some(thread)
        || config
            .get("checkpoint_ns")
            .is_some_and(|namespace| namespace.as_str() != Some(""))
    {
        return Err(denied(
            "Checkpoint parent/before config is outside the current job",
        ));
    }
    optional_checkpoint_id(config.get("checkpoint_id"))
}

fn private_checkpoint_data(value: &Value, settings: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "apikey"
                    | "api_key"
                    | "authorization"
                    | "cookie"
                    | "cookies"
                    | "imagebytes"
                    | "base64"
            ) || private_checkpoint_data(value, settings)
        }),
        Value::Array(values) => values
            .iter()
            .any(|value| private_checkpoint_data(value, settings)),
        Value::String(value) => {
            value.starts_with("data:image/")
                || ["decision", "generation"].into_iter().any(|endpoint| {
                    settings[endpoint]["apiKey"].as_str().is_some_and(|key| {
                        !key.is_empty() && (value == key || (key.len() >= 8 && value.contains(key)))
                    })
                })
        }
        _ => false,
    }
}

fn checkpoint_tuple(db: &Connection, thread: &str, id: &str, encoded: &str) -> AgentResult<Value> {
    let mut tuple: Value = serde_json::from_str(encoded).map_err(storage_error)?;
    let mut query=db.prepare(
        "SELECT task_id,channel,value_json FROM agent_pending_writes WHERE job_id=?1 AND namespace=''
         AND checkpoint_id=?2 ORDER BY task_path COLLATE BINARY,task_id COLLATE BINARY,write_index"
    ).map_err(storage_error)?;
    let rows = query
        .query_map(params![thread, id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let mut writes = Vec::new();
    for (task, channel, value) in rows {
        writes.push(json!([
            task,
            channel,
            serde_json::from_str::<Value>(&value).map_err(storage_error)?
        ]));
    }
    tuple["pendingWrites"] = json!(writes);
    if canonical(&tuple).len() > 800 * 1024 {
        return Err(invalid(
            "Checkpoint tuple and pending writes exceed the reply budget",
        ));
    }
    Ok(tuple)
}
