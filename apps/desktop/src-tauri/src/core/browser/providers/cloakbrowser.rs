use crate::core::browser::connection_store::BrowserConnection;
use crate::core::browser::provider::{
    BUILTIN_CONNECTION_ID, BrowserBinding, BrowserError, BrowserProvider, BrowserProviderId,
    BrowserResult, CreatedProfile, ObservedProfiles, ProviderGroup, ProviderProbe, ProxyMode,
    RemoteProfile, ResolvedProxy, UpdateEvidence, WindowState,
};
use crate::core::kernel_service::KernelService;
use crate::core::license_store::LicenseStore;
use crate::core::network_proxy::NetworkProxyStore;
use crate::core::runtime_paths::RuntimePaths;
use crate::core::window_store::{WindowRecord, valid_version};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const STDERR_LIMIT: usize = 8192;
const CREATE_DIRECTORY: &str = ".native-create";
const CREATE_WITNESS: &str = ".native-create.json";
const CREATE_MARKER_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateMarker {
    schema_version: u8,
    operation_id: String,
    request_digest: String,
    window_id: String,
    binding: BrowserBinding,
    name: String,
    binary_path: PathBuf,
    kernel_version: String,
    provider_config: Value,
    created_at: i64,
    staging_directory: String,
}

impl CreateMarker {
    fn created_profile(&self) -> CreatedProfile {
        CreatedProfile {
            profile_id: self.binding.profile_id.clone(),
            kernel_version: Some(self.kernel_version.clone()),
            binary_path: Some(self.binary_path.clone()),
            provider_config: self.provider_config.clone(),
        }
    }

    fn remote_profile(&self) -> RemoteProfile {
        RemoteProfile {
            id: self.binding.profile_id.clone(),
            name: self.name.clone(),
            kernel_version: Some(self.kernel_version.clone()),
            created_at: Some(self.created_at),
            provider_config: self.provider_config.clone(),
        }
    }
}

struct Session {
    child: Child,
    state: WindowState,
    stop_requested: bool,
}

impl Drop for Session {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) && self.child.kill().is_ok() {
            let _ = self.child.wait();
        }
    }
}

type SharedSession = Arc<Mutex<Session>>;

