use super::engine::model::Project;
use crate::core::browser::provider::{BrowserError, BrowserResult};
use crate::core::database::open_database;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

const PROJECT_LIMIT: usize = 8 * 1024 * 1024;

pub(crate) fn storage_error(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new(
        "storage_failed",
        "Unable to read or persist automation data",
    )
}

pub(crate) fn invalid(message: impl Into<String>) -> BrowserError {
    BrowserError::new("invalid_config", message)
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn to_sql_i64(value: u64) -> BrowserResult<i64> {
    i64::try_from(value).map_err(|_| invalid("Unsigned integer exceeds the SQLite integer range"))
}

fn read_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

#[derive(Clone)]
pub struct AutomationStore {
    database: Arc<Mutex<Connection>>,
    pub modules_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceIssue {
    pub path: String,
    pub kind: String,
    pub reference: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub connection_id: String,
    pub operation_id: String,
    pub project_id: String,
    pub phase: String,
    pub snapshot: Value,
    pub state: Value,
}

/// The intent is committed before the engine gets permission to dispatch.
#[derive(Debug)]
pub enum RunIntent {
    Created(RunRecord),
    Existing(RunRecord),
}

pub enum ActionIntent {
    New,
    Completed(Value),
    Rejected(BrowserError),
}

/// Action id, phase, input payload, and optional recorded result.
pub type ActionRecord = (String, String, Value, Option<Value>);

impl AutomationStore {
    pub fn open(path: PathBuf, modules_dir: PathBuf) -> BrowserResult<Self> {
        let database = open_database(&path).map_err(storage_error)?;
        let store = Self {
            database: Arc::new(Mutex::new(database)),
            modules_dir,
        };
        store.ensure_schema()?;
        std::fs::create_dir_all(&store.modules_dir).map_err(storage_error)?;
        Ok(store)
    }

    fn database(&self) -> BrowserResult<MutexGuard<'_, Connection>> {
        self.database.lock().map_err(storage_error)
    }

    fn ensure_schema(&self) -> BrowserResult<()> {
        self.database()?
            .execute_batch(
                "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS automation_projects(
               id TEXT PRIMARY KEY,
               connection_id TEXT NOT NULL REFERENCES browser_connections(id),
               version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
               revision INTEGER NOT NULL,
               project_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS automation_project_scope
               ON automation_projects(connection_id,updated_at,id);
             CREATE TRIGGER IF NOT EXISTS automation_project_binding
               BEFORE UPDATE OF id,connection_id ON automation_projects
               WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id
               BEGIN SELECT RAISE(ABORT,'automation project binding is immutable'); END;
             CREATE TABLE IF NOT EXISTS automation_runs(
               id TEXT PRIMARY KEY,
               connection_id TEXT NOT NULL REFERENCES browser_connections(id),
               operation_id TEXT NOT NULL,
               project_id TEXT NOT NULL,
               phase TEXT NOT NULL,
               snapshot_json TEXT NOT NULL,
               state_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               UNIQUE(connection_id,operation_id)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS automation_one_active_run
               ON automation_runs(connection_id,project_id)
               WHERE phase IN('intent','running','stopping','reconciling');
             CREATE INDEX IF NOT EXISTS automation_run_scope
               ON automation_runs(connection_id,project_id,updated_at);
             CREATE TABLE IF NOT EXISTS automation_actions(
               run_id TEXT NOT NULL REFERENCES automation_runs(id),
               action_id TEXT NOT NULL,
               phase TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               result_json TEXT,
               PRIMARY KEY(run_id,action_id)
             );
             CREATE TABLE IF NOT EXISTS automation_run_cancellations(
               run_id TEXT PRIMARY KEY REFERENCES automation_runs(id),
               requested_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS automation_action_steps(
               run_id TEXT NOT NULL,
               action_id TEXT NOT NULL,
               intent_id TEXT NOT NULL,
               PRIMARY KEY(run_id,action_id)
             );
             CREATE TABLE IF NOT EXISTS automation_action_operations(
               run_id TEXT NOT NULL,
               action_id TEXT NOT NULL,
               operation_id TEXT NOT NULL,
               PRIMARY KEY(run_id,action_id,operation_id)
             );
             CREATE TABLE IF NOT EXISTS automation_operation_baselines(
               run_id TEXT NOT NULL,action_id TEXT NOT NULL,ids_json TEXT NOT NULL,
               PRIMARY KEY(run_id,action_id)
             );
             CREATE TABLE IF NOT EXISTS automation_steps(
               run_id TEXT NOT NULL REFERENCES automation_runs(id),
               step_key TEXT NOT NULL,
               intent_id TEXT NOT NULL UNIQUE,
               params_json TEXT NOT NULL,
               phase TEXT NOT NULL,
               completion_json TEXT,
               error TEXT,
               PRIMARY KEY(run_id,step_key)
             );
             CREATE TABLE IF NOT EXISTS automation_resources(
               run_id TEXT NOT NULL REFERENCES automation_runs(id),
               profile_id TEXT NOT NULL,
               worker INTEGER NOT NULL,
               owner TEXT NOT NULL,
               temporary INTEGER NOT NULL DEFAULT 0,
               started INTEGER NOT NULL DEFAULT 0,
               retained INTEGER NOT NULL DEFAULT 0,
               released INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(run_id,profile_id)
             );
             CREATE TABLE IF NOT EXISTS automation_module_grants(
               connection_id TEXT NOT NULL REFERENCES browser_connections(id),
               module_id TEXT NOT NULL,
               digest TEXT NOT NULL,
               grant_json TEXT NOT NULL,
               PRIMARY KEY(connection_id,module_id)
             );
             COMMIT;",
            )
            .map_err(storage_error)
    }

    pub fn require_connection(&self, connection_id: &str) -> BrowserResult<()> {
        require_connection(&*self.database()?, connection_id)
    }

    pub fn list(&self, connection_id: &str) -> BrowserResult<Vec<Project>> {
        let database = self.database()?;
        require_connection(&database, connection_id)?;
        let mut query = database
            .prepare(
                "SELECT project_json FROM automation_projects WHERE connection_id=?1
             ORDER BY updated_at DESC,id",
            )
            .map_err(storage_error)?;
        let rows = query
            .query_map([connection_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.map(|row| decode(&row.map_err(storage_error)?))
            .collect()
    }

    pub fn get(&self, connection_id: &str, id: &str) -> BrowserResult<Project> {
        get_project(&*self.database()?, connection_id, id)
    }

    pub fn create(&self, connection_id: &str, name: &str) -> BrowserResult<Project> {
        let stamp = now();
        let project: Project = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "name": if name.trim().is_empty() { "Untitled" } else { name.trim() },
            "notes": "", "blocks": [], "run": {}, "rules": [],
            "created_at": stamp, "updated_at": stamp, "revision": 1
        }))
        .map_err(storage_error)?;
        self.insert(connection_id, project)
    }

    fn insert(&self, connection_id: &str, project: Project) -> BrowserResult<Project> {
        validate_project(&project)?;
        let database = self.database()?;
        require_connection(&database, connection_id)?;
        database
            .execute(
                "INSERT INTO automation_projects(id,connection_id,revision,project_json,updated_at)
             VALUES(?1,?2,?3,?4,?5)",
                params![
                    project.id,
                    connection_id,
                    to_sql_i64(project.revision.unwrap_or(1))?,
                    encode(&project)?,
                    to_sql_i64(project.updated_at)?
                ],
            )
            .map_err(storage_error)?;
        Ok(project)
    }

    pub fn save(&self, connection_id: &str, mut project: Project) -> BrowserResult<Project> {
        normalize_blocks(&mut project);
        validate_project(&project)?;
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let previous = get_project(&transaction, connection_id, &project.id)?;
        let revision = previous.revision.unwrap_or(1);
        if project
            .revision
            .is_some_and(|expected| expected != revision)
        {
            return Err(BrowserError::new(
                "conflict",
                "The project was changed by another editor",
            ));
        }
        project.created_at = previous.created_at;
        project.updated_at = now();
        project.revision = Some(revision.saturating_add(1));
        transaction
            .execute(
                "UPDATE automation_projects SET revision=?3,project_json=?4,updated_at=?5
             WHERE id=?1 AND connection_id=?2",
                params![
                    project.id,
                    connection_id,
                    project.revision.map(to_sql_i64).transpose()?,
                    encode(&project)?,
                    to_sql_i64(project.updated_at)?
                ],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(project)
    }

    pub fn duplicate(&self, connection_id: &str, id: &str) -> BrowserResult<Project> {
        let mut copy = self.get(connection_id, id)?;
        copy.id = uuid::Uuid::new_v4().to_string();
        copy.name = format!("{} copy", copy.name);
        copy.created_at = now();
        copy.updated_at = copy.created_at;
        copy.revision = Some(1);
        self.insert(connection_id, copy)
    }

    pub fn delete(&self, connection_id: &str, id: &str) -> BrowserResult<()> {
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        get_project(&transaction, connection_id, id)?;
        if transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE project_id=?1 AND connection_id=?2
             AND (phase IN('intent','running','stopping','reconciling','interrupted')
               OR EXISTS(SELECT 1 FROM automation_resources WHERE run_id=automation_runs.id AND released=0)
               OR EXISTS(SELECT 1 FROM automation_steps WHERE run_id=automation_runs.id AND phase IN('intent','unknown'))
               OR EXISTS(SELECT 1 FROM automation_actions WHERE run_id=automation_runs.id AND phase='intent')))",
            params![id, connection_id], |row| row.get::<_, bool>(0),
        ).map_err(storage_error)? {
            return Err(BrowserError::new("profile_busy", "Stop the project before deleting it"));
        }
        transaction
            .execute(
                "DELETE FROM automation_projects WHERE id=?1 AND connection_id=?2",
                params![id, connection_id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }

    /// Reports unresolved bindings without dropping the imported flow.
    pub fn references(
        &self,
        connection_id: &str,
        project: &Project,
    ) -> BrowserResult<Vec<ReferenceIssue>> {
        let database = self.database()?;
        require_connection(&database, connection_id)?;
        let mut issues = Vec::new();
        for (index, block) in project.blocks.iter().enumerate() {
            if !block.enabled {
                continue;
            }
            let path = format!("blocks[{index}]");
            for secret in &block.secrets {
                if block
                    .params
                    .get(secret)
                    .is_none_or(|value| value.is_null() || value == "")
                {
                    issues.push(issue(
                        format!("{path}.params.{secret}"),
                        "secret",
                        secret,
                        "Fill this secret parameter before running",
                    ));
                }
            }
            let binding = match block.kind.as_str() {
                "profile.use" => Some(("id", "profile_records", "profile")),
                "profile.delete" if block.params.get("id").is_some_and(|value| value != "") => {
                    Some(("id", "profile_records", "profile"))
                }
                "flow.call" => Some(("project", "automation_projects", "flow")),
                _ => None,
            };
            if let Some((key, table, kind)) = binding {
                let value = block.params.get(key).and_then(Value::as_str).unwrap_or("");
                if !value.contains("{{") {
                    if kind == "flow"
                        && value.is_empty()
                        && let Some(name) = block.params["projectName"]
                            .as_str()
                            .filter(|name| !name.is_empty())
                    {
                        if name.contains("{{") {
                            continue;
                        }
                        let matches: i64 = database.query_row(
                                "SELECT COUNT(*) FROM automation_projects WHERE connection_id=?1 AND json_extract(project_json,'$.name')=?2",
                                params![connection_id, name], |row| row.get(0),
                            ).map_err(storage_error)?;
                        if matches != 1 {
                            issues.push(issue(
                                format!("{path}.params.projectName"),
                                kind,
                                name,
                                "Subflow name must resolve uniquely in this Workspace",
                            ));
                        }
                        continue;
                    }
                    let sql = format!(
                        "SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1 AND connection_id=?2)"
                    );
                    let found: bool = database
                        .query_row(&sql, params![value, connection_id], |row| row.get(0))
                        .map_err(storage_error)?;
                    if value.is_empty() || !found {
                        issues.push(issue(
                            format!("{path}.params.{key}"),
                            kind,
                            value,
                            "Reference must be bound in this Workspace",
                        ));
                    }
                }
            }
            if let Some(folder) = block
                .params
                .get("folder")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && !value.contains("{{"))
            {
                let found: bool = database
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM groups WHERE id=?1 AND connection_id=?2)",
                        params![folder, connection_id],
                        |row| row.get(0),
                    )
                    .map_err(storage_error)?;
                if !found
                    && (uuid::Uuid::parse_str(folder).is_ok()
                        || folder == "__raccoon_unbound_folder__")
                {
                    issues.push(issue(
                        format!("{path}.params.folder"),
                        "folder",
                        folder,
                        "Folder must belong to this Workspace",
                    ));
                }
            }
            if let Some(id) = module_id(&block.kind)
                && (!valid_module_id(id) || !self.modules_dir.join(format!("{id}.wasm")).is_file())
            {
                issues.push(issue(
                    format!("{path}.kind"),
                    "module",
                    id,
                    "Required WASM module is missing",
                ));
            }
        }
        Ok(issues)
    }

    pub fn export(&self, connection_id: &str, id: &str) -> BrowserResult<Value> {
        let mut project = self.get(connection_id, id)?;
        let needs = redact_project(&mut project);
        let modules: std::collections::BTreeSet<_> = project
            .blocks
            .iter()
            .filter_map(|block| module_id(&block.kind))
            .map(str::to_owned)
            .collect();
        Ok(json!({
            "format": 1, "exported_at": now(), "project": project,
            "modules": modules, "module_files": [], "needs": needs,
            "raccoon": { "version": 1, "connection_id": connection_id }
        }))
    }

    /// Accepts upstream format 1 and the versioned Raccoon extension.
    /// Module extraction is performed by the service before this insertion.
    pub fn import(&self, connection_id: &str, bundle: Value) -> BrowserResult<Project> {
        if bundle.get("format").and_then(Value::as_u64) != Some(1)
            || bundle
                .get("raccoon")
                .is_some_and(|value| value["version"] != 1)
        {
            return Err(invalid("Unsupported automation bundle version"));
        }
        let mut project: Project = serde_json::from_value(bundle["project"].clone())
            .map_err(|_| invalid("Invalid automation project bundle"))?;
        // Imported ids are untrusted local bindings, including ids that happen to
        // exist in the destination. Empty references require explicit rebinding.
        project.run.profiles.clear();
        for block in &mut project.blocks {
            let key = match block.kind.as_str() {
                "profile.use" | "profile.delete" => Some("id"),
                "flow.call" => Some("project"),
                _ => None,
            };
            if let Some(key) = key
                && let Some(value) = block.params.get_mut(key)
                && !value.as_str().is_some_and(|value| value.contains("{{"))
                && value.as_str().is_some_and(|value| !value.is_empty())
            {
                *value = json!("__raccoon_unbound_reference__");
            }
            if let Some(folder) = block.params.get_mut("folder")
                && folder
                    .as_str()
                    .is_some_and(|folder| !folder.is_empty() && !folder.contains("{{"))
            {
                *folder = json!("__raccoon_unbound_folder__");
            }
            if block.kind == "flow.call"
                && let Some(name) = block.params.get_mut("projectName")
            {
                *name = json!("");
            }
        }
        project.id = uuid::Uuid::new_v4().to_string();
        project.created_at = now();
        project.updated_at = project.created_at;
        project.revision = Some(1);
        normalize_blocks(&mut project);
        self.insert(connection_id, project)
    }

    pub fn begin_run(
        &self,
        connection_id: &str,
        project_id: &str,
        operation_id: &str,
        snapshot: Value,
    ) -> BrowserResult<RunIntent> {
        if operation_id.is_empty()
            || operation_id.len() > 128
            || operation_id.chars().any(char::is_control)
        {
            return Err(invalid("A stable operationId is required"));
        }
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        require_connection(&transaction, connection_id)?;
        if let Some(existing) = find_run(
            &transaction,
            "SELECT id,connection_id,operation_id,project_id,phase,snapshot_json,state_json
             FROM automation_runs WHERE connection_id=?1 AND operation_id=?2",
            connection_id,
            operation_id,
        )? {
            if existing.project_id != project_id {
                return Err(BrowserError::new(
                    "conflict",
                    "operationId already belongs to another project",
                ));
            }
            return Ok(RunIntent::Existing(existing));
        }
        let project = get_project(&transaction, connection_id, project_id)?;
        let active: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE connection_id=?1 AND project_id=?2
             AND phase IN('intent','running','stopping','reconciling'))",
            params![connection_id, project_id], |row| row.get(0),
        ).map_err(storage_error)?;
        if active {
            return Err(BrowserError::new(
                "profile_busy",
                "This project already has an active run",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = RunRecord {
            id: id.clone(),
            connection_id: connection_id.into(),
            operation_id: operation_id.into(),
            project_id: project_id.into(),
            phase: "intent".into(),
            snapshot,
            state: json!({
                "project_id": project_id, "project_name": project.name, "started_at": now(),
                "running": true, "workers": [], "log": [], "connectionId": connection_id,
                "runId": id, "status": "intent"
            }),
        };
        transaction.execute(
            "INSERT INTO automation_runs(id,connection_id,operation_id,project_id,phase,snapshot_json,state_json,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![record.id, connection_id, operation_id, project_id, record.phase,
                encode(&record.snapshot)?, encode(&record.state)?, to_sql_i64(now())?],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(RunIntent::Created(record))
    }

    pub fn operation_run(
        &self,
        connection_id: &str,
        operation_id: &str,
    ) -> BrowserResult<Option<RunRecord>> {
        find_run(
            &*self.database()?,
            "SELECT id,connection_id,operation_id,project_id,phase,snapshot_json,state_json
             FROM automation_runs WHERE connection_id=?1 AND operation_id=?2",
            connection_id,
            operation_id,
        )
    }

    pub fn latest_run(
        &self,
        connection_id: &str,
        project_id: &str,
    ) -> BrowserResult<Option<RunRecord>> {
        self.require_connection(connection_id)?;
        find_run(&*self.database()?,
            "SELECT id,connection_id,operation_id,project_id,phase,snapshot_json,state_json
             FROM automation_runs WHERE connection_id=?1 AND project_id=?2 ORDER BY rowid DESC LIMIT 1",
            connection_id, project_id)
    }

    pub fn run_by_id(&self, connection: &str, id: &str) -> BrowserResult<RunRecord> {
        self.require_connection(connection)?;
        find_run(
            &*self.database()?,
            "SELECT id,connection_id,operation_id,project_id,phase,snapshot_json,state_json
             FROM automation_runs WHERE connection_id=?1 AND id=?2",
            connection,
            id,
        )?
        .ok_or_else(|| BrowserError::new("run_missing", "Run is absent from this Workspace"))
    }

    pub fn recovery_runs(&self, connection: &str, project: &str) -> BrowserResult<Vec<RunRecord>> {
        let database = self.database()?;
        require_connection(&database, connection)?;
        let mut query = database.prepare(
            "SELECT id FROM automation_runs WHERE connection_id=?1 AND project_id=?2
             AND (phase IN('interrupted','reconciling','stopping') OR
               (phase IN('completed','failed','cancelled') AND EXISTS(
                 SELECT 1 FROM automation_resources WHERE run_id=automation_runs.id AND released=0))) ORDER BY rowid",
        ).map_err(storage_error)?;
        let ids = query
            .query_map(params![connection, project], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(query);
        drop(database);
        ids.into_iter()
            .map(|id| self.run_by_id(connection, &id))
            .collect()
    }

    pub fn fleet(&self, connection_id: &str) -> BrowserResult<Vec<Value>> {
        let database = self.database()?;
        require_connection(&database, connection_id)?;
        let mut query = database
            .prepare(
                "SELECT state_json FROM automation_runs WHERE connection_id=?1
             AND (phase IN('interrupted','reconciling','stopping') OR id IN(SELECT id FROM automation_runs r WHERE r.rowid=(
               SELECT MAX(s.rowid) FROM automation_runs s
               WHERE s.connection_id=r.connection_id AND s.project_id=r.project_id)))
             ORDER BY rowid DESC",
            )
            .map_err(storage_error)?;
        query
            .query_map([connection_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| decode(&row.map_err(storage_error)?))
            .collect()
    }

    pub fn update_run(&self, id: &str, phase: &str, mut state: Value) -> BrowserResult<()> {
        if !matches!(
            phase,
            "running"
                | "stopping"
                | "completed"
                | "failed"
                | "cancelled"
                | "reconciling"
                | "interrupted"
        ) {
            return Err(invalid("Invalid run transition"));
        }
        let database = self.database()?;
        let (connection, current): (String, String) = database
            .query_row(
                "SELECT connection_id,phase FROM automation_runs WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(storage_error)?;
        let phase = if current == "stopping" && phase == "running" {
            "stopping"
        } else {
            phase
        };
        state["connectionId"] = json!(connection);
        state["connection_id"] = state["connectionId"].clone();
        state["runId"] = json!(id);
        state["run_id"] = json!(id);
        state["status"] = json!(phase);
        state["running"] = json!(matches!(phase, "running" | "stopping" | "reconciling"));
        let changed = database
            .execute(
                "UPDATE automation_runs SET phase=?2,state_json=?3,updated_at=?4 WHERE id=?1
             AND (phase IN('intent','running','stopping','reconciling')
               OR (phase=?2 AND phase IN('completed','failed','cancelled')
                 AND json(state_json)=json(?3)))",
                params![id, phase, encode(&state)?, to_sql_i64(now())?],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(BrowserError::new(
                "conflict",
                "This run has already reached a terminal state",
            ));
        }
        Ok(())
    }

    pub fn seal_snapshot(&self, id: &str, snapshot: &Value) -> BrowserResult<()> {
        let changed = self
            .database()?
            .execute(
                "UPDATE automation_runs SET snapshot_json=?2 WHERE id=?1 AND phase='intent'
                 AND json_extract(snapshot_json,'$.engine_modules') IS NULL",
                params![id, encode(snapshot)?],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(BrowserError::new(
                "conflict",
                "Run snapshot is already sealed",
            ));
        }
        Ok(())
    }

    pub fn interrupt_unfinished(&self) -> BrowserResult<usize> {
        let database = self.database()?;
        database.execute(
            "UPDATE automation_runs SET phase='interrupted',
             state_json=json_set(state_json,'$.running',json('false'),'$.status','interrupted',
               '$.workers',json(COALESCE((SELECT json_group_array(json_set(value,
                 '$.status','interrupted','$.note','Application restarted; reconcile before resuming'))
                 FROM json_each(state_json,'$.workers')),'[]'))),
             updated_at=?1 WHERE phase IN('intent','running','stopping','reconciling')",
            [to_sql_i64(now())?],
        ).map_err(storage_error)
    }

    pub fn begin_action(
        &self,
        run_id: &str,
        action_id: &str,
        payload: &Value,
    ) -> BrowserResult<ActionIntent> {
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let previous: Option<(String, String, Option<String>)> = transaction.query_row(
            "SELECT phase,payload_json,result_json FROM automation_actions WHERE run_id=?1 AND action_id=?2",
            params![run_id, action_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(storage_error)?;
        let encoded = encode(payload)?;
        if let Some((phase, previous, result)) = previous {
            if previous != encoded {
                return Err(BrowserError::new(
                    "conflict",
                    "Action id was reused with different input",
                ));
            }
            return match (phase.as_str(), result) {
                ("completed", Some(result)) => Ok(ActionIntent::Completed(decode(&result)?)),
                ("failed", Some(result)) => Ok(ActionIntent::Rejected(decode(&result)?)),
                _ => Err(BrowserError::new(
                    "operation_uncertain",
                    "Action result requires reconciliation",
                )),
            };
        }
        transaction.execute(
            "INSERT INTO automation_actions(run_id,action_id,phase,payload_json) VALUES(?1,?2,'intent',?3)",
            params![run_id, action_id, encoded],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(ActionIntent::New)
    }

    pub fn complete_action(
        &self,
        run_id: &str,
        action_id: &str,
        result: &Value,
    ) -> BrowserResult<()> {
        let changed = self
            .database()?
            .execute(
                "UPDATE automation_actions SET phase='completed',result_json=?3
             WHERE run_id=?1 AND action_id=?2 AND phase='intent'",
                params![run_id, action_id, encode(result)?],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(BrowserError::new(
                "conflict",
                "Action intent is missing or already resolved",
            ));
        }
        Ok(())
    }

    pub fn reject_action(&self, run: &str, id: &str, error: &BrowserError) -> BrowserResult<()> {
        self.database()?.execute(
            "UPDATE automation_actions SET phase='failed',result_json=?3 WHERE run_id=?1 AND action_id=?2 AND phase='intent'",
            params![run, id, encode(error)?],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn step_input(&self, run: &str, intent: &str) -> BrowserResult<Value> {
        let raw: String = self
            .database()?
            .query_row(
                "SELECT params_json FROM automation_steps WHERE run_id=?1 AND intent_id=?2",
                params![run, intent],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        decode(&raw)
    }

    pub fn actions(&self, run: &str) -> BrowserResult<Vec<ActionRecord>> {
        let database = self.database()?;
        let mut query = database.prepare(
            "SELECT action_id,phase,payload_json,result_json FROM automation_actions WHERE run_id=?1 ORDER BY rowid",
        ).map_err(storage_error)?;
        query
            .query_map([run], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(storage_error)?
            .map(|row| {
                let (id, phase, input, output) = row.map_err(storage_error)?;
                Ok((
                    id,
                    phase,
                    decode(&input)?,
                    output.map(|raw| decode(&raw)).transpose()?,
                ))
            })
            .collect()
    }

    pub fn browser_operation(
        &self,
        id: &str,
    ) -> BrowserResult<Option<crate::core::browser::operation_store::BrowserOperation>> {
        let raw: Option<String> = self
            .database()?
            .query_row(
                "SELECT record_json FROM browser_operations WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        raw.map(|raw| decode(&raw)).transpose()
    }

    pub fn profile_operations(
        &self,
        connection: &str,
        profile: &str,
    ) -> BrowserResult<Vec<crate::core::browser::operation_store::BrowserOperation>> {
        let database = self.database()?;
        let mut query = database.prepare(
            "SELECT record_json FROM browser_operations WHERE connection_id=?1 AND window_id=?2 ORDER BY rowid",
        ).map_err(storage_error)?;
        query
            .query_map(params![connection, profile], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| decode(&row.map_err(storage_error)?))
            .collect()
    }

    pub fn link_operation(&self, run: &str, action: &str, operation: &str) -> BrowserResult<()> {
        self.database()?.execute(
            "INSERT INTO automation_action_operations(run_id,action_id,operation_id) VALUES(?1,?2,?3)
             ON CONFLICT(run_id,action_id,operation_id) DO NOTHING", params![run, action, operation],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn operation_baseline(
        &self,
        run: &str,
        action: &str,
        ids: &[String],
    ) -> BrowserResult<Vec<String>> {
        let database = self.database()?;
        database.execute(
            "INSERT INTO automation_operation_baselines(run_id,action_id,ids_json) VALUES(?1,?2,?3)
             ON CONFLICT(run_id,action_id) DO NOTHING", params![run, action, encode(&ids)?],
        ).map_err(storage_error)?;
        let raw: String = database.query_row(
            "SELECT ids_json FROM automation_operation_baselines WHERE run_id=?1 AND action_id=?2",
            params![run, action], |row| row.get(0),
        ).map_err(storage_error)?;
        decode(&raw)
    }

    pub fn action_operations(
        &self,
        run: &str,
        action: &str,
    ) -> BrowserResult<Vec<crate::core::browser::operation_store::BrowserOperation>> {
        let database = self.database()?;
        let mut query = database
            .prepare(
                "SELECT operations.record_json FROM automation_action_operations links
             JOIN browser_operations operations ON operations.id=links.operation_id
             WHERE links.run_id=?1 AND links.action_id=?2",
            )
            .map_err(storage_error)?;
        query
            .query_map(params![run, action], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| decode(&row.map_err(storage_error)?))
            .collect()
    }

    pub fn confirmed_deleted(&self, connection: &str, profile: &str) -> BrowserResult<bool> {
        self.database()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_operations WHERE connection_id=?1 AND window_id=?2
             AND kind='delete' AND phase='committed')", params![connection, profile], |row| row.get(0),
        ).map_err(storage_error)
    }

    pub fn pending_actions(&self, run: &str) -> BrowserResult<bool> {
        self.database()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM automation_actions WHERE run_id=?1 AND phase='intent')
             OR EXISTS(SELECT 1 FROM automation_steps WHERE run_id=?1 AND phase='unknown')",
                [run],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    pub fn link_action(&self, run: &str, action: &str, intent: &str) -> BrowserResult<()> {
        self.database()?
            .execute(
                "INSERT INTO automation_action_steps(run_id,action_id,intent_id) VALUES(?1,?2,?3)
             ON CONFLICT(run_id,action_id) DO NOTHING",
                params![run, action, intent],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn unresolved_steps(
        &self,
        run: &str,
    ) -> BrowserResult<Vec<super::engine::host::StepIntent>> {
        let database = self.database()?;
        let mut query = database.prepare(
            "SELECT intent_id,step_key FROM automation_steps WHERE run_id=?1 AND phase IN('intent','unknown') ORDER BY rowid",
        ).map_err(storage_error)?;
        query
            .query_map([run], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?
            .map(|row| {
                let (id, key) = row.map_err(storage_error)?;
                Ok(super::engine::host::StepIntent {
                    id,
                    key: decode(&key)?,
                })
            })
            .collect()
    }

    pub fn review_step(&self, run: &str, intent: &str, outcome: &str) -> BrowserResult<()> {
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let changed = transaction.execute(
            "UPDATE automation_steps SET phase='reviewed',error=?3 WHERE run_id=?1 AND intent_id=?2 AND phase IN('intent','unknown')",
            params![run, intent, outcome],
        ).map_err(storage_error)?;
        if changed != 1 {
            return Err(BrowserError::new(
                "conflict",
                "Step is absent or already reconciled",
            ));
        }
        transaction.execute(
            "UPDATE automation_actions SET phase='reviewed',result_json=?3 WHERE run_id=?1 AND phase='intent'
             AND action_id IN(SELECT action_id FROM automation_action_steps WHERE run_id=?1 AND intent_id=?2)",
            params![run, intent, json!({"reviewedOutcome":outcome}).to_string()],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }

    pub fn settle_interrupted(&self, run: &str) -> BrowserResult<()> {
        self.database()?.execute(
            "UPDATE automation_runs SET phase='cancelled',state_json=json_set(state_json,'$.status','cancelled','$.running',json('false'),
               '$.workers',json(COALESCE((SELECT json_group_array(CASE
                 WHEN json_extract(value,'$.status') IN('queued','starting','running','reconciling','interrupted','persistence_error')
                 THEN json_set(value,'$.status','stopped','$.note','Ended after inspecting the external result','$.pending_intent',json('null'))
                 ELSE json_set(value,'$.pending_intent',json('null')) END) FROM json_each(state_json,'$.workers')),'[]'))),
             updated_at=?2 WHERE id=?1 AND phase IN('interrupted','stopping','reconciling','completed','failed','cancelled')", params![run, to_sql_i64(now())?],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn request_cancel(&self, run: &str) -> BrowserResult<()> {
        self.database()?
            .execute(
                "INSERT INTO automation_run_cancellations(run_id,requested_at) VALUES(?1,?2)
             ON CONFLICT(run_id) DO NOTHING",
                params![run, to_sql_i64(now())?],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn cancelled(&self, run: &str) -> BrowserResult<bool> {
        self.database()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM automation_run_cancellations WHERE run_id=?1)",
                [run],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    pub fn resources(&self, run: &str) -> BrowserResult<Vec<(String, String)>> {
        let database = self.database()?;
        let mut query = database
            .prepare(
                "SELECT profile_id,owner FROM automation_resources WHERE run_id=?1 AND released=0",
            )
            .map_err(storage_error)?;
        query
            .query_map([run], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)
    }

    pub fn unreleased_runs(&self) -> BrowserResult<Vec<String>> {
        let database = self.database()?;
        let mut query = database
            .prepare("SELECT DISTINCT run_id FROM automation_resources WHERE released=0")
            .map_err(storage_error)?;
        query
            .query_map([], |row| row.get(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)
    }

    pub fn active_runs(&self) -> BrowserResult<Vec<(String, String)>> {
        let database = self.database()?;
        let mut query = database.prepare(
            "SELECT connection_id,id FROM automation_runs WHERE phase IN('intent','running','stopping','reconciling')",
        ).map_err(storage_error)?;
        query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)
    }

    pub fn interrupted_pending(&self, run: &str) -> BrowserResult<bool> {
        self.database()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM automation_actions WHERE run_id=?1 AND phase='intent')
             OR EXISTS(SELECT 1 FROM automation_steps WHERE run_id=?1 AND phase IN('intent','unknown'))",
            [run], |row| row.get(0),
        ).map_err(storage_error)
    }

    /// Retain immutable operation receipts. Only acknowledged, released terminal
    /// snapshots and logs beyond the most recent fifty may be compacted.
    pub fn prune_artifacts(&self) -> BrowserResult<usize> {
        use sha2::{Digest, Sha256};
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let old = {
            let mut query = transaction.prepare(
                "SELECT id,connection_id,project_id FROM automation_runs r
                 WHERE phase IN('completed','failed','cancelled')
                 AND NOT EXISTS(SELECT 1 FROM automation_resources WHERE run_id=r.id AND released=0)
                 AND NOT EXISTS(SELECT 1 FROM automation_steps WHERE run_id=r.id AND phase IN('intent','unknown'))
                 AND NOT EXISTS(SELECT 1 FROM automation_actions WHERE run_id=r.id AND phase='intent')
                 ORDER BY rowid DESC LIMIT -1 OFFSET 50",
            ).map_err(storage_error)?;
            query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(storage_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        let mut removed = 0;
        for (id, connection_id, project_id) in old {
            let scope = super::engine::host::EngineScope {
                connection_id,
                run_id: id.clone(),
                project_id,
            };
            let digest = format!(
                "{:x}",
                Sha256::digest(scope.resource_key("modules").as_bytes())
            );
            let directory = self.modules_dir.join("snapshots").join(digest);
            if directory.exists() {
                let metadata = std::fs::symlink_metadata(&directory).map_err(storage_error)?;
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    std::fs::remove_dir_all(&directory).map_err(storage_error)?;
                    removed += 1;
                }
            }
            transaction
                .execute(
                    "UPDATE automation_runs SET state_json=json_set(state_json,'$.log',json('[]')),
                 snapshot_json=json_object('version',1,'retired',json('true')) WHERE id=?1",
                    [&id],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(removed)
    }

    pub fn database_path(&self) -> BrowserResult<PathBuf> {
        self.database()?
            .path()
            .map(PathBuf::from)
            .ok_or_else(|| storage_error("database path missing"))
    }

    pub fn grant(
        &self,
        connection_id: &str,
        module: &str,
        digest: &str,
    ) -> BrowserResult<Option<Value>> {
        let database = self.database()?;
        require_connection(&database, connection_id)?;
        let value: Option<String> = database
            .query_row(
                "SELECT grant_json FROM automation_module_grants
             WHERE connection_id=?1 AND module_id=?2 AND digest=?3",
                params![connection_id, module, digest],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        value.map(|value| decode(&value)).transpose()
    }

    pub fn set_grant(
        &self,
        connection_id: &str,
        module: &str,
        digest: &str,
        grant: &Value,
    ) -> BrowserResult<()> {
        let database = self.database()?;
        require_connection(&database, connection_id)?;
        database.execute(
            "INSERT INTO automation_module_grants(connection_id,module_id,digest,grant_json) VALUES(?1,?2,?3,?4)
             ON CONFLICT(connection_id,module_id) DO UPDATE SET digest=excluded.digest,grant_json=excluded.grant_json",
            params![connection_id, module, digest, encode(grant)?],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn freeze_modules(&self, project: &Project) -> BrowserResult<BTreeMap<String, String>> {
        use sha2::{Digest, Sha256};
        project
            .blocks
            .iter()
            .filter_map(|block| module_id(&block.kind))
            .map(|id| {
                if !valid_module_id(id) {
                    return Err(invalid("Invalid WASM module id"));
                }
                let bytes = std::fs::read(self.modules_dir.join(format!("{id}.wasm")))
                    .map_err(|_| invalid(format!("Required module {id} is missing")))?;
                Ok((id.to_owned(), format!("{:x}", Sha256::digest(bytes))))
            })
            .collect()
    }

    pub fn allocate_step(&self, run: &str, key: &Value, params: &Value) -> BrowserResult<String> {
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let step_key = encode(key)?;
        let previous: Option<(String, String, String)> = transaction.query_row(
            "SELECT intent_id,params_json,phase FROM automation_steps WHERE run_id=?1 AND step_key=?2",
            params![run, step_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(storage_error)?;
        if let Some((id, previous, _)) = previous {
            if previous != encode(params)? {
                return Err(BrowserError::new(
                    "conflict",
                    "Step identity was reused with different parameters",
                ));
            }
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO automation_steps(run_id,step_key,intent_id,params_json,phase)
             VALUES(?1,?2,?3,?4,'intent')",
                params![run, step_key, id, encode(params)?],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(id)
    }

    pub fn finish_step(
        &self,
        run: &str,
        id: &str,
        phase: &str,
        completion: Option<&Value>,
        error: Option<&str>,
    ) -> BrowserResult<()> {
        let encoded_completion = completion.map(encode).transpose()?;
        let changed = self
            .database()?
            .execute(
                "UPDATE automation_steps SET phase=?3,completion_json=?4,error=?5
             WHERE run_id=?1 AND intent_id=?2 AND phase IN('intent','unknown')",
                params![run, id, phase, encoded_completion, error],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            let existing: Option<(String, Option<String>)> = self.database()?.query_row(
                "SELECT phase,completion_json FROM automation_steps WHERE run_id=?1 AND intent_id=?2",
                params![run, id], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(storage_error)?;
            if existing == Some((phase.to_owned(), encoded_completion)) {
                return Ok(());
            }
            return Err(BrowserError::new(
                "conflict",
                "Step is absent or already resolved",
            ));
        }
        Ok(())
    }

    pub fn step_result(&self, run: &str, id: &str) -> BrowserResult<(String, Option<Value>)> {
        let database = self.database()?;
        let (phase, completion): (String, Option<String>) = database.query_row(
            "SELECT phase,completion_json FROM automation_steps WHERE run_id=?1 AND intent_id=?2",
            params![run, id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(storage_error)?;
        Ok((phase, completion.map(|raw| decode(&raw)).transpose()?))
    }

    pub fn resource(&self, run: &str, profile: &str) -> BrowserResult<Option<Value>> {
        self.database()?
            .query_row(
                "SELECT worker,owner,temporary,started,retained,released FROM automation_resources
             WHERE run_id=?1 AND profile_id=?2",
                params![run, profile],
                |row| {
                    Ok(json!({
                        "worker":read_u64(row, 0)?, "owner":row.get::<_, String>(1)?,
                        "temporary":row.get::<_, bool>(2)?, "started":row.get::<_, bool>(3)?,
                        "retained":row.get::<_, bool>(4)?, "released":row.get::<_, bool>(5)?
                    }))
                },
            )
            .optional()
            .map_err(storage_error)
    }

    pub fn own_resource(
        &self,
        run: &str,
        profile: &str,
        worker: usize,
        owner: &str,
        temporary: bool,
    ) -> BrowserResult<()> {
        let worker = i64::try_from(worker)
            .map_err(|_| invalid("Worker index exceeds the SQLite integer range"))?;
        let mut database = self.database()?;
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let current: Option<(i64, bool)> = transaction.query_row(
            "SELECT worker,released FROM automation_resources WHERE run_id=?1 AND profile_id=?2",
            params![run, profile], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(storage_error)?;
        if current.is_some_and(|(current, released)| current != worker && !released) {
            return Err(BrowserError::new(
                "profile_busy",
                "Another worker controls this Profile",
            ));
        }
        transaction
            .execute(
                "INSERT INTO automation_resources(run_id,profile_id,worker,owner,temporary)
             VALUES(?1,?2,?3,?4,?5) ON CONFLICT(run_id,profile_id)
             DO UPDATE SET worker=excluded.worker,owner=excluded.owner,released=0",
                params![run, profile, worker, owner, temporary],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }

    pub fn resource_flag(&self, run: &str, profile: &str, flag: &str) -> BrowserResult<()> {
        if !["started", "retained", "released"].contains(&flag) {
            return Err(invalid("Invalid automation resource transition"));
        }
        let sql =
            format!("UPDATE automation_resources SET {flag}=1 WHERE run_id=?1 AND profile_id=?2");
        if self
            .database()?
            .execute(&sql, params![run, profile])
            .map_err(storage_error)?
            != 1
        {
            return Err(BrowserError::new(
                "conflict",
                "Automation resource ownership is missing",
            ));
        }
        Ok(())
    }

    pub fn unreleased_resources(&self) -> BrowserResult<Vec<(String, String)>> {
        let database = self.database()?;
        let mut query = database
            .prepare("SELECT resources.profile_id,resources.owner FROM automation_resources resources
                      JOIN profile_records profiles ON profiles.id=resources.profile_id WHERE resources.released=0")
            .map_err(storage_error)?;
        query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)
    }
}

fn require_connection(database: &Connection, connection_id: &str) -> BrowserResult<()> {
    if connection_id.is_empty() || connection_id.len() > 256 {
        return Err(invalid("connectionId is required"));
    }
    let exists: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_connections WHERE id=?1)",
            [connection_id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !exists {
        return Err(BrowserError::new(
            "connection_missing",
            "The Workspace connection does not exist",
        ));
    }
    Ok(())
}

fn get_project(database: &Connection, connection_id: &str, id: &str) -> BrowserResult<Project> {
    require_connection(database, connection_id)?;
    let raw: Option<String> = database
        .query_row(
            "SELECT project_json FROM automation_projects WHERE id=?1 AND connection_id=?2",
            params![id, connection_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    decode(&raw.ok_or_else(|| {
        BrowserError::new("project_missing", "Project is absent from this Workspace")
    })?)
}

fn find_run(
    database: &Connection,
    sql: &str,
    scope: &str,
    key: &str,
) -> BrowserResult<Option<RunRecord>> {
    let raw = database
        .query_row(sql, params![scope, key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .optional()
        .map_err(storage_error)?;
    raw.map(
        |(id, connection_id, operation_id, project_id, phase, snapshot, state)| {
            Ok(RunRecord {
                id,
                connection_id,
                operation_id,
                project_id,
                phase,
                snapshot: decode(&snapshot)?,
                state: decode(&state)?,
            })
        },
    )
    .transpose()
}

pub(crate) fn encode(value: &impl Serialize) -> BrowserResult<String> {
    serde_json::to_string(value).map_err(storage_error)
}

fn decode<T: serde::de::DeserializeOwned>(raw: &str) -> BrowserResult<T> {
    serde_json::from_str(raw).map_err(storage_error)
}

fn validate_project(project: &Project) -> BrowserResult<()> {
    if uuid::Uuid::parse_str(&project.id).is_err()
        || project.name.len() > 1024
        || project.blocks.len() > 10_000
        || project.rules.len() > 10_000
        || project.run.threads == 0
        || project.run.threads > 64
        || !project.run.hours.is_finite()
        || project.run.hours < 0.0
        || encode(project)?.len() > PROJECT_LIMIT
    {
        return Err(invalid("Invalid automation project or run settings"));
    }
    Ok(())
}

fn normalize_blocks(project: &mut Project) {
    let mut seen = HashSet::new();
    for block in &mut project.blocks {
        if block.id.is_empty() || !seen.insert(block.id.clone()) {
            block.id = uuid::Uuid::new_v4().to_string();
            seen.insert(block.id.clone());
        }
    }
}

fn issue(path: String, kind: &str, reference: &str, reason: &str) -> ReferenceIssue {
    ReferenceIssue {
        path,
        kind: kind.into(),
        reference: reference.into(),
        reason: reason.into(),
    }
}

pub(crate) fn module_id(kind: &str) -> Option<&str> {
    kind.strip_prefix("module:")?
        .split_once(':')
        .map(|(id, _)| id)
}

pub(crate) fn valid_module_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn redact_project(project: &mut Project) -> Vec<Value> {
    let mut needs = Vec::new();
    for block in &mut project.blocks {
        let mut cleared = Vec::new();
        for secret in &block.secrets {
            if let Some(value) = block.params.get_mut(secret) {
                *value = json!("");
                cleared.push(secret.clone());
            }
        }
        // Credentials nested in HTTP headers, proxy URLs, or traffic rules
        // also must not escape through a bundle or ordinary run log.
        let before = block.params.clone();
        redact_value(&mut block.params);
        if let Some(parameters) = block.params.as_object_mut() {
            for (key, value) in parameters {
                if before.get(key) != Some(value) && !cleared.contains(key) {
                    // Upstream's refill contract names top-level parameters.
                    // Mark automatically discovered credentials through that same contract.
                    *value = json!("");
                    cleared.push(key.clone());
                    if !block.secrets.contains(key) {
                        block.secrets.push(key.clone());
                    }
                }
            }
        }
        if !cleared.is_empty() {
            needs.push(json!({"block_id":block.id,"label":if block.label.is_empty() { &block.kind } else { &block.label },"params":cleared}));
        }
    }
    for rule in &mut project.rules {
        redact_value(rule);
    }
    project.run.profiles.clear();
    project.revision = None;
    needs
}

pub(crate) fn redact_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let name = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    name.as_str(),
                    "password"
                        | "passwd"
                        | "secret"
                        | "token"
                        | "apikey"
                        | "authorization"
                        | "proxyauthorization"
                        | "cookie"
                        | "setcookie"
                ) {
                    *value = json!("");
                } else {
                    redact_value(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_value),
        Value::String(text) => {
            if text.lines().any(|line| {
                line.split_once(':').is_some_and(|(name, _)| {
                    matches!(
                        name.trim().to_ascii_lowercase().as_str(),
                        "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
                    )
                })
            }) {
                *text = String::new();
                return;
            }
            if let Ok(mut url) = url::Url::parse(text)
                && (!url.username().is_empty() || url.password().is_some())
            {
                let _ = url.set_username("");
                let _ = url.set_password(None);
                *text = url.into();
            }
        }
        _ => {}
    }
}

pub(crate) fn module_path(root: &Path, id: &str) -> BrowserResult<PathBuf> {
    if !valid_module_id(id) {
        return Err(invalid("Invalid module id"));
    }
    Ok(root.join(format!("{id}.wasm")))
}
