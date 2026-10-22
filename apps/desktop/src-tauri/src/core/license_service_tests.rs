use super::license_service::{ValidatedLicense, persist_validated_license};
use super::license_store::LicenseStore;

#[test]
fn invalid_license_does_not_replace_the_current_database_value() {
    let root = tempfile::tempdir().unwrap();
    let store = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();
    store
        .save_validated("cb_previous_key", "free", None)
        .unwrap();

    let result = persist_validated_license(
        &store,
        "cb_rejected_key",
        &ValidatedLicense {
            valid: false,
            plan: "free".into(),
            expires: None,
        },
    );

    assert!(result.is_err());
    assert_eq!(
        store.license_key().unwrap().as_deref(),
        Some("cb_previous_key")
    );
}

#[test]
fn valid_license_persists_only_after_validation_result_is_valid() {
    let root = tempfile::tempdir().unwrap();
    let store = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();

    persist_validated_license(
        &store,
        "cb_accepted_key",
        &ValidatedLicense {
            valid: true,
            plan: "team".into(),
            expires: Some("2027-01-01".into()),
        },
    )
    .unwrap();

    assert_eq!(
        store.license_key().unwrap().as_deref(),
        Some("cb_accepted_key")
    );
    assert_eq!(store.status().unwrap().plan.as_deref(), Some("team"));
}
