use super::browser::{
    connection_store::{BrowserConnection, ConnectionInput, ConnectionStore},
    operation_store::{BrowserOperation, OperationResolution, OperationStore},
    provider::*,
    providers::{
        adspower::AdsPowerProvider, bitbrowser::BitBrowserProvider,
        cloakbrowser::CloakBrowserProvider,
    },
    registry::ProviderRegistry,
    session_store::SessionStore,
};
use super::{
    license_store::LicenseStore,
    network_proxy::NetworkProxyStore,
    plugin_host::PluginHost,
    runtime_paths::RuntimePaths,
    scheduler::{LaunchRequest, ProxyBinding, Scheduler},
    window_store::{WindowRecord, WindowSettings, WindowStore, now_seconds, validate_draft},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWindowInput {
    pub operation_id: String,
    pub connection_id: String,
    pub name: String,
    pub proxy_mode: ProxyMode,
    pub proxy: Option<String>,
    pub proxy_plugin: Option<String>,
    pub proxy_endpoint: Option<i64>,
    pub settings: WindowSettings,
    pub group_id: Option<String>,
    pub kernel_version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateWindowInput {
    pub id: String,
    pub name: String,
    pub proxy_mode: ProxyMode,
    pub proxy: Option<String>,
    pub proxy_plugin: Option<String>,
    pub proxy_endpoint: Option<i64>,
    pub settings: WindowSettings,
    pub group_id: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResolveOperationInput {
    Associate {
        id: String,
        provider_profile_id: String,
        confirmed: bool,
    },
    Abandon {
        id: String,
        confirmed: bool,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindow {
    pub id: String,
    pub name: String,
    pub provider_id: BrowserProviderId,
    pub connection_id: String,
    pub provider_profile_id: String,
    pub origin: WindowOrigin,
    pub state: WindowState,
    pub version: String,
    pub kernel_version: Option<String>,
    pub proxy: Option<String>,
    pub proxy_plugin: Option<String>,
    pub proxy_endpoint: Option<i64>,
    pub proxy_mode: ProxyMode,
    pub settings: WindowSettings,
    pub group_id: Option<String>,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
    pub sort_order: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    #[serde(flatten)]
    pub connection: BrowserConnection,
    pub capabilities: BrowserCapabilities,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    id: String,
    window_id: String,
    connection_id: String,
    kind: String,
    phase: String,
    message: Option<String>,
    created_at: i64,
    updated_at: i64,
}
impl From<BrowserOperation> for OperationView {
    fn from(op: BrowserOperation) -> Self {
        Self {
            id: op.id,
            window_id: op.window_id,
            connection_id: op.connection_id,
            kind: op.kind,
            phase: op.phase,
            message: op.message,
            created_at: op.created_at,
            updated_at: op.updated_at,
        }
    }
}
struct WindowManagerState {
    scheduler: Scheduler,
    epochs: HashMap<String, u64>,
    busy: HashSet<String>,
    transfers: HashSet<String>,
    recoveries: HashSet<String>,
    installing: bool,
    transfer_operations: usize,
}
impl WindowManagerState {
    fn epoch(&self, id: &str) -> u64 {
        self.epochs.get(id).copied().unwrap_or(0)
    }
    fn advance(&mut self, id: &str) -> BrowserResult<()> {
        let epoch = self
            .epoch(id)
            .checked_add(1)
            .ok_or_else(|| failure("窗口状态版本已用尽，请重启应用"))?;
        self.epochs.insert(id.into(), epoch);
        Ok(())
    }
    fn can_observe(&self, id: &str) -> bool {
        !self.installing
            && !self.busy.contains("connections")
            && !self.busy.contains(id)
            && !self.transfers.contains(id)
            && !self.recoveries.contains(id)
    }
}
pub struct WindowService {
    pub(crate) store: WindowStore,
    pub(crate) builtin: Arc<CloakBrowserProvider>,
    registry: ProviderRegistry,
    connections: ConnectionStore,
    operations: OperationStore,
    observations: SessionStore,
    plugin_host: Option<Arc<PluginHost>>,
    state: Mutex<WindowManagerState>,
}
fn failure(error: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", error.to_string())
}
fn busy() -> BrowserError {
    BrowserError::new("profile_busy", "窗口正在操作或等待恢复，请稍后重试")
}
fn uncertain() -> BrowserError {
    BrowserError::new(
        "operation_uncertain",
        "操作结果尚未确认，请在待处理操作中重新检查",
    )
}
fn known_rejection(error: &BrowserError) -> bool {
    matches!(
        error.code.as_str(),
        "invalid_config"
            | "unsupported"
            | "auth_required"
            | "permission_denied"
            | "not_submitted"
            | "rate_limited"
            | "profile_busy"
            | "profile_missing"
    )
}

impl WindowService {
    pub fn with_runtime(
        root: PathBuf,
        plugin_host: Option<Arc<PluginHost>>,
        license: LicenseStore,
        runtime: RuntimePaths,
    ) -> Result<Self, String> {
        let store = WindowStore::new(root.clone());
        let path = store.database_path();
        let connections = ConnectionStore::new(path.clone()).map_err(|e| e.to_string())?;
        connections
            .reset_confirmations()
            .map_err(|e| e.to_string())?;
        let builtin = Arc::new(CloakBrowserProvider::new(root, license, runtime, None));
        let mut registry = ProviderRegistry::default();
        registry.register(builtin.clone());
        registry.register(Arc::new(AdsPowerProvider::new()));
        registry.register(Arc::new(BitBrowserProvider::new()));
        Ok(Self {
            store,
            builtin,
            registry,
            connections,
            operations: OperationStore::new(path.clone()),
            observations: SessionStore::new(path),
            plugin_host,
            state: Mutex::new(WindowManagerState {
                scheduler: Scheduler::default(),
                epochs: HashMap::new(),
                busy: HashSet::new(),
                transfers: HashSet::new(),
                recoveries: HashSet::new(),
                installing: false,
                transfer_operations: 0,
            }),
        })
    }
    pub fn with_network(mut self, network: NetworkProxyStore) -> Self {
        self.builtin = Arc::new(CloakBrowserProvider::new(
            self.store.root().into(),
            self.builtin.license_store.clone(),
            self.builtin.runtime.clone(),
            Some(network),
        ));
        self.registry.register(self.builtin.clone());
        self
    }
    pub fn watch_sessions(self: &Arc<Self>) {
        let service = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                {
                    let Some(service) = service.upgrade() else {
                        return;
                    };
                    // Observation never replays pending mutations or launches a browser.
                    let _ = service.list(None);
                }
                std::thread::sleep(std::time::Duration::from_secs(10));
            }
        });
    }
    fn hold(&self, id: &str) -> BrowserResult<WindowGuard<'_>> {
        let mut state = self.state.lock().map_err(failure)?;
        if state.installing
            || state.busy.contains("connections")
            || state.busy.contains(id)
            || state.transfers.contains(id)
            || state.recoveries.contains(id)
        {
            return Err(busy());
        }
        state.advance(id)?;
        state.busy.insert(id.into());
        Ok(WindowGuard {
            service: self,
            id: id.into(),
        })
    }
    fn sequence(&self) -> BrowserResult<i64> {
        self.store.reserve_sort_order().map_err(failure)
    }
    fn hold_connections(
        &self,
        provider_id: BrowserProviderId,
        allow_pending: bool,
    ) -> BrowserResult<WindowGuard<'_>> {
        let mut state = self.state.lock().map_err(failure)?;
        if state.installing
            || !state.busy.is_empty()
            || !state.transfers.is_empty()
            || state.transfer_operations > 0
        {
            return Err(busy());
        }
        if !allow_pending {
            for operation in self.operations.list(None)? {
                if self.connections.get(&operation.connection_id)?.provider_id == provider_id {
                    return Err(busy());
                }
            }
        }
        state.advance("connections")?;
        state.busy.insert("connections".into());
        Ok(WindowGuard {
            service: self,
            id: "connections".into(),
        })
    }
    fn connection(&self, id: &str, write: bool) -> BrowserResult<BrowserConnection> {
        let connection = self.connections.get(id)?;
        if !connection.enabled {
            return Err(BrowserError::new(
                "unavailable",
                "此浏览器接入已停用，请先在设置中启用",
            ));
        }
        if write && !connection.scope_confirmed {
            return Err(BrowserError::new(
                "scope_mismatch",
                "请先在浏览器接入设置中确认当前账户",
            ));
        }
        Ok(connection)
    }
    pub fn probe_connection(&self, id: &str) -> BrowserResult<ProviderProbe> {
        let connection = self.connections.get(id)?;
        self.registry
            .get(connection.provider_id)?
            .probe(&connection)
    }
    pub fn confirm_connection(&self, id: &str, scope_label: &str) -> BrowserResult<ConnectionView> {
        let provider_id = self.connections.get(id)?.provider_id;
        let _guard = self.hold_connections(provider_id, true)?;
        let previous = self.connections.get(id)?;
        let provider = self.registry.get(provider_id)?;
        let probe = provider.probe(&previous)?;
        if !probe.connected {
            return Err(BrowserError::new("unavailable", probe.message));
        }
        let connection =
            self.connections
                .confirm(id, scope_label, probe.scope_id, previous.revision)?;
        Ok(ConnectionView {
            connection,
            capabilities: provider.capabilities(),
        })
    }
    pub fn activate_connection(&self, id: &str) -> BrowserResult<ConnectionView> {
        let provider_id = self.connections.get(id)?.provider_id;
        let _guard = self.hold_connections(provider_id, false)?;
        let connection = self.connections.activate(id)?;
        Ok(ConnectionView {
            connection,
            capabilities: self.registry.get(provider_id)?.capabilities(),
        })
    }
    pub fn connection_groups(&self, id: &str) -> BrowserResult<Vec<ProviderGroup>> {
        let connection = self.connections.get(id)?;
        self.registry
            .get(connection.provider_id)?
            .list_groups(&connection)
    }
    fn validate_group(&self, group: Option<&str>) -> BrowserResult<()> {
        if let Some(group) = group {
            if !super::group_store::GroupStore::new(self.store.database_path())
                .map_err(failure)?
                .list()
                .map_err(failure)?
                .iter()
                .any(|g| g.id == group)
            {
                return Err(BrowserError::new("invalid_config", "所选分组不存在"));
            }
        }
        Ok(())
    }
    fn summary(&self, record: WindowRecord, state: WindowState) -> BrowserResult<BrowserWindow> {
        let group_id = self.store.group_id(&record.id).map_err(failure)?;
        Ok(BrowserWindow {
            id: record.id,
            name: record.name,
            provider_id: record.binding.provider_id,
            connection_id: record.binding.connection_id,
            provider_profile_id: record.binding.profile_id,
            origin: record.origin,
            state,
            version: record
                .provider_config
                .get("displayVersion")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| record.kernel_version.clone())
                .unwrap_or_default(),
            kernel_version: record.kernel_version,
            proxy: record.proxy,
            proxy_plugin: record.proxy_plugin,
            proxy_endpoint: record.proxy_endpoint,
            proxy_mode: record.proxy_mode,
            settings: record.settings,
            group_id,
            created_at: record.created_at,
            last_opened_at: record.last_opened_at,
            sort_order: record.sort_order,
        })
    }
    fn observe(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles> {
        let result = self
            .registry
            .get(connection.provider_id)?
            .observe_profiles(connection, records);
        if result.is_err() && connection.provider_id != BrowserProviderId::CloakBrowser {
            self.connections
                .unconfirm(&connection.id, connection.revision)?;
        }
        result
    }
    fn observe_states(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<HashMap<String, WindowState>> {
        self.observe(connection, records)
            .map(|observation| observation.states)
    }
    pub fn list(&self, connection_id: Option<&str>) -> BrowserResult<Vec<BrowserWindow>> {
        let records = self.store.list().map_err(failure)?;
        let mut states = std::collections::HashMap::new();
        let mut refreshed = HashMap::new();
        for listed in self.connections.list()? {
            if connection_id.is_some_and(|id| id != listed.id) {
                continue;
            }
            let selected: Vec<_> = records
                .iter()
                .filter(|r| r.binding.connection_id == listed.id)
                .cloned()
                .collect();
            if selected.is_empty() {
                continue;
            }
            let (connection, tickets): (_, HashMap<_, _>) = {
                let state = self.state.lock().map_err(failure)?;
                let connection = self.connections.get(&listed.id)?;
                let tickets = selected
                    .iter()
                    .map(|record| {
                        (
                            record.id.clone(),
                            state
                                .can_observe(&record.id)
                                .then(|| (state.epoch(&record.id), state.epoch("connections"))),
                        )
                    })
                    .collect();
                (connection, tickets)
            };
            let observation = if connection.enabled {
                self.observe(&connection, &selected).ok()
            } else {
                None
            };
            for record in &selected {
                let observed = observation
                    .as_ref()
                    .and_then(|batch| batch.states.get(&record.binding.profile_id))
                    .copied()
                    .unwrap_or(WindowState::Unknown);
                let mut state = self.state.lock().map_err(failure)?;
                let previous = self.observations.get(&record.id)?;
                let current_connection = self.connections.get(&connection.id)?;
                let fresh = tickets.get(&record.id).copied().flatten().is_some_and(
                    |(epoch, connection_epoch)| {
                        state.can_observe(&record.id)
                            && state.epoch(&record.id) == epoch
                            && state.epoch("connections") == connection_epoch
                            && current_connection.revision == connection.revision
                            && current_connection.enabled == connection.enabled
                    },
                );
                if !fresh {
                    let display = state
                        .scheduler
                        .status(&record.id)
                        .map(|active| active.state)
                        .or_else(|| previous.map(|observation| observation.state))
                        .unwrap_or(WindowState::Unknown);
                    states.insert(record.id.clone(), display);
                    continue;
                }
                let current = state.scheduler.status(&record.id).cloned();
                let pending = self.operations.window_pending(&record.id)?;
                let display = match current {
                    Some(active)
                        if matches!(
                            active.state,
                            WindowState::Starting | WindowState::Stopping
                        ) =>
                    {
                        active.state
                    }
                    Some(active) if observed == WindowState::Stopped && !pending => {
                        state
                            .scheduler
                            .release(&active.snapshot)
                            .map_err(|_| busy())?;
                        observed
                    }
                    Some(active) if active.state == WindowState::Unknown => WindowState::Unknown,
                    _ => observed,
                };
                if display == WindowState::Running
                    && connection.provider_id == BrowserProviderId::CloakBrowser
                {
                    Self::retain_running(&mut state, record)?;
                }
                let started = previous.is_some_and(|o| o.nexus_started)
                    && !matches!(display, WindowState::Stopped | WindowState::Missing);
                if !pending && connection.provider_id != BrowserProviderId::CloakBrowser {
                    if let Some(remote) = observation.as_ref().and_then(|batch| {
                        batch
                            .profiles
                            .iter()
                            .find(|remote| remote.id == record.binding.profile_id)
                    }) {
                        let updated = self
                            .store
                            .refresh_external_metadata(&record.id, remote)
                            .map_err(failure)?;
                        refreshed.insert(record.id.clone(), updated);
                    }
                }
                self.observations.set(&record.id, display, started)?;
                state.advance(&record.id)?;
                states.insert(record.id.clone(), display);
            }
        }
        records
            .into_iter()
            .filter(|r| connection_id.is_none_or(|id| id == r.binding.connection_id))
            .map(|record| {
                let record = refreshed.remove(&record.id).unwrap_or(record);
                let state = states
                    .get(&record.id)
                    .copied()
                    .unwrap_or(WindowState::Unknown);
                self.summary(record, state)
            })
            .collect()
    }
    fn retain_running(state: &mut WindowManagerState, record: &WindowRecord) -> BrowserResult<()> {
        let snapshot = if let Some(active) = state.scheduler.status(&record.id) {
            if active.snapshot.binding != record.binding {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "运行中的窗口绑定与保存的环境不一致",
                ));
            }
            active.snapshot.clone()
        } else {
            state
                .scheduler
                .reserve(LaunchRequest {
                    window_id: record.id.clone(),
                    binding: record.binding.clone(),
                    proxy: ProxyBinding::Observed,
                })
                .map_err(|_| busy())?
        };
        state
            .scheduler
            .confirm_running(&snapshot)
            .map_err(|_| busy())
    }
    fn proxy(&self, record: &WindowRecord) -> BrowserResult<(ProxyBinding, ResolvedProxy)> {
        let (binding, url) = match record.proxy_mode {
            ProxyMode::Provider => (ProxyBinding::Provider, None),
            ProxyMode::Direct => (ProxyBinding::Direct, None),
            ProxyMode::Manual => (
                ProxyBinding::Configured {
                    server: record
                        .proxy
                        .clone()
                        .ok_or_else(|| failure("代理地址缺失"))?,
                },
                record.proxy.clone(),
            ),
            ProxyMode::Plugin => {
                let plugin = record
                    .proxy_plugin
                    .as_deref()
                    .ok_or_else(|| failure("代理插件缺失"))?;
                let host = self
                    .plugin_host
                    .as_ref()
                    .ok_or_else(|| BrowserError::new("invalid_config", "代理插件宿主不可用"))?;
                let resolved = host
                    .resolve_browser_proxy(plugin, &record.id, record.proxy_endpoint)
                    .map_err(|e| BrowserError::new("invalid_config", e.message()))?;
                if resolved.connection_url.trim().is_empty() {
                    return Err(BrowserError::new(
                        "invalid_config",
                        "代理插件未提供可用连接",
                    ));
                }
                (
                    ProxyBinding::Required {
                        plugin_id: plugin.into(),
                        config_handle: resolved.reference.config_handle,
                        secret_ref: resolved.reference.secret_ref,
                    },
                    Some(resolved.connection_url),
                )
            }
        };
        Ok((
            binding,
            ResolvedProxy {
                mode: record.proxy_mode,
                connection_url: url,
            },
        ))
    }
    fn transient(&self, record: &WindowRecord) -> BrowserResult<WindowRecord> {
        let mut transient = record.clone();
        let (_, proxy) = self.proxy(record)?;
        if record.proxy_mode == ProxyMode::Plugin {
            transient.proxy = proxy.connection_url;
        }
        Ok(transient)
    }
    fn check_external(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        destructive: bool,
    ) -> BrowserResult<()> {
        if connection.provider_id == BrowserProviderId::CloakBrowser {
            return Ok(());
        }
        let remote = self
            .registry
            .get(connection.provider_id)?
            .list_profiles(connection)?
            .into_iter()
            .find(|r| r.id == record.binding.profile_id)
            .ok_or_else(|| {
                BrowserError::new("profile_missing", "官方环境不可见，请核对账户和权限")
            })?;
        let saved = record.provider_config.get("identity");
        let current = remote.provider_config.get("identity");
        if saved.zip(current).is_some_and(|(a, b)| a != b) {
            return Err(BrowserError::new(
                "scope_mismatch",
                "环境身份已变化，已阻止操作",
            ));
        }
        let identity_present = |value: Option<&Value>| {
            value
                .and_then(Value::as_object)
                .is_some_and(|fields| !fields.is_empty())
        };
        if destructive && (!identity_present(saved) || !identity_present(current)) {
            return Err(BrowserError::new(
                "scope_mismatch",
                "缺少环境身份信息，请在官方应用操作，或重新接入环境",
            ));
        }
        Ok(())
    }
    fn validate_capabilities(&self, record: &WindowRecord, editing: bool) -> BrowserResult<()> {
        let capabilities = self
            .registry
            .get(record.binding.provider_id)?
            .capabilities();
        if (editing && !capabilities.update) || (!editing && !capabilities.create) {
            return Err(BrowserError::unsupported(
                "此浏览器当前不支持在工作台中修改这些配置，请在官方应用中操作",
            ));
        }
        if (record.proxy_mode == ProxyMode::Manual && !capabilities.manual_proxy)
            || (record.proxy_mode == ProxyMode::Plugin && !capabilities.proxy_plugin)
            || (record.settings.fingerprint_seed.is_some() && !capabilities.fingerprint_seed)
            || (record.kernel_version.is_some()
                && record.binding.provider_id == BrowserProviderId::CloakBrowser
                && !capabilities.kernel_selection)
            || (record.settings.geoip
                && record.proxy_mode != ProxyMode::Provider
                && !capabilities.geoip)
        {
            return Err(BrowserError::unsupported(
                "所选浏览器接入暂不支持此配置，请调整后重试",
            ));
        }
        Ok(())
    }
    pub fn create(&self, input: CreateWindowInput) -> BrowserResult<BrowserWindow> {
        let _guard = self.hold(&format!("operation:{}", input.operation_id))?;
        let _binding_guard = self.hold(&format!("bindings:{}", input.connection_id))?;
        let input_value = serde_json::to_value(&input).map_err(failure)?;
        if let Some(mut op) = self.operations.get(&input.operation_id)? {
            if op.kind != "create"
                || op.connection_id != input.connection_id
                || op.payload["input"] != input_value
            {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "同一创建操作的配置已改变",
                ));
            }
            if op.phase == "committed" {
                let record = self.store.get(&op.window_id).map_err(failure)?;
                let connection = self.connections.get(&op.connection_id)?;
                let state = self
                    .observe_states(&connection, std::slice::from_ref(&record))
                    .ok()
                    .and_then(|states| states.get(&record.binding.profile_id).copied())
                    .unwrap_or(WindowState::Unknown);
                return self.summary(record, state);
            }
            if op.phase == "cancelled" {
                return Err(BrowserError::new(
                    "operation_cancelled",
                    "此操作已由人工结束，请重新创建窗口",
                ));
            }
            let connection = self.connection(&op.connection_id, true)?;
            let _window_guard = self.hold(&op.window_id)?;
            if op.phase == "failed" {
                // A known rejection can be retried with the original UUID and draft.
                return self.execute_create(&connection, &mut op);
            }
            return self.reconcile_operation(&mut op)?.ok_or_else(uncertain);
        }
        let connection = self.connection(&input.connection_id, true)?;
        self.validate_group(input.group_id.as_deref())?;
        let builtin = connection.provider_id == BrowserProviderId::CloakBrowser;
        let id = uuid::Uuid::new_v4().to_string();
        let mut settings = input.settings.clone();
        if !builtin && (settings.fingerprint_seed.is_some() || input.kernel_version.is_some()) {
            return Err(BrowserError::unsupported(
                "此接入的内核和指纹由官方浏览器管理",
            ));
        }
        if builtin && settings.fingerprint_seed.is_none() {
            let seed = uuid::Uuid::new_v4();
            let bytes = seed.as_bytes();
            settings.fingerprint_seed = Some(
                (u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & 0x7fff_ffff).max(1),
            );
        }
        if builtin && input.proxy_mode == ProxyMode::Provider {
            return Err(BrowserError::new(
                "invalid_config",
                "内置浏览器需要明确代理来源",
            ));
        }
        let record = WindowRecord {
            schema_version: 2,
            id: id.clone(),
            name: input.name.trim().into(),
            binding: BrowserBinding {
                provider_id: connection.provider_id,
                connection_id: connection.id.clone(),
                profile_id: if builtin { id.clone() } else { String::new() },
            },
            binary_path: None,
            kernel_version: input.kernel_version.clone(),
            proxy: input.proxy.clone(),
            proxy_plugin: input.proxy_plugin.clone(),
            proxy_endpoint: input.proxy_endpoint,
            proxy_mode: input.proxy_mode,
            settings,
            origin: WindowOrigin::Created,
            provider_config: json!({}),
            created_at: now_seconds(),
            last_opened_at: None,
            sort_order: self.sequence()?,
        };
        validate_draft(&record).map_err(failure)?;
        self.validate_capabilities(&record, false)?;
        let mut op = self.operations.prepare(
            &input.operation_id,
            &id,
            &connection.id,
            "create",
            json!({"input":input_value,"record":record,"groupId":input.group_id}),
        )?;
        let _window_guard = self.hold(&op.window_id)?;
        self.execute_create(&connection, &mut op)
    }
    fn execute_create(
        &self,
        connection: &BrowserConnection,
        op: &mut BrowserOperation,
    ) -> BrowserResult<BrowserWindow> {
        let mut record: WindowRecord =
            serde_json::from_value(op.payload["record"].clone()).map_err(failure)?;
        self.validate_capabilities(&record, false)?;
        let transient = match self.transient(&record) {
            Ok(record) => record,
            Err(error) => {
                self.operations
                    .phase(op, "failed", Some(error.message.clone()))?;
                return Err(error);
            }
        };
        self.operations.phase(op, "submitted", None)?;
        match self
            .registry
            .get(connection.provider_id)?
            .create_profile(connection, &transient, &op.id)
        {
            Ok(created) => {
                record.binding.profile_id = created.profile_id;
                record.binary_path = created.binary_path;
                record.kernel_version = created.kernel_version;
                record.provider_config = created.provider_config;
                if connection.provider_id == BrowserProviderId::CloakBrowser {
                    record
                        .provider_config
                        .as_object_mut()
                        .ok_or_else(|| failure("创建结果缺少浏览器配置"))?
                        .remove("binaryPath");
                }
                op.payload["record"] = serde_json::to_value(&record).map_err(failure)?;
                self.operations.phase(op, "confirmed", None)?;
                self.commit_create(op, record)
            }
            Err(error) => {
                let phase = if known_rejection(&error) {
                    "failed"
                } else {
                    "uncertain"
                };
                self.operations
                    .phase(op, phase, Some(error.message.clone()))?;
                Err(error)
            }
        }
    }
    fn commit_create(
        &self,
        op: &mut BrowserOperation,
        record: WindowRecord,
    ) -> BrowserResult<BrowserWindow> {
        let group = op.payload["groupId"].as_str();
        if let Some(existing) = self
            .store
            .list()
            .map_err(failure)?
            .into_iter()
            .find(|existing| existing.id == record.id)
        {
            if existing != record {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "窗口已有不同配置，请检查待处理操作",
                ));
            }
        } else {
            self.store.insert(&record, group).map_err(failure)?;
        }
        let connection = self.connections.get(&record.binding.connection_id)?;
        let state = self
            .observe_states(&connection, std::slice::from_ref(&record))
            .ok()
            .and_then(|states| states.get(&record.binding.profile_id).copied())
            .unwrap_or(WindowState::Unknown);
        self.observations.set(&record.id, state, false)?;
        self.operations.phase(op, "committed", None)?;
        self.summary(record, state)
    }
    fn stopped(&self, connection: &BrowserConnection, record: &WindowRecord) -> BrowserResult<()> {
        let states = self.observe_states(connection, std::slice::from_ref(record))?;
        if states.get(&record.binding.profile_id) != Some(&WindowState::Stopped) {
            return Err(BrowserError::new(
                "profile_busy",
                "请先确认窗口已停止，再修改或删除环境",
            ));
        }
        Ok(())
    }
    pub fn update(&self, input: UpdateWindowInput) -> BrowserResult<()> {
        let _guard = self.hold(&input.id)?;
        if self.operations.window_pending(&input.id)? {
            return Err(uncertain());
        }
        let previous = self.store.get(&input.id).map_err(failure)?;
        self.validate_group(input.group_id.as_deref())?;
        if previous.settings.fingerprint_seed != input.settings.fingerprint_seed {
            return Err(BrowserError::new(
                "invalid_config",
                "已创建窗口的指纹种子不能修改",
            ));
        }
        let mut updated = previous.clone();
        updated.name = input.name.trim().into();
        updated.proxy = input.proxy;
        updated.proxy_plugin = input.proxy_plugin;
        updated.proxy_endpoint = input.proxy_endpoint;
        updated.proxy_mode = input.proxy_mode;
        updated.settings = input.settings;
        validate_draft(&updated).map_err(failure)?;
        let remote_changed = previous.name != updated.name
            || previous.proxy != updated.proxy
            || previous.proxy_plugin != updated.proxy_plugin
            || previous.proxy_endpoint != updated.proxy_endpoint
            || previous.proxy_mode != updated.proxy_mode
            || previous.settings.geoip != updated.settings.geoip
            || previous.settings.timezone != updated.settings.timezone
            || previous.settings.locale != updated.settings.locale
            || previous.settings.viewport != updated.settings.viewport
            || previous.settings.start_url != updated.settings.start_url;
        if !remote_changed {
            return self
                .store
                .save(&updated, input.group_id.as_deref())
                .map_err(failure);
        }
        let connection = self.connection(&previous.binding.connection_id, true)?;
        self.stopped(&connection, &previous)?;
        self.check_external(&connection, &previous, true)?;
        self.validate_capabilities(&updated, true)?;
        let proxy_source_changed = previous.proxy_mode != updated.proxy_mode
            || previous.proxy != updated.proxy
            || previous.proxy_plugin != updated.proxy_plugin
            || previous.proxy_endpoint != updated.proxy_endpoint;
        let transient = if proxy_source_changed {
            self.transient(&updated)?
        } else {
            updated.clone()
        };
        let provider = self.registry.get(connection.provider_id)?;
        let evidence = provider.prepare_update_evidence(&previous, &transient)?;
        let mut op = self.operations.prepare(
            &uuid::Uuid::new_v4().to_string(),
            &updated.id,
            &connection.id,
            "update",
            json!({"previous":previous,"record":updated,"groupId":input.group_id,"updateEvidence":evidence}),
        )?;
        self.operations.phase(&mut op, "submitted", None)?;
        match provider.update_profile(&connection, &previous, &transient) {
            Ok(()) => {
                self.operations.phase(&mut op, "confirmed", None)?;
                self.store
                    .save(&updated, input.group_id.as_deref())
                    .map_err(failure)?;
                self.operations.phase(&mut op, "committed", None)
            }
            Err(error) => {
                self.operations.phase(
                    &mut op,
                    if known_rejection(&error) {
                        "failed"
                    } else {
                        "uncertain"
                    },
                    Some(error.message.clone()),
                )?;
                Err(error)
            }
        }
    }
    pub fn update_note(&self, id: &str, note: &str) -> BrowserResult<String> {
        let _guard = self.hold(id)?;
        if self.operations.window_pending(id)? {
            return Err(uncertain());
        }
        self.store.update_note(id, note).map_err(failure)
    }
    pub(crate) fn delete_window(&self, id: &str, delete_environment: bool) -> BrowserResult<()> {
        let _guard = self.hold(id)?;
        if self.operations.window_pending(id)? {
            return Err(uncertain());
        }
        let record = self.store.get(id).map_err(failure)?;
        let connection = self.connections.get(&record.binding.connection_id)?;
        if delete_environment {
            self.connection(&connection.id, true)?;
            if !self
                .registry
                .get(connection.provider_id)?
                .capabilities()
                .delete_environment
            {
                return Err(BrowserError::unsupported("此浏览器不支持删除环境"));
            }
            self.stopped(&connection, &record)?;
            self.check_external(&connection, &record, true)?;
        } else if record.binding.provider_id == BrowserProviderId::CloakBrowser {
            return Err(BrowserError::unsupported("内置窗口请使用删除浏览器环境"));
        }
        let binding_plugins = self
            .plugin_host
            .as_ref()
            .map(|host| host.window_binding_plugins())
            .transpose()
            .map_err(|error| BrowserError::new("plugin_cleanup_failed", error.message()))?
            .unwrap_or_default();
        let mut op = self.operations.prepare(
            &uuid::Uuid::new_v4().to_string(),
            id,
            &connection.id,
            "delete",
            json!({"record":record,"deleteEnvironment":delete_environment,"bindingPlugins":binding_plugins}),
        )?;
        self.execute_delete(&connection, &record, &mut op)
    }
    fn execute_delete(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        op: &mut BrowserOperation,
    ) -> BrowserResult<()> {
        let delete_environment = op.payload["deleteEnvironment"]
            .as_bool()
            .ok_or_else(|| failure("删除操作数据损坏"))?;
        if delete_environment {
            self.operations.phase(op, "submitted", None)?;
            if let Err(error) = self
                .registry
                .get(connection.provider_id)?
                .delete_profile(connection, record)
            {
                self.operations.phase(
                    op,
                    if known_rejection(&error) {
                        "failed"
                    } else {
                        "uncertain"
                    },
                    Some(error.message.clone()),
                )?;
                return Err(error);
            }
        }
        self.operations.phase(op, "confirmed", None)?;
        self.finish_delete(op, record)
    }
    fn finish_delete(&self, op: &mut BrowserOperation, record: &WindowRecord) -> BrowserResult<()> {
        let targets: Vec<String> =
            serde_json::from_value(op.payload["bindingPlugins"].clone()).map_err(failure)?;
        if !targets.is_empty() {
            let host = self.plugin_host.as_ref().ok_or_else(|| {
                BrowserError::new("plugin_cleanup_failed", "请恢复插件宿主后重新检查删除操作")
            })?;
            if let Err(error) = host.detach_window_bindings(&record.id, &targets) {
                self.operations.phase(
                    op,
                    "confirmed",
                    Some("浏览器操作已完成，等待清理插件中的窗口关联".into()),
                )?;
                return Err(BrowserError::new("plugin_cleanup_failed", error.message()));
            }
        }
        if self
            .store
            .list()
            .map_err(failure)?
            .iter()
            .any(|window| window.id == record.id)
        {
            self.store.delete(&record.id).map_err(failure)?;
        }
        self.observations.delete(&record.id)?;
        self.release_snapshot(&record.id)?;
        self.operations.phase(op, "committed", None)
    }
    fn release_snapshot(&self, id: &str) -> BrowserResult<()> {
        let mut state = self.state.lock().map_err(failure)?;
        if let Some(active) = state.scheduler.status(id).cloned() {
            state
                .scheduler
                .release(&active.snapshot)
                .map_err(|_| busy())?;
        }
        Ok(())
    }
    fn accept_session(
        &self,
        record: &WindowRecord,
        actual: WindowState,
        owned: bool,
    ) -> BrowserResult<()> {
        let mut state = self.state.lock().map_err(failure)?;
        match actual {
            WindowState::Running => Self::retain_running(&mut state, record)?,
            WindowState::Stopped => {
                if let Some(active) = state.scheduler.status(&record.id).cloned() {
                    state
                        .scheduler
                        .release(&active.snapshot)
                        .map_err(|_| busy())?;
                }
            }
            _ => {
                if let Some(active) = state.scheduler.status(&record.id).cloned() {
                    state
                        .scheduler
                        .uncertain(&active.snapshot)
                        .map_err(|_| busy())?;
                }
            }
        }
        self.observations
            .set(&record.id, actual, owned && actual != WindowState::Stopped)?;
        state.advance(&record.id)
    }
    fn mark_start_uncertain(
        &self,
        op: &mut BrowserOperation,
        snapshot: &super::scheduler::LaunchSnapshot,
        message: String,
    ) -> BrowserResult<()> {
        self.state
            .lock()
            .map_err(failure)?
            .scheduler
            .uncertain(snapshot)
            .map_err(|_| busy())?;
        self.operations.phase(op, "uncertain", Some(message))?;
        self.observations
            .set(&op.window_id, WindowState::Unknown, true)
    }
    pub(crate) fn start_window(&self, id: &str) -> BrowserResult<()> {
        let _guard = self.hold(id)?;
        if self.operations.window_pending(id)? {
            return Err(uncertain());
        }
        let record = self.store.get(id).map_err(failure)?;
        let connection = self.connection(&record.binding.connection_id, true)?;
        self.check_external(&connection, &record, false)?;
        let observed = self.observe_states(&connection, std::slice::from_ref(&record))?;
        match observed.get(&record.binding.profile_id) {
            Some(WindowState::Running) => {
                let owned = self.observations.get(id)?.is_some_and(|o| o.nexus_started);
                self.accept_session(&record, WindowState::Running, owned)?;
                return Ok(());
            }
            Some(WindowState::Stopped) => {}
            _ => {
                return Err(BrowserError::new(
                    "unavailable",
                    "无法确认环境已停止，请刷新后重试",
                ));
            }
        }
        let capabilities = self.registry.get(connection.provider_id)?.capabilities();
        if (record.proxy_mode == ProxyMode::Plugin && !capabilities.proxy_plugin)
            || (record.proxy_mode == ProxyMode::Manual && !capabilities.manual_proxy)
        {
            return Err(BrowserError::unsupported("此接入不支持所选代理来源"));
        }
        self.release_snapshot(id)?;
        let (binding, proxy) = self.proxy(&record)?;
        let mut op = self.operations.prepare(
            &uuid::Uuid::new_v4().to_string(),
            id,
            &connection.id,
            "start",
            json!({"record":record}),
        )?;
        let snapshot = self
            .state
            .lock()
            .map_err(failure)?
            .scheduler
            .reserve(LaunchRequest {
                window_id: id.into(),
                binding: record.binding.clone(),
                proxy: binding,
            })
            .map_err(|_| busy())?;
        if let Err(error) = self.operations.phase(&mut op, "submitted", None) {
            self.release_snapshot(id)?;
            return Err(error);
        }
        let result =
            self.registry
                .get(connection.provider_id)?
                .start_profile(&connection, &record, &proxy);
        if let Err(error) = result {
            let observed = self
                .observe_states(&connection, std::slice::from_ref(&record))
                .ok()
                .and_then(|states| states.get(&record.binding.profile_id).copied())
                .unwrap_or(WindowState::Unknown);
            if known_rejection(&error)
                || (connection.provider_id == BrowserProviderId::CloakBrowser
                    && observed == WindowState::Stopped)
            {
                self.operations
                    .phase(&mut op, "failed", Some(error.message.clone()))?;
                self.accept_session(&record, observed, false)?;
            } else {
                self.mark_start_uncertain(&mut op, &snapshot, error.message.clone())?;
            }
            return Err(error);
        }
        let running = self
            .observe_states(&connection, std::slice::from_ref(&record))
            .ok()
            .is_some_and(|states| {
                states.get(&record.binding.profile_id) == Some(&WindowState::Running)
            });
        if !running {
            self.mark_start_uncertain(&mut op, &snapshot, "等待浏览器确认启动".into())?;
            return Err(uncertain());
        }
        self.operations.phase(&mut op, "confirmed", None)?;
        self.state
            .lock()
            .map_err(failure)?
            .scheduler
            .confirm_running(&snapshot)
            .map_err(|_| busy())?;
        self.observations.set(id, WindowState::Running, true)?;
        self.store.mark_opened(id).map_err(failure)?;
        self.operations.phase(&mut op, "committed", None)?;
        Ok(())
    }
    pub fn stop(&self, id: &str) -> BrowserResult<()> {
        let _guard = self.hold(id)?;
        let record = self.store.get(id).map_err(failure)?;
        if self.operations.window_pending(id)? {
            return Err(uncertain());
        }
        let connection = self.connection(&record.binding.connection_id, true)?;
        self.check_external(&connection, &record, false)?;
        let states = self.observe_states(&connection, std::slice::from_ref(&record))?;
        if states.get(&record.binding.profile_id) == Some(&WindowState::Stopped) {
            self.accept_session(&record, WindowState::Stopped, false)?;
            return Ok(());
        }
        let mut op = self.operations.prepare(
            &uuid::Uuid::new_v4().to_string(),
            id,
            &connection.id,
            "stop",
            json!({"record":record}),
        )?;
        self.operations.phase(&mut op, "submitted", None)?;
        {
            let mut state = self.state.lock().map_err(failure)?;
            if let Some(active) = state.scheduler.status(id).cloned() {
                state
                    .scheduler
                    .begin_stop(&active.snapshot)
                    .map_err(|_| busy())?;
            }
        }
        let result = self
            .registry
            .get(connection.provider_id)?
            .stop_profile(&connection, &record);
        if let Err(error) = result {
            if known_rejection(&error) {
                self.operations
                    .phase(&mut op, "failed", Some(error.message.clone()))?;
                let actual = self
                    .observe_states(&connection, std::slice::from_ref(&record))
                    .ok()
                    .and_then(|states| states.get(&record.binding.profile_id).copied())
                    .unwrap_or(WindowState::Unknown);
                let owned = self.observations.get(id)?.is_some_and(|o| o.nexus_started);
                self.accept_session(&record, actual, owned)?;
                return Err(error);
            }
            self.operations
                .phase(&mut op, "uncertain", Some(error.message.clone()))?;
            return Err(error);
        }
        let stopped = self
            .observe_states(&connection, std::slice::from_ref(&record))
            .ok()
            .is_some_and(|states| {
                states.get(&record.binding.profile_id) == Some(&WindowState::Stopped)
            });
        if !stopped {
            self.operations
                .phase(&mut op, "uncertain", Some("等待浏览器确认停止".into()))?;
            return Err(uncertain());
        }
        self.operations.phase(&mut op, "confirmed", None)?;
        self.accept_session(&record, WindowState::Stopped, false)?;
        self.operations.phase(&mut op, "committed", None)?;
        Ok(())
    }
    pub fn attach(&self, connection_id: &str, ids: &[String]) -> BrowserResult<Vec<BrowserWindow>> {
        let _guard = self.hold(&format!("bindings:{connection_id}"))?;
        if self
            .operations
            .list(Some(connection_id))?
            .iter()
            .any(|op| op.kind == "create")
        {
            return Err(BrowserError::new(
                "operation_uncertain",
                "此接入有尚未保存的创建结果，请先处理待核对操作后再接入已有环境",
            ));
        }
        let connection = self.connection(connection_id, true)?;
        let provider = self.registry.get(connection.provider_id)?;
        if !provider.capabilities().attach {
            return Err(BrowserError::unsupported("此浏览器不提供已有环境接入"));
        }
        let remote = provider.list_profiles(&connection)?;
        let mut result = Vec::new();
        for id in ids {
            let profile = remote
                .iter()
                .find(|r| r.id == *id)
                .ok_or_else(|| BrowserError::new("profile_missing", "所选环境不存在"))?;
            if let Some(existing) =
                self.store.list().map_err(failure)?.into_iter().find(|r| {
                    r.binding.connection_id == connection_id && r.binding.profile_id == *id
                })
            {
                let _window_guard = self.hold(&existing.id)?;
                if self.operations.window_pending(&existing.id)? {
                    return Err(uncertain());
                }
                let updated = self
                    .store
                    .refresh_external_metadata(&existing.id, profile)
                    .map_err(failure)?;
                result.push(self.summary(updated, WindowState::Unknown)?);
                continue;
            }
            let record = WindowRecord {
                schema_version: 2,
                id: uuid::Uuid::new_v4().to_string(),
                name: profile.name.clone(),
                binding: BrowserBinding {
                    provider_id: connection.provider_id,
                    connection_id: connection_id.into(),
                    profile_id: id.clone(),
                },
                binary_path: None,
                kernel_version: profile.kernel_version.clone(),
                proxy: None,
                proxy_plugin: None,
                proxy_endpoint: None,
                proxy_mode: ProxyMode::Provider,
                settings: WindowSettings::default(),
                origin: WindowOrigin::Attached,
                provider_config: profile.provider_config.clone(),
                created_at: now_seconds(),
                last_opened_at: None,
                sort_order: self.sequence()?,
            };
            self.store.insert(&record, None).map_err(failure)?;
            result.push(self.summary(record, WindowState::Unknown)?);
        }
        Ok(result)
    }
    pub fn reconcile(&self, id: &str) -> BrowserResult<Option<BrowserWindow>> {
        let _operation_guard = self.hold(&format!("operation:{id}"))?;
        let mut op = self
            .operations
            .get(id)?
            .ok_or_else(|| BrowserError::new("operation_missing", "待处理操作不存在"))?;
        let _binding_guard = (op.kind == "create")
            .then(|| self.hold(&format!("bindings:{}", op.connection_id)))
            .transpose()?;
        let _window_guard = self.hold(&op.window_id)?;
        self.reconcile_operation(&mut op)
    }
    pub fn resolve_operation(
        &self,
        input: ResolveOperationInput,
    ) -> BrowserResult<Option<BrowserWindow>> {
        let (id, confirmed) = match &input {
            ResolveOperationInput::Associate { id, confirmed, .. }
            | ResolveOperationInput::Abandon { id, confirmed } => (id, *confirmed),
        };
        if !confirmed {
            return Err(BrowserError::new(
                "invalid_config",
                "请先核对官方应用中的操作结果并明确确认",
            ));
        }
        let _operation_guard = self.hold(&format!("operation:{id}"))?;
        let mut op = self
            .operations
            .get(id)?
            .ok_or_else(|| BrowserError::new("operation_missing", "待处理操作不存在"))?;
        if !matches!(op.phase.as_str(), "submitted" | "uncertain") {
            return Err(BrowserError::new(
                "operation_conflict",
                "操作状态已改变，请刷新后重新核对",
            ));
        }
        let _binding_guard = (op.kind == "create")
            .then(|| self.hold(&format!("bindings:{}", op.connection_id)))
            .transpose()?;
        let _window_guard = self.hold(&op.window_id)?;
        let saved_connection = self.connections.get(&op.connection_id)?;
        if matches!(&input, ResolveOperationInput::Abandon { .. })
            && op.kind == "create"
            && saved_connection.provider_id != BrowserProviderId::CloakBrowser
        {
            if self
                .store
                .list()
                .map_err(failure)?
                .iter()
                .any(|window| window.id == op.window_id)
            {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "窗口已经保存，请重新核对本机提交结果",
                ));
            }
            let resolution = OperationResolution {
                action: "abandon".into(),
                provider_profile_id: None,
                observed_state: None,
                confirmed_at: now_seconds(),
            };
            self.operations.resolve(&mut op, resolution, "cancelled")?;
            return Ok(None);
        }
        let connection = self.connection(&op.connection_id, true)?;
        let provider = self.registry.get(connection.provider_id)?;
        let mut record: WindowRecord =
            serde_json::from_value(op.payload["record"].clone()).map_err(failure)?;
        match input {
            ResolveOperationInput::Associate {
                provider_profile_id,
                ..
            } => {
                if op.kind != "create" || !provider.capabilities().attach {
                    return Err(BrowserError::unsupported("此操作不支持关联已有环境"));
                }
                if self.store.list().map_err(failure)?.iter().any(|window| {
                    window.binding.connection_id == connection.id
                        && window.binding.profile_id == provider_profile_id
                        && window.id != op.window_id
                }) || self
                    .operations
                    .list(Some(&connection.id))?
                    .iter()
                    .any(|other| {
                        other.id != op.id
                            && other.kind == "create"
                            && other.payload["record"]["binding"]["profile_id"]
                                .as_str()
                                .is_some_and(|id| id == provider_profile_id)
                    })
                {
                    return Err(BrowserError::new(
                        "operation_conflict",
                        "所选环境已被其他窗口或待处理操作占用",
                    ));
                }
                let remote = provider
                    .list_profiles(&connection)?
                    .into_iter()
                    .find(|profile| profile.id == provider_profile_id)
                    .ok_or_else(|| BrowserError::new("profile_missing", "所选官方环境不可见"))?;
                if !remote.provider_config["identity"]
                    .as_object()
                    .is_some_and(|identity| !identity.is_empty())
                {
                    return Err(BrowserError::new(
                        "scope_mismatch",
                        "无法核对所选环境身份，请先在官方应用中检查账户和权限",
                    ));
                }
                record.binding.profile_id = remote.id;
                record.name = remote.name;
                record.kernel_version = remote.kernel_version;
                record.provider_config = remote.provider_config;
                record.origin = WindowOrigin::Attached;
                Self::inherit_provider_settings(&mut record);
                self.store
                    .validate_record(&record.id, &record)
                    .map_err(failure)?;
                op.payload["record"] = serde_json::to_value(&record).map_err(failure)?;
                let resolution = OperationResolution {
                    action: "associate".into(),
                    provider_profile_id: Some(record.binding.profile_id.clone()),
                    observed_state: None,
                    confirmed_at: now_seconds(),
                };
                self.operations.resolve(&mut op, resolution, "confirmed")?;
                self.commit_create(&mut op, record).map(Some)
            }
            ResolveOperationInput::Abandon { .. } => {
                if connection.provider_id == BrowserProviderId::CloakBrowser
                    && !matches!(op.kind.as_str(), "start" | "stop")
                {
                    return Err(BrowserError::unsupported(
                        "此本机操作需要通过重新核对完成恢复",
                    ));
                }
                let remote = if connection.provider_id != BrowserProviderId::CloakBrowser {
                    let remote = provider
                        .list_profiles(&connection)?
                        .into_iter()
                        .find(|remote| remote.id == record.binding.profile_id);
                    if let Some(remote) = &remote {
                        if record.provider_config["identity"] != remote.provider_config["identity"]
                        {
                            return Err(BrowserError::new(
                                "scope_mismatch",
                                "官方环境身份已变化，无法结束此操作",
                            ));
                        }
                    } else if op.kind != "delete" {
                        return Err(BrowserError::new("profile_missing", "官方环境不可见"));
                    }
                    remote
                } else {
                    None
                };
                let actual = self
                    .observe_states(&connection, std::slice::from_ref(&record))?
                    .get(&record.binding.profile_id)
                    .copied()
                    .unwrap_or(WindowState::Unknown);
                if !matches!(actual, WindowState::Stopped | WindowState::Running)
                    && !(op.kind == "delete" && actual == WindowState::Missing)
                {
                    return Err(uncertain());
                }
                let mut saved = self.store.get(&record.id).map_err(failure)?;
                if op.kind == "update" {
                    let remote = remote.ok_or_else(uncertain)?;
                    saved.name = remote.name;
                    saved.provider_config = remote.provider_config;
                    Self::inherit_provider_settings(&mut saved);
                    let group = self.store.group_id(&saved.id).map_err(failure)?;
                    self.store.save(&saved, group.as_deref()).map_err(failure)?;
                }
                let owned = self
                    .observations
                    .get(&saved.id)?
                    .is_some_and(|observation| observation.nexus_started);
                self.accept_session(&saved, actual, owned)?;
                let resolution = OperationResolution {
                    action: "abandon".into(),
                    provider_profile_id: Some(saved.binding.profile_id.clone()),
                    observed_state: Some(actual),
                    confirmed_at: now_seconds(),
                };
                self.operations.resolve(&mut op, resolution, "cancelled")?;
                self.summary(saved, actual).map(Some)
            }
        }
    }
    fn inherit_provider_settings(record: &mut WindowRecord) {
        record.proxy_mode = ProxyMode::Provider;
        record.proxy = None;
        record.proxy_plugin = None;
        record.proxy_endpoint = None;
        record.settings = WindowSettings {
            platform: record.settings.platform.clone(),
            note: record.settings.note.clone(),
            ..WindowSettings::default()
        };
    }
    fn reconcile_operation(
        &self,
        op: &mut BrowserOperation,
    ) -> BrowserResult<Option<BrowserWindow>> {
        if op.phase == "committed" {
            return self
                .store
                .list()
                .map_err(failure)?
                .into_iter()
                .find(|record| record.id == op.window_id)
                .map(|record| self.summary(record, WindowState::Unknown))
                .transpose();
        }
        if op.phase == "failed" {
            return Err(BrowserError::new(
                "operation_failed",
                "操作已被明确拒绝，请重新发起",
            ));
        }
        if op.phase == "cancelled" {
            return Err(BrowserError::new(
                "operation_cancelled",
                "此操作已由人工结束",
            ));
        }
        let mut record: WindowRecord =
            serde_json::from_value(op.payload["record"].clone()).map_err(failure)?;
        // Confirmed deletion only needs local cleanup, even when the vendor is offline.
        if op.kind == "delete" && op.phase == "confirmed" {
            self.finish_delete(op, &record)?;
            return Ok(None);
        }
        let connection = self.connection(&op.connection_id, true)?;
        let provider = self.registry.get(connection.provider_id)?;
        if op.kind == "create" {
            if op.phase == "prepared" {
                return self.execute_create(&connection, op).map(Some);
            }
            if op.phase == "confirmed" {
                return self.commit_create(op, record).map(Some);
            }
            let remote = provider
                .reconcile_create(&connection, &op.id)?
                .ok_or_else(uncertain)?;
            record.binding.profile_id = remote.id;
            record.kernel_version = remote.kernel_version;
            record.provider_config = remote.provider_config;
            if connection.provider_id == BrowserProviderId::CloakBrowser {
                record.binary_path = Some(PathBuf::from(
                    record
                        .provider_config
                        .get("binaryPath")
                        .and_then(Value::as_str)
                        .ok_or_else(|| failure("创建恢复记录缺少内核绑定"))?,
                ));
                record
                    .provider_config
                    .as_object_mut()
                    .ok_or_else(|| failure("创建恢复记录无效"))?
                    .remove("binaryPath");
            }
            self.store
                .validate_record(&record.id, &record)
                .map_err(failure)?;
            op.payload["record"] = serde_json::to_value(&record).map_err(failure)?;
            self.operations.phase(op, "confirmed", None)?;
            return self.commit_create(op, record).map(Some);
        }
        if op.kind == "delete" {
            if op.phase == "prepared" {
                if op.payload["deleteEnvironment"].as_bool() == Some(true) {
                    self.stopped(&connection, &record)?;
                    self.check_external(&connection, &record, true)?;
                }
                self.execute_delete(&connection, &record, op)?;
                return Ok(None);
            }
            if op.payload["deleteEnvironment"].as_bool() != Some(false)
                && !provider.reconcile_delete(&connection, &record)?
            {
                return Err(uncertain());
            }
            self.operations.phase(op, "confirmed", None)?;
            self.finish_delete(op, &record)?;
            return Ok(None);
        }
        if op.kind == "update" {
            if op.phase == "prepared" {
                self.operations
                    .phase(op, "failed", Some("配置尚未提交，可以重新保存".into()))?;
                return self
                    .summary(
                        self.store.get(&record.id).map_err(failure)?,
                        WindowState::Unknown,
                    )
                    .map(Some);
            }
            if op.phase != "confirmed" {
                let previous: WindowRecord =
                    serde_json::from_value(op.payload["previous"].clone()).map_err(failure)?;
                self.check_external(&connection, &previous, true)?;
                let evidence: UpdateEvidence =
                    serde_json::from_value(op.payload["updateEvidence"].clone())
                        .map_err(failure)?;
                if !provider.reconcile_update(&connection, &previous, &record, &evidence)? {
                    return Err(BrowserError::new(
                        "operation_uncertain",
                        "配置结果尚未确认，请在官方应用核对配置后重新检查",
                    ));
                }
                self.operations.phase(op, "confirmed", None)?;
            }
            self.store
                .save(&record, op.payload["groupId"].as_str())
                .map_err(failure)?;
            self.operations.phase(op, "committed", None)?;
            return self.summary(record, WindowState::Stopped).map(Some);
        }
        if !matches!(op.kind.as_str(), "start" | "stop") {
            return Err(failure("浏览器操作类型无效"));
        }
        self.check_external(&connection, &record, false)?;
        let observed = self.observe_states(&connection, std::slice::from_ref(&record))?;
        let actual = observed
            .get(&record.binding.profile_id)
            .copied()
            .unwrap_or(WindowState::Unknown);
        let desired = if op.kind == "start" {
            WindowState::Running
        } else {
            WindowState::Stopped
        };
        if actual != desired {
            if op.phase == "prepared"
                || (op.kind == "start"
                    && connection.provider_id == BrowserProviderId::CloakBrowser
                    && actual == WindowState::Stopped)
            {
                self.operations.phase(
                    op,
                    "failed",
                    Some("浏览器未执行此操作，可以重新发起".into()),
                )?;
                let owned = self
                    .observations
                    .get(&record.id)?
                    .is_some_and(|observation| observation.nexus_started);
                self.accept_session(&record, actual, owned)?;
                return self.summary(record, actual).map(Some);
            }
            return Err(uncertain());
        }
        self.accept_session(&record, desired, op.kind == "start")?;
        if op.kind == "start" {
            self.store.mark_opened(&record.id).map_err(failure)?;
        }
        self.operations.phase(op, "committed", None)?;
        self.summary(record, desired).map(Some)
    }
    pub(crate) fn lock_transfer(&self, ids: &[String]) -> Result<TransferGuard<'_>, String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        if state.installing
            || state.busy.contains("connections")
            || ids.iter().any(|id| {
                state.busy.contains(id)
                    || state.transfers.contains(id)
                    || state.recoveries.contains(id)
                    || state.scheduler.status(id).is_some()
            })
        {
            return Err("请先关闭窗口并等待已有操作完成".into());
        }
        for id in ids {
            if self
                .operations
                .window_pending(id)
                .map_err(|e| e.to_string())?
            {
                return Err("窗口有待确认操作".into());
            }
        }
        for id in ids {
            state.advance(id).map_err(|error| error.message)?;
        }
        state.transfers.extend(ids.iter().cloned());
        let guard = TransferGuard {
            service: self,
            ids: ids.to_vec(),
        };
        drop(state);
        // The reservation excludes lifecycle mutations while fresh provider facts are read.
        let records = self.store.list().map_err(|error| error.to_string())?;
        for record in records.iter().filter(|record| ids.contains(&record.id)) {
            let connection = self
                .connection(&record.binding.connection_id, true)
                .map_err(|error| error.message)?;
            self.stopped(&connection, record)
                .map_err(|error| error.message)?;
        }
        Ok(guard)
    }
    pub(crate) fn block_recovery(&self, ids: &[String]) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "窗口状态不可用")?
            .recoveries
            .extend(ids.iter().cloned());
        Ok(())
    }
    pub(crate) fn restore_imported(&self, records: &[WindowRecord]) -> Result<(), String> {
        for record in records {
            self.store
                .validate_record(&record.id, record)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(crate) fn lock_transfer_operation(self: &Arc<Self>) -> Result<AppOperationGuard, String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        if state.installing {
            return Err("应用正在安装更新".into());
        }
        state.transfer_operations += 1;
        Ok(AppOperationGuard {
            service: self.clone(),
            install: false,
        })
    }
    pub(crate) fn lock_app_install(self: &Arc<Self>) -> Result<AppOperationGuard, &'static str> {
        let guard = {
            let mut state = self.state.lock().map_err(|_| "profiles_failed")?;
            if state.installing
                || !state.busy.is_empty()
                || !state.transfers.is_empty()
                || !state.recoveries.is_empty()
                || state.transfer_operations > 0
                || state
                    .scheduler
                    .has_active_provider(BrowserProviderId::CloakBrowser)
                || !self
                    .operations
                    .list(None)
                    .map_err(|_| "profiles_failed")?
                    .is_empty()
            {
                return Err("running_windows");
            }
            state.installing = true;
            AppOperationGuard {
                service: self.clone(),
                install: true,
            }
        };
        let records = self.store.list().map_err(|_| "profiles_failed")?;
        let builtin: Vec<_> = records
            .into_iter()
            .filter(|r| r.binding.provider_id == BrowserProviderId::CloakBrowser)
            .collect();
        let connection = self
            .connections
            .get(BUILTIN_CONNECTION_ID)
            .map_err(|_| "profiles_failed")?;
        let observed = self
            .registry
            .get(BrowserProviderId::CloakBrowser)
            .map_err(|_| "profiles_failed")?
            .observe_profiles(&connection, &builtin)
            .map_err(|_| "profiles_failed")?
            .states;
        if builtin
            .iter()
            .any(|record| observed.get(&record.binding.profile_id) != Some(&WindowState::Stopped))
        {
            return Err("running_windows");
        }
        Ok(guard)
    }
}
struct WindowGuard<'a> {
    service: &'a WindowService,
    id: String,
}
impl Drop for WindowGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.service.state.lock() {
            state.busy.remove(&self.id);
        }
    }
}
pub(crate) struct TransferGuard<'a> {
    service: &'a WindowService,
    ids: Vec<String>,
}
impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.service.state.lock() {
            for id in &self.ids {
                state.transfers.remove(id);
            }
        }
    }
}
pub(crate) struct AppOperationGuard {
    service: Arc<WindowService>,
    install: bool,
}
impl Drop for AppOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.service.state.lock() {
            if self.install {
                state.installing = false;
            } else {
                state.transfer_operations = state.transfer_operations.saturating_sub(1);
            }
        }
    }
}

