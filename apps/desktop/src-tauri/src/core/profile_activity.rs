use crate::core::browser::provider::{BrowserError, BrowserResult, WindowState};
use crate::core::database::open_database;
use crate::core::window_store::now_seconds;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileActivity {
    pub launches: u64,
    pub total_runtime_ms: u64,
}

fn failure(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法读取或保存 Profile 活动")
}

pub fn observe(path: &PathBuf, id: &str, state: WindowState) -> BrowserResult<ProfileActivity> {
    let mut database = open_database(path).map_err(failure)?;
    database
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS profile_activity(
            profile_id TEXT PRIMARY KEY REFERENCES profile_records(id) ON DELETE CASCADE,
            launches INTEGER NOT NULL DEFAULT 0,
            total_ms INTEGER NOT NULL DEFAULT 0,
            running_since INTEGER,
            last_running INTEGER
        );",
        )
        .map_err(failure)?;
    let transaction = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    let row: Option<(i64, i64, Option<i64>, Option<i64>)> = transaction.query_row(
        "SELECT launches,total_ms,running_since,last_running FROM profile_activity WHERE profile_id=?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(failure)?;
    let (mut launches, mut total, mut since, mut last_running) = row.unwrap_or((0, 0, None, None));
    let now = now_seconds();
    match state {
        WindowState::Running => {
            if since.is_none() {
                since = Some(now);
                launches = launches.saturating_add(1);
            }
            last_running = Some(now);
        }
        WindowState::Stopped => {
            if let Some(start) = since.take() {
                total = total.saturating_add(
                    last_running
                        .unwrap_or(start)
                        .saturating_sub(start)
                        .max(0)
                        .saturating_mul(1000),
                );
            }
            last_running = None;
        }
        _ => {}
    }
    transaction.execute(
        "INSERT INTO profile_activity(profile_id,launches,total_ms,running_since,last_running) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(profile_id) DO UPDATE SET launches=excluded.launches,total_ms=excluded.total_ms,running_since=excluded.running_since,last_running=excluded.last_running",
        params![id, launches, total, since, last_running],
    ).map_err(failure)?;
    transaction.commit().map_err(failure)?;
    let active = since.zip(last_running).map_or(0, |(start, end)| {
        end.saturating_sub(start).max(0).saturating_mul(1000)
    });
    Ok(ProfileActivity {
        launches: launches.max(0) as u64,
        total_runtime_ms: total.saturating_add(active).max(0) as u64,
    })
}
