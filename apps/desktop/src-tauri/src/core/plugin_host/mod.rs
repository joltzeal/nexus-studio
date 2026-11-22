pub mod discovery;
pub mod install;
pub mod license;
pub mod manifest;
pub mod market;
pub mod package;
pub mod permissions;
pub mod process;
pub mod registry;

#[cfg(test)]
mod tests;

use self::discovery::{CandidateSource, DiscoveryReport};
use self::install::InstallError;
use self::license::{
    FIRST_PARTY_PLUGIN_IDS, LicenseError, LicenseStatus, LicenseTarget, PluginLicenseStore,
};
use self::manifest::{Capability, ManifestError, PluginManifest, PluginPermissions, StorageScope};
use self::market::{Catalog, MarketBinding, MarketError, MarketStore};
use self::permissions::PermissionError;
use self::process::{
    HostGateway, HostHandlerSlot, HostRequestHandler, NodeLaunchOptions, PluginCaller,
    PluginProcess, ProcessError, ReadyInfo,
};
use self::registry::{InstalledPlugin, RegistryDocument, RegistryError, RegistryStore};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyReference {
    pub config_handle: String,
    pub secret_ref: Option<String>,
}
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const DEFAULT_CALL_DEADLINE: Duration = Duration::from_secs(30);
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(20);
/// How often the supervisor looks for a plugin process that needs starting.
pub const SUPERVISE_INTERVAL: Duration = Duration::from_secs(3);
/// First retry delay after a failed start; doubled on every further failure.
const RETRY_BASE: Duration = Duration::from_millis(500);
const RETRY_CEILING: Duration = Duration::from_secs(30);
/// A process that stayed up this long counts as healthy, so its next crash
/// starts the delay from the base again instead of escalating forever.
const HEALTHY_UPTIME: Duration = Duration::from_secs(30);
/// Delay before the first start so the window paints before the spawn work.
const SUPERVISE_DELAY: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostError {
    Registry,
    NotInstalled,
    Install(InstallError),
    Manifest(ManifestError),
    Permission(PermissionError),
    Process(ProcessError),
    Market(MarketError),
    License(LicenseError),
    WorkspaceSource,
    ReplacementRequired,
    MarketChanged,
    NotFound,
}

impl HostError {
    pub fn code(&self) -> &str {
        match self {
            HostError::Registry => "UNAVAILABLE",
            HostError::NotInstalled | HostError::NotFound => "NOT_CONFIGURED",
            HostError::Install(_) => "INVALID_REQUEST",
            HostError::Manifest(_) => "INVALID_REQUEST",
            HostError::Permission(error) => error.code(),
            HostError::Process(error) => error.code(),
            HostError::Market(error) => error.code(),
            HostError::License(LicenseError::Unavailable | LicenseError::Storage) => "UNAVAILABLE",
            HostError::WorkspaceSource
            | HostError::ReplacementRequired
            | HostError::MarketChanged => "INVALID_REQUEST",
            HostError::License(_) => "PERMISSION_DENIED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            HostError::Registry => "插件登记表损坏或不可读".into(),
            HostError::NotInstalled => "插件未安装".into(),
            HostError::NotFound => "插件不存在".into(),
            HostError::Install(error) => error.message().into(),
            HostError::Manifest(error) => error.message().into(),
            HostError::Permission(error) => error.message().into(),
            HostError::Process(error) => error.message(),
            HostError::Market(error) => error.message(),
            HostError::License(error) => error.message().into(),
            HostError::WorkspaceSource => "工作区源码插件由开发宿主直接加载".into(),
            HostError::ReplacementRequired => "已安装同 ID 的其他来源插件，请先确认替换".into(),
            HostError::MarketChanged => "商店条目或原安装已变更，请刷新后重新操作".into(),
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            HostError::Process(error) => error.retryable(),
            HostError::Registry
            | HostError::Market(MarketError::Offline)
            | HostError::License(LicenseError::Unavailable) => true,
            _ => false,
        }
    }
}

impl From<ProcessError> for HostError {
    fn from(error: ProcessError) -> Self {
        HostError::Process(error)
    }
}

impl From<PermissionError> for HostError {
    fn from(error: PermissionError) -> Self {
        HostError::Permission(error)
    }
}

impl From<InstallError> for HostError {
    fn from(error: InstallError) -> Self {
        HostError::Install(error)
    }
}

impl From<ManifestError> for HostError {
    fn from(error: ManifestError) -> Self {
        HostError::Manifest(error)
    }
}

impl From<MarketError> for HostError {
    fn from(error: MarketError) -> Self {
        HostError::Market(error)
    }
}

/// Ephemeral browser launch input. Only `reference` belongs in the scheduler;
/// the credentialed URL must stay out of saved records, views and diagnostics.
pub struct ResolvedBrowserProxy {
    pub reference: ProxyReference,
    pub connection_url: String,
}

impl std::fmt::Debug for ResolvedBrowserProxy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedBrowserProxy")
            .field("reference", &self.reference)
            .field("connection_url", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub min_core_version: String,
    pub capabilities: Vec<String>,
    pub granted: Vec<String>,
    pub permissions: PluginPermissions,
    pub source: String,
    /// available | stopped | running | failed
    pub state: String,
    pub enabled: bool,
    pub methods: Vec<String>,
    pub status: Value,
    pub last_error: Option<String>,
    pub storage_durable: bool,
    /// Declared slot names. The plugin owns the values; the host never reads them.
    pub secret_slots: Vec<String>,
    /// The directory this plugin can be installed from: a package that is not
    /// installed yet, or the development copy an installed one is refreshed
    /// from. `None` when nothing on disk can supply it.
    pub source_directory: Option<String>,
    pub ui: Option<manifest::PluginUi>,
    pub installation: String,
    pub runtime_generation: Option<String>,
    pub license_required: bool,
}

/// One row of the configured store. `state` is derived by comparing the
/// published version and origin with what is installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntryView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub min_core_version: String,
    pub description: String,
    pub changelog: String,
    pub capabilities: Vec<String>,
    pub installed_version: Option<String>,
    pub state: String,
    pub size: u64,
    pub checksum: String,
    pub selection: String,
    pub license_status: Option<LicenseStatus>,
    pub replaces_installation: Option<String>,
    pub installed_catalog_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStatusView {
    pub store_url: Option<String>,
    pub catalog_url: Option<String>,
    pub last_checked_at: Option<String>,
    pub last_error: Option<String>,
    pub entries: Vec<MarketEntryView>,
}

