use rusqlite::Connection;

use super::{AgentResult, storage_error};

pub(super) fn initialize(db: &Connection) -> AgentResult<()> {
    db.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS agent_dispatch(
           job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id),action TEXT NOT NULL DEFAULT 'run',
           control_revision INTEGER NOT NULL DEFAULT 0,takeover TEXT NOT NULL DEFAULT 'none',
           retry_json TEXT,progress_json TEXT,next_attempt INTEGER NOT NULL DEFAULT 0,
           retry_attempt INTEGER NOT NULL DEFAULT 0,retry_code TEXT NOT NULL DEFAULT '',
           item_revision INTEGER NOT NULL DEFAULT 0,control_retry_at INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS agent_cooldowns(
           resource_key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS agent_items(
           job_id TEXT NOT NULL REFERENCES agent_jobs(id),product_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
           state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL DEFAULT '',
           title TEXT NOT NULL,description TEXT NOT NULL,control_action TEXT,
           control_revision INTEGER NOT NULL DEFAULT 0,override_json TEXT,
           operation_id TEXT,submitted INTEGER NOT NULL DEFAULT 0,observed_revision INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY(job_id,product_id),UNIQUE(job_id,ordinal));
         CREATE TABLE IF NOT EXISTS agent_item_continuations(
           job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id),product_id TEXT NOT NULL,
           revision INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS agent_model_requests(
           request_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES agent_jobs(id),
           batch_id TEXT NOT NULL REFERENCES agent_batches(id),scope_json TEXT NOT NULL,
           generation TEXT NOT NULL,kind TEXT NOT NULL,endpoint_digest TEXT NOT NULL,
           state TEXT NOT NULL,acquired_at INTEGER NOT NULL,deadline INTEGER NOT NULL,
           elapsed_ms INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER,
           cost_usd REAL,receipt_json TEXT);
         CREATE INDEX IF NOT EXISTS agent_model_active ON agent_model_requests(state,deadline);
         CREATE INDEX IF NOT EXISTS agent_model_rate ON agent_model_requests(endpoint_digest,acquired_at);
         CREATE INDEX IF NOT EXISTS agent_model_batch ON agent_model_requests(batch_id,acquired_at,request_id);
         CREATE TABLE IF NOT EXISTS agent_workspace(
           id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,data_json TEXT NOT NULL,
           revision INTEGER NOT NULL,
           created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
         CREATE TABLE IF NOT EXISTS agent_notification_outbox(
           notification_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES agent_batches(id),
           kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
           attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
           last_error TEXT NOT NULL DEFAULT '',UNIQUE(batch_id,kind));
         CREATE TABLE IF NOT EXISTS agent_retention_previews(
           token TEXT PRIMARY KEY,before_at TEXT NOT NULL,batch_ids_json TEXT NOT NULL,
           created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS agent_artifact_cleanup(
           batch_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS agent_archived_publications(
           operation_id TEXT PRIMARY KEY,product_id TEXT NOT NULL,result_json TEXT NOT NULL,
           archived_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
         CREATE TABLE IF NOT EXISTS agent_archived_batches(
           operation_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,body_sha256 TEXT NOT NULL,
           archived_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
         INSERT OR IGNORE INTO agent_dispatch(job_id,action)
           SELECT id,CASE WHEN state='paused' THEN 'pause' ELSE 'run' END FROM agent_jobs;
         INSERT OR IGNORE INTO agent_items(job_id,product_id,ordinal,title,description)
           SELECT j.id,json_extract(p.value,'$.id'),CAST(p.key AS INTEGER),
             json_extract(p.value,'$.title'),json_extract(p.value,'$.description')
           FROM agent_jobs j,json_each(j.snapshot_json,'$.products') p;
         ",
    ).map_err(storage_error)?;
    let mut statement = db
        .prepare("SELECT i.job_id,i.product_id FROM agent_items i")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);
    for (job, product) in rows {
        let operation = super::items::operation_id(&job, &format!("listing:{product}"));
        db.execute("UPDATE agent_items SET operation_id=?3,
            submitted=COALESCE((SELECT submitted FROM agent_actions WHERE operation_id=?3),submitted),
            state=CASE
                WHEN EXISTS(SELECT 1 FROM agent_actions WHERE operation_id=?3 AND state='confirmed')
                 THEN CASE WHEN EXISTS(SELECT 1 FROM agent_publication_outbox WHERE operation_id=?3 AND state='review_required')
                      THEN 'review_required' WHEN EXISTS(SELECT 1 FROM agent_publication_outbox WHERE operation_id=?3 AND state!='synced')
                      THEN 'sync_pending' ELSE 'published' END
                WHEN EXISTS(SELECT 1 FROM agent_actions WHERE operation_id=?3 AND state IN ('prepared','unknown'))
                 THEN 'result_unknown' ELSE state END
            WHERE job_id=?1 AND product_id=?2 AND EXISTS(SELECT 1 FROM agent_actions WHERE operation_id=?3 AND job_id=?1)",
            rusqlite::params![job,product,operation]).map_err(storage_error)?;
    }
    db.execute_batch("COMMIT;").map_err(storage_error)
}

pub(super) fn millis(db: &Connection, value: &str) -> AgentResult<i64> {
    super::gateway::validate_timestamp(value)?;
    db.query_row(
        "SELECT CAST(ROUND((julianday(?1)-2440587.5)*86400000) AS INTEGER)",
        [value],
        |row| row.get(0),
    )
    .map_err(storage_error)
}

pub(super) fn timestamp(db: &Connection, value: i64) -> AgentResult<String> {
    db.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?1/1000.0,'unixepoch')",
        [value],
        |row| row.get(0),
    )
    .map_err(storage_error)
}
