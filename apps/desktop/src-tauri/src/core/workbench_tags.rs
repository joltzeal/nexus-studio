use super::{
    browser::provider::{BrowserError, BrowserResult},
    database::open_database,
    window_service::WindowService,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tauri::State;

const COLORS: &[&str] = &[
    "blue", "violet", "magenta", "red", "orange", "yellow", "green", "sky",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Serialize)]
pub struct TagState {
    pub tags: Vec<Tag>,
    pub by_profile: BTreeMap<String, Vec<String>>,
}

fn storage(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法读写 Profile 标签，请重新读取后重试")
}

fn invalid(message: &str) -> BrowserError {
    BrowserError::new("invalid_config", message)
}

fn validate_tag(mut tag: Tag) -> BrowserResult<Tag> {
    tag.name = tag.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if tag.id.is_empty() || tag.id.len() > 128 || tag.id.chars().any(char::is_control) {
        return Err(invalid("标签 ID 无效"));
    }
    if tag.name.is_empty() || tag.name.encode_utf16().count() > 32 {
        return Err(invalid("标签名称需包含 1 至 32 个字符"));
    }
    if !COLORS.contains(&tag.color.as_str()) {
        return Err(invalid("标签颜色无效"));
    }
    Ok(tag)
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

/// Called by every database open so Profile writes always enforce tag references.
/// The existing v2 metadata is imported exactly once inside the schema transaction.
pub(crate) fn ensure_schema(db: &mut Connection) -> Result<(), String> {
    let installed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_tag_schema')",
        [], |row| row.get(0),
    ).map_err(|_| "无法读取标签数据结构")?;
    if installed {
        return Ok(());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "无法初始化标签数据结构")?;
    // Another database opener may have completed initialization while this one waited.
    let installed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_tag_schema')",
        [], |row| row.get(0),
    ).map_err(|_| "无法读取标签数据结构")?;
    if installed {
        return Ok(());
    }
    tx.execute_batch(
        "CREATE TABLE browser_tags(
           connection_id TEXT NOT NULL REFERENCES browser_connections(id),
           id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
           color TEXT NOT NULL CHECK(color IN('blue','violet','magenta','red','orange','yellow','green','sky')),
           position INTEGER NOT NULL,
           PRIMARY KEY(connection_id,id), UNIQUE(connection_id,name_key)
         );
         CREATE TABLE browser_profile_tags(
           connection_id TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile_records(id) ON DELETE CASCADE,
           tag_id TEXT NOT NULL, position INTEGER NOT NULL,
           PRIMARY KEY(profile_id,tag_id),
           FOREIGN KEY(connection_id,tag_id) REFERENCES browser_tags(connection_id,id) ON DELETE CASCADE
         );
         CREATE INDEX browser_profile_tag_connection ON browser_profile_tags(connection_id,profile_id);
         CREATE TRIGGER browser_profile_tag_scope BEFORE INSERT ON browser_profile_tags
           WHEN NOT EXISTS(SELECT 1 FROM profile_records WHERE id=NEW.profile_id AND connection_id=NEW.connection_id)
           BEGIN SELECT RAISE(ABORT,'tag profile belongs to a different workspace'); END;"
    ).map_err(|_| "无法创建标签数据结构")?;
    import_metadata(&tx).map_err(|error| error.message)?;
    // The metadata carries ids only. Both the form and inline assignment use this path.
    // These triggers run inside the Profile store's original transaction.
    for event in ["INSERT", "UPDATE OF record_json"] {
        let suffix = if event == "INSERT" {
            "insert"
        } else {
            "update"
        };
        let changed = if event == "INSERT" {
            "1"
        } else {
            "json_extract(OLD.record_json,'$.settings.shardbrowser._meta.raccoon_tag_ids') IS NOT json_extract(NEW.record_json,'$.settings.shardbrowser._meta.raccoon_tag_ids')"
        };
        tx.execute_batch(&format!(
            "CREATE TRIGGER browser_profile_tags_{suffix} AFTER {event} ON profile_records WHEN {changed}
             BEGIN
               SELECT CASE WHEN json_type(NEW.record_json,'$.settings.shardbrowser._meta.raccoon_tag_ids') IS NOT NULL
                 AND json_type(NEW.record_json,'$.settings.shardbrowser._meta.raccoon_tag_ids') IS NOT 'array'
                 THEN RAISE(ABORT,'tag ids must be an array') END;
               SELECT CASE WHEN EXISTS(
                 SELECT 1 FROM json_each(NEW.record_json,'$.settings.shardbrowser._meta.raccoon_tag_ids') AS given
                 WHERE given.type != 'text' OR NOT EXISTS(
                   SELECT 1 FROM browser_tags WHERE connection_id=NEW.connection_id AND id=given.value
                 )
               ) THEN RAISE(ABORT,'tag belongs to a different workspace or is missing') END;
               DELETE FROM browser_profile_tags WHERE profile_id=NEW.id;
               INSERT INTO browser_profile_tags(connection_id,profile_id,tag_id,position)
                 SELECT NEW.connection_id,NEW.id,value,MIN(CAST(key AS INTEGER))
                 FROM json_each(NEW.record_json,'$.settings.shardbrowser._meta.raccoon_tag_ids') GROUP BY value;
             END;"
        )).map_err(|_| "无法创建标签关系约束")?;
    }
    for event in ["INSERT", "UPDATE"] {
        let suffix = event.to_lowercase();
        tx.execute_batch(&format!(
            "CREATE TRIGGER browser_operation_tags_{suffix} BEFORE {event} ON browser_operations
             WHEN NEW.phase NOT IN('committed','cancelled','failed')
             BEGIN
               SELECT CASE WHEN EXISTS(
                 SELECT 1 FROM json_tree(NEW.record_json,'$.payload') AS field
                 WHERE field.key='raccoon_tag_ids' AND (field.type!='array' OR EXISTS(
                   SELECT 1 FROM json_each(field.value) AS given
                   WHERE given.type!='text' OR NOT EXISTS(
                     SELECT 1 FROM browser_tags WHERE connection_id=NEW.connection_id AND id=given.value
                   )
                 ))
               ) THEN RAISE(ABORT,'operation tag belongs to a different workspace or is missing') END;
             END;"
        )).map_err(|_| "无法创建操作标签约束")?;
    }
    tx.execute_batch("CREATE TABLE workbench_tag_schema(version INTEGER NOT NULL CHECK(version=1)); INSERT INTO workbench_tag_schema VALUES(1);")
        .map_err(|_| "无法记录标签数据结构")?;
    tx.commit().map_err(|_| "无法保存标签数据结构".into())
}

