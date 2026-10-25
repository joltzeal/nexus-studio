use super::kernel_service::{
    KernelFailure, KernelService, KernelStatus, sanitize_kernel_error as sanitize_license_error,
};
use super::license_store::LicenseStore;
use super::network_proxy::NetworkProxyStore;
use super::plugin_host::PluginHost;
use super::profile_store::{
    PreparedBinary, ProfileRecord, ProfileStore, ProxySource, StoreError, WindowSettings,
};
use super::runtime_paths::RuntimePaths;
use super::scheduler::{
    EngineCapacity, EngineChannel, LaunchRequest, LaunchSnapshot, Phase, ProxyBinding, Scheduler,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

struct Session {
    child: Child,
    snapshot: LaunchSnapshot,
    stop_requested: bool,
}

struct SessionState {
    scheduler: Scheduler,
    sessions: HashMap<String, Session>,
    transfers: HashSet<String>,
    recoveries: HashSet<String>,
    installing: bool,
    transfer_operations: usize,
}

const RECOVERY_PENDING: &str = "窗口资料恢复未完成，已暂停相关操作，请重启应用重试";
const APP_INSTALLING: &str = "应用正在安装更新或等待重启，请退出并重新打开应用后再操作";

pub struct ProfileService {
    pub(crate) store: ProfileStore,
    pub(crate) license_store: LicenseStore,
    pub(crate) runtime: RuntimePaths,
    pub(crate) kernels: KernelService,
    pub(crate) network: Option<NetworkProxyStore>,
    state: Mutex<SessionState>,
    /// When present, a window that requires a plugin proxy is resolved through
    /// it before a scheduler slot is reserved.
    plugin_host: Option<Arc<PluginHost>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    id: String,
    name: String,
    version: String,
    proxy: Option<String>,
    proxy_plugin: Option<String>,
    proxy_endpoint: Option<i64>,
    running: bool,
    settings: WindowSettings,
    group_id: Option<String>,
    /// Unix seconds; 0 for records written before the field existed.
    created_at: i64,
    last_opened_at: Option<i64>,
}

fn channel(record: &ProfileRecord) -> EngineChannel {
    EngineChannel {
        id: record.binding.channel_id.clone(),
        version: record.binding.channel_version.clone(),
        capacity: EngineCapacity::ProviderEnforced,
    }
}

fn error_message(error: StoreError) -> String {
    match error {
        StoreError::InvalidName => "名称需要包含 1 至 40 个字符".into(),
        StoreError::InvalidNote => "备注最多 120 个字符".into(),
        StoreError::InvalidProxy => "代理地址需要是无凭据的 HTTP 或 SOCKS5 主机及端口".into(),
        StoreError::InvalidProxyPlugin => "代理来源只能二选一：手动填写或代理插件".into(),
        StoreError::InvalidSettings => "浏览器配置无效，请检查表单内容".into(),
        StoreError::ImmutableFingerprint => "已创建窗口的指纹种子不能修改".into(),
        StoreError::InvalidBinary => "无法确认浏览器内核版本".into(),
        StoreError::InvalidProfileId => "窗口标识无效".into(),
        StoreError::CorruptProfile => "窗口绑定记录缺失或损坏，已拒绝启动".into(),
        StoreError::Io => "无法读写本机窗口数据目录".into(),
    }
}

impl ProfileService {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        Self::with_plugin_host(root, None)
    }

    pub fn with_plugin_host(
        root: PathBuf,
        plugin_host: Option<Arc<PluginHost>>,
    ) -> Result<Self, String> {
        let license_path = root
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("nexus.sqlite");
        Self::with_services(root, plugin_host, LicenseStore::new(license_path)?)
    }

    pub fn with_services(
        root: PathBuf,
        plugin_host: Option<Arc<PluginHost>>,
        license_store: LicenseStore,
    ) -> Result<Self, String> {
        Self::with_runtime(
            root,
            plugin_host,
            license_store,
            RuntimePaths::development(),
        )
    }

    pub fn with_runtime(
        root: PathBuf,
        plugin_host: Option<Arc<PluginHost>>,
        license_store: LicenseStore,
        runtime: RuntimePaths,
    ) -> Result<Self, String> {
        let store = ProfileStore::new(root);
        let mut scheduler = Scheduler::default();
        if let Ok(records) = store.list() {
            for record in records {
                let _ = scheduler.register_channel(channel(&record));
                scheduler
                    .restore_profile(record.binding)
                    .map_err(|_| "Profile 绑定记录冲突".to_string())?;
            }
        }
        Ok(Self {
            store,
            kernels: KernelService::new(license_store.clone(), runtime.clone()),
            license_store,
            runtime,
            network: None,
            state: Mutex::new(SessionState {
                scheduler,
                sessions: HashMap::new(),
                transfers: HashSet::new(),
                recoveries: HashSet::new(),
                installing: false,
                transfer_operations: 0,
            }),
            plugin_host,
        })
    }

    pub fn with_network(mut self, network: NetworkProxyStore) -> Self {
        self.kernels = self.kernels.with_network(network.clone());
        self.network = Some(network);
        self
    }

    pub fn list(&self) -> Result<Vec<ProfileSummary>, String> {
        let records = self.store.list().map_err(error_message)?;
        let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
        Self::reap(&mut state);
        records
            .into_iter()
            .map(|record| {
                Ok(ProfileSummary {
                    group_id: self.store.group_id(&record.id).map_err(error_message)?,
                    running: state.scheduler.status(&record.id).is_some_and(|status| {
                        status.phase == Phase::Running || status.phase == Phase::Stopping
                    }),
                    id: record.id,
                    name: record.name,
                    version: record.binding.channel_version,
                    proxy: record.proxy,
                    proxy_plugin: record.proxy_plugin,
                    proxy_endpoint: record.proxy_endpoint,
                    settings: record.settings,
                    created_at: record.created_at,
                    last_opened_at: record.last_opened_at,
                })
            })
            .collect::<Result<Vec<_>, String>>()
    }

    pub fn create(
        &self,
        name: String,
        proxy: ProxySource,
        settings: WindowSettings,
        group_id: Option<String>,
    ) -> Result<ProfileSummary, String> {
        let binary = self.kernels.prepare(None)?;
        self.create_prepared(&name, proxy, settings, binary, group_id.as_deref())
    }

    fn create_prepared(
        &self,
        name: &str,
        proxy: ProxySource,
        mut settings: WindowSettings,
        binary: PreparedBinary,
        group_id: Option<&str>,
    ) -> Result<ProfileSummary, String> {
        if settings.fingerprint_seed.is_none() {
            let random = uuid::Uuid::new_v4();
            let bytes = random.as_bytes();
            settings.fingerprint_seed = Some(
                (u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & 0x7fff_ffff).max(1),
            );
        }
        let record = self
            .store
            .create_with_group(name, proxy, settings, binary, group_id)
            .map_err(error_message)?;
        let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
        let _ = state.scheduler.register_channel(channel(&record));
        state
            .scheduler
            .restore_profile(record.binding.clone())
            .map_err(|_| "Profile 绑定记录冲突".to_string())?;
        Ok(ProfileSummary {
            id: record.id,
            name: record.name,
            version: record.binding.channel_version,
            proxy: record.proxy,
            proxy_plugin: record.proxy_plugin,
            proxy_endpoint: record.proxy_endpoint,
            running: false,
            settings: record.settings,
            group_id: group_id.map(str::to_owned),
            created_at: record.created_at,
            last_opened_at: record.last_opened_at,
        })
    }

    pub fn update(
        &self,
        id: &str,
        name: String,
        proxy: ProxySource,
        settings: WindowSettings,
        group_id: Option<String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        Self::reap(&mut state);
        if state.recoveries.contains(id) {
            return Err(RECOVERY_PENDING.into());
        }
        if state.transfers.contains(id) {
            return Err("窗口正在迁移，请等待操作完成".into());
        }
        if state.scheduler.status(id).is_some() {
            return Err("请先停止窗口，再修改浏览器配置".into());
        }
        self.store
            .update_with_group(id, &name, proxy, settings, group_id.as_deref())
            .map_err(error_message)?;
        Ok(())
    }

    pub fn update_note(&self, id: &str, note: &str) -> Result<String, String> {
        let state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        if state.installing {
            return Err(APP_INSTALLING.into());
        }
        if state.recoveries.contains(id) {
            return Err(RECOVERY_PENDING.into());
        }
        if state.transfers.contains(id) {
            return Err("窗口正在迁移，请等待操作完成".into());
        }
        // Notes are metadata and may be edited while the browser is running.
        self.store.update_note(id, note).map_err(error_message)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        Self::reap(&mut state);
        if state.recoveries.contains(id) {
            return Err(RECOVERY_PENDING.into());
        }
        if state.transfers.contains(id) {
            return Err("窗口正在迁移，请等待操作完成".into());
        }
        if state.scheduler.status(id).is_some() {
            return Err("请先停止窗口，再删除浏览器数据".into());
        }
        self.store.delete(id).map_err(error_message)?;
        state
            .scheduler
            .remove_profile(id)
            .map_err(|_| "窗口状态异常".to_string())?;
        Ok(())
    }

    pub fn launch(&self, id: &str) -> Result<(), String> {
        // Hold the profile before loading configuration or waiting on a plugin,
        // so an import cannot replace its data under this launch snapshot.
        let _guard = self.lock_profiles(&[id.to_owned()])?;
        let record = self.store.get(id).map_err(error_message)?;
        // Resolution happens before a slot is reserved: a plugin that cannot
        // produce a proxy must block the launch, never fall back to direct.
        let (proxy, connection_url) = match (&record.proxy_plugin, &record.proxy) {
            (Some(plugin_id), _) => {
                let host = self
                    .plugin_host
                    .as_ref()
                    .ok_or_else(|| "代理插件宿主未初始化，窗口启动被阻断".to_string())?;
                let resolved = host
                    .resolve_browser_proxy(plugin_id, &record.id, record.proxy_endpoint)
                    .map_err(|error| format!("窗口代理不可用：{}", error.message()))?;
                (
                    ProxyBinding::Required {
                        plugin_id: plugin_id.clone(),
                        config_handle: resolved.reference.config_handle,
                        secret_ref: resolved.reference.secret_ref,
                    },
                    Some(resolved.connection_url),
                )
            }
            (None, Some(server)) => (
                ProxyBinding::Configured {
                    server: server.clone(),
                },
                Some(server.clone()),
            ),
            (None, None) => (ProxyBinding::Direct, None),
        };
        let snapshot = {
            let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
            Self::reap(&mut state);
            state
                .scheduler
                .reserve(LaunchRequest {
                    window_id: record.id.clone(),
                    profile_id: record.id.clone(),
                    channel_id: record.binding.channel_id.clone(),
                    proxy,
                })
                .map_err(|error| format!("Profile 调度被拒绝：{error:?}"))?
        };
        match self.spawn_browser(&record, connection_url.as_deref()) {
            Ok(child) => {
                let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
                state
                    .scheduler
                    .mark_running(&snapshot)
                    .map_err(|error| format!("Profile 状态异常：{error:?}"))?;
                state.sessions.insert(
                    id.to_owned(),
                    Session {
                        child,
                        snapshot,
                        stop_requested: false,
                    },
                );
                drop(state);
                // Display data only: a failed timestamp write must not undo a
                // window that is already up.
                let _ = self.store.mark_opened(id);
                Ok(())
            }
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    let _ = state.scheduler.start_failed(&snapshot);
                }
                Err(error)
            }
        }
    }

    fn spawn_browser(
        &self,
        record: &ProfileRecord,
        connection_url: Option<&str>,
    ) -> Result<Child, String> {
        let launch_record = browser_launch_record(record, connection_url)?;
        let user_data = self
            .store
            .user_data_dir(&record.id)
            .map_err(error_message)?;
        let license_key = self.license_store.require_key()?;
        let mut command = Command::new(&self.runtime.node);
        if let Some(network) = &self.network {
            network
                .get()?
                .apply_to_node(&mut command, &self.runtime.network_preload)?;
        }
        command
            .arg(&self.runtime.browser_script)
            .arg("launch")
            .arg(user_data)
            .env(
                "CLOAKBROWSER_CACHE_DIR",
                self.license_store.browser_cache_dir(),
            )
            .env("CLOAKBROWSER_LICENSE_KEY", license_key)
            .env("CLOAKBROWSER_AUTO_UPDATE", "false")
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|_| "无法启动浏览器适配进程")?;
        // Runtime credentials travel over stdin only; the saved record stays opaque.
        let config = serde_json::to_vec(&launch_record).map_err(|_| "窗口配置无法编码")?;
        if child.stdin.as_mut().is_none_or(|stdin| {
            stdin.write_all(&config).is_err() || stdin.write_all(b"\n").is_err()
        }) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法将窗口配置传给浏览器".into());
        }
        let stdout = child.stdout.take().ok_or("无法读取浏览器启动状态")?;
        let stderr = child.stderr.take().ok_or("无法读取浏览器启动错误")?;
        let (sender, receiver) = std::sync::mpsc::channel::<Result<(), ()>>();
        let stdout_reader = std::thread::spawn(move || {
            let mut notified = false;
            for line in BufReader::new(stdout).lines() {
                if !notified && line.is_ok_and(|value| value == "NEXUS_READY") {
                    let _ = sender.send(Ok(()));
                    notified = true;
                }
            }
            if !notified {
                let _ = sender.send(Err(()));
            }
        });
        let stderr_reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut stderr = stderr;
            let mut buffer = [0; 1024];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        let remaining = 8192usize.saturating_sub(bytes.len());
                        bytes.extend_from_slice(&buffer[..length.min(remaining)]);
                    }
                }
            }
            String::from_utf8_lossy(&bytes).trim().to_owned()
        });
        match receiver.recv_timeout(Duration::from_secs(120)) {
            Ok(Ok(())) => Ok(child),
            _ => {
                // Losing the startup channel also ends the launch. A live
                // runner must not keep this wait blocked after stdout closes.
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let detail = stderr_reader.join().unwrap_or_default();
                if detail.is_empty() {
                    Err("窗口启动失败或超时，请检查所选代理与内核；原窗口数据已保留".into())
                } else {
                    Err(sanitize_license_error(&detail))
                }
            }
        }
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
        Self::reap(&mut state);
        let snapshot = state
            .sessions
            .get(id)
            .ok_or("Profile 当前没有运行")?
            .snapshot
            .clone();
        state
            .scheduler
            .begin_stop(&snapshot)
            .map_err(|error| format!("停止状态异常：{error:?}"))?;
        let mut session = state.sessions.remove(id).ok_or("Profile 当前没有运行")?;
        drop(state);
        if !session.stop_requested {
            if let Some(mut stdin) = session.child.stdin.take() {
                let _ = stdin.write_all(b"stop\n");
            }
            session.stop_requested = true;
        }
        for _ in 0..400 {
            match session.child.try_wait() {
                Ok(Some(_)) => {
                    let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
                    state
                        .scheduler
                        .finish_stop(&snapshot)
                        .map_err(|error| format!("停止状态异常：{error:?}"))?;
                    return Ok(());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => {
                    if let Ok(mut state) = self.state.lock() {
                        state.sessions.insert(id.to_owned(), session);
                    }
                    return Err("无法确认浏览器已退出".into());
                }
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.sessions.insert(id.to_owned(), session);
        }
        Err("浏览器尚未完成关闭；Profile 保持占用".into())
    }

    fn reap(state: &mut SessionState) {
        let exited: Vec<_> = state
            .sessions
            .iter_mut()
            .filter_map(|(id, session)| match session.child.try_wait() {
                Ok(Some(_)) => Some(id.clone()),
                _ => None,
            })
            .collect();
        for id in exited {
            if let Some(session) = state.sessions.remove(&id) {
                let _ = state.scheduler.process_exited(&session.snapshot);
            }
        }
    }

    pub(crate) fn lock_transfer(&self, ids: &[String]) -> Result<TransferGuard<'_>, String> {
        self.lock_profiles(ids)
    }

    pub(crate) fn lock_app_install(self: &Arc<Self>) -> Result<AppOperationGuard, &'static str> {
        let mut state = self.state.lock().map_err(|_| "profiles_failed")?;
        Self::reap(&mut state);
        if !state.recoveries.is_empty() {
            return Err("profiles_failed");
        }
        if state.installing
            || !state.scheduler.is_idle()
            || !state.sessions.is_empty()
            || !state.transfers.is_empty()
            || state.transfer_operations != 0
        {
            return Err("running_windows");
        }
        state.installing = true;
        Ok(AppOperationGuard {
            service: Arc::clone(self),
            operation: AppOperation::Install,
        })
    }

    /// Covers preparation and asynchronous sync transport before profile IDs are locked.
    pub(crate) fn lock_transfer_operation(self: &Arc<Self>) -> Result<AppOperationGuard, String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        if state.installing {
            return Err(APP_INSTALLING.into());
        }
        state.transfer_operations += 1;
        Ok(AppOperationGuard {
            service: Arc::clone(self),
            operation: AppOperation::Transfer,
        })
    }

    fn lock_profiles(&self, ids: &[String]) -> Result<TransferGuard<'_>, String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        Self::reap(&mut state);
        if state.installing {
            return Err(APP_INSTALLING.into());
        }
        if ids.iter().any(|id| state.recoveries.contains(id)) {
            return Err(RECOVERY_PENDING.into());
        }
        if ids
            .iter()
            .any(|id| state.transfers.contains(id) || state.scheduler.status(id).is_some())
        {
            return Err("请先关闭所选窗口，且等待已有迁移操作完成".into());
        }
        state.transfers.extend(ids.iter().cloned());
        Ok(TransferGuard {
            service: self,
            ids: ids.to_vec(),
        })
    }

    pub(crate) fn block_recovery(&self, ids: &[String]) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "窗口状态不可用")?
            .recoveries
            .extend(ids.iter().cloned());
        Ok(())
    }

    pub(crate) fn restore_imported(&self, records: &[ProfileRecord]) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        for record in records {
            let _ = state.scheduler.remove_profile(&record.id);
            let _ = state.scheduler.register_channel(channel(record));
            state
                .scheduler
                .restore_profile(record.binding.clone())
                .map_err(|_| "导入窗口的内核绑定冲突")?;
        }
        Ok(())
    }
}

