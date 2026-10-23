use super::license_service::{LicenseService, ValidatedLicense, persist_validated_license};
use super::license_store::LicenseStore;
use super::runtime_paths::RuntimePaths;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

fn service_with_cached_license(root: &Path, fetch: &str) -> (LicenseService, LicenseStore) {
    let store = LicenseStore::new(root.join("nexus.sqlite")).unwrap();
    store
        .save_validated("cb_fixture_previous", "free", None)
        .unwrap();
    let cache = root.join("cache");
    fs::create_dir(&cache).unwrap();
    fs::write(
        cache.join(".license_cache"),
        serde_json::to_vec(&serde_json::json!({
            "key_sha256": format!("{:x}", Sha256::digest(b"cb_fixture_checked")),
            "valid": true,
            "plan": "free",
            "expires": null,
            "validated_at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
        }))
        .unwrap(),
    )
    .unwrap();
    let sdk = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/browser-runtime/node_modules/cloakbrowser/dist/index.js")
        .canonicalize()
        .unwrap();
    let script = root.join("validate.mjs");
    fs::write(
        &script,
        format!(
            "import {{ validateLicense }} from {};\n\
             globalThis.fetch = async () => {{ {fetch} }};\n\
             console.log(JSON.stringify(await validateLicense(process.env.CLOAKBROWSER_LICENSE_KEY)));",
            serde_json::to_string(url::Url::from_file_path(sdk).unwrap().as_str()).unwrap(),
        ),
    ).unwrap();
    let service = LicenseService::with_runtime(
        store.clone(),
        cache,
        RuntimePaths {
            node: "node".into(),
            browser_script: script,
            network_preload: root.join("unused-preload.mjs"),
        },
    );
    (service, store)
}

#[test]
fn saving_revalidates_online_instead_of_accepting_a_cached_success() {
    let root = tempfile::tempdir().unwrap();
    let (service, store) = service_with_cached_license(
        root.path(),
        r#"return new Response(JSON.stringify({valid:false,plan:"free",expires:null}));"#,
    );
    let error = service.set_key("cb_fixture_checked".into()).unwrap_err();
    assert!(error.contains("激活服务未接受"));
    assert!(!error.contains("过期"));
    assert_eq!(
        store.license_key().unwrap().as_deref(),
        Some("cb_fixture_previous")
    );
}

#[test]
fn unreachable_validation_does_not_accept_the_sdks_stale_cache_fallback() {
    let root = tempfile::tempdir().unwrap();
    let (service, store) = service_with_cached_license(
        root.path(),
        r#"throw new TypeError("synthetic network outage");"#,
    );
    let cache_path = root.path().join("cache/.license_cache");
    let mut cache: serde_json::Value =
        serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    cache["validated_at"] = serde_json::json!(0);
    fs::write(cache_path, serde_json::to_vec(&cache).unwrap()).unwrap();
    let error = service.set_key("cb_fixture_checked".into()).unwrap_err();
    assert!(error.contains("无法连接激活服务"));
    assert_eq!(
        store.license_key().unwrap().as_deref(),
        Some("cb_fixture_previous")
    );
}

#[test]
fn successful_online_validation_saves_the_key_and_cleans_temporary_cache() {
    let root = tempfile::tempdir().unwrap();
    let (service, store) = service_with_cached_license(
        root.path(),
        r#"return new Response(JSON.stringify({valid:true,plan:"team",expires:null}));"#,
    );
    let status = service.set_key("cb_fixture_checked".into()).unwrap();
    assert_eq!(status.plan.as_deref(), Some("team"));
    assert_eq!(
        store.license_key().unwrap().as_deref(),
        Some("cb_fixture_checked")
    );
    assert_eq!(fs::read_dir(root.path().join("cache")).unwrap().count(), 1);
}

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