pub struct CloakBrowserProvider {
    /// The existing app-data `profiles` directory, not the app-data root.
    root: PathBuf,
    pub(crate) license_store: LicenseStore,
    pub(crate) runtime: RuntimePaths,
    pub(crate) kernels: KernelService,
    pub(crate) network: Option<NetworkProxyStore>,
    sessions: Mutex<HashMap<String, SharedSession>>,
    process_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl CloakBrowserProvider {
    pub fn new(
        root: PathBuf,
        license_store: LicenseStore,
        runtime: RuntimePaths,
        network: Option<NetworkProxyStore>,
    ) -> Self {
        let mut kernels = KernelService::new(license_store.clone(), runtime.clone());
        if let Some(network) = &network {
            kernels = kernels.with_network(network.clone());
        }
        Self {
            root,
            license_store,
            runtime,
            kernels,
            network,
            sessions: Mutex::new(HashMap::new()),
            process_locks: Mutex::new(HashMap::new()),
        }
    }

    fn process_lock(&self, id: &str) -> BrowserResult<Arc<Mutex<()>>> {
        let mut locks = self.process_locks.lock().map_err(|_| state_error())?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(id.to_owned(), Arc::downgrade(&lock));
        Ok(lock)
    }

    fn session(&self, id: &str) -> BrowserResult<Option<SharedSession>> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| state_error())?
            .get(id)
            .cloned())
    }

    fn remove_session(&self, id: &str, session: &SharedSession) -> BrowserResult<()> {
        let mut sessions = self.sessions.lock().map_err(|_| state_error())?;
        if sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            sessions.remove(id);
        }
        Ok(())
    }

    fn observe(&self, id: &str) -> BrowserResult<WindowState> {
        let Some(session) = self.session(id)? else {
            return Ok(WindowState::Stopped);
        };
        let state = {
            let mut process = session.lock().map_err(|_| state_error())?;
            match process.child.try_wait() {
                Ok(Some(_)) => WindowState::Stopped,
                Ok(None) => process.state,
                Err(_) => {
                    process.state = WindowState::Unknown;
                    WindowState::Unknown
                }
            }
        };
        if state == WindowState::Stopped {
            self.remove_session(id, &session)?;
        }
        Ok(state)
    }

    fn require_stopped(&self, id: &str) -> BrowserResult<()> {
        match self.observe(id)? {
            WindowState::Stopped => Ok(()),
            WindowState::Unknown | WindowState::Missing => Err(BrowserError::new(
                "operation_uncertain",
                "无法确认浏览器进程状态，请重新检查后再操作",
            )),
            _ => Err(busy_error()),
        }
    }

    fn profile_dir(&self, id: &str) -> BrowserResult<PathBuf> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| BrowserError::new("invalid_config", "窗口标识无效"))?;
        Ok(self.root.join(id))
    }

    fn create_marker_path(&self, operation_id: &str) -> PathBuf {
        self.root
            .join(CREATE_DIRECTORY)
            .join(format!("{}.json", operation_digest(operation_id)))
    }

    fn read_create_marker(&self, operation_id: &str) -> BrowserResult<Option<CreateMarker>> {
        if !self.root.is_absolute() {
            return Err(create_uncertain());
        }
        if !managed_directory_exists(&self.root).map_err(|_| create_uncertain())?
            || !managed_directory_exists(&self.root.join(CREATE_DIRECTORY))
                .map_err(|_| create_uncertain())?
        {
            return Ok(None);
        }
        let Some(marker) = read_create_marker_file(&self.create_marker_path(operation_id))? else {
            return Ok(None);
        };
        let mut staging = Path::new(&marker.staging_directory).components();
        let prefix = format!("creating-{}-", operation_digest(operation_id));
        if marker.schema_version != 1
            || marker.operation_id != operation_id
            || marker.request_digest.len() != 64
            || !marker
                .request_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || uuid::Uuid::parse_str(&marker.window_id).is_err()
            || marker.binding.provider_id != BrowserProviderId::CloakBrowser
            || marker.binding.connection_id != BUILTIN_CONNECTION_ID
            || marker.binding.profile_id != marker.window_id
            || !marker.binary_path.is_absolute()
            || marker
                .binary_path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
            || !valid_version(&marker.kernel_version)
            || self.kernels.package_version(&marker.binary_path).as_deref()
                != Some(marker.kernel_version.as_str())
            || !marker.provider_config.is_object()
            || marker.provider_config["binaryPath"].as_str() != marker.binary_path.to_str()
            || marker.provider_config["binaryPath"].as_str().is_none()
            || !marker.provider_config["displayVersion"]
                .as_str()
                .is_some_and(valid_version)
            || !marker.staging_directory.starts_with(&prefix)
            || marker.staging_directory.len() <= prefix.len()
            || !matches!(staging.next(), Some(Component::Normal(_)))
            || staging.next().is_some()
        {
            return Err(create_uncertain());
        }
        Ok(Some(marker))
    }

    fn finish_create(&self, marker: &CreateMarker) -> BrowserResult<()> {
        let directory = self.root.join(CREATE_DIRECTORY);
        let profile = self.profile_dir(&marker.window_id)?;
        if managed_directory_exists(&profile).map_err(|_| create_uncertain())? {
            if read_create_marker_file(&profile.join(CREATE_WITNESS))?.as_ref() != Some(marker) {
                return Err(create_uncertain());
            }
        } else {
            let staging = directory.join(&marker.staging_directory);
            if !managed_directory_exists(&staging).map_err(|_| create_uncertain())?
                || read_create_marker_file(&staging.join(CREATE_WITNESS))?.as_ref() != Some(marker)
            {
                return Err(create_uncertain());
            }
            // The exact operation index is durable before a profile becomes visible.
            sync_directory(&directory).map_err(|_| create_uncertain())?;
            fs::rename(&staging, &profile).map_err(|_| create_uncertain())?;
        }
        sync_directory(&self.root).map_err(|_| create_uncertain())?;
        sync_directory(&directory).map_err(|_| create_uncertain())
    }

    fn stage_create(
        &self,
        record: &WindowRecord,
        operation_id: &str,
    ) -> BrowserResult<(CreateMarker, tempfile::TempDir, tempfile::NamedTempFile)> {
        if record
            .kernel_version
            .as_deref()
            .is_some_and(|version| !valid_version(version))
        {
            return Err(BrowserError::new(
                "invalid_config",
                "请选择完整的浏览器内核包版本",
            ));
        }
        let profile = self.profile_dir(&record.id)?;
        if !self.root.is_absolute()
            || managed_directory_exists(&profile).map_err(|_| create_uncertain())?
        {
            return Err(BrowserError::new(
                "invalid_config",
                "此窗口已存在本机环境，或环境路径无效",
            ));
        }
        self.license_key()?;
        let binary = match record.kernel_version.as_deref() {
            Some(version) => self.kernels.exact_binary(version),
            None => self.kernels.prepare(None),
        }
        .map_err(|_| {
            BrowserError::new(
                "unavailable",
                "无法准备所选浏览器内核，请检查激活码和应用网络设置",
            )
        })?;
        // The Chrome display version can omit the SDK's package revision.
        let version = self
            .kernels
            .package_version(&binary.binary_path)
            .filter(|version| {
                record
                    .kernel_version
                    .as_ref()
                    .is_none_or(|requested| requested == version)
            })
            .filter(|_| {
                valid_version(&binary.version)
                    && binary.binary_path.is_absolute()
                    && binary.binary_path.is_file()
                    && !binary.binary_path.components().any(|component| {
                        matches!(component, Component::ParentDir | Component::CurDir)
                    })
            })
            .ok_or_else(|| {
                BrowserError::new("invalid_config", "无法确认所选内核的完整受管包版本")
            })?;
        let binary_path = binary
            .binary_path
            .to_str()
            .ok_or_else(|| BrowserError::new("invalid_config", "浏览器内核路径无法编码"))?;
        let mut provider_config = record.provider_config.clone();
        provider_config["displayVersion"] = binary.version.into();
        provider_config["binaryPath"] = binary_path.into();
        let request_digest = create_request_digest(record)?;
        if !managed_directory_exists(&self.root).map_err(|_| create_uncertain())? {
            fs::create_dir_all(&self.root).map_err(|_| create_uncertain())?;
        }
        if !managed_directory_exists(&self.root).map_err(|_| create_uncertain())? {
            return Err(create_uncertain());
        }
        let directory = self.root.join(CREATE_DIRECTORY);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(create_uncertain()),
        }
        if !managed_directory_exists(&directory).map_err(|_| create_uncertain())? {
            return Err(create_uncertain());
        }
        sync_directory(&self.root).map_err(|_| create_uncertain())?;
        if let Some(parent) = self.root.parent() {
            sync_directory(parent).map_err(|_| create_uncertain())?;
        }
        let staging = tempfile::Builder::new()
            .prefix(&format!("creating-{}-", operation_digest(operation_id)))
            .tempdir_in(&directory)
            .map_err(|_| create_uncertain())?;
        let staging_directory = staging
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(create_uncertain)?
            .to_owned();
        let marker = CreateMarker {
            schema_version: 1,
            operation_id: operation_id.into(),
            request_digest,
            window_id: record.id.clone(),
            binding: record.binding.clone(),
            name: record.name.clone(),
            binary_path: binary.binary_path,
            kernel_version: version,
            provider_config,
            created_at: record.created_at,
            staging_directory,
        };
        let bytes = serde_json::to_vec(&marker).map_err(|_| create_uncertain())?;
        if bytes.len() as u64 > CREATE_MARKER_LIMIT {
            return Err(BrowserError::new("invalid_config", "本机环境创建信息过大"));
        }
        let mut witness = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staging.path().join(CREATE_WITNESS))
            .map_err(|_| create_uncertain())?;
        witness.write_all(&bytes).map_err(|_| create_uncertain())?;
        witness.sync_all().map_err(|_| create_uncertain())?;
        sync_directory(staging.path()).map_err(|_| create_uncertain())?;
        sync_directory(&directory).map_err(|_| create_uncertain())?;
        let mut index =
            tempfile::NamedTempFile::new_in(&directory).map_err(|_| create_uncertain())?;
        index.write_all(&bytes).map_err(|_| create_uncertain())?;
        index.as_file().sync_all().map_err(|_| create_uncertain())?;
        Ok((marker, staging, index))
    }

    pub(crate) fn user_data_dir(&self, id: &str) -> BrowserResult<PathBuf> {
        let profile = self.profile_dir(id)?;
        let metadata = fs::symlink_metadata(&profile)
            .map_err(|_| BrowserError::new("profile_missing", "本机环境目录不可用"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(BrowserError::new(
                "invalid_config",
                "本机环境必须使用受管目录",
            ));
        }
        let user_data = profile.join("user-data");
        match fs::symlink_metadata(&user_data) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(BrowserError::new(
                    "invalid_config",
                    "浏览器数据必须使用受管目录",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(BrowserError::new("unavailable", "无法检查浏览器数据目录"));
            }
        }
        Ok(user_data)
    }

    fn validate_kernel(&self, record: &WindowRecord) -> BrowserResult<()> {
        if record
            .settings
            .fingerprint_seed
            .is_none_or(|seed| seed == 0 || seed > 0x7fff_ffff)
        {
            return Err(BrowserError::new(
                "invalid_config",
                "窗口缺少有效的固定指纹种子",
            ));
        }
        let path = record
            .binary_path
            .as_deref()
            .filter(|path| path.is_absolute() && path.is_file())
            .ok_or_else(|| {
                BrowserError::new("invalid_config", "窗口绑定的浏览器内核不可用，请恢复原内核")
            })?;
        let version = record
            .kernel_version
            .as_deref()
            .ok_or_else(|| BrowserError::new("invalid_config", "窗口缺少固定内核包版本"))?;
        if self.kernels.package_version(path).as_deref() != Some(version) {
            return Err(BrowserError::new(
                "invalid_config",
                "浏览器内核与窗口绑定的完整包版本不一致",
            ));
        }
        Ok(())
    }

    fn license_key(&self) -> BrowserResult<String> {
        self.license_store
            .license_key()
            .map_err(|_| BrowserError::new("unavailable", "无法读取激活码，请稍后重试"))?
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| BrowserError::new("auth_required", "请先在应用设置中保存并验证激活码"))
    }

    fn launch_command(&self, user_data: PathBuf) -> BrowserResult<Command> {
        if !self.runtime.browser_script.is_file() {
            return Err(BrowserError::new(
                "unavailable",
                "浏览器运行组件缺失，请重新安装应用",
            ));
        }
        let key = self.license_key()?;
        let mut command = Command::new(&self.runtime.node);
        if let Some(network) = &self.network {
            network
                .get()
                .map_err(|_| BrowserError::new("unavailable", "无法读取应用代理设置"))?
                .apply_to_node(&mut command, &self.runtime.network_preload)
                .map_err(|_| {
                    BrowserError::new("invalid_config", "无法将应用代理设置应用到浏览器运行组件")
                })?;
        }
        command
            .arg(&self.runtime.browser_script)
            .arg("launch")
            .arg(user_data)
            .env(
                "CLOAKBROWSER_CACHE_DIR",
                self.license_store.browser_cache_dir(),
            )
            .env("CLOAKBROWSER_LICENSE_KEY", key)
            .env("CLOAKBROWSER_AUTO_UPDATE", "false")
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL")
            .env_remove("CLOAKBROWSER_SKIP_CHECKSUM")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Ok(command)
    }

    fn terminate_failed_start(&self, id: &str, session: &SharedSession) -> BrowserResult<()> {
        {
            let mut process = session.lock().map_err(|_| state_error())?;
            process.state = WindowState::Stopping;
            process.child.stdin.take();
            let exited = matches!(process.child.try_wait(), Ok(Some(_)))
                || if process.child.kill().is_ok() {
                    process.child.wait().is_ok()
                } else {
                    matches!(process.child.try_wait(), Ok(Some(_)))
                };
            if !exited {
                process.state = WindowState::Unknown;
                return Err(BrowserError::new(
                    "operation_uncertain",
                    "无法确认启动失败的浏览器已退出，环境仍被占用",
                ));
            }
        }
        self.remove_session(id, session)
    }

    fn start(&self, record: &WindowRecord, proxy: &ResolvedProxy) -> BrowserResult<()> {
        let launch_record = browser_launch_record(record, proxy)?;
        self.validate_kernel(record)?;
        let user_data = self.user_data_dir(&record.id)?;
        let config = serde_json::to_vec(&launch_record)
            .map_err(|_| BrowserError::new("invalid_config", "无法编码窗口配置"))?;
        let mut process = Session {
            child: self
                .launch_command(user_data)?
                .spawn()
                .map_err(|_| BrowserError::new("unavailable", "无法启动浏览器运行组件"))?,
            state: WindowState::Starting,
            stop_requested: false,
        };
        let started = Instant::now();
        let stdin = process.child.stdin.take().ok_or_else(state_error)?;
        let stdout = process.child.stdout.take().ok_or_else(state_error)?;
        let stderr = process.child.stderr.take().ok_or_else(state_error)?;
        let configured = write_configuration(stdin, config);
        let ready = read_readiness(stdout);
        let errors = read_errors(stderr);
        let session = Arc::new(Mutex::new(process));
        self.sessions
            .lock()
            .map_err(|_| state_error())?
            .insert(record.id.clone(), Arc::clone(&session));
        let launched = (|| {
            {
                let stdin = configured
                    .recv_timeout(START_TIMEOUT)
                    .ok()
                    .and_then(Result::ok)
                    .ok_or_else(|| {
                        BrowserError::new("unavailable", "无法将窗口配置发送到浏览器")
                    })?;
                let mut process = session.lock().map_err(|_| state_error())?;
                process.child.stdin = Some(stdin);
            }
            let remaining = START_TIMEOUT.saturating_sub(started.elapsed());
            if !matches!(ready.recv_timeout(remaining), Ok(true)) {
                return Err(BrowserError::new(
                    "unavailable",
                    "浏览器启动失败或超时，请检查所选代理和内核",
                ));
            }
            let mut process = session.lock().map_err(|_| state_error())?;
            match process.child.try_wait() {
                Ok(None) => {
                    process.state = WindowState::Running;
                    Ok(())
                }
                _ => Err(BrowserError::new("unavailable", "浏览器在确认启动前已退出")),
            }
        })();
        if let Err(error) = launched {
            self.terminate_failed_start(&record.id, &session)?;
            let detail = errors
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or_default();
            return Err(if detail.is_empty() {
                error
            } else {
                runtime_error(&String::from_utf8_lossy(&detail))
            });
        }
        Ok(())
    }
}

