use super::provider::{BUILTIN_CONNECTION_ID, BrowserError, BrowserProviderId, BrowserResult};
use crate::core::database::open_database;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserConnection {
    pub id: String,
    pub provider_id: BrowserProviderId,
    pub name: String,
    pub endpoint: String,
    pub api_key: Option<String>,
    pub default_group_id: Option<String>,
    pub scope_label: String,
    pub scope_id: Option<String>,
    pub scope_confirmed: bool,
    pub enabled: bool,
    pub revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub provider_id: BrowserProviderId,
    pub name: String,
    pub endpoint: String,
    pub api_key: Option<String>,
    pub default_group_id: Option<String>,
    pub scope_label: String,
}

pub struct ConnectionStore {
    path: PathBuf,
}
fn storage(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法读写浏览器接入")
}
fn conflict() -> BrowserError {
    BrowserError::new("connection_conflict", "浏览器接入已更新，请重新加载后重试")
}

impl ConnectionStore {
    pub fn new(path: PathBuf) -> BrowserResult<Self> {
        let store = Self { path };
        match store.get(BUILTIN_CONNECTION_ID) {
            Ok(_) => {}
            Err(error) if error.code == "connection_missing" => {
                store.write(
                    &BrowserConnection {
                        id: BUILTIN_CONNECTION_ID.into(),
                        provider_id: BrowserProviderId::CloakBrowser,
                        name: "内置浏览器".into(),
                        endpoint: String::new(),
                        api_key: None,
                        default_group_id: None,
                        scope_label: "本机".into(),
                        scope_id: Some(BUILTIN_CONNECTION_ID.into()),
                        scope_confirmed: true,
                        enabled: true,
                        revision: 1,
                    },
                    None,
                )?;
            }
            Err(error) => return Err(error),
        }
        Ok(store)
    }
    fn write(
        &self,
        record: &BrowserConnection,
        observed: Option<&BrowserConnection>,
    ) -> BrowserResult<()> {
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT record_json FROM browser_connections WHERE id=?1",
                [&record.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        let previous = previous
            .map(|text| serde_json::from_str::<BrowserConnection>(&text).map_err(storage))
            .transpose()?;
        if let Some(previous) = previous.as_ref() {
            if previous.provider_id != record.provider_id
                || (!previous.scope_label.trim().is_empty()
                    && previous.scope_label.trim() != record.scope_label.trim())
                || (previous.scope_id.is_some() && previous.scope_id != record.scope_id)
            {
                return Err(BrowserError::new(
                    "scope_mismatch",
                    "当前账户与接入绑定不同，请创建新的接入",
                ));
            }
        }
        // Activation and invalidation can change flags without advancing the configuration revision.
        if previous.as_ref() != observed
            || observed.is_some_and(|previous| record.revision < previous.revision)
        {
            return Err(conflict());
        }
        let text = serde_json::to_string(record).map_err(storage)?;
        let changed = if let Some(observed) = observed {
            tx.execute(
                "UPDATE browser_connections SET enabled=?2,record_json=?3
                 WHERE id=?1 AND json_extract(record_json,'$.revision')=?4",
                params![record.id, record.enabled, text, observed.revision],
            )
        } else {
            tx.execute(
                "INSERT INTO browser_connections(id,provider,enabled,record_json) VALUES(?1,?2,?3,?4)",
                params![
                    record.id,
                    serde_json::to_string(&record.provider_id).map_err(storage)?,
                    record.enabled,
                    text
                ],
            )
        }
        .map_err(storage)?;
        if changed != 1 {
            return Err(conflict());
        }
        tx.commit().map_err(storage)
    }
    pub fn get(&self, id: &str) -> BrowserResult<BrowserConnection> {
        let text: Option<String> = open_database(&self.path)
            .map_err(storage)?
            .query_row(
                "SELECT record_json FROM browser_connections WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        let record: BrowserConnection = serde_json::from_str(
            &text.ok_or_else(|| BrowserError::new("connection_missing", "浏览器接入不存在"))?,
        )
        .map_err(storage)?;
        if record.id != id {
            return Err(storage("connection identity mismatch"));
        }
        Ok(record)
    }
    pub fn list(&self) -> BrowserResult<Vec<BrowserConnection>> {
        let db = open_database(&self.path).map_err(storage)?;
        let mut query = db
            .prepare("SELECT record_json FROM browser_connections ORDER BY rowid")
            .map_err(storage)?;
        let collected = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(storage)?
            .map(|row| serde_json::from_str(&row.map_err(storage)?).map_err(storage))
            .collect();
        collected
    }
    pub fn save(&self, input: ConnectionInput) -> BrowserResult<BrowserConnection> {
        if input.provider_id == BrowserProviderId::CloakBrowser {
            return Err(BrowserError::new("invalid_config", "内置接入由应用管理"));
        }
        if input.name.trim().is_empty()
            || input.name.chars().count() > 80
            || input.scope_label.chars().count() > 120
        {
            return Err(BrowserError::new(
                "invalid_config",
                "请填写有效的接入名称和账户说明",
            ));
        }
        let raw_endpoint = input.endpoint.trim();
        if raw_endpoint.len() > 2048
            || raw_endpoint
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\')
        {
            return Err(BrowserError::new("invalid_config", "本机 API 地址无效"));
        }
        let endpoint = url::Url::parse(raw_endpoint)
            .map_err(|_| BrowserError::new("invalid_config", "本机 API 地址无效"))?;
        let loopback = match endpoint.host() {
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => {
                ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
            }
            None => false,
        };
        if !matches!(endpoint.scheme(), "http" | "https")
            || !loopback
            || endpoint
                .port_or_known_default()
                .is_none_or(|port| port == 0)
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !matches!(endpoint.path(), "" | "/")
            || raw_endpoint
                .split_once("://")
                .is_some_and(|(_, authority)| {
                    authority.split('/').next().unwrap_or("").contains('@')
                })
        {
            return Err(BrowserError::new(
                "invalid_config",
                "请填写本机 API 的根地址",
            ));
        }
        let previous = input.id.as_deref().map(|id| self.get(id)).transpose()?;
        if previous
            .as_ref()
            .is_some_and(|p| p.provider_id != input.provider_id)
        {
            return Err(BrowserError::new(
                "scope_mismatch",
                "不能更换已有接入的浏览器类型",
            ));
        }
        let enabled = previous.as_ref().map_or(
            !self
                .list()?
                .iter()
                .any(|c| c.provider_id == input.provider_id && c.enabled),
            |p| p.enabled,
        );
        let revision = if let Some(previous) = previous.as_ref() {
            previous
                .revision
                .checked_add(1)
                .filter(|revision| i64::try_from(*revision).is_ok())
                .ok_or_else(|| storage("connection revision exhausted"))?
        } else {
            1
        };
        let record = BrowserConnection {
            id: previous
                .as_ref()
                .map_or_else(|| uuid::Uuid::new_v4().to_string(), |p| p.id.clone()),
            provider_id: input.provider_id,
            name: input.name.trim().into(),
            endpoint: endpoint.to_string().trim_end_matches('/').into(),
            api_key: input
                .api_key
                .filter(|key| !key.trim().is_empty())
                .map(|key| key.trim().into()),
            default_group_id: input.default_group_id.filter(|id| !id.is_empty()),
            scope_label: input.scope_label.trim().into(),
            scope_id: previous.as_ref().and_then(|p| p.scope_id.clone()),
            scope_confirmed: false,
            enabled,
            revision,
        };
        self.write(&record, previous.as_ref())?;
        Ok(record)
    }
    pub fn confirm(
        &self,
        id: &str,
        label: &str,
        scope: Option<String>,
        observed_revision: u64,
    ) -> BrowserResult<BrowserConnection> {
        let observed = self.get(id)?;
        if observed.revision != observed_revision {
            return Err(conflict());
        }
        let mut record = observed.clone();
        if label.trim().is_empty() || label.trim().chars().count() > 120 {
            return Err(BrowserError::new(
                "invalid_config",
                "请确认当前浏览器账户或工作区名称",
            ));
        }
        if record
            .scope_id
            .as_ref()
            .zip(scope.as_ref())
            .is_some_and(|(a, b)| a != b)
        {
            return Err(BrowserError::new(
                "scope_mismatch",
                "当前账户与接入绑定不同，请创建新的接入",
            ));
        }
        record.scope_label = label.trim().into();
        record.scope_id = scope.or(record.scope_id);
        record.scope_confirmed = true;
        self.write(&record, Some(&observed))?;
        Ok(record)
    }
    pub fn unconfirm(&self, id: &str, observed_revision: u64) -> BrowserResult<()> {
        open_database(&self.path)
            .map_err(storage)?
            .execute(
                "UPDATE browser_connections
                 SET record_json=json_set(record_json,'$.scopeConfirmed',json('false'))
                 WHERE id=?1 AND json_extract(record_json,'$.revision')=?2 AND provider<>?3",
                params![
                    id,
                    observed_revision,
                    serde_json::to_string(&BrowserProviderId::CloakBrowser).map_err(storage)?
                ],
            )
            .map_err(storage)?;
        Ok(())
    }
    pub fn reset_confirmations(&self) -> BrowserResult<()> {
        for connection in self.list()? {
            self.unconfirm(&connection.id, connection.revision)?;
        }
        Ok(())
    }
    pub fn activate(&self, id: &str) -> BrowserResult<BrowserConnection> {
        let record = self.get(id)?;
        let mut db = open_database(&self.path).map_err(storage)?;
        let tx = db.transaction().map_err(storage)?;
        let kind = serde_json::to_string(&record.provider_id).map_err(storage)?;
        tx.execute("UPDATE browser_connections SET enabled=0,record_json=json_set(record_json,'$.enabled',json('false')) WHERE provider=?1",[kind]).map_err(storage)?;
        tx.execute("UPDATE browser_connections SET enabled=1,record_json=json_set(record_json,'$.enabled',json('true')) WHERE id=?1",[id]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        self.get(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(label: &str) -> ConnectionInput {
        ConnectionInput {
            id: None,
            provider_id: BrowserProviderId::AdsPower,
            name: "Local browser".into(),
            endpoint: "http://127.0.0.1:50325".into(),
            api_key: None,
            default_group_id: None,
            scope_label: label.into(),
        }
    }

    #[test]
    fn initialization_propagates_corrupt_database_and_storage_errors() {
        let root = tempfile::tempdir().unwrap();
        let corrupt = root.path().join("corrupt.sqlite");
        std::fs::write(&corrupt, b"this is not a SQLite database").unwrap();
        assert_eq!(
            ConnectionStore::new(corrupt).err().unwrap().code,
            "storage_failed"
        );

        let directory = root.path().join("directory.sqlite");
        std::fs::create_dir(&directory).unwrap();
        assert_eq!(
            ConnectionStore::new(directory).err().unwrap().code,
            "storage_failed"
        );
    }

    #[test]
    fn initialization_rejects_corrupt_builtin_record_without_replacing_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        ConnectionStore::new(path.clone()).unwrap();
        let db = open_database(&path).unwrap();
        db.execute(
            "UPDATE browser_connections SET record_json='{' WHERE id=?1",
            [BUILTIN_CONNECTION_ID],
        )
        .unwrap();
        assert_eq!(
            ConnectionStore::new(path).err().unwrap().code,
            "storage_failed"
        );
        assert_eq!(
            db.query_row(
                "SELECT record_json FROM browser_connections WHERE id=?1",
                [BUILTIN_CONNECTION_ID],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
            "{"
        );
    }

    #[test]
    fn known_scope_label_cannot_be_changed_or_cleared_by_save_or_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let store = ConnectionStore::new(path.clone()).unwrap();
        let saved = store.save(input("Account A")).unwrap();
        for label in ["Account B", ""] {
            let mut changed = input(label);
            changed.id = Some(saved.id.clone());
            assert_eq!(store.save(changed).unwrap_err().code, "scope_mismatch");
        }
        let confirmed = store
            .confirm(&saved.id, "Account A", None, saved.revision)
            .unwrap();
        store.unconfirm(&saved.id, confirmed.revision).unwrap();
        assert_eq!(
            store
                .confirm(&saved.id, "Account B", None, saved.revision)
                .unwrap_err()
                .code,
            "scope_mismatch"
        );
        let reopened = ConnectionStore::new(path).unwrap();
        let unchanged = reopened.get(&saved.id).unwrap();
        assert_eq!(unchanged.scope_label, confirmed.scope_label);
        assert_eq!(unchanged.scope_id, confirmed.scope_id);
        assert!(!unchanged.scope_confirmed);

        let other_account = reopened.save(input("Account B")).unwrap();
        assert_ne!(other_account.id, saved.id);
        assert!(!other_account.enabled);
    }

    #[test]
    fn first_confirmation_can_set_an_empty_label_and_preserves_known_scope_evidence() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let store = ConnectionStore::new(path.clone()).unwrap();
        let saved = store.save(input("")).unwrap();
        let confirmed = store
            .confirm(
                &saved.id,
                "  Account A  ",
                Some("owner-a".into()),
                saved.revision,
            )
            .unwrap();
        assert_eq!(confirmed.scope_label, "Account A");
        assert!(confirmed.scope_confirmed);

        let mut changed = input(" Account A ");
        changed.id = Some(saved.id.clone());
        changed.endpoint = "http://localhost:50326".into();
        let updated = store.save(changed).unwrap();
        assert_eq!(updated.scope_id.as_deref(), Some("owner-a"));
        assert!(!updated.scope_confirmed);
        let confirmed = store
            .confirm(&saved.id, "Account A", None, saved.revision)
            .unwrap();
        assert_eq!(confirmed.scope_id.as_deref(), Some("owner-a"));
        assert_eq!(
            store
                .confirm(
                    &saved.id,
                    "Account A",
                    Some("owner-b".into()),
                    saved.revision
                )
                .unwrap_err()
                .code,
            "scope_mismatch"
        );
        let mut stale = confirmed.clone();
        stale.scope_id = None;
        stale.scope_confirmed = true;
        assert_eq!(
            store.write(&stale, Some(&confirmed)).unwrap_err().code,
            "scope_mismatch"
        );
        assert_eq!(
            serde_json::to_value(ConnectionStore::new(path).unwrap().get(&stale.id).unwrap())
                .unwrap(),
            serde_json::to_value(confirmed).unwrap()
        );
    }

    #[test]
    fn concurrent_first_confirmations_cannot_relabel_the_winning_scope() {
        use std::sync::{Arc, Barrier};

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let store = ConnectionStore::new(path.clone()).unwrap();
        let saved = store.save(input("")).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["Account A", "Account B"]
            .into_iter()
            .map(|label| {
                let path = path.clone();
                let id = saved.id.clone();
                let revision = saved.revision;
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let store = ConnectionStore::new(path).unwrap();
                    barrier.wait();
                    store.confirm(&id, label, None, revision)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .find_map(|result| result.as_ref().err())
                .unwrap()
                .code,
            "scope_mismatch"
        );
        let winner = results.into_iter().find_map(Result::ok).unwrap();
        assert_eq!(
            serde_json::to_value(store.get(&saved.id).unwrap()).unwrap(),
            serde_json::to_value(winner).unwrap()
        );
    }

    #[test]
    fn stale_invalidation_preserves_newer_connection_configuration_and_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let store = ConnectionStore::new(path.clone()).unwrap();
        let mut original = input("Account A");
        original.api_key = Some("fixture-old-key".into());
        let saved = store.save(original).unwrap();
        let observed = store
            .confirm(&saved.id, "Account A", None, saved.revision)
            .unwrap();
        let other = store.save(input("Account B")).unwrap();
        store.activate(&other.id).unwrap();

        let mut changed = input("Account A");
        changed.id = Some(observed.id.clone());
        changed.name = "Updated browser".into();
        changed.endpoint = "http://localhost:50326".into();
        changed.api_key = Some("fixture-new-key".into());
        changed.default_group_id = Some("updated-vendor-group".into());
        let updated = store.save(changed).unwrap();
        let latest = store
            .confirm(&updated.id, "Account A", None, updated.revision)
            .unwrap();
        assert_eq!(latest.revision, observed.revision + 1);
        assert_ne!(latest.name, observed.name);
        assert_ne!(latest.endpoint, observed.endpoint);
        assert_ne!(latest.api_key, observed.api_key);
        assert_ne!(latest.enabled, observed.enabled);
        assert!(latest.scope_confirmed);

        store.unconfirm(&observed.id, observed.revision).unwrap();
        assert_eq!(store.get(&latest.id).unwrap(), latest);
        assert!(store.get(&other.id).unwrap().enabled);

        store.unconfirm(&latest.id, latest.revision).unwrap();
        let mut invalidated = latest;
        invalidated.scope_confirmed = false;
        assert_eq!(
            ConnectionStore::new(path)
                .unwrap()
                .get(&invalidated.id)
                .unwrap(),
            invalidated
        );
    }

    #[test]
    fn full_record_writes_reject_stale_save_and_confirmation_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(root.path().join("nexus.sqlite")).unwrap();
        let observed = store.save(input("Account A")).unwrap();
        let mut delayed_save = observed.clone();
        delayed_save.name = "Delayed save".into();
        delayed_save.revision += 1;
        let mut delayed_confirmation = observed.clone();
        delayed_confirmation.scope_confirmed = true;
        let mut changed = input("Account A");
        changed.id = Some(observed.id.clone());
        changed.endpoint = "http://localhost:50326".into();
        changed.api_key = Some("fixture-new-key".into());
        let latest = store.save(changed).unwrap();

        for candidate in [&delayed_save, &delayed_confirmation] {
            assert_eq!(
                store.write(candidate, Some(&observed)).unwrap_err().code,
                "connection_conflict"
            );
        }
        assert_eq!(
            store.write(&observed, Some(&latest)).unwrap_err().code,
            "connection_conflict"
        );
        assert_eq!(store.get(&latest.id).unwrap(), latest);
    }

    #[test]
    fn full_record_writes_cannot_restore_stale_enabled_state_at_the_same_revision() {
        let root = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(root.path().join("nexus.sqlite")).unwrap();
        let observed = store.save(input("Account A")).unwrap();
        let other = store.save(input("Account B")).unwrap();
        let mut delayed_save = observed.clone();
        delayed_save.name = "Delayed save".into();
        delayed_save.revision += 1;
        let mut delayed_confirmation = observed.clone();
        delayed_confirmation.scope_confirmed = true;
        store.activate(&other.id).unwrap();
        let latest = store.get(&observed.id).unwrap();
        assert!(!latest.enabled);
        assert_eq!(latest.revision, observed.revision);

        for candidate in [&delayed_save, &delayed_confirmation] {
            assert_eq!(
                store.write(candidate, Some(&observed)).unwrap_err().code,
                "connection_conflict"
            );
        }
        assert_eq!(store.get(&latest.id).unwrap(), latest);
        assert!(store.get(&other.id).unwrap().enabled);
    }

    #[test]
    fn confirmation_cannot_approve_a_configuration_revision_that_was_never_probed() {
        let root = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(root.path().join("nexus.sqlite")).unwrap();
        let probed = store.save(input("Account A")).unwrap();
        let mut changed = input("Account A");
        changed.id = Some(probed.id.clone());
        changed.endpoint = "http://localhost:50326".into();
        changed.api_key = Some("fixture-new-key".into());
        let latest = store.save(changed).unwrap();
        assert_eq!(
            store
                .confirm(&latest.id, "Account A", None, probed.revision)
                .unwrap_err()
                .code,
            "connection_conflict"
        );
        assert!(!store.get(&latest.id).unwrap().scope_confirmed);
        assert!(
            store
                .confirm(&latest.id, "Account A", None, latest.revision)
                .unwrap()
                .scope_confirmed
        );
    }

    #[test]
    fn confirmation_reset_preserves_configuration_and_builtin_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(root.path().join("nexus.sqlite")).unwrap();
        let saved = store.save(input("Account A")).unwrap();
        let mut expected = store
            .confirm(&saved.id, "Account A", None, saved.revision)
            .unwrap();
        let builtin = store.get(BUILTIN_CONNECTION_ID).unwrap();
        store
            .unconfirm(BUILTIN_CONNECTION_ID, builtin.revision)
            .unwrap();
        assert_eq!(store.get(BUILTIN_CONNECTION_ID).unwrap(), builtin);
        store.reset_confirmations().unwrap();
        expected.scope_confirmed = false;
        assert_eq!(store.get(&expected.id).unwrap(), expected);
        assert_eq!(store.get(BUILTIN_CONNECTION_ID).unwrap(), builtin);
    }

