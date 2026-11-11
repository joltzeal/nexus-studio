use super::{
    browser::{connection_store::ConnectionStore, operation_store::OperationStore, provider::*},
    database::open_database,
    group_store::GroupStore,
    scheduler::{LaunchRequest, ProxyBinding, Scheduler, SchedulerError},
    window_store::{StoreError, WindowRecord, WindowSettings, WindowStore},
};
use serde_json::json;

fn record(root: &std::path::Path) -> WindowRecord {
    let id = uuid::Uuid::new_v4().to_string();
    WindowRecord {
        schema_version: 2,
        id: id.clone(),
        name: "Store".into(),
        binding: BrowserBinding {
            provider_id: BrowserProviderId::CloakBrowser,
            connection_id: BUILTIN_CONNECTION_ID.into(),
            profile_id: id,
        },
        binary_path: Some(root.join("chromium-155.0.8059.39.5-pro/browser")),
        kernel_version: Some("155.0.8059.39.5".into()),
        proxy: None,
        proxy_plugin: None,
        proxy_endpoint: None,
        proxy_mode: ProxyMode::Direct,
        settings: WindowSettings {
            fingerprint_seed: Some(12345),
            ..Default::default()
        },
        origin: WindowOrigin::Created,
        provider_config: json!({}),
        created_at: 1234,
        last_opened_at: None,
        sort_order: 1,
    }
}

fn external_record(root: &std::path::Path) -> WindowRecord {
    let mut external = record(root);
    external.binding = BrowserBinding {
        provider_id: BrowserProviderId::AdsPower,
        connection_id: "external-connection".into(),
        profile_id: "vendor-profile".into(),
    };
    external.binary_path = None;
    external.kernel_version = Some("132".into());
    external.settings.fingerprint_seed = None;
    external.proxy_mode = ProxyMode::Provider;
    external.origin = WindowOrigin::Attached;
    external.provider_config = json!({
        "identity": {"profileId": "vendor-profile", "createdAt": 1000, "ownerId": "fixture-owner"},
        "raw": {"name": "Store"}
    });
    external
}

fn observed_external_profile() -> RemoteProfile {
    RemoteProfile {
        id: "vendor-profile".into(),
        name: "Official rename".into(),
        kernel_version: Some("133".into()),
        created_at: Some(9000),
        provider_config: json!({
            "identity": {
                "profileId": "vendor-profile", "createdAt": 1000,
                "ownerId": "fixture-owner", "teamId": "fixture-team"
            },
            "raw": {"name": "Official rename", "kernel": "133", "note": "Provider note"}
        }),
    }
}

fn legacy_record(root: &std::path::Path) -> serde_json::Value {
    let mut value = serde_json::to_value(record(root)).unwrap();
    value["schema_version"] = json!(1);
    value["binding"] = json!({
        "profile_id": value["id"],
        "channel_id": "cloak:155.0.8059.39",
        "channel_version": "155.0.8059.39"
    });
    let fields = value.as_object_mut().unwrap();
    for field in [
        "kernel_version",
        "proxy_mode",
        "origin",
        "provider_config",
        "sort_order",
    ] {
        fields.remove(field);
    }
    value
}

fn legacy_database(path: &std::path::Path, rows: &[serde_json::Value]) {
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch(
        "CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL);
         CREATE TABLE profile_records(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,group_id TEXT REFERENCES groups(id));",
    )
    .unwrap();
    for row in rows {
        db.execute(
            "INSERT INTO profile_records(id,record_json) VALUES(?1,?2)",
            rusqlite::params![row["id"].as_str().unwrap(), row.to_string()],
        )
        .unwrap();
    }
}

#[test]
fn database_upgrade_preserves_identity_and_records_the_full_pinned_package() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let id = uuid::Uuid::new_v4().to_string();
    let group = uuid::Uuid::new_v4().to_string();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL);
        CREATE TABLE profile_records(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,group_id TEXT REFERENCES groups(id));
        CREATE INDEX idx_profile_group ON profile_records(group_id);").unwrap();
    db.execute("INSERT INTO groups VALUES(?1,'Group','')", [&group])
        .unwrap();
    let original = json!({"schema_version":1,"id":id,"name":"Old",
        "binding":{"profile_id":id,"channel_id":"cloak:155.0.8059.39","channel_version":"155.0.8059.39"},
        "binary_path":root.path().join("chromium-155.0.8059.39.5-pro/browser"),"proxy":null,
        "proxy_plugin":null,"proxy_endpoint":null,"settings":{"platform":"Vinted","note":"keep",
        "geoip":true,"timezone":"","locale":"","viewport":"default","fingerprintSeed":321,"startUrl":""},
        "created_at":20,"last_opened_at":30});
    db.execute(
        "INSERT INTO profile_records VALUES(?1,?2,?3)",
        rusqlite::params![id, original.to_string(), group],
    )
    .unwrap();
    drop(db);
    open_database(&path).unwrap();
    ConnectionStore::new(path.clone()).unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let saved = store.get(&id).unwrap();
    assert_eq!(saved.binding.profile_id, id);
    assert_eq!(saved.binding.connection_id, BUILTIN_CONNECTION_ID);
    assert_eq!(saved.kernel_version.as_deref(), Some("155.0.8059.39.5"));
    assert_eq!(saved.settings.fingerprint_seed, Some(321));
    assert_eq!(saved.settings.note, "keep");
    assert_eq!(saved.created_at, 20);
    assert_eq!(saved.last_opened_at, Some(30));
    assert_eq!(
        store.group_id(&id).unwrap().as_deref(),
        Some(group.as_str())
    );
    assert_eq!(
        GroupStore::new(path.clone()).unwrap().list().unwrap()[0].window_count,
        1
    );
    assert_eq!(
        std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("before-browser-v2"))
            .count(),
        1
    );
    open_database(&path).unwrap();
    assert_eq!(store.get(&id).unwrap(), saved);
    assert_eq!(store.reserve_sort_order().unwrap(), saved.sort_order + 1);
}

