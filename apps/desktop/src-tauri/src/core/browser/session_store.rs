use super::provider::{BrowserError, BrowserResult, WindowState};
use crate::core::{database::open_database, window_store::now_seconds};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionObservation {
    pub state: WindowState,
    pub observed_at: i64,
    pub nexus_started: bool,
}
pub struct SessionStore {
    path: PathBuf,
}
fn error(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法保存窗口观察状态")
}
impl SessionStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    pub fn get(&self, id: &str) -> BrowserResult<Option<SessionObservation>> {
        let text: Option<String> = open_database(&self.path)
            .map_err(error)?
            .query_row(
                "SELECT record_json FROM browser_session_observations WHERE window_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        text.map(|text| serde_json::from_str(&text).map_err(error))
            .transpose()
    }
    pub fn set(&self, id: &str, state: WindowState, nexus_started: bool) -> BrowserResult<()> {
        let observation = SessionObservation {
            state,
            observed_at: now_seconds(),
            nexus_started,
        };
        open_database(&self.path)
            .map_err(error)?
            .execute(
                "INSERT INTO browser_session_observations(window_id,record_json) VALUES(?1,?2)
             ON CONFLICT(window_id) DO UPDATE SET record_json=excluded.record_json",
                params![id, serde_json::to_string(&observation).map_err(error)?],
            )
            .map_err(error)?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> BrowserResult<()> {
        open_database(&self.path)
            .map_err(error)?
            .execute(
                "DELETE FROM browser_session_observations WHERE window_id=?1",
                [id],
            )
            .map_err(error)?;
        Ok(())
    }
}