pub struct PluginHost {
    root: PathBuf,
    node: PathBuf,
    store: RegistryStore,
    registry: Mutex<RegistryDocument>,
    processes: Mutex<HashMap<String, Arc<PluginProcess>>>,
    process_start: Mutex<()>,
    host_handler: HostHandlerSlot,
    closing: AtomicBool,
    attempts: Mutex<HashMap<String, Attempt>>,
    supervisor: Mutex<Option<Supervisor>>,
    dev_roots: Vec<(PathBuf, CandidateSource)>,
    /// Uninstalled packages are only listed while developing the host. A
    /// released build shows what is installed plus whatever the store offers.
    lists_candidates: bool,
    market_store: MarketStore,
    market: Mutex<Catalog>,
    market_operation: Mutex<()>,
    market_watch: Mutex<Option<Supervisor>>,
    network: Option<(crate::core::network_proxy::NetworkProxyStore, PathBuf)>,
    license: PluginLicenseStore,
    workspace_plugins: Mutex<HashMap<String, InstalledPlugin>>,
    source_loader: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceManifestInventory {
    plugins: Vec<WorkspaceManifestEntry>,
    problems: Vec<WorkspaceManifestProblem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceManifestEntry {
    directory: PathBuf,
    entry: PathBuf,
    manifest: PluginManifest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceManifestProblem {
    directory: PathBuf,
    message: String,
}

/// Start/retry bookkeeping for one plugin.
#[derive(Debug, Clone, Default)]
struct Attempt {
    failures: u32,
    /// `None` means the plugin may be started on the next pass.
    next_at: Option<Instant>,
    started_at: Option<Instant>,
}

impl Attempt {
    fn delay(&self) -> Duration {
        let exponent = self.failures.saturating_sub(1).min(8);
        let scaled = RETRY_BASE.saturating_mul(1u32 << exponent);
        scaled.min(RETRY_CEILING)
    }
}

struct Supervisor {
    running: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

impl PluginHost {
    pub fn open(
        root: PathBuf,
        dev_roots: Vec<(PathBuf, CandidateSource)>,
    ) -> Result<Self, HostError> {
        Self::open_with_node(root, dev_roots, PathBuf::from("node"))
    }

    pub fn open_with_node(
        root: PathBuf,
        dev_roots: Vec<(PathBuf, CandidateSource)>,
        node: PathBuf,
    ) -> Result<Self, HostError> {
        let license_path =
            crate::core::workspace_paths::database_path(root.parent().unwrap_or(&root));
        let license = PluginLicenseStore::new(license_path).map_err(HostError::License)?;
        let store = RegistryStore::new(root.join("registry.json"));
        let document = store.load().map_err(|error| match error {
            RegistryError::Corrupt | RegistryError::Io => HostError::Registry,
        })?;
        let market_store = MarketStore::new(&root);
        let host = Self {
            market_store,
            market: Mutex::new(Catalog::default()),
            market_operation: Mutex::new(()),
            market_watch: Mutex::new(None),
            network: None,
            license,
            lists_candidates: cfg!(debug_assertions),
            root,
            node,
            store,
            registry: Mutex::new(document),
            processes: Mutex::new(HashMap::new()),
            process_start: Mutex::new(()),
            host_handler: Arc::new(Mutex::new(None)),
            closing: AtomicBool::new(false),
            attempts: Mutex::new(HashMap::new()),
            supervisor: Mutex::new(None),
            dev_roots,
            workspace_plugins: Mutex::new(HashMap::new()),
            source_loader: None,
        };
        Ok(host)
    }

    /// Adds unbuilt TypeScript workspace plugins to this debug host. The
    /// source records stay in memory and never enter the installed registry.
    pub fn with_workspace_source(mut self, plugin_root: PathBuf, source_loader: PathBuf) -> Self {
        if !cfg!(debug_assertions) || !plugin_root.is_dir() {
            return self;
        }
        let plugin_root = plugin_root.canonicalize().unwrap_or(plugin_root);
        let source_loader_url = match url::Url::from_file_path(&source_loader) {
            Ok(url) => url,
            Err(_) => {
                eprintln!("Could not resolve workspace plugin loader path");
                return self;
            }
        };

        let manifest_loader =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/plugin-source-manifests.mjs");
        let output = match Command::new(&self.node)
            .args(["--conditions=development", "--import"])
            .arg(source_loader_url.as_str())
            .arg(&manifest_loader)
            .arg(&plugin_root)
            .output()
        {
            Ok(output) => output,
            Err(error) => {
                eprintln!("Could not start workspace plugin discovery: {error}");
                return self;
            }
        };
        if !output.status.success() {
            eprintln!(
                "Could not inspect workspace plugin sources: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return self;
        }
        let inventory: WorkspaceManifestInventory = match serde_json::from_slice(&output.stdout) {
            Ok(inventory) => inventory,
            Err(_) => {
                eprintln!("Workspace plugin discovery returned an invalid response");
                return self;
            }
        };
        let mut plugins = HashMap::new();
        for problem in inventory.problems {
            eprintln!(
                "Could not load workspace plugin at {}: {}",
                problem.directory.display(),
                problem.message
            );
        }
        for entry in inventory.plugins {
            let Ok(relative_entry) = entry.entry.strip_prefix(&entry.directory) else {
                eprintln!("Workspace plugin entry escaped its package directory");
                continue;
            };
            if !entry.directory.starts_with(&plugin_root)
                || relative_entry
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
                || !entry.entry.is_file()
                || entry.manifest.validate().is_err()
            {
                eprintln!(
                    "Skipped invalid workspace plugin source at {}",
                    entry.directory.display()
                );
                continue;
            }
            let Ok(manifest_bytes) = serde_json::to_vec(&entry.manifest) else {
                continue;
            };
            let id = entry.manifest.id.clone();
            let plugin = InstalledPlugin {
                id: id.clone(),
                version: entry.manifest.version.clone(),
                granted_capabilities: entry.manifest.capabilities.clone(),
                granted_domains: entry.manifest.permissions.network_domains.clone(),
                manifest: entry.manifest,
                directory: entry.directory,
                entry: relative_entry.to_string_lossy().into_owned(),
                manifest_digest: registry::digest(&manifest_bytes),
                enabled: true,
                installed_at: "workspace-source".into(),
                market: None,
            };
            if plugins.contains_key(&id) {
                eprintln!("Skipped duplicate workspace plugin id {id}");
                continue;
            }
            plugins.insert(id, plugin);
        }
        self.workspace_plugins = Mutex::new(plugins);
        self.source_loader = Some(source_loader);
        self
    }

    pub fn with_network(
        mut self,
        store: crate::core::network_proxy::NetworkProxyStore,
        preload: PathBuf,
    ) -> Self {
        self.network = Some((store, preload));
        self
    }

    pub fn restart_for_network_change(&self) {
        let Ok(lifecycle) = self.process_start.lock() else {
            return;
        };
        let ids: Vec<String> = self
            .processes
            .lock()
            .map(|processes| processes.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.stop(&id);
            self.forget_attempt(&id);
        }
        drop(lifecycle);
        self.supervise_once();
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    #[cfg(test)]
    pub(crate) fn seed_test_license(&self, plugin_id: &str) {
        self.license.seed_test_license(plugin_id).unwrap();
    }

    pub fn license_statuses(
        &self,
    ) -> Result<std::collections::BTreeMap<String, LicenseStatus>, HostError> {
        let installed = self.snapshot()?;
        let mut statuses = std::collections::BTreeMap::new();
        for plugin in &installed.plugins {
            if let Some(target) = LicenseTarget::for_plugin(&plugin.id, plugin.market.as_ref()) {
                statuses.insert(
                    plugin.id.clone(),
                    self.license.status(target).map_err(HostError::License)?,
                );
            }
        }
        for &id in FIRST_PARTY_PLUGIN_IDS {
            if !installed.plugins.iter().any(|plugin| plugin.id == id)
                && let Some(target) = LicenseTarget::for_plugin(id, None)
            {
                statuses.insert(
                    id.into(),
                    self.license.status(target).map_err(HostError::License)?,
                );
            }
        }
        Ok(statuses)
    }

    pub fn activate_license(
        &self,
        plugin_id: &str,
        card: &str,
        market_selection: Option<&str>,
        installed_selection: Option<&str>,
    ) -> Result<LicenseStatus, HostError> {
        let binding = match market_selection {
            Some(selection) => {
                let (catalog, entry) = self.selected_market_entry(plugin_id, Some(selection))?;
                Some(catalog.binding(&entry))
            }
            None => match installed_selection {
                Some(selection) => {
                    let plugin = self.find(plugin_id)?;
                    if installation_generation(&plugin) != selection {
                        return Err(HostError::MarketChanged);
                    }
                    plugin.market
                }
                None => self.installed_market(plugin_id)?,
            },
        };
        let target =
            LicenseTarget::for_plugin(plugin_id, binding.as_ref()).ok_or(HostError::NotFound)?;
        let status = self
            .license
            .activate(target, card, self.network.as_ref().map(|(store, _)| store))
            .map_err(HostError::License)?;
        if market_selection.is_none() || binding == self.installed_market(plugin_id)? {
            let _ = self.ensure_started(plugin_id);
        }
        Ok(status)
    }

    fn installed_market(&self, id: &str) -> Result<Option<MarketBinding>, HostError> {
        let registry = self.registry.lock().map_err(|_| HostError::Registry)?;
        Ok(registry
            .plugins
            .iter()
            .find(|plugin| plugin.id == id)
            .and_then(|plugin| plugin.market.clone()))
    }

    fn require_source_license(
        &self,
        id: &str,
        binding: Option<&MarketBinding>,
    ) -> Result<(), HostError> {
        if let Some(target) = LicenseTarget::for_plugin(id, binding) {
            self.license
                .require_for(target, self.network.as_ref().map(|(store, _)| store))
                .map_err(HostError::License)?;
        }
        Ok(())
    }

    fn require_local_license(&self, id: &str) -> Result<(), HostError> {
        if self.workspace_plugin(id).is_some() {
            return Ok(());
        }
        let binding = self.installed_market(id)?;
        self.require_local_source_license(id, binding.as_ref())
    }

    fn require_local_source_license(
        &self,
        id: &str,
        binding: Option<&MarketBinding>,
    ) -> Result<(), HostError> {
        if let Some(target) = LicenseTarget::for_plugin(id, binding) {
            self.license
                .require_local(target)
                .map_err(HostError::License)?;
        }
        Ok(())
    }

    pub fn register_host_handler(&self, handler: Arc<HostRequestHandler>) -> Result<(), HostError> {
        *self.host_handler.lock().map_err(|_| HostError::Registry)? = Some(handler);
        Ok(())
    }

    pub fn validate_agent_caller(&self, caller: &PluginCaller) -> Result<(), HostError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(ProcessError::Cancelled.into());
        }
        self.require_local_license(&caller.plugin_id)?;
        let plugin = self.find(&caller.plugin_id)?;
        permissions::check_agent_gateway(&plugin)?;
        let current = self
            .processes
            .lock()
            .map_err(|_| HostError::Registry)?
            .get(&caller.plugin_id)
            .cloned()
            .ok_or(PermissionError::StaleGeneration)?;
        if current.caller() != caller
            || caller.installation != installation_generation(&plugin)
            || current.failure().is_some()
            || !current.is_alive()
        {
            return Err(PermissionError::StaleGeneration.into());
        }
        Ok(())
    }

    pub fn agent_caller(&self) -> Result<PluginCaller, HostError> {
        let plugin = self.find("studio.sales-agent")?;
        permissions::check_agent_gateway(&plugin)?;
        let process = self.ensure_started(&plugin.id)?;
        Ok(process.caller().clone())
    }

    pub fn call_agent_generation(
        &self,
        caller: &PluginCaller,
        method: &str,
        payload: Value,
        deadline: Duration,
    ) -> Result<Value, HostError> {
        self.validate_agent_caller(caller)?;
        let plugin = self.find(&caller.plugin_id)?;
        let process = self
            .processes
            .lock()
            .map_err(|_| HostError::Registry)?
            .get(&caller.plugin_id)
            .cloned()
            .ok_or(PermissionError::StaleGeneration)?;
        if process.caller() != caller {
            return Err(PermissionError::StaleGeneration.into());
        }
        let ready = process.ready().ok_or(ProcessError::NotReady)?;
        permissions::check_call(&plugin, &ready, Capability::SalesAgent, method)?;
        process
            .call(Capability::SalesAgent, method, payload, deadline)
            .map_err(HostError::Process)
    }

    fn snapshot(&self) -> Result<RegistryDocument, HostError> {
        self.registry
            .lock()
            .map(|document| document.clone())
            .map_err(|_| HostError::Registry)
    }

    fn persist(&self, document: &RegistryDocument) -> Result<(), HostError> {
        self.store.save(document).map_err(|_| HostError::Registry)
    }

    fn find(&self, id: &str) -> Result<InstalledPlugin, HostError> {
        if let Some(plugin) = self.workspace_plugin(id) {
            return Ok(plugin);
        }
        self.snapshot()?
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == id)
            .ok_or(HostError::NotInstalled)
    }

    fn workspace_plugin(&self, id: &str) -> Option<InstalledPlugin> {
        self.workspace_plugins
            .lock()
            .ok()
            .and_then(|plugins| plugins.get(id).cloned())
    }

    fn workspace_snapshot(&self) -> HashMap<String, InstalledPlugin> {
        self.workspace_plugins
            .lock()
            .map(|plugins| plugins.clone())
            .unwrap_or_default()
    }

    fn all_plugins(&self) -> Result<Vec<InstalledPlugin>, HostError> {
        let workspace = self.workspace_snapshot();
        let mut plugins = self.snapshot()?.plugins;
        plugins.retain(|plugin| !workspace.contains_key(&plugin.id));
        plugins.extend(workspace.into_values());
        Ok(plugins)
    }

    pub fn discover(&self) -> DiscoveryReport {
        let mut roots = vec![(self.root.join("installed"), CandidateSource::Installed)];
        roots.extend(self.dev_roots.iter().cloned());
        discovery::scan_roots(&roots)
    }

    pub fn catalog(&self) -> Result<Vec<PluginView>, HostError> {
        let document = self.snapshot()?;
        // A package sitting in a development root is also the source an
        // installed copy can be refreshed from, so its path is reported on the
        // installed row: without it a stale build has no way back.
        let candidates = if self.lists_candidates {
            self.discover().candidates
        } else {
            Vec::new()
        };
        let workspace = self.workspace_snapshot();
        let mut views: Vec<PluginView> = Vec::new();
        for plugin in &document.plugins {
            if workspace.contains_key(&plugin.id) {
                continue;
            }
            let mut view = self.view(plugin);
            view.source_directory = candidates
                .iter()
                .find(|candidate| plugin.market.is_none() && candidate.manifest.id == plugin.id)
                .map(|candidate| candidate.directory.to_string_lossy().into_owned());
            views.push(view);
        }
        for plugin in workspace.values() {
            views.push(self.view(plugin));
        }
        // A shipped build starts with an empty plugin list: what is installed
        // plus what the store offers. Listing packages that merely sit next to
        // the binary made the app look like it came with plugins.
        for candidate in candidates {
            if workspace.contains_key(&candidate.manifest.id)
                || document
                    .plugins
                    .iter()
                    .any(|plugin| plugin.id == candidate.manifest.id)
            {
                continue;
            }
            views.push(PluginView {
                id: candidate.manifest.id.clone(),
                name: candidate.manifest.name.clone(),
                version: candidate.manifest.version.clone(),
                api_version: candidate.manifest.api_version,
                min_core_version: candidate.manifest.min_core_version.clone(),
                capabilities: capability_names(&candidate.manifest),
                granted: Vec::new(),
                permissions: candidate.manifest.permissions.clone(),
                source: source_name(candidate.source).to_string(),
                state: "available".into(),
                enabled: false,
                methods: Vec::new(),
                status: Value::Null,
                last_error: None,
                storage_durable: false,
                secret_slots: Vec::new(),
                source_directory: Some(candidate.directory.to_string_lossy().into_owned()),
                ui: candidate.manifest.ui.clone(),
                installation: candidate.digest.clone(),
                runtime_generation: None,
                license_required: LicenseTarget::for_plugin(&candidate.manifest.id, None).is_some(),
            });
        }
        views.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(views)
    }

    pub fn view_of(&self, id: &str) -> Result<PluginView, HostError> {
        let plugin = self.find(id)?;
        Ok(self.view(&plugin))
    }

    fn failures_of(&self, id: &str) -> u32 {
        self.attempts
            .lock()
            .ok()
            .and_then(|attempts| attempts.get(id).map(|attempt| attempt.failures))
            .unwrap_or(0)
    }

    fn view(&self, plugin: &InstalledPlugin) -> PluginView {
        let workspace_source = self.workspace_plugin(&plugin.id).is_some();
        let target = (!workspace_source)
            .then(|| LicenseTarget::for_plugin(&plugin.id, plugin.market.as_ref()))
            .flatten();
        let license_error = target.and_then(|target| {
            self.license
                .status(target)
                .ok()
                .filter(|status| status.state == "active")
                .is_none()
                .then_some("插件尚未激活或需要联网核验".to_string())
        });
        let process = self
            .processes
            .lock()
            .ok()
            .and_then(|processes| processes.get(&plugin.id).cloned());
        let ready = process.as_ref().and_then(|process| process.ready());
        let healthy = process
            .as_ref()
            .is_some_and(|process| process.failure().is_none() && process.is_alive());
        let running = healthy && ready.is_some();
        let failures = self.failures_of(&plugin.id);
        // A plugin the host owns is never reported as failed: the supervisor
        // keeps restarting it, so the honest states are running, starting and
        // retrying. The reason stays available for the manifest dialog.
        let state = if license_error.is_some() {
            "unlicensed"
        } else if running {
            "running"
        } else if process.is_some() || failures > 0 {
            // A process entry that is not usable means it died or misbehaved.
            "retrying"
        } else {
            "starting"
        };
        let last_error = if let Some(reason) = license_error {
            Some(reason)
        } else if running {
            None
        } else if let Some(reason) = process.as_ref().and_then(|process| process.failure()) {
            Some(reason)
        } else if failures > 0 {
            Some(format!("已连续失败 {failures} 次，后台继续重试"))
        } else {
            None
        };
        PluginView {
            id: plugin.id.clone(),
            name: plugin.manifest.name.clone(),
            version: plugin.version.clone(),
            api_version: plugin.manifest.api_version,
            min_core_version: plugin.manifest.min_core_version.clone(),
            capabilities: capability_names(&plugin.manifest),
            granted: plugin
                .granted_capabilities
                .iter()
                .map(|capability| capability.as_str().to_string())
                .collect(),
            permissions: plugin.manifest.permissions.clone(),
            source: if workspace_source {
                "workspace".into()
            } else {
                "installed".into()
            },
            state: state.into(),
            enabled: plugin.enabled,
            methods: ready
                .as_ref()
                .map(|ready| ready.methods.clone())
                .unwrap_or_default(),
            status: ready.map(|ready| ready.status).unwrap_or(Value::Null),
            last_error,
            storage_durable: plugin.manifest.permissions.storage == StorageScope::Private,
            secret_slots: plugin.manifest.permissions.secrets.clone(),
            source_directory: workspace_source
                .then(|| plugin.directory.to_string_lossy().into_owned()),
            ui: plugin.manifest.ui.clone(),
            installation: installation_generation(plugin),
            runtime_generation: process
                .as_ref()
                .map(|process| process.caller().generation.clone()),
            license_required: target.is_some(),
        }
    }

    pub fn install(&self, source: &Path) -> Result<PluginView, HostError> {
        let candidate = discovery::inspect(source, CandidateSource::Development)
            .ok()
            .flatten()
            .ok_or(HostError::NotFound)?;
        if self.workspace_plugin(&candidate.manifest.id).is_some() {
            return Err(HostError::WorkspaceSource);
        }
        self.require_source_license(&candidate.manifest.id, None)?;
        let installation = self.process_start.lock().map_err(|_| HostError::Registry)?;
        self.require_local_source_license(&candidate.manifest.id, None)?;
        let existing = self
            .snapshot()?
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == candidate.manifest.id);
        if let Some(plugin) = &existing {
            if plugin.market.is_some() {
                return Err(HostError::ReplacementRequired);
            }
            // Reinstalling the same version is how a package built from a
            // directory picks up new code; a lower version is still refused.
            if matches!(
                market::compare_versions(&candidate.manifest.version, &plugin.version),
                Some(std::cmp::Ordering::Less)
            ) {
                return Err(HostError::Install(InstallError::Downgrade));
            }
            // The running process holds the old entry file open on Windows, so
            // it has to stop before the version directory is replaced.
            self.stop(&plugin.id);
            self.forget_attempt(&plugin.id);
        }
        let directory = if existing.is_some() {
            install::reinstall(&candidate, &self.root)?
        } else {
            install::install(&candidate, &self.root)?
        };
        let record = InstalledPlugin {
            id: candidate.manifest.id.clone(),
            version: candidate.manifest.version.clone(),
            manifest: candidate.manifest.clone(),
            directory,
            entry: candidate.entry.clone(),
            manifest_digest: candidate.digest.clone(),
            // Installing is the only decision: the plugin is enabled and holds
            // the whole grant its manifest declares.
            enabled: true,
            granted_capabilities: candidate.manifest.capabilities.clone(),
            granted_domains: candidate.manifest.permissions.network_domains.clone(),
            installed_at: timestamp(),
            market: None,
        };
        let mut document = self.snapshot()?;
        document.plugins.retain(|plugin| plugin.id != record.id);
        document.plugins.push(record.clone());
        self.persist(&document)?;
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        if let Some(previous) = existing
            && previous.version != record.version
        {
            let _ = install::uninstall(&self.root, &previous.id, &previous.version);
        }
        drop(installation);
        // Start right away so the page that installs a plugin can use it. A
        // start failure is not fatal: the supervisor retries with backoff.
        let _ = self.ensure_started(&record.id);
        self.view_of(&record.id)
    }

    pub fn uninstall(&self, id: &str) -> Result<(), HostError> {
        let _installation = self.process_start.lock().map_err(|_| HostError::Registry)?;
        if self.workspace_plugin(id).is_some() {
            return Err(HostError::WorkspaceSource);
        }
        let plugin = self.find(id)?;
        self.stop(id);
        self.forget_attempt(id);
        install::remove_version_directory(&self.root, &plugin.id, &plugin.directory)?;
        let mut document = self.snapshot()?;
        document.plugins.retain(|entry| entry.id != id);
        self.persist(&document)?;
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        Ok(())
    }

    /// Installs a `.nexuspkg` that was already downloaded and checksummed.
    /// Installing a higher version replaces the record in place and starts the
    /// new process; the previous version directory is removed afterwards.
    #[cfg(test)]
    pub fn install_from_package(&self, bytes: &[u8]) -> Result<PluginView, HostError> {
        let contents = package::parse(bytes)
            .map_err(|error| HostError::Install(InstallError::Package(error)))?;
        self.install_package(contents, None, None)
    }

    fn install_package(
        &self,
        contents: package::PackageContents,
        binding: Option<MarketBinding>,
        replacement: Option<&str>,
    ) -> Result<PluginView, HostError> {
        let manifest = contents.manifest.clone();
        if self.workspace_plugin(&manifest.id).is_some() {
            return Err(HostError::WorkspaceSource);
        }
        self.require_source_license(&manifest.id, binding.as_ref())?;
        let installation = self.process_start.lock().map_err(|_| HostError::Registry)?;
        self.require_local_source_license(&manifest.id, binding.as_ref())?;
        let mut document = self.snapshot()?;
        let existing = document
            .plugins
            .iter()
            .find(|plugin| plugin.id == manifest.id)
            .cloned();
        let replaces = existing
            .as_ref()
            .filter(|plugin| !same_install_source(plugin, binding.as_ref()));
        match (replaces, replacement) {
            (Some(_), None) => return Err(HostError::ReplacementRequired),
            (Some(plugin), Some(expected)) if installation_generation(plugin) == expected => {}
            (_, Some(_)) => return Err(HostError::MarketChanged),
            (None, None) => {}
        }
        if let Some(plugin) = &existing
            && replaces.is_none()
            && matches!(
                market::compare_versions(&manifest.version, &plugin.version),
                Some(std::cmp::Ordering::Less)
            )
        {
            return Err(HostError::Install(InstallError::Downgrade));
        }

        // A market installation must leave the current files intact until the
        // new registry record has been saved, including same-version replacements.
        let directory_version = if binding.is_some() {
            format!("{}-{}", manifest.version, uuid::Uuid::new_v4())
        } else {
            if let Some(plugin) = &existing {
                self.stop(&plugin.id);
                self.forget_attempt(&plugin.id);
            }
            manifest.version.clone()
        };
        let directory = install::write_version(
            &self.root,
            &manifest.id,
            &directory_version,
            &contents.files,
        )?;
        let manifest_bytes = contents
            .read("nexus.plugin.json")
            .map(<[u8]>::to_vec)
            .unwrap_or_else(|| serde_json::to_vec(&manifest).unwrap_or_default());
        let record = InstalledPlugin {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            manifest: manifest.clone(),
            directory,
            entry: contents.entry.clone(),
            manifest_digest: registry::digest(&manifest_bytes),
            enabled: true,
            granted_capabilities: manifest.capabilities.clone(),
            granted_domains: manifest.permissions.network_domains.clone(),
            installed_at: timestamp(),
            market: binding,
        };
        document.plugins.retain(|plugin| plugin.id != record.id);
        document.plugins.push(record.clone());
        if let Err(error) = self.persist(&document) {
            if record.market.is_some() {
                let _ =
                    install::remove_version_directory(&self.root, &record.id, &record.directory);
            }
            return Err(error);
        }
        self.stop(&record.id);
        self.forget_attempt(&record.id);
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        if let Some(previous) = existing
            && previous.directory != record.directory
        {
            let _ =
                install::remove_version_directory(&self.root, &previous.id, &previous.directory);
        }
        drop(installation);
        let _ = self.ensure_started(&record.id);
        self.view_of(&record.id)
    }

    pub fn market_status(&self) -> Result<MarketStatusView, HostError> {
        let settings = self.market_store.load();
        let mut catalog = self
            .market
            .lock()
            .map(|catalog| catalog.clone())
            .unwrap_or_default();
        if settings.store_url.as_deref() != Some(catalog.source_url.as_str()) {
            catalog = Catalog::default();
        }
        let document = self.snapshot()?;
        let workspace = self.workspace_snapshot();
        let mut entries: Vec<MarketEntryView> = catalog
            .entries
            .iter()
            .map(|entry| -> Result<MarketEntryView, HostError> {
                let binding = catalog.binding(entry);
                let is_workspace = workspace.contains_key(&entry.manifest.id);
                let installed = workspace.get(&entry.manifest.id).or_else(|| {
                    document
                        .plugins
                        .iter()
                        .find(|plugin| plugin.id == entry.manifest.id)
                });
                let replaces = installed
                    .filter(|plugin| !is_workspace && !same_install_source(plugin, Some(&binding)));
                let state = match installed {
                    None => "install",
                    Some(_) if replaces.is_some() => "replace",
                    Some(plugin) => {
                        match market::compare_versions(&plugin.version, &entry.manifest.version) {
                            Some(std::cmp::Ordering::Less) => "update",
                            _ => "current",
                        }
                    }
                };
                let license_status = LicenseTarget::for_plugin(&entry.manifest.id, Some(&binding))
                    .filter(|_| !is_workspace)
                    .map(|target| self.license.status(target))
                    .transpose()
                    .map_err(HostError::License)?;
                Ok(MarketEntryView {
                    id: entry.manifest.id.clone(),
                    name: entry.manifest.name.clone(),
                    version: entry.manifest.version.clone(),
                    api_version: entry.manifest.api_version,
                    min_core_version: entry.manifest.min_core_version.clone(),
                    description: entry.description.clone(),
                    changelog: entry.changelog.clone(),
                    capabilities: capability_names(&entry.manifest),
                    installed_version: installed.map(|plugin| plugin.version.clone()),
                    state: state.into(),
                    size: entry.package.size,
                    checksum: entry.package.sha256.clone(),
                    selection: catalog.selection(entry),
                    license_status,
                    replaces_installation: replaces.map(installation_generation),
                    installed_catalog_url: installed.and_then(|plugin| {
                        plugin
                            .market
                            .as_ref()
                            .map(|market| market.catalog_url.clone())
                    }),
                })
            })
            .collect::<Result<_, _>>()?;
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(MarketStatusView {
            catalog_url: settings
                .store_url
                .as_deref()
                .and_then(|url| market::normalize_store_url(url).ok()),
            store_url: settings.store_url,
            last_checked_at: settings.last_checked_at,
            last_error: settings.last_error,
            entries,
        })
    }

    /// Stores the URL and refreshes once so the page shows the result of the
    /// address it just saved. An empty value clears the store.
    pub fn set_store_url(&self, url: Option<String>) -> Result<MarketStatusView, HostError> {
        let _operation = self
            .market_operation
            .lock()
            .map_err(|_| HostError::Registry)?;
        let mut settings = self.market_store.load_checked()?;
        match url {
            Some(value) if !value.trim().is_empty() => {
                let normalized = market::normalize_store_url(&value)?;
                settings.store_url = Some(normalized);
                settings.last_checked_at = None;
                settings.last_error = None;
                self.market_store.save(&settings)?;
                self.refresh_market_inner()
            }
            _ => {
                settings.store_url = None;
                settings.last_checked_at = None;
                settings.last_error = None;
                self.market_store.save(&settings)?;
                if let Ok(mut catalog) = self.market.lock() {
                    *catalog = Catalog::default();
                }
                self.market_status()
            }
        }
    }

    pub fn refresh_market(&self) -> Result<MarketStatusView, HostError> {
        let _operation = self
            .market_operation
            .lock()
            .map_err(|_| HostError::Registry)?;
        self.refresh_market_inner()
    }

    fn refresh_market_inner(&self) -> Result<MarketStatusView, HostError> {
        let mut settings = self.market_store.load_checked()?;
        let Some(store_url) = settings.store_url.clone() else {
            return Err(HostError::Market(MarketError::NotConfigured));
        };
        let catalog_url = market::normalize_store_url(&store_url)?;
        let proxy = self
            .network
            .as_ref()
            .map(|(store, _)| store.get())
            .transpose()
            .map_err(|error| HostError::Market(MarketError::Proxy(error)))?
            .unwrap_or_default();
        let fetched = market::fetch_catalog(&catalog_url, &proxy).and_then(|bytes| {
            Catalog::parse(
                &bytes,
                &catalog_url,
                settings.signing_pins.get(&catalog_url).map(String::as_str),
            )
        });
        match fetched {
            Ok(catalog) => {
                if let Some(pin) = &catalog.signing_pin {
                    settings.signing_pins.insert(catalog_url, pin.clone());
                }
                settings.last_checked_at = Some(market::now_timestamp());
                settings.last_error = None;
                self.market_store.save(&settings)?;
                *self.market.lock().map_err(|_| HostError::Registry)? = catalog;
                self.market_status()
            }
            Err(error) => {
                settings.last_error = Some(error.message());
                let _ = self.market_store.save(&settings);
                Err(HostError::Market(error))
            }
        }
    }

    fn selected_market_entry(
        &self,
        id: &str,
        selection: Option<&str>,
    ) -> Result<(Catalog, market::Entry), HostError> {
        let read = || -> Result<Option<(Catalog, market::Entry)>, HostError> {
            let settings = self.market_store.load_checked()?;
            let catalog = self.market.lock().map_err(|_| HostError::Registry)?;
            if settings.store_url.as_deref() != Some(catalog.source_url.as_str()) {
                return Ok(None);
            }
            let Some(entry) = catalog.find(id) else {
                return Ok(None);
            };
            if selection.is_some_and(|selected| selected != catalog.selection(entry)) {
                return Err(HostError::MarketChanged);
            }
            Ok(Some((catalog.clone(), entry.clone())))
        };
        if let Some(selected) = read()? {
            return Ok(selected);
        }
        if selection.is_some() {
            return Err(HostError::MarketChanged);
        }
        self.refresh_market()?;
        read()?.ok_or(HostError::NotFound)
    }

    pub fn install_from_market(
        &self,
        id: &str,
        selection: Option<&str>,
        replacement: Option<&str>,
    ) -> Result<PluginView, HostError> {
        if replacement.is_some() && selection.is_none() {
            return Err(HostError::MarketChanged);
        }
        if self.workspace_plugin(id).is_some() {
            return Err(HostError::WorkspaceSource);
        }
        let (catalog, entry) = self.selected_market_entry(id, selection)?;
        let binding = catalog.binding(&entry);
        if replacement.is_none()
            && self
                .snapshot()?
                .plugins
                .iter()
                .any(|plugin| plugin.id == id && !same_install_source(plugin, Some(&binding)))
        {
            return Err(HostError::ReplacementRequired);
        }
        self.require_source_license(id, Some(&binding))?;
        let base = market::store_base(&catalog.source_url);
        let url = market::resolve_package_url(&base, &entry.package.url);
        let proxy = self
            .network
            .as_ref()
            .map(|(store, _)| store.get())
            .transpose()
            .map_err(|error| HostError::Market(MarketError::Proxy(error)))?
            .unwrap_or_default();
        let bytes = market::fetch_with_proxy(&url, market::MAX_PACKAGE_BYTES, &proxy)?;
        if registry::digest(&bytes) != entry.package.sha256 {
            return Err(HostError::Install(InstallError::ChecksumMismatch));
        }
        let contents = package::parse(&bytes)
            .map_err(|error| HostError::Install(InstallError::Package(error)))?;
        if contents.manifest != entry.manifest {
            return Err(HostError::Install(InstallError::Package(
                package::PackageError::MalformedHeader,
            )));
        }
        let _operation = self
            .market_operation
            .lock()
            .map_err(|_| HostError::Registry)?;
        self.selected_market_entry(id, Some(&catalog.selection(&entry)))?;
        self.install_package(contents, Some(binding), replacement)
    }

    /// Checks the store on a timer. Failures are recorded on the settings and
    /// never surface as an error the user has to dismiss.
    pub fn watch_market(self: &Arc<Self>) {
        let Ok(mut slot) = self.market_watch.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        let running = Arc::new(AtomicBool::new(true));
        let host = Arc::clone(self);
        let flag = Arc::clone(&running);
        let handle = thread::spawn(move || {
            if !sleep_unless_stopped(&flag, market::CHECK_DELAY) {
                return;
            }
            while flag.load(Ordering::Relaxed) {
                if host.market_store.load().store_url.is_some() {
                    let _ = host.refresh_market();
                }
                if !sleep_unless_stopped(&flag, market::CHECK_INTERVAL) {
                    break;
                }
            }
        });
        *slot = Some(Supervisor { running, handle });
    }

    /// Starts every installed plugin and keeps restarting the ones that die.
    pub fn supervise(self: &Arc<Self>) {
        let Ok(mut slot) = self.supervisor.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        let running = Arc::new(AtomicBool::new(true));
        let host = Arc::clone(self);
        let flag = Arc::clone(&running);
        let handle = thread::spawn(move || {
            if !sleep_unless_stopped(&flag, SUPERVISE_DELAY) {
                return;
            }
            while flag.load(Ordering::Relaxed) {
                host.supervise_once();
                if !sleep_unless_stopped(&flag, SUPERVISE_INTERVAL) {
                    break;
                }
            }
        });
        *slot = Some(Supervisor { running, handle });
    }

    /// One supervision pass. Exposed so tests can drive it deterministically.
    pub fn supervise_once(&self) {
        let Ok(plugins) = self.all_plugins() else {
            return;
        };
        for plugin in plugins.iter().filter(|plugin| plugin.enabled) {
            if self.closing.load(Ordering::Acquire) {
                break;
            }
            if self.workspace_plugin(&plugin.id).is_none() {
                let _ = self.require_source_license(&plugin.id, plugin.market.as_ref());
            }
            let Ok(_lifecycle) = self.process_start.lock() else {
                return;
            };
            let Ok(current) = self.find(&plugin.id) else {
                continue;
            };
            if installation_generation(&current) != installation_generation(plugin) {
                continue;
            }
            if self.require_local_license(&plugin.id).is_err() {
                self.stop(&plugin.id);
                continue;
            }
            let healthy = self
                .processes
                .lock()
                .ok()
                .and_then(|processes| processes.get(&plugin.id).cloned())
                .is_some_and(|process| {
                    process.failure().is_none() && process.is_alive() && process.ready().is_some()
                });
            if healthy {
                continue;
            }
            if !self.attempt_due(&plugin.id) {
                continue;
            }
            self.stop(&plugin.id);
            match self.ensure_started_locked(&plugin.id) {
                Ok(_) => self.note_started(&plugin.id),
                Err(_) => self.note_failure(&plugin.id),
            }
        }
    }

    fn attempt_due(&self, id: &str) -> bool {
        self.attempts
            .lock()
            .ok()
            .and_then(|attempts| attempts.get(id).and_then(|attempt| attempt.next_at))
            .is_none_or(|next_at| Instant::now() >= next_at)
    }

    fn note_started(&self, id: &str) {
        if let Ok(mut attempts) = self.attempts.lock() {
            let attempt = attempts.entry(id.to_string()).or_default();
            attempt.started_at = Some(Instant::now());
            attempt.next_at = None;
        }
    }

    fn note_failure(&self, id: &str) {
        let Ok(mut attempts) = self.attempts.lock() else {
            return;
        };
        let attempt = attempts.entry(id.to_string()).or_default();
        // A process that ran long enough is treated as healthy, so a one-off
        // crash does not keep escalating the delay.
        if attempt
            .started_at
            .is_some_and(|at| at.elapsed() >= HEALTHY_UPTIME)
        {
            attempt.failures = 0;
        }
        attempt.failures = attempt.failures.saturating_add(1);
        attempt.started_at = None;
        attempt.next_at = Some(Instant::now() + attempt.delay());
    }

    fn forget_attempt(&self, id: &str) {
        if let Ok(mut attempts) = self.attempts.lock() {
            attempts.remove(id);
        }
    }

    // Call while holding process_start so the process is fully shut down before
    // any replacement can use the same ID.
    fn stop(&self, id: &str) {
        let process = self
            .processes
            .lock()
            .ok()
            .and_then(|mut processes| processes.remove(id));
        if let Some(process) = process {
            process.stop();
        }
    }

    fn ensure_started(&self, id: &str) -> Result<Arc<PluginProcess>, HostError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(ProcessError::Cancelled.into());
        }
        let _start = self.process_start.lock().map_err(|_| HostError::Registry)?;
        self.ensure_started_locked(id)
    }