impl BrowserProvider for CloakBrowserProvider {
    fn id(&self) -> BrowserProviderId {
        BrowserProviderId::CloakBrowser
    }

    fn probe(&self, connection: &BrowserConnection) -> BrowserResult<ProviderProbe> {
        validate_connection(connection)?;
        let configured = self
            .license_store
            .status()
            .map_err(|_| BrowserError::new("unavailable", "无法读取激活状态，请稍后重试"))?
            .configured;
        let available = self.runtime.browser_script.is_file();
        Ok(ProviderProbe {
            connected: available && configured,
            message: if !available {
                "内置浏览器运行组件缺失，请重新安装应用"
            } else if !configured {
                "请先在应用设置中保存并验证激活码"
            } else {
                "内置浏览器运行组件和已保存激活码可用"
            }
            .into(),
            scope_id: Some(BUILTIN_CONNECTION_ID.into()),
            capabilities: self.capabilities(),
        })
    }

    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        validate_connection(connection)?;
        Ok(Vec::new())
    }

    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        validate_connection(connection)?;
        Ok(Vec::new())
    }

    fn create_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        operation_id: &str,
    ) -> BrowserResult<CreatedProfile> {
        validate_connection(connection).map_err(create_rejected)?;
        validate_operation_id(operation_id).map_err(create_rejected)?;
        let operation_lock =
            self.process_lock(&format!("create:{}", operation_digest(operation_id)))?;
        let _operation = operation_lock.try_lock().map_err(|_| create_uncertain())?;
        if !self.root.is_absolute()
            || fs::symlink_metadata(&self.root).is_ok_and(|metadata| metadata.is_file())
        {
            return Err(BrowserError::new(
                "not_submitted",
                "本机环境根路径无效，尚未提交创建",
            ));
        }
        if let Some(marker) = self.read_create_marker(operation_id)? {
            if validate_record(connection, record).is_err()
                || create_request_digest(record)? != marker.request_digest
            {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "此创建操作已绑定其他窗口配置，请核对待处理操作",
                ));
            }
            let lock = self.process_lock(&marker.window_id)?;
            let _window = lock.try_lock().map_err(|_| create_uncertain())?;
            self.require_stopped(&marker.window_id)?;
            self.finish_create(&marker)?;
            return Ok(marker.created_profile());
        }
        validate_record(connection, record).map_err(create_rejected)?;
        validate_proxy_source(record, true).map_err(create_rejected)?;
        let lock = self.process_lock(&record.id).map_err(create_rejected)?;
        let _window = lock.try_lock().map_err(|_| create_rejected(busy_error()))?;
        self.require_stopped(&record.id).map_err(create_rejected)?;
        let (marker, staging, index) = self
            .stage_create(record, operation_id)
            .map_err(create_rejected)?;
        match index.persist_noclobber(self.create_marker_path(operation_id)) {
            Ok(_) => {
                // Once the operation is published, recovery owns the staged directory.
                let _ = staging.keep();
            }
            Err(_) => {
                if fs::symlink_metadata(self.create_marker_path(operation_id))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                {
                    return Err(BrowserError::new(
                        "not_submitted",
                        "无法保存本机环境创建信息，尚未提交创建",
                    ));
                }
                let _ = staging.keep();
                return Err(create_uncertain());
            }
        }
        self.finish_create(&marker)?;
        Ok(marker.created_profile())
    }

    fn update_profile(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_record(connection, previous)?;
        validate_record(connection, updated)?;
        validate_proxy_source(updated, true)?;
        if previous.id != updated.id
            || previous.binding != updated.binding
            || previous.binary_path != updated.binary_path
            || previous.kernel_version != updated.kernel_version
            || previous.settings.fingerprint_seed != updated.settings.fingerprint_seed
        {
            return Err(BrowserError::new(
                "invalid_config",
                "已有窗口的浏览器绑定、内核和指纹种子不可修改",
            ));
        }
        let lock = self.process_lock(&previous.id)?;
        let _operation = lock.try_lock().map_err(|_| busy_error())?;
        self.require_stopped(&previous.id)?;
        self.user_data_dir(&previous.id)?;
        Ok(())
    }

    fn prepare_update_evidence(
        &self,
        _previous: &WindowRecord,
        _updated: &WindowRecord,
    ) -> BrowserResult<UpdateEvidence> {
        // Native settings take effect on the next launch; there is no remote write to compare.
        UpdateEvidence::from_fields(self.id(), &serde_json::json!({}))
    }

    fn delete_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_record(connection, record)?;
        let lock = self.process_lock(&record.id)?;
        let _operation = lock.try_lock().map_err(|_| busy_error())?;
        self.require_stopped(&record.id)?;
        let profile = self.profile_dir(&record.id)?;
        match fs::symlink_metadata(&profile) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err(BrowserError::new("unavailable", "无法检查本机环境目录"));
            }
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(BrowserError::new(
                    "invalid_config",
                    "本机环境必须使用受管目录",
                ));
            }
            Ok(_) => {}
        }
        fs::remove_dir_all(profile)
            .map_err(|_| BrowserError::new("unavailable", "无法删除本机环境数据"))
    }

    fn start_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        proxy: &ResolvedProxy,
    ) -> BrowserResult<()> {
        validate_record(connection, record)?;
        let lock = self.process_lock(&record.id)?;
        let _operation = lock.try_lock().map_err(|_| busy_error())?;
        self.require_stopped(&record.id)?;
        self.start(record, proxy)
    }

    fn stop_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_record(connection, record)?;
        let lock = self.process_lock(&record.id)?;
        let _operation = lock.try_lock().map_err(|_| busy_error())?;
        let Some(session) = self.session(&record.id)? else {
            return Ok(());
        };
        {
            let mut process = session.lock().map_err(|_| state_error())?;
            process.state = WindowState::Stopping;
            if !process.stop_requested {
                if let Some(mut stdin) = process.child.stdin.take() {
                    let _ = stdin.write_all(b"stop\n");
                }
                process.stop_requested = true;
            }
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            {
                let mut process = session.lock().map_err(|_| state_error())?;
                match process.child.try_wait() {
                    Ok(Some(_)) => {
                        drop(process);
                        self.remove_session(&record.id, &session)?;
                        return Ok(());
                    }
                    Ok(None) => {}
                    Err(_) => {
                        process.state = WindowState::Unknown;
                        return Err(BrowserError::new(
                            "operation_uncertain",
                            "无法确认浏览器已退出，环境仍被占用",
                        ));
                    }
                }
            }
            if Instant::now() >= deadline {
                return Err(BrowserError::new(
                    "operation_uncertain",
                    "浏览器仍在关闭，环境仍被占用",
                ));
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn observe_profiles(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles> {
        validate_connection(connection)?;
        let states = records
            .iter()
            .map(|record| {
                validate_record(connection, record)?;
                Ok((record.id.clone(), self.observe(&record.id)?))
            })
            .collect::<BrowserResult<HashMap<_, _>>>()?;
        Ok(ObservedProfiles {
            states,
            profiles: Vec::new(),
        })
    }

    fn reconcile_create(
        &self,
        connection: &BrowserConnection,
        operation_id: &str,
    ) -> BrowserResult<Option<RemoteProfile>> {
        validate_connection(connection)?;
        validate_operation_id(operation_id)?;
        let operation_lock =
            self.process_lock(&format!("create:{}", operation_digest(operation_id)))?;
        let _operation = operation_lock.try_lock().map_err(|_| create_uncertain())?;
        let Some(marker) = self.read_create_marker(operation_id)? else {
            return Ok(None);
        };
        let lock = self.process_lock(&marker.window_id)?;
        let _window = lock.try_lock().map_err(|_| create_uncertain())?;
        self.require_stopped(&marker.window_id)?;
        self.finish_create(&marker)?;
        Ok(Some(marker.remote_profile()))
    }

    fn reconcile_update(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool> {
        evidence.validate(self.id())?;
        if !evidence.fields.is_empty() {
            return Err(BrowserError::new("invalid_config", "本机配置确认数据无效"));
        }
        self.update_profile(connection, previous, updated)?;
        Ok(true)
    }

    fn reconcile_delete(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<bool> {
        validate_record(connection, record)?;
        let lock = self.process_lock(&record.id)?;
        let _operation = lock.try_lock().map_err(|_| busy_error())?;
        self.require_stopped(&record.id)?;
        let profile = self.profile_dir(&record.id)?;
        let uncertain = || {
            BrowserError::new(
                "operation_uncertain",
                "无法确认本机环境目录是否已删除，请重新检查待处理操作",
            )
        };
        if !self.root.is_absolute() {
            return Err(uncertain());
        }
        // An invalid root must not turn an inaccessible profile into confirmed absence.
        managed_directory_exists(&self.root).map_err(|_| uncertain())?;
        match fs::symlink_metadata(&profile) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(_) => Err(uncertain()),
        }
    }
}

fn operation_digest(operation_id: &str) -> String {
    format!("{:x}", Sha256::digest(operation_id.as_bytes()))
}

fn validate_operation_id(operation_id: &str) -> BrowserResult<()> {
    if operation_id.trim().is_empty()
        || operation_id.len() > 512
        || operation_id.chars().any(char::is_control)
    {
        return Err(BrowserError::new("invalid_config", "创建操作标识无效"));
    }
    Ok(())
}

fn create_request_digest(record: &WindowRecord) -> BrowserResult<String> {
    let mut request = record.clone();
    if request.proxy_mode == ProxyMode::Plugin {
        request.proxy = None;
    }
    let bytes = serde_json::to_vec(&request)
        .map_err(|_| BrowserError::new("operation_conflict", "无法核对本机环境创建参数"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn managed_directory_exists(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(std::io::Error::other("managed directory required")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn read_create_marker_file(path: &Path) -> BrowserResult<Option<CreateMarker>> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= CREATE_MARKER_LIMIT => {}
        Ok(_) => return Err(create_uncertain()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(create_uncertain()),
    }
    let file = fs::File::open(path).map_err(|_| create_uncertain())?;
    let mut bytes = Vec::new();
    file.take(CREATE_MARKER_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| create_uncertain())?;
    if bytes.len() as u64 > CREATE_MARKER_LIMIT {
        return Err(create_uncertain());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| create_uncertain())
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn create_rejected(error: BrowserError) -> BrowserError {
    BrowserError::new(
        "not_submitted",
        if error.code == "operation_uncertain" {
            "无法准备本机环境创建信息，尚未提交创建".into()
        } else {
            error.message
        },
    )
}

fn create_uncertain() -> BrowserError {
    BrowserError::new(
        "operation_uncertain",
        "本机环境创建结果尚未确认，请重新检查待处理操作",
    )
}

fn validate_connection(connection: &BrowserConnection) -> BrowserResult<()> {
    if connection.id != BUILTIN_CONNECTION_ID
        || connection.provider_id != BrowserProviderId::CloakBrowser
    {
        return Err(BrowserError::new(
            "scope_mismatch",
            "此操作需要使用内置浏览器连接",
        ));
    }
    Ok(())
}

fn validate_record(connection: &BrowserConnection, record: &WindowRecord) -> BrowserResult<()> {
    validate_connection(connection)?;
    if record.schema_version != 2
        || record.binding.provider_id != BrowserProviderId::CloakBrowser
        || record.binding.connection_id != connection.id
        || record.binding.profile_id != record.id
        || uuid::Uuid::parse_str(&record.id).is_err()
        || !record.provider_config.is_object()
    {
        return Err(BrowserError::new(
            "invalid_config",
            "窗口的内置浏览器绑定无效",
        ));
    }
    Ok(())
}

// Create/update may receive the common service's transient plugin connection.
// Launch instead requires a saved source plus its separate resolved proxy.
fn validate_proxy_source(record: &WindowRecord, allow_resolved_plugin: bool) -> BrowserResult<()> {
    let valid = match record.proxy_mode {
        ProxyMode::Direct => {
            record.proxy.is_none()
                && record.proxy_plugin.is_none()
                && record.proxy_endpoint.is_none()
        }
        ProxyMode::Manual => {
            record
                .proxy
                .as_deref()
                .is_some_and(|proxy| !proxy.trim().is_empty())
                && record.proxy_plugin.is_none()
                && record.proxy_endpoint.is_none()
        }
        ProxyMode::Plugin => {
            (allow_resolved_plugin || record.proxy.is_none())
                && record
                    .proxy_plugin
                    .as_deref()
                    .is_some_and(|plugin| !plugin.trim().is_empty())
                && record.proxy_endpoint.is_none_or(|endpoint| endpoint > 0)
        }
        ProxyMode::Provider => {
            return Err(BrowserError::unsupported(
                "内置浏览器没有可继承的外部代理设置",
            ));
        }
    };
    if !valid {
        return Err(BrowserError::new(
            "invalid_config",
            "窗口代理模式与代理配置不一致",
        ));
    }
    Ok(())
}

fn browser_launch_record(
    record: &WindowRecord,
    proxy: &ResolvedProxy,
) -> BrowserResult<WindowRecord> {
    validate_proxy_source(record, false)?;
    if proxy.mode != record.proxy_mode {
        return Err(BrowserError::new(
            "invalid_config",
            "解析后的代理与窗口所选代理模式不一致",
        ));
    }
    match proxy.mode {
        ProxyMode::Direct if proxy.connection_url.is_some() => {
            return Err(BrowserError::new(
                "invalid_config",
                "直连窗口不能使用代理连接",
            ));
        }
        ProxyMode::Manual | ProxyMode::Plugin => {
            let connection = proxy
                .connection_url
                .as_deref()
                .ok_or_else(missing_proxy_error)?;
            if connection.trim().is_empty() || connection.chars().any(char::is_control) {
                return Err(missing_proxy_error());
            }
            let parsed = url::Url::parse(connection).map_err(|_| missing_proxy_error())?;
            if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
                || parsed.host().is_none()
                || parsed.port_or_known_default().is_none_or(|port| port == 0)
                || !matches!(parsed.path(), "" | "/")
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(missing_proxy_error());
            }
        }
        _ => {}
    }
    let mut launching = record.clone();
    // Only this immutable launch copy receives plugin credentials. Online IP
    // matching remains in the Node runner and uses this exact connection URL.
    launching.proxy = proxy.connection_url.clone();
    Ok(launching)
}

fn read_readiness(mut stdout: impl Read + Send + 'static) -> mpsc::Receiver<bool> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 1024];
        let mut line = Vec::new();
        let mut overlong = false;
        let mut notified = false;
        loop {
            match stdout.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    for byte in &buffer[..length] {
                        if *byte == b'\n' {
                            if !notified
                                && !overlong
                                && (line.as_slice() == b"NEXUS_READY"
                                    || line.as_slice() == b"NEXUS_READY\r")
                            {
                                let _ = sender.send(true);
                                notified = true;
                            }
                            line.clear();
                            overlong = false;
                        } else if line.len() < 64 {
                            line.push(*byte);
                        } else {
                            overlong = true;
                        }
                    }
                }
            }
        }
        if !notified {
            let _ = sender.send(false);
        }
    });
    receiver
}

fn read_errors(mut stderr: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0; 1024];
        loop {
            match stderr.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let remaining = STDERR_LIMIT.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&buffer[..length.min(remaining)]);
                }
            }
        }
        let _ = sender.send(bytes);
    });
    receiver
}

