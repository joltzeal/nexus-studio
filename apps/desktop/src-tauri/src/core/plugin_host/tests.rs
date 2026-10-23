use super::PluginHost;
use super::discovery::{CandidateSource, DiscoveryProblem, inspect};
use super::install::{self, InstallError};
use super::manifest::{Capability, ManifestError, PluginManifest};
use super::permissions::{PermissionError, check_call};
use super::process::{PluginProcess, ProcessError, scrub_url_credentials};
use super::registry::RegistryStore;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MANIFEST: &str = r#"{
  "apiVersion": 1,
  "id": "test.fixture-plugin",
  "version": "1.2.0",
  "name": "Fixture",
  "minCoreVersion": "0.1.0",
  "capabilities": ["proxy.provider"],
  "permissions": {
    "networkDomains": ["example.com"],
    "wantsBrowserAccess": false,
    "storage": "private",
    "secrets": ["proxy-password"]
  }
}"#;

const PLUGIN_JS: &str = r#"
const readline = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nexus.plugin.json'), 'utf8'))
const configPath = path.join(__dirname, 'fixture.json')
const configured = fs.existsSync(configPath) && JSON.parse(fs.readFileSync(configPath, 'utf8')).configured === true
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const pending = new Map()
let sequence = 0
send({
  type: 'hello',
  protocolVersion: 1,
  pluginId: manifest.id,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  capabilities: manifest.capabilities,
})
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'handshake') {
    send({
      type: 'ready',
      protocolVersion: 1,
      pluginId: manifest.id,
      version: manifest.version,
      capabilities: manifest.capabilities,
      methods: ['proxy.resolve', 'proxy.groups.list', 'test.echo', 'test.crash'],
      status: { fixture: true },
    })
    return
  }
  if (message.method === 'test.crash') {
    process.exit(1)
    return
  }
  if (message.method === 'test.echo') {
    send({ protocolVersion: 1, requestId: message.requestId, ok: true, result: message.payload })
    return
  }
  if (message.method === 'proxy.resolve') {
    send({
      protocolVersion: 1,
      requestId: message.requestId,
      ok: true,
      result: configured
        ? { configured: true, configHandle: 'fixture:endpoint:1', secretRef: null }
        : { configured: false, configHandle: null, secretRef: null },
    })
    return
  }
  if (message.method === 'proxy.groups.list') {
    send({ protocolVersion: 1, requestId: message.requestId, ok: true, result: { items: [] } })
    return
  }
  send({ protocolVersion: 1, requestId: message.requestId, ok: false, error: { code: 'INVALID_REQUEST', message: 'unknown method', retryable: false } })
})
"#;

/// Every test that starts a real Node process competes for the same machine.
/// Four at a time keeps the suite quick without making the 15 s handshake
/// budget depend on how loaded the box happens to be.
static NODE_SLOTS: std::sync::Mutex<usize> = std::sync::Mutex::new(4);
static NODE_WAKE: std::sync::Condvar = std::sync::Condvar::new();

struct NodeSlot;

impl NodeSlot {
    fn acquire() -> Self {
        let mut free = NODE_SLOTS.lock().unwrap_or_else(|error| error.into_inner());
        while *free == 0 {
            free = NODE_WAKE
                .wait(free)
                .unwrap_or_else(|error| error.into_inner());
        }
        *free -= 1;
        NodeSlot
    }
}

impl Drop for NodeSlot {
    fn drop(&mut self) {
        let mut free = NODE_SLOTS.lock().unwrap_or_else(|error| error.into_inner());
        *free += 1;
        NODE_WAKE.notify_one();
    }
}

fn write_package(directory: &Path, manifest: &str, configured: bool) -> PathBuf {
    fs::create_dir_all(directory.join("dist")).unwrap();
    fs::write(directory.join("nexus.plugin.json"), manifest).unwrap();
    fs::write(
        directory.join("package.json"),
        r#"{"name":"fixture","main":"dist/index.js"}"#,
    )
    .unwrap();
    fs::write(directory.join("dist/index.js"), PLUGIN_JS).unwrap();
    if configured {
        fs::write(
            directory.join("dist/fixture.json"),
            r#"{"configured":true}"#,
        )
        .unwrap();
    }
    directory.to_path_buf()
}

#[test]
fn manifest_rejects_unknown_fields() {
    let with_extra = MANIFEST.replace(
        "\"minCoreVersion\": \"0.1.0\",",
        "\"minCoreVersion\": \"0.1.0\", \"entry\": \"index.js\",",
    );
    assert_eq!(
        PluginManifest::parse(with_extra.as_bytes()).unwrap_err(),
        ManifestError::UnknownField
    );
}

#[test]
fn manifest_rejects_wildcard_and_port_domains() {
    for domain in ["*.example.com", "example.com:8080", "localhost", "10.0.0.1"] {
        let text = MANIFEST.replace("\"example.com\"", &format!("\"{domain}\""));
        assert_eq!(
            PluginManifest::parse(text.as_bytes()).unwrap_err(),
            ManifestError::InvalidNetworkDomain,
            "{domain} must be rejected"
        );
    }
}

