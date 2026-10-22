use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub configured: bool,
    pub plan: Option<String>,
    pub expires: Option<String>,
}

#[derive(Clone)]
pub struct LicenseStore {
    path: PathBuf,
}

impl LicenseStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法创建应用数据目录")?;
        }
        let store = Self { path };
        let connection = store.open()?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS cloakbrowser_license (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    license_key TEXT NOT NULL,
                    plan TEXT NOT NULL,
                    expires TEXT
                );",
            )
            .map_err(|_| "无法初始化授权数据库")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&store.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法限制授权数据库文件权限")?;
            if let Some(parent) = store.path.parent() {
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| "无法限制应用数据目录权限")?;
            }
        }
        Ok(store)
    }

    fn open(&self) -> Result<Connection, String> {
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|_| "无法打开授权数据库")?;
        connection
            .execute_batch("PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;")
            .map_err(|_| "无法设置授权数据库安全选项")?;
        Ok(connection)
    }

    pub fn status(&self) -> Result<LicenseStatus, String> {
        let connection = self.open()?;
        let metadata = connection
            .query_row(
                "SELECT plan, expires FROM cloakbrowser_license WHERE id = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|_| "无法读取 CloakBrowser 授权状态")?;
        Ok(match metadata {
            Some((plan, expires)) => LicenseStatus {
                configured: true,
                plan: Some(plan),
                expires,
            },
            None => LicenseStatus {
                configured: false,
                plan: None,
                expires: None,
            },
        })
    }

    pub fn license_key(&self) -> Result<Option<String>, String> {
        self.open()?
            .query_row(
                "SELECT license_key FROM cloakbrowser_license WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "无法读取 CloakBrowser 授权".to_string())
    }

    pub fn save_validated(
        &self,
        license_key: &str,
        plan: &str,
        expires: Option<&str>,
    ) -> Result<(), String> {
        let license_key = license_key.trim();
        if license_key.is_empty() || plan.trim().is_empty() {
            return Err("授权信息无效".into());
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction()
            .map_err(|_| "无法保存 CloakBrowser 授权")?;
        transaction
            .execute(
                "INSERT INTO cloakbrowser_license (id, license_key, plan, expires)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    license_key = excluded.license_key,
                    plan = excluded.plan,
                    expires = excluded.expires",
                params![license_key, plan.trim(), expires],
            )
            .map_err(|_| "无法保存 CloakBrowser 授权".to_string())?;
        transaction
            .commit()
            .map_err(|_| "无法保存 CloakBrowser 授权".to_string())
    }

    pub fn remove(&self) -> Result<(), String> {
        self.open()?
            .execute("DELETE FROM cloakbrowser_license WHERE id = 1", [])
            .map_err(|_| "无法移除 CloakBrowser 授权")?;
        Ok(())
    }

    pub fn browser_cache_dir(&self) -> PathBuf {
        self.path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("cloakbrowser")
    }
}