#[test]
fn database_upgrade_rolls_back_every_row_and_keeps_backup_on_invalid_new_records() {
    for field in [
        "unknown_field",
        "missing_settings",
        "invalid_settings",
        "missing_seed",
        "invalid_binary",
        "invalid_name",
        "invalid_proxy",
        "negative_created_at",
        "negative_last_opened_at",
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let valid = legacy_record(root.path());
        let mut invalid = legacy_record(root.path());
        match field {
            "unknown_field" => invalid["unexpected"] = json!(true),
            "missing_settings" => {
                invalid.as_object_mut().unwrap().remove("settings");
            }
            "invalid_settings" => invalid["settings"]["viewport"] = json!("invalid"),
            "missing_seed" => invalid["settings"]["fingerprintSeed"] = json!(null),
            "invalid_binary" => invalid["binary_path"] = json!("relative/browser"),
            "invalid_name" => invalid["name"] = json!(""),
            "invalid_proxy" => invalid["proxy"] = json!("not a proxy URL"),
            "negative_created_at" => invalid["created_at"] = json!(-1),
            "negative_last_opened_at" => invalid["last_opened_at"] = json!(-1),
            _ => unreachable!(),
        }
        let rows = [valid, invalid];
        legacy_database(&path, &rows);

        assert!(open_database(&path).is_err(), "{field}");
        let db = rusqlite::Connection::open(&path).unwrap();
        for row in &rows {
            let text: String = db
                .query_row(
                    "SELECT record_json FROM profile_records WHERE id=?1",
                    [row["id"].as_str().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(text, row.to_string(), "{field}");
        }
        assert_eq!(
            db.query_row(
                "SELECT COALESCE(MAX(version),0) FROM browser_schema",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "{field}"
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN('browser_connections','browser_operations','browser_sequences')",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "{field}"
        );
        let backups: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("before-browser-v2")
            })
            .collect();
        assert_eq!(backups.len(), 1, "{field}");
        let backup = rusqlite::Connection::open(backups[0].path()).unwrap();
        for row in &rows {
            let text: String = backup
                .query_row(
                    "SELECT record_json FROM profile_records WHERE id=?1",
                    [row["id"].as_str().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(text, row.to_string(), "{field}");
        }
    }
}

#[cfg(unix)]
#[test]
fn database_upgrade_validates_profile_symlinks_under_the_database_parent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let row = legacy_record(root.path());
    let profiles = root.path().join("profiles");
    let target = root.path().join("outside");
    std::fs::create_dir_all(&profiles).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::os::unix::fs::symlink(&target, profiles.join(row["id"].as_str().unwrap())).unwrap();
    legacy_database(&path, std::slice::from_ref(&row));

    assert!(open_database(&path).is_err());
    std::fs::remove_file(profiles.join(row["id"].as_str().unwrap())).unwrap();
    open_database(&path).unwrap();
    assert!(
        WindowStore::new(profiles)
            .get(row["id"].as_str().unwrap())
            .is_ok()
    );
}

#[test]
fn sort_reservations_are_durable_even_before_a_window_or_operation_is_saved() {
    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    let store = WindowStore::new(profiles.clone());
    assert_eq!(store.reserve_sort_order().unwrap(), 1);
    assert_eq!(store.reserve_sort_order().unwrap(), 2);
    drop(store);

    let reopened = WindowStore::new(profiles);
    assert_eq!(reopened.reserve_sort_order().unwrap(), 3);
}

#[test]
fn sort_reservations_exceed_pending_drafts_and_high_imports_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    let path = root.path().join("nexus.sqlite");
    let store = WindowStore::new(profiles.clone());
    let mut saved = record(root.path());
    saved.sort_order = 40;
    store.insert(&saved, None).unwrap();
    let operations = OperationStore::new(path.clone());
    let mut draft = record(root.path());
    draft.sort_order = 800;
    operations
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            &draft.id,
            &draft.binding.connection_id,
            "create",
            json!({"record": draft}),
        )
        .unwrap();
    assert_eq!(store.reserve_sort_order().unwrap(), 801);
    assert!(store.get(&draft.id).is_err());
    drop(store);

    let reopened = WindowStore::new(profiles.clone());
    assert_eq!(reopened.reserve_sort_order().unwrap(), 802);
    let mut imported = record(root.path());
    imported.sort_order = 5_000;
    open_database(&path)
        .unwrap()
        .execute(
            "INSERT INTO profile_records(id,record_json) VALUES(?1,?2)",
            rusqlite::params![imported.id, serde_json::to_string(&imported).unwrap()],
        )
        .unwrap();
    assert_eq!(reopened.reserve_sort_order().unwrap(), 5_001);
    let mut removed_import = record(root.path());
    removed_import.sort_order = 9_000;
    reopened.insert(&removed_import, None).unwrap();
    reopened.delete(&removed_import.id).unwrap();
    drop(reopened);

    assert_eq!(
        WindowStore::new(profiles).reserve_sort_order().unwrap(),
        9_001
    );
}