#[test]
fn manifest_rejects_incompatible_core_and_api() {
    let newer = MANIFEST.replace(
        "\"minCoreVersion\": \"0.1.0\"",
        "\"minCoreVersion\": \"9.0.0\"",
    );
    assert_eq!(
        PluginManifest::parse(newer.as_bytes()).unwrap_err(),
        ManifestError::IncompatibleCore
    );
    let other_api = MANIFEST.replace("\"apiVersion\": 1", "\"apiVersion\": 2");
    assert_eq!(
        PluginManifest::parse(other_api.as_bytes()).unwrap_err(),
        ManifestError::UnsupportedApiVersion
    );
}

#[test]
fn manifest_rejects_duplicate_capability() {
    let duplicated = MANIFEST.replace(
        "\"capabilities\": [\"proxy.provider\"]",
        "\"capabilities\": [\"proxy.provider\", \"proxy.provider\"]",
    );
    assert_eq!(
        PluginManifest::parse(duplicated.as_bytes()).unwrap_err(),
        ManifestError::DuplicateCapability
    );
}

#[test]
fn workspace_plugin_manifest_is_valid() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/proxy-pool/dist/nexus.plugin.json");
    if !path.is_file() {
        return;
    }
    let manifest = PluginManifest::parse(&fs::read(path).unwrap()).unwrap();
    assert_eq!(manifest.id, "studio.proxy-pool");
    assert!(manifest.declares(Capability::ProxyProvider));
    assert!(manifest.declares_secret("proxy-password"));
}

#[test]
fn every_capability_round_trips_through_its_wire_name() {
    // A capability that is added to the enum but not to `as_str` (or the
    // reverse) would silently stop matching manifests.
    for capability in Capability::ALL {
        assert_eq!(Capability::parse(capability.as_str()), Some(capability));
    }
}

#[test]
fn workspace_vinted_accounts_manifest_declares_the_account_pool() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/vinted-accounts/dist/nexus.plugin.json");
    if !path.is_file() {
        return;
    }
    let manifest = PluginManifest::parse(&fs::read(path).unwrap()).unwrap();
    assert_eq!(manifest.id, "studio.vinted-accounts");
    assert!(manifest.declares(Capability::AccountPool));
    // Credentials never leave the private store: no network, no secret slots.
    assert!(manifest.permissions.network_domains.is_empty());
    assert!(manifest.permissions.secrets.is_empty());
}

