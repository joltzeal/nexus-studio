use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::{AgentResult, canonical, storage_error};

// Only startup reads the old graph format. Runtime reads this native projection,
// which survives graph resets and never grants a new submission entitlement.
pub(super) fn initialize(db: &Connection, legacy_upgrade: bool) -> AgentResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_action_recovery(
           operation_id TEXT PRIMARY KEY REFERENCES agent_actions(operation_id),
           job_id TEXT NOT NULL REFERENCES agent_jobs(id),recovery_json TEXT NOT NULL);",
    )
    .map_err(storage_error)?;
    let migrated: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_execution_migrations WHERE version=4)",
            [],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if migrated {
        return Ok(());
    }
    let mut statement = db
        .prepare(
            "SELECT j.id,j.snapshot_json FROM agent_jobs j
             JOIN agent_batches b ON b.id=j.batch_id JOIN agent_execution e ON e.job_id=j.id
             WHERE b.preset='post_listing' AND (?1 OR e.reconcile_only=1)
               AND EXISTS(SELECT 1 FROM agent_actions a WHERE a.job_id=j.id AND a.kind='listing')",
        )
        .map_err(storage_error)?;
    let jobs = statement
        .query_map([legacy_upgrade], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);
    for (job, encoded) in jobs {
        let snapshot: Value = serde_json::from_str(&encoded).map_err(storage_error)?;
        let products = snapshot["products"]
            .as_array()
            .ok_or_else(|| storage_error("Missing frozen recovery products"))?;
        let states = legacy_states(db, &job)?;
        for (index, product) in products.iter().enumerate() {
            let product_id = product["id"]
                .as_str()
                .ok_or_else(|| storage_error("Missing frozen recovery product ID"))?;
            let operation = super::items::operation_id(&job, &format!("listing:{product_id}"));
            let exists: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_actions
                     WHERE operation_id=?1 AND job_id=?2 AND kind='listing')",
                    params![operation, job],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            if !exists {
                continue;
            }
            let state = states.get(&index).unwrap_or(&Value::Null);
            let recovery = json!({
                "version":1,"mode":"reconcile_only","productId":product_id,
                "productRevision":product["revision"],
                "content":legacy_content(state, product),
                "listingBaseline":legacy_baseline(state, &snapshot),
                "intentStartedAt":state["intentStartedAt"].as_str()
                    .filter(|s| super::gateway::validate_timestamp(s).is_ok())
            });
            db.execute(
                "INSERT OR IGNORE INTO agent_action_recovery(operation_id,job_id,recovery_json)
                 VALUES(?1,?2,?3)",
                params![operation, job, canonical(&recovery)],
            )
            .map_err(storage_error)?;
        }
    }
    db.execute(
        "INSERT INTO agent_execution_migrations(version) VALUES(4)",
        [],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(super) fn initialize_messages(db: &Connection) -> AgentResult<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_message_recovery(
           operation_id TEXT PRIMARY KEY REFERENCES agent_actions(operation_id),
           job_id TEXT NOT NULL REFERENCES agent_jobs(id),recovery_json TEXT NOT NULL);",
    )
    .map_err(storage_error)?;
    let migrated: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_execution_migrations WHERE version=5)",
            [],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    if migrated {
        return Ok(());
    }
    let mut statement = db
        .prepare(
            "SELECT j.id,b.preset,j.snapshot_json FROM agent_jobs j
             JOIN agent_batches b ON b.id=j.batch_id
             WHERE b.preset IN ('message','inspect_accounts') ORDER BY j.id",
        )
        .map_err(storage_error)?;
    let jobs = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    drop(statement);
    for (job, preset, encoded) in jobs {
        let pinned: bool = preset == "message"
            && db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_actions WHERE job_id=?1)",
                    [&job],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
        if pinned {
            let snapshot: Value = serde_json::from_str(&encoded).map_err(storage_error)?;
            extract_messages(db, &job, &snapshot)?;
            db.execute(
                "UPDATE agent_actions SET state='unknown' WHERE job_id=?1 AND state='prepared'",
                [&job],
            )
            .map_err(storage_error)?;
        }
        db.execute(
            "UPDATE agent_execution SET reconcile_only=?2,needs_reprepare=0 WHERE job_id=?1",
            params![job, pinned],
        )
        .map_err(storage_error)?;
        let state = if pinned && super::store::uncertain_actions(db, &job)? {
            "result_unknown"
        } else if pinned && super::store::pending_outbox(db, &job)? {
            "sync_pending"
        } else if pinned {
            "review_required"
        } else {
            "paused"
        };
        // Revoke leases without declaring a retained browser actor stopped.
        // Graph resets do not change journals, outbox receipts, or resource locks.
        db.execute(
            "UPDATE agent_jobs SET reconcile_only=?2,scope_json=NULL,
               plugin_generation=NULL,lease_until=0,steps=0,
               state=CASE WHEN state IN ('completed','blocked','cancelled','skipped')
                 THEN state ELSE ?3 END,
               phase=CASE WHEN state IN ('completed','blocked','cancelled','skipped')
                 THEN phase ELSE ?4 END,revision=revision+1,
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            params![
                job,
                pinned,
                state,
                if pinned {
                    "restart_reconcile"
                } else {
                    "workflow_upgrade"
                }
            ],
        )
        .map_err(storage_error)?;
        if !pinned {
            db.execute(
                "UPDATE agent_dispatch SET action='pause' WHERE job_id=?1 AND action='run'
                 AND EXISTS(SELECT 1 FROM agent_jobs j WHERE j.id=?1
                   AND j.state NOT IN ('completed','blocked','cancelled','skipped'))",
                [&job],
            )
            .map_err(storage_error)?;
        }
        super::execution::clear_checkpoints(db, &job)?;
    }
    db.execute(
        "INSERT INTO agent_execution_migrations(version) VALUES(5)",
        [],
    )
    .map_err(storage_error)?;
    Ok(())
}