    fn ensure_started_locked(&self, id: &str) -> Result<Arc<PluginProcess>, HostError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(ProcessError::Cancelled.into());
        }
        let current_authorization = self.require_local_license(id);
        if current_authorization.is_err() {
            self.stop(id);
        }
        current_authorization?;
        if let Some(existing) = self
            .processes
            .lock()
            .ok()
            .and_then(|processes| processes.get(id).cloned())
        {
            if existing.failure().is_none() && existing.is_alive() {
                return Ok(existing);
            }
            self.stop(id);
        }
        let plugin = self.find(id)?;
        if !plugin.enabled {
            return Err(HostError::Permission(PermissionError::NotEnabled));
        }
        let storage = if plugin.manifest.permissions.storage == StorageScope::Private {
            let directory = plugin.storage_directory(&self.root);
            std::fs::create_dir_all(&directory).map_err(|_| HostError::Registry)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
            }
            Some(directory)
        } else {
            None
        };
        let proxy = self
            .network
            .as_ref()
            .map(|(store, _)| store.get())
            .transpose()
            .map_err(|error| HostError::Process(ProcessError::Failed(error)))?;
        let source_loader = if self.workspace_plugin(&plugin.id).is_some() {
            self.source_loader.as_deref()
        } else {
            None
        };
        let (process, ready) = PluginProcess::spawn_with_gateway_and_loader(
            &plugin.entry_path(),
            storage.as_deref(),
            plugin.manifest.clone(),
            &self.node,
            // Packages carry an encrypted entry; the loader needs this to run.
            // A plain directory install simply ignores it.
            &package::key_for(&plugin.id, &plugin.version),
            NodeLaunchOptions {
                network: proxy
                    .as_ref()
                    .zip(self.network.as_ref().map(|(_, path)| path.as_path())),
                source_loader,
            },
            HostGateway {
                installation: installation_generation(&plugin),
                host_handler: Arc::clone(&self.host_handler),
            },
        )?;
        let _ = ready;
        if self.closing.load(Ordering::Acquire)
            || installation_generation(&self.find(id)?) != installation_generation(&plugin)
        {
            process.stop();
            return Err(PermissionError::StaleGeneration.into());
        }
        if let Ok(mut processes) = self.processes.lock() {
            processes.insert(plugin.id.clone(), Arc::clone(&process));
        }
        Ok(process)
    }

    pub(crate) fn require_methods(
        &self,
        id: &str,
        capability: Capability,
        methods: &[&str],
    ) -> Result<(), HostError> {
        let process = self.ensure_started(id)?;
        let plugin = self.find(id)?;
        if process.caller().installation != installation_generation(&plugin) {
            return Err(PermissionError::StaleGeneration.into());
        }
        let ready = process
            .ready()
            .ok_or(HostError::Process(ProcessError::NotReady))?;
        for method in methods {
            permissions::check_call(&plugin, &ready, capability, method)?;
        }
        Ok(())
    }

    pub fn call(
        &self,
        id: &str,
        capability: Capability,
        method: &str,
        payload: Value,
        deadline: Duration,
    ) -> Result<Value, HostError> {
        let process = self.ensure_started(id)?;
        let plugin = self.find(id)?;
        if process.caller().installation != installation_generation(&plugin) {
            return Err(PermissionError::StaleGeneration.into());
        }
        let ready = process
            .ready()
            .ok_or(HostError::Process(ProcessError::NotReady))?;
        permissions::check_call(&plugin, &ready, capability, method)?;
        process
            .call(capability, method, payload, deadline)
            .map_err(HostError::Process)
    }

    fn process_for_generation(
        &self,
        id: &str,
        installation: &str,
        generation: &str,
        capability: Capability,
        method: &str,
    ) -> Result<Arc<PluginProcess>, HostError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(ProcessError::Cancelled.into());
        }
        let workspace = self
            .workspace_plugins
            .lock()
            .map_err(|_| HostError::Registry)?;
        let registry = self.registry.lock().map_err(|_| HostError::Registry)?;
        let plugin = workspace
            .get(id)
            .or_else(|| registry.plugins.iter().find(|plugin| plugin.id == id))
            .ok_or(HostError::NotInstalled)?;
        let processes = self.processes.lock().map_err(|_| HostError::Registry)?;
        let process = processes.get(id).ok_or(PermissionError::StaleGeneration)?;
        let caller = process.caller();
        if installation_generation(plugin) != installation
            || caller.plugin_id != id
            || caller.installation != installation
            || caller.generation != generation
            || process.failure().is_some()
            || !process.is_alive()
        {
            return Err(PermissionError::StaleGeneration.into());
        }
        // A scoped UI call uses the selected installation's local lease.
        if !workspace.contains_key(id) {
            self.require_local_source_license(id, plugin.market.as_ref())?;
        }
        let ready = process.ready().ok_or(ProcessError::NotReady)?;
        permissions::check_call(plugin, &ready, capability, method)?;
        Ok(Arc::clone(process))
    }

    /// Calls only the exact installed process selected by a scoped UI request.
    /// Process restarts never cause an operation to run on a replacement.
    pub(crate) fn call_generation(
        &self,
        id: &str,
        identity: &str,
        capability: Capability,
        method: &str,
        payload: Value,
        deadline: Duration,
    ) -> Result<Value, HostError> {
        let started = Instant::now();
        let (installation, generation) = identity
            .rsplit_once(':')
            .filter(|(installation, generation)| {
                identity.len() <= 512 && !installation.is_empty() && !generation.is_empty()
            })
            .ok_or(PermissionError::StaleGeneration)?;
        let process =
            self.process_for_generation(id, installation, generation, capability, method)?;
        let remaining = deadline
            .checked_sub(started.elapsed())
            .and_then(|remaining| remaining.checked_sub(process::DEADLINE_GRACE))
            .filter(|remaining| !remaining.is_zero())
            .ok_or(ProcessError::Timeout)?;
        let result = process
            .call(capability, method, payload, remaining)
            .map_err(HostError::Process);
        let current =
            self.process_for_generation(id, installation, generation, capability, method)?;
        if !Arc::ptr_eq(&process, &current) {
            return Err(PermissionError::StaleGeneration.into());
        }
        if started.elapsed() >= deadline {
            return Err(ProcessError::Timeout.into());
        }
        result
    }

    /// Persist these installed account-pool IDs before remotely deleting a window.
    /// Disabled, stopped and unavailable plugins remain cleanup targets.
    pub fn window_binding_plugins(&self) -> Result<Vec<String>, HostError> {
        let mut ids: Vec<String> = self
            .all_plugins()?
            .into_iter()
            .filter(|plugin| plugin.manifest.declares(Capability::AccountPool))
            .map(|plugin| plugin.id)
            .collect();
        ids.sort();
        Ok(ids)
    }

    /// Retry the deletion's saved targets; only an uninstalled target is skipped.
    /// Any error requires the caller to retain its confirmed deletion tombstone.
    pub fn detach_window_bindings(
        &self,
        window_id: &str,
        target_plugin_ids: &[String],
    ) -> Result<(), HostError> {
        for id in target_plugin_ids {
            let plugin = match self.find(id) {
                Ok(plugin) => plugin,
                Err(HostError::NotInstalled) => continue,
                Err(error) => return Err(error),
            };
            if !plugin.enabled {
                return Err(HostError::Permission(PermissionError::NotEnabled));
            }
            // `call` starts a stopped process before checking its advertised methods.
            let result = self.call(
                id,
                Capability::AccountPool,
                "window.detach",
                json!({ "windowId": window_id }),
                DEFAULT_CALL_DEADLINE,
            )?;
            let valid = result.as_object().is_some_and(|object| {
                object.len() == 2
                    && object.get("windowId").and_then(Value::as_str) == Some(window_id)
                    && object.get("unbound").and_then(Value::as_bool).is_some()
            });
            if !valid {
                return Err(HostError::Process(ProcessError::Protocol(
                    "invalid window.detach result".into(),
                )));
            }
        }
        Ok(())
    }

    /// Window launch gate. A required proxy that cannot be resolved is an
    /// error: the caller must block the launch instead of falling back to a
    /// direct connection. `endpoint_id` pins one row of the provider's
    /// inventory; `None` keeps the provider's own default.
    pub fn resolve_proxy(
        &self,
        plugin_id: &str,
        _window_id: &str,
        endpoint_id: Option<i64>,
    ) -> Result<ProxyReference, HostError> {
        let (reference, _) = self.resolve_proxy_result(plugin_id, endpoint_id)?;
        Ok(reference)
    }

    /// Resolves the reference and the credentialed browser connection in one
    /// RPC so they describe the same plugin snapshot. Pass the URL only through
    /// the browser adapter's launch IPC; never persist it or fall back to direct.
    pub fn resolve_browser_proxy(
        &self,
        plugin_id: &str,
        _window_id: &str,
        endpoint_id: Option<i64>,
    ) -> Result<ResolvedBrowserProxy, HostError> {
        let (reference, value) = self.resolve_proxy_result(plugin_id, endpoint_id)?;
        let connection_url = parse_proxy_connection_url(&value)?;
        Ok(ResolvedBrowserProxy {
            reference,
            connection_url,
        })
    }

    fn resolve_proxy_result(
        &self,
        plugin_id: &str,
        endpoint_id: Option<i64>,
    ) -> Result<(ProxyReference, Value), HostError> {
        let value = self.call(
            plugin_id,
            Capability::ProxyProvider,
            "proxy.resolve",
            json!({ "endpointId": endpoint_id }),
            RESOLVE_DEADLINE,
        )?;
        let reference = parse_proxy_reference(&value, endpoint_id)?;
        Ok((reference, value))
    }

    /// Proxy provider plugins that can be offered when creating a window.
    pub fn proxy_providers(&self) -> Result<Vec<PluginView>, HostError> {
        Ok(self
            .catalog()?
            .into_iter()
            .filter(|view| {
                view.capabilities
                    .iter()
                    .any(|name| name == "proxy.provider")
            })
            .collect())
    }

    pub fn shutdown(&self) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut slot) = self.market_watch.lock()
            && let Some(watcher) = slot.take()
        {
            watcher.running.store(false, Ordering::Relaxed);
            let _ = watcher.handle.join();
        }
        if let Ok(mut slot) = self.supervisor.lock()
            && let Some(supervisor) = slot.take()
        {
            supervisor.running.store(false, Ordering::Relaxed);
            let _ = supervisor.handle.join();
        }
        let Ok(_lifecycle) = self.process_start.lock() else {
            return;
        };
        let ids: Vec<String> = self
            .processes
            .lock()
            .map(|processes| processes.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.stop(&id);
        }
    }
}