#[test]
fn schema_two_rejects_missing_or_corrupt_sort_sequence_without_reconstructing_it() {
    for corruption in ["missing_table", "missing_value", "negative_value"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let store = WindowStore::new(root.path().join("profiles"));
        let saved = record(root.path());
        store.insert(&saved, None).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        match corruption {
            "missing_table" => db.execute_batch("DROP TABLE browser_sequences").unwrap(),
            "missing_value" => db.execute_batch("DELETE FROM browser_sequences").unwrap(),
            "negative_value" => db
                .execute_batch("UPDATE browser_sequences SET value=-1")
                .unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(
            open_database(&path).err().unwrap(),
            "窗口排序数据缺失或损坏，数据库无法打开",
            "{corruption}"
        );
        assert_eq!(store.reserve_sort_order(), Err(StoreError::Io));
        let has_table: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_sequences')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_table, corruption != "missing_table");
        if has_table {
            let values: (i64, Option<i64>) = db
                .query_row(
                    "SELECT COUNT(*),MAX(value) FROM browser_sequences",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                values,
                if corruption == "missing_value" {
                    (0, None)
                } else {
                    (1, Some(-1))
                }
            );
        }
        let text: String = db
            .query_row(
                "SELECT record_json FROM profile_records WHERE id=?1",
                [&saved.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(text, serde_json::to_string(&saved).unwrap());
    }
}

#[test]
fn concurrent_sort_reservations_are_unique_and_overflow_is_an_error() {
    use std::sync::{Arc, Barrier};

    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    let store = WindowStore::new(profiles.clone());
    open_database(&root.path().join("nexus.sqlite")).unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let profiles = profiles.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                WindowStore::new(profiles).reserve_sort_order().unwrap()
            })
        })
        .collect();
    let mut orders: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    orders.sort_unstable();
    assert_eq!(orders, (1..=8).collect::<Vec<_>>());

    let mut imported = record(root.path());
    imported.sort_order = i64::MAX;
    store.insert(&imported, None).unwrap();
    assert_eq!(store.reserve_sort_order(), Err(StoreError::Io));
    assert_eq!(
        open_database(&root.path().join("nexus.sqlite"))
            .unwrap()
            .query_row(
                "SELECT value FROM browser_sequences WHERE name='window_sort_order'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
        i64::MAX
    );
}

#[test]
fn window_store_rejects_negative_times_and_sort_orders_and_accepts_zero() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let store = WindowStore::new(root.path().join("profiles"));
    let mut zero = record(root.path());
    zero.created_at = 0;
    zero.last_opened_at = Some(0);
    zero.sort_order = 0;
    store.insert(&zero, None).unwrap();
    assert_eq!(store.get(&zero.id).unwrap(), zero);
    assert_eq!(store.reserve_sort_order().unwrap(), 1);
    let db = open_database(&path).unwrap();
    for field in ["created_at", "last_opened_at", "sort_order"] {
        let mut invalid = zero.clone();
        match field {
            "created_at" => invalid.created_at = -1,
            "last_opened_at" => invalid.last_opened_at = Some(-1),
            "sort_order" => invalid.sort_order = -1,
            _ => unreachable!(),
        }
        assert_eq!(store.insert(&invalid, None), Err(StoreError::CorruptWindow));
        db.execute(
            "UPDATE profile_records SET record_json=?2 WHERE id=?1",
            rusqlite::params![invalid.id, serde_json::to_string(&invalid).unwrap()],
        )
        .unwrap();
        assert_eq!(store.get(&invalid.id), Err(StoreError::CorruptWindow));
    }
}

