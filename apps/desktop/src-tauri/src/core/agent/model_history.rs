use rusqlite::params;
use serde_json::{Value, json};

use super::dto::{uuid, validate_page};
use super::sql::{read_optional_u64, read_u64, to_sql_i64};
use super::store::AgentStore;
use super::{AgentResult, now_ms, storage_error};

const HISTORY_QUERY: &str = "SELECT request_id,job_id,kind,
       CASE WHEN receipt_json IS NULL AND deadline<=?2 THEN 'unknown' ELSE state END,
       strftime('%Y-%m-%dT%H:%M:%fZ',acquired_at/1000.0,'unixepoch'),
       elapsed_ms,input_tokens,output_tokens,cost_usd,json_extract(receipt_json,'$.status')
     FROM agent_model_requests WHERE batch_id=?1
     ORDER BY acquired_at DESC,request_id DESC LIMIT ?3 OFFSET ?4";

impl AgentStore {
    pub fn model_requests(&self, id: &str, page: u32, page_size: u32) -> AgentResult<Value> {
        uuid(id)?;
        validate_page(page, page_size)?;
        let mut db = self.open()?;
        // Keep count and rows in one read snapshot while other jobs record usage.
        let tx = db.transaction().map_err(storage_error)?;
        super::store::batch_view(&tx, id)?;
        let total: u64 = tx
            .query_row(
                "SELECT COUNT(*) FROM agent_model_requests WHERE batch_id=?1",
                [id],
                |row| read_u64(row, 0),
            )
            .map_err(storage_error)?;
        let items = {
            let mut statement = tx.prepare(HISTORY_QUERY).map_err(storage_error)?;
            let rows = statement
                .query_map(
                    params![
                        id,
                        now_ms(),
                        page_size,
                        to_sql_i64(u64::from(page - 1) * u64::from(page_size))?
                    ],
                    |row| -> rusqlite::Result<Value> {
                        Ok(json!({
                            "requestId":row.get::<_,String>(0)?,
                            "jobId":row.get::<_,String>(1)?,
                            "kind":row.get::<_,String>(2)?,
                            "state":row.get::<_,String>(3)?,
                            "startedAt":row.get::<_,String>(4)?,
                            "elapsedMs":read_u64(row, 5)?,
                            "inputTokens":read_optional_u64(row, 6)?,
                            "outputTokens":read_optional_u64(row, 7)?,
                            "estimatedCostUsd":row.get::<_,Option<f64>>(8)?,
                            "status":row.get::<_,Option<u16>>(9)?
                        }))
                    },
                )
                .map_err(storage_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
        };
        tx.commit().map_err(storage_error)?;
        Ok(json!({"batchId":id,"items":items,"total":total,"page":page,"pageSize":page_size}))
    }
}
