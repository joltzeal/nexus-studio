use super::license_store::LicenseStore;
use super::plugin_host::PluginHost;
use super::profile_store::{
    PreparedBinary, ProfileRecord, ProfileStore, ProxySource, StoreError, WindowSettings,
};
use super::runtime_paths::RuntimePaths;
use super::scheduler::{
    EngineCapacity, EngineChannel, LaunchRequest, LaunchSnapshot, Phase, ProxyBinding, Scheduler,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

struct Session {
    child: Child,
    snapshot: LaunchSnapshot,
    stop_requested: bool,
}

struct SessionState {
    scheduler: Scheduler,
    sessions: HashMap<String, Session>,
}

pub struct ProfileService {
    store: ProfileStore,
    license_store: LicenseStore,
    runtime: RuntimePaths,
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

fn run_preparation(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "未找到 Node.js 运行时，请从项目根目录启动桌面开发命令")?;
    // Drain both streams while the SDK downloads: waiting with full pipes can block the child.
    let stdout = child.stdout.take().ok_or("无法读取内核准备结果")?;
    let stderr = child.stderr.take().ok_or("无法读取内核准备错误")?;
    let out_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let err_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => break Err("内核准备超时，请检查网络后重试".to_string()),
            Err(_) => break Err("无法等待内核准备进程".to_string()),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(Output {
        status: status?,
        stdout,
        stderr,
    })
}

fn error_message(error: StoreError) -> String {
    match error {
        StoreError::InvalidName => "名称需要包含 1 至 40 个字符".into(),
        StoreError::InvalidProxy => "代理地址需要是无凭据的 HTTP 或 SOCKS5 主机及端口".into(),
        StoreError::InvalidProxyPlugin => "代理来源只能二选一：手动填写或代理插件".into(),
        StoreError::InvalidSettings => "浏览器配置无效，请检查表单内容".into(),
        StoreError::ImmutableFingerprint => "已创建窗口的指纹种子不能修改".into(),
        StoreError::InvalidBinary => "无法确认 CloakBrowser 二进制版本".into(),
        StoreError::InvalidProfileId => "Profile 标识无效".into(),
        StoreError::CorruptProfile => "Profile 绑定记录缺失或损坏，已拒绝启动".into(),
        StoreError::Io => "无法读写本机 Profile 目录".into(),
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
            license_store,
            runtime,
            state: Mutex::new(SessionState {
                scheduler,
                sessions: HashMap::new(),
            }),
            plugin_host,
        })
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
        browser_version: Option<String>,
        group_id: Option<String>,
    ) -> Result<ProfileSummary, String> {
        let script = &self.runtime.browser_script;
        if !script.is_file() {
            return Err("浏览器适配器未构建，请从项目根目录启动桌面开发命令".into());
        }
        let license_key = self.license_store.license_key()?;
        let status = self.license_store.status()?;
        if browser_version.is_some() && !can_pin_browser_version(status.plan.as_deref()) {
            return Err("固定内核版本需要支持此功能的激活码".into());
        }
        if let Some(version) = browser_version.as_deref()
            && !valid_browser_version(version)
        {
            return Err("内核版本需要是完整的数字版本号".into());
        }
        let mut command = Command::new(&self.runtime.node);
        command
            .arg(script)
            .arg("prepare")
            .env(
                "CLOAKBROWSER_CACHE_DIR",
                self.license_store.browser_cache_dir(),
            )
            .env_remove("CLOAKBROWSER_LICENSE_KEY")
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL");
        if let Some(key) = license_key.as_deref() {
            command.env("CLOAKBROWSER_LICENSE_KEY", key);
        }
        if let Some(version) = browser_version {
            command.env("CLOAKBROWSER_VERSION", version);
        }
        let output = run_preparation(&mut command, Duration::from_secs(12 * 60))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(sanitize_license_error(&detail));
        }
        let line = output
            .stdout
            .split(|byte| *byte == b'\n')
            .rev()
            .find(|line| !line.is_empty())
            .ok_or("无法识别 CloakBrowser 内核信息")?;
        let binary: PreparedBinary =
            serde_json::from_slice(line).map_err(|_| "无法识别 CloakBrowser 内核信息")?;
        self.create_prepared(&name, proxy, settings, binary, group_id.as_deref())
    }

    fn create_prepared(
        &self,
        name: &str,
        proxy: ProxySource,
        settings: WindowSettings,
        binary: PreparedBinary,
        group_id: Option<&str>,
    ) -> Result<ProfileSummary, String> {
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
        if state.scheduler.status(id).is_some() {
            return Err("请先停止窗口，再修改浏览器配置".into());
        }
        self.store
            .update_with_group(id, &name, proxy, settings, group_id.as_deref())
            .map_err(error_message)?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "窗口状态不可用")?;
        Self::reap(&mut state);
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
        let record = self.store.get(id).map_err(error_message)?;
        // Resolution happens before a slot is reserved: a plugin that cannot
        // produce a proxy must block the launch, never fall back to direct.
        let proxy = match (&record.proxy_plugin, &record.proxy) {
            (Some(plugin_id), _) => {
                let host = self
                    .plugin_host
                    .as_ref()
                    .ok_or_else(|| "代理插件宿主未初始化，窗口启动被阻断".to_string())?;
                let reference = host
                    .resolve_proxy(plugin_id, &record.id, record.proxy_endpoint)
                    .map_err(|error| format!("代理插件未提供可用代理：{}", error.message()))?;
                ProxyBinding::Required {
                    plugin_id: plugin_id.clone(),
                    config_handle: reference.config_handle,
                    secret_ref: reference.secret_ref,
                }
            }
            (None, Some(server)) => ProxyBinding::Configured {
                server: server.clone(),
            },
            (None, None) => ProxyBinding::Direct,
        };
        let snapshot = {
            let mut state = self.state.lock().map_err(|_| "Profile 状态不可用")?;
            Self::reap(&mut state);
            state
                .scheduler
                .reserve(LaunchRequest {
                    window_id: record.id.clone(),
                    profile_id: record.id.clone(),
                    channel_id: record.binding.channel_id,
                    proxy,
                })
                .map_err(|error| format!("Profile 调度被拒绝：{error:?}"))?
        };
        match self.spawn_browser(id) {
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

    fn spawn_browser(&self, id: &str) -> Result<Child, String> {
        let record = self.store.get(id).map_err(error_message)?;
        let user_data = self.store.user_data_dir(id).map_err(error_message)?;
        let license_key = self.license_store.license_key()?;
        let mut command = Command::new(&self.runtime.node);
        command
            .arg(&self.runtime.browser_script)
            .arg("launch")
            .arg(user_data)
            .env(
                "CLOAKBROWSER_CACHE_DIR",
                self.license_store.browser_cache_dir(),
            )
            .env_remove("CLOAKBROWSER_LICENSE_KEY")
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(key) = license_key.as_deref() {
            command.env("CLOAKBROWSER_LICENSE_KEY", key);
        }
        let mut child = command.spawn().map_err(|_| "无法启动浏览器适配进程")?;
        let config = serde_json::to_vec(&record).map_err(|_| "窗口配置无法编码")?;
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
            event => {
                if matches!(event, Err(std::sync::mpsc::RecvTimeoutError::Timeout)) {
                    let _ = child.kill();
                }
                let _ = child.wait();
                let _ = stdout_reader.join();
                let detail = stderr_reader.join().unwrap_or_default();
                if detail.is_empty() {
                    Err("CloakBrowser 启动失败或超时；Profile 绑定保持不变".into())
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
}

fn valid_browser_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    version.len() <= 48
        && (4..=5).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// CloakBrowser ignores version pins for free plans; other validated plans can pin.
fn can_pin_browser_version(plan: Option<&str>) -> bool {
    plan.is_some_and(|value| !value.trim().is_empty() && !value.eq_ignore_ascii_case("free"))
}

fn sanitize_license_error(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("invalid or expired") || lower.contains("license key is invalid") {
        "CloakBrowser 授权无效或已过期，请检查密钥".into()
    } else if lower.contains("could not be validated")
        || lower.contains("couldn't verify")
        || lower.contains("license server unreachable")
    {
        "无法连接 CloakBrowser 授权服务，请检查网络后重试".into()
    } else if lower.contains("session limit") || lower.contains("session limit reached") {
        "CloakBrowser 并发席位已满，请先关闭其他会话或升级授权".into()
    } else if lower.contains("pro binary unavailable") {
        "授权有效，但 CloakBrowser 最新内核暂时无法下载，请稍后重试".into()
    } else {
        "CloakBrowser 内核准备失败，请检查网络、授权和版本设置".into()
    }
}

#[tauri::command]
pub fn profile_list(state: State<'_, Arc<ProfileService>>) -> Result<Vec<ProfileSummary>, String> {
    state.list()
}

/// A Tauri command receives flat arguments; the three proxy fields are folded
/// into one `ProxySource` before they reach the store.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn profile_create(
    state: State<'_, Arc<ProfileService>>,
    name: String,
    proxy: Option<String>,
    proxy_plugin: Option<String>,
    proxy_endpoint: Option<i64>,
    settings: WindowSettings,
    browser_version: Option<String>,
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
            browser_version,
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
mod tests {
    use super::ProfileService;
    use crate::core::profile_store::{PreparedBinary, ProxySource, WindowSettings};
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn preparation_process_that_never_exits_returns_an_error() {
        let mut command = Command::new("node");
        command.arg("-e").arg("setInterval(() => {}, 1000)");
        let started = Instant::now();
        let result = super::run_preparation(&mut command, Duration::from_millis(150));
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
                    version: "145.0.7632.109".into(),
                    binary_path,
                },
                None,
            )
            .unwrap();
        assert_eq!(created.name, "New window");
        assert_eq!(created.version, "145.0.7632.109");
        assert!(!created.running);
        assert_eq!(service.list().unwrap()[0].id, created.id);
    }

    #[test]
    #[ignore = "downloads or uses a local CloakBrowser binary and opens a visible window"]
    fn creates_launches_stops_and_reloads_a_profile() {
        let root = tempfile::tempdir().unwrap();
        let service = ProfileService::new(root.path().join("profiles")).unwrap();
        service
            .create(
                "Smoke Profile".into(),
                ProxySource::direct(),
                WindowSettings::default(),
                None,
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
    fn browser_version_selection_requires_a_full_numeric_version() {
        assert!(super::valid_browser_version("155.0.1.2"));
        assert!(super::valid_browser_version("155.0.1.2.3"));
        assert!(!super::valid_browser_version("latest"));
        assert!(!super::valid_browser_version("155.0"));
        assert!(!super::valid_browser_version("155.0.x.2"));
    }

    #[test]
    fn exact_browser_version_pinning_requires_a_pro_license() {
        assert!(super::can_pin_browser_version(Some("pro")));
        assert!(super::can_pin_browser_version(Some("Pro")));
        assert!(!super::can_pin_browser_version(Some("free")));
        assert!(super::can_pin_browser_version(Some("team")));
        assert!(!super::can_pin_browser_version(None));
    }

    #[test]
    fn license_errors_are_actionable_and_never_echo_secrets() {
        assert_eq!(
            super::sanitize_license_error(
                "CloakBrowser Pro: license key is invalid or expired: cb_secret"
            ),
            "CloakBrowser 授权无效或已过期，请检查密钥"
        );
        assert_eq!(
            super::sanitize_license_error("session limit reached"),
            "CloakBrowser 并发席位已满，请先关闭其他会话或升级授权"
        );
    }
}
