use super::browser::{
    connection_store::ConnectionStore,
    provider::{BrowserError, BrowserProviderId, BrowserResult},
};
use super::database::open_database;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
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
    pub provider_id: BrowserProviderId,
    pub connection_id: String,
    pub name: String,
    pub note: String,
    pub window_count: u32,
    pub color: Option<String>,
    pub icon: String,
}

pub struct FolderAppearance {
    pub color: Option<String>,
    pub icon: String,
}

impl Default for FolderAppearance {
    fn default() -> Self {
        Self {
            color: None,
            icon: "folder".into(),
        }
    }
}

impl FolderAppearance {
    fn validate(&self) -> Result<(), String> {
        if self.color.as_deref().is_some_and(|color| {
            ![
                "blue", "violet", "magenta", "red", "orange", "yellow", "green", "sky",
            ]
            .contains(&color)
        }) || ![
            "folder",
            "briefcase",
            "cart",
            "megaphone",
            "people",
            "globe",
            "star",
            "code",
            "game",
            "wallet",
            "mail",
            "rocket",
        ]
        .contains(&self.icon.as_str())
        {
            return Err("文件夹颜色或图标无效".into());
        }
        Ok(())
    }
}

impl GroupStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        open_database(&path)?;
        Ok(Self { path })
    }

    fn enabled_connection(&self, provider_id: BrowserProviderId) -> Result<String, String> {
        ConnectionStore::new(self.path.clone())
            .and_then(|store| store.list())
            .map_err(|error| error.message)?
            .into_iter()
            .find(|connection| connection.provider_id == provider_id && connection.enabled)
            .map(|connection| connection.id)
            .ok_or_else(|| "此浏览器提供方没有已启用的接入".into())
    }

    fn connection_provider(&self, connection_id: &str) -> Result<BrowserProviderId, String> {
        ConnectionStore::new(self.path.clone())
            .and_then(|store| store.get(connection_id))
            .map(|connection| connection.provider_id)
            .map_err(|error| error.message)
    }

    pub fn list(&self, provider_id: BrowserProviderId) -> Result<Vec<Group>, String> {
        self.list_for_connection(&self.enabled_connection(provider_id)?)
    }

    pub fn list_for_connection(&self, connection_id: &str) -> Result<Vec<Group>, String> {
        let provider_id = self.connection_provider(connection_id)?;
        let db = open_database(&self.path)?;
        let mut statement = db
            .prepare(
                "SELECT g.id, g.name, g.note, COUNT(p.id), g.color, g.icon
                 FROM groups g LEFT JOIN profile_records p ON p.group_id = g.id
                   AND p.connection_id = g.connection_id AND p.provider_id = g.provider_id
                   AND NOT EXISTS(SELECT 1 FROM browser_profile_trash t WHERE t.profile_id=p.id)
                 WHERE g.connection_id = ?1 GROUP BY g.id ORDER BY g.rowid",
            )
            .map_err(|_| "无法读取文件夹")?;
        statement
            .query_map([connection_id], |row| {
                Ok(Group {
                    id: row.get(0)?,
                    provider_id,
                    connection_id: connection_id.into(),
                    name: row.get(1)?,
                    note: row.get(2)?,
                    window_count: row.get(3)?,
                    color: row.get(4)?,
                    icon: row.get(5)?,
                })
            })
            .map_err(|_| "无法读取文件夹")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取文件夹".into())
    }

    pub fn create(
        &self,
        provider_id: BrowserProviderId,
        name: &str,
        note: &str,
    ) -> Result<Group, String> {
        self.create_for_connection(&self.enabled_connection(provider_id)?, name, note)
    }

    pub fn create_for_connection(
        &self,
        connection_id: &str,
        name: &str,
        note: &str,
    ) -> Result<Group, String> {
        self.create_with_appearance(connection_id, name, note, FolderAppearance::default())
    }

    pub fn create_with_appearance(
        &self,
        connection_id: &str,
        name: &str,
        note: &str,
        appearance: FolderAppearance,
    ) -> Result<Group, String> {
        let provider_id = self.connection_provider(connection_id)?;
        let (name, note) = validate(name, note)?;
        appearance.validate()?;
        let id = Uuid::new_v4().to_string();
        let mut db = open_database(&self.path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法开始创建文件夹")?;
        unique_folder_name(&tx, connection_id, &name, None)?;
        tx
            .execute(
                "INSERT INTO groups (id, provider_id, connection_id, name, note, color, icon) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, provider_id.as_str(), connection_id, name, note, appearance.color, appearance.icon],
            )
            .map_err(|_| "无法创建文件夹")?;
        tx.commit().map_err(|_| "无法保存文件夹")?;
        Ok(Group {
            id,
            provider_id,
            connection_id: connection_id.into(),
            name,
            note,
            window_count: 0,
            color: appearance.color,
            icon: appearance.icon,
        })
    }

    pub fn update(
        &self,
        provider_id: BrowserProviderId,
        id: &str,
        name: &str,
        note: &str,
    ) -> Result<(), String> {
        self.update_for_connection(&self.enabled_connection(provider_id)?, id, name, note)
    }

    pub fn update_for_connection(
        &self,
        connection_id: &str,
        id: &str,
        name: &str,
        note: &str,
    ) -> Result<(), String> {
        self.update_with_appearance(connection_id, id, name, note, None)
    }

    pub fn update_with_appearance(
        &self,
        connection_id: &str,
        id: &str,
        name: &str,
        note: &str,
        appearance: Option<FolderAppearance>,
    ) -> Result<(), String> {
        self.connection_provider(connection_id)?;
        Uuid::parse_str(id).map_err(|_| "文件夹标识无效")?;
        let (name, note) = validate(name, note)?;
        if let Some(appearance) = &appearance {
            appearance.validate()?;
        }
        let mut db = open_database(&self.path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法更新文件夹")?;
        unique_folder_name(&tx, connection_id, &name, Some(id))?;
        let changed = match appearance {
            Some(appearance) => tx.execute(
                "UPDATE groups SET name = ?3, note = ?4, color = ?5, icon = ?6 WHERE id = ?1 AND connection_id = ?2",
                params![id, connection_id, name, note, appearance.color, appearance.icon],
            ),
            None => tx.execute(
                "UPDATE groups SET name = ?3, note = ?4 WHERE id = ?1 AND connection_id = ?2",
                params![id, connection_id, name, note],
            ),
        }
            .map_err(|_| "无法更新文件夹")?;
        if changed == 0 {
            return Err("文件夹不存在".into());
        }
        tx.commit().map_err(|_| "无法保存文件夹")?;
        Ok(())
    }

    pub fn delete(&self, provider_id: BrowserProviderId, id: &str) -> Result<(), String> {
        self.delete_for_connection(&self.enabled_connection(provider_id)?, id)
    }

    pub fn delete_for_connection(&self, connection_id: &str, id: &str) -> Result<(), String> {
        self.connection_provider(connection_id)?;
        Uuid::parse_str(id).map_err(|_| "文件夹标识无效")?;
        let changed = open_database(&self.path)?
            .execute(
                "DELETE FROM groups WHERE id = ?1 AND connection_id = ?2",
                params![id, connection_id],
            )
            .map_err(|_| "无法删除文件夹")?;
        if changed == 0 {
            return Err("文件夹不存在".into());
        }
        Ok(())
    }

    pub fn assign(
        &self,
        provider_id: BrowserProviderId,
        profile_id: &str,
        group_id: Option<&str>,
    ) -> Result<(), String> {
        self.assign_many(provider_id, &[profile_id.to_owned()], group_id)
    }

    pub fn assign_many(
        &self,
        provider_id: BrowserProviderId,
        profile_ids: &[String],
        group_id: Option<&str>,
    ) -> Result<(), String> {
        self.assign_many_for_connection(
            &self.enabled_connection(provider_id)?,
            profile_ids,
            group_id,
        )
    }

    pub fn assign_many_for_connection(
        &self,
        connection_id: &str,
        profile_ids: &[String],
        group_id: Option<&str>,
    ) -> Result<(), String> {
        let provider_id = self.connection_provider(connection_id)?;
        if profile_ids.is_empty() {
            return Err("请先选择窗口".into());
        }
        let mut unique = std::collections::HashSet::new();
        for id in profile_ids {
            Uuid::parse_str(id).map_err(|_| "窗口标识无效")?;
            if !unique.insert(id) {
                return Err("窗口不能重复".into());
            }
        }
        if let Some(id) = group_id {
            Uuid::parse_str(id).map_err(|_| "文件夹标识无效")?;
        }
        let mut db = open_database(&self.path)?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法移动 Profile 到文件夹")?;
        if let Some(id) = group_id {
            let exists: Option<i32> = transaction
                .query_row(
                    "SELECT 1 FROM groups WHERE id = ?1 AND connection_id = ?2 AND provider_id = ?3",
                    params![id, connection_id, provider_id.as_str()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "无法检查文件夹")?;
            if exists.is_none() {
                return Err("文件夹不存在".into());
            }
        }
        for profile_id in profile_ids {
            let changed = transaction
                .execute(
                    "UPDATE profile_records SET group_id = ?2 WHERE id = ?1 AND connection_id = ?3 AND provider_id = ?4",
                    params![profile_id, group_id, connection_id, provider_id.as_str()],
                )
                .map_err(|_| "无法移动 Profile 到文件夹")?;
            if changed == 0 {
                return Err("窗口不存在".into());
            }
        }
        transaction
            .commit()
            .map_err(|_| "无法保存 Profile 的文件夹")?;
        Ok(())
    }
}

fn unique_folder_name(
    db: &rusqlite::Connection,
    connection_id: &str,
    name: &str,
    id: Option<&str>,
) -> Result<(), String> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM groups WHERE connection_id = ?1 AND name = ?2 AND (?3 IS NULL OR id != ?3))",
        params![connection_id, name, id], |row| row.get(0),
    ).map_err(|_| "无法检查文件夹名称")?;
    if exists {
        return Err("此文件夹名称已存在".into());
    }
    Ok(())
}