fn import_metadata(db: &Connection) -> BrowserResult<()> {
    let records = {
        let mut query = db.prepare("SELECT id,connection_id,record_json FROM profile_records WHERE json_type(record_json,'$.settings.shardbrowser._meta.raccoon_tags')='array' ORDER BY id").map_err(storage)?;
        query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?
    };
    for (profile_id, connection_id, raw) in records {
        let mut record: Value = serde_json::from_str(&raw).map_err(storage)?;
        let tags: Vec<Tag> = serde_json::from_value(
            record
                .pointer("/settings/shardbrowser/_meta/raccoon_tags")
                .cloned()
                .unwrap_or(json!([])),
        )
        .map_err(storage)?;
        let mut ids = Vec::new();
        for tag in tags {
            let tag = validate_tag(tag)?;
            let existing: Option<String> = db.query_row(
                "SELECT id FROM browser_tags WHERE connection_id=?1 AND (id=?2 OR name_key=?3) ORDER BY CASE WHEN id=?2 THEN 0 ELSE 1 END LIMIT 1",
                params![connection_id, tag.id, tag.name.to_lowercase()], |row| row.get(0),
            ).optional().map_err(storage)?;
            let id = existing.unwrap_or_else(|| tag.id.clone());
            db.execute("INSERT OR IGNORE INTO browser_tags(connection_id,id,name,name_key,color,position) VALUES(?1,?2,?3,?4,?5,(SELECT COALESCE(MAX(position)+1,0) FROM browser_tags WHERE connection_id=?1))",
                params![connection_id, id, tag.name, tag.name.to_lowercase(), tag.color]).map_err(storage)?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let meta = record
            .pointer_mut("/settings/shardbrowser/_meta")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| invalid("Profile 标签元数据无效"))?;
        meta.remove("raccoon_tags");
        meta.insert("raccoon_tag_ids".into(), json!(ids));
        db.execute(
            "UPDATE profile_records SET record_json=?2 WHERE id=?1",
            params![profile_id, record.to_string()],
        )
        .map_err(storage)?;
        for (position, id) in ids.iter().enumerate() {
            db.execute("INSERT INTO browser_profile_tags(connection_id,profile_id,tag_id,position) VALUES(?1,?2,?3,?4)", params![connection_id, profile_id, id, position as i64]).map_err(storage)?;
        }
    }
    Ok(())
}