#[tauri::command]
pub async fn browser_window_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
) -> BrowserResult<Vec<BrowserWindow>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.list(connection_id.as_deref()))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_window_create(
    state: State<'_, Arc<WindowService>>,
    input: CreateWindowInput,
) -> BrowserResult<BrowserWindow> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.create(input))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_window_update(
    state: State<'_, Arc<WindowService>>,
    input: UpdateWindowInput,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.update(input))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_window_update_note(
    state: State<'_, Arc<WindowService>>,
    id: String,
    note: String,
) -> BrowserResult<String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.update_note(&id, &note))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_window_delete(
    state: State<'_, Arc<WindowService>>,
    id: String,
    delete_environment: bool,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.delete_window(&id, delete_environment))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_window_start(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.start_window(&id))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_window_stop(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.stop(&id))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_connection_list(
    state: State<'_, Arc<WindowService>>,
) -> BrowserResult<Vec<ConnectionView>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .connections
            .list()?
            .into_iter()
            .map(|connection| {
                let capabilities = state.registry.get(connection.provider_id)?.capabilities();
                Ok(ConnectionView {
                    connection,
                    capabilities,
                })
            })
            .collect()
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_connection_save(
    state: State<'_, Arc<WindowService>>,
    input: ConnectionInput,
) -> BrowserResult<ConnectionView> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state.hold_connections(input.provider_id, false)?;
        let connection = state.connections.save(input)?;
        let capabilities = state.registry.get(connection.provider_id)?.capabilities();
        Ok(ConnectionView {
            connection,
            capabilities,
        })
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_connection_probe(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<ProviderProbe> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.probe_connection(&id))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}