fn validate(name: &str, note: &str) -> Result<(String, String), String> {
    let name = name.trim();
    let note = note.trim();
    if name.is_empty() || name.chars().count() > 40 || note.chars().count() > 120 {
        return Err("文件夹名称需要 1 至 40 字，备注最多 120 字".into());
    }
    Ok((name.into(), note.into()))
}

#[tauri::command]
pub fn group_list(
    state: tauri::State<'_, GroupStore>,
    provider_id: BrowserProviderId,
) -> Result<Vec<Group>, String> {
    state.list(provider_id)
}

#[tauri::command]
pub fn group_create(
    state: tauri::State<'_, GroupStore>,
    provider_id: BrowserProviderId,
    name: String,
    note: String,
) -> Result<Group, String> {
    state.create(provider_id, &name, &note)
}

#[tauri::command]
pub fn group_update(
    state: tauri::State<'_, GroupStore>,
    provider_id: BrowserProviderId,
    id: String,
    name: String,
    note: String,
) -> Result<(), String> {
    state.update(provider_id, &id, &name, &note)
}

#[tauri::command]
pub fn group_delete(
    state: tauri::State<'_, GroupStore>,
    provider_id: BrowserProviderId,
    id: String,
) -> Result<(), String> {
    state.delete(provider_id, &id)
}