#[test]
fn window_store_rejects_old_schema_and_immutable_binding_changes() {
    let root = tempfile::tempdir().unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let original = record(root.path());
    store.insert(&original, None).unwrap();
    let mut changed = original.clone();
    changed.binding.connection_id = "another".into();
    assert_eq!(
        store.save(&changed, None),
        Err(StoreError::ImmutableBinding)
    );
    changed = original.clone();
    changed.settings.fingerprint_seed = Some(54321);
    assert_eq!(
        store.save(&changed, None),
        Err(StoreError::ImmutableBinding)
    );
    changed = original.clone();
    changed.kernel_version = Some("156.0.8100.1.1".into());
    assert_eq!(
        store.save(&changed, None),
        Err(StoreError::ImmutableBinding)
    );
    changed = original.clone();
    changed.binary_path = Some(root.path().join("another/browser"));
    assert_eq!(
        store.save(&changed, None),
        Err(StoreError::ImmutableBinding)
    );
    changed = original.clone();
    changed.schema_version = 1;
    assert_eq!(
        store.validate_record(&changed.id, &changed),
        Err(StoreError::CorruptWindow)
    );
    let reopened = WindowStore::new(root.path().join("profiles"));
    assert_eq!(reopened.get(&original.id).unwrap(), original);
}

#[test]
fn note_and_open_timestamp_patches_preserve_each_other_and_stable_order() {
    let root = tempfile::tempdir().unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let first = record(root.path());
    let mut second = record(root.path());
    second.sort_order = 2;
    store.insert(&first, None).unwrap();
    store.insert(&second, None).unwrap();
    store.update_note(&first.id, "  note  ").unwrap();
    store.mark_opened(&first.id).unwrap();
    assert_eq!(store.get(&first.id).unwrap().settings.note, "note");
    assert!(store.get(&first.id).unwrap().last_opened_at.is_some());
    assert_eq!(
        store
            .list()
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect::<Vec<_>>(),
        vec![second.id, first.id]
    );
}

#[test]
fn window_list_breaks_duplicate_timestamp_and_sort_order_ties_by_id() {
    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    let store = WindowStore::new(profiles.clone());
    let mut first = record(root.path());
    first.id = "00000000-0000-4000-8000-000000000001".into();
    first.binding.profile_id = first.id.clone();
    let mut second = record(root.path());
    second.id = "00000000-0000-4000-8000-000000000002".into();
    second.binding.profile_id = second.id.clone();
    assert_eq!(first.created_at, second.created_at);
    assert_eq!(first.sort_order, second.sort_order);
    store.insert(&first, None).unwrap();
    store.insert(&second, None).unwrap();
    drop(store);

    let reopened = WindowStore::new(profiles);
    assert_eq!(
        reopened
            .list()
            .unwrap()
            .into_iter()
            .map(|record| record.id)
            .collect::<Vec<_>>(),
        vec![second.id, first.id]
    );
}

#[test]
fn external_records_have_no_local_binary_or_numeric_seed_and_keep_business_groups() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let groups = GroupStore::new(path).unwrap();
    let group = groups.create("Group", "").unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let mut external = record(root.path());
    external.binding.provider_id = BrowserProviderId::AdsPower;
    external.binding.connection_id = "ads".into();
    external.binding.profile_id = "vendor-profile".into();
    external.binary_path = None;
    external.kernel_version = None;
    external.settings.fingerprint_seed = None;
    external.proxy_mode = ProxyMode::Provider;
    external.origin = WindowOrigin::Attached;
    store.insert(&external, Some(&group.id)).unwrap();
    assert_eq!(groups.list().unwrap()[0].window_count, 1);
    groups.delete(&group.id).unwrap();
    assert_eq!(store.group_id(&external.id).unwrap(), None);
    assert!(!store.root().join(&external.id).exists());
}

