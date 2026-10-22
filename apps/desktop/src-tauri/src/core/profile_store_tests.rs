use super::profile_store::{PreparedBinary, ProfileStore, WindowSettings};
use std::fs;

#[test]
fn profile_binding_survives_a_new_store_instance() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let created = store
        .create(
            "Vinted 01",
            None,
            PreparedBinary {
                version: "146.0.7680.177.5".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    let reopened = ProfileStore::new(root.path().join("profiles"));
    let record = reopened.get(&created.id).unwrap();
    assert_eq!(record.name, "Vinted 01");
    assert_eq!(record.binding.channel_version, "146.0.7680.177.5");
    assert_eq!(record.binding.channel_id, "cloak:146.0.7680.177.5");
    assert_eq!(reopened.list().unwrap(), vec![record]);
}

#[test]
fn profile_fields_are_plain_text_in_sqlite_and_legacy_records_migrate() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let record = store
        .create(
            "Shop in database",
            None,
            PreparedBinary {
                version: "145.0.7632.109".into(),
                binary_path: binary.clone(),
            },
        )
        .unwrap();
    assert!(!store.record_path(&record.id).unwrap().exists());
    let database = fs::read(root.path().join("nexus.sqlite")).unwrap();
    assert!(
        database
            .windows(b"Shop in database".len())
            .any(|slice| slice == b"Shop in database")
    );

    let old = store
        .record_path("550e8400-e29b-41d4-a716-446655440000")
        .unwrap();
    fs::create_dir_all(old.parent().unwrap()).unwrap();
    let mut legacy = record.clone();
    legacy.id = "550e8400-e29b-41d4-a716-446655440000".into();
    legacy.binding.profile_id = legacy.id.clone();
    fs::write(&old, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let reopened = ProfileStore::new(root.path().join("profiles"));
    assert_eq!(reopened.list().unwrap().len(), 2);
    assert!(!old.exists());
    assert_eq!(reopened.get(&legacy.id).unwrap().binding, legacy.binding);
}

#[test]
fn missing_or_corrupt_binding_fails_closed_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let profiles = root.path().join("profiles");
    fs::create_dir_all(profiles.join("550e8400-e29b-41d4-a716-446655440000")).unwrap();
    let store = ProfileStore::new(profiles.clone());
    assert!(store.list().is_err());
    fs::write(
        profiles.join("550e8400-e29b-41d4-a716-446655440000/profile.json"),
        b"not json",
    )
    .unwrap();
    assert!(store.list().is_err());
}

#[test]
fn tampered_profile_binding_does_not_get_silently_rewritten() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let created = store
        .create(
            "Vinted",
            None,
            PreparedBinary {
                version: "146.0.7680.177.5".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    let db = rusqlite::Connection::open(root.path().join("nexus.sqlite")).unwrap();
    let json: String = db
        .query_row(
            "SELECT record_json FROM profile_records WHERE id = ?1",
            [&created.id],
            |row| row.get(0),
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value["binding"]["channel_version"] = "155.0.1".into();
    db.execute(
        "UPDATE profile_records SET record_json = ?2 WHERE id = ?1",
        rusqlite::params![created.id, value.to_string()],
    )
    .unwrap();
    assert!(store.get(&created.id).is_err());
}

#[test]
fn proxy_validation_requires_explicit_port_and_refuses_credentials() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let prepared = PreparedBinary {
        version: "146.0.7680.177.5".into(),
        binary_path: binary,
    };
    assert!(
        store
            .create("proxy", Some("http://host:80".into()), prepared.clone())
            .is_ok()
    );
    assert!(
        store
            .create("proxy", Some("http://host".into()), prepared.clone())
            .is_err()
    );
    assert!(
        store
            .create("proxy", Some("http://user:pass@host:8080".into()), prepared)
            .is_err()
    );
}

#[test]
fn window_settings_survive_edit_without_changing_the_browser_binding() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let initial_settings = WindowSettings {
        fingerprint_seed: Some(42),
        ..WindowSettings::default()
    };
    let created = store
        .create_with_settings(
            "First",
            None,
            None,
            initial_settings,
            PreparedBinary {
                version: "146.0.7680.177.5".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    let settings = WindowSettings {
        platform: "Vinted".into(),
        note: "Shop one".into(),
        geoip: true,
        timezone: "America/New_York".into(),
        locale: "en-US".into(),
        viewport: "1440x900".into(),
        fingerprint_seed: Some(42),
        start_url: "https://www.vinted.com".into(),
    };
    let updated = store
        .update(
            &created.id,
            "Second",
            Some("http://proxy.local:8080".into()),
            None,
            settings.clone(),
        )
        .unwrap();
    assert_eq!(updated.binding, created.binding);
    assert_eq!(updated.binary_path, created.binary_path);
    assert_eq!(updated.settings, settings);
    assert_eq!(store.get(&created.id).unwrap().name, "Second");
}

#[test]
fn deleting_a_window_removes_its_own_browser_data() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let created = store
        .create(
            "Delete me",
            None,
            PreparedBinary {
                version: "146.0.7680.177.5".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    let user_data = store.user_data_dir(&created.id).unwrap();
    fs::create_dir(&user_data).unwrap();
    fs::write(user_data.join("cookie"), b"browser data").unwrap();
    store.delete(&created.id).unwrap();
    assert!(!store.record_path(&created.id).unwrap().exists());
    assert!(!user_data.exists());
}

#[test]
fn existing_window_cannot_change_its_fingerprint_seed() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("chrome");
    fs::write(&binary, b"binary").unwrap();
    let store = ProfileStore::new(root.path().join("profiles"));
    let created = store
        .create_with_settings(
            "Identity",
            None,
            None,
            WindowSettings {
                fingerprint_seed: Some(17),
                ..WindowSettings::default()
            },
            PreparedBinary {
                version: "146.0.7680.177.5".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    let result = store.update(
        &created.id,
        "Identity",
        None,
        None,
        WindowSettings {
            fingerprint_seed: Some(18),
            ..WindowSettings::default()
        },
    );
    assert!(result.is_err());
    assert_eq!(
        store.get(&created.id).unwrap().settings.fingerprint_seed,
        Some(17)
    );
}
