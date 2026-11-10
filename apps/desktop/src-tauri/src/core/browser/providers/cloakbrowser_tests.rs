use super::*;
use crate::core::browser::provider::{BrowserBinding, WindowOrigin};
use crate::core::window_store::WindowSettings;
use serde_json::{Value, json};
use std::io::Cursor;

fn record() -> WindowRecord {
    let id = uuid::Uuid::new_v4().to_string();
    WindowRecord {
        schema_version: 2,
        id: id.clone(),
        name: "Built-in window".into(),
        binding: BrowserBinding {
            provider_id: BrowserProviderId::CloakBrowser,
            connection_id: BUILTIN_CONNECTION_ID.into(),
            profile_id: id,
        },
        binary_path: Some(PathBuf::from(
            "/managed/chromium-155.0.8059.39.2-pro/browser",
        )),
        kernel_version: Some("155.0.8059.39.2".into()),
        proxy: None,
        proxy_plugin: None,
        proxy_endpoint: None,
        proxy_mode: ProxyMode::Direct,
        settings: WindowSettings {
            fingerprint_seed: Some(42),
            ..WindowSettings::default()
        },
        origin: WindowOrigin::Created,
        provider_config: json!({}),
        created_at: 100,
        last_opened_at: None,
        sort_order: 7,
    }
}

fn plugin_record() -> WindowRecord {
    let mut record = record();
    record.proxy_mode = ProxyMode::Plugin;
    record.proxy_plugin = Some("studio.proxy-pool".into());
    record.proxy_endpoint = Some(7);
    record
}

fn resolved(mode: ProxyMode, url: Option<&str>) -> ResolvedProxy {
    ResolvedProxy {
        mode,
        connection_url: url.map(str::to_owned),
    }
}

#[test]
fn authenticated_proxy_only_changes_the_transient_launch_copy() {
    let record = plugin_record();
    let saved = serde_json::to_value(&record).unwrap();
    let connection = "socks5://synthetic-user:synthetic%40password@proxy.invalid:1080";
    let launch =
        browser_launch_record(&record, &resolved(ProxyMode::Plugin, Some(connection))).unwrap();
    let launching = serde_json::to_value(&launch).unwrap();
    let mut expected = saved.clone();
    expected["proxy"] = Value::String(connection.into());
    assert_eq!(launching, expected);
    assert_eq!(launching["schema_version"], 2);
    assert_eq!(launching["binding"]["provider_id"], "cloakbrowser");
    assert_eq!(launching["kernel_version"], "155.0.8059.39.2");
    assert_eq!(launching["proxy_plugin"], "studio.proxy-pool");
    assert_eq!(launching["proxy_endpoint"], 7);
    assert_eq!(launching["proxy_mode"], "plugin");
    assert_eq!(launching["settings"]["fingerprintSeed"], 42);
    assert_eq!(launching["settings"]["geoip"], true);
    assert_eq!(serde_json::to_value(&record).unwrap(), saved);
    assert!(record.proxy.is_none());
    assert!(
        !serde_json::to_string(&record)
            .unwrap()
            .contains("synthetic%40password")
    );
}

#[test]
fn plugin_resolution_failure_never_falls_back_to_direct() {
    let record = plugin_record();
    for connection in [None, Some(""), Some(" \t ")] {
        let error =
            browser_launch_record(&record, &resolved(ProxyMode::Plugin, connection)).unwrap_err();
        assert_eq!(error.code, "invalid_config");
    }
    assert!(browser_launch_record(&record, &resolved(ProxyMode::Direct, None)).is_err());
    assert!(record.proxy.is_none());
}

#[test]
fn manual_resolution_failure_never_falls_back_to_the_saved_server() {
    let mut record = record();
    record.proxy_mode = ProxyMode::Manual;
    record.proxy = Some("http://proxy.invalid:8080".into());
    for connection in [None, Some(""), Some(" ")] {
        assert!(browser_launch_record(&record, &resolved(ProxyMode::Manual, connection)).is_err());
    }
    let launch = browser_launch_record(
        &record,
        &resolved(ProxyMode::Manual, Some("http://proxy.invalid:8080")),
    )
    .unwrap();
    assert_eq!(launch.proxy, record.proxy);
}

#[test]
fn direct_launch_requires_an_explicit_matching_direct_resolution() {
    let record = record();
    let launch = browser_launch_record(&record, &resolved(ProxyMode::Direct, None)).unwrap();
    assert!(launch.proxy.is_none());
    for mode in [ProxyMode::Manual, ProxyMode::Plugin, ProxyMode::Provider] {
        assert!(browser_launch_record(&record, &resolved(mode, None)).is_err());
    }
    assert!(
        browser_launch_record(
            &record,
            &resolved(ProxyMode::Direct, Some("http://proxy.invalid:8080"))
        )
        .is_err()
    );
}

#[test]
fn inconsistent_saved_proxy_sources_are_rejected_before_launch() {
    let mut plugin = plugin_record();
    plugin.proxy = Some("http://fallback.invalid:8080".into());
    assert!(
        browser_launch_record(
            &plugin,
            &resolved(ProxyMode::Plugin, Some("http://selected.invalid:8080"))
        )
        .is_err()
    );
    let mut direct = plugin_record();
    direct.proxy_mode = ProxyMode::Direct;
    assert!(browser_launch_record(&direct, &resolved(ProxyMode::Direct, None)).is_err());
    let mut orphan_endpoint = record();
    orphan_endpoint.proxy_endpoint = Some(7);
    assert!(browser_launch_record(&orphan_endpoint, &resolved(ProxyMode::Direct, None)).is_err());
}