fn extract_messages(db: &Connection, job: &str, snapshot: &Value) -> AgentResult<()> {
    let messages = snapshot["messages"]
        .as_array()
        .filter(|messages| messages.len() <= 100)
        .ok_or_else(|| storage_error("Invalid frozen recovery messages"))?;
    let states = legacy_states(db, job)?;
    for (index, message) in messages.iter().enumerate() {
        let operation = super::items::operation_id(job, &format!("message:{index}"));
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_actions
                 WHERE operation_id=?1 AND job_id=?2 AND kind='message')",
                params![operation, job],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            continue;
        }
        let conversation = numeric_id(&message["conversationId"])
            .ok_or_else(|| storage_error("Invalid frozen recovery conversation"))?;
        let text = bounded_copy(&message["text"], 4000)
            .ok_or_else(|| storage_error("Invalid frozen recovery message text"))?;
        let state = states.get(&index).unwrap_or(&Value::Null);
        let recovery = json!({
            "version":1,"mode":"reconcile_only","messageIndex":index,
            "conversationId":conversation,"text":text,
            "messageBaseline":message_baseline(state, conversation),
            "intentStartedAt":state["intentStartedAt"].as_str()
                .filter(|s| super::gateway::validate_timestamp(s).is_ok())
        });
        db.execute(
            "INSERT OR IGNORE INTO agent_message_recovery(operation_id,job_id,recovery_json)
             VALUES(?1,?2,?3)",
            params![operation, job, canonical(&recovery)],
        )
        .map_err(storage_error)?;
    }
    Ok(())
}

fn numeric_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 32
            && !s.starts_with('0')
            && s.bytes().all(|b| b.is_ascii_digit())
    })
}

fn message_baseline(state: &Value, conversation: &str) -> Value {
    let baseline = &state["messageBaseline"];
    if baseline.as_object().is_none_or(|o| o.len() != 3)
        || baseline["conversationId"].as_str() != Some(conversation)
        || baseline["messageIds"]
            .as_array()
            .is_none_or(|ids| ids.len() > 200 || ids.iter().any(|id| numeric_id(id).is_none()))
        || baseline["observedAt"]
            .as_str()
            .is_none_or(|s| super::gateway::validate_timestamp(s).is_err())
    {
        return Value::Null;
    }
    baseline.clone()
}

fn legacy_index(state: &Value) -> Option<usize> {
    if state["version"] != 1 {
        return None;
    }
    usize::try_from(state["index"].as_u64()?).ok()
}

