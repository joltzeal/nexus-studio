use super::license_store::LicenseStore;

#[test]
fn saved_license_survives_reopen_without_exposing_the_key_in_status() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    let store = LicenseStore::new(path.clone()).unwrap();
    store
        .save_validated("cb_private_test_key", "free", None)
        .unwrap();

    let status = LicenseStore::new(path).unwrap().status().unwrap();
    assert!(status.configured);
    assert_eq!(status.plan.as_deref(), Some("free"));
    assert_eq!(status.expires, None);
    let public_status = serde_json::to_string(&status).unwrap();
    assert!(!public_status.contains("cb_private_test_key"));
}

#[cfg(unix)]
#[test]
fn license_database_is_readable_only_by_the_current_user() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nexus.sqlite");
    LicenseStore::new(path.clone()).unwrap();

    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn empty_license_is_not_persisted() {
    let root = tempfile::tempdir().unwrap();
    let store = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();

    assert!(store.save_validated("  ", "free", None).is_err());
    assert!(!store.status().unwrap().configured);
}

#[test]
fn removing_license_clears_configuration_status() {
    let root = tempfile::tempdir().unwrap();
    let store = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();
    store
        .save_validated("cb_private_test_key", "pro", Some("2027-01-01"))
        .unwrap();

    store.remove().unwrap();

    assert!(!store.status().unwrap().configured);
    assert_eq!(store.license_key().unwrap(), None);
}

#[test]
fn save_replaces_the_old_key_only_when_explicitly_called_after_validation() {
    let root = tempfile::tempdir().unwrap();
    let store = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();
    store
        .save_validated("cb_old_test_key", "free", None)
        .unwrap();
    store
        .save_validated("cb_new_test_key", "team", Some("2027-01-01"))
        .unwrap();

    assert_eq!(
        store.license_key().unwrap().as_deref(),
        Some("cb_new_test_key")
    );
    assert_eq!(store.status().unwrap().plan.as_deref(), Some("team"));
}