#[test]
fn builtin_browser_cannot_inherit_external_provider_proxy_settings() {
    let mut record = record();
    record.proxy_mode = ProxyMode::Provider;
    let error = browser_launch_record(&record, &resolved(ProxyMode::Provider, None)).unwrap_err();
    assert_eq!(error.code, "unsupported");
}

#[test]
fn invalid_resolved_proxy_addresses_do_not_expose_credentials() {
    let record = plugin_record();
    for connection in [
        "not-a-url-synthetic-password",
        "ftp://synthetic-user:synthetic-password@proxy.invalid:1080",
        "socks5://synthetic-user:synthetic-password@proxy.invalid:0",
        "socks5://synthetic-user:synthetic-password@proxy.invalid",
        "http://synthetic-user:synthetic-password@proxy.invalid:8080/path",
        "http://synthetic-user:synthetic-password@proxy.invalid:8080?credential=synthetic-password",
        "http://synthetic-user:synthetic-password@proxy.invalid:8080#synthetic-password",
        "http://proxy.invalid:8080\nsynthetic-password",
    ] {
        let error = browser_launch_record(&record, &resolved(ProxyMode::Plugin, Some(connection)))
            .unwrap_err();
        let serialized = serde_json::to_string(&error).unwrap();
        assert_eq!(error.code, "invalid_config");
        assert!(!serialized.contains("synthetic-password"));
        assert!(!serialized.contains("synthetic-user"));
    }
}

#[test]
fn launch_preserves_proxy_urls_and_online_ip_settings() {
    for connection in [
        "socks5://proxy.invalid:1080",
        "socks5://[::1]:1080",
        "socks5://synthetic-user:synthetic%40password@proxy.invalid:1080",
        "socks5h://proxy.invalid:1080",
        "socks5h://synthetic-user:synthetic%40password@proxy.invalid:1080",
        "http://synthetic-user:synthetic%40password@proxy.invalid:8080",
        "https://proxy.invalid:443/",
    ] {
        for automatic in [true, false] {
            let mut record = plugin_record();
            record.settings.geoip = automatic;
            record.settings.timezone = "Europe/Paris".into();
            record.settings.locale = "fr-FR".into();
            let launch =
                browser_launch_record(&record, &resolved(ProxyMode::Plugin, Some(connection)))
                    .unwrap();
            assert_eq!(launch.proxy.as_deref(), Some(connection));
            assert_eq!(launch.settings, record.settings);
        }
    }
}

#[test]
fn runtime_errors_are_structured_without_echoing_runner_output() {
    for (detail, code) in [
        ("ACTIVATION_REQUIRED cb_synthetic-secret", "auth_required"),
        (
            "license key is invalid: cb_synthetic-secret",
            "auth_required",
        ),
        ("session limit reached: cb_synthetic-secret", "rate_limited"),
        (
            "PROFILE_ENGINE_MISMATCH cb_synthetic-secret",
            "invalid_config",
        ),
        (
            "PROFILE_PROXY_MISSING cb_synthetic-secret",
            "invalid_config",
        ),
        (
            "PROFILE_GEO_ONLINE_UNAVAILABLE cb_synthetic-secret",
            "unavailable",
        ),
        (
            "PROFILE_GEO_PROXY_CONNECT_FAILED socks5://synthetic-user:synthetic-password@proxy.invalid:1080",
            "unavailable",
        ),
        (
            "NEXUS_KERNEL_ERROR {\"code\":\"NETWORK\",\"message\":\"cb_synthetic-secret synthetic-password\",\"retryable\":true}",
            "unavailable",
        ),
    ] {
        let error = runtime_error(detail);
        assert_eq!(error.code, code);
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("cb_synthetic-secret"));
        assert!(!serialized.contains("synthetic-password"));
        assert!(!serialized.contains("synthetic-user"));
        assert!(!error.message.to_ascii_lowercase().contains("cloakbrowser"));
        assert!(
            error
                .message
                .chars()
                .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
        );
    }
}

#[test]
fn readiness_requires_a_complete_marker_and_handles_closed_output() {
    for bytes in [
        b"unrelated\nNEXUS_READY\n".to_vec(),
        b"NEXUS_READY\r\n".to_vec(),
        [vec![b'x'; 4096], b"\nNEXUS_READY\n".to_vec()].concat(),
    ] {
        assert!(
            read_readiness(Cursor::new(bytes))
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
        );
    }
    for bytes in [
        b"".to_vec(),
        b"NEXUS_READY".to_vec(),
        b"prefix NEXUS_READY\n".to_vec(),
        b"NEXUS_READY trailing-output\n".to_vec(),
        [vec![b'x'; 4096], b"NEXUS_READY\n".to_vec()].concat(),
    ] {
        assert!(
            !read_readiness(Cursor::new(bytes))
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
        );
    }
}

#[test]
fn runner_diagnostics_are_bounded_and_drained() {
    let bytes = vec![b'x'; STDERR_LIMIT * 4];
    assert_eq!(
        read_errors(Cursor::new(bytes))
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        vec![b'x'; STDERR_LIMIT]
    );
}