enum AppOperation {
    Install,
    Transfer,
}

pub(crate) struct AppOperationGuard {
    service: Arc<ProfileService>,
    operation: AppOperation,
}

impl Drop for AppOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.service.state.lock() {
            match self.operation {
                AppOperation::Install => state.installing = false,
                AppOperation::Transfer => state.transfer_operations -= 1,
            }
        }
    }
}

pub(crate) struct TransferGuard<'a> {
    service: &'a ProfileService,
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

fn browser_launch_record(
    record: &ProfileRecord,
    connection_url: Option<&str>,
) -> Result<ProfileRecord, String> {
    if record.proxy_plugin.is_some() && connection_url.is_none_or(|url| url.trim().is_empty()) {
        return Err("所选代理没有提供连接信息，窗口启动被阻断".into());
    }
    let mut launch_record = record.clone();
    launch_record.proxy = connection_url.map(str::to_owned);
    Ok(launch_record)
}

#[tauri::command]
pub async fn kernel_status(
    state: State<'_, Arc<ProfileService>>,
    refresh: Option<bool>,
) -> Result<KernelStatus, KernelFailure> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .kernels
            .status(refresh.unwrap_or(false))
            .map_err(KernelFailure::operation)
    })
    .await
    .map_err(|_| KernelFailure::operation("内核状态读取中断"))?
}

