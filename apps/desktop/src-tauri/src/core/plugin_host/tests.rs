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
      methods: ['proxy.resolve', 'proxy.groups.list', 'test.echo'],
      status: { fixture: true },
    })
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

#[test]
fn host_installs_enables_and_calls_a_plugin() {
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);

    let catalog = host.catalog().unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].state, "available");

    let source = temporary.path().join("source");
    let view = host.install(&source).unwrap();
    assert_eq!(view.state, "stopped");
    assert!(view.granted.is_empty());

    // Declared but not granted: the call is refused before the process runs.
    let denied = host
        .call(
            "test.fixture-plugin",
            Capability::ProxyProvider,
            "test.echo",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(denied.code(), "PERMISSION_DENIED");

    let enabled = host
        .enable("test.fixture-plugin", &[Capability::ProxyProvider])
        .unwrap();
    assert!(enabled.enabled);
    assert_eq!(enabled.state, "running");
    assert!(enabled.methods.contains(&"test.echo".to_string()));

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

    // A method the plugin never declared cannot be reached even when the
    // capability is granted.
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
fn host_blocks_launch_when_the_plugin_has_no_proxy() {
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    host.install(&temporary.path().join("source")).unwrap();
    host.enable("test.fixture-plugin", &[Capability::ProxyProvider])
        .unwrap();

    let blocked = host
        .resolve_proxy("test.fixture-plugin", "window-1")
        .unwrap_err();
    assert_eq!(blocked.code(), "NOT_CONFIGURED");
    assert!(blocked.message().contains("窗口启动被阻断"));
    host.shutdown();
}

#[test]
fn host_resolves_a_configured_proxy_handle() {
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, true);
    host.install(&temporary.path().join("source")).unwrap();
    host.enable("test.fixture-plugin", &[Capability::ProxyProvider])
        .unwrap();

    let reference = host
        .resolve_proxy("test.fixture-plugin", "window-1")
        .unwrap();
    assert_eq!(reference.config_handle, "fixture:endpoint:1");
    assert!(reference.secret_ref.is_none());
    host.shutdown();
}

#[test]
fn uninstall_stops_the_process_and_forgets_the_plugin() {
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    host.install(&temporary.path().join("source")).unwrap();
    host.enable("test.fixture-plugin", &[Capability::ProxyProvider])
        .unwrap();

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
fn disabling_a_plugin_stops_its_process() {
    let temporary = tempfile::tempdir().unwrap();
    let host = host_with_fixture(&temporary, false);
    host.install(&temporary.path().join("source")).unwrap();
    host.enable("test.fixture-plugin", &[Capability::ProxyProvider])
        .unwrap();
    let disabled = host.disable("test.fixture-plugin").unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.state, "stopped");
    assert_eq!(
        host.call(
            "test.fixture-plugin",
            Capability::ProxyProvider,
            "test.echo",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err()
        .code(),
        "PERMISSION_DENIED"
    );
}

#[test]
fn workspace_plugin_installs_from_its_built_dist_and_runs() {
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
    assert_eq!(installed.state, "stopped");
    assert!(!installed.enabled);

    let enabled = host
        .enable("studio.proxy-pool", &[Capability::ProxyProvider])
        .unwrap();
    assert_eq!(
        enabled.state, "running",
        "lastError: {:?}",
        enabled.last_error
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
    assert!(!installed.enabled);

    let enabled = host
        .enable("studio.address-generator", &[Capability::AddressGenerator])
        .unwrap();
    assert_eq!(
        enabled.state, "running",
        "lastError: {:?}",
        enabled.last_error
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