fn parse_proxy_reference(
    value: &Value,
    endpoint_id: Option<i64>,
) -> Result<ProxyReference, HostError> {
    let configured = value
        .get("configured")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let handle = value
        .get("configHandle")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !configured || handle.trim().is_empty() {
        return Err(HostError::Process(ProcessError::Plugin(
            process::PluginErrorPayload::new(
                "NOT_CONFIGURED",
                if endpoint_id.is_some() {
                    "窗口指定的代理不存在或不可用，请重新选择，窗口启动被阻断"
                } else {
                    "未选择默认代理，窗口启动被阻断"
                },
                false,
            ),
        )));
    }
    Ok(ProxyReference {
        config_handle: handle.to_string(),
        secret_ref: value
            .get("secretRef")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

fn parse_proxy_connection_url(value: &Value) -> Result<String, HostError> {
    let connection = value
        .get("connectionUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            HostError::Process(ProcessError::Plugin(process::PluginErrorPayload::new(
                "NOT_CONFIGURED",
                "代理插件版本过旧，请更新或重新安装插件，窗口启动被阻断",
                false,
            )))
        })?;
    let invalid = || {
        HostError::Process(ProcessError::Protocol(
            "代理连接配置无效，窗口启动被阻断".into(),
        ))
    };
    let parsed = url::Url::parse(connection).map_err(|_| invalid())?;
    let (_, authority) = connection.split_once("://").ok_or_else(invalid)?;
    // Check the raw authority too: URL parsers normalize default ports,
    // whitespace, backslashes and dot paths, which must not hide bad input.
    let explicit_port = authority
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .is_some_and(|port| port > 0);
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
        || parsed.host_str().is_none_or(str::is_empty)
        || !explicit_port
        || connection
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        || authority.contains(['/', '\\', '?', '#'])
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid());
    }
    // Preserve the plugin's percent encoding and explicit port.
    Ok(connection.to_string())
}