#[tauri::command]
pub async fn kernel_download(
    state: State<'_, Arc<ProfileService>>,
) -> Result<String, KernelFailure> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .kernels
            .prepare(None)
            .map(|binary| binary.version)
            .map_err(|message| state.kernels.failure(message))
    })
    .await
    .map_err(|_| KernelFailure::operation("内核下载任务中断"))?
}

#[tauri::command]
pub fn profile_list(state: State<'_, Arc<ProfileService>>) -> Result<Vec<ProfileSummary>, String> {
    state.list()
}

/// A Tauri command receives flat arguments; the three proxy fields are folded
/// into one `ProxySource` before they reach the store.
#[tauri::command]
pub async fn profile_create(
    state: State<'_, Arc<ProfileService>>,
    name: String,
    proxy: Option<String>,
    proxy_plugin: Option<String>,
    proxy_endpoint: Option<i64>,
    settings: WindowSettings,
    group_id: Option<String>,
) -> Result<ProfileSummary, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.create(
            name,
            ProxySource {
                server: proxy,
                plugin: proxy_plugin,
                endpoint: proxy_endpoint,
            },
            settings,
            group_id,
        )
    })
    .await
    .map_err(|_| "Profile 创建任务中断".to_string())?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn profile_update(
    state: State<'_, Arc<ProfileService>>,
    id: String,
    name: String,
    proxy: Option<String>,
    proxy_plugin: Option<String>,
    proxy_endpoint: Option<i64>,
    settings: WindowSettings,
    group_id: Option<String>,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.update(
            &id,
            name,
            ProxySource {
                server: proxy,
                plugin: proxy_plugin,
                endpoint: proxy_endpoint,
            },
            settings,
            group_id,
        )
    })
    .await
    .map_err(|_| "窗口修改任务中断".to_string())?
}