fn legacy_states(db: &Connection, job: &str) -> AgentResult<BTreeMap<usize, Value>> {
    let mut statement = db
        .prepare(
            "SELECT ids.checkpoint_id,c.tuple_json FROM (
               SELECT checkpoint_id FROM agent_checkpoints WHERE job_id=?1 AND namespace=''
               UNION SELECT checkpoint_id FROM agent_pending_writes
                 WHERE job_id=?1 AND namespace='' AND channel='value') ids
             LEFT JOIN agent_checkpoints c
               ON c.job_id=?1 AND c.namespace='' AND c.checkpoint_id=ids.checkpoint_id
             ORDER BY ids.checkpoint_id DESC",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([job], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(storage_error)?;
    let mut states = BTreeMap::new();
    for row in rows {
        let (checkpoint_id, encoded) = row.map_err(storage_error)?;
        let tuple: Value = encoded
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(storage_error)?
            .unwrap_or(Value::Null);
        let mut checkpoint = BTreeMap::new();
        let state = &tuple["checkpoint"]["channel_values"]["value"];
        if let Some(index) = legacy_index(state) {
            checkpoint.insert(index, state.clone());
        }
        let mut pending = db
            .prepare(
                "SELECT value_json FROM agent_pending_writes
                 WHERE job_id=?1 AND namespace='' AND checkpoint_id=?2 AND channel='value'
                 ORDER BY task_path COLLATE BINARY,task_id COLLATE BINARY,write_index",
            )
            .map_err(storage_error)?;
        let values = pending
            .query_map(params![job, checkpoint_id], |r| r.get::<_, String>(0))
            .map_err(storage_error)?;
        let mut writes = BTreeMap::new();
        for value in values {
            let state: Value =
                serde_json::from_str(&value.map_err(storage_error)?).map_err(storage_error)?;
            if let Some(index) = legacy_index(&state) {
                // A completed node's durable value supersedes the checkpoint
                // input. Conflicting writes provide no unambiguous recovery copy.
                writes
                    .entry(index)
                    .and_modify(|saved| {
                        if *saved != state {
                            *saved = Value::Null;
                        }
                    })
                    .or_insert(state);
            }
        }
        checkpoint.extend(writes);
        for (index, state) in checkpoint {
            states.entry(index).or_insert(state);
        }
    }
    Ok(states)
}

fn bounded_copy(value: &Value, limit: usize) -> Option<&str> {
    value.as_str().filter(|s| s.encode_utf16().count() <= limit)
}

fn legacy_content(state: &Value, product: &Value) -> Value {
    if state.is_null() {
        return Value::Null;
    }
    let amendment = &state["amendments"][product["id"].as_str().unwrap_or("")];
    let final_field = |key: &str, limit: usize| {
        let reviewed = bounded_copy(&state[key], limit)?;
        if !reviewed.is_empty() {
            Some(reviewed)
        } else {
            bounded_copy(amendment.get(key).unwrap_or(&product[key]), limit)
        }
    };
    match (final_field("title", 500), final_field("description", 6000)) {
        (Some(title), Some(description)) => json!({"title":title,"description":description}),
        _ => Value::Null,
    }
}

fn legacy_baseline(state: &Value, snapshot: &Value) -> Value {
    let baseline = &state["listingBaseline"];
    let Some(object) = baseline.as_object() else {
        return Value::Null;
    };
    if object.len() != 3 {
        return Value::Null;
    }
    let Some(url_text) = baseline["url"].as_str().filter(|s| s.len() <= 4096) else {
        return Value::Null;
    };
    let Ok(url) = url::Url::parse(url_text) else {
        return Value::Null;
    };
    let Some(ids) = baseline["listingIds"].as_array().filter(|v| v.len() <= 200) else {
        return Value::Null;
    };
    if url.origin().ascii_serialization() != snapshot["platformOrigin"].as_str().unwrap_or("")
        || !url.username().is_empty()
        || url.password().is_some()
        || ids.iter().any(|id| {
            id.as_str().is_none_or(|s| {
                s.is_empty()
                    || s.len() > 32
                    || s.starts_with('0')
                    || !s.bytes().all(|b| b.is_ascii_digit())
            })
        })
        || baseline["observedAt"]
            .as_str()
            .is_none_or(|s| super::gateway::validate_timestamp(s).is_err())
    {
        return Value::Null;
    }
    baseline.clone()
}

pub(super) fn get(db: &Connection, job: &str, operation: &str) -> AgentResult<Option<Value>> {
    let encoded: Option<String> = db
        .query_row(
            "SELECT recovery_json FROM agent_action_recovery WHERE job_id=?1 AND operation_id=?2",
            params![job, operation],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    encoded
        .map(|s| serde_json::from_str(&s).map_err(storage_error))
        .transpose()
}

pub(super) fn get_message(
    db: &Connection,
    job: &str,
    operation: &str,
) -> AgentResult<Option<Value>> {
    let encoded: Option<String> = db
        .query_row(
            "SELECT recovery_json FROM agent_message_recovery WHERE job_id=?1 AND operation_id=?2",
            params![job, operation],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    encoded
        .map(|s| serde_json::from_str(&s).map_err(storage_error))
        .transpose()
}