#[test]
fn external_metadata_refresh_persists_official_changes_and_preserves_current_local_fields() {
    for (provider, proxy_mode) in [
        (BrowserProviderId::AdsPower, ProxyMode::Manual),
        (BrowserProviderId::BitBrowser, ProxyMode::Plugin),
    ] {
        let root = tempfile::tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let groups = GroupStore::new(root.path().join("nexus.sqlite")).unwrap();
        let original_group = groups.create("Original group", "").unwrap();
        let current_group = groups.create("Current group", "").unwrap();
        let store = WindowStore::new(profiles.clone());
        let mut external = external_record(root.path());
        external.binding.provider_id = provider;
        external.proxy_mode = proxy_mode;
        match proxy_mode {
            ProxyMode::Manual => external.proxy = Some("socks5://127.0.0.1:1080".into()),
            ProxyMode::Plugin => {
                external.proxy_plugin = Some("studio.proxy-pool".into());
                external.proxy_endpoint = Some(42);
            }
            _ => unreachable!(),
        }
        external.settings.platform = "Vinted".into();
        external.settings.note = "Original local note".into();
        external.settings.geoip = false;
        external.settings.timezone = "Europe/Paris".into();
        external.settings.locale = "fr-FR".into();
        external.settings.viewport = "1440x900".into();
        external.settings.start_url = "https://example.com/".into();
        external.created_at = 2000;
        external.sort_order = 71;
        store.insert(&external, Some(&original_group.id)).unwrap();
        let mut remote = observed_external_profile();
        remote.name = "R".repeat(100);
        remote.provider_config["raw"]["name"] = json!(remote.name);

        store
            .update_note(&external.id, "Current local note")
            .unwrap();
        store.mark_opened(&external.id).unwrap();
        groups
            .assign(&external.id, Some(&current_group.id))
            .unwrap();
        let mut expected = store.get(&external.id).unwrap();
        assert!(expected.last_opened_at.is_some());
        expected.name = remote.name.clone();
        expected.kernel_version = Some("133".into());
        expected.provider_config = remote.provider_config.clone();

        assert_eq!(
            store
                .refresh_external_metadata(&external.id, &remote)
                .unwrap(),
            expected
        );
        assert_eq!(
            store
                .refresh_external_metadata(&external.id, &remote)
                .unwrap(),
            expected
        );
        drop(store);

        let reopened = WindowStore::new(profiles);
        assert_eq!(reopened.get(&external.id).unwrap(), expected);
        assert_eq!(reopened.list().unwrap(), vec![expected]);
        assert_eq!(
            reopened.group_id(&external.id).unwrap().as_deref(),
            Some(current_group.id.as_str())
        );
    }
}

#[test]
fn external_metadata_refresh_keeps_known_or_unknown_kernel_when_none_is_reported() {
    for kernel in [Some("132".to_string()), None] {
        let root = tempfile::tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let store = WindowStore::new(profiles.clone());
        let mut external = external_record(root.path());
        external.kernel_version = kernel.clone();
        store.insert(&external, None).unwrap();
        let mut remote = observed_external_profile();
        remote.kernel_version = None;
        let mut expected = external.clone();
        expected.name = remote.name.clone();
        expected.provider_config = remote.provider_config.clone();

        assert_eq!(
            store
                .refresh_external_metadata(&external.id, &remote)
                .unwrap(),
            expected
        );
        assert_eq!(
            WindowStore::new(profiles)
                .get(&external.id)
                .unwrap()
                .kernel_version,
            kernel
        );
    }
}

#[test]
fn external_metadata_refresh_rejects_changed_or_unverifiable_identity() {
    for mismatch in [
        "remote_profile_id",
        "remote_identity_profile_id",
        "saved_identity_profile_id",
        "changed_owner",
        "missing_evidence_key",
        "missing_saved_identity",
        "missing_remote_identity",
        "empty_identity",
        "profile_id_only",
    ] {
        let root = tempfile::tempdir().unwrap();
        let profiles = root.path().join("profiles");
        let store = WindowStore::new(profiles.clone());
        let mut external = external_record(root.path());
        let mut remote = observed_external_profile();
        match mismatch {
            "remote_profile_id" => remote.id = "another-profile".into(),
            "remote_identity_profile_id" => {
                remote.provider_config["identity"]["profileId"] = json!("another-profile");
            }
            "saved_identity_profile_id" => {
                external.provider_config["identity"]["profileId"] = json!("another-profile");
            }
            "changed_owner" => {
                remote.provider_config["identity"]["ownerId"] = json!("another-owner");
            }
            "missing_evidence_key" => {
                remote.provider_config["identity"]
                    .as_object_mut()
                    .unwrap()
                    .remove("createdAt");
            }
            "missing_saved_identity" => external.provider_config = json!({"raw": {}}),
            "missing_remote_identity" => remote.provider_config = json!({"raw": {}}),
            "empty_identity" => {
                external.provider_config["identity"] = json!({});
                remote.provider_config["identity"] = json!({});
            }
            "profile_id_only" => {
                external.provider_config["identity"] = json!({"profileId": "vendor-profile"});
                remote.provider_config["identity"] = json!({"profileId": "vendor-profile"});
            }
            _ => unreachable!(),
        }
        store.insert(&external, None).unwrap();

        assert_eq!(
            store.refresh_external_metadata(&external.id, &remote),
            Err(StoreError::ImmutableBinding),
            "{mismatch}"
        );
        assert_eq!(
            WindowStore::new(profiles).get(&external.id).unwrap(),
            external,
            "{mismatch}"
        );
    }
}