/// Sleeps in slices so a shutdown does not wait for a full interval.
fn sleep_unless_stopped(flag: &AtomicBool, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if !flag.load(Ordering::Relaxed) {
            return false;
        }
        thread::sleep(
            Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    flag.load(Ordering::Relaxed)
}

pub fn capability_names(manifest: &PluginManifest) -> Vec<String> {
    manifest
        .capabilities
        .iter()
        .map(|capability| capability.as_str().to_string())
        .collect()
}

pub fn source_name(source: CandidateSource) -> &'static str {
    match source {
        CandidateSource::Installed => "installed",
        CandidateSource::Development => "development",
        CandidateSource::Workspace => "workspace",
    }
}

pub fn ready_methods(ready: &ReadyInfo) -> Vec<String> {
    ready.methods.clone()
}

fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:09}", now.as_secs(), now.subsec_nanos())
}

fn installation_generation(plugin: &InstalledPlugin) -> String {
    format!(
        "{}:{}:{}",
        plugin.version, plugin.installed_at, plugin.manifest_digest
    )
}

fn same_install_source(plugin: &InstalledPlugin, binding: Option<&MarketBinding>) -> bool {
    plugin.market.as_ref() == binding
}

#[cfg(test)]
mod ui_generation_tests {
    use super::*;