fn connection() -> BrowserConnection {
    BrowserConnection {
        id: BUILTIN_CONNECTION_ID.into(),
        provider_id: BrowserProviderId::CloakBrowser,
        name: "Built-in browser".into(),
        endpoint: String::new(),
        api_key: None,
        default_group_id: None,
        scope_label: "Local".into(),
        scope_id: Some(BUILTIN_CONNECTION_ID.into()),
        scope_confirmed: true,
        enabled: true,
        revision: 1,
    }
}

fn fixture() -> (tempfile::TempDir, CloakBrowserProvider, WindowRecord) {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("runner.cjs");
    fs::write(root.path().join("mode"), "normal").unwrap();
    fs::write(
        &script,
        r#"const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const action = process.argv[2];
const cache = process.env.CLOAKBROWSER_CACHE_DIR;
const mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8');
const describe = version => ({
  version: version.split('.').slice(0, 4).join('.'),
  binary_path: path.join(cache, 'chromium-' + version + '-pro', 'browser')
});
if (action === 'inventory') {
  const installed = fs.existsSync(cache) ? fs.readdirSync(cache).map(directory => {
    const version = directory.slice(9, -4);
    return {version, binaryPath: describe(version).binary_path};
  }) : [];
  process.stdout.write(JSON.stringify({cacheDir: cache, platform: 'fixture', installed}));
} else if (action === 'version') {
  const version = path.basename(path.dirname(process.argv[3])).slice(9, -4);
  process.stdout.write(JSON.stringify(describe(version)));
} else if (action === 'prepare') {
  const requested = process.env.CLOAKBROWSER_VERSION;
  const version = mode === 'substitute' ? '155.0.8059.39.2' : (requested ?? '155.0.8059.39.2');
  const binary = describe(version);
  if (mode === 'unmanaged') binary.binary_path = path.join(__dirname, 'unmanaged-browser');
  fs.mkdirSync(path.dirname(binary.binary_path), {recursive: true});
  fs.writeFileSync(binary.binary_path, 'fixture');
  fs.writeFileSync(path.join(__dirname, 'preparation.json'), JSON.stringify({
    requestedVersion: requested ?? null,
    hasKey: Boolean(process.env.CLOAKBROWSER_LICENSE_KEY)
  }));
  process.stdout.write(JSON.stringify(binary));
} else if (action === 'launch') {
  let configured = false;
  const input = readline.createInterface({input: process.stdin});
  input.on('line', line => {
    if (configured) {
      if (line === 'stop') process.exit(0);
      return;
    }
    configured = true;
    fs.writeFileSync(path.join(__dirname, 'launch.json'), JSON.stringify({
      record: JSON.parse(line),
      userData: process.argv[3],
      arguments: process.argv,
      hasKey: Boolean(process.env.CLOAKBROWSER_LICENSE_KEY),
      autoUpdate: process.env.CLOAKBROWSER_AUTO_UPDATE,
      versionOverride: process.env.CLOAKBROWSER_VERSION ?? null,
      binaryOverride: process.env.CLOAKBROWSER_BINARY_PATH ?? null
    }));
    if (mode === 'failure') {
      fs.writeSync(2, 'PROFILE_GEO_PROXY_CONNECT_FAILED socks5://synthetic-user:synthetic-password@proxy.invalid:1080 cb_synthetic-license\n');
      process.exit(1);
    }
    if (mode === 'closed-output') {
      fs.closeSync(1);
      setInterval(() => {}, 1000);
      return;
    }
    process.stdout.write('NEXUS_READY\n');
  });
} else {
  process.exitCode = 42;
}
"#,
    )
    .unwrap();
    let licenses = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();
    licenses
        .save_validated("cb_synthetic-license", "pro", None)
        .unwrap();
    let provider = CloakBrowserProvider::new(
        root.path().join("profiles"),
        licenses,
        RuntimePaths {
            node: "node".into(),
            browser_script: script,
            network_preload: root.path().join("unused-preload.cjs"),
        },
        None,
    );
    let mut draft = record();
    draft.binary_path = None;
    draft.kernel_version = None;
    (root, provider, draft)
}

fn prepared_fixture() -> (tempfile::TempDir, CloakBrowserProvider, WindowRecord) {
    let (root, provider, mut record) = fixture();
    let created = provider
        .create_profile(&connection(), &record, "fixture-operation")
        .unwrap();
    record.binary_path = created.binary_path;
    record.kernel_version = created.kernel_version;
    record.provider_config = created.provider_config;
    (root, provider, record)
}