struct TagLibrary {
    path: PathBuf,
}

impl TagLibrary {
    fn list(&self, connection_id: &str) -> BrowserResult<TagState> {
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db.transaction().map_err(storage)?;
        require_connection(&tx, connection_id)?;
        let tags = {
            let mut query = tx.prepare("SELECT id,name,color FROM browser_tags WHERE connection_id=?1 ORDER BY position,id").map_err(storage)?;
            query
                .query_map([connection_id], |row| {
                    Ok(Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                    })
                })
                .map_err(storage)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?
        };
        let mut by_profile: BTreeMap<String, Vec<String>> = BTreeMap::new();
        {
            let mut query = tx.prepare("SELECT profile_id,tag_id FROM browser_profile_tags WHERE connection_id=?1 ORDER BY profile_id,position,tag_id").map_err(storage)?;
            let rows = query
                .query_map([connection_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage)?;
            for row in rows {
                let (id, tag) = row.map_err(storage)?;
                by_profile.entry(id).or_default().push(tag);
            }
        }
        tx.commit().map_err(storage)?;
        Ok(TagState { tags, by_profile })
    }

    fn save(&self, connection_id: &str, tag: Tag, at: Option<usize>) -> BrowserResult<Tag> {
        let tag = validate_tag(tag)?;
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        require_connection(&tx, connection_id)?;
        let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM browser_tags WHERE connection_id=?1 AND name_key=?2 AND id!=?3)", params![connection_id, tag.name.to_lowercase(), tag.id], |row| row.get(0)).map_err(storage)?;
        if duplicate {
            return Err(invalid("该 Workspace 已存在同名标签"));
        }
        let existing: Option<i64> = tx
            .query_row(
                "SELECT position FROM browser_tags WHERE connection_id=?1 AND id=?2",
                params![connection_id, tag.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        let end: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position)+1,0) FROM browser_tags WHERE connection_id=?1",
                [connection_id],
                |row| row.get(0),
            )
            .map_err(storage)?;
        let position =
            existing.unwrap_or_else(|| at.map(|at| at.min(end as usize) as i64).unwrap_or(end));
        if existing.is_none() {
            tx.execute("UPDATE browser_tags SET position=position+1 WHERE connection_id=?1 AND position>=?2", params![connection_id, position]).map_err(storage)?;
        }
        tx.execute("INSERT INTO browser_tags(connection_id,id,name,name_key,color,position) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(connection_id,id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,color=excluded.color", params![connection_id, tag.id, tag.name, tag.name.to_lowercase(), tag.color, position]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(tag)
    }

    fn assign(
        &self,
        connection_id: &str,
        by_profile: BTreeMap<String, Vec<String>>,
    ) -> BrowserResult<()> {
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        require_connection(&tx, connection_id)?;
        for (profile_id, ids) in by_profile {
            replace_assignment(&tx, connection_id, &profile_id, ids)?;
        }
        tx.commit().map_err(storage)
    }

    fn delete(&self, connection_id: &str, id: &str) -> BrowserResult<()> {
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        require_connection(&tx, connection_id)?;
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_operations AS operation, json_tree(operation.record_json,'$.payload') AS field
             WHERE operation.connection_id=?1 AND operation.phase NOT IN('committed','cancelled','failed')
               AND field.key='raccoon_tag_ids' AND field.type='array'
               AND EXISTS(SELECT 1 FROM json_each(field.value) WHERE value=?2))",
            params![connection_id, id], |row| row.get(0),
        ).map_err(storage)?;
        if pending {
            return Err(BrowserError::new(
                "tag_in_use",
                "标签正被待核对的 Profile 操作引用，请先完成核对",
            ));
        }
        let profiles = {
            let mut query = tx.prepare("SELECT profile_id FROM browser_profile_tags WHERE connection_id=?1 AND tag_id=?2").map_err(storage)?;
            query
                .query_map(params![connection_id, id], |row| row.get::<_, String>(0))
                .map_err(storage)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?
        };
        for profile_id in profiles {
            let ids = {
                let mut query = tx.prepare("SELECT tag_id FROM browser_profile_tags WHERE connection_id=?1 AND profile_id=?2 AND tag_id!=?3 ORDER BY position").map_err(storage)?;
                query
                    .query_map(params![connection_id, profile_id, id], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(storage)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(storage)?
            };
            replace_assignment(&tx, connection_id, &profile_id, ids)?;
        }
        tx.execute(
            "DELETE FROM browser_tags WHERE connection_id=?1 AND id=?2",
            params![connection_id, id],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)
    }
}

