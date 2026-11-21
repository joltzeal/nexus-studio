// Bookmark DTO, URL normalization, Chromium tree merge, and ownership markers
// follow ProxyShard/ShardBrowser at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
use crate::core::browser::connection_store::{BrowserConnection, ConnectionStore};
use crate::core::browser::provider::{
    BrowserError, BrowserProviderId, BrowserResult, SHARDBROWSER_CONNECTION_ID,
};
use crate::core::database::open_database;
use crate::core::window_service::WindowService;
use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior, params, params_from_iter,
    types::Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

const OWNED_KEY: &str = "shardx_owned";
const ID_KEY: &str = "shardx_id";
const OLD_FOLDER_KEY: &str = "shardx_managed";
const LEGACY_FOLDER: &str = "ShardX";
const ROOTS: [(&str, &str); 3] = [
    ("bookmark_bar", "Bookmarks bar"),
    ("other", "Other bookmarks"),
    ("synced", "Mobile bookmarks"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub root: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
}

#[derive(Clone)]
struct BookmarkStore {
    path: PathBuf,
}

struct StoredBookmark {
    id: String,
    title: String,
    url: String,
    folder_id: Option<String>,
    folder_name: Option<String>,
    root: String,
    path_json: String,
}

pub(crate) fn ensure_schema(db: &mut Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS shardbrowser_bookmarks(
           connection_id TEXT NOT NULL REFERENCES browser_connections(id),
           id TEXT NOT NULL,
           title TEXT NOT NULL,
           url TEXT NOT NULL,
           folder_id TEXT REFERENCES groups(id),
           chrome_root TEXT NOT NULL DEFAULT '',
           path_json TEXT NOT NULL DEFAULT '[]'
             CHECK(json_valid(path_json) AND json_type(path_json)='array'),
           sort_order INTEGER NOT NULL,
           PRIMARY KEY(connection_id,id)
         );
         CREATE INDEX IF NOT EXISTS shardbrowser_bookmarks_order
           ON shardbrowser_bookmarks(connection_id,sort_order);
         CREATE INDEX IF NOT EXISTS shardbrowser_bookmarks_folder
           ON shardbrowser_bookmarks(connection_id,folder_id);
         CREATE TRIGGER IF NOT EXISTS shardbrowser_bookmark_connection_insert
           BEFORE INSERT ON shardbrowser_bookmarks
           WHEN NOT EXISTS(
             SELECT 1 FROM browser_connections
             WHERE id=NEW.connection_id
               AND json_extract(record_json,'$.providerId')='shardbrowser'
           )
           BEGIN SELECT RAISE(ABORT,'bookmark connection is not ShardBrowser'); END;
         CREATE TRIGGER IF NOT EXISTS shardbrowser_bookmark_connection_update
           BEFORE UPDATE OF connection_id ON shardbrowser_bookmarks
           WHEN NOT EXISTS(
             SELECT 1 FROM browser_connections
             WHERE id=NEW.connection_id
               AND json_extract(record_json,'$.providerId')='shardbrowser'
           )
           BEGIN SELECT RAISE(ABORT,'bookmark connection is not ShardBrowser'); END;
         CREATE TRIGGER IF NOT EXISTS shardbrowser_bookmark_folder_insert
           BEFORE INSERT ON shardbrowser_bookmarks
           WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM groups
             WHERE id=NEW.folder_id
               AND connection_id=NEW.connection_id
               AND provider_id='shardbrowser'
           )
           BEGIN SELECT RAISE(ABORT,'bookmark folder belongs to another workspace'); END;
         CREATE TRIGGER IF NOT EXISTS shardbrowser_bookmark_folder_update
           BEFORE UPDATE OF connection_id,folder_id ON shardbrowser_bookmarks
           WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM groups
             WHERE id=NEW.folder_id
               AND connection_id=NEW.connection_id
               AND provider_id='shardbrowser'
           )
           BEGIN SELECT RAISE(ABORT,'bookmark folder belongs to another workspace'); END;",
    )
    .map_err(|_| "无法初始化 ShardBrowser 书签数据".to_owned())
}

fn storage(error: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", error.to_string())
}

fn invalid(message: impl Into<String>) -> BrowserError {
    BrowserError::new("invalid_config", message)
}

