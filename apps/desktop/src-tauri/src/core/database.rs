use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use super::browser::provider::BUILTIN_CONNECTION_ID;
use super::window_store::{WindowRecord, WindowStore};

pub(crate) const WINDOW_SORT_SEQUENCE: &str = "window_sort_order";

pub fn open_database(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建数据目录")?;
    }
    let mut db = Connection::open(path).map_err(|_| "无法打开本地数据库")?;
    db.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
         CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');
         CREATE TABLE IF NOT EXISTS profile_records(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,group_id TEXT REFERENCES groups(id) ON DELETE SET NULL);
         CREATE TABLE IF NOT EXISTS browser_schema(version INTEGER NOT NULL);",
    )
    .map_err(|_| "无法初始化数据库")?;
    let version: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(version),0) FROM browser_schema",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "无法读取数据库版本")?;
    if version == 0 {
        upgrade_windows(&mut db, path)?;
    } else if version != 2 {
        return Err("此数据库版本不受当前应用支持".into());
    } else {
        let sequence: i64 = db
            .query_row(
                "SELECT value FROM browser_sequences WHERE name=?1",
                [WINDOW_SORT_SEQUENCE],
                |row| row.get(0),
            )
            .map_err(|_| "窗口排序数据缺失或损坏，数据库无法打开")?;
        if sequence < 0 {
            return Err("窗口排序数据缺失或损坏，数据库无法打开".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置数据库权限")?;
    }
    Ok(db)
}

/// Runs once before window commands become available; normal reads accept only schema 2.
fn upgrade_windows(db: &mut Connection, path: &Path) -> Result<(), String> {
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM profile_records", [], |r| r.get(0))
        .map_err(|_| "无法检查窗口数据")?;
    if count > 0 {
        let backup =
            path.with_extension(format!("before-browser-v2-{}.sqlite", uuid::Uuid::new_v4()));
        db.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
            .map_err(|_| "窗口升级前数据库备份失败，已停止升级")?;
    }
    let store = WindowStore::new(
        path.parent()
            .unwrap_or_else(|| Path::new("."))
            .join("profiles"),
    );
    let tx = db.transaction().map_err(|_| "无法开始窗口数据升级")?;
    let records = {
        let mut query = tx
            .prepare("SELECT id,record_json,rowid FROM profile_records ORDER BY rowid")
            .map_err(|_| "无法读取待升级窗口")?;
        let collected = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|_| "无法读取待升级窗口")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取待升级窗口")?;
        collected
    };
    for (id, text, order) in records {
        let mut record: Value =
            serde_json::from_str(&text).map_err(|_| "窗口数据损坏，升级已回滚")?;
        if record["schema_version"] != 1
            || record["id"] != id
            || record["binding"]["profile_id"] != id
        {
            return Err("待升级窗口格式异常，升级已回滚".into());
        }
        let display = record["binding"]["channel_version"]
            .as_str()
            .ok_or("窗口内核绑定缺失")?
            .to_owned();
        let binary = record["binary_path"].as_str().ok_or("窗口内核路径缺失")?;
        let package = Path::new(binary)
            .components()
            .filter_map(|part| part.as_os_str().to_str())
            .find_map(|part| part.strip_prefix("chromium-")?.strip_suffix("-pro"))
            .unwrap_or(&display)
            .to_owned();
        record["schema_version"] = json!(2);
        record["binding"] = json!({"provider_id":"cloakbrowser","connection_id":BUILTIN_CONNECTION_ID,"profile_id":id});
        record["kernel_version"] = json!(package);
        record["origin"] = json!("created");
        record["provider_config"] = json!({"displayVersion":display});
        record["sort_order"] = json!(order);
        record["proxy_mode"] = json!(if record["proxy_plugin"].is_string() {
            "plugin"
        } else if record["proxy"].is_string() {
            "manual"
        } else {
            "direct"
        });
        let record: WindowRecord =
            serde_json::from_value(record).map_err(|_| "窗口数据格式无效，升级已回滚")?;
        store
            .validate_record(&id, &record)
            .map_err(|error| format!("窗口数据无效，升级已回滚：{error}"))?;
        tx.execute(
            "UPDATE profile_records SET record_json=?2 WHERE id=?1",
            params![
                id,
                serde_json::to_string(&record).map_err(|_| "窗口数据编码失败，升级已回滚")?
            ],
        )
        .map_err(|_| "窗口升级写入失败，已回滚")?;
    }
    tx.execute_batch(
        "CREATE TABLE browser_connections(id TEXT PRIMARY KEY,provider TEXT NOT NULL,enabled INTEGER NOT NULL,record_json TEXT NOT NULL);
         CREATE UNIQUE INDEX one_active_browser_connection ON browser_connections(provider) WHERE enabled=1;
         ALTER TABLE profile_records ADD COLUMN connection_id TEXT GENERATED ALWAYS AS(json_extract(record_json,'$.binding.connection_id')) VIRTUAL;
         ALTER TABLE profile_records ADD COLUMN provider_profile_id TEXT GENERATED ALWAYS AS(json_extract(record_json,'$.binding.profile_id')) VIRTUAL;
         ALTER TABLE profile_records ADD COLUMN sort_order INTEGER GENERATED ALWAYS AS(json_extract(record_json,'$.sort_order')) VIRTUAL;
         CREATE UNIQUE INDEX browser_window_binding ON profile_records(connection_id,provider_profile_id);
         CREATE INDEX IF NOT EXISTS idx_profile_group ON profile_records(group_id);
         CREATE TABLE browser_operations(id TEXT PRIMARY KEY,window_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL,phase TEXT NOT NULL,record_json TEXT NOT NULL);
         CREATE TABLE browser_session_observations(window_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
         INSERT INTO browser_schema(version) VALUES(2);",
    ).map_err(|_| "无法提交浏览器数据结构升级")?;
    initialize_sort_sequence(&tx)?;
    tx.commit().map_err(|_| "窗口数据升级提交失败".to_owned())
}

fn initialize_sort_sequence(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE browser_sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);",
    )
    .map_err(|_| "无法创建窗口排序数据")?;
    db.execute(
        "INSERT INTO browser_sequences(name,value)
         SELECT ?1,MAX(0,
             COALESCE((SELECT MAX(sort_order) FROM profile_records),0),
             COALESCE((SELECT MAX(json_extract(record_json,'$.payload.record.sort_order')) FROM browser_operations),0))",
        [WINDOW_SORT_SEQUENCE],
    )
    .map_err(|_| "无法初始化窗口排序数据")?;
    Ok(())
}
