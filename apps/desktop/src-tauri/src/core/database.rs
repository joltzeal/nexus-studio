use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::PathBuf;

pub(crate) const WINDOW_SORT_SEQUENCE: &str = "window_sort_order";
const DATABASE_VERSION: i64 = 4;

pub fn open_database(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建数据目录")?;
    }
    let mut db = Connection::open(path).map_err(|_| "无法打开本地数据库")?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|_| "无法初始化数据库")?;

    let has_schema: Option<i64> = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_schema'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "无法读取数据库版本")?;
    if has_schema.is_none() {
        let existing = {
            let mut query = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                .map_err(|_| "无法检查数据库结构")?;
            query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| "无法检查数据库结构")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "无法检查数据库结构")?
        };
        // An interrupted 0.2 startup may have created only auxiliary tables.
        // Preserve those rows while completing the browser schema; reject other layouts.
        if existing.iter().any(|name| {
            !matches!(
                name.as_str(),
                "network_proxy" | "cloakbrowser_license" | "plugin_entitlements"
            )
        }) {
            return Err("此数据库不是 Raccoon 0.2 工作区，旧数据需通过独立工具迁移".into());
        }
        initialize_database(&mut db)?;
    }
    let (count, version): (i64, Option<i64>) = db
        .query_row(
            "SELECT COUNT(*), MAX(version) FROM browser_schema",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "无法读取数据库版本")?;
    if count != 1 || version != Some(DATABASE_VERSION) {
        return Err("此数据库版本不受 Raccoon 0.2 支持".into());
    }
    ensure_folder_appearance(&mut db)?;
    ensure_scope_triggers(&mut db)?;
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
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_proxy_library(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS browser_proxy_tests(
           sequence INTEGER PRIMARY KEY AUTOINCREMENT,
           proxy_id TEXT NOT NULL REFERENCES browser_proxy_library(id) ON DELETE CASCADE,
           record_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS browser_proxy_tests_history ON browser_proxy_tests(proxy_id,sequence);
         CREATE TRIGGER IF NOT EXISTS profile_proxy_reference_insert BEFORE INSERT ON profile_records
           WHEN json_extract(NEW.record_json,'$.proxy_id') IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM browser_proxy_library WHERE id=json_extract(NEW.record_json,'$.proxy_id')
           ) BEGIN SELECT RAISE(ABORT,'bound proxy is missing'); END;
         CREATE TRIGGER IF NOT EXISTS profile_proxy_reference_update BEFORE UPDATE OF record_json ON profile_records
           WHEN json_extract(NEW.record_json,'$.proxy_id') IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM browser_proxy_library WHERE id=json_extract(NEW.record_json,'$.proxy_id')
           ) BEGIN SELECT RAISE(ABORT,'bound proxy is missing'); END;
         CREATE TRIGGER IF NOT EXISTS operation_proxy_reference_insert BEFORE INSERT ON browser_operations
           WHEN json_extract(NEW.record_json,'$.payload.record.proxy_id') IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM browser_proxy_library WHERE id=json_extract(NEW.record_json,'$.payload.record.proxy_id')
           ) BEGIN SELECT RAISE(ABORT,'bound proxy is missing'); END;
         CREATE TRIGGER IF NOT EXISTS operation_proxy_reference_update BEFORE UPDATE ON browser_operations
           WHEN NEW.phase NOT IN('committed','cancelled','failed')
             AND json_extract(NEW.record_json,'$.payload.record.proxy_id') IS NOT NULL AND NOT EXISTS(
               SELECT 1 FROM browser_proxy_library WHERE id=json_extract(NEW.record_json,'$.payload.record.proxy_id')
             ) BEGIN SELECT RAISE(ABORT,'bound proxy is missing'); END;
         CREATE TRIGGER IF NOT EXISTS browser_proxy_reference_delete BEFORE DELETE ON browser_proxy_library
           WHEN EXISTS(SELECT 1 FROM profile_records WHERE json_extract(record_json,'$.proxy_id')=OLD.id)
             OR EXISTS(SELECT 1 FROM browser_operations WHERE phase NOT IN('committed','failed','cancelled')
               AND (json_extract(record_json,'$.payload.record.proxy_id')=OLD.id
                 OR json_extract(record_json,'$.payload.previous.proxy_id')=OLD.id))
           BEGIN SELECT RAISE(ABORT,'proxy is referenced'); END;",
    )
    .map_err(|_| "无法初始化全局代理库")?;
    super::workbench_tags::ensure_schema(&mut db)?;
    super::workbench_trash::ensure_schema(&mut db)?;
    super::shardbrowser_extensions::ensure_schema(&mut db)?;
    super::shardbrowser_bookmarks::ensure_schema(&mut db)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置数据库权限")?;
    }
    Ok(db)
}

