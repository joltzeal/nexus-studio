use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

use super::dto::*;
use super::sql::{read_u64, to_sql_i64};
use super::store::AgentStore;
use super::{AgentResult, canonical, conflict, invalid, storage_error};

impl AgentStore {
    pub fn workspace_list(
        &self,
        kind: Option<&str>,
        page: u32,
        page_size: u32,
    ) -> AgentResult<Value> {
        validate_page(page, page_size)?;
        if let Some(kind) = kind {
            validate_kind(kind)?;
        }
        let db = self.open()?;
        let total: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_workspace WHERE (?1 IS NULL OR kind=?1)",
                [kind],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        let ids = super::store::strings(
            &db,
            "SELECT id FROM agent_workspace WHERE (?1 IS NULL OR kind=?1)
             ORDER BY updated_at DESC,id LIMIT ?2 OFFSET ?3",
            params![
                kind,
                page_size,
                to_sql_i64(u64::from(page - 1) * u64::from(page_size))?
            ],
        )?;
        let mut items = Vec::with_capacity(ids.len());
        for id in ids {
            let mut entry = entry(&db, &id)?;
            entry
                .as_object_mut()
                .ok_or_else(|| invalid("Invalid workspace entry"))?
                .remove("data");
            items.push(entry);
        }
        Ok(json!({"items":items,"total":total,"page":page,"pageSize":page_size}))
    }

    pub fn workspace_get(&self, id: &str) -> AgentResult<Value> {
        uuid(id)?;
        entry(&self.open()?, id)
    }

    pub fn workspace_save(&self, input: &WorkspaceSave) -> AgentResult<Value> {
        uuid(&input.id)?;
        validate_kind(&input.kind)?;
        text(input.name.trim(), 1, 120)?;
        if input.expected_revision >= 9_007_199_254_740_991 {
            return Err(invalid("Workspace revision exceeds its limit"));
        }
        validate_plan(&input.data)?;
        let data = canonical(&serde_json::to_value(&input.data).map_err(storage_error)?);
        if data.len() > 800 * 1024 {
            return Err(invalid("Saved plan exceeds the bounded workspace payload"));
        }
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let saved: Option<(u64, String)> = tx
            .query_row(
                "SELECT revision,kind FROM agent_workspace WHERE id=?1",
                [&input.id],
                |r| Ok((read_u64(r, 0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        if saved.as_ref().map_or(0, |s| s.0) != input.expected_revision
            || saved.as_ref().is_some_and(|s| s.1 != input.kind)
        {
            return Err(conflict(
                "Workspace entry changed; reload its current revision",
            ));
        }
        tx.execute(
            "INSERT INTO agent_workspace(id,kind,name,data_json,revision) VALUES(?1,?2,?3,?4,1)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,
             revision=agent_workspace.revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![input.id, input.kind, input.name.trim(), data],
        )
        .map_err(storage_error)?;
        let result = entry(&tx, &input.id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn workspace_delete(&self, id: &str, expected_revision: u64) -> AgentResult<Value> {
        uuid(id)?;
        if expected_revision == 0 || expected_revision > 9_007_199_254_740_991 {
            return Err(invalid("Expected a saved workspace revision"));
        }
        let changed = self
            .open()?
            .execute(
                "DELETE FROM agent_workspace WHERE id=?1 AND revision=?2",
                params![id, to_sql_i64(expected_revision)?],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(conflict("Workspace entry changed or was deleted"));
        }
        Ok(json!({"deleted":true,"id":id}))
    }
}

fn entry(db: &Connection, id: &str) -> AgentResult<Value> {
    let row=db.query_row("SELECT kind,name,data_json,revision,created_at,updated_at FROM agent_workspace WHERE id=?1",
        [id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
        read_u64(r, 3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))
        .optional().map_err(storage_error)?.ok_or_else(||invalid("Workspace entry was not found"))?;
    let data: Value = serde_json::from_str(&row.2).map_err(storage_error)?;
    Ok(
        json!({"id":id,"kind":row.0,"name":row.1,"data":data,"revision":row.3,"createdAt":row.4,"updatedAt":row.5}),
    )
}

fn validate_kind(value: &str) -> AgentResult<()> {
    if !matches!(value, "draft" | "template") {
        return Err(invalid("Unsupported workspace kind"));
    }
    Ok(())
}

fn validate_plan(plan: &SavedPlan) -> AgentResult<()> {
    text(&plan.instruction, 0, 4000)?;
    if !(1..=10).contains(&plan.concurrency)
        || plan.product_ids.len() > 100
        || plan.window_ids.len() > 100
        || plan.assignments.len() > 100
        || plan.unassigned_overrides.len() > 100
    {
        return Err(invalid("Saved plan exceeds its bounds"));
    }
    let products = unique(&plan.product_ids)?;
    let windows = unique(&plan.window_ids)?;
    let mut assigned = HashSet::new();
    let mut targets = HashSet::new();
    let mut message_count = 0usize;
    for a in &plan.assignments {
        if !windows.contains(&a.window_id)
            || !targets.insert(&a.window_id)
            || a.product_ids.len() > 100
            || a.overrides.len() > 100
            || a.messages.len() > 100
        {
            return Err(invalid(
                "Saved assignments must belong to distinct selected windows",
            ));
        }
        for id in &a.product_ids {
            if !products.contains(id) || !assigned.insert(id) {
                return Err(invalid("Saved product assignment is missing or duplicated"));
            }
        }
        let mut overrides = HashSet::new();
        for item in &a.overrides {
            if !a.product_ids.contains(&item.product_id) || !overrides.insert(&item.product_id) {
                return Err(invalid(
                    "Saved overrides must refer to distinct assigned products",
                ));
            }
            validate_saved_override(item)?;
        }
        for message in &a.messages {
            message_count += 1;
            if message_count > 100 {
                return Err(invalid("Saved plans support at most 100 messages in total"));
            }
            text(&message.conversation_id, 1, 32)?;
            text(message.text.trim(), 1, 4000)?;
            if !message.conversation_id.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid("Invalid conversation ID"));
            }
        }
    }
    let mut unassigned = HashSet::new();
    for item in &plan.unassigned_overrides {
        if !products.contains(&item.product_id)
            || assigned.contains(&item.product_id)
            || !unassigned.insert(&item.product_id)
        {
            return Err(invalid(
                "Unassigned edits must belong to distinct selected products without a window assignment",
            ));
        }
        validate_saved_override(item)?;
    }
    Ok(())
}

fn validate_saved_override(item: &ProductOverride) -> AgentResult<()> {
    let mut value = serde_json::to_value(item).map_err(storage_error)?;
    value
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid product override"))?
        .remove("productId");
    super::items::validate_override(&item.product_id, &value)
}

fn unique(values: &[String]) -> AgentResult<HashSet<&String>> {
    let mut set = HashSet::new();
    for id in values {
        uuid(id)?;
        if !set.insert(id) {
            return Err(invalid("Saved relation IDs must be unique"));
        }
    }
    Ok(set)
}