#[test]
fn invalid_external_metadata_leaves_saved_name_kernel_and_snapshot_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    let store = WindowStore::new(profiles.clone());
    let external = external_record(root.path());
    store.insert(&external, None).unwrap();
    for name in [
        String::new(),
        " ".into(),
        "R".repeat(101),
        "Invalid\nname".into(),
    ] {
        let mut remote = observed_external_profile();
        remote.name = name;
        assert_eq!(
            store.refresh_external_metadata(&external.id, &remote),
            Err(StoreError::InvalidName)
        );
        assert_eq!(
            WindowStore::new(profiles.clone())
                .get(&external.id)
                .unwrap(),
            external
        );
    }
}

#[test]
fn external_names_allow_one_hundred_characters_and_builtin_names_remain_bounded() {
    let root = tempfile::tempdir().unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let mut builtin = record(root.path());
    builtin.name = "B".repeat(40);
    store.insert(&builtin, None).unwrap();
    let mut too_long = builtin.clone();
    too_long.name.push('B');
    assert_eq!(store.save(&too_long, None), Err(StoreError::InvalidName));
    assert_eq!(store.get(&builtin.id).unwrap(), builtin);

    for provider in [BrowserProviderId::AdsPower, BrowserProviderId::BitBrowser] {
        let mut external = external_record(root.path());
        external.binding.provider_id = provider;
        external.binding.connection_id = format!("external-{provider:?}");
        external.name = "E".repeat(100);
        store.insert(&external, None).unwrap();
        assert_eq!(store.get(&external.id).unwrap(), external);
        store.save(&external, None).unwrap();
        external.name.push('E');
        assert_eq!(store.save(&external, None), Err(StoreError::InvalidName));
    }
}

#[test]
fn external_metadata_refresh_cannot_change_a_builtin_pinned_kernel() {
    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    let store = WindowStore::new(profiles.clone());
    let mut builtin = record(root.path());
    builtin.provider_config = json!({
        "identity": {"profileId": builtin.id, "createdAt": 1000, "ownerId": "fixture-owner"}
    });
    store.insert(&builtin, None).unwrap();
    let remote = RemoteProfile {
        id: builtin.id.clone(),
        name: "Official rename".into(),
        kernel_version: Some("156.0.8100.1.1".into()),
        created_at: Some(9000),
        provider_config: builtin.provider_config.clone(),
    };
    assert_eq!(
        store.refresh_external_metadata(&builtin.id, &remote),
        Err(StoreError::ImmutableBinding)
    );
    assert_eq!(
        WindowStore::new(profiles).get(&builtin.id).unwrap(),
        builtin
    );
}

#[test]
fn group_crud_persists_and_deletion_preserves_the_window() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let groups = GroupStore::new(path.clone()).unwrap();
    let group = groups.create("First", "Original").unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let window = record(root.path());
    store.insert(&window, None).unwrap();
    groups.assign(&window.id, Some(&group.id)).unwrap();
    groups.update(&group.id, "Renamed", "Updated").unwrap();
    let saved = GroupStore::new(path).unwrap().list().unwrap().remove(0);
    assert_eq!(
        (saved.name.as_str(), saved.note.as_str(), saved.window_count),
        ("Renamed", "Updated", 1)
    );
    groups.delete(&group.id).unwrap();
    assert_eq!(store.group_id(&window.id).unwrap(), None);
    assert_eq!(store.get(&window.id).unwrap(), window);
}

#[test]
fn invalid_group_assignment_preserves_existing_membership() {
    let root = tempfile::tempdir().unwrap();
    let groups = GroupStore::new(root.path().join("nexus.sqlite")).unwrap();
    let group = groups.create("Original", "").unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let window = record(root.path());
    store.insert(&window, Some(&group.id)).unwrap();
    assert!(
        groups
            .assign(&window.id, Some(&uuid::Uuid::new_v4().to_string()))
            .is_err()
    );
    assert_eq!(
        store.group_id(&window.id).unwrap().as_deref(),
        Some(group.id.as_str())
    );
}

#[test]
fn batch_group_assignment_is_atomic_and_persists_without_changing_browser_records() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let groups = GroupStore::new(path.clone()).unwrap();
    let first = groups.create("First", "").unwrap();
    let second = groups.create("Second", "").unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let a = record(root.path());
    let mut b = record(root.path());
    b.id = uuid::Uuid::new_v4().to_string();
    b.binding.profile_id = b.id.clone();
    store.insert(&a, Some(&first.id)).unwrap();
    store.insert(&b, None).unwrap();
    let ids = vec![a.id.clone(), b.id.clone()];
    groups.assign_many(&ids, Some(&second.id)).unwrap();
    let reopened = WindowStore::new(root.path().join("profiles"));
    for window in [&a, &b] {
        assert_eq!(
            reopened.group_id(&window.id).unwrap().as_deref(),
            Some(second.id.as_str())
        );
        assert_eq!(reopened.get(&window.id).unwrap(), *window);
    }
    let counts = GroupStore::new(path).unwrap().list().unwrap();
    assert_eq!(counts[0].window_count, 0);
    assert_eq!(counts[1].window_count, 2);
    groups.assign_many(&ids, None).unwrap();
    assert_eq!(reopened.group_id(&a.id).unwrap(), None);
    assert_eq!(reopened.group_id(&b.id).unwrap(), None);
}