fn write_configuration(
    mut stdin: ChildStdin,
    config: Vec<u8>,
) -> mpsc::Receiver<Result<ChildStdin, ()>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let written = stdin
            .write_all(&config)
            .and_then(|_| stdin.write_all(b"\n"))
            .map(|_| stdin)
            .map_err(|_| ());
        let _ = sender.send(written);
    });
    receiver
}

fn runtime_error(detail: &str) -> BrowserError {
    let lower = detail.to_ascii_lowercase();
    let (code, message) =
        if lower.contains("activation_required") || lower.contains("license key is invalid") {
            (
                "auth_required",
                "激活验证未通过，请在应用设置中重新验证激活码",
            )
        } else if lower.contains("session limit") {
            ("rate_limited", "已达到浏览器并发上限，请关闭其他窗口后重试")
        } else if lower.contains("profile_engine_unsupported") {
            ("unsupported", "此窗口的浏览器内核已不受支持")
        } else if lower.contains("profile_engine_mismatch")
            || lower.contains("profile_record_invalid")
            || lower.contains("profile_kernel")
            || lower.contains("binary_version")
        {
            ("invalid_config", "浏览器内核与窗口固定绑定不一致")
        } else if lower.contains("portable_state") || lower.contains("profile_restore") {
            ("invalid_config", "无法恢复窗口站点数据，已保留导入状态")
        } else if lower.contains("profile_proxy_missing") {
            ("invalid_config", "缺少必需的代理连接，已阻止浏览器启动")
        } else if lower.contains("profile_geo_online_unavailable") {
            (
                "unavailable",
                "出口 IP 自动匹配暂不可用，请重试或在窗口设置中关闭自动匹配",
            )
        } else if lower.contains("profile_geo_proxy_connect_failed")
            || lower.contains("profile_proxy_bridge_failed")
            || lower.contains("err_no_supported_proxies")
        {
            ("unavailable", "无法连接所选代理，请检查地址和认证信息")
        } else if lower.contains("browser_runtime_dependency_missing") {
            ("unavailable", "浏览器代理运行组件不完整，请重新安装应用")
        } else if lower.contains("profile_launch_timeout") {
            ("unavailable", "浏览器启动超时，请检查所选代理和内核")
        } else {
            (
                "unavailable",
                "浏览器启动失败，请检查激活码、所选代理和绑定内核",
            )
        };
    // Runner output may contain SDK diagnostics or authenticated URLs.
    BrowserError::new(code, message)
}

fn state_error() -> BrowserError {
    BrowserError::new("unavailable", "内置浏览器进程状态暂不可用")
}

fn busy_error() -> BrowserError {
    BrowserError::new("profile_busy", "窗口正在运行或正在执行其他浏览器操作")
}

fn missing_proxy_error() -> BrowserError {
    BrowserError::new(
        "invalid_config",
        "所选代理缺少有效连接信息，已阻止浏览器启动",
    )
}

#[cfg(test)]
#[path = "cloakbrowser_tests.rs"]
mod tests;
