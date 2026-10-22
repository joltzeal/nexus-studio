pub mod discovery;
pub mod install;
pub mod manifest;
pub mod permissions;
pub mod process;
pub mod registry;

#[cfg(test)]
mod tests;

use self::discovery::{CandidateSource, DiscoveryReport};
use self::install::InstallError;
use self::manifest::{Capability, ManifestError, PluginManifest, PluginPermissions, StorageScope};
use self::permissions::PermissionError;
use self::process::{PluginProcess, ProcessError, ReadyInfo};
use self::registry::{InstalledPlugin, RegistryDocument, RegistryError, RegistryStore};
use super::plugins::ProxyReference;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DEFAULT_CALL_DEADLINE: Duration = Duration::from_secs(30);
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostError {
    Registry,
    NotInstalled,
    Install(InstallError),
    Manifest(ManifestError),
    Permission(PermissionError),
    Process(ProcessError),
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
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            HostError::Process(error) => error.retryable(),
            HostError::Registry => true,
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
    /// Set only for a discovered package that is not installed yet.
    pub source_directory: Option<String>,
}

pub struct PluginHost {
    root: PathBuf,
    node: PathBuf,
    store: RegistryStore,
    registry: Mutex<RegistryDocument>,
    processes: Mutex<HashMap<String, Arc<PluginProcess>>>,
    dev_roots: Vec<(PathBuf, CandidateSource)>,
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
        Ok(Self {
            root,
            node,
            store,
            registry: Mutex::new(document),
            processes: Mutex::new(HashMap::new()),
            dev_roots,
        })
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
        let report = self.discover();
        let mut views: Vec<PluginView> = Vec::new();
        for plugin in &document.plugins {
            views.push(self.view(plugin));
        }
        for candidate in report.candidates {
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

    fn view(&self, plugin: &InstalledPlugin) -> PluginView {
        let process = self
            .processes
            .lock()
            .ok()
            .and_then(|processes| processes.get(&plugin.id).cloned());
        let (state, methods, status, last_error) = match process {
            Some(process) => {
                let failure = process.failure();
                let ready = process.ready();
                let alive = process.is_alive();
                let state = if failure.is_some() || !alive {
                    "failed"
                } else if plugin.enabled {
                    "running"
                } else {
                    "stopped"
                };
                let error = failure.or_else(|| {
                    if alive || !plugin.enabled {
                        None
                    } else {
                        Some("插件进程已退出".to_string())
                    }
                });
                (
                    state.to_string(),
                    ready
                        .as_ref()
                        .map(|ready| ready.methods.clone())
                        .unwrap_or_default(),
                    ready.map(|ready| ready.status).unwrap_or(Value::Null),
                    error,
                )
            }
            None => (
                if plugin.enabled { "failed" } else { "stopped" }.to_string(),
                Vec::new(),
                Value::Null,
                if plugin.enabled {
                    Some("插件进程未启动".to_string())
                } else {
                    None
                },
            ),
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
            state,
            enabled: plugin.enabled,
            methods,
            status,
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
        if self
            .snapshot()?
            .plugins
            .iter()
            .any(|plugin| plugin.id == candidate.manifest.id)
        {
            return Err(HostError::Install(InstallError::AlreadyInstalled));
        }
        let directory = install::install(&candidate, &self.root)?;
        let record = InstalledPlugin {
            id: candidate.manifest.id.clone(),
            version: candidate.manifest.version.clone(),
            manifest: candidate.manifest.clone(),
            directory,
            entry: candidate.entry.clone(),
            manifest_digest: candidate.digest.clone(),
            enabled: false,
            granted_capabilities: Vec::new(),
            granted_domains: Vec::new(),
            installed_at: timestamp(),
        };
        let mut document = self.snapshot()?;
        document.plugins.push(record.clone());
        self.persist(&document)?;
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        Ok(self.view(&record))
    }

    pub fn uninstall(&self, id: &str) -> Result<(), HostError> {
        let plugin = self.find(id)?;
        self.stop(id);
        install::uninstall(&self.root, &plugin.id, &plugin.version)?;
        let mut document = self.snapshot()?;
        document.plugins.retain(|entry| entry.id != id);
        self.persist(&document)?;
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        Ok(())
    }

    /// Enabling is the authorization step: the requested capabilities are
    /// narrowed to the declared ones and persisted before the process starts.
    pub fn enable(&self, id: &str, requested: &[Capability]) -> Result<PluginView, HostError> {
        let plugin = self.find(id)?;
        let granted = permissions::narrow_grant(&plugin, requested);
        if granted.is_empty() {
            return Err(HostError::Permission(PermissionError::CapabilityNotGranted));
        }
        {
            let mut document = self.snapshot()?;
            let Some(entry) = document.plugins.iter_mut().find(|entry| entry.id == id) else {
                return Err(HostError::NotInstalled);
            };
            entry.enabled = true;
            entry.granted_capabilities = granted;
            entry.granted_domains = entry.manifest.permissions.network_domains.clone();
            self.persist(&document)?;
            if let Ok(mut current) = self.registry.lock() {
                *current = document;
            }
        }
        match self.ensure_started(id) {
            Ok(_) => self.view_of(id),
            Err(error) => {
                // Keep the persisted grant but report the real state: enabled
                // does not mean running.
                let view = self.view_of(id)?;
                let _ = error;
                Ok(view)
            }
        }
    }

    pub fn disable(&self, id: &str) -> Result<PluginView, HostError> {
        let mut document = self.snapshot()?;
        let Some(entry) = document.plugins.iter_mut().find(|entry| entry.id == id) else {
            return Err(HostError::NotInstalled);
        };
        entry.enabled = false;
        self.persist(&document)?;
        if let Ok(mut current) = self.registry.lock() {
            *current = document;
        }
        self.stop(id);
        self.view_of(id)
    }

    pub fn restart(&self, id: &str) -> Result<PluginView, HostError> {
        self.stop(id);
        self.ensure_started(id)?;
        self.view_of(id)
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
        let (process, ready) = PluginProcess::spawn(
            &plugin.entry_path(),
            storage.as_deref(),
            plugin.manifest.clone(),
            &self.node,
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
    /// direct connection.
    pub fn resolve_proxy(
        &self,
        plugin_id: &str,
        window_id: &str,
    ) -> Result<ProxyReference, HostError> {
        let value = self.call(
            plugin_id,
            Capability::ProxyProvider,
            "proxy.resolve",
            json!({ "windowId": window_id }),
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