#[test]
fn discovery_skips_non_packages_and_reports_missing_entry() {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir_all(temporary.path().join("empty")).unwrap();
    assert!(
        inspect(
            &temporary.path().join("empty"),
            CandidateSource::Development
        )
        .unwrap()
        .is_none()
    );

    let broken = temporary.path().join("broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("nexus.plugin.json"), MANIFEST).unwrap();
    assert_eq!(
        inspect(&broken, CandidateSource::Development).unwrap_err(),
        DiscoveryProblem::MissingEntry
    );
}

#[test]
fn install_copies_package_and_refuses_a_second_install() {
    let temporary = tempfile::tempdir().unwrap();
    let source = write_package(&temporary.path().join("source"), MANIFEST, false);
    let root = temporary.path().join("host");
    let candidate = inspect(&source, CandidateSource::Development)
        .unwrap()
        .unwrap();

    let installed = install::install(&candidate, &root).unwrap();
    assert!(installed.join("dist/index.js").is_file());
    assert!(installed.join("nexus.plugin.json").is_file());
    assert_eq!(
        install::install(&candidate, &root).unwrap_err(),
        InstallError::AlreadyInstalled
    );

    install::uninstall(&root, &candidate.manifest.id, &candidate.manifest.version).unwrap();
    assert!(!installed.exists());
}

#[test]
fn reinstall_replaces_the_version_directory_in_place() {
    // A package rebuilt from a directory keeps its version, so refreshing it
    // cannot go through `install`: that path refuses a directory that exists.
    let temporary = tempfile::tempdir().unwrap();
    let source = write_package(&temporary.path().join("source"), MANIFEST, false);
    let root = temporary.path().join("host");
    let candidate = inspect(&source, CandidateSource::Development)
        .unwrap()
        .unwrap();
    let installed = install::install(&candidate, &root).unwrap();
    fs::write(installed.join("dist/index.js"), "// old build").unwrap();

    let replaced = install::reinstall(&candidate, &root).unwrap();
    assert_eq!(replaced, installed);
    assert_ne!(
        fs::read_to_string(replaced.join("dist/index.js")).unwrap(),
        "// old build"
    );
    // The staging directory is cleaned up either way.
    assert!(
        fs::read_dir(root.join(".staging"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn install_keeps_a_manifest_that_lives_in_dist() {
    // Built packages ship `dist/nexus.plugin.json`, not a root manifest. The
    // install re-reads the copied manifest, so it has to use the same relative
    // path the discovery step used.
    let temporary = tempfile::tempdir().unwrap();
    let source = write_package(&temporary.path().join("source"), MANIFEST, false);
    fs::rename(
        source.join("nexus.plugin.json"),
        source.join("dist/nexus.plugin.json"),
    )
    .unwrap();
    let root = temporary.path().join("host");
    let candidate = inspect(&source, CandidateSource::Workspace)
        .unwrap()
        .unwrap();
    assert_eq!(
        candidate.manifest_relative,
        PathBuf::from("dist/nexus.plugin.json")
    );

    let installed = install::install(&candidate, &root).unwrap();
    assert!(installed.join("dist/nexus.plugin.json").is_file());
    assert!(!installed.join("nexus.plugin.json").exists());
    assert!(installed.join("dist/index.js").is_file());
}

#[test]
fn permission_checkpoint_denies_undeclared_and_ungranted_capabilities() {
    let temporary = tempfile::tempdir().unwrap();
    let source = write_package(&temporary.path().join("source"), MANIFEST, false);
    let candidate = inspect(&source, CandidateSource::Development)
        .unwrap()
        .unwrap();
    let mut plugin = super::registry::InstalledPlugin {
        id: candidate.manifest.id.clone(),
        version: candidate.manifest.version.clone(),
        manifest: candidate.manifest.clone(),
        directory: candidate.directory.clone(),
        entry: candidate.entry.clone(),
        manifest_digest: candidate.digest.clone(),
        enabled: true,
        granted_capabilities: vec![Capability::ProxyProvider],
        granted_domains: Vec::new(),
        installed_at: "0".into(),
    };
    let ready = super::process::ReadyInfo {
        plugin_id: plugin.id.clone(),
        version: plugin.version.clone(),
        capabilities: vec!["proxy.provider".into()],
        methods: vec!["proxy.resolve".into()],
        status: serde_json::Value::Null,
    };
    assert!(check_call(&plugin, &ready, Capability::ProxyProvider, "proxy.resolve").is_ok());
    assert_eq!(
        check_call(&plugin, &ready, Capability::ImageProvider, "proxy.resolve").unwrap_err(),
        PermissionError::CapabilityUndeclared
    );
    assert_eq!(
        check_call(&plugin, &ready, Capability::ProxyProvider, "proxy.delete").unwrap_err(),
        PermissionError::MethodNotDeclared
    );
    plugin.granted_capabilities.clear();
    assert_eq!(
        check_call(&plugin, &ready, Capability::ProxyProvider, "proxy.resolve").unwrap_err(),
        PermissionError::CapabilityNotGranted
    );
}

#[test]
fn registry_roundtrip_and_corruption() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("registry.json");
    let store = RegistryStore::new(path.clone());
    let document = super::registry::RegistryDocument::default();
    store.save(&document).unwrap();
    assert_eq!(store.load().unwrap(), document);

    fs::write(&path, "{not json}").unwrap();
    assert!(store.load().is_err());
}

#[test]
fn url_credentials_are_scrubbed_from_diagnostics() {
    let text = "connect socks5://user:secret@127.0.0.1:1080 failed";
    let scrubbed = scrub_url_credentials(text);
    assert!(!scrubbed.contains("secret"));
    assert!(scrubbed.contains("socks5://***@127.0.0.1:1080"));
    assert_eq!(scrub_url_credentials("no url here"), "no url here");
}

fn host_with_fixture(temporary: &tempfile::TempDir, configured: bool) -> PluginHost {
    let source = write_package(&temporary.path().join("source"), MANIFEST, configured);
    PluginHost::open(
        temporary.path().join("host"),
        vec![(source, CandidateSource::Development)],
    )
    .unwrap()
}

/// Node starts in milliseconds on an idle machine and in seconds while the rest
/// of the suite is running, so a state that needs a finished handshake is
/// polled instead of asserted on the first read.
fn wait_for_running(host: &PluginHost, id: &str) -> super::PluginView {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let view = host.view_of(id).unwrap();
        if view.state == "running" || std::time::Instant::now() > deadline {
            return view;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn installing_a_plugin_grants_and_starts_it() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);

    let catalog = host.catalog().unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].state, "available");

    let source = temporary.path().join("source");
    let view = host.install(&source).unwrap();
    // No separate enable step: install grants the declared capabilities and
    // starts the process.
    assert!(view.enabled);
    assert_eq!(view.granted, vec!["proxy.provider".to_string()]);
    let view = wait_for_running(&host, "test.fixture-plugin");
    assert_eq!(view.state, "running", "lastError: {:?}", view.last_error);
    assert!(view.methods.contains(&"test.echo".to_string()));

    let echoed = host
        .call(
            "test.fixture-plugin",
            Capability::ProxyProvider,
            "test.echo",
            serde_json::json!({ "value": 7 }),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(echoed["value"], 7);

    // A capability the manifest does not declare stays out of reach even
    // though installation granted everything it asked for.
    let undeclared = host
        .call(
            "test.fixture-plugin",
            Capability::ImageProvider,
            "test.echo",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(undeclared.code(), "PERMISSION_DENIED");

    // A method the plugin never declared cannot be reached either.
    let unknown = host
        .call(
            "test.fixture-plugin",
            Capability::ProxyProvider,
            "proxy.delete",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(unknown.code(), "PERMISSION_DENIED");

    host.shutdown();
}

#[test]
fn an_installed_plugin_reports_its_source_and_can_be_reinstalled() {
    // Rebuilding a plugin at the same version is invisible unless the page can
    // point back at the package it came from, so the catalog carries that path
    // on the installed row and installing again refreshes the copy.
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    let source = temporary.path().join("source");
    host.install(&source).unwrap();

    let catalog = host.catalog().unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(
        catalog[0].source_directory.as_deref(),
        Some(source.to_string_lossy().as_ref())
    );
    assert_eq!(
        wait_for_running(&host, "test.fixture-plugin").state,
        "running"
    );

    // A rebuild keeps the version, so this only succeeds because the install
    // replaces the version directory instead of refusing it.
    let refreshed = host.install(&source).unwrap();
    assert_eq!(refreshed.version, catalog[0].version);
    assert_eq!(
        wait_for_running(&host, "test.fixture-plugin").state,
        "running"
    );

    host.shutdown();
}

#[test]
fn supervisor_restarts_a_plugin_that_exits() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    host.install(&temporary.path().join("source")).unwrap();

    // The fixture kills its own process when asked to crash.
    let _ = host.call(
        "test.fixture-plugin",
        Capability::ProxyProvider,
        "test.crash",
        serde_json::json!({}),
        Duration::from_secs(5),
    );
    let dead = host.view_of("test.fixture-plugin").unwrap();
    assert_eq!(dead.state, "retrying", "lastError: {:?}", dead.last_error);

    // The first retry waits out the base delay before the next pass picks it up.
    std::thread::sleep(Duration::from_millis(700));
    host.supervise_once();

    let revived = host.view_of("test.fixture-plugin").unwrap();
    assert_eq!(
        revived.state, "running",
        "lastError: {:?}",
        revived.last_error
    );
    let echoed = host
        .call(
            "test.fixture-plugin",
            Capability::ProxyProvider,
            "test.echo",
            serde_json::json!({ "value": 1 }),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(echoed["value"], 1);
    host.shutdown();
}

#[test]
fn a_disabled_registry_entry_is_adopted_on_open() {
    let _slot = NodeSlot::acquire();
    // Registries written by a build that still had a manual enable step must
    // not stay inert: opening the host enables and grants them.
    let temporary = tempfile::tempdir().unwrap();
    let source = write_package(&temporary.path().join("source"), MANIFEST, false);
    let candidate = inspect(&source, CandidateSource::Development)
        .unwrap()
        .unwrap();
    let root = temporary.path().join("host");
    let directory = install::install(&candidate, &root).unwrap();
    let store = RegistryStore::new(root.join("registry.json"));
    store
        .save(&super::registry::RegistryDocument {
            schema_version: super::registry::REGISTRY_SCHEMA_VERSION,
            plugins: vec![super::registry::InstalledPlugin {
                id: candidate.manifest.id.clone(),
                version: candidate.manifest.version.clone(),
                manifest: candidate.manifest.clone(),
                directory,
                entry: candidate.entry.clone(),
                manifest_digest: candidate.digest.clone(),
                enabled: false,
                granted_capabilities: Vec::new(),
                granted_domains: Vec::new(),
                installed_at: "0".into(),
            }],
        })
        .unwrap();

    let host = PluginHost::open(root, Vec::new()).unwrap();
    let view = host.view_of("test.fixture-plugin").unwrap();
    assert!(view.enabled);
    assert_eq!(view.granted, vec!["proxy.provider".to_string()]);
    let persisted = store.load().unwrap();
    assert!(persisted.plugins[0].enabled);
    assert_eq!(
        persisted.plugins[0].granted_domains,
        vec!["example.com".to_string()]
    );
    host.shutdown();
}

#[test]
fn host_blocks_launch_when_the_plugin_has_no_proxy() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    host.install(&temporary.path().join("source")).unwrap();

    let blocked = host
        .resolve_proxy("test.fixture-plugin", "window-1", None)
        .unwrap_err();
    assert_eq!(blocked.code(), "NOT_CONFIGURED");
    assert!(blocked.message().contains("窗口启动被阻断"));
    host.shutdown();
}

#[test]
fn host_resolves_a_configured_proxy_handle() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, true);
    host.install(&temporary.path().join("source")).unwrap();

    let reference = host
        .resolve_proxy("test.fixture-plugin", "window-1", None)
        .unwrap();
    assert_eq!(reference.config_handle, "fixture:endpoint:1");
    assert!(reference.secret_ref.is_none());
    host.shutdown();
}

#[test]
fn uninstall_stops_the_process_and_forgets_the_plugin() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    host.install(&temporary.path().join("source")).unwrap();

    host.uninstall("test.fixture-plugin").unwrap();
    // The development source is still discoverable, but nothing is installed.
    let catalog = host.catalog().unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].state, "available");
    assert_eq!(
        host.view_of("test.fixture-plugin").unwrap_err().code(),
        "NOT_CONFIGURED"
    );
}