fn bookmark_apply_failed(error: impl std::fmt::Display) -> BrowserError {
    BrowserError::new(
        "bookmark_apply_failed",
        format!("无法更新 Profile 书签文件: {error}"),
    )
}

fn shardbrowser_connection(
    database: &Path,
    connection_id: &str,
) -> BrowserResult<BrowserConnection> {
    if connection_id != SHARDBROWSER_CONNECTION_ID {
        return Err(BrowserError::new(
            "scope_mismatch",
            "书签库只属于 ShardBrowser Workspace",
        ));
    }
    let connection = ConnectionStore::new(database.to_path_buf())?.get(connection_id)?;
    if connection.provider_id != BrowserProviderId::ShardBrowser || !connection.enabled {
        return Err(BrowserError::new("unavailable", "ShardBrowser 接入未启用"));
    }
    Ok(connection)
}

impl BookmarkStore {
    fn new(path: PathBuf) -> BrowserResult<Self> {
        open_database(&path).map_err(storage)?;
        Ok(Self { path })
    }

    fn connection(&self, connection_id: &str) -> BrowserResult<BrowserConnection> {
        shardbrowser_connection(&self.path, connection_id)
    }

    fn list(&self, connection_id: &str) -> BrowserResult<Vec<Bookmark>> {
        self.connection(connection_id)?;
        let db = open_database(&self.path).map_err(storage)?;
        let mut statement = db
            .prepare(
                "SELECT b.id,b.title,b.url,b.folder_id,g.name,b.chrome_root,b.path_json
                 FROM shardbrowser_bookmarks b
                 LEFT JOIN groups g
                   ON g.id=b.folder_id AND g.connection_id=b.connection_id
                 WHERE b.connection_id=?1
                 ORDER BY b.sort_order,b.rowid",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([connection_id], |row| {
                Ok(StoredBookmark {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    url: row.get(2)?,
                    folder_id: row.get(3)?,
                    folder_name: row.get(4)?,
                    root: row.get(5)?,
                    path_json: row.get(6)?,
                })
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows.into_iter().map(stored_bookmark).collect()
    }

    fn save(&self, connection_id: &str, bookmark: Bookmark) -> BrowserResult<Bookmark> {
        self.connection(connection_id)?;
        let mut bookmark = cleaned(bookmark)?;
        if bookmark.id.is_empty() {
            bookmark.id = Uuid::new_v4().to_string();
        }
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let folder_id = resolve_folder(&tx, connection_id, &bookmark.folder)?;
        let sort_order: Option<i64> = tx
            .query_row(
                "SELECT sort_order FROM shardbrowser_bookmarks
                 WHERE connection_id=?1 AND id=?2",
                params![connection_id, &bookmark.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        let sort_order = match sort_order {
            Some(value) => value,
            None => tx
                .query_row(
                    "SELECT COALESCE(MAX(sort_order),0)
                     FROM shardbrowser_bookmarks WHERE connection_id=?1",
                    [connection_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(storage)?
                .checked_add(1)
                .ok_or_else(|| storage("书签排序序号已用尽"))?,
        };
        let path_json = serde_json::to_string(&bookmark.path).map_err(storage)?;
        tx.execute(
            "INSERT INTO shardbrowser_bookmarks(
               connection_id,id,title,url,folder_id,chrome_root,path_json,sort_order
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(connection_id,id) DO UPDATE SET
               title=excluded.title,
               url=excluded.url,
               folder_id=excluded.folder_id,
               chrome_root=excluded.chrome_root,
               path_json=excluded.path_json",
            params![
                connection_id,
                &bookmark.id,
                &bookmark.title,
                &bookmark.url,
                folder_id.as_deref(),
                &bookmark.root,
                &path_json,
                sort_order
            ],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(bookmark)
    }

    fn delete(&self, connection_id: &str, id: &str) -> BrowserResult<()> {
        self.connection(connection_id)?;
        open_database(&self.path)
            .map_err(storage)?
            .execute(
                "DELETE FROM shardbrowser_bookmarks
                 WHERE connection_id=?1 AND id=?2",
                params![connection_id, id],
            )
            .map_err(storage)?;
        Ok(())
    }

    fn delete_many(&self, connection_id: &str, ids: &[String]) -> BrowserResult<()> {
        self.connection(connection_id)?;
        let ids: Vec<&str> = ids
            .iter()
            .map(String::as_str)
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        let placeholders = (2..=ids.len() + 1)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "DELETE FROM shardbrowser_bookmarks
             WHERE connection_id=?1 AND id IN({placeholders})"
        );
        let mut values = Vec::with_capacity(ids.len() + 1);
        values.push(SqlValue::Text(connection_id.to_owned()));
        values.extend(ids.into_iter().map(|id| SqlValue::Text(id.to_owned())));
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        tx.execute(&sql, params_from_iter(values))
            .map_err(storage)?;
        tx.commit().map_err(storage)
    }

    fn for_profile(
        &self,
        connection_id: &str,
        profile_id: &str,
    ) -> BrowserResult<(String, Vec<Bookmark>)> {
        self.connection(connection_id)?;
        let db = open_database(&self.path).map_err(storage)?;
        let profile: Option<(Option<String>, Option<String>)> = db
            .query_row(
                "SELECT p.group_id,g.name
                 FROM profile_records p
                 LEFT JOIN groups g
                   ON g.id=p.group_id AND g.connection_id=p.connection_id
                 WHERE p.id=?1
                   AND p.connection_id=?2
                   AND p.provider_id='shardbrowser'",
                params![profile_id, connection_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (folder_id, folder_name) =
            profile.ok_or_else(|| BrowserError::new("profile_missing", "Profile 不存在"))?;
        if folder_id.is_some() && folder_name.is_none() {
            return Err(storage("Profile 的 Folder 绑定已损坏"));
        }
        let mut statement = db
            .prepare(
                "SELECT b.id,b.title,b.url,b.folder_id,g.name,b.chrome_root,b.path_json
                 FROM shardbrowser_bookmarks b
                 LEFT JOIN groups g
                   ON g.id=b.folder_id AND g.connection_id=b.connection_id
                 WHERE b.connection_id=?1
                   AND (b.folder_id IS NULL OR b.folder_id=?2)
                 ORDER BY b.sort_order,b.rowid",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map(params![connection_id, folder_id.as_deref()], |row| {
                Ok(StoredBookmark {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    url: row.get(2)?,
                    folder_id: row.get(3)?,
                    folder_name: row.get(4)?,
                    root: row.get(5)?,
                    path_json: row.get(6)?,
                })
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        let bookmarks = rows
            .into_iter()
            .map(stored_bookmark)
            .collect::<BrowserResult<Vec<_>>>()?;
        Ok((folder_name.unwrap_or_default(), bookmarks))
    }
}

fn resolve_folder(
    db: &Connection,
    connection_id: &str,
    folder: &str,
) -> BrowserResult<Option<String>> {
    if folder.is_empty() {
        return Ok(None);
    }
    let id = db
        .query_row(
            "SELECT id FROM groups
         WHERE connection_id=?1 AND provider_id='shardbrowser' AND name=?2",
            params![connection_id, folder],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    id.map(Some)
        .ok_or_else(|| invalid("书签指定的 Folder 不存在"))
}

fn stored_bookmark(row: StoredBookmark) -> BrowserResult<Bookmark> {
    let folder = match (row.folder_id, row.folder_name) {
        (None, _) => String::new(),
        (Some(_), Some(name)) => name,
        (Some(_), None) => return Err(storage("书签的 Folder 绑定已损坏")),
    };
    let path = serde_json::from_str::<Vec<String>>(&row.path_json).map_err(storage)?;
    Ok(Bookmark {
        id: row.id,
        title: row.title,
        url: row.url,
        folder,
        root: row.root,
        path,
    })
}

fn cleaned(mut bookmark: Bookmark) -> BrowserResult<Bookmark> {
    bookmark.title = bookmark.title.trim().to_string();
    bookmark.url = normalise_url(&bookmark.url);
    bookmark.folder = bookmark.folder.trim().to_string();
    bookmark.root = match bookmark.root.trim().to_ascii_lowercase().as_str() {
        "" | "bookmark_bar" => String::new(),
        "other" => "other".into(),
        "synced" | "mobile" => "synced".into(),
        other => {
            return Err(invalid(format!(
                "书签根目录只能是 bookmark_bar、other 或 synced，不能是 {other:?}"
            )));
        }
    };
    bookmark.path = bookmark
        .path
        .iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();
    if bookmark.url.is_empty() {
        return Err(invalid("书签需要 URL"));
    }
    if is_bookmarklet(&bookmark.url) && bookmark.url["javascript:".len()..].trim().is_empty() {
        return Err(invalid("Bookmarklet 需要 javascript: 后的脚本"));
    }
    if bookmark.title.is_empty() {
        bookmark.title = bookmark.url.clone();
    }
    Ok(bookmark)
}

fn normalise_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains("://") || is_bookmarklet(trimmed) {
        return trimmed.to_string();
    }
    format!("https://{trimmed}")
}

fn is_bookmarklet(url: &str) -> bool {
    url.get(.."javascript:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("javascript:"))
}

pub(crate) fn apply_for_profile(
    database: &Path,
    connection_id: &str,
    profile_id: &str,
    user_data_dir: &Path,
) -> BrowserResult<usize> {
    let store = BookmarkStore::new(database.to_path_buf())?;
    let (folder, bookmarks) = store.for_profile(connection_id, profile_id)?;
    apply_to_profile(user_data_dir, &folder, &bookmarks).map_err(bookmark_apply_failed)
}

fn chrome_now() -> String {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    ((unix + 11_644_473_600) * 1_000_000).to_string()
}

fn empty_tree() -> Value {
    let timestamp = chrome_now();
    let root = |id: &str, name: &str| {
        json!({
            "children": [],
            "date_added": timestamp,
            "date_modified": timestamp,
            "guid": Uuid::new_v4().to_string(),
            "id": id,
            "name": name,
            "type": "folder"
        })
    };
    json!({
        "checksum": "",
        "roots": {
            "bookmark_bar": root("1", "Bookmarks bar"),
            "other": root("2", "Other bookmarks"),
            "synced": root("3", "Mobile bookmarks")
        },
        "version": 1
    })
}

fn max_id(node: &Value, current: &mut u64) {
    if let Some(id) = node
        .get("id")
        .and_then(Value::as_str)
        .and_then(|id| id.parse::<u64>().ok())
    {
        *current = (*current).max(id);
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            max_id(child, current);
        }
    }
    if let Some(roots) = node.get("roots").and_then(Value::as_object) {
        for root in roots.values() {
            max_id(root, current);
        }
    }
}

fn apply_to_profile(user_data_dir: &Path, folder: &str, all: &[Bookmark]) -> anyhow::Result<usize> {
    let wanted: Vec<&Bookmark> = all
        .iter()
        .filter(|bookmark| bookmark.folder.is_empty() || bookmark.folder == folder)
        .collect();
    let default_dir = user_data_dir.join("Default");
    let path = default_dir.join("Bookmarks");
    let existing = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    if wanted.is_empty() && existing.is_none() {
        return Ok(0);
    }
    let mut tree = existing.unwrap_or_else(empty_tree);
    if !tree.get("roots").is_some_and(Value::is_object) {
        return Ok(0);
    }
    let mut next_id = 0u64;
    max_id(&tree, &mut next_id);
    let mut reuse = HashMap::new();
    collect_ours(&tree["roots"], &mut reuse);
    let mut layout = Layout {
        reuse,
        next_id,
        timestamp: chrome_now(),
        had_ours: false,
    };
    for (key, name) in ROOTS {
        let root = &mut tree["roots"][key];
        if !root.is_object() {
            layout.next_id += 1;
            *root = json!({
                "children": [],
                "date_added": layout.timestamp,
                "date_modified": layout.timestamp,
                "id": layout.next_id.to_string(),
                "name": name,
                "type": "folder"
            });
        }
        let children = match root.get_mut("children").map(Value::take) {
            Some(Value::Array(children)) => children,
            _ => Vec::new(),
        };
        let wanted = wanted_tree(
            wanted
                .iter()
                .copied()
                .filter(|bookmark| root_of(bookmark) == key),
        );
        root["children"] = Value::Array(layout.merge(children, &wanted, key == "bookmark_bar"));
    }
    if wanted.is_empty() && !layout.had_ours {
        return Ok(0);
    }
    tree["checksum"] = json!("");
    if let Some(object) = tree.as_object_mut() {
        object.remove("checksum_sha256");
    }
    fs::create_dir_all(&default_dir)?;
    fs::write(&path, serde_json::to_string(&tree)?)?;
    Ok(wanted.len())
}

fn root_of(bookmark: &Bookmark) -> &'static str {
    match bookmark.root.as_str() {
        "other" => "other",
        "synced" => "synced",
        _ => "bookmark_bar",
    }
}

enum Want<'a> {
    Mark(&'a Bookmark),
    Folder(&'a str, Vec<Want<'a>>),
}

fn wanted_tree<'a>(bookmarks: impl Iterator<Item = &'a Bookmark>) -> Vec<Want<'a>> {
    let mut top = Vec::new();
    for bookmark in bookmarks {
        let mut children = &mut top;
        for name in &bookmark.path {
            let index = match children.iter().position(
                |item| matches!(item, Want::Folder(folder, _) if *folder == name.as_str()),
            ) {
                Some(index) => index,
                None => {
                    children.push(Want::Folder(name, Vec::new()));
                    children.len() - 1
                }
            };
            let Want::Folder(_, nested) = &mut children[index] else {
                unreachable!("matched a bookmark folder")
            };
            children = nested;
        }
        children.push(Want::Mark(bookmark));
    }
    top
}

fn owned(node: &Value) -> bool {
    node["meta_info"].get(OWNED_KEY).is_some()
}

fn old_folder(node: &Value, bar_top: bool) -> bool {
    node["type"] == "folder"
        && !owned(node)
        && (node["meta_info"].get(OLD_FOLDER_KEY).is_some()
            || (bar_top && node["name"] == LEGACY_FOLDER))
}

fn collect_ours(node: &Value, output: &mut HashMap<String, Value>) {
    if node["type"] == "url"
        && owned(node)
        && let Some(id) = node["meta_info"][ID_KEY]
            .as_str()
            .filter(|id| !id.is_empty())
    {
        output.entry(id.to_string()).or_insert_with(|| node.clone());
    }
    match node {
        Value::Object(object) if object.contains_key("children") => {
            node["children"]
                .as_array()
                .into_iter()
                .flatten()
                .for_each(|child| collect_ours(child, output));
        }
        Value::Object(object) => {
            object
                .values()
                .for_each(|child| collect_ours(child, output));
        }
        _ => {}
    }
}

enum Slot {
    Ours,
    Keep(Value),
    Folder(usize),
}

struct Layout {
    reuse: HashMap<String, Value>,
    next_id: u64,
    timestamp: String,
    had_ours: bool,
}

impl Layout {
    fn merge(&mut self, existing: Vec<Value>, wanted: &[Want], bar_top: bool) -> Vec<Value> {
        let mut sequence = Vec::new();
        let mut folders: Vec<Option<(String, Value)>> = Vec::new();
        for mut node in existing {
            if old_folder(&node, bar_top) {
                self.had_ours = true;
                sequence.push(Slot::Ours);
            } else if owned(&node) {
                self.had_ours = true;
                if node["type"] == "folder" {
                    folders.push(Some((
                        node["name"].as_str().unwrap_or_default().to_string(),
                        node,
                    )));
                    sequence.push(Slot::Folder(folders.len() - 1));
                } else {
                    sequence.push(Slot::Ours);
                }
            } else {
                if let Some(Value::Array(children)) = node.get_mut("children").map(Value::take) {
                    node["children"] = Value::Array(self.merge(children, &[], false));
                }
                sequence.push(Slot::Keep(node));
            }
        }
        let mut ours = Vec::with_capacity(wanted.len());
        for wanted in wanted {
            match wanted {
                Want::Mark(bookmark) => ours.push(self.mark_node(bookmark)),
                Want::Folder(name, children) => {
                    let found = folders
                        .iter_mut()
                        .find(|folder| folder.as_ref().is_some_and(|(found, _)| found == name));
                    let mut node = match found.and_then(Option::take) {
                        Some((_, node)) => node,
                        None => self.folder_node(name),
                    };
                    let existing = match node.get_mut("children").map(Value::take) {
                        Some(Value::Array(children)) => children,
                        _ => Vec::new(),
                    };
                    node["children"] = Value::Array(self.merge(existing, children, false));
                    ours.push(node);
                }
            }
        }
        let sequence: Vec<Slot> = sequence
            .into_iter()
            .map(|slot| match slot {
                Slot::Folder(index) => match folders[index].take() {
                    None => Slot::Ours,
                    Some((_, mut folder)) => {
                        let children = match folder.get_mut("children").map(Value::take) {
                            Some(Value::Array(children)) => self.merge(children, &[], false),
                            _ => Vec::new(),
                        };
                        if children.is_empty() {
                            Slot::Ours
                        } else {
                            folder["children"] = Value::Array(children);
                            Slot::Keep(folder)
                        }
                    }
                },
                slot => slot,
            })
            .collect();
        let slots = sequence
            .iter()
            .filter(|slot| matches!(slot, Slot::Ours))
            .count();
        let mut ours = ours.into_iter();
        let mut output: Vec<Value> = if slots == 0 {
            ours.by_ref().collect()
        } else {
            Vec::new()
        };
        let mut seen = 0;
        for slot in sequence {
            match slot {
                Slot::Keep(node) => output.push(node),
                Slot::Ours => {
                    seen += 1;
                    if seen < slots {
                        output.extend(ours.next());
                    } else {
                        output.extend(ours.by_ref());
                    }
                }
                Slot::Folder(_) => {}
            }
        }
        output
    }

    fn mark_node(&mut self, bookmark: &Bookmark) -> Value {
        let reused = (!bookmark.id.is_empty())
            .then(|| self.reuse.remove(&bookmark.id))
            .flatten();
        let mut node = reused.unwrap_or_else(|| {
            self.next_id += 1;
            json!({
                "date_added": self.timestamp,
                "date_last_used": "0",
                "guid": Uuid::new_v4().to_string(),
                "id": self.next_id.to_string()
            })
        });
        node["name"] = json!(bookmark.title);
        node["type"] = json!("url");
        node["url"] = json!(bookmark.url);
        mark_owned(&mut node, Some(&bookmark.id));
        node
    }

    fn folder_node(&mut self, name: &str) -> Value {
        self.next_id += 1;
        let mut node = json!({
            "children": [],
            "date_added": self.timestamp,
            "date_last_used": "0",
            "date_modified": self.timestamp,
            "guid": Uuid::new_v4().to_string(),
            "id": self.next_id.to_string(),
            "name": name,
            "type": "folder"
        });
        mark_owned(&mut node, None);
        node
    }
}

fn mark_owned(node: &mut Value, id: Option<&str>) {
    if !node["meta_info"].is_object() {
        node["meta_info"] = json!({});
    }
    node["meta_info"][OWNED_KEY] = json!("1");
    if let Some(id) = id.filter(|id| !id.is_empty()) {
        node["meta_info"][ID_KEY] = json!(id);
    }
}

async fn run<T: Send + 'static>(
    job: impl FnOnce() -> BrowserResult<T> + Send + 'static,
) -> BrowserResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "书签操作中断，请重新读取并核对结果"))?
}

#[tauri::command]
pub async fn shardbrowser_bookmark_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<Vec<Bookmark>> {
    let path = state.store.database_path();
    run(move || BookmarkStore::new(path)?.list(&connection_id)).await
}

#[tauri::command]
pub async fn shardbrowser_bookmark_save(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    entry: Bookmark,
    epoch: Option<u64>,
) -> BrowserResult<Bookmark> {
    let _ = epoch;
    let path = state.store.database_path();
    run(move || BookmarkStore::new(path)?.save(&connection_id, entry)).await
}

#[tauri::command]
pub async fn shardbrowser_bookmark_delete(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    id: String,
    epoch: Option<u64>,
) -> BrowserResult<()> {
    let _ = epoch;
    let path = state.store.database_path();
    run(move || BookmarkStore::new(path)?.delete(&connection_id, &id)).await
}

#[tauri::command]
pub async fn shardbrowser_bookmark_delete_many(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    ids: Vec<String>,
    epoch: Option<u64>,
) -> BrowserResult<()> {
    let _ = epoch;
    let path = state.store.database_path();
    run(move || BookmarkStore::new(path)?.delete_many(&connection_id, &ids)).await
}
