use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone)]
pub struct GroupStore {
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub note: String,
    pub window_count: u32,
}

pub(crate) fn open_database(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建数据目录")?;
    }
    let db = Connection::open(path).map_err(|_| "无法打开本地数据库")?;
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS groups (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           note TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS profile_records (
           id TEXT PRIMARY KEY,
           record_json TEXT NOT NULL,
           group_id TEXT REFERENCES groups(id) ON DELETE SET NULL
         );
         CREATE INDEX IF NOT EXISTS idx_profile_group ON profile_records(group_id);",
    )
    .map_err(|_| "无法初始化本地数据库")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置数据库权限")?;
    }
    Ok(db)
}

impl GroupStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        open_database(&path)?;
        Ok(Self { path })
    }

    pub fn list(&self) -> Result<Vec<Group>, String> {
        let db = open_database(&self.path)?;
        let mut statement = db
            .prepare(
                "SELECT g.id, g.name, g.note, COUNT(p.id)
                 FROM groups g LEFT JOIN profile_records p ON p.group_id = g.id
                 GROUP BY g.id ORDER BY g.rowid",
            )
            .map_err(|_| "无法读取分组")?;
        statement
            .query_map([], |row| {
                Ok(Group {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    note: row.get(2)?,
                    window_count: row.get(3)?,
                })
            })
            .map_err(|_| "无法读取分组")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取分组".into())
    }

    pub fn create(&self, name: &str, note: &str) -> Result<Group, String> {
        let (name, note) = validate(name, note)?;
        let id = Uuid::new_v4().to_string();
        open_database(&self.path)?
            .execute(
                "INSERT INTO groups (id, name, note) VALUES (?1, ?2, ?3)",
                params![id, name, note],
            )
            .map_err(|_| "无法创建分组")?;
        Ok(Group {
            id,
            name,
            note,
            window_count: 0,
        })
    }

    pub fn update(&self, id: &str, name: &str, note: &str) -> Result<(), String> {
        Uuid::parse_str(id).map_err(|_| "分组标识无效")?;
        let (name, note) = validate(name, note)?;
        let changed = open_database(&self.path)?
            .execute(
                "UPDATE groups SET name = ?2, note = ?3 WHERE id = ?1",
                params![id, name, note],
            )
            .map_err(|_| "无法更新分组")?;
        if changed == 0 {
            return Err("分组不存在".into());
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        Uuid::parse_str(id).map_err(|_| "分组标识无效")?;
        let changed = open_database(&self.path)?
            .execute("DELETE FROM groups WHERE id = ?1", [id])
            .map_err(|_| "无法删除分组")?;
        if changed == 0 {
            return Err("分组不存在".into());
        }
        Ok(())
    }

    pub fn assign(&self, profile_id: &str, group_id: Option<&str>) -> Result<(), String> {
        Uuid::parse_str(profile_id).map_err(|_| "窗口标识无效")?;
        if let Some(id) = group_id {
            Uuid::parse_str(id).map_err(|_| "分组标识无效")?;
        }
        let db = open_database(&self.path)?;
        if let Some(id) = group_id {
            let exists: Option<i32> = db
                .query_row("SELECT 1 FROM groups WHERE id = ?1", [id], |row| row.get(0))
                .optional()
                .map_err(|_| "无法检查分组")?;
            if exists.is_none() {
                return Err("分组不存在".into());
            }
        }
        let changed = db
            .execute(
                "UPDATE profile_records SET group_id = ?2 WHERE id = ?1",
                params![profile_id, group_id],
            )
            .map_err(|_| "无法设置窗口分组")?;
        if changed == 0 {
            return Err("窗口不存在".into());
        }
        Ok(())
    }
}

fn validate(name: &str, note: &str) -> Result<(String, String), String> {
    let name = name.trim();
    let note = note.trim();
    if name.is_empty() || name.chars().count() > 40 || note.chars().count() > 120 {
        return Err("分组名称需要 1 至 40 字，备注最多 120 字".into());
    }
    Ok((name.into(), note.into()))
}

#[tauri::command]
pub fn group_list(state: tauri::State<'_, GroupStore>) -> Result<Vec<Group>, String> {
    state.list()
}

#[tauri::command]
pub fn group_create(
    state: tauri::State<'_, GroupStore>,
    name: String,
    note: String,
) -> Result<Group, String> {
    state.create(&name, &note)
}

#[tauri::command]
pub fn group_update(
    state: tauri::State<'_, GroupStore>,
    id: String,
    name: String,
    note: String,
) -> Result<(), String> {
    state.update(&id, &name, &note)
}

#[tauri::command]
pub fn group_delete(state: tauri::State<'_, GroupStore>, id: String) -> Result<(), String> {
    state.delete(&id)
}
