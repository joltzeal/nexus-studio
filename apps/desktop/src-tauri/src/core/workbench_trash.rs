use super::{
    browser::provider::{BrowserError, BrowserResult},
    database::open_database,
    window_service::WindowService,
    window_store::now_seconds,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::{collections::HashSet, path::PathBuf, sync::Arc};
use tauri::State;

#[derive(Serialize)]
pub struct TrashEntry {
    id: String,
    name: String,
    folder: String,
    deleted_at: i64,
    // Explicit deletion only. No startup sweep or invented disk measurements.
    expires_at: Option<i64>,
    size_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct RestoredProfile {
    id: String,
    name: String,
}

fn storage(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法读写回收站，请重新读取结果")
}

pub(crate) fn ensure_schema(db: &mut Connection) -> Result<(), String> {
    let installed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='browser_profile_trash_immutable')",
        [], |row| row.get(0),
    ).map_err(|_| "无法读取回收站数据结构")?;
    if installed {
        return Ok(());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "无法初始化回收站数据结构")?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_profile_trash(
           profile_id TEXT PRIMARY KEY REFERENCES profile_records(id) ON DELETE CASCADE,
           connection_id TEXT NOT NULL REFERENCES browser_connections(id),
           deleted_at INTEGER NOT NULL CHECK(deleted_at>=0)
         );
         CREATE INDEX IF NOT EXISTS browser_profile_trash_connection
           ON browser_profile_trash(connection_id,deleted_at);
         CREATE TRIGGER IF NOT EXISTS browser_profile_trash_scope BEFORE INSERT ON browser_profile_trash
           WHEN NOT EXISTS(SELECT 1 FROM profile_records WHERE id=NEW.profile_id AND connection_id=NEW.connection_id)
           BEGIN SELECT RAISE(ABORT,'trash profile belongs to a different workspace'); END;
         CREATE TRIGGER IF NOT EXISTS browser_profile_trash_immutable BEFORE UPDATE ON browser_profile_trash
           BEGIN SELECT RAISE(ABORT,'trash marker is immutable'); END;",
    )
    .map_err(|_| "无法初始化回收站数据结构")?;
    tx.commit().map_err(|_| "无法保存回收站数据结构".into())
}

pub(crate) fn is_trashed(path: &PathBuf, id: &str) -> BrowserResult<bool> {
    open_database(path)
        .map_err(storage)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_profile_trash WHERE profile_id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(storage)
}

/// Filter the returned list after observation, retaining health/recovery for Trash records.
pub(crate) fn trashed_ids(
    path: &PathBuf,
    connection_id: Option<&str>,
) -> BrowserResult<HashSet<String>> {
    let db = open_database(path).map_err(storage)?;
    let mut query = db
        .prepare(
            "SELECT profile_id FROM browser_profile_trash WHERE ?1 IS NULL OR connection_id=?1",
        )
        .map_err(storage)?;
    query
        .query_map([connection_id], |row| row.get(0))
        .map_err(storage)?
        .collect::<Result<_, _>>()
        .map_err(storage)
}

fn require_connection(db: &Connection, id: &str) -> BrowserResult<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_connections WHERE id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if !exists {
        return Err(BrowserError::new(
            "connection_missing",
            "Workspace 接入不存在",
        ));
    }
    Ok(())
}

fn require_profile(db: &Connection, connection_id: &str, id: &str) -> BrowserResult<String> {
    db.query_row(
        "SELECT json_extract(record_json,'$.name') FROM profile_records WHERE id=?1 AND connection_id=?2",
        params![id, connection_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(storage)?
    .ok_or_else(|| BrowserError::new("scope_mismatch", "Profile 不存在或不属于当前 Workspace"))
}

/// Called under the WindowService Profile guard before preparing a permanent delete.
pub(crate) fn require_trashed(path: &PathBuf, connection_id: &str, id: &str) -> BrowserResult<()> {
    let db = open_database(path).map_err(storage)?;
    require_profile(&db, connection_id, id)?;
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM browser_profile_trash WHERE profile_id=?1 AND connection_id=?2)",
        params![id, connection_id], |row| row.get(0),
    ).map_err(storage)?;
    if !exists {
        return Err(BrowserError::new(
            "trash_missing",
            "Profile 已离开回收站，请刷新列表",
        ));
    }
    Ok(())
}