#[test]
fn workspace_plugin_installs_from_its_built_dist_and_runs() {
    let _slot = NodeSlot::acquire();
    // End-to-end guard for the reported "复制插件文件失败": the real package
    // ships `dist/nexus.plugin.json`, has pnpm symlinks in `node_modules`, and
    // must still install into a self-contained directory that can run.
    let plugins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
    if !plugins.join("proxy-pool/dist/src/index.js").is_file() {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let host = PluginHost::open(
        temporary.path().join("host"),
        vec![(plugins.clone(), CandidateSource::Workspace)],
    )
    .unwrap();

    let installed = host.install(&plugins.join("proxy-pool")).unwrap();
    assert_eq!(installed.id, "studio.proxy-pool");
    let running = wait_for_running(&host, "studio.proxy-pool");
    assert_eq!(
        running.state, "running",
        "lastError: {:?}",
        running.last_error
    );

    let listed = host
        .call(
            "studio.proxy-pool",
            Capability::ProxyProvider,
            "proxy.list",
            serde_json::json!({}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(listed["total"], 0);
    host.shutdown();
}

#[test]
fn workspace_proxy_plugin_completes_a_handshake_and_a_call() {
    let _slot = NodeSlot::acquire();
    let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/proxy-pool/dist/src/index.js");
    if !entry.is_file() {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let manifest = PluginManifest::parse(
        &fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../plugins/proxy-pool/dist/nexus.plugin.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let (process, ready) = PluginProcess::spawn(
        &entry,
        Some(temporary.path()),
        manifest,
        std::path::Path::new("node"),
        "",
    )
    .unwrap();
    assert_eq!(ready.plugin_id, "studio.proxy-pool");
    assert!(ready.methods.contains(&"proxy.list".to_string()));

    let listed = process
        .call(
            Capability::ProxyProvider,
            "proxy.list",
            serde_json::json!({}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(listed["total"], 0);

    let missing = process
        .call(
            Capability::ProxyProvider,
            "proxy.get",
            serde_json::json!({ "id": 999 }),
            Duration::from_secs(10),
        )
        .unwrap_err();
    match missing {
        ProcessError::Plugin(payload) => assert_eq!(payload.code, "INVALID_REQUEST"),
        other => panic!("unexpected error: {other:?}"),
    }
    process.stop();
}

#[test]
fn workspace_address_plugin_installs_enables_and_serves_its_catalog() {
    let _slot = NodeSlot::acquire();
    let plugins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
    if !plugins
        .join("address-generator/dist/src/index.js")
        .is_file()
    {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let host = PluginHost::open(
        temporary.path().join("host"),
        vec![(plugins.clone(), CandidateSource::Workspace)],
    )
    .unwrap();

    let installed = host.install(&plugins.join("address-generator")).unwrap();
    assert_eq!(installed.id, "studio.address-generator");
    assert_eq!(
        installed.state, "running",
        "lastError: {:?}",
        installed.last_error
    );

    // `address.catalog` is served from the plugin's own table, so this stays offline.
    let catalog = host
        .call(
            "studio.address-generator",
            Capability::AddressGenerator,
            "address.catalog",
            serde_json::json!({}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(catalog["countries"].as_array().unwrap().len(), 10);
    assert!(!catalog["cities"].as_array().unwrap().is_empty());

    // The plugin declares only `address.generator`, so a proxy call must be refused.
    assert_eq!(
        host.call(
            "studio.address-generator",
            Capability::ProxyProvider,
            "address.catalog",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err()
        .code(),
        "PERMISSION_DENIED"
    );
    host.shutdown();
}

#[test]
fn workspace_account_plugin_installs_and_binds_a_window() {
    let _slot = NodeSlot::acquire();
    let plugins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
    if !plugins.join("vinted-accounts/dist/src/index.js").is_file() {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let host = PluginHost::open(
        temporary.path().join("host"),
        vec![(plugins.clone(), CandidateSource::Workspace)],
    )
    .unwrap();

    let installed = host.install(&plugins.join("vinted-accounts")).unwrap();
    assert_eq!(installed.id, "studio.vinted-accounts");
    assert_eq!(
        installed.state, "running",
        "lastError: {:?}",
        installed.last_error
    );

    // Everything below is served from the plugin's own store: no network call.
    let saved = host
        .call(
            "studio.vinted-accounts",
            Capability::AccountPool,
            "vinted.accounts.save",
            serde_json::json!({
                "loginMethod": "email",
                "account": "a@b.com",
                "password": "secret",
                "phone": "",
                "emailOtpUrl": "",
                "smsOtpUrl": "",
                "note": "",
                "status": "active",
                "homepageUrl": ""
            }),
            Duration::from_secs(10),
        )
        .unwrap();
    let account_id = saved["item"]["id"].as_str().unwrap().to_string();

    let bound = host
        .call(
            "studio.vinted-accounts",
            Capability::AccountPool,
            "vinted.accounts.bind",
            serde_json::json!({ "accountId": &account_id, "windowId": "win-1" }),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(bound["bound"], true);

    // The same account on a second window is a conflict until it is confirmed.
    let conflict = host
        .call(
            "studio.vinted-accounts",
            Capability::AccountPool,
            "vinted.accounts.bind",
            serde_json::json!({ "accountId": &account_id, "windowId": "win-2" }),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(conflict["bound"], false);
    assert_eq!(conflict["duplicates"][0], "win-1");

    let template = host
        .call(
            "studio.vinted-accounts",
            Capability::AccountPool,
            "vinted.accounts.template",
            serde_json::json!({ "format": "csv" }),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(template["filename"], "vinted-accounts-template.csv");
    assert!(!template["base64"].as_str().unwrap().is_empty());

    // The plugin declares only `account.pool`, so a monitor call must be refused.
    assert_eq!(
        host.call(
            "studio.vinted-accounts",
            Capability::MonitorCollector,
            "vinted.accounts.list",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err()
        .code(),
        "PERMISSION_DENIED"
    );
    host.shutdown();
}

#[test]
fn workspace_supply_plugin_installs_enables_and_lists_favourites() {
    let _slot = NodeSlot::acquire();
    let plugins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
    if !plugins.join("shared-supply/dist/src/index.js").is_file() {
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let host = PluginHost::open(
        temporary.path().join("host"),
        vec![(plugins.clone(), CandidateSource::Workspace)],
    )
    .unwrap();

    let installed = host.install(&plugins.join("shared-supply")).unwrap();
    assert_eq!(installed.id, "studio.shared-supply");
    assert_eq!(
        installed.state, "running",
        "lastError: {:?}",
        installed.last_error
    );

    // Both calls below are served from the plugin itself, so no upstream request
    // is made: the catalogue is a constant table and favourites start empty.
    let catalog = host
        .call(
            "studio.shared-supply",
            Capability::SupplyCatalog,
            "supply.catalog",
            serde_json::json!({}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(catalog["categories"].as_array().unwrap().len(), 10);

    let favorites = host
        .call(
            "studio.shared-supply",
            Capability::SupplyCatalog,
            "supply.favorites.list",
            serde_json::json!({}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(favorites["total"], 0);

    // The plugin declares only `supply.catalog`, so an address call must be refused.
    assert_eq!(
        host.call(
            "studio.shared-supply",
            Capability::AddressGenerator,
            "supply.catalog",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err()
        .code(),
        "PERMISSION_DENIED"
    );
    host.shutdown();
}

/// Builds a `.nexuspkg` the same way `scripts/pack-plugin.mjs` does, minus the
/// encryption: these tests exercise the container, the install and the store,
/// not AES.
fn package_bytes(manifest: &str, entry: &str, files: &[(&str, &str)]) -> Vec<u8> {
    let mut descriptors = Vec::new();
    let mut body: Vec<u8> = Vec::new();
    for (path, data) in files {
        descriptors.push(serde_json::json!({
            "path": path,
            "size": data.len(),
            "sha256": super::registry::digest(data.as_bytes()),
        }));
        body.extend_from_slice(data.as_bytes());
    }
    let header = serde_json::json!({
        "schemaVersion": 1,
        "manifest": serde_json::from_str::<serde_json::Value>(manifest).unwrap(),
        "entry": entry,
        "files": descriptors,
    });
    let header_bytes = serde_json::to_vec(&header).unwrap();
    let mut bytes = b"NXP1".to_vec();
    bytes.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&header_bytes);
    bytes.extend_from_slice(&body);
    bytes
}

fn fixture_package() -> Vec<u8> {
    package_bytes(
        MANIFEST,
        "dist/index.js",
        &[
            ("nexus.plugin.json", MANIFEST),
            ("dist/index.js", PLUGIN_JS),
        ],
    )
}

#[test]
fn package_rejects_paths_that_escape_the_install_directory() {
    for path in [
        "../escape.js",
        "/etc/passwd",
        "a/../../b.js",
        "dist\\index.js",
        "",
    ] {
        assert!(!super::package::safe_relative_path(path), "{path}");
        let bytes = package_bytes(MANIFEST, path, &[(path, "x")]);
        assert_eq!(
            super::package::parse(&bytes).unwrap_err(),
            super::package::PackageError::UnsafePath,
            "{path}"
        );
    }
    assert!(super::package::safe_relative_path("dist/index.js"));
}

#[test]
fn package_rejects_a_corrupted_body() {
    let mut bytes = fixture_package();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    assert_eq!(
        super::package::parse(&bytes).unwrap_err(),
        super::package::PackageError::FileDigestMismatch
    );
    assert_eq!(
        super::package::parse(b"not a package").unwrap_err(),
        super::package::PackageError::BadMagic
    );
}

#[test]
fn package_key_matches_the_packer() {
    // Cross-checked with `deriveKey` in scripts/lib/market-package.mjs: a drift
    // here would make every published package undecryptable.
    assert_eq!(
        super::package::key_for("test.fixture-plugin", "1.2.0"),
        "04038965c0fc9e471a427e59b5c5d3ba934621b5bba6bf982f0ecc1e4027ddbd"
    );
    assert_eq!(
        super::package::key_for("studio.vinted-accounts", "1.0.0"),
        "9ebc6b303e9518817f4f5bd6e6fab1ae1a5fa9b3637e5b754351f40ccb5708d6"
    );
}

#[test]
fn store_url_normalisation_accepts_a_bucket_root() {
    use super::market::normalize_store_url;
    assert_eq!(
        normalize_store_url("https://market.example.com/nexus-studio-market/").unwrap(),
        "https://market.example.com/nexus-studio-market/catalog.json"
    );
    assert_eq!(
        normalize_store_url("https://market.example.com/store/catalog.json").unwrap(),
        "https://market.example.com/store/catalog.json"
    );
    assert_eq!(
        normalize_store_url("market.example.com").unwrap(),
        "https://market.example.com/catalog.json"
    );
    assert_eq!(
        normalize_store_url("file:///tmp/store").unwrap(),
        "file:///tmp/store/catalog.json"
    );
    assert_eq!(
        normalize_store_url("ftp://market.example.com").unwrap_err(),
        super::market::MarketError::UnsupportedUrl
    );
    assert_eq!(
        normalize_store_url("   ").unwrap_err(),
        super::market::MarketError::NotConfigured
    );
}

#[test]
fn catalog_drops_rows_it_cannot_trust() {
    let catalog = serde_json::json!({
        "schemaVersion": 1,
        "generatedAt": "2026-10-23T00:00:00.000Z",
        "plugins": [
            {
                "manifest": serde_json::from_str::<serde_json::Value>(MANIFEST).unwrap(),
                "description": "fixture",
                "package": { "url": "plugins/a.nexuspkg", "size": 10, "sha256": "a".repeat(64) },
            },
            {
                // Unknown capability: the row is skipped, the rest survives.
                "manifest": {
                    "apiVersion": 1,
                    "id": "test.unknown",
                    "version": "1.0.0",
                    "name": "Unknown",
                    "minCoreVersion": "0.1.0",
                    "capabilities": ["teleport.users"],
                    "permissions": { "networkDomains": [], "wantsBrowserAccess": false, "storage": "none", "secrets": [] }
                },
                "package": { "url": "plugins/b.nexuspkg", "size": 10, "sha256": "b".repeat(64) },
            },
            {
                // Truncated checksum: rejected before anything is downloaded.
                "manifest": serde_json::from_str::<serde_json::Value>(MANIFEST).unwrap(),
                "package": { "url": "plugins/c.nexuspkg", "size": 10, "sha256": "short" },
            }
        ]
    });
    let parsed = super::market::Catalog::parse(catalog.to_string().as_bytes()).unwrap();
    assert_eq!(parsed.entries.len(), 1);
    assert_eq!(parsed.entries[0].manifest.id, "test.fixture-plugin");
}

fn file_store(directory: &Path, package: &[u8], version: &str) -> String {
    let plugins = directory.join("plugins/test.fixture-plugin");
    fs::create_dir_all(&plugins).unwrap();
    fs::write(plugins.join(format!("{version}.nexuspkg")), package).unwrap();
    let manifest = MANIFEST.replace("\"1.2.0\"", &format!("\"{version}\""));
    let catalog = serde_json::json!({
        "schemaVersion": 1,
        "plugins": [{
            "manifest": serde_json::from_str::<serde_json::Value>(&manifest).unwrap(),
            "description": "fixture",
            "changelog": "first",
            "package": {
                "url": format!("plugins/test.fixture-plugin/{version}.nexuspkg"),
                "size": package.len(),
                "sha256": super::registry::digest(package),
            }
        }]
    });
    fs::write(
        directory.join("catalog.json"),
        serde_json::to_vec_pretty(&catalog).unwrap(),
    )
    .unwrap();
    format!("file://{}", directory.to_string_lossy())
}

#[test]
fn a_package_installs_from_the_store_and_starts() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let store = temporary.path().join("store");
    fs::create_dir_all(&store).unwrap();
    let url = file_store(&store, &fixture_package(), "1.2.0");
    let host = PluginHost::open(temporary.path().join("host"), Vec::new()).unwrap();

    let status = host.set_store_url(Some(url)).unwrap();
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].state, "install");
    assert!(status.last_error.is_none());

    let view = host.install_from_market("test.fixture-plugin").unwrap();
    assert_eq!(view.version, "1.2.0");
    assert_eq!(view.state, "running", "lastError: {:?}", view.last_error);
    assert!(view.methods.contains(&"test.echo".to_string()));

    let echoed = host
        .call(
            "test.fixture-plugin",
            Capability::ProxyProvider,
            "test.echo",
            serde_json::json!({ "value": 11 }),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(echoed["value"], 11);

    // The store now reports the installed version as current.
    let status = host.market_status().unwrap();
    assert_eq!(status.entries[0].state, "current");
    assert_eq!(
        status.entries[0].installed_version.as_deref(),
        Some("1.2.0")
    );
    host.shutdown();
}

#[test]
fn the_store_refuses_a_package_whose_checksum_does_not_match() {
    let temporary = tempfile::tempdir().unwrap();
    let store = temporary.path().join("store");
    fs::create_dir_all(&store).unwrap();
    let url = file_store(&store, &fixture_package(), "1.2.0");
    // Rewrite the catalog with a checksum that belongs to something else.
    let catalog_path = store.join("catalog.json");
    let mut catalog: serde_json::Value =
        serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
    catalog["plugins"][0]["package"]["sha256"] = serde_json::json!("0".repeat(64));
    fs::write(&catalog_path, serde_json::to_vec(&catalog).unwrap()).unwrap();

    let host = PluginHost::open(temporary.path().join("host"), Vec::new()).unwrap();
    host.set_store_url(Some(url)).unwrap();
    let error = host.install_from_market("test.fixture-plugin").unwrap_err();
    assert_eq!(error.code(), "INVALID_REQUEST");
    assert!(host.catalog().unwrap().is_empty());
    host.shutdown();
}

#[test]
fn a_newer_package_replaces_the_installed_version() {
    let _slot = NodeSlot::acquire();
    let temporary = tempfile::tempdir().unwrap();
    let store = temporary.path().join("store");
    fs::create_dir_all(&store).unwrap();
    let host = PluginHost::open(temporary.path().join("host"), Vec::new()).unwrap();

    host.install_from_package(&fixture_package()).unwrap();
    assert_eq!(
        host.view_of("test.fixture-plugin").unwrap().version,
        "1.2.0"
    );

    let newer = MANIFEST.replace("\"1.2.0\"", "\"1.3.0\"");
    let package = package_bytes(
        &newer,
        "dist/index.js",
        &[("nexus.plugin.json", &newer), ("dist/index.js", PLUGIN_JS)],
    );
    let view = host.install_from_package(&package).unwrap();
    assert_eq!(view.version, "1.3.0");
    assert_eq!(view.state, "running", "lastError: {:?}", view.last_error);

    // Only one version directory survives, and the registry keeps one record.
    let installed = temporary.path().join("host/installed/test.fixture-plugin");
    let versions: Vec<String> = fs::read_dir(&installed)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(versions, vec!["1.3.0".to_string()]);

    // Downgrades are refused instead of silently replacing a newer build.
    let error = host.install_from_package(&fixture_package()).unwrap_err();
    assert_eq!(error.code(), "INVALID_REQUEST");
    host.shutdown();
}

#[test]
fn a_released_build_lists_no_plugins_until_one_is_installed() {
    let temporary = tempfile::tempdir().unwrap();
    let source = write_package(&temporary.path().join("source"), MANIFEST, false);
    let mut host = PluginHost::open(
        temporary.path().join("host"),
        vec![(source, CandidateSource::Development)],
    )
    .unwrap();
    // Debug builds list discovered packages so the workspace stays usable while
    // developing the host; a released build only shows installed plugins.
    host.lists_candidates = false;
    assert!(host.catalog().unwrap().is_empty());
    host.shutdown();
}

/// Serves exactly the two requests an install makes: the catalog, then the
/// package it points at. Used to exercise the HTTP branch without a network.
fn spawn_store(catalog: String, package: Vec<u8>) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let responses = [
            ("/catalog.json", catalog.into_bytes()),
            ("/plugins/test.fixture-plugin/1.2.0.nexuspkg", package),
        ];
        for (path, body) in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buffer = [0u8; 2048];
            let read = stream.read(&mut buffer).unwrap_or(0);
            if !String::from_utf8_lossy(&buffer[..read]).contains(path) {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    format!("http://{address}")
}

#[test]
fn a_package_installs_from_an_http_store() {
    let _slot = NodeSlot::acquire();
    let package = fixture_package();
    let catalog = serde_json::json!({
        "schemaVersion": 1,
        "plugins": [{
            "manifest": serde_json::from_str::<serde_json::Value>(MANIFEST).unwrap(),
            "description": "fixture",
            "package": {
                "url": "plugins/test.fixture-plugin/1.2.0.nexuspkg",
                "size": package.len(),
                "sha256": super::registry::digest(&package),
            }
        }]
    })
    .to_string();
    let base = spawn_store(catalog, package);

    let temporary = tempfile::tempdir().unwrap();
    let host = PluginHost::open(temporary.path().join("host"), Vec::new()).unwrap();
    let status = host.set_store_url(Some(base)).unwrap();
    assert_eq!(
        status
            .catalog_url
            .as_deref()
            .map(|url| url.ends_with("/catalog.json")),
        Some(true)
    );
    assert_eq!(status.entries.len(), 1);

    let view = host.install_from_market("test.fixture-plugin").unwrap();
    assert_eq!(view.state, "running", "lastError: {:?}", view.last_error);
    host.shutdown();
}
