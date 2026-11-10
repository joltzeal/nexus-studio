use super::provider::{BrowserError, BrowserResult, WindowState};
use crate::core::{database::open_database, window_store::now_seconds};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationResolution {
    pub action: String,
    pub provider_profile_id: Option<String>,
    pub observed_state: Option<WindowState>,
    pub confirmed_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserOperation {
    pub id: String,
    pub window_id: String,
    pub connection_id: String,
    pub kind: String,
    pub phase: String,
    pub message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub request_hash: String,
    pub payload: Value,
    pub resolution: Option<OperationResolution>,
}
pub struct OperationStore {
    path: PathBuf,
}
fn error(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法保存浏览器操作状态")
}
fn conflict() -> BrowserError {
    BrowserError::new("operation_conflict", "同一操作不能使用不同的请求内容")
}

fn read_operation(db: &Connection, id: &str) -> BrowserResult<Option<BrowserOperation>> {
    let text: Option<String> = db
        .query_row(
            "SELECT record_json FROM browser_operations WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)?;
    text.map(|text| {
        let record: BrowserOperation = serde_json::from_str(&text).map_err(error)?;
        if record.id != id {
            return Err(error("operation identity mismatch"));
        }
        Ok(record)
    })
    .transpose()
}

fn write_operation(db: &Connection, record: &BrowserOperation) -> BrowserResult<()> {
    db.execute(
        "INSERT INTO browser_operations(id,window_id,connection_id,kind,phase,record_json) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,record_json=excluded.record_json",
        params![record.id,record.window_id,record.connection_id,record.kind,record.phase,serde_json::to_string(record).map_err(error)?],
    )
    .map_err(error)?;
    Ok(())
}

impl OperationStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    pub fn get(&self, id: &str) -> BrowserResult<Option<BrowserOperation>> {
        let db = open_database(&self.path).map_err(error)?;
        read_operation(&db, id)
    }
    pub fn prepare(
        &self,
        id: &str,
        window_id: &str,
        connection_id: &str,
        kind: &str,
        payload: Value,
    ) -> BrowserResult<BrowserOperation> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| BrowserError::new("invalid_config", "操作 ID 无效"))?;
        let request_hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&payload).map_err(error)?)
        );
        let mut db = open_database(&self.path).map_err(error)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        if let Some(previous) = read_operation(&tx, id)? {
            if previous.request_hash != request_hash
                || previous.window_id != window_id
                || previous.connection_id != connection_id
                || previous.kind != kind
            {
                return Err(conflict());
            }
            return Ok(previous);
        }
        let now = now_seconds();
        let record = BrowserOperation {
            id: id.into(),
            window_id: window_id.into(),
            connection_id: connection_id.into(),
            kind: kind.into(),
            phase: "prepared".into(),
            message: None,
            created_at: now,
            updated_at: now,
            request_hash,
            payload,
            resolution: None,
        };
        write_operation(&tx, &record)?;
        tx.commit().map_err(error)?;
        Ok(record)
    }
    pub fn write(&self, record: &BrowserOperation) -> BrowserResult<()> {
        let mut db = open_database(&self.path).map_err(error)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        if let Some(previous) = read_operation(&tx, &record.id)? {
            let mut previous_request = previous.payload;
            let mut request = record.payload.clone();
            // Only creation can enrich its reserved draft with a provider identity.
            if previous.kind == "create" {
                for payload in [&mut previous_request, &mut request] {
                    if let Some(fields) = payload.as_object_mut() {
                        fields.remove("record");
                    }
                }
            }
            if previous.window_id != record.window_id
                || previous.connection_id != record.connection_id
                || previous.kind != record.kind
                || previous.request_hash != record.request_hash
                || previous.created_at != record.created_at
                || previous_request != request
                || (previous.resolution.is_some() && previous.resolution != record.resolution)
                || (matches!(previous.phase.as_str(), "committed" | "cancelled")
                    && previous.phase != record.phase)
            {
                return Err(conflict());
            }
        }
        write_operation(&tx, record)?;
        tx.commit().map_err(error)
    }
    pub fn phase(
        &self,
        record: &mut BrowserOperation,
        phase: &str,
        message: Option<String>,
    ) -> BrowserResult<()> {
        let mut updated = record.clone();
        updated.phase = phase.into();
        updated.message = message;
        updated.updated_at = now_seconds();
        self.write(&updated)?;
        *record = updated;
        Ok(())
    }
    pub fn list(&self, connection: Option<&str>) -> BrowserResult<Vec<BrowserOperation>> {
        let db = open_database(&self.path).map_err(error)?;
        let mut query=db.prepare("SELECT record_json FROM browser_operations WHERE (?1 IS NULL OR connection_id=?1) AND phase NOT IN('committed','failed','cancelled') ORDER BY rowid DESC").map_err(error)?;
        let collected = query
            .query_map([connection], |r| r.get::<_, String>(0))
            .map_err(error)?
            .map(|row| serde_json::from_str(&row.map_err(error)?).map_err(error))
            .collect();
        collected
    }
    pub fn window_pending(&self, id: &str) -> BrowserResult<bool> {
        Ok(self.list(None)?.iter().any(|op| op.window_id == id))
    }
    pub fn resolve(
        &self,
        record: &mut BrowserOperation,
        resolution: OperationResolution,
        phase: &str,
    ) -> BrowserResult<()> {
        if !matches!(record.phase.as_str(), "submitted" | "uncertain")
            || record.resolution.is_some()
            || !matches!(
                (resolution.action.as_str(), phase),
                ("associate", "confirmed") | ("abandon", "cancelled")
            )
        {
            return Err(conflict());
        }
        let mut updated = record.clone();
        updated.resolution = Some(resolution);
        updated.phase = phase.into();
        updated.message = None;
        updated.updated_at = now_seconds();
        self.write(&updated)?;
        *record = updated;
        Ok(())
    }
}