/// Refresh the scope triggers in existing 0.2 databases. Connections store
/// providers as JSON strings, while Folders store plain provider IDs. Profile
/// triggers read the binding from `record_json` before generated columns are populated.
fn ensure_scope_triggers(db: &mut Connection) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "无法更新 Folder 作用域校验")?;
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS group_connection_scope_insert;
         DROP TRIGGER IF EXISTS window_group_scope_insert;
         DROP TRIGGER IF EXISTS window_group_scope_update;
         CREATE TRIGGER group_connection_scope_insert BEFORE INSERT ON groups
           WHEN NOT EXISTS(SELECT 1 FROM browser_connections WHERE id=NEW.connection_id AND provider=json_quote(NEW.provider_id))
           BEGIN SELECT RAISE(ABORT,'folder provider does not match connection'); END;
         CREATE TRIGGER window_group_scope_insert BEFORE INSERT ON profile_records
           WHEN NEW.group_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM groups WHERE id=NEW.group_id
               AND provider_id=json_extract(NEW.record_json,'$.binding.provider_id')
               AND connection_id=json_extract(NEW.record_json,'$.binding.connection_id')
           ) BEGIN SELECT RAISE(ABORT,'window group belongs to a different workspace'); END;
         CREATE TRIGGER window_group_scope_update BEFORE UPDATE OF group_id,record_json ON profile_records
           WHEN NEW.group_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM groups WHERE id=NEW.group_id
               AND provider_id=json_extract(NEW.record_json,'$.binding.provider_id')
               AND connection_id=json_extract(NEW.record_json,'$.binding.connection_id')
           ) BEGIN SELECT RAISE(ABORT,'window group belongs to a different workspace'); END;",
    )
    .map_err(|_| "无法更新 Folder 作用域校验")?;
    tx.commit().map_err(|_| "无法保存 Folder 作用域校验".into())
}

/// Add optional Folder presentation to existing 0.2 workspaces in one transaction.
fn ensure_folder_appearance(db: &mut Connection) -> Result<(), String> {
    let present: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('groups') WHERE name IN('color','icon')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "无法读取 Folder 字段")?;
    if present == 2 {
        return Ok(());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "无法更新 Folder 外观字段")?;
    let columns = {
        let mut query = tx
            .prepare("PRAGMA table_info(groups)")
            .map_err(|_| "无法读取 Folder 字段")?;
        query
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|_| "无法读取 Folder 字段")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取 Folder 字段")?
    };
    if !columns.iter().any(|column| column == "color") {
        tx.execute_batch("ALTER TABLE groups ADD COLUMN color TEXT DEFAULT NULL CHECK(color IS NULL OR color IN('blue','violet','magenta','red','orange','yellow','green','sky'));")
            .map_err(|_| "无法添加 Folder 颜色字段")?;
    }
    if !columns.iter().any(|column| column == "icon") {
        tx.execute_batch("ALTER TABLE groups ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder' CHECK(icon IN('folder','briefcase','cart','megaphone','people','globe','star','code','game','wallet','mail','rocket'));")
            .map_err(|_| "无法添加 Folder 图标字段")?;
    }
    tx.commit().map_err(|_| "无法保存 Folder 外观字段".into())
}

