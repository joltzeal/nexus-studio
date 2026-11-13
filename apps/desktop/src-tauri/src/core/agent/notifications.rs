use rusqlite::{TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

use super::service::AgentService;
use super::store::{AgentStore, batch_view, strings};
use super::{AgentResult, canonical, host_error, invalid, now_ms, storage_error};
use crate::core::plugin_host::manifest::Capability;

impl AgentStore {
    pub fn due_notifications(&self) -> AgentResult<Vec<Value>> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let ids=strings(&tx,
            "SELECT b.id FROM agent_batches b WHERE json_extract(settings_json,'$.notifications.enabled')=1
             AND ((COALESCE(json_extract(settings_json,'$.notifications.onAttention'),1)=1
               AND EXISTS(SELECT 1 FROM agent_jobs j WHERE j.batch_id=b.id AND j.state IN
                   ('blocked','review_required','result_unknown','sync_pending','failed'))
               AND NOT EXISTS(SELECT 1 FROM agent_notification_outbox n WHERE n.batch_id=b.id AND n.kind='attention'))
              OR (COALESCE(json_extract(settings_json,'$.notifications.onCompleted'),1)=1
               AND NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.batch_id=b.id AND j.state NOT IN ('completed','cancelled','skipped'))
               AND NOT EXISTS(SELECT 1 FROM agent_notification_outbox n WHERE n.batch_id=b.id AND n.kind='completed')))
             ORDER BY b.updated_at DESC LIMIT 100",[])?;
        for id in ids {
            let batch = batch_view(&tx, &id)?;
            let kind = match batch["state"].as_str() {
                Some("needs_attention") => "attention",
                Some("completed" | "cancelled") => "completed",
                _ => continue,
            };
            let settings:String=tx.query_row("SELECT json_extract(settings_json,'$.notifications') FROM agent_batches WHERE id=?1",
                [&id],|r|r.get(0)).map_err(storage_error)?;
            let settings: Value = serde_json::from_str(&settings).map_err(storage_error)?;
            let flag = if kind == "attention" {
                "onAttention"
            } else {
                "onCompleted"
            };
            if settings[flag] == false {
                continue;
            }
            let notification_id = Uuid::new_v4().to_string();
            let payload = json!({"notificationId":notification_id,"batchId":id,"kind":kind,"settings":settings,
                "title":if kind=="attention" {"销售任务需要处理"}else{"销售任务已结束"},
                "body":format!("已完成 {}/{} 个窗口，{} 个需处理。打开 Raccoon 查看执行结果。",
                    batch["completed"],batch["total"],batch["attention"])});
            tx.execute(
                "INSERT OR IGNORE INTO agent_notification_outbox(notification_id,batch_id,kind,payload_json)
                 VALUES(?1,?2,?3,?4)",params![notification_id,id,kind,canonical(&payload)],
            ).map_err(storage_error)?;
        }
        let ids=strings(&tx,
            "SELECT notification_id FROM agent_notification_outbox WHERE state='pending' AND attempts<4
             AND next_attempt<=?1 ORDER BY next_attempt,notification_id LIMIT 10",[now_ms()])?;
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            let payload: String = tx
                .query_row(
                    "SELECT payload_json FROM agent_notification_outbox WHERE notification_id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            // Reserve the delivery before calling Node. A crash retries the same durable ID.
            tx.execute(
                "UPDATE agent_notification_outbox SET attempts=attempts+1,next_attempt=?2 WHERE notification_id=?1",
                params![id,now_ms()+120_000],
            ).map_err(storage_error)?;
            result.push(serde_json::from_str(&payload).map_err(storage_error)?);
        }
        tx.execute("UPDATE agent_notification_outbox SET state='failed' WHERE state='pending' AND attempts>=4 AND next_attempt<=?1",
            [now_ms()]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn notification_result(&self, id: &str, error: Option<&str>) -> AgentResult<()> {
        let db = self.open()?;
        db.execute(
            "UPDATE agent_notification_outbox SET
             state=CASE WHEN ?2 IS NULL THEN 'sent' WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
             next_attempt=?3+MIN(300000,2000*(1 << MIN(attempts,7))),last_error=COALESCE(?2,'')
             WHERE notification_id=?1 AND state!='sent'",
            params![id,error,now_ms()],
        ).map_err(storage_error)?;
        Ok(())
    }
}

impl AgentService {
    pub(super) fn flush_notifications(&self) {
        let Ok(items) = self.store.due_notifications() else {
            return;
        };
        for item in items {
            let Some(id) = item["notificationId"].as_str() else {
                continue;
            };
            let result = self
                .host()
                .and_then(|host| {
                    host.call(
                        "studio.sales-agent",
                        Capability::SalesAgent,
                        "salesAgent.notifications.send",
                        item.clone(),
                        std::time::Duration::from_secs(30),
                    )
                    .map_err(host_error)
                })
                .and_then(|reply| {
                    if reply["delivered"] != true || reply["notificationId"].as_str() != Some(id) {
                        return Err(invalid("Notification sender returned an invalid receipt"));
                    }
                    Ok(())
                });
            let _ = self
                .store
                .notification_result(id, result.as_ref().err().map(|e| e.code.as_str()));
        }
    }
}