fn replace_assignment(
    db: &Connection,
    connection_id: &str,
    profile_id: &str,
    ids: Vec<String>,
) -> BrowserResult<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM profile_records WHERE id=?1 AND connection_id=?2)",
            params![profile_id, connection_id],
            |row| row.get(0),
        )
        .map_err(storage)?;
    if !exists {
        return Err(BrowserError::new(
            "scope_mismatch",
            "Profile 不属于当前 Workspace",
        ));
    }
    let pending: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM browser_operations WHERE window_id=?1 AND phase NOT IN('committed','cancelled','failed'))",
        [profile_id], |row| row.get(0),
    ).map_err(storage)?;
    if pending {
        return Err(BrowserError::new(
            "operation_pending",
            "Profile 操作待核对，完成核对后可修改标签",
        ));
    }
    for id in &ids {
        let known: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM browser_tags WHERE connection_id=?1 AND id=?2)",
                params![connection_id, id],
                |row| row.get(0),
            )
            .map_err(storage)?;
        if !known {
            return Err(invalid("标签已删除或属于其他 Workspace，请重新选择"));
        }
    }
    let mut unique = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    // Other Providers keep their independent assignments without a ShardBrowser config.
    db.execute("UPDATE profile_records SET record_json=json_set(record_json,'$.settings.shardbrowser._meta',json_set(COALESCE(NULLIF(json_extract(record_json,'$.settings.shardbrowser._meta'),'null'),'{}'),'$.raccoon_tag_ids',json(?3))) WHERE id=?1 AND connection_id=?2 AND json_type(record_json,'$.settings.shardbrowser')='object'", params![profile_id, connection_id, json!(unique).to_string()]).map_err(storage)?;
    db.execute(
        "DELETE FROM browser_profile_tags WHERE profile_id=?1",
        [profile_id],
    )
    .map_err(storage)?;
    for (position, id) in unique.iter().enumerate() {
        db.execute("INSERT INTO browser_profile_tags(connection_id,profile_id,tag_id,position) VALUES(?1,?2,?3,?4)", params![connection_id, profile_id, id, position as i64]).map_err(storage)?;
    }
    Ok(())
}

async fn run<T: Send + 'static>(
    job: impl FnOnce() -> BrowserResult<T> + Send + 'static,
) -> BrowserResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "标签操作中断，请重新读取结果"))?
}

#[tauri::command]
pub async fn browser_tag_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<TagState> {
    let lib = TagLibrary {
        path: state.store.database_path(),
    };
    run(move || lib.list(&connection_id)).await
}

#[tauri::command]
pub async fn browser_tag_save(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    tag: Tag,
    at: Option<usize>,
) -> BrowserResult<Tag> {
    let lib = TagLibrary {
        path: state.store.database_path(),
    };
    run(move || lib.save(&connection_id, tag, at)).await
}

#[tauri::command]
pub async fn browser_tag_delete(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    id: String,
) -> BrowserResult<()> {
    let lib = TagLibrary {
        path: state.store.database_path(),
    };
    run(move || lib.delete(&connection_id, &id)).await
}

#[tauri::command]
pub async fn browser_tag_assign(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    by_profile: BTreeMap<String, Vec<String>>,
) -> BrowserResult<()> {
    let lib = TagLibrary {
        path: state.store.database_path(),
    };
    run(move || lib.assign(&connection_id, by_profile)).await
}