fn initialize_database(db: &mut Connection) -> Result<(), String> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "无法开始初始化数据库")?;
    tx.execute_batch(
        "CREATE TABLE browser_schema(version INTEGER NOT NULL);
         CREATE TABLE browser_connections(id TEXT PRIMARY KEY,provider TEXT NOT NULL,enabled INTEGER NOT NULL,record_json TEXT NOT NULL);
         CREATE UNIQUE INDEX one_active_browser_connection ON browser_connections(provider) WHERE enabled=1;
         CREATE TABLE groups(
           id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,connection_id TEXT NOT NULL,
           name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',
           color TEXT DEFAULT NULL CHECK(color IS NULL OR color IN('blue','violet','magenta','red','orange','yellow','green','sky')),
           icon TEXT NOT NULL DEFAULT 'folder' CHECK(icon IN('folder','briefcase','cart','megaphone','people','globe','star','code','game','wallet','mail','rocket')),
           FOREIGN KEY(connection_id) REFERENCES browser_connections(id)
         );
         CREATE INDEX idx_group_connection ON groups(connection_id);
         CREATE TRIGGER group_connection_scope_insert BEFORE INSERT ON groups
           WHEN NOT EXISTS(SELECT 1 FROM browser_connections WHERE id=NEW.connection_id AND provider=json_quote(NEW.provider_id))
           BEGIN SELECT RAISE(ABORT,'folder provider does not match connection'); END;
         CREATE TRIGGER group_binding_immutable BEFORE UPDATE OF id,provider_id,connection_id ON groups
           WHEN NEW.id IS NOT OLD.id OR NEW.provider_id IS NOT OLD.provider_id OR NEW.connection_id IS NOT OLD.connection_id
           BEGIN SELECT RAISE(ABORT,'folder binding is immutable'); END;
         CREATE TABLE profile_records(
           id TEXT PRIMARY KEY,record_json TEXT NOT NULL,
           group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
           connection_id TEXT GENERATED ALWAYS AS(json_extract(record_json,'$.binding.connection_id')) VIRTUAL,
           provider_id TEXT GENERATED ALWAYS AS(json_extract(record_json,'$.binding.provider_id')) VIRTUAL,
           provider_profile_id TEXT GENERATED ALWAYS AS(json_extract(record_json,'$.binding.profile_id')) VIRTUAL,
           sort_order INTEGER GENERATED ALWAYS AS(json_extract(record_json,'$.sort_order')) VIRTUAL
         );
         CREATE INDEX idx_profile_group ON profile_records(group_id);
         CREATE UNIQUE INDEX browser_window_binding ON profile_records(connection_id,provider_profile_id);
         CREATE TRIGGER window_group_scope_insert BEFORE INSERT ON profile_records
           WHEN NEW.group_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM groups WHERE id=NEW.group_id
               AND provider_id=json_extract(NEW.record_json,'$.binding.provider_id')
               AND connection_id=json_extract(NEW.record_json,'$.binding.connection_id')
           ) BEGIN SELECT RAISE(ABORT,'window group belongs to a different workspace'); END;
         CREATE TRIGGER window_group_scope_update BEFORE UPDATE OF group_id,record_json ON profile_records
           WHEN NEW.group_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM groups WHERE id=NEW.group_id
               AND provider_id=json_extract(NEW.record_json,'$.binding.provider_id')
               AND connection_id=json_extract(NEW.record_json,'$.binding.connection_id')
           ) BEGIN SELECT RAISE(ABORT,'window group belongs to a different workspace'); END;
         CREATE TABLE browser_operations(id TEXT PRIMARY KEY,window_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL,phase TEXT NOT NULL,record_json TEXT NOT NULL);
         CREATE TABLE browser_session_observations(window_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
         CREATE TABLE browser_sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);",
    )
    .map_err(|_| "无法创建 0.2 数据结构")?;
    tx.execute(
        "INSERT INTO browser_sequences(name,value) VALUES(?1,0)",
        [WINDOW_SORT_SEQUENCE],
    )
    .map_err(|_| "无法初始化窗口排序数据")?;
    tx.execute(
        "INSERT INTO browser_schema(version) VALUES(?1)",
        params![DATABASE_VERSION],
    )
    .map_err(|_| "无法写入数据库版本")?;
    tx.commit().map_err(|_| "无法提交 0.2 数据结构".into())
}