#[tauri::command]
pub async fn profile_update_note(
    state: State<'_, Arc<ProfileService>>,
    id: String,
    note: String,
) -> Result<String, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.update_note(&id, &note))
        .await
        .map_err(|_| "备注保存任务中断".to_string())?
}

#[tauri::command]
pub async fn profile_delete(
    state: State<'_, Arc<ProfileService>>,
    id: String,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.delete(&id))
        .await
        .map_err(|_| "窗口删除任务中断".to_string())?
}

#[tauri::command]
pub async fn profile_launch(
    state: State<'_, Arc<ProfileService>>,
    id: String,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.launch(&id))
        .await
        .map_err(|_| "Profile 启动任务中断".to_string())?
}

#[tauri::command]
pub async fn profile_stop(state: State<'_, Arc<ProfileService>>, id: String) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.stop(&id))
        .await
        .map_err(|_| "Profile 停止任务中断".to_string())?
}

#[cfg(test)]
#[path = "profile_install_tests.rs"]
mod install_tests;

#[cfg(test)]
mod tests {
    use super::ProfileService;
    use crate::core::license_store::LicenseStore;
    use crate::core::profile_store::{PreparedBinary, ProxySource, WindowSettings};
    use crate::core::runtime_paths::RuntimePaths;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn kernel_fixture(
        plan: Option<&str>,
    ) -> (tempfile::TempDir, ProfileService, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("preparation.json");
        let runner = root.path().join("runner.cjs");
        std::fs::write(root.path().join("latest-version"), "155.0.8059.39").unwrap();
        std::fs::write(
            &runner,
            format!(
                r#"const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'prepare') process.exit(42);
const version = fs.readFileSync(path.join(__dirname, 'latest-version'), 'utf8');
const binary = path.join(__dirname, 'browser-' + version);
fs.writeFileSync(binary, 'fixture');
fs.writeFileSync({}, JSON.stringify({{hasKey: Boolean(process.env.CLOAKBROWSER_LICENSE_KEY), requestedVersion: process.env.CLOAKBROWSER_VERSION ?? null, autoUpdate: process.env.CLOAKBROWSER_AUTO_UPDATE}}));
process.stdout.write(JSON.stringify({{version, binary_path: binary}}));"#,
                serde_json::to_string(&capture).unwrap(),
            ),
        )
        .unwrap();
        let licenses = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();
        if let Some(plan) = plan {
            licenses
                .save_validated("synthetic-kernel-key", plan, None)
                .unwrap();
        }
        let service = ProfileService::with_runtime(
            root.path().join("profiles"),
            None,
            licenses,
            RuntimePaths {
                node: "node".into(),
                browser_script: runner,
                network_preload: root.path().join("unused-preload.js"),
            },
        )
        .unwrap();
        (root, service, capture)
    }

