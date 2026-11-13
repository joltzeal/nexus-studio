use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::dto::*;
use super::sql::{read_u64, to_sql_i64};
use super::store::{AgentStore, Job, event, read_job};
use super::{AgentResult, canonical, conflict, denied, invalid, storage_error};

const MAX_CONTROLS_BYTES: usize = 800 * 1024;

pub(super) fn operation_id(job: &str, key: &str) -> String {
    let hash = Sha256::digest(format!("{job}\0{key}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

pub(super) fn prepare_item(db: &Connection, job: &Job, op: &str, kind: &str) -> AgentResult<()> {
    if kind != "listing" {
        return Ok(());
    }
    let product = job
        .snapshot
        .products
        .iter()
        .find(|p| {
            p["id"]
                .as_str()
                .is_some_and(|id| operation_id(&job.id, &format!("listing:{id}")) == op)
        })
        .ok_or_else(|| denied("Listing operation does not identify an assigned product"))?;
    let id = product["id"]
        .as_str()
        .ok_or_else(|| invalid("Invalid product identity"))?;
    let (action, revision, observed, submitted): (Option<String>, u64, u64, bool) = db
        .query_row(
            "SELECT control_action,control_revision,observed_revision,submitted FROM agent_items
         WHERE job_id=?1 AND product_id=?2",
            params![job.id, id],
            |r| Ok((r.get(0)?, read_u64(r, 1)?, read_u64(r, 2)?, r.get(3)?)),
        )
        .map_err(storage_error)?;
    if action.as_deref() == Some("skip") || revision != observed || submitted {
        return Err(conflict(
            "Item controls changed or the product already entered submission",
        ));
    }
    db.execute(
        "UPDATE agent_items SET operation_id=?3 WHERE job_id=?1 AND product_id=?2",
        params![job.id, id, op],
    )
    .map_err(storage_error)?;
    Ok(())
}

pub(super) fn submit_item(db: &Connection, job: &Job, op: &str) -> AgentResult<()> {
    if job.preset != Preset::PostListing {
        return Ok(());
    }
    let changed = db.execute(
        "UPDATE agent_items SET submitted=1,state='submitting' WHERE job_id=?1 AND operation_id=?2
         AND submitted=0 AND COALESCE(control_action,'')!='skip' AND control_revision=observed_revision",
        params![job.id,op],
    ).map_err(storage_error)?;
    if changed != 1 {
        return Err(conflict(
            "Item changed since review or has already been submitted",
        ));
    }
    Ok(())
}

pub(super) fn record_updates(db: &Connection, job: &Job, output: &StepOutput) -> AgentResult<()> {
    if output.item_updates.len() > 2 {
        return Err(invalid(
            "A graph step may update at most two assigned items",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for update in &output.item_updates {
        uuid(&update.product_id)?;
        text(&update.reason, 0, 1000)?;
        if !seen.insert(&update.product_id)
            || !matches!(
                update.state.as_str(),
                "pending"
                    | "reviewing"
                    | "preparing"
                    | "submitting"
                    | "published"
                    | "skipped"
                    | "review_required"
                    | "result_unknown"
                    | "sync_pending"
                    | "failed"
                    | "cancelled"
            )
        {
            return Err(invalid("Invalid item progress update"));
        }
        if let Some(title) = &update.title {
            text(title, 0, 500)?;
        }
        if let Some(description) = &update.description {
            text(description, 0, 6000)?;
        }
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_items WHERE job_id=?1 AND product_id=?2)",
                params![job.id, update.product_id],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(denied("Item update is outside the immutable assignment"));
        }
        // Publication and uncertain states are projected from the journal, never graph claims.
        db.execute(
            "UPDATE agent_items SET
             state=CASE
               WHEN EXISTS(SELECT 1 FROM agent_actions a WHERE a.operation_id=agent_items.operation_id AND a.state='confirmed')
                 THEN CASE WHEN EXISTS(SELECT 1 FROM agent_publication_outbox o WHERE o.operation_id=agent_items.operation_id AND o.state='review_required')
                      THEN 'review_required' WHEN EXISTS(SELECT 1 FROM agent_publication_outbox o WHERE o.operation_id=agent_items.operation_id AND o.state!='synced')
                      THEN 'sync_pending' ELSE 'published' END
               WHEN submitted=1 THEN 'result_unknown'
               WHEN control_action='skip' THEN 'skipped'
               WHEN ?3 IN ('published','sync_pending','submitting','result_unknown') THEN 'review_required'
               ELSE ?3 END,
             reason=?4,title=COALESCE(?5,title),description=COALESCE(?6,description)
             WHERE job_id=?1 AND product_id=?2 AND control_revision=observed_revision",
            params![job.id,update.product_id,update.state,update.reason,update.title,update.description],
        ).map_err(storage_error)?;
    }
    Ok(())
}

impl AgentStore {
    pub fn controls_get(&self, id: &str) -> AgentResult<Value> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        read_job(&tx, id)?;
        let result = controls(&tx, id)?;
        tx.execute(
            "UPDATE agent_items SET observed_revision=control_revision WHERE job_id=?1",
            [id],
        )
        .map_err(storage_error)?;
        // A revision read by the graph must not wake a later, unrelated review.
        tx.execute(
            "DELETE FROM agent_item_continuations WHERE job_id=?1 AND EXISTS(
               SELECT 1 FROM agent_items i WHERE i.job_id=agent_item_continuations.job_id
                 AND i.product_id=agent_item_continuations.product_id
                 AND i.observed_revision>=agent_item_continuations.revision)",
            [id],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn item_control(&self, input: &ItemControlInput) -> AgentResult<Value> {
        uuid(&input.job_id)?;
        uuid(&input.product_id)?;
        if !matches!(input.action.as_str(), "skip" | "revise" | "approve")
            || (input.action == "skip" && input.r#override.is_some())
            || (input.action == "revise"
                && input
                    .r#override
                    .as_ref()
                    .is_none_or(|v| v.as_object().is_none_or(|o| o.is_empty())))
        {
            return Err(invalid("Invalid unsubmitted item control"));
        }
        if let Some(value) = &input.r#override {
            validate_override(&input.product_id, value)?;
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let job = read_job(&tx, &input.job_id)?;
        if matches!(
            job.state.as_str(),
            "blocked" | "completed" | "cancelled" | "skipped"
        ) {
            return Err(denied(
                "Terminal or blocked jobs cannot accept item changes",
            ));
        }
        let row:Option<(bool,Option<String>,String)>=tx.query_row(
            "SELECT submitted,operation_id,state FROM agent_items WHERE job_id=?1 AND product_id=?2",
            params![input.job_id,input.product_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(storage_error)?;
        let Some((submitted, operation, state)) = row else {
            return Err(denied("Product is outside the job"));
        };
        if submitted
            || operation.is_some()
            || matches!(
                state.as_str(),
                "published" | "sync_pending" | "result_unknown" | "skipped" | "cancelled"
            )
        {
            return Err(conflict(
                "A durable action intent or submitted item can only be reconciled",
            ));
        }
        tx.execute(
            "UPDATE agent_dispatch SET item_revision=item_revision+1 WHERE job_id=?1",
            [&input.job_id],
        )
        .map_err(storage_error)?;
        let revision: u64 = tx
            .query_row(
                "SELECT item_revision FROM agent_dispatch WHERE job_id=?1",
                [&input.job_id],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        tx.execute(
            "UPDATE agent_items SET control_action=?3,control_revision=?4,
             override_json=CASE WHEN ?3='skip' THEN NULL ELSE json_patch(COALESCE(override_json,'{}'),COALESCE(?5,'{}')) END,
             state=CASE WHEN ?3='skip' THEN 'skipped' ELSE 'pending' END,reason='',
             title=COALESCE(json_extract(?5,'$.title'),title),
             description=COALESCE(json_extract(?5,'$.description'),description)
             WHERE job_id=?1 AND product_id=?2",
            params![
                input.job_id,
                input.product_id,
                input.action,
                to_sql_i64(revision)?,
                input.r#override.as_ref().map(canonical)
            ],
        )
        .map_err(storage_error)?;
        let result = controls(&tx, &job.id)?;
        // Preserve decisions accepted after a running step read its controls.
        let continuation = tx.execute(
            "INSERT INTO agent_item_continuations(job_id,product_id,revision)
             SELECT j.id,?2,?3 FROM agent_jobs j JOIN agent_batches b ON b.id=j.batch_id
               JOIN agent_dispatch d ON d.job_id=j.id JOIN agent_items i ON i.job_id=j.id AND i.product_id=?2
             WHERE j.id=?1 AND b.preset='post_listing' AND j.state IN ('running','review_required')
               AND j.reconcile_only=0 AND b.control='run' AND d.action='run'
               AND i.control_revision=?3 AND i.control_revision>i.observed_revision
               AND i.submitted=0 AND i.operation_id IS NULL
               AND NOT EXISTS(SELECT 1 FROM agent_actions WHERE job_id=?1 AND state IN ('prepared','unknown'))
               AND NOT EXISTS(SELECT 1 FROM agent_publication_outbox WHERE job_id=?1 AND state!='synced')
             ON CONFLICT(job_id) DO UPDATE SET product_id=excluded.product_id,revision=excluded.revision",
            params![job.id,input.product_id,to_sql_i64(revision)?],
        ).map_err(storage_error)?;
        if continuation == 1 {
            tx.execute(
                "UPDATE agent_dispatch SET control_retry_at=0 WHERE job_id=?1",
                [&job.id],
            )
            .map_err(storage_error)?;
            continue_after_item_control(&tx, &job.id)?;
        }
        event(
            &tx,
            &job.batch_id,
            Some(&job.id),
            "item.control_requested",
            &input.action,
        )?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn items(
        &self,
        id: &str,
        page: u32,
        page_size: u32,
        attention_only: bool,
    ) -> AgentResult<Value> {
        uuid(id)?;
        validate_page(page, page_size)?;
        let db = self.open()?;
        let job = read_job(&db, id)?;
        let predicate =
            "(?2=0 OR state IN ('review_required','result_unknown','sync_pending','failed'))";
        let total: u64 = db
            .query_row(
                &format!("SELECT COUNT(*) FROM agent_items WHERE job_id=?1 AND {predicate}"),
                params![id, attention_only],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        let mut stmt=db.prepare(&format!(
            "SELECT product_id,state,reason,title,description,submitted,control_revision,operation_id
             FROM agent_items WHERE job_id=?1 AND {predicate} ORDER BY ordinal LIMIT ?3 OFFSET ?4")).map_err(storage_error)?;
        let rows = stmt
            .query_map(
                params![
                    id,
                    attention_only,
                    page_size,
                    to_sql_i64(u64::from(page - 1) * u64::from(page_size))?
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, bool>(5)?,
                        read_u64(r, 6)?,
                        r.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let mut items = Vec::new();
        for (product, state, reason, title, description, submitted, revision, _) in rows {
            let original = job
                .snapshot
                .products
                .iter()
                .find(|p| p["id"].as_str() == Some(&product))
                .ok_or_else(|| invalid("Item projection has no immutable source"))?;
            let mut item = json!({"jobId":id,"productId":product,"windowId":job.snapshot.window_id,
                "windowName":job.snapshot.window_name,"accountId":job.snapshot.account_id()?,
                "state":state,"reason":reason,"originalTitle":original["title"],"originalDescription":original["description"],
                "title":title,"description":description,"submitted":submitted,"controlRevision":revision});
            if let Some(artifact) = original["images"][0]["artifactId"].as_str() {
                item["artifactId"] = json!(artifact);
            }
            items.push(item);
        }
        Ok(json!({"items":items,"total":total,"page":page,"pageSize":page_size}))
    }
}

fn controls(db: &Connection, id: &str) -> AgentResult<Value> {
    let revision: u64 = db
        .query_row(
            "SELECT item_revision FROM agent_dispatch WHERE job_id=?1",
            [id],
            |r| read_u64(r, 0),
        )
        .map_err(storage_error)?;
    let mut stmt = db
        .prepare(
            "SELECT product_id,control_action,control_revision,override_json FROM agent_items
        WHERE job_id=?1 AND control_action IS NOT NULL ORDER BY ordinal",
        )
        .map_err(storage_error)?;
    let rows = stmt
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                read_u64(r, 2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let mut items = Vec::new();
    for (product, action, rev, amendment) in rows {
        let mut item = json!({"productId":product,"action":action,"revision":rev});
        if let Some(value) = amendment {
            item["override"] = serde_json::from_str(&value).map_err(storage_error)?;
        }
        items.push(item);
    }
    let result = json!({"revision":revision,"items":items});
    if canonical(&result).len() > MAX_CONTROLS_BYTES {
        return Err(invalid(
            "Accumulated item controls exceed the 800 KiB UTF-8 JSON budget",
        ));
    }
    Ok(result)
}

pub(super) fn continue_after_item_control(db: &Connection, id: &str) -> AgentResult<()> {
    let changed = db.execute(
        "UPDATE agent_jobs SET state='queued',phase='item_control',message='',revision=revision+1,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?1 AND actor_owned=0 AND state='review_required' AND reconcile_only=0
           AND EXISTS(SELECT 1 FROM agent_batches b JOIN agent_dispatch d ON d.job_id=?1
             WHERE b.id=agent_jobs.batch_id AND b.preset='post_listing' AND b.control='run' AND d.action='run')
           AND EXISTS(SELECT 1 FROM agent_item_continuations c JOIN agent_items i
             ON i.job_id=c.job_id AND i.product_id=c.product_id
              WHERE c.job_id=?1 AND i.control_revision=c.revision AND i.control_revision>i.observed_revision
                AND i.submitted=0 AND i.operation_id IS NULL)
           AND NOT EXISTS(SELECT 1 FROM agent_actions WHERE job_id=?1 AND state IN ('prepared','unknown'))
           AND NOT EXISTS(SELECT 1 FROM agent_publication_outbox WHERE job_id=?1 AND state!='synced')",
        [id],
    ).map_err(storage_error)?;
    db.execute(
        "DELETE FROM agent_item_continuations WHERE job_id=?1
         AND EXISTS(SELECT 1 FROM agent_jobs WHERE id=?1 AND actor_owned=0)",
        [id],
    )
    .map_err(storage_error)?;
    if changed == 1 {
        event(
            db,
            &read_job(db, id)?.batch_id,
            Some(id),
            "job.item_continuation",
            "queued",
        )?;
    }
    Ok(())
}

pub(super) fn validate_override(id: &str, value: &Value) -> AgentResult<()> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("Item override must be an object"))?;
    if object.contains_key("productId") || object.values().any(Value::is_null) {
        return Err(invalid(
            "Item overrides contain only explicit editable values",
        ));
    }
    for value in object.values_mut() {
        if let Some(text) = value.as_str() {
            *value = json!(text.trim());
        }
    }
    object.insert("productId".into(), json!(id));
    let item: ProductOverride = serde_json::from_value(Value::Object(object))
        .map_err(|_| invalid("Invalid product override"))?;
    // Reuse the creation boundary for all text, price and currency limits.
    let input = BatchCreateInput {
        operation_id: Uuid::new_v4().to_string(),
        preset: Preset::PostListing,
        instruction: String::new(),
        concurrency: 1,
        assignments: vec![Assignment {
            window_id: Uuid::new_v4().to_string(),
            product_ids: vec![id.to_owned()],
            overrides: vec![item],
            messages: vec![],
        }],
    };
    validate_create(&input)
}
