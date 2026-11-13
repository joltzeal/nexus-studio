use rusqlite::params;
use serde_json::{Value, json};

use super::dto::*;
use super::sql::{read_u64, to_sql_i64};
use super::store::AgentStore;
use super::{AgentResult, invalid, storage_error};

const RELATED: &str =
    "(?1='attention' AND j.state IN ('blocked','review_required','result_unknown','sync_pending','failed'))
     OR (?1='window' AND (json_extract(j.snapshot_json,'$.windowId')=?2 OR EXISTS(
         SELECT 1 FROM agent_actions a WHERE a.job_id=j.id AND json_extract(a.result_json,'$.windowId')=?2)))
     OR (?1='account' AND json_extract(j.snapshot_json,'$.account.accountId')=?2)
     OR (?1='product' AND (EXISTS(SELECT 1 FROM agent_product_assignments p WHERE p.job_id=j.id AND p.product_id=?2)
         OR EXISTS(SELECT 1 FROM json_each(j.snapshot_json,'$.products') p WHERE json_extract(p.value,'$.id')=?2)
         OR EXISTS(SELECT 1 FROM agent_actions a WHERE a.job_id=j.id AND json_extract(a.result_json,'$.productId')=?2)))";

impl AgentStore {
    pub fn related(&self, kind: &str, id: &str, page: u32, page_size: u32) -> AgentResult<Value> {
        if !matches!(kind, "product" | "window" | "account" | "attention") {
            return Err(invalid("Unsupported execution relation"));
        }
        if kind != "attention" {
            uuid(id)?;
        }
        validate_page(page, page_size)?;
        let db = self.open()?;
        let total: u64 = db
            .query_row(
                &format!("SELECT COUNT(*) FROM agent_jobs j WHERE {RELATED}"),
                params![kind, id],
                |r| read_u64(r, 0),
            )
            .map_err(storage_error)?;
        let ids = super::store::strings(
            &db,
            &format!(
                "SELECT j.id FROM agent_jobs j WHERE {RELATED} ORDER BY j.updated_at DESC,j.id DESC LIMIT ?3 OFFSET ?4"
            ),
            params![
                kind,
                id,
                page_size,
                to_sql_i64(u64::from(page - 1) * u64::from(page_size))?
            ],
        )?;
        let mut items = Vec::with_capacity(ids.len());
        for id in ids {
            let job = super::store::read_job(&db, &id)?;
            let view = super::controls::job_view(&db, &id)?;
            let mut row = json!({"batchId":job.batch_id,"jobId":id,"windowId":view["windowId"],
                "windowName":view["windowName"],"accountId":view["accountId"],"account":view["account"],
                "state":view["state"],"phase":view["phase"],"message":view["message"],"updatedAt":view["updatedAt"]});
            if let Some(product) = view["progress"]["currentProductId"].as_str() {
                row["currentProductId"] = json!(product);
            }
            items.push(row);
        }
        Ok(json!({"items":items,"total":total,"page":page,"pageSize":page_size}))
    }
}