    #[test]
    fn new_windows_always_request_latest_with_the_saved_activation() {
        for plan in ["free", "pro"] {
            let (_root, service, capture) = kernel_fixture(Some(plan));
            let window = service
                .create(
                    "New window".into(),
                    ProxySource::direct(),
                    WindowSettings::default(),
                    None,
                )
                .unwrap();
            assert_eq!(window.version, "155.0.8059.39");
            let preparation: serde_json::Value =
                serde_json::from_slice(&std::fs::read(capture).unwrap()).unwrap();
            assert_eq!(preparation["hasKey"], true);
            assert_eq!(preparation["autoUpdate"], "true");
            assert!(preparation["requestedVersion"].is_null());
        }
    }

    #[test]
    fn missing_activation_blocks_creation_before_starting_the_adapter() {
        let (_root, service, capture) = kernel_fixture(None);
        let error = service
            .create(
                "Unavailable window".into(),
                ProxySource::direct(),
                WindowSettings::default(),
                None,
            )
            .err()
            .unwrap();
        assert!(error.contains("激活码"));
        assert!(!capture.exists());
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn removing_activation_blocks_launch_and_releases_the_reservation() {
        let (_root, service, capture) = kernel_fixture(Some("free"));
        let window = service
            .create(
                "Window".into(),
                ProxySource::direct(),
                WindowSettings::default(),
                None,
            )
            .unwrap();
        std::fs::remove_file(&capture).unwrap();
        service.license_store.remove().unwrap();
        assert!(service.launch(&window.id).unwrap_err().contains("激活码"));
        assert!(!capture.exists());
        assert!(!service.list().unwrap()[0].running);
        let state = service.state.lock().unwrap();
        assert!(state.scheduler.status(&window.id).is_none());
        assert!(!state.transfers.contains(&window.id));
    }

    #[test]
    fn a_new_release_does_not_rebind_existing_windows_after_restart() {
        let (root, service, _capture) = kernel_fixture(Some("free"));
        let first = service
            .create(
                "First window".into(),
                ProxySource::direct(),
                WindowSettings::default(),
                None,
            )
            .unwrap();
        let original = service.store.get(&first.id).unwrap();
        std::fs::write(root.path().join("latest-version"), "156.0.1.2").unwrap();
        let next = service
            .create(
                "Next window".into(),
                ProxySource::direct(),
                WindowSettings::default(),
                None,
            )
            .unwrap();
        assert_eq!(next.version, "156.0.1.2");
        let reopened = ProfileService::new(root.path().join("profiles")).unwrap();
        assert_eq!(reopened.store.get(&first.id).unwrap(), original);
        assert_eq!(reopened.list().unwrap().len(), 2);
    }

    #[test]
    fn preparation_process_that_never_exits_returns_an_error() {
        let mut command = Command::new("node");
        command.arg("-e").arg("setInterval(() => {}, 1000)");
        let started = Instant::now();
        let result = crate::core::kernel_service::run_preparation(
            &mut command,
            Duration::from_millis(150),
            None,
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn creating_a_window_returns_its_saved_record_without_a_list_refresh() {
        let root = tempfile::tempdir().unwrap();
        let binary_path = root.path().join("browser");
        std::fs::write(&binary_path, b"binary").unwrap();
        let service = ProfileService::new(root.path().join("profiles")).unwrap();
        let created = service
            .create_prepared(
                "New window",
                ProxySource::direct(),
                WindowSettings::default(),
                PreparedBinary {
                    version: "155.0.8059.39".into(),
                    binary_path,
                },
                None,
            )
            .unwrap();
        assert_eq!(created.name, "New window");
        assert_eq!(created.version, "155.0.8059.39");
        assert!(!created.running);
        assert!(created.settings.geoip);
        assert!(
            created
                .settings
                .fingerprint_seed
                .is_some_and(|seed| seed > 0)
        );
        assert_eq!(service.list().unwrap()[0].id, created.id);
    }

    #[test]
    fn resolved_proxy_is_only_in_the_launch_record_and_never_written_to_the_profile() {
        let root = tempfile::tempdir().unwrap();
        let binary_path = root.path().join("browser");
        std::fs::write(&binary_path, b"binary").unwrap();
        let service = ProfileService::new(root.path().join("profiles")).unwrap();
        let created = service
            .create_prepared(
                "Proxy window",
                ProxySource::plugin("studio.proxy-pool".into(), Some(7)),
                WindowSettings::default(),
                PreparedBinary {
                    version: "155.0.8059.39".into(),
                    binary_path,
                },
                None,
            )
            .unwrap();
        let saved = service.store.get(&created.id).unwrap();
        assert!(super::browser_launch_record(&saved, None).is_err());
        let connection = "socks5://account:p%40ss@selected.example:1080";
        let launching = super::browser_launch_record(&saved, Some(connection)).unwrap();
        assert_eq!(launching.proxy.as_deref(), Some(connection));
        assert_eq!(launching.proxy_endpoint, Some(7));
        assert_eq!(launching.binding, saved.binding);
        assert!(service.store.get(&created.id).unwrap().proxy.is_none());
        assert!(!serde_json::to_string(&saved).unwrap().contains("p%40ss"));
    }

    #[test]
    fn closed_startup_output_terminates_the_runner_and_releases_the_window() {
        let root = tempfile::tempdir().unwrap();
        let binary_path = root.path().join("browser");
        std::fs::write(&binary_path, b"binary").unwrap();
        let runner = root.path().join(format!(
            "closed-startup-output{}",
            std::env::consts::EXE_SUFFIX
        ));
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/closed-startup-output.rs");
        let compiled = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg("--edition=2024")
            .arg("--crate-name=nexus_closed_startup_output")
            .arg(fixture)
            .arg("-o")
            .arg(&runner)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "failed to compile startup fixture: {}",
            String::from_utf8_lossy(&compiled.stderr),
        );
        let marker = root.path().join("runner-started");
        let service = ProfileService::with_runtime(
            root.path().join("profiles"),
            None,
            LicenseStore::new(root.path().join("nexus.sqlite")).unwrap(),
            RuntimePaths {
                node: runner,
                browser_script: marker.clone(),
                network_preload: root.path().join("unused-preload.js"),
            },
        )
        .unwrap();
        service
            .license_store
            .save_validated("synthetic-startup-key", "free", None)
            .unwrap();
        let created = service
            .create_prepared(
                "Proxy startup",
                ProxySource::server("http://127.0.0.1:8080".into()),
                WindowSettings::default(),
                PreparedBinary {
                    version: "155.0.8059.39".into(),
                    binary_path,
                },
                None,
            )
            .unwrap();
        let started = Instant::now();
        assert!(service.launch(&created.id).is_err());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "a runner that loses its startup channel must not keep the launch waiting"
        );
        assert!(!service.list().unwrap()[0].running);
        assert_eq!(std::fs::read(&marker).unwrap(), b"configuration received");
        let state = service.state.lock().unwrap();
        assert!(state.scheduler.status(&created.id).is_none());
        assert!(!state.sessions.contains_key(&created.id));
        assert!(!state.transfers.contains(&created.id));
    }

    #[test]
    #[ignore = "downloads or uses a local CloakBrowser binary and opens a visible window"]
    fn creates_launches_stops_and_reloads_a_profile() {
        let root = tempfile::tempdir().unwrap();
        let service = ProfileService::new(root.path().join("profiles")).unwrap();
        let key = std::env::var("NEXUS_TEST_LICENSE_KEY")
            .expect("set NEXUS_TEST_LICENSE_KEY for this opt-in integration test");
        crate::core::license_service::LicenseService::new(
            service.license_store.clone(),
            service.license_store.browser_cache_dir(),
        )
        .set_key(key)
        .unwrap();
        service
            .create(
                "Smoke Profile".into(),
                ProxySource::direct(),
                WindowSettings::default(),
                None,
            )
            .unwrap();
        let created = service.list().unwrap();
        assert_eq!(created.len(), 1);
        let id = created[0].id.clone();
        let version = created[0].version.clone();
        service.launch(&id).unwrap();
        assert!(service.list().unwrap()[0].running);
        service.stop(&id).unwrap();
        assert!(!service.list().unwrap()[0].running);
        let restarted = ProfileService::new(root.path().join("profiles")).unwrap();
        assert_eq!(restarted.list().unwrap()[0].version, version);
    }

    #[test]
    fn license_errors_are_actionable_and_never_echo_secrets() {
        assert_eq!(
            super::sanitize_license_error(
                "CloakBrowser Pro: license key is invalid or expired: cb_secret"
            ),
            "激活服务未接受此激活码，请在设置中重新校验"
        );
        assert_eq!(
            super::sanitize_license_error("session limit reached"),
            "同时打开的窗口已达上限，请先关闭其他窗口"
        );
    }

    #[test]
    fn preparation_preserves_safe_download_failure_details() {
        let detail = "[cloakbrowser] downloading cb_secret\nNEXUS_KERNEL_ERROR {\"code\":\"NOT_FOUND\",\"message\":\"当前平台的内核下载不可用（HTTP 404），请稍后重试。\",\"retryable\":false}\n";
        assert_eq!(
            super::sanitize_license_error(detail),
            "当前平台的内核下载不可用（HTTP 404），请稍后重试。"
        );
    }
}