    #[test]
    fn generation_calls_do_not_start_a_stopped_plugin() {
        let temporary = tempfile::tempdir().unwrap();
        let host = PluginHost::open_with_node(
            temporary.path().join("plugins"),
            Vec::new(),
            temporary.path().join("runtime-must-not-start"),
        )
        .unwrap();
        let manifest = PluginManifest::parse(
            &serde_json::to_vec(&json!({
                "apiVersion":1,"id":"example.catalog","version":"1.0.0",
                "name":"Catalog","minCoreVersion":env!("CARGO_PKG_VERSION"),
                "capabilities":["product.catalog"],"permissions":{
                    "networkDomains":[],"wantsBrowserAccess":false,"storage":"private","secrets":[]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let plugin = InstalledPlugin {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            manifest,
            directory: temporary.path().join("unused-plugin"),
            entry: "index.js".into(),
            manifest_digest: "fixture-digest".into(),
            enabled: true,
            granted_capabilities: vec![Capability::ProductCatalog],
            granted_domains: Vec::new(),
            installed_at: "fixture-installation".into(),
            market: None,
        };
        let identity = format!("{}:missing-runtime", installation_generation(&plugin));
        host.registry.lock().unwrap().plugins.push(plugin);
        let result = host.call_generation(
            "example.catalog",
            &identity,
            Capability::ProductCatalog,
            "items.list",
            json!({}),
            Duration::from_secs(1),
        );
        assert_eq!(
            result,
            Err(HostError::Permission(PermissionError::StaleGeneration))
        );
        assert!(host.processes.lock().unwrap().is_empty());
    }
}