#[tauri::command]
pub async fn browser_connection_confirm(
    state: State<'_, Arc<WindowService>>,
    id: String,
    scope_label: String,
) -> BrowserResult<ConnectionView> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.confirm_connection(&id, &scope_label))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}

#[tauri::command]
pub async fn browser_connection_activate(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<ConnectionView> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.activate_connection(&id))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}

#[tauri::command]
pub async fn browser_profile_discover(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<Vec<RemoteProfile>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let connection = state.connection(&connection_id, false)?;
        state
            .registry
            .get(connection.provider_id)?
            .list_profiles(&connection)
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_group_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
) -> BrowserResult<Vec<ProviderGroup>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.connection_groups(&connection_id))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}

#[tauri::command]
pub async fn browser_window_attach(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    profile_ids: Vec<String>,
) -> BrowserResult<Vec<BrowserWindow>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.attach(&connection_id, &profile_ids))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_operation_list(
    state: State<'_, Arc<WindowService>>,
    connection_id: Option<String>,
) -> BrowserResult<Vec<OperationView>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(state
            .operations
            .list(connection_id.as_deref())?
            .into_iter()
            .map(OperationView::from)
            .collect())
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_operation_reconcile(
    state: State<'_, Arc<WindowService>>,
    operation_id: String,
) -> BrowserResult<Option<BrowserWindow>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.reconcile(&operation_id))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}
#[tauri::command]
pub async fn browser_operation_resolve(
    state: State<'_, Arc<WindowService>>,
    input: ResolveOperationInput,
) -> BrowserResult<Option<BrowserWindow>> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.resolve_operation(input))
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "浏览器操作任务中断，请重新检查结果"))?
}

#[cfg(test)]
#[path = "window_service_tests.rs"]
mod tests;