#[test]
fn creation_pins_the_full_package_revision_without_writing_a_nexus_record() {
    let (root, provider, draft) = fixture();
    let created = provider
        .create_profile(&connection(), &draft, "create")
        .unwrap();
    assert_eq!(created.kernel_version.as_deref(), Some("155.0.8059.39.2"));
    assert_eq!(created.provider_config["displayVersion"], "155.0.8059.39");
    assert_eq!(created.profile_id, draft.id);
    assert_eq!(
        provider.user_data_dir(&draft.id).unwrap(),
        root.path()
            .join("profiles")
            .join(&draft.id)
            .join("user-data")
    );
    assert!(!provider.user_data_dir(&draft.id).unwrap().exists());
    assert!(
        !provider
            .profile_dir(&draft.id)
            .unwrap()
            .join("profile.json")
            .exists()
    );
    assert!(draft.binary_path.is_none());
    assert!(draft.kernel_version.is_none());
    let preparation: Value =
        serde_json::from_slice(&fs::read(root.path().join("preparation.json")).unwrap()).unwrap();
    assert!(preparation["requestedVersion"].is_null());
    assert_eq!(preparation["hasKey"], true);
    let db = rusqlite::Connection::open(root.path().join("nexus.sqlite")).unwrap();
    let tables: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='profile_records'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    if tables > 0 {
        let records: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM profile_records WHERE id=?1",
                [&draft.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(records, 0);
    }
}

#[test]
fn explicit_creation_prepares_the_requested_package_and_rejects_substitution() {
    let (root, provider, mut draft) = fixture();
    draft.kernel_version = Some("154.0.8000.10.4".into());
    let created = provider
        .create_profile(&connection(), &draft, "selected")
        .unwrap();
    assert_eq!(created.kernel_version, draft.kernel_version);
    assert_eq!(created.provider_config["displayVersion"], "154.0.8000.10");
    let preparation: Value =
        serde_json::from_slice(&fs::read(root.path().join("preparation.json")).unwrap()).unwrap();
    assert_eq!(preparation["requestedVersion"], "154.0.8000.10.4");

    let (root, provider, mut draft) = fixture();
    draft.kernel_version = Some("155.0.8059.39.1".into());
    fs::write(root.path().join("mode"), "substitute").unwrap();
    assert!(
        provider
            .create_profile(&connection(), &draft, "wrong-package")
            .is_err()
    );
    assert!(!provider.profile_dir(&draft.id).unwrap().exists());
}

#[test]
fn creation_cannot_use_the_display_version_without_managed_package_metadata() {
    let (root, provider, draft) = fixture();
    fs::write(root.path().join("mode"), "unmanaged").unwrap();
    let error = provider
        .create_profile(&connection(), &draft, "unmanaged")
        .unwrap_err();
    assert_eq!(error.code, "not_submitted");
    assert!(!provider.profile_dir(&draft.id).unwrap().exists());
}

#[test]
fn create_and_update_accept_transient_plugin_configuration_without_retaining_credentials() {
    let (_root, provider, mut draft) = fixture();
    draft.proxy_mode = ProxyMode::Plugin;
    draft.proxy_plugin = Some("studio.proxy-pool".into());
    draft.proxy_endpoint = Some(7);
    let mut transient = draft.clone();
    transient.proxy = Some("socks5://synthetic-user:synthetic-password@proxy.invalid:1080".into());
    let created = provider
        .create_profile(&connection(), &transient, "plugin-create")
        .unwrap();
    assert!(
        !created
            .provider_config
            .to_string()
            .contains("synthetic-password")
    );
    draft.binary_path = created.binary_path;
    draft.kernel_version = created.kernel_version;
    draft.provider_config = created.provider_config;
    let mut updated = draft.clone();
    updated.name = "Renamed".into();
    updated.proxy = transient.proxy;
    provider
        .update_profile(&connection(), &draft, &updated)
        .unwrap();
    assert!(
        provider
            .reconcile_update(&connection(), &draft, &updated, &empty_update_evidence())
            .unwrap()
    );
    assert!(draft.proxy.is_none());
}

fn restarted_provider(provider: &CloakBrowserProvider) -> CloakBrowserProvider {
    CloakBrowserProvider::new(
        provider.root.clone(),
        provider.license_store.clone(),
        provider.runtime.clone(),
        provider.network.clone(),
    )
}

#[test]
fn creation_recovers_the_exact_result_after_restart_without_preparing_a_kernel() {
    let (root, provider, mut draft) = fixture();
    draft.provider_config = json!({"ui": {"label": "kept"}});
    let created = provider
        .create_profile(&connection(), &draft, "recover-create")
        .unwrap();
    provider.license_store.remove().unwrap();
    fs::remove_file(&provider.runtime.browser_script).unwrap();
    let restarted = restarted_provider(&provider);
    drop(provider);
    let remote = restarted
        .reconcile_create(&connection(), "recover-create")
        .unwrap()
        .unwrap();
    let binary = created.binary_path.as_ref().unwrap();
    assert!(binary.is_absolute());
    assert_eq!(remote.id, draft.id);
    assert_eq!(remote.name, draft.name);
    assert_eq!(remote.created_at, Some(100));
    assert_eq!(remote.kernel_version.as_deref(), Some("155.0.8059.39.2"));
    assert_eq!(
        remote.provider_config["binaryPath"],
        binary.to_str().unwrap()
    );
    assert_eq!(remote.provider_config["displayVersion"], "155.0.8059.39");
    assert_eq!(remote.provider_config["ui"]["label"], "kept");
    assert_eq!(remote.provider_config, created.provider_config);
    assert!(!root.path().join("launch.json").exists());
}

#[test]
fn reconciliation_finishes_a_directory_publish_interrupted_after_marker_publication() {
    let (_root, provider, draft) = fixture();
    let created = provider
        .create_profile(&connection(), &draft, "interrupted-create")
        .unwrap();
    let marker = provider
        .read_create_marker("interrupted-create")
        .unwrap()
        .unwrap();
    let profile = provider.profile_dir(&draft.id).unwrap();
    let staged = provider
        .root
        .join(CREATE_DIRECTORY)
        .join(&marker.staging_directory);
    fs::rename(&profile, &staged).unwrap();
    let restarted = restarted_provider(&provider);
    drop(provider);
    let remote = restarted
        .reconcile_create(&connection(), "interrupted-create")
        .unwrap()
        .unwrap();
    assert!(profile.is_dir());
    assert!(!staged.exists());
    assert_eq!(remote.id, draft.id);
    assert_eq!(remote.provider_config, created.provider_config);
    assert_eq!(remote.kernel_version, created.kernel_version);
}

#[test]
fn reconciliation_ignores_legacy_profiles_and_markers_for_other_operations() {
    let (_root, provider, draft) = fixture();
    let legacy = provider.profile_dir(&draft.id).unwrap();
    fs::create_dir_all(&legacy).unwrap();
    fs::write(
        legacy.join("profile.json"),
        serde_json::to_vec(&draft).unwrap(),
    )
    .unwrap();
    assert!(
        provider
            .reconcile_create(&connection(), "unknown-operation")
            .unwrap()
            .is_none()
    );
    assert!(provider.list_profiles(&connection()).unwrap().is_empty());
    fs::remove_dir_all(&legacy).unwrap();
    provider
        .create_profile(&connection(), &draft, "known-operation")
        .unwrap();
    assert!(
        provider
            .reconcile_create(&connection(), "unknown-operation")
            .unwrap()
            .is_none()
    );
}

#[test]
fn replay_uses_the_original_package_and_rejects_operation_id_reuse() {
    let (_root, provider, draft) = fixture();
    let created = provider
        .create_profile(&connection(), &draft, "idempotent-create")
        .unwrap();
    provider.license_store.remove().unwrap();
    fs::remove_file(&provider.runtime.browser_script).unwrap();
    let replay = provider
        .create_profile(&connection(), &draft, "idempotent-create")
        .unwrap();
    assert_eq!(replay.profile_id, created.profile_id);
    assert_eq!(replay.kernel_version, created.kernel_version);
    assert_eq!(replay.binary_path, created.binary_path);
    assert_eq!(replay.provider_config, created.provider_config);
    let mut changed = draft.clone();
    changed.settings.fingerprint_seed = Some(43);
    assert_eq!(
        provider
            .create_profile(&connection(), &changed, "idempotent-create")
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    let mut different = draft.clone();
    different.id = uuid::Uuid::new_v4().to_string();
    different.binding.profile_id = different.id.clone();
    assert_eq!(
        provider
            .create_profile(&connection(), &different, "idempotent-create")
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    assert!(!provider.profile_dir(&different.id).unwrap().exists());
}

#[test]
fn create_markers_exclude_transient_proxy_credentials_and_nexus_records() {
    let (_root, provider, mut draft) = fixture();
    draft.proxy_mode = ProxyMode::Plugin;
    draft.proxy_plugin = Some("studio.proxy-pool".into());
    draft.proxy_endpoint = Some(7);
    draft.proxy = Some("socks5://synthetic-user:synthetic-password@proxy.invalid:1080".into());
    let created = provider
        .create_profile(&connection(), &draft, "../exact-operation")
        .unwrap();
    let index = provider.create_marker_path("../exact-operation");
    assert_eq!(
        index.parent().unwrap(),
        provider.root.join(CREATE_DIRECTORY)
    );
    let witness = provider
        .profile_dir(&draft.id)
        .unwrap()
        .join(CREATE_WITNESS);
    for path in [&index, &witness] {
        let bytes = fs::read(path).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("synthetic-user"));
        assert!(!text.contains("synthetic-password"));
        assert!(!text.contains("cb_synthetic-license"));
        let stored: Value = serde_json::from_str(&text).unwrap();
        assert!(stored.get("proxy").is_none());
        assert!(stored.get("settings").is_none());
        assert_eq!(stored["kernelVersion"], "155.0.8059.39.2");
        assert_eq!(stored["providerConfig"], created.provider_config);
    }
    // Plugin credentials can be rotated between submission and recovery.
    draft.proxy = Some("socks5://replacement-user:replacement-password@proxy.invalid:1080".into());
    assert!(
        provider
            .create_profile(&connection(), &draft, "../exact-operation")
            .is_ok()
    );
}

#[test]
fn malformed_or_mismatched_create_markers_never_confirm_a_profile() {
    for invalid in [
        "truncated",
        "wrong-operation",
        "wrong-package",
        "wrong-path",
        "bad-stage",
    ] {
        let (_root, provider, draft) = fixture();
        provider
            .create_profile(&connection(), &draft, "invalid-marker")
            .unwrap();
        let path = provider.create_marker_path("invalid-marker");
        if invalid == "truncated" {
            fs::write(&path, b"{\"schemaVersion\":").unwrap();
        } else {
            let mut marker: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            match invalid {
                "wrong-operation" => marker["operationId"] = json!("other-operation"),
                "wrong-package" => marker["kernelVersion"] = json!("155.0.8059.39"),
                "wrong-path" => marker["providerConfig"]["binaryPath"] = json!("relative/browser"),
                "bad-stage" => marker["stagingDirectory"] = json!("../foreign"),
                _ => unreachable!(),
            }
            fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();
        }
        assert_eq!(
            restarted_provider(&provider)
                .reconcile_create(&connection(), "invalid-marker")
                .unwrap_err()
                .code,
            "operation_uncertain"
        );
    }
}

#[test]
fn foreign_profile_directories_and_missing_stage_witnesses_are_not_adopted() {
    for foreign_target in [true, false] {
        let (_root, provider, draft) = fixture();
        provider
            .create_profile(&connection(), &draft, "foreign-target")
            .unwrap();
        let marker = provider
            .read_create_marker("foreign-target")
            .unwrap()
            .unwrap();
        let profile = provider.profile_dir(&draft.id).unwrap();
        let staged = provider
            .root
            .join(CREATE_DIRECTORY)
            .join(&marker.staging_directory);
        fs::rename(&profile, &staged).unwrap();
        if foreign_target {
            fs::create_dir(&profile).unwrap();
            fs::write(profile.join("foreign-data"), b"preserved").unwrap();
        } else {
            fs::remove_file(staged.join(CREATE_WITNESS)).unwrap();
        }
        assert_eq!(
            provider
                .reconcile_create(&connection(), "foreign-target")
                .unwrap_err()
                .code,
            "operation_uncertain"
        );
        assert!(staged.is_dir());
        if foreign_target {
            assert_eq!(
                fs::read(profile.join("foreign-data")).unwrap(),
                b"preserved"
            );
        } else {
            assert!(!profile.exists());
        }
    }
}

#[cfg(unix)]
#[test]
fn creation_recovery_refuses_symlinked_markers_and_profile_directories() {
    for substitute_index in [true, false] {
        let (root, provider, draft) = fixture();
        provider
            .create_profile(&connection(), &draft, "symlinked-create")
            .unwrap();
        let original = if substitute_index {
            provider.create_marker_path("symlinked-create")
        } else {
            provider.profile_dir(&draft.id).unwrap()
        };
        let moved = root.path().join("moved");
        fs::rename(&original, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &original).unwrap();
        assert_eq!(
            provider
                .reconcile_create(&connection(), "symlinked-create")
                .unwrap_err()
                .code,
            "operation_uncertain"
        );
        assert!(moved.exists());
    }
}

#[test]
fn a_deleted_profile_is_never_resurrected_or_replaced_from_a_stale_marker() {
    let (_root, provider, draft) = fixture();
    provider
        .create_profile(&connection(), &draft, "deleted-create")
        .unwrap();
    provider.delete_profile(&connection(), &draft).unwrap();
    assert_eq!(
        provider
            .reconcile_create(&connection(), "deleted-create")
            .unwrap_err()
            .code,
        "operation_uncertain"
    );
    assert!(!provider.profile_dir(&draft.id).unwrap().exists());
    provider
        .create_profile(&connection(), &draft, "replacement-create")
        .unwrap();
    assert_eq!(
        provider
            .reconcile_create(&connection(), "deleted-create")
            .unwrap_err()
            .code,
        "operation_uncertain"
    );
    assert!(
        provider
            .reconcile_create(&connection(), "replacement-create")
            .unwrap()
            .is_some()
    );
}

#[test]
fn native_creation_rejections_before_submission_use_the_known_rejection_code() {
    for failure in [
        "binding", "proxy", "version", "license", "runtime", "root", "existing",
    ] {
        let (_root, provider, mut draft) = fixture();
        match failure {
            "binding" => draft.binding.profile_id = uuid::Uuid::new_v4().to_string(),
            "proxy" => draft.proxy_mode = ProxyMode::Plugin,
            "version" => draft.kernel_version = Some("latest".into()),
            "license" => provider.license_store.remove().unwrap(),
            "runtime" => fs::remove_file(&provider.runtime.browser_script).unwrap(),
            "root" => fs::write(&provider.root, b"file-instead-of-directory").unwrap(),
            "existing" => fs::create_dir_all(provider.profile_dir(&draft.id).unwrap()).unwrap(),
            _ => unreachable!(),
        }
        let error = provider
            .create_profile(&connection(), &draft, "rejected-create")
            .unwrap_err();
        assert_eq!(error.code, "not_submitted", "{failure}");
        assert!(!error.message.to_ascii_lowercase().contains("cloakbrowser"));
        assert!(!error.message.contains("cb_synthetic-license"));
        assert!(!provider.create_marker_path("rejected-create").exists());
    }
}

#[test]
fn a_published_marker_preserves_uncertainty_instead_of_reporting_not_submitted() {
    let (_root, provider, draft) = fixture();
    provider
        .create_profile(&connection(), &draft, "published-create")
        .unwrap();
    fs::remove_file(
        provider
            .profile_dir(&draft.id)
            .unwrap()
            .join(CREATE_WITNESS),
    )
    .unwrap();
    assert_eq!(
        provider
            .create_profile(&connection(), &draft, "published-create")
            .unwrap_err()
            .code,
        "operation_uncertain"
    );
}

#[test]
fn update_recovery_validates_immutability_without_writing_profile_data() {
    let (root, provider, previous) = prepared_fixture();
    let profile = provider.profile_dir(&previous.id).unwrap();
    let witness = fs::read(profile.join(CREATE_WITNESS)).unwrap();
    let mut updated = previous.clone();
    updated.name = "Recovered name".into();
    updated.settings.note = "Recovered note".into();
    assert!(
        provider
            .reconcile_update(&connection(), &previous, &updated, &empty_update_evidence())
            .unwrap()
    );
    assert_eq!(fs::read(profile.join(CREATE_WITNESS)).unwrap(), witness);
    assert!(!provider.user_data_dir(&previous.id).unwrap().exists());
    assert!(!root.path().join("launch.json").exists());
    for field in ["binding", "binary", "kernel", "seed", "proxy"] {
        let mut invalid = updated.clone();
        match field {
            "binding" => invalid.binding.connection_id = "foreign".into(),
            "binary" => invalid.binary_path = None,
            "kernel" => invalid.kernel_version = Some("155.0.8059.39.1".into()),
            "seed" => invalid.settings.fingerprint_seed = Some(43),
            "proxy" => invalid.proxy_mode = ProxyMode::Plugin,
            _ => unreachable!(),
        }
        assert!(
            provider
                .reconcile_update(&connection(), &previous, &invalid, &empty_update_evidence())
                .is_err(),
            "{field}"
        );
    }
    fs::remove_dir_all(profile).unwrap();
    assert_eq!(
        provider
            .reconcile_update(&connection(), &previous, &updated, &empty_update_evidence())
            .unwrap_err()
            .code,
        "profile_missing"
    );
}

#[test]
fn delete_recovery_requires_directory_absence_even_when_discovery_is_empty() {
    let (_root, provider, record) = prepared_fixture();
    let profile = provider.profile_dir(&record.id).unwrap();
    assert!(provider.list_profiles(&connection()).unwrap().is_empty());
    assert!(!provider.reconcile_delete(&connection(), &record).unwrap());
    // A partially removed directory still contains an environment to delete.
    fs::remove_file(profile.join(CREATE_WITNESS)).unwrap();
    fs::create_dir(profile.join("user-data")).unwrap();
    fs::write(
        profile.join("user-data").join("remaining-data"),
        b"preserved",
    )
    .unwrap();
    assert!(!provider.reconcile_delete(&connection(), &record).unwrap());
    assert_eq!(
        fs::read(profile.join("user-data").join("remaining-data")).unwrap(),
        b"preserved"
    );
    provider.delete_profile(&connection(), &record).unwrap();
    assert!(provider.reconcile_delete(&connection(), &record).unwrap());
    let mut invalid = record.clone();
    invalid.binding.profile_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        provider
            .reconcile_delete(&connection(), &invalid)
            .unwrap_err()
            .code,
        "invalid_config"
    );
    let mut foreign = connection();
    foreign.id = "foreign".into();
    assert_eq!(
        provider
            .reconcile_delete(&foreign, &record)
            .unwrap_err()
            .code,
        "scope_mismatch"
    );
}

#[test]
fn delete_recovery_does_not_confirm_a_rejected_removal_with_data_remaining() {
    let (_root, provider, record) = prepared_fixture();
    let lock = provider.process_lock(&record.id).unwrap();
    let operation = lock.lock().unwrap();
    assert_eq!(
        provider
            .delete_profile(&connection(), &record)
            .unwrap_err()
            .code,
        "profile_busy"
    );
    drop(operation);
    assert!(!provider.reconcile_delete(&connection(), &record).unwrap());
    assert!(provider.profile_dir(&record.id).unwrap().is_dir());
}

#[test]
fn delete_recovery_reports_inspection_errors_without_claiming_data_is_absent() {
    let (root, provider, record) = prepared_fixture();
    let inaccessible = root.path().join("preserved-profiles");
    fs::rename(&provider.root, &inaccessible).unwrap();
    fs::write(&provider.root, b"not-a-directory").unwrap();
    let error = provider
        .reconcile_delete(&connection(), &record)
        .unwrap_err();
    assert_eq!(error.code, "operation_uncertain");
    assert!(inaccessible.join(&record.id).is_dir());
    assert!(!error.message.contains("cb_synthetic-license"));
    assert!(!error.message.contains("preserved-profiles"));
}

#[cfg(unix)]
#[test]
fn a_rejected_symlink_removal_is_not_confirmed_by_delete_recovery() {
    let (root, provider, record) = prepared_fixture();
    let profile = provider.profile_dir(&record.id).unwrap();
    let preserved = root.path().join("preserved-profile");
    fs::rename(&profile, &preserved).unwrap();
    std::os::unix::fs::symlink(&preserved, &profile).unwrap();
    assert_eq!(
        provider
            .delete_profile(&connection(), &record)
            .unwrap_err()
            .code,
        "invalid_config"
    );
    assert!(!provider.reconcile_delete(&connection(), &record).unwrap());
    assert!(preserved.is_dir());
}

#[test]
fn launch_and_stop_use_the_child_state_and_preserve_the_record() {
    let (root, provider, mut record) = prepared_fixture();
    record.proxy_mode = ProxyMode::Plugin;
    record.proxy_plugin = Some("studio.proxy-pool".into());
    record.proxy_endpoint = Some(7);
    let saved = serde_json::to_value(&record).unwrap();
    let proxy = resolved(
        ProxyMode::Plugin,
        Some("socks5://synthetic-user:synthetic-password@proxy.invalid:1080"),
    );
    for _ in 0..2 {
        provider
            .start_profile(&connection(), &record, &proxy)
            .unwrap();
        let capture: Value =
            serde_json::from_slice(&fs::read(root.path().join("launch.json")).unwrap()).unwrap();
        let mut expected = saved.clone();
        expected["proxy"] = Value::String(proxy.connection_url.clone().unwrap());
        assert_eq!(capture["record"], expected);
        assert_eq!(capture["hasKey"], true);
        assert_eq!(capture["autoUpdate"], "false");
        assert!(capture["versionOverride"].is_null());
        assert!(capture["binaryOverride"].is_null());
        assert!(
            !capture["arguments"]
                .to_string()
                .contains("cb_synthetic-license")
        );
        assert!(
            !capture["record"]
                .to_string()
                .contains("cb_synthetic-license")
        );
        assert_eq!(
            capture["userData"],
            provider
                .user_data_dir(&record.id)
                .unwrap()
                .to_str()
                .unwrap()
        );
        assert_eq!(provider.observe(&record.id).unwrap(), WindowState::Running);
        assert_eq!(
            provider
                .reconcile_update(&connection(), &record, &record, &empty_update_evidence())
                .unwrap_err()
                .code,
            "profile_busy"
        );
        assert_eq!(
            provider
                .reconcile_delete(&connection(), &record)
                .unwrap_err()
                .code,
            "profile_busy"
        );
        assert_eq!(
            provider
                .start_profile(&connection(), &record, &proxy)
                .unwrap_err()
                .code,
            "profile_busy"
        );
        assert_eq!(
            provider
                .delete_profile(&connection(), &record)
                .unwrap_err()
                .code,
            "profile_busy"
        );
        provider.stop_profile(&connection(), &record).unwrap();
        assert_eq!(provider.observe(&record.id).unwrap(), WindowState::Stopped);
        assert!(provider.session(&record.id).unwrap().is_none());
    }
    assert_eq!(serde_json::to_value(&record).unwrap(), saved);
}

#[test]
fn unresolved_proxy_and_missing_package_binding_never_start_the_runtime() {
    let (root, provider, mut record) = prepared_fixture();
    let pinned = record.kernel_version.take();
    let direct = resolved(ProxyMode::Direct, None);
    assert_eq!(
        provider
            .start_profile(&connection(), &record, &direct)
            .unwrap_err()
            .code,
        "invalid_config"
    );
    record.kernel_version = Some("155.0.8059.39".into());
    assert!(
        provider
            .start_profile(&connection(), &record, &direct)
            .is_err()
    );
    record.kernel_version = pinned;
    record.proxy_mode = ProxyMode::Plugin;
    record.proxy_plugin = Some("studio.proxy-pool".into());
    assert!(
        provider
            .start_profile(&connection(), &record, &resolved(ProxyMode::Plugin, None))
            .is_err()
    );
    assert!(!root.path().join("launch.json").exists());
    assert!(provider.session(&record.id).unwrap().is_none());
}

fn assert_failed_start_cleanup(mode: &str) {
    let (root, provider, record) = prepared_fixture();
    fs::write(root.path().join("mode"), mode).unwrap();
    let started = Instant::now();
    let error = provider
        .start_profile(&connection(), &record, &resolved(ProxyMode::Direct, None))
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(root.path().join("launch.json").is_file());
    assert!(!error.message.contains("synthetic-user"));
    assert!(!error.message.contains("synthetic-password"));
    assert!(!error.message.contains("cb_synthetic-license"));
    assert_eq!(provider.observe(&record.id).unwrap(), WindowState::Stopped);
    assert!(provider.session(&record.id).unwrap().is_none());
    fs::write(root.path().join("mode"), "normal").unwrap();
    provider
        .start_profile(&connection(), &record, &resolved(ProxyMode::Direct, None))
        .unwrap();
    provider.stop_profile(&connection(), &record).unwrap();
}

#[test]
fn failed_start_reaps_the_runner_before_retry() {
    assert_failed_start_cleanup("failure");
}

// Node deliberately leaves stdio open for fs.closeSync on Windows.
#[cfg(unix)]
#[test]
fn closed_startup_output_kills_and_reaps_the_runner_before_retry() {
    assert_failed_start_cleanup("closed-output");
}

#[test]
fn observation_reaps_an_exited_child_instead_of_trusting_a_running_flag() {
    let (_root, provider, record) = prepared_fixture();
    provider
        .start_profile(&connection(), &record, &resolved(ProxyMode::Direct, None))
        .unwrap();
    let session = provider.session(&record.id).unwrap().unwrap();
    session.lock().unwrap().child.kill().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if provider.observe(&record.id).unwrap() == WindowState::Stopped {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(provider.session(&record.id).unwrap().is_none());
}

#[test]
fn separate_windows_can_run_the_same_pinned_kernel() {
    let (_root, provider, first) = prepared_fixture();
    let mut second = record();
    second.binary_path = None;
    second.kernel_version = first.kernel_version.clone();
    let created = provider
        .create_profile(&connection(), &second, "second-window")
        .unwrap();
    second.binary_path = created.binary_path;
    second.kernel_version = created.kernel_version;
    second.provider_config = created.provider_config;
    assert_eq!(first.binary_path, second.binary_path);
    let proxy = resolved(ProxyMode::Direct, None);
    provider
        .start_profile(&connection(), &first, &proxy)
        .unwrap();
    provider
        .start_profile(&connection(), &second, &proxy)
        .unwrap();
    let states = provider
        .observe_profiles(&connection(), &[first.clone(), second.clone()])
        .unwrap()
        .states;
    assert_eq!(states.get(&first.id), Some(&WindowState::Running));
    assert_eq!(states.get(&second.id), Some(&WindowState::Running));
    provider.stop_profile(&connection(), &first).unwrap();
    assert_eq!(provider.observe(&second.id).unwrap(), WindowState::Running);
    provider.stop_profile(&connection(), &second).unwrap();
}

#[test]
fn removing_the_saved_license_blocks_launch_before_spawning() {
    let (root, provider, record) = prepared_fixture();
    provider.license_store.remove().unwrap();
    let error = provider
        .start_profile(&connection(), &record, &resolved(ProxyMode::Direct, None))
        .unwrap_err();
    assert_eq!(error.code, "auth_required");
    assert!(!root.path().join("launch.json").exists());
    assert!(provider.session(&record.id).unwrap().is_none());
}

fn empty_update_evidence() -> UpdateEvidence {
    UpdateEvidence::from_fields(BrowserProviderId::CloakBrowser, &serde_json::json!({})).unwrap()
}