    #[test]
    fn save_accepts_only_loopback_ip_addresses_or_localhost() {
        let root = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(root.path().join("nexus.sqlite")).unwrap();
        for endpoint in [
            "http://127.0.0.1:50325",
            "http://127.0.0.2:50325",
            "http://[::1]:50325",
            "http://[::ffff:127.0.0.1]:50325",
            "https://localhost:50325",
        ] {
            let mut value = input("");
            value.endpoint = endpoint.into();
            assert!(store.save(value).is_ok(), "{endpoint}");
        }
        let saved_count = store.list().unwrap().len();
        for endpoint in [
            "http://192.0.2.1:50325",
            "http://0.0.0.0:50325",
            "http://[::]:50325",
            "http://[::ffff:192.0.2.1]:50325",
            "http://browser.example:50325",
            "http://localhost.example:50325",
            "http://localhost:0",
            "http://user:password@localhost:50325",
            "http://@localhost:50325",
            "http://localhost:50325/base",
            "http://localhost:50325?key=fixture",
            "http://localhost:50325/#fragment",
            "http://local\thost:50325",
            "http://localhost:50325\\",
        ] {
            let mut value = input("");
            value.endpoint = endpoint.into();
            assert_eq!(
                store.save(value).unwrap_err().code,
                "invalid_config",
                "{endpoint}"
            );
        }
        assert_eq!(store.list().unwrap().len(), saved_count);
    }

    #[test]
    fn confirmation_requires_a_bounded_nonempty_label() {
        let root = tempfile::tempdir().unwrap();
        let store = ConnectionStore::new(root.path().join("nexus.sqlite")).unwrap();
        let saved = store.save(input("")).unwrap();
        for label in [" ".into(), "a".repeat(121)] {
            assert_eq!(
                store
                    .confirm(&saved.id, &label, None, saved.revision)
                    .unwrap_err()
                    .code,
                "invalid_config"
            );
        }
        assert_eq!(
            serde_json::to_value(store.get(&saved.id).unwrap()).unwrap(),
            json!(saved)
        );
    }
}