#[test]
fn rejected_batch_group_assignments_leave_every_membership_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let groups = GroupStore::new(root.path().join("nexus.sqlite")).unwrap();
    let first = groups.create("First", "").unwrap();
    let second = groups.create("Second", "").unwrap();
    let store = WindowStore::new(root.path().join("profiles"));
    let window = record(root.path());
    store.insert(&window, Some(&first.id)).unwrap();
    for (ids, target) in [
        (vec![], Some(second.id.clone())),
        (
            vec![window.id.clone(), window.id.clone()],
            Some(second.id.clone()),
        ),
        (
            vec![window.id.clone(), uuid::Uuid::new_v4().to_string()],
            Some(second.id.clone()),
        ),
        (
            vec![window.id.clone(), "invalid".into()],
            Some(second.id.clone()),
        ),
        (
            vec![window.id.clone()],
            Some(uuid::Uuid::new_v4().to_string()),
        ),
        (vec![window.id.clone()], Some("invalid".into())),
    ] {
        assert!(groups.assign_many(&ids, target.as_deref()).is_err());
        assert_eq!(
            store.group_id(&window.id).unwrap().as_deref(),
            Some(first.id.as_str())
        );
    }
}

#[test]
fn deleted_groups_do_not_block_confirmed_create_or_update_commits() {
    for kind in ["create", "update"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nexus.sqlite");
        let groups = GroupStore::new(path.clone()).unwrap();
        let group = groups.create("Group", "").unwrap();
        let store = WindowStore::new(root.path().join("profiles"));
        let operations = OperationStore::new(path);
        let mut draft = record(root.path());
        draft.sort_order = store.reserve_sort_order().unwrap();
        if kind == "update" {
            store.insert(&draft, Some(&group.id)).unwrap();
            draft.name = "Updated window".into();
        }
        let original_payload = json!({"record": draft, "groupId": group.id});
        let mut operation = operations
            .prepare(
                &uuid::Uuid::new_v4().to_string(),
                &draft.id,
                &draft.binding.connection_id,
                kind,
                original_payload.clone(),
            )
            .unwrap();

        groups.delete(&group.id).unwrap();
        operations.phase(&mut operation, "confirmed", None).unwrap();
        if kind == "create" {
            store.insert(&draft, Some(&group.id)).unwrap();
        } else {
            store.save(&draft, Some(&group.id)).unwrap();
        }
        operations.phase(&mut operation, "committed", None).unwrap();

        assert_eq!(store.get(&draft.id).unwrap(), draft);
        assert_eq!(store.group_id(&draft.id).unwrap(), None);
        let committed = operations.get(&operation.id).unwrap().unwrap();
        assert_eq!(committed.phase, "committed");
        assert_eq!(committed.payload, original_payload);
    }
}

#[test]
fn operations_preserve_payload_and_never_reuse_an_id_with_different_input() {
    let root = tempfile::tempdir().unwrap();
    let store = OperationStore::new(root.path().join("nexus.sqlite"));
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({"secret":"plain-value","window":"one"});
    let mut operation = store
        .prepare(&id, "window", "connection", "create", payload.clone())
        .unwrap();
    store
        .phase(&mut operation, "uncertain", Some("network timeout".into()))
        .unwrap();
    let reopened = OperationStore::new(root.path().join("nexus.sqlite"));
    assert_eq!(reopened.get(&id).unwrap().unwrap().payload, payload);
    assert_eq!(
        reopened
            .prepare(&id, "window", "connection", "create", payload)
            .unwrap()
            .phase,
        "uncertain"
    );
    assert_eq!(
        reopened
            .prepare(&id, "window", "connection", "create", json!({}))
            .unwrap_err()
            .code,
        "operation_conflict"
    );
}