/// Native Folder response consumed by desktop-v2.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub note: String,
    pub window_count: u32,
    pub color: Option<String>,
    pub icon: String,
}

fn folder_error(message: String) -> BrowserError {
    BrowserError::new("folder_failed", message)
}

impl From<Group> for Folder {
    fn from(group: Group) -> Self {
        Self {
            id: group.id,
            connection_id: group.connection_id,
            name: group.name,
            note: group.note,
            window_count: group.window_count,
            color: group.color,
            icon: group.icon,
        }
    }
}

#[tauri::command]
pub fn browser_folder_list(
    state: tauri::State<'_, GroupStore>,
    connection_id: String,
) -> BrowserResult<Vec<Folder>> {
    state
        .list_for_connection(&connection_id)
        .map(|groups| groups.into_iter().map(Folder::from).collect())
        .map_err(folder_error)
}

#[tauri::command]
pub fn browser_folder_create(
    state: tauri::State<'_, GroupStore>,
    connection_id: String,
    name: String,
    note: Option<String>,
    color: Option<String>,
    icon: Option<String>,
) -> BrowserResult<Folder> {
    state
        .create_with_appearance(
            &connection_id,
            &name,
            note.as_deref().unwrap_or(""),
            FolderAppearance {
                color,
                icon: icon.unwrap_or_else(|| "folder".into()),
            },
        )
        .map(Folder::from)
        .map_err(folder_error)
}

#[tauri::command]
pub fn browser_folder_update(
    state: tauri::State<'_, GroupStore>,
    connection_id: String,
    id: String,
    name: String,
    note: Option<String>,
    color: Option<String>,
    icon: Option<String>,
) -> BrowserResult<()> {
    let appearance = if color.is_some() || icon.is_some() {
        Some(FolderAppearance {
            color,
            icon: icon.unwrap_or_else(|| "folder".into()),
        })
    } else {
        None
    };
    state
        .update_with_appearance(
            &connection_id,
            &id,
            &name,
            note.as_deref().unwrap_or(""),
            appearance,
        )
        .map_err(folder_error)
}

#[tauri::command]
pub fn browser_folder_delete(
    state: tauri::State<'_, GroupStore>,
    connection_id: String,
    id: String,
) -> BrowserResult<()> {
    state
        .delete_for_connection(&connection_id, &id)
        .map_err(folder_error)
}