fn list(service: &WindowService, connection_id: &str) -> BrowserResult<Vec<TrashEntry>> {
    let mut db = open_database(&service.store.database_path()).map_err(storage)?;
    let tx = db.transaction().map_err(storage)?;
    require_connection(&tx, connection_id)?;
    let mut query = tx
        .prepare(
            "SELECT p.id,json_extract(p.record_json,'$.name'),COALESCE(g.name,''),t.deleted_at
         FROM browser_profile_trash t JOIN profile_records p ON p.id=t.profile_id
         LEFT JOIN groups g ON g.id=p.group_id AND g.connection_id=t.connection_id
         WHERE t.connection_id=?1 AND p.connection_id=?1 ORDER BY t.deleted_at DESC,p.id",
        )
        .map_err(storage)?;
    query
        .query_map([connection_id], |row| {
            Ok(TrashEntry {
                id: row.get(0)?,
                name: row.get(1)?,
                folder: row.get(2)?,
                deleted_at: row.get(3)?,
                expires_at: None,
                size_bytes: None,
            })
        })
        .map_err(storage)?
        .collect::<Result<_, _>>()
        .map_err(storage)
}

fn trash(
    service: &WindowService,
    connection_id: &str,
    ids: Vec<String>,
) -> BrowserResult<Vec<String>> {
    let ids = unique_ids(ids)?;
    {
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        require_connection(&db, connection_id)?;
        for id in &ids {
            require_profile(&db, connection_id, id)?;
        }
    }
    // Reserves the entire batch and obtains fresh stopped observations while held.
    // Unknown, missing, running, Agent-owned and pending Profiles fail before writes.
    let _guard = service.lock_transfer(&ids).map_err(|_| {
        BrowserError::new(
            "profile_busy",
            "请确认所有 Profile 已停止且没有待核对操作，再移入回收站",
        )
    })?;
    let mut db = open_database(&service.store.database_path()).map_err(storage)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    require_connection(&tx, connection_id)?;
    for id in &ids {
        require_profile(&tx, connection_id, id)?;
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_operations WHERE window_id=?1 AND phase NOT IN('committed','cancelled','failed'))",
            [id], |row| row.get(0),
        ).map_err(storage)?;
        if pending {
            return Err(BrowserError::new(
                "operation_pending",
                "Profile 操作仍待核对",
            ));
        }
        tx.execute(
            "INSERT INTO browser_profile_trash(profile_id,connection_id,deleted_at) VALUES(?1,?2,?3) ON CONFLICT(profile_id) DO NOTHING",
            params![id, connection_id, now_seconds()],
        ).map_err(storage)?;
    }
    tx.commit().map_err(storage)?;
    Ok(ids)
}

fn restore(
    service: &WindowService,
    connection_id: &str,
    id: &str,
) -> BrowserResult<RestoredProfile> {
    service.with_profile_trash_access(id, || {
        let mut db = open_database(&service.store.database_path()).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let name = require_profile(&tx, connection_id, id)?;
        // Idempotent after a lost response. The record and Folder/Tag relationships stay intact.
        tx.execute(
            "DELETE FROM browser_profile_trash WHERE profile_id=?1 AND connection_id=?2",
            params![id, connection_id],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(RestoredProfile {
            id: id.into(),
            name,
        })
    })
}

fn unique_ids(ids: Vec<String>) -> BrowserResult<Vec<String>> {
    if ids.len() > 10_000 || ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err()) {
        return Err(BrowserError::new("invalid_config", "Profile ID 列表无效"));
    }
    let mut seen = HashSet::new();
    Ok(ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect())
}

async fn run<T: Send + 'static>(
    job: impl FnOnce() -> BrowserResult<T> + Send + 'static,
) -> BrowserResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| {
            BrowserError::new("task_interrupted", "回收站操作中断，请重新读取并核对结果")
        })?
}

#[tauri::command]
pub async fn browser_trash_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<Vec<TrashEntry>> {
    let service = state.inner().clone();
    run(move || list(&service, &connection_id)).await
}

#[tauri::command]
pub async fn browser_profile_trash(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    ids: Vec<String>,
) -> BrowserResult<Vec<String>> {
    let service = state.inner().clone();
    run(move || trash(&service, &connection_id, ids)).await
}

#[tauri::command]
pub async fn browser_trash_restore(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    id: String,
) -> BrowserResult<RestoredProfile> {
    let service = state.inner().clone();
    run(move || restore(&service, &connection_id, &id)).await
}

#[tauri::command]
pub async fn browser_trash_purge(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    id: String,
) -> BrowserResult<()> {
    let service = state.inner().clone();
    run(move || service.delete_trashed_profile(&connection_id, &id)).await
}

#[tauri::command]
pub async fn browser_trash_empty(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    ids: Vec<String>,
) -> BrowserResult<usize> {
    let service = state.inner().clone();
    run(move || {
        let ids = unique_ids(ids)?;
        let db = open_database(&service.store.database_path()).map_err(storage)?;
        require_connection(&db, &connection_id)?;
        // Validate the whole confirmed snapshot before the first irreversible operation.
        for id in &ids {
            require_trashed(&service.store.database_path(), &connection_id, id)?;
        }
        for id in &ids {
            service.delete_trashed_profile(&connection_id, id)?;
        }
        Ok(ids.len())
    })
    .await
}
