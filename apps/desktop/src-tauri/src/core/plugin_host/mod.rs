pub mod discovery;
pub mod install;
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
use self::manifest::{Capability, ManifestError, PluginManifest, PluginPermissions, StorageScope};
use self::market::{Catalog, MarketError, MarketStore, StoreSettings};
use self::permissions::PermissionError;
use self::process::{PluginProcess, ProcessError, ReadyInfo};
use self::registry::{InstalledPlugin, RegistryDocument, RegistryError, RegistryStore};
use super::plugins::ProxyReference;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            HostError::Process(error) => error.retryable(),
            HostError::Registry | HostError::Market(MarketError::Offline) => true,
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
}

/// One row of the configured store. `state` is derived by comparing the
/// published version with what is installed: `install`, `update` or `current`.
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
    attempts: Mutex<HashMap<String, Attempt>>,
    supervisor: Mutex<Option<Supervisor>>,
    dev_roots: Vec<(PathBuf, CandidateSource)>,
    /// Uninstalled packages are only listed while developing the host. A
    /// released build shows what is installed plus whatever the store offers.
    lists_candidates: bool,
    market_store: MarketStore,
    market: Mutex<Catalog>,
    market_watch: Mutex<Option<Supervisor>>,
    network: Option<(crate::core::network_proxy::NetworkProxyStore, PathBuf)>,
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
        let store = RegistryStore::new(root.join("registry.json"));
        let document = store.load().map_err(|error| match error {
            RegistryError::Corrupt | RegistryError::Io => HostError::Registry,
        })?;
        let market_store = MarketStore::new(&root);
        let host = Self {
            market_store,
            market: Mutex::new(Catalog::default()),
            market_watch: Mutex::new(None),
            network: None,
            lists_candidates: cfg!(debug_assertions),
            root,
            node,
            store,
            registry: Mutex::new(document),
            processes: Mutex::new(HashMap::new()),
            attempts: Mutex::new(HashMap::new()),
            supervisor: Mutex::new(None),
            dev_roots,
        };
        // Installations written by an older build may still be disabled or carry
        // a partial grant. There is no manual enable step any more, so they are
        // adopted on open instead of being left inert.
        let _ = host.adopt_installed();
        Ok(host)
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
        let ids: Vec<String> = self
            .processes
            .lock()
            .map(|processes| processes.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.stop(&id);
            self.forget_attempt(&id);
        }
        self.supervise_once();
    }

    /// Every installed plugin is enabled and holds the full grant its manifest
    /// declares. Installation is the only decision point.
    fn adopt_installed(&self) -> Result<(), HostError> {
        let mut document = self.snapshot()?;
        let mut changed = false;
        for entry in &mut document.plugins {
            let declared = permissions::grantable(entry);
            if !entry.enabled || entry.granted_capabilities != declared {
                entry.enabled = true;
                entry.granted_capabilities = declared;
                entry.granted_domains = entry.manifest.permissions.network_domains.clone();
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        self.persist(&document)?;
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
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
        self.snapshot()?
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == id)
            .ok_or(HostError::NotInstalled)
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
        let mut views: Vec<PluginView> = Vec::new();
        for plugin in &document.plugins {
            let mut view = self.view(plugin);
            view.source_directory = candidates
                .iter()
                .find(|candidate| candidate.manifest.id == plugin.id)
                .map(|candidate| candidate.directory.to_string_lossy().into_owned());
            views.push(view);
        }
        // A shipped build starts with an empty plugin list: what is installed
        // plus what the store offers. Listing packages that merely sit next to
        // the binary made the app look like it came with plugins.
        for candidate in candidates {
            if document
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
        let state = if running {
            "running"
        } else if process.is_some() || failures > 0 {
            // A process entry that is not usable means it died or misbehaved.
            "retrying"
        } else {
            "starting"
        };
        let last_error = if running {
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
            source: "installed".into(),
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
            source_directory: None,
        }
    }

    pub fn install(&self, source: &Path) -> Result<PluginView, HostError> {
        let candidate = discovery::inspect(source, CandidateSource::Development)
            .ok()
            .flatten()
            .ok_or(HostError::NotFound)?;
        let existing = self
            .snapshot()?
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == candidate.manifest.id);
        if let Some(plugin) = &existing {
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
        // Start right away so the page that installs a plugin can use it. A
        // start failure is not fatal: the supervisor retries with backoff.
        let _ = self.ensure_started(&record.id);
        self.view_of(&record.id)
    }

    pub fn uninstall(&self, id: &str) -> Result<(), HostError> {
        let plugin = self.find(id)?;
        self.stop(id);
        self.forget_attempt(id);
        install::uninstall(&self.root, &plugin.id, &plugin.version)?;
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
    pub fn install_from_package(&self, bytes: &[u8]) -> Result<PluginView, HostError> {
        let contents = package::parse(bytes)
            .map_err(|error| HostError::Install(InstallError::Package(error)))?;
        let manifest = contents.manifest.clone();
        let existing = self
            .snapshot()?
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == manifest.id);
        if let Some(plugin) = &existing {
            if matches!(
                market::compare_versions(&manifest.version, &plugin.version),
                Some(std::cmp::Ordering::Less)
            ) {
                return Err(HostError::Install(InstallError::Downgrade));
            }
            // The running process holds the old entry file open on Windows, so
            // it has to stop before the version directory is replaced.
            self.stop(&plugin.id);
            self.forget_attempt(&plugin.id);
        }

        let directory =
            install::write_version(&self.root, &manifest.id, &manifest.version, &contents.files)?;
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
        let _ = self.ensure_started(&record.id);
        self.view_of(&record.id)
    }

    pub fn market_status(&self) -> Result<MarketStatusView, HostError> {
        let settings = self.market_store.load();
        let catalog = self
            .market
            .lock()
            .map(|catalog| catalog.clone())
            .unwrap_or_default();
        let document = self.snapshot()?;
        let mut entries: Vec<MarketEntryView> = catalog
            .entries
            .iter()
            .map(|entry| {
                let installed = document
                    .plugins
                    .iter()
                    .find(|plugin| plugin.id == entry.manifest.id);
                let state = match installed {
                    None => "install",
                    Some(plugin) => {
                        match market::compare_versions(&plugin.version, &entry.manifest.version) {
                            Some(std::cmp::Ordering::Less) => "update",
                            _ => "current",
                        }
                    }
                };
                MarketEntryView {
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
                }
            })
            .collect();
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
        let mut settings = self.market_store.load();
        match url {
            Some(value) if !value.trim().is_empty() => {
                let normalized = market::normalize_store_url(&value)?;
                settings.store_url = Some(normalized);
                settings.last_checked_at = None;
                settings.last_error = None;
                self.market_store.save(&settings)?;
                self.refresh_market()
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
        let mut settings = self.market_store.load();
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
        let fetched = market::fetch_with_proxy(&catalog_url, market::MAX_CATALOG_BYTES, &proxy)
            .and_then(|bytes| Catalog::parse(&bytes));
        match fetched {
            Ok(catalog) => {
                if let Ok(mut slot) = self.market.lock() {
                    *slot = catalog;
                }
                settings.last_checked_at = Some(market::now_timestamp());
                settings.last_error = None;
                let _ = self.market_store.save(&settings);
                self.market_status()
            }
            Err(error) => {
                settings.last_error = Some(error.message());
                let _ = self.market_store.save(&settings);
                Err(HostError::Market(error))
            }
        }
    }

    pub fn install_from_market(&self, id: &str) -> Result<PluginView, HostError> {
        let mut entry = self
            .market
            .lock()
            .ok()
            .and_then(|catalog| catalog.find(id).cloned());
        if entry.is_none() {
            self.refresh_market()?;
            entry = self
                .market
                .lock()
                .ok()
                .and_then(|catalog| catalog.find(id).cloned());
        }
        let entry = entry.ok_or(HostError::NotFound)?;
        let settings: StoreSettings = self.market_store.load();
        let store_url = settings
            .store_url
            .ok_or(HostError::Market(MarketError::NotConfigured))?;
        let catalog_url = market::normalize_store_url(&store_url)?;
        let base = market::store_base(&catalog_url);
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
        let view = self.install_from_package(&bytes)?;
        if view.id != entry.manifest.id {
            // The catalog and the package disagree about identity: roll the
            // install back rather than leave a surprise behind.
            let _ = self.uninstall(&view.id);
            return Err(HostError::Install(InstallError::Package(
                package::PackageError::MalformedHeader,
            )));
        }
        Ok(view)
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
        let Ok(document) = self.snapshot() else {
            return;
        };
        for plugin in document.plugins.iter().filter(|plugin| plugin.enabled) {
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
            match self.ensure_started(&plugin.id) {
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
        let (process, ready) = PluginProcess::spawn_with_network(
            &plugin.entry_path(),
            storage.as_deref(),
            plugin.manifest.clone(),
            &self.node,
            // Packages carry an encrypted entry; the loader needs this to run.
            // A plain directory install simply ignores it.
            &package::key_for(&plugin.id, &plugin.version),
            proxy
                .as_ref()
                .zip(self.network.as_ref().map(|(_, path)| path.as_path())),
        )?;
        let _ = ready;
        if let Ok(mut processes) = self.processes.lock() {
            processes.insert(plugin.id.clone(), Arc::clone(&process));
        }
        Ok(process)
    }

    pub fn call(
        &self,
        id: &str,
        capability: Capability,
        method: &str,
        payload: Value,
        deadline: Duration,
    ) -> Result<Value, HostError> {
        let plugin = self.find(id)?;
        let process = self.ensure_started(id)?;
        let ready = process
            .ready()
            .ok_or(HostError::Process(ProcessError::NotReady))?;
        permissions::check_call(&plugin, &ready, capability, method)?;
        process
            .call(capability, method, payload, deadline)
            .map_err(HostError::Process)
    }

    /// Window launch gate. A required proxy that cannot be resolved is an
    /// error: the caller must block the launch instead of falling back to a
    /// direct connection. `endpoint_id` pins one row of the provider's
    /// inventory; `None` keeps the provider's own default.
    pub fn resolve_proxy(
        &self,
        plugin_id: &str,
        window_id: &str,
        endpoint_id: Option<i64>,
    ) -> Result<ProxyReference, HostError> {
        let value = self.call(
            plugin_id,
            Capability::ProxyProvider,
            "proxy.resolve",
            json!({ "windowId": window_id, "endpointId": endpoint_id }),
            RESOLVE_DEADLINE,
        )?;
        let configured = value
            .get("configured")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let handle = value
            .get("configHandle")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !configured || handle.trim().is_empty() {
            return Err(HostError::Process(ProcessError::Plugin(
                process::PluginErrorPayload::new(
                    "NOT_CONFIGURED",
                    "代理插件未选择默认代理，窗口启动被阻断",
                    false,
                ),
            )));
        }
        let secret_ref = value
            .get("secretRef")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        Ok(ProxyReference {
            config_handle: handle,
            secret_ref,
        })
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
    format!("{}", now.as_secs())
}