#[test]
fn operations_reject_rebinding_and_request_changes_without_losing_provider_results() {
    let root = tempfile::tempdir().unwrap();
    let store = OperationStore::new(root.path().join("nexus.sqlite"));
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({"input": {"name": "Window"}, "record": {"sort_order": 1}});
    let original = store
        .prepare(&id, "window", "connection", "create", payload.clone())
        .unwrap();
    assert_eq!(
        store
            .prepare(&id, "other-window", "connection", "create", payload.clone())
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    for field in [
        "window_id",
        "connection_id",
        "kind",
        "request_hash",
        "created_at",
        "payload",
    ] {
        let mut changed = original.clone();
        match field {
            "window_id" => changed.window_id = "other-window".into(),
            "connection_id" => changed.connection_id = "other-connection".into(),
            "kind" => changed.kind = "delete".into(),
            "request_hash" => changed.request_hash = "different".into(),
            "created_at" => changed.created_at += 1,
            "payload" => changed.payload["input"]["name"] = json!("Different request"),
            _ => unreachable!(),
        }
        assert_eq!(
            store.write(&changed).unwrap_err().code,
            "operation_conflict"
        );
    }
    assert_eq!(
        serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap(),
        serde_json::to_value(&original).unwrap()
    );

    let mut enriched = original;
    enriched.payload["record"]["providerProfileId"] = json!("remote-profile");
    store.phase(&mut enriched, "confirmed", None).unwrap();
    let repeated = store
        .prepare(&id, "window", "connection", "create", payload)
        .unwrap();
    assert_eq!(repeated.phase, "confirmed");
    assert_eq!(repeated.payload, enriched.payload);
}

#[test]
fn submitted_update_record_and_evidence_are_immutable() {
    let root = tempfile::tempdir().unwrap();
    let store = OperationStore::new(root.path().join("nexus.sqlite"));
    let mut operation = store
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            "window",
            "connection",
            "update",
            json!({"record":{"name":"Submitted"},"updateEvidence":{"field":"immutable"}}),
        )
        .unwrap();
    store.phase(&mut operation, "submitted", None).unwrap();
    for field in ["record", "updateEvidence"] {
        let mut changed = operation.clone();
        changed.payload[field] = json!({"different":"value"});
        assert_eq!(
            store.write(&changed).unwrap_err().code,
            "operation_conflict"
        );
    }
    store.phase(&mut operation, "confirmed", None).unwrap();
}

#[test]
fn explicit_operation_resolution_remains_durable_and_terminal() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let store = OperationStore::new(path.clone());
    let mut operation = store
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            "reserved-window",
            "connection",
            "create",
            json!({"input":{"name":"Original"},"record":{"name":"Original"}}),
        )
        .unwrap();
    store.phase(&mut operation, "submitted", None).unwrap();
    let hash = operation.request_hash.clone();
    store
        .resolve(
            &mut operation,
            super::browser::operation_store::OperationResolution {
                action: "abandon".into(),
                provider_profile_id: None,
                observed_state: None,
                confirmed_at: 1234,
            },
            "cancelled",
        )
        .unwrap();
    let reopened = OperationStore::new(path);
    let saved = reopened.get(&operation.id).unwrap().unwrap();
    assert_eq!(saved.window_id, "reserved-window");
    assert_eq!(saved.request_hash, hash);
    assert_eq!(saved.resolution.unwrap().confirmed_at, 1234);
    assert!(reopened.list(None).unwrap().is_empty());
    assert_eq!(
        reopened
            .phase(&mut operation, "submitted", None)
            .unwrap_err()
            .code,
        "operation_conflict"
    );
}

#[test]
fn concurrent_operation_prepares_cannot_overwrite_a_different_request() {
    use std::sync::{Arc, Barrier};

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    open_database(&path).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|name| {
            let path = path.clone();
            let id = id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                OperationStore::new(path).prepare(
                    &id,
                    name,
                    "connection",
                    "create",
                    json!({"input": name}),
                )
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
        "operation_conflict"
    );
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    let store = OperationStore::new(path.clone());
    assert_eq!(
        serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap(),
        serde_json::to_value(&winner).unwrap()
    );
    assert_eq!(store.list(None).unwrap().len(), 1);
    let db = open_database(&path).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT window_id FROM browser_operations WHERE id=?1",
            [&id],
            |r| r.get::<_, String>(0),
        )
        .unwrap(),
        winner.window_id
    );
}

#[test]
fn scheduler_locks_vendor_environment_per_connection_and_rejects_late_callbacks() {
    let mut scheduler = Scheduler::default();
    let binding = BrowserBinding {
        provider_id: BrowserProviderId::AdsPower,
        connection_id: "a".into(),
        profile_id: "same".into(),
    };
    let request = |window: &str, binding: BrowserBinding| LaunchRequest {
        window_id: window.into(),
        binding,
        proxy: ProxyBinding::Provider,
    };
    let first = scheduler.reserve(request("one", binding.clone())).unwrap();
    assert_eq!(
        scheduler
            .reserve(request("two", binding.clone()))
            .unwrap_err(),
        SchedulerError::ProfileBusy
    );
    let mut other = binding.clone();
    other.connection_id = "b".into();
    scheduler.reserve(request("two", other)).unwrap();
    scheduler.release(&first).unwrap();
    let next = scheduler.reserve(request("one", binding)).unwrap();
    assert_eq!(
        scheduler.confirm_running(&first),
        Err(SchedulerError::StaleAttempt)
    );
    scheduler.confirm_running(&next).unwrap();
}
