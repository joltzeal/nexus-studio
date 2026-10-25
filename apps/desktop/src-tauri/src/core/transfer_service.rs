use super::group_store::{GroupStore, open_database};
use super::plugin_host::{PluginHost, manifest::Capability};
use super::profile_service::{AppOperationGuard, ProfileService};
use super::profile_store::ProfileRecord;
use super::transfer_archive;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const SYNC_PLUGIN: &str = "studio.window-sync";
const MAX_WINDOWS: usize = 100;
const MAX_MANIFEST: u64 = 16 * 1024 * 1024;
const MAX_STATE: u64 = 128 * 1024 * 1024;
const MANIFEST_VERSION: u8 = 2;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PortableGroup {
    id: String,
    name: String,
    note: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PortableWindow {
    record: ProfileRecord,
    group: Option<PortableGroup>,
    kernel_version: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PluginAttachment {
    id: String,
    version: String,
    capability: Capability,
    data: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    source_platform: String,
    source_arch: String,
    created_at: u64,
    windows: Vec<PortableWindow>,
    plugins: Vec<PluginAttachment>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferReport {
    pub window_count: usize,
    pub ids: Vec<String>,
    pub warnings: Vec<String>,
    pub path: Option<String>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Copy,
    Replace,
    Preserve,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    id: String,
    capability: Capability,
    receipt: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Original {
    id: String,
    record: Option<String>,
    group_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportJournal {
    committed: bool,
    #[serde(default)]
    native_rolled_back: bool,
    originals: Vec<Original>,
    groups: Vec<PortableGroup>,
    receipts: Vec<Receipt>,
}

struct ReceiveJob {
    path: PathBuf,
    password: String,
    receiving: bool,
    operation: Option<AppOperationGuard>,
}

pub struct TransferService {
    profiles: Arc<ProfileService>,
    host: Arc<PluginHost>,
    root: PathBuf,
    jobs: Mutex<HashMap<String, ReceiveJob>>,
    import_operation: Mutex<()>,
}

fn failure(context: &str) -> String {
    format!("{context}，请检查磁盘空间与文件权限")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn canonical_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn json_file<T: serde::de::DeserializeOwned>(path: &Path, limit: u64) -> Result<T, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "窗口文件缺少必要的数据".to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取窗口文件".to_string())?;
    if bytes.len() as u64 > limit {
        return Err("窗口文件中的数据超过大小限制".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "窗口文件的数据格式无效".into())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("数据路径无效")?;
    fs::create_dir_all(parent).map_err(|_| failure("无法创建临时数据目录"))?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| failure("无法创建临时文件"))?;
    serde_json::to_writer(file.as_file_mut(), value).map_err(|_| "无法编码迁移数据")?;
    file.as_file()
        .sync_all()
        .map_err(|_| failure("无法保存迁移数据"))?;
    file.persist(path)
        .map_err(|_| failure("无法保存迁移数据"))?;
    Ok(())
}

fn call(
    host: &PluginHost,
    id: &str,
    capability: Capability,
    method: &str,
    payload: Value,
) -> Result<Value, String> {
    host.call(id, capability, method, payload, Duration::from_secs(120))
        .map_err(|error| format!("插件 {id}：{}", error.message()))
}

fn skip_browser_file(name: &str, is_user_data_root: bool) -> bool {
    // Chromium's machine-local launch breadcrumbs live only at the user-data root.
    if is_user_data_root && matches!(name, "Last Browser" | "RunningChromeVersion") {
        return true;
    }
    matches!(
        name,
        "Cache"
            | "Code Cache"
            | "GPUCache"
            | "ShaderCache"
            | "GrShaderCache"
            | "DawnCache"
            | "Crashpad"
            | "BrowserMetrics"
            | "SingletonLock"
            | "SingletonCookie"
            | "SingletonSocket"
            | "DevToolsActivePort"
            | ".DS_Store"
    )
}

fn copy_browser_tree(
    source: &Path,
    destination: &Path,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    copy_browser_directory(source, destination, count, bytes, true)
}

fn copy_browser_directory(
    source: &Path,
    destination: &Path,
    count: &mut usize,
    bytes: &mut u64,
    is_user_data_root: bool,
) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|_| failure("无法创建浏览器数据目录"))?;
    if !source.exists() {
        return Ok(());
    }
    if !fs::symlink_metadata(source)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
    {
        return Err("浏览器数据目录无效".into());
    }
    for item in fs::read_dir(source).map_err(|_| failure("无法读取浏览器数据"))? {
        let item = item.map_err(|_| failure("无法读取浏览器数据"))?;
        if skip_browser_file(&item.file_name().to_string_lossy(), is_user_data_root) {
            continue;
        }
        let kind = item
            .file_type()
            .map_err(|_| failure("无法读取浏览器数据"))?;
        let target = destination.join(item.file_name());
        if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
            return Err("浏览器数据中包含不可迁移的链接或特殊文件".into());
        }
        *count += 1;
        if *count > 100_000 {
            return Err("浏览器数据文件过多".into());
        }
        if kind.is_dir() {
            copy_browser_directory(&item.path(), &target, count, bytes, false)?;
        } else {
            *bytes += item
                .metadata()
                .map_err(|_| failure("无法读取浏览器数据"))?
                .len();
            if *bytes > 20 * 1024 * 1024 * 1024 {
                return Err("所选浏览器数据超过 20 GiB，请分批导出".into());
            }
            fs::copy(item.path(), &target).map_err(|_| failure("无法复制浏览器数据"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o600))
                    .map_err(|_| failure("无法设置浏览器数据权限"))?;
            }
        }
    }
    Ok(())
}

impl TransferService {
    pub fn new(
        profiles: Arc<ProfileService>,
        host: Arc<PluginHost>,
        root: PathBuf,
    ) -> Result<Self, String> {
        fs::create_dir_all(root.join("pending")).map_err(|_| failure("无法创建迁移目录"))?;
        for entry in fs::read_dir(&root).map_err(|_| failure("无法检查迁移临时目录"))? {
            let entry = entry.map_err(|_| failure("无法检查迁移临时目录"))?;
            if entry.file_name().to_string_lossy().starts_with(".tmp")
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                fs::remove_dir_all(entry.path()).map_err(|_| failure("无法清理中断的窗口快照"))?;
            }
        }
        if root.join("exchange").exists() {
            fs::remove_dir_all(root.join("exchange"))
                .map_err(|_| failure("无法清理上次同步的临时文件"))?;
        }
        fs::create_dir_all(root.join("exchange")).map_err(|_| failure("无法创建同步目录"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| failure("无法设置迁移目录权限"))?;
        }
        Ok(Self {
            profiles,
            host,
            root,
            jobs: Mutex::new(HashMap::new()),
            import_operation: Mutex::new(()),
        })
    }

    fn snapshot(&self, record: &ProfileRecord, output: &Path) -> Result<(), String> {
        let user_data = self
            .profiles
            .store
            .user_data_dir(&record.id)
            .map_err(|_| "窗口数据路径无效")?;
        if !user_data.exists() {
            return write_json(
                output,
                &json!({"schemaVersion":1,"storageState":{"cookies":[],"origins":[]}}),
            );
        }
        let license_key = self.profiles.license_store.require_key()?;
        let mut command = Command::new(&self.profiles.runtime.node);
        if let Some(network) = &self.profiles.network {
            network
                .get()?
                .apply_to_node(&mut command, &self.profiles.runtime.network_preload)?;
        }
        command
            .arg(&self.profiles.runtime.browser_script)
            .arg("snapshot")
            .arg(user_data)
            .env(
                "CLOAKBROWSER_CACHE_DIR",
                self.profiles.license_store.browser_cache_dir(),
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
        let mut child = command.spawn().map_err(|_| "无法启动浏览器数据读取进程")?;
        let record = serde_json::to_vec(record).map_err(|_| "无法编码窗口配置")?;
        let write = child
            .stdin
            .take()
            .ok_or("无法读取浏览器输入")
            .and_then(|mut stdin| {
                stdin
                    .write_all(&record)
                    .and_then(|()| stdin.write_all(b"\n"))
                    .map_err(|_| "无法传入窗口配置")
            });
        if let Err(error) = write {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
        let stdout = child.stdout.take().ok_or("无法读取浏览器数据")?;
        let stderr = child.stderr.take().ok_or("无法读取浏览器状态")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_STATE + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
        let diagnostics = std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut captured = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        let remaining = 8192usize.saturating_sub(captured.len());
                        captured.extend_from_slice(&buffer[..length.min(remaining)]);
                    }
                }
            }
            String::from_utf8_lossy(&captured).into_owned()
        });
        let started = Instant::now();
        let success = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if started.elapsed() < Duration::from_secs(120) => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        let bytes = reader
            .join()
            .map_err(|_| "浏览器数据读取中断")?
            .map_err(|_| "无法读取浏览器 Cookie 与站点存储")?;
        let detail = diagnostics.join().unwrap_or_default();
        if !success || bytes.len() as u64 > MAX_STATE {
            let lower = detail.to_ascii_lowercase();
            if lower.contains("session limit")
                || lower.contains("invalid or expired")
                || lower.contains("profile_launch_timeout")
                || lower.contains("portable_state")
                || lower.contains("profile_engine_mismatch")
            {
                return Err(super::kernel_service::sanitize_kernel_error(&detail));
            }
            return Err("无法读取浏览器 Cookie 与站点存储；请确认窗口已关闭且原内核可用".into());
        }
        let state: Value =
            serde_json::from_slice(&bytes).map_err(|_| "浏览器返回的站点数据无效")?;
        if state.get("schemaVersion") != Some(&json!(1))
            || !state.get("storageState").is_some_and(Value::is_object)
        {
            return Err("浏览器返回的站点数据版本不受支持".into());
        }
        write_json(output, &state)
    }

    pub fn export(
        &self,
        ids: &[String],
        password: &str,
        path: &Path,
    ) -> Result<TransferReport, String> {
        if password.chars().count() < 8 || password.len() > 1024 {
            return Err("导出密码需要至少 8 个字符".into());
        }
        if !path.is_absolute() {
            return Err("请选择本机的完整导出路径".into());
        }
        if ids.is_empty()
            || ids.len() > MAX_WINDOWS
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err("请选择 1 至 100 个不同的窗口".into());
        }
        let _operation = self.profiles.lock_transfer_operation()?;
        let _guard = self.profiles.lock_transfer(ids)?;
        let working = tempfile::tempdir_in(&self.root).map_err(|_| failure("无法创建快照目录"))?;
        let groups = GroupStore::new(self.profiles.store.database_path())?.list()?;
        let kernels = self.profiles.kernels.installed()?;
        let mut windows = Vec::new();
        let mut warnings = Vec::new();
        let mut proxy_plugins: BTreeMap<String, Vec<i64>> = BTreeMap::new();
        let mut count = 0;
        let mut bytes = 0;
        for id in ids {
            let record = self
                .profiles
                .store
                .get(id)
                .map_err(|_| "所选窗口不存在或配置损坏")?;
            let kernel = kernels
                .iter()
                .find(|kernel| Path::new(&kernel.binary_path) == record.binary_path)
                .ok_or("无法确认窗口的精确内核版本，请恢复原有内核后再导出")?;
            if record.settings.fingerprint_seed.is_none() {
                warnings.push(format!(
                    "窗口「{}」没有固定指纹种子，无法保证迁移前后指纹一致",
                    record.name
                ));
            }
            if let Some(plugin) = &record.proxy_plugin {
                let endpoints = proxy_plugins.entry(plugin.clone()).or_default();
                if let Some(endpoint) = record.proxy_endpoint {
                    endpoints.push(endpoint);
                }
            }
            let folder = working.path().join("profiles").join(id);
            fs::create_dir_all(&folder).map_err(|_| failure("无法创建窗口快照"))?;
            self.snapshot(&record, &folder.join("portable-state.json"))?;
            copy_browser_tree(
                &self
                    .profiles
                    .store
                    .user_data_dir(id)
                    .map_err(|_| "窗口路径无效")?,
                &folder.join("user-data"),
                &mut count,
                &mut bytes,
            )?;
            let group_id = self
                .profiles
                .store
                .group_id(id)
                .map_err(|_| "无法读取窗口分组")?;
            let group = groups
                .iter()
                .find(|group| Some(&group.id) == group_id.as_ref())
                .map(|group| PortableGroup {
                    id: group.id.clone(),
                    name: group.name.clone(),
                    note: group.note.clone(),
                });
            windows.push(PortableWindow {
                record,
                group,
                kernel_version: kernel.version.clone(),
            });
        }
        let catalog = self.host.catalog().map_err(|error| error.message())?;
        let mut plugins = Vec::new();
        for (id, endpoints) in proxy_plugins {
            let plugin = catalog
                .iter()
                .find(|plugin| plugin.id == id && plugin.enabled)
                .ok_or("窗口关联的代理插件未安装，无法完整导出")?;
            let include_default = windows.iter().any(|window| {
                window.record.proxy_plugin.as_deref() == Some(&id)
                    && window.record.proxy_endpoint.is_none()
            });
            let data = call(
                &self.host,
                &id,
                Capability::ProxyProvider,
                "transfer.export",
                json!({"windowIds": ids, "endpointIds":endpoints,"includeDefault":include_default}),
            )?;
            plugins.push(PluginAttachment {
                id,
                version: plugin.version.clone(),
                capability: Capability::ProxyProvider,
                data,
            });
        }
        for plugin in catalog.iter().filter(|plugin| {
            plugin.enabled && plugin.capabilities.iter().any(|cap| cap == "account.pool")
        }) {
            let data = call(
                &self.host,
                &plugin.id,
                Capability::AccountPool,
                "transfer.export",
                json!({"windowIds":ids,"endpointIds":[]}),
            )?;
            plugins.push(PluginAttachment {
                id: plugin.id.clone(),
                version: plugin.version.clone(),
                capability: Capability::AccountPool,
                data,
            });
        }
        let manifest = Manifest {
            schema_version: MANIFEST_VERSION,
            source_platform: std::env::consts::OS.into(),
            source_arch: std::env::consts::ARCH.into(),
            created_at: now(),
            windows,
            plugins,
            warnings: warnings.clone(),
        };
        write_json(&working.path().join("manifest.json"), &manifest)?;
        transfer_archive::pack(working.path(), path, password)
            .map_err(|error| error.to_string())?;
        Ok(TransferReport {
            window_count: ids.len(),
            ids: ids.to_vec(),
            warnings,
            path: Some(path.to_string_lossy().into_owned()),
        })
    }

    fn manifest(&self, extracted: &Path) -> Result<Manifest, String> {
        let value: Value = json_file(&extracted.join("manifest.json"), MAX_MANIFEST)?;
        if value.get("schemaVersion") != Some(&json!(MANIFEST_VERSION)) {
            return Err("窗口文件版本不受支持，请在新版应用中重新导出".into());
        }
        let manifest: Manifest = serde_json::from_value(value).map_err(|_| "窗口文件内容无效")?;
        if manifest.windows.is_empty() || manifest.windows.len() > MAX_WINDOWS {
            return Err("窗口文件数量不受支持".into());
        }
        let mut ids = HashSet::new();
        let mut plugins = HashSet::new();
        for window in &manifest.windows {
            let mut record = window.record.clone();
            if window.kernel_version.len() > 48
                || !(4..=5).contains(&window.kernel_version.split('.').count())
                || !window
                    .kernel_version
                    .split('.')
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                || !(window.kernel_version == record.binding.channel_version
                    || window
                        .kernel_version
                        .rsplit_once('.')
                        .is_some_and(|(chrome, _)| chrome == record.binding.channel_version))
            {
                return Err("窗口文件的精确内核版本或绑定无效".into());
            }
            if !canonical_id(&record.id) || !ids.insert(record.id.clone()) {
                return Err("窗口文件包含重复或无效标识".into());
            }
            record.binary_path = std::env::current_exe().map_err(|_| "无法确认本机路径")?;
            self.profiles
                .store
                .validate_record(&record.id, &record)
                .map_err(|_| "导入窗口的配置或内核绑定无效")?;
            if record.name.trim().is_empty() || record.name.chars().count() > 40 {
                return Err("导入窗口的名称无效".into());
            }
            let state: Value = json_file(
                &extracted
                    .join("profiles")
                    .join(&record.id)
                    .join("portable-state.json"),
                MAX_STATE,
            )?;
            if state.get("schemaVersion") != Some(&json!(1))
                || !state.get("storageState").is_some_and(Value::is_object)
            {
                return Err("窗口文件缺少可移植 Cookie 与站点存储".into());
            }
            if let Some(group) = &window.group
                && (!canonical_id(&group.id)
                    || group.name.trim().is_empty()
                    || group.name.chars().count() > 40
                    || group.note.chars().count() > 120)
            {
                return Err("导入窗口的分组无效".into());
            }
        }
        for plugin in &manifest.plugins {
            if !super::plugin_host::manifest::valid_plugin_id(&plugin.id)
                || !matches!(
                    plugin.capability,
                    Capability::ProxyProvider | Capability::AccountPool
                )
                || !plugins.insert((&plugin.id, plugin.capability))
            {
                return Err("窗口文件中的插件附件无效".into());
            }
        }
        for window in &manifest.windows {
            if window.record.proxy_plugin.as_ref().is_some_and(|id| {
                !manifest.plugins.iter().any(|plugin| {
                    &plugin.id == id && plugin.capability == Capability::ProxyProvider
                })
            }) {
                return Err("窗口文件缺少关联的代理资料".into());
            }
        }
        let paths: Vec<PathBuf> = manifest
            .windows
            .iter()
            .map(|window| {
                extracted
                    .join("profiles")
                    .join(&window.record.id)
                    .join("portable-state.json")
            })
            .collect();
        let output = super::kernel_service::run_preparation(
            Command::new(&self.profiles.runtime.node)
                .arg(&self.profiles.runtime.browser_script)
                .arg("validate-state")
                .args(&paths),
            Duration::from_secs(30),
            None,
        )
        .map_err(|_| "无法完成窗口站点数据校验，原窗口资料未修改")?;
        if !output.status.success()
            || !output
                .stdout
                .split(|byte| *byte == b'\n')
                .rev()
                .find(|line| !line.iter().all(u8::is_ascii_whitespace))
                .and_then(|line| serde_json::from_slice::<Value>(line).ok())
                .is_some_and(|value| value.get("valid") == Some(&json!(true)))
        {
            return Err("窗口文件的 Cookie 或站点数据校验失败，原窗口资料未修改".into());
        }
        Ok(manifest)
    }

    fn extracted(
        &self,
        path: &Path,
        password: &str,
    ) -> Result<(tempfile::TempDir, PathBuf), String> {
        let root = tempfile::tempdir_in(&self.root).map_err(|_| failure("无法创建解密目录"))?;
        let extracted = root.path().join("contents");
        transfer_archive::unpack(path, &extracted, password).map_err(|error| error.to_string())?;
        Ok((root, extracted))
    }

    pub fn inspect(&self, path: &Path, password: &str) -> Result<Value, String> {
        let _operation = self.profiles.lock_transfer_operation()?;
        let (_working, extracted) = self.extracted(path, password)?;
        let manifest = self.manifest(&extracted)?;
        let mut warnings = manifest.warnings;
        if manifest.source_platform != std::env::consts::OS {
            warnings
                .push("来源与本机操作系统不同，只恢复可移植站点数据；操作系统指纹会有差异".into());
        }
        Ok(json!({
            "windows":manifest.windows.iter().map(|window| json!({"id":window.record.id,"name":window.record.name,
                "version":window.kernel_version,"platform":window.record.settings.platform})).collect::<Vec<_>>(),
            "sourcePlatform":manifest.source_platform,"sourceArch":manifest.source_arch,
            "plugins":manifest.plugins.iter().map(|plugin| json!({"id":plugin.id,"version":plugin.version})).collect::<Vec<_>>(),
            "warnings":warnings
        }))
    }

    pub fn import(
        &self,
        path: &Path,
        password: &str,
        mode: ImportMode,
    ) -> Result<TransferReport, String> {
        let _activity = self.profiles.lock_transfer_operation()?;
        let _operation = self.import_operation.lock().map_err(|_| "导入状态不可用")?;
        let (_working, extracted) = self.extracted(path, password)?;
        let manifest = self.manifest(&extracted)?;
        let mut warnings = manifest.warnings.clone();
        let cross_platform = manifest.source_platform != std::env::consts::OS;
        if cross_platform {
            warnings.push("跨操作系统导入已恢复可移植站点数据；系统指纹与原机器不同".into());
        }
        let existing = self.profiles.store.list().map_err(|_| "无法读取本机窗口")?;
        let installed = self.profiles.kernels.installed()?;
        let mut id_map = BTreeMap::new();
        let mut records = Vec::new();
        let mut binaries = HashMap::new();
        for window in &manifest.windows {
            let mut record = window.record.clone();
            let id = match mode {
                ImportMode::Copy => Uuid::new_v4().to_string(),
                ImportMode::Replace | ImportMode::Preserve => record.id.clone(),
            };
            if matches!(mode, ImportMode::Preserve) && existing.iter().any(|old| old.id == id) {
                return Err(
                    "本机已有同标识窗口；如需同步更新，请先关闭该窗口，再明确选择覆盖".into(),
                );
            }
            if let Some(old) = existing.iter().find(|old| old.id == id)
                && (old.binding.channel_version != record.binding.channel_version
                    || old.settings.fingerprint_seed != record.settings.fingerprint_seed
                    || !installed.iter().any(|kernel| {
                        Path::new(&kernel.binary_path) == old.binary_path
                            && kernel.version == window.kernel_version
                    }))
            {
                return Err("已有窗口的内核版本与指纹种子不可更改，请选择导入副本".into());
            }
            let package = window.kernel_version.clone();
            if !binaries.contains_key(&package) {
                binaries.insert(
                    package.clone(),
                    self.profiles.kernels.exact_binary(&window.kernel_version)?,
                );
            }
            let binary = &binaries[&package];
            if binary.version != record.binding.channel_version {
                return Err("目标内核与窗口原始版本不匹配，导入已停止".into());
            }
            record.binary_path = binary.binary_path.clone();
            id_map.insert(record.id.clone(), id.clone());
            record.id = id.clone();
            record.binding.profile_id = id;
            records.push(record);
        }
        let ids: Vec<String> = records.iter().map(|record| record.id.clone()).collect();
        let _guard = self.profiles.lock_transfer(&ids)?;
        let catalog = self.host.catalog().map_err(|error| error.message())?;
        for plugin in &manifest.plugins {
            if !catalog.iter().any(|local| {
                local.id == plugin.id
                    && local.enabled
                    && local
                        .capabilities
                        .iter()
                        .any(|cap| cap == plugin.capability.as_str())
            }) {
                return Err(format!("请先安装窗口文件需要的插件：{}", plugin.id));
            }
            self.host
                .require_methods(
                    &plugin.id,
                    plugin.capability,
                    &["transfer.import", "transfer.rollback", "transfer.commit"],
                )
                .map_err(|_| format!("插件 {} 不支持完整迁移，请先更新该插件", plugin.id))?;
        }
        let operation = self.root.join("pending").join(Uuid::new_v4().to_string());
        fs::create_dir_all(operation.join("backup")).map_err(|_| failure("无法创建导入事务"))?;
        let db = open_database(&self.profiles.store.database_path())?;
        let mut originals = Vec::new();
        for id in &ids {
            let old: Option<(String, Option<String>)> = db
                .query_row(
                    "SELECT record_json, group_id FROM profile_records WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| "无法准备导入事务")?;
            originals.push(Original {
                id: id.clone(),
                record: old.as_ref().map(|value| value.0.clone()),
                group_id: old.and_then(|value| value.1),
            });
        }
        let local_groups = GroupStore::new(self.profiles.store.database_path())?.list()?;
        let mut group_map = HashMap::new();
        let mut new_groups = Vec::new();
        for window in &manifest.windows {
            if let Some(group) = &window.group
                && !group_map.contains_key(&group.id)
            {
                let same = local_groups.iter().find(|local| local.id == group.id);
                let id = match same {
                    Some(local) if local.name == group.name && local.note == group.note => {
                        group.id.clone()
                    }
                    Some(_) => Uuid::new_v4().to_string(),
                    None => group.id.clone(),
                };
                if !local_groups.iter().any(|group| group.id == id) {
                    new_groups.push(PortableGroup {
                        id: id.clone(),
                        name: group.name.clone(),
                        note: group.note.clone(),
                    });
                }
                group_map.insert(group.id.clone(), id);
            }
        }
        let mut journal = ImportJournal {
            committed: false,
            native_rolled_back: false,
            originals,
            groups: new_groups,
            receipts: Vec::new(),
        };
        write_json(&operation.join("journal.json"), &journal)?;
        let result = (|| {
            let mut endpoint_maps: HashMap<String, HashMap<String, i64>> = HashMap::new();
            for plugin in &manifest.plugins {
                let transaction_id = Uuid::new_v4().to_string();
                journal.receipts.push(Receipt {
                    id: plugin.id.clone(),
                    capability: plugin.capability,
                    receipt: transaction_id.clone(),
                });
                write_json(&operation.join("journal.json"), &journal)?;
                let imported = call(
                    &self.host,
                    &plugin.id,
                    plugin.capability,
                    "transfer.import",
                    json!({"data":plugin.data,"windowIdMap":id_map,"transactionId":transaction_id}),
                )?;
                let receipt = imported
                    .get("receipt")
                    .and_then(Value::as_str)
                    .ok_or("插件未返回导入收据")?;
                journal.receipts.last_mut().ok_or("导入收据缺失")?.receipt = receipt.into();
                write_json(&operation.join("journal.json"), &journal)?;
                if plugin.capability == Capability::ProxyProvider {
                    let map: HashMap<String, i64> = serde_json::from_value(
                        imported
                            .get("endpointIdMap")
                            .cloned()
                            .ok_or("代理插件未返回端点映射")?,
                    )
                    .map_err(|_| "代理插件端点映射无效")?;
                    endpoint_maps.insert(plugin.id.clone(), map);
                }
            }
            for (index, window) in manifest.windows.iter().enumerate() {
                let record = &mut records[index];
                if let Some(plugin_id) = &record.proxy_plugin {
                    let source = record
                        .proxy_endpoint
                        .or_else(|| {
                            manifest
                                .plugins
                                .iter()
                                .find(|plugin| plugin.id == *plugin_id)
                                .and_then(|plugin| plugin.data.get("defaultEndpointId"))
                                .and_then(Value::as_i64)
                        })
                        .ok_or("窗口原来的默认代理缺失，导入已停止")?;
                    record.proxy_endpoint = Some(
                        *endpoint_maps
                            .get(plugin_id)
                            .and_then(|map| map.get(&source.to_string()))
                            .ok_or("窗口关联的代理未完整恢复")?,
                    );
                }
                self.profiles
                    .store
                    .validate_record(&record.id, record)
                    .map_err(|_| "导入配置校验失败")?;
                let destination = operation.join("new").join(&record.id);
                fs::create_dir_all(&destination).map_err(|_| failure("无法准备导入数据"))?;
                let source = extracted.join("profiles").join(&window.record.id);
                if !cross_platform {
                    copy_browser_tree(
                        &source.join("user-data"),
                        &destination.join("user-data"),
                        &mut 0,
                        &mut 0,
                    )?;
                } else {
                    fs::create_dir_all(destination.join("user-data"))
                        .map_err(|_| failure("无法创建浏览器目录"))?;
                }
                fs::copy(
                    source.join("portable-state.json"),
                    destination.join("portable-state.json"),
                )
                .map_err(|_| failure("无法恢复 Cookie 与站点数据"))?;
            }
            let mut db = open_database(&self.profiles.store.database_path())?;
            let transaction = db.transaction().map_err(|_| "无法开始导入事务")?;
            for group in &journal.groups {
                transaction
                    .execute(
                        "INSERT INTO groups(id,name,note) VALUES(?1,?2,?3)",
                        params![group.id, group.name, group.note],
                    )
                    .map_err(|_| "无法导入分组")?;
            }
            fs::create_dir_all(self.profiles.store.root())
                .map_err(|_| failure("无法创建窗口目录"))?;
            for (index, record) in records.iter().enumerate() {
                let target = self.profiles.store.root().join(&record.id);
                if target.exists() {
                    fs::rename(&target, operation.join("backup").join(&record.id))
                        .map_err(|_| failure("无法备份原窗口"))?;
                }
                fs::rename(operation.join("new").join(&record.id), &target)
                    .map_err(|_| failure("无法恢复浏览器环境"))?;
                let group_id = manifest.windows[index]
                    .group
                    .as_ref()
                    .and_then(|group| group_map.get(&group.id));
                transaction.execute("INSERT INTO profile_records(id,record_json,group_id) VALUES(?1,?2,?3)
                    ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,group_id=excluded.group_id",
                    params![record.id,serde_json::to_string(record).map_err(|_| "无法编码窗口")?,group_id])
                    .map_err(|_| "无法保存导入窗口")?;
            }
            transaction.commit().map_err(|_| "无法提交导入窗口")?;
            journal.committed = true;
            if let Err(error) = write_json(&operation.join("journal.json"), &journal) {
                journal.committed = false;
                return Err(error);
            }
            self.profiles.restore_imported(&records)?;
            Ok(())
        })();
        if let Err(error) = result {
            if !journal.committed {
                self.rollback(&operation, &mut journal)?;
            }
            return Err(error);
        }
        if finalize_receipts(&self.host, &journal).is_ok() {
            fs::remove_dir_all(&operation).map_err(|_| failure("无法清理已完成导入的备份"))?;
        } else {
            warnings.push("窗口已导入，部分插件收据将在下次启动时清理".into());
        }
        Ok(TransferReport {
            window_count: ids.len(),
            ids,
            warnings,
            path: None,
        })
    }

    fn rollback(&self, operation: &Path, journal: &mut ImportJournal) -> Result<(), String> {
        let result = rollback_import(
            &self.profiles.store.database_path(),
            self.profiles.store.root(),
            operation,
            journal,
            &self.host,
        );
        if let Err(error) = result {
            if !journal.native_rolled_back {
                let ids: Vec<String> = journal
                    .originals
                    .iter()
                    .map(|original| original.id.clone())
                    .collect();
                self.profiles.block_recovery(&ids)?;
                return Err(
                    "窗口资料恢复未完成，已暂停相关操作；请重启应用重试，原备份已保留".into(),
                );
            }
            return Err(error);
        }
        fs::remove_dir_all(operation).map_err(|_| failure("无法清理失败的导入"))
    }

    pub fn offer(&self, ids: &[String]) -> Result<Value, String> {
        let operation = self.profiles.lock_transfer_operation()?;
        if !self
            .host
            .catalog()
            .map_err(|error| error.message())?
            .iter()
            .any(|plugin| {
                plugin.id == SYNC_PLUGIN
                    && plugin.enabled
                    && plugin.capabilities.iter().any(|cap| cap == "window.sync")
            })
        {
            return Err("请先到插件中心安装「窗口同步」插件".into());
        }
        let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let path = self
            .root
            .join("exchange")
            .join(format!("{}.nexuswindow", Uuid::new_v4()));
        self.export(ids, &secret, &path)?;
        match call(
            &self.host,
            SYNC_PLUGIN,
            Capability::WindowSync,
            "sync.offer",
            json!({"filePath":path,"secret":secret}),
        ) {
            Ok(result) => {
                let id = result
                    .get("offerId")
                    .and_then(Value::as_str)
                    .ok_or("同步插件未返回发送标识")?;
                self.jobs.lock().map_err(|_| "同步状态不可用")?.insert(
                    id.into(),
                    ReceiveJob {
                        path,
                        password: secret,
                        receiving: false,
                        operation: Some(operation),
                    },
                );
                Ok(result)
            }
            Err(error) => {
                let _ = fs::remove_file(path);
                Err(error)
            }
        }
    }

    pub fn receive(&self, invitation: &str, host: Option<&str>) -> Result<Value, String> {
        let operation = self.profiles.lock_transfer_operation()?;
        // Parsing and expiry validation are also enforced independently by the transport.
        let invitation_data = decode_invitation(invitation)?;
        let password = invitation_data
            .get("secret")
            .and_then(Value::as_str)
            .ok_or("配对码缺少必要信息")?
            .to_string();
        let path = self
            .root
            .join("exchange")
            .join(format!("{}.nexuswindow", Uuid::new_v4()));
        let mut payload = json!({"invitation":invitation,"destination":path});
        if let Some(host) = host.filter(|host| !host.trim().is_empty()) {
            payload["host"] = json!(host);
        }
        let result = call(
            &self.host,
            SYNC_PLUGIN,
            Capability::WindowSync,
            "sync.receive",
            payload,
        )?;
        let id = result
            .get("jobId")
            .and_then(Value::as_str)
            .ok_or("同步插件未返回任务标识")?;
        self.jobs.lock().map_err(|_| "同步状态不可用")?.insert(
            id.into(),
            ReceiveJob {
                path,
                password,
                receiving: true,
                operation: Some(operation),
            },
        );
        Ok(result)
    }

    pub(crate) fn prepare_app_install(&self) -> Result<AppOperationGuard, &'static str> {
        let active_jobs: Vec<String> = self
            .jobs
            .lock()
            .map_err(|_| "profiles_failed")?
            .iter()
            .filter(|(_, job)| job.operation.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        // A closed dialog no longer polls; refresh without holding the jobs lock
        // so terminal transfers can release their installation reservations.
        for id in active_jobs {
            self.sync_status(&id).map_err(|_| "profiles_failed")?;
        }
        self.profiles.lock_app_install()
    }

    pub fn sync_status(&self, id: &str) -> Result<Value, String> {
        let mut result = call(
            &self.host,
            SYNC_PLUGIN,
            Capability::WindowSync,
            "sync.status",
            json!({"id":id}),
        )?;
        if matches!(
            result.get("state").and_then(Value::as_str),
            Some("completed" | "failed" | "cancelled")
        ) {
            let mut jobs = self.jobs.lock().map_err(|_| "同步状态不可用")?;
            if let Some(job) = jobs.get_mut(id) {
                job.operation.take();
            }
            if jobs.get(id).is_some_and(|job| !job.receiving)
                && let Some(job) = jobs.remove(id)
            {
                let _ = fs::remove_file(job.path);
            }
        }
        // The plugin's managed filesystem path is internal to the native import path.
        if let Some(object) = result.as_object_mut() {
            object.remove("path");
        }
        Ok(result)
    }

    pub fn sync_cancel(&self, id: &str) -> Result<(), String> {
        call(
            &self.host,
            SYNC_PLUGIN,
            Capability::WindowSync,
            "sync.cancel",
            json!({"id":id}),
        )?;
        if let Some(job) = self.jobs.lock().map_err(|_| "同步状态不可用")?.remove(id) {
            let _ = fs::remove_file(job.path);
        }
        Ok(())
    }

    pub fn sync_import(&self, id: &str, mode: ImportMode) -> Result<TransferReport, String> {
        let _operation = self.profiles.lock_transfer_operation()?;
        let status = self.sync_status(id)?;
        if status.get("state").and_then(Value::as_str) != Some("completed") {
            return Err("同步数据尚未完整接收".into());
        }
        let (path, password) = {
            let jobs = self.jobs.lock().map_err(|_| "同步状态不可用")?;
            let job = jobs
                .get(id)
                .ok_or("同步接收任务不存在或应用已经重启，请重新接收")?;
            if !job.receiving {
                return Err("该任务是发送任务，不能导入".into());
            }
            (job.path.clone(), job.password.clone())
        };
        let report = self.import(
            &path,
            &password,
            match mode {
                ImportMode::Copy => ImportMode::Preserve,
                mode => mode,
            },
        )?;
        self.jobs.lock().map_err(|_| "同步状态不可用")?.remove(id);
        let _ = fs::remove_file(path);
        Ok(report)
    }

    pub fn recovery_status(&self) -> Result<Value, String> {
        let _activity = self.profiles.lock_transfer_operation()?;
        let _operation = self
            .import_operation
            .try_lock()
            .map_err(|_| "窗口迁移正在进行，请稍后刷新恢复状态")?;
        let mut pending = 0usize;
        let mut warnings = Vec::new();
        for item in fs::read_dir(self.root.join("pending")).map_err(|_| "无法检查迁移恢复状态")?
        {
            let item = item.map_err(|_| "无法读取迁移恢复记录")?;
            if !item
                .file_type()
                .map_err(|_| "无法读取迁移恢复记录")?
                .is_dir()
            {
                continue;
            }
            let path = item.path();
            let journal: ImportJournal = json_file(&path.join("journal.json"), MAX_MANIFEST)?;
            if !journal.committed && !journal.native_rolled_back {
                pending += 1;
                warnings
                    .push("上次窗口资料恢复未完成，相关窗口已暂停操作，请重启应用重试".to_string());
                continue;
            }
            let result = if journal.committed {
                finalize_receipts(&self.host, &journal)
            } else {
                rollback_receipts(&self.host, &journal)
            };
            if result.is_err() {
                pending += 1;
                let plugins: Vec<&str> = journal
                    .receipts
                    .iter()
                    .map(|receipt| receipt.id.as_str())
                    .collect();
                warnings.push(format!(
                    "上次窗口迁移的插件资料尚待恢复，请安装或更新所需插件后刷新重试：{}",
                    plugins.join("、")
                ));
            } else if fs::remove_dir_all(&path).is_err() {
                pending += 1;
                warnings
                    .push("窗口资料已恢复，但迁移备份尚未清理，请检查磁盘权限后刷新重试".into());
            }
        }
        Ok(json!({"pending":pending,"warnings":warnings}))
    }
}

fn finalize_receipts(host: &PluginHost, journal: &ImportJournal) -> Result<(), String> {
    for receipt in &journal.receipts {
        call(
            host,
            &receipt.id,
            receipt.capability,
            "transfer.commit",
            json!({"receipt":receipt.receipt}),
        )?;
    }
    Ok(())
}

fn rollback_import(
    db_path: &PathBuf,
    profiles: &Path,
    operation: &Path,
    journal: &mut ImportJournal,
    host: &PluginHost,
) -> Result<(), String> {
    if !journal.native_rolled_back {
        rollback_native(db_path, profiles, operation, journal)?;
        journal.native_rolled_back = true;
        if let Err(error) = write_json(&operation.join("journal.json"), journal) {
            journal.native_rolled_back = false;
            return Err(error);
        }
    }
    rollback_receipts(host, journal)
}

fn rollback_receipts(host: &PluginHost, journal: &ImportJournal) -> Result<(), String> {
    for receipt in journal.receipts.iter().rev() {
        call(
            host,
            &receipt.id,
            receipt.capability,
            "transfer.rollback",
            json!({"receipt":receipt.receipt}),
        )?;
    }
    Ok(())
}

fn rollback_native(
    db_path: &PathBuf,
    profiles: &Path,
    operation: &Path,
    journal: &ImportJournal,
) -> Result<(), String> {
    let mut db = open_database(db_path)?;
    let transaction = db.transaction().map_err(|_| "无法恢复导入前的资料")?;
    for original in &journal.originals {
        if Uuid::parse_str(&original.id).is_err() {
            return Err("导入恢复记录无效".into());
        }
        let target = profiles.join(&original.id);
        let backup = operation.join("backup").join(&original.id);
        let staged = operation.join("new").join(&original.id);
        if backup.exists() {
            if target.exists() {
                fs::remove_dir_all(&target).map_err(|_| failure("无法恢复原浏览器数据"))?;
            }
            fs::rename(&backup, &target).map_err(|_| failure("无法恢复原浏览器数据"))?;
        } else if original.record.is_none() && !staged.exists() && target.exists() {
            fs::remove_dir_all(&target).map_err(|_| failure("无法清理失败导入的数据"))?;
        }
        if let Some(record) = &original.record {
            let current: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT record_json, group_id FROM profile_records WHERE id=?1",
                    [&original.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| "无法读取原窗口资料")?;
            if current
                .as_ref()
                .is_none_or(|(json, group)| json != record || group != &original.group_id)
            {
                transaction.execute("INSERT INTO profile_records(id,record_json,group_id) VALUES(?1,?2,?3)
                    ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,group_id=excluded.group_id",
                    params![original.id,record,original.group_id]).map_err(|_| "无法恢复原窗口资料")?;
            }
        } else {
            transaction
                .execute("DELETE FROM profile_records WHERE id=?1", [&original.id])
                .map_err(|_| "无法撤回导入窗口")?;
        }
    }
    for group in &journal.groups {
        transaction
            .execute(
                "DELETE FROM groups WHERE id=?1 AND name=?2 AND note=?3 \
                 AND NOT EXISTS(SELECT 1 FROM profile_records WHERE group_id=?1)",
                params![group.id, group.name, group.note],
            )
            .map_err(|_| "无法撤回导入分组")?;
    }
    transaction.commit().map_err(|_| "无法提交导入恢复事务")?;
    Ok(())
}

/// Run before ProfileService loads bindings: interrupted filesystem moves may
/// otherwise look like corrupt or orphaned profiles.
pub fn recover_pending(app_data: &Path) -> Result<usize, String> {
    let pending = app_data.join("transfers/pending");
    if !pending.exists() {
        return Ok(0);
    }
    let mut deferred = 0;
    for item in fs::read_dir(&pending).map_err(|_| "无法检查未完成的窗口导入")? {
        let item = item.map_err(|_| "无法检查未完成的窗口导入")?;
        if !item.file_type().map_err(|_| "无法检查迁移事务")?.is_dir() {
            continue;
        }
        let path = item.path();
        if !path.join("journal.json").exists() {
            fs::remove_dir_all(&path).map_err(|_| failure("无法清理未开始的导入"))?;
            continue;
        }
        let mut journal: ImportJournal = json_file(&path.join("journal.json"), MAX_MANIFEST)?;
        if !journal.committed && !journal.native_rolled_back {
            rollback_native(
                &app_data.join("nexus.sqlite"),
                &app_data.join("profiles"),
                &path,
                &journal,
            )?;
            journal.native_rolled_back = true;
            write_json(&path.join("journal.json"), &journal)?;
        }
        if journal.receipts.is_empty() {
            fs::remove_dir_all(&path).map_err(|_| failure("无法清理迁移事务"))?;
        } else {
            deferred += 1;
        }
    }
    Ok(deferred)
}

fn decode_invitation(invitation: &str) -> Result<Value, String> {
    use base64::Engine;
    let encoded = invitation
        .trim()
        .strip_prefix("nexus-sync:")
        .ok_or("配对码格式不正确")?;
    if encoded.len() > 8192 {
        return Err("配对码过长".into());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "配对码格式不正确")?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "配对码格式不正确")?;
    let secret = value
        .get("secret")
        .and_then(Value::as_str)
        .ok_or("配对码格式不正确")?;
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("配对码格式不正确".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn profile_transfer_recovery_status(
    state: State<'_, Arc<TransferService>>,
) -> Result<Value, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.recovery_status())
        .await
        .map_err(|_| "迁移恢复状态检查中断".to_string())?
}

#[tauri::command]
pub async fn profile_transfer_pick(
    app: tauri::AppHandle,
    save: bool,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .add_filter("Nexus 窗口", &["nexuswindow"]);
        let path = if save {
            dialog
                .set_file_name("windows.nexuswindow")
                .blocking_save_file()
        } else {
            dialog.blocking_pick_file()
        };
        path.map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|_| "只能选择本机文件".to_string())
        })
        .transpose()
    })
    .await
    .map_err(|_| "文件选择中断".to_string())?
}

#[tauri::command]
pub async fn profile_transfer_export(
    state: State<'_, Arc<TransferService>>,
    ids: Vec<String>,
    password: String,
    path: String,
) -> Result<TransferReport, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.export(&ids, &password, Path::new(&path)))
        .await
        .map_err(|_| "窗口导出任务中断".to_string())?
}

#[tauri::command]
pub async fn profile_transfer_inspect(
    state: State<'_, Arc<TransferService>>,
    path: String,
    password: String,
) -> Result<Value, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.inspect(Path::new(&path), &password))
        .await
        .map_err(|_| "窗口文件检查中断".to_string())?
}

#[tauri::command]
pub async fn profile_transfer_import(
    state: State<'_, Arc<TransferService>>,
    path: String,
    password: String,
    mode: ImportMode,
) -> Result<TransferReport, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.import(Path::new(&path), &password, mode))
        .await
        .map_err(|_| "窗口导入任务中断".to_string())?
}

#[tauri::command]
pub async fn profile_sync_offer(
    state: State<'_, Arc<TransferService>>,
    ids: Vec<String>,
) -> Result<Value, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.offer(&ids))
        .await
        .map_err(|_| "窗口同步发送中断".to_string())?
}

#[tauri::command]
pub async fn profile_sync_receive(
    state: State<'_, Arc<TransferService>>,
    invitation: String,
    host: Option<String>,
) -> Result<Value, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.receive(&invitation, host.as_deref()))
        .await
        .map_err(|_| "窗口同步接收中断".to_string())?
}

#[tauri::command]
pub async fn profile_sync_status(
    state: State<'_, Arc<TransferService>>,
    id: String,
) -> Result<Value, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.sync_status(&id))
        .await
        .map_err(|_| "同步状态读取中断".to_string())?
}

#[tauri::command]
pub async fn profile_sync_cancel(
    state: State<'_, Arc<TransferService>>,
    id: String,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.sync_cancel(&id))
        .await
        .map_err(|_| "同步取消中断".to_string())?
}

#[tauri::command]
pub async fn profile_sync_import(
    state: State<'_, Arc<TransferService>>,
    id: String,
    mode: ImportMode,
) -> Result<TransferReport, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.sync_import(&id, mode))
        .await
        .map_err(|_| "同步窗口导入中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        license_store::LicenseStore,
        profile_store::{PreparedBinary, ProxySource, WindowSettings},
        runtime_paths::RuntimePaths,
    };

    fn service(root: &Path) -> TransferService {
        fs::create_dir_all(root).unwrap();
        let binary = root.join("browser");
        fs::write(&binary, b"browser-fixture").unwrap();
        let runner = root.join("runner.cjs");
        let inventory = root.join("inventory.json");
        write_json(
            &inventory,
            &json!([{"version":"155.0.8059.39","binaryPath":binary}]),
        )
        .unwrap();
        fs::write(&runner, format!(
            "const fs=require('node:fs'); const inventory={}; const prepared={}; const action = process.argv[2]; if(action==='validate-state') process.stdout.write(JSON.stringify({{valid:true}})); else if(action==='version') process.stdout.write(JSON.stringify({{version:'155.0.8059.39',binary_path:process.argv[3]}})); else if(action==='inventory') process.stdout.write(JSON.stringify({{cacheDir:'.',platform:'darwin-arm64',installed:JSON.parse(fs.readFileSync(inventory,'utf8'))}})); else if(action==='prepare'){{if(!fs.existsSync(prepared))process.exit(42);const entry=JSON.parse(fs.readFileSync(prepared,'utf8'));fs.writeFileSync(inventory,JSON.stringify([entry]));process.stdout.write(JSON.stringify({{version:'155.0.8059.39',binary_path:entry.binaryPath}}));}} else if(action==='snapshot'){{process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({{schemaVersion:1,storageState:{{cookies:[{{name:'session',value:'portable-session',domain:'example.test',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}}],origins:[]}}}})));}}",
            serde_json::to_string(&inventory).unwrap(),
            serde_json::to_string(&root.join("prepared-kernel.json")).unwrap()
        )).unwrap();
        let runtime = RuntimePaths {
            node: "node".into(),
            browser_script: runner,
            network_preload: root.join("preload.js"),
        };
        let licenses = LicenseStore::new(root.join("nexus.sqlite")).unwrap();
        licenses
            .save_validated("synthetic-transfer-key", "pro", None)
            .unwrap();
        let profiles = Arc::new(
            ProfileService::with_runtime(root.join("profiles"), None, licenses, runtime).unwrap(),
        );
        let host = Arc::new(PluginHost::open(root.join("plugins"), Vec::new()).unwrap());
        TransferService::new(profiles, host, root.join("transfers")).unwrap()
    }

    fn kernel_package(service: &TransferService, version: &str) -> Value {
        json!({"version":version,"binaryPath":service.root.parent().unwrap().join("browser")})
    }

    fn set_kernel_package(service: &TransferService, version: &str) {
        write_json(
            &service.root.parent().unwrap().join("inventory.json"),
            &json!([kernel_package(service, version)]),
        )
        .unwrap();
    }

    fn window(service: &TransferService) -> ProfileRecord {
        let binary = service.root.parent().unwrap().join("browser");
        let record = service
            .profiles
            .store
            .create_with_settings(
                "Window",
                None,
                None,
                WindowSettings {
                    fingerprint_seed: Some(12345),
                    ..WindowSettings::default()
                },
                PreparedBinary {
                    version: "155.0.8059.39".into(),
                    binary_path: binary,
                },
            )
            .unwrap();
        let data = service.profiles.store.user_data_dir(&record.id).unwrap();
        fs::create_dir_all(data.join("Default")).unwrap();
        fs::write(data.join("Default/Cookies"), b"machine-encrypted-database").unwrap();
        fs::create_dir_all(data.join("Default/Cache")).unwrap();
        fs::write(data.join("Default/Cache/discard"), b"cache").unwrap();
        record
    }

    #[test]
    fn install_guard_blocks_import_before_kernel_preparation() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        let record = window(&source);
        let path = root.path().join("fixture.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "fixture-password", &path)
            .unwrap();
        let marker = root.path().join("preparation-started");
        let runner = &target.profiles.runtime.browser_script;
        fs::write(
            runner,
            format!(
                "require('node:fs').writeFileSync({}, 'unexpected preparation');\n{}",
                serde_json::to_string(&marker).unwrap(),
                fs::read_to_string(runner).unwrap(),
            ),
        )
        .unwrap();
        let guard = target.profiles.lock_app_install().unwrap();
        assert!(
            target
                .import(&path, "fixture-password", ImportMode::Copy)
                .is_err()
        );
        assert!(
            !marker.exists(),
            "import executed a bundled runtime during installation"
        );
        assert!(target.profiles.store.list().unwrap().is_empty());
        assert!(target.inspect(&path, "fixture-password").is_err());
        drop(guard);
        assert!(target.inspect(&path, "fixture-password").is_ok());
    }

    fn install_sync_fixture(service: &TransferService) -> PathBuf {
        let package = service.root.parent().unwrap().join("sync-fixture");
        fs::create_dir_all(package.join("dist")).unwrap();
        write_json(
            &package.join("nexus.plugin.json"),
            &json!({
                "apiVersion": 1, "id": SYNC_PLUGIN, "version": "1.0.0",
                "name": "Synthetic sync", "minCoreVersion": "0.1.0",
                "capabilities": ["window.sync"],
                "permissions": {
                    "networkDomains": [], "wantsBrowserAccess": false,
                    "storage": "private", "secrets": [],
                },
            }),
        )
        .unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"name":"sync-fixture","main":"dist/index.cjs"}"#,
        )
        .unwrap();
        let status = service.root.parent().unwrap().join("sync-state.json");
        write_json(
            &status,
            &json!({"state":"transferring", "bytes":0, "total":26}),
        )
        .unwrap();
        fs::write(package.join("dist/index.cjs"), format!(r#"
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const identity = {{protocolVersion:1, pluginId:'studio.window-sync', version:'1.0.0', capabilities:['window.sync']}};
send({{...identity, type:'hello', apiVersion:1}});
require('node:readline').createInterface({{input:process.stdin}}).on('line', line => {{
  const request = JSON.parse(line);
  if (request.type === 'handshake') {{
    send({{...identity, type:'ready', methods:['sync.offer','sync.receive','sync.status','sync.cancel'], status:{{}}}});
    return;
  }}
  let result = {{}};
  if (request.method === 'sync.receive') {{
    fs.writeFileSync(request.payload.destination, 'synthetic received package');
    result = {{jobId:'receive-fixture'}};
  }} else if (request.method === 'sync.offer') result = {{offerId:'offer-fixture'}};
  else if (request.method === 'sync.status') result = JSON.parse(fs.readFileSync({}, 'utf8'));
  send({{protocolVersion:1, requestId:request.requestId, ok:true, result}});
}});
"#, serde_json::to_string(&status).unwrap())).unwrap();
        service.host.install(&package).unwrap();
        status
    }

    #[test]
    fn install_guard_covers_sync_transport_until_terminal_status_or_cancel() {
        use base64::Engine;
        struct StopHost<'a>(&'a PluginHost);
        impl Drop for StopHost<'_> {
            fn drop(&mut self) {
                self.0.shutdown();
            }
        }
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let _stop_host = StopHost(&service.host);
        let status = install_sync_fixture(&service);
        let invitation = format!(
            "nexus-sync:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&json!({"secret":"0".repeat(64)})).unwrap())
        );
        for terminal in ["completed", "failed", "cancelled"] {
            service.receive(&invitation, None).unwrap();
            let path = service.jobs.lock().unwrap()["receive-fixture"].path.clone();
            assert_eq!(
                service.profiles.lock_app_install().err(),
                Some("running_windows")
            );
            write_json(&status, &json!({"state": terminal})).unwrap();
            service.sync_status("receive-fixture").unwrap();
            let guard = service.profiles.lock_app_install().unwrap();
            assert!(service.receive(&invitation, None).is_err());
            // Completed packages remain available for explicit import after a failed install.
            assert!(path.exists());
            drop(guard);
            service.sync_cancel("receive-fixture").unwrap();
            assert!(!path.exists());
        }
        let record = window(&service);
        service.offer(std::slice::from_ref(&record.id)).unwrap();
        assert_eq!(
            service.profiles.lock_app_install().err(),
            Some("running_windows")
        );
        service.sync_cancel("offer-fixture").unwrap();
        assert!(service.profiles.lock_app_install().is_ok());
    }

    #[test]
    fn install_rechecks_finished_sync_without_requiring_an_open_dialog() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let status = install_sync_fixture(&service);
        let record = window(&service);
        service.offer(std::slice::from_ref(&record.id)).unwrap();
        assert_eq!(service.prepare_app_install().err(), Some("running_windows"));

        // The plugin finished after the user left the dialog, so no UI poll runs.
        write_json(&status, &json!({"state":"completed"})).unwrap();
        let admitted = service.prepare_app_install();
        service.host.shutdown();
        assert!(
            admitted.is_ok(),
            "a finished sync retained the install reservation"
        );
        assert!(service.jobs.lock().unwrap().is_empty());
    }

    const SITE_STORAGE_FILES: &[(&str, &[u8])] = &[
        ("Local State", b"synthetic-local-state"),
        ("Default/Cookies", b"synthetic-cookie-database"),
        ("Default/Network/Cookies", b"synthetic-network-cookies"),
        (
            "Default/Local Storage/leveldb/000003.log",
            b"synthetic-local-storage",
        ),
        (
            "Default/IndexedDB/https_fixture.test_0.indexeddb.leveldb/000003.log",
            b"synthetic-indexeddb",
        ),
        ("Default/File System/000/t/00/00000001", b"synthetic-opfs"),
        (
            "Default/Service Worker/CacheStorage/fixture/entry",
            b"synthetic-cache-storage",
        ),
        ("Default/Last Browser", b"nested-site-file"),
        ("Default/RunningChromeVersion", b"another-nested-site-file"),
    ];

    fn write_site_storage(root: &Path) {
        for (relative, contents) in SITE_STORAGE_FILES {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    fn assert_site_storage(root: &Path) {
        for (relative, contents) in SITE_STORAGE_FILES {
            assert_eq!(
                fs::read(root.join(relative)).unwrap(),
                *contents,
                "{relative}"
            );
        }
    }

    #[test]
    fn browser_copy_omits_root_runtime_breadcrumbs_but_preserves_site_storage() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        write_site_storage(&source);
        fs::write(source.join("Last Browser"), b"C:\\fixture\\chrome.exe").unwrap();
        fs::write(source.join("RunningChromeVersion"), b"151.0.7922.108").unwrap();
        let mut count = 0;
        let mut bytes = 0;
        copy_browser_tree(&source, &destination, &mut count, &mut bytes).unwrap();
        assert_site_storage(&destination);
        for name in ["Last Browser", "RunningChromeVersion"] {
            assert!(
                fs::symlink_metadata(destination.join(name)).is_err(),
                "machine-local browser breadcrumb {name} must not be copied"
            );
        }
        assert_eq!(
            bytes,
            SITE_STORAGE_FILES
                .iter()
                .map(|(_, contents)| contents.len() as u64)
                .sum::<u64>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn browser_copy_ignores_leftover_running_chrome_version_link() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        fs::create_dir_all(&source).unwrap();
        std::os::unix::fs::symlink("151.0.7922.108", source.join("RunningChromeVersion")).unwrap();
        let mut count = 0;
        let mut bytes = 0;
        copy_browser_tree(&source, &destination, &mut count, &mut bytes)
            .expect("a stale Chromium app-shim version link must not prevent transfer");
        assert_eq!(count, 0);
        assert_eq!(bytes, 0);
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
        assert!(fs::symlink_metadata(source.join("RunningChromeVersion")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn browser_copy_skips_root_breadcrumb_links_without_copying_their_targets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        let outside = root.path().join("browser-fixture");
        fs::write(&outside, b"synthetic-browser-executable").unwrap();
        fs::create_dir_all(&source).unwrap();
        for name in [
            "Last Browser",
            "RunningChromeVersion",
            "SingletonLock",
            "SingletonCookie",
            "SingletonSocket",
        ] {
            std::os::unix::fs::symlink(&outside, source.join(name)).unwrap();
        }
        copy_browser_tree(&source, &destination, &mut 0, &mut 0).unwrap();
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
        assert_eq!(fs::read(outside).unwrap(), b"synthetic-browser-executable");
    }

    #[cfg(unix)]
    #[test]
    fn browser_copy_rejects_unknown_and_nested_links() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("fixture"), b"outside-selected-profile").unwrap();
        for (index, relative) in [
            "UnknownLink",
            "Default/Cookies",
            "Default/Local Storage",
            "Default/Last Browser",
            "Default/RunningChromeVersion",
        ]
        .into_iter()
        .enumerate()
        {
            for (kind, target) in [
                ("file", outside.join("fixture")),
                ("directory", outside.clone()),
                ("dangling", outside.join("missing")),
            ] {
                let source = root.path().join(format!("source-{index}-{kind}"));
                let destination = root.path().join(format!("destination-{index}-{kind}"));
                let link = source.join(relative);
                fs::create_dir_all(link.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(target, &link).unwrap();
                let error = copy_browser_tree(&source, &destination, &mut 0, &mut 0).unwrap_err();
                assert!(
                    error.contains("不可迁移的链接或特殊文件"),
                    "{relative}: {error}"
                );
                assert!(fs::symlink_metadata(destination.join(relative)).is_err());
                assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
            }
        }
        assert_eq!(
            fs::read(outside.join("fixture")).unwrap(),
            b"outside-selected-profile"
        );
    }

    #[cfg(unix)]
    #[test]
    fn browser_copy_rejects_unexpected_sockets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(&source).unwrap();
        let _socket = std::os::unix::net::UnixListener::bind(source.join("socket")).unwrap();
        let destination = root.path().join("destination");
        let error = copy_browser_tree(&source, &destination, &mut 0, &mut 0).unwrap_err();
        assert!(error.contains("不可迁移的链接或特殊文件"));
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn encrypted_transfer_omits_runtime_links_and_preserves_persistent_site_files() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        let record = window(&source);
        let user_data = source.profiles.store.user_data_dir(&record.id).unwrap();
        write_site_storage(&user_data);
        std::os::unix::fs::symlink(&record.binary_path, user_data.join("Last Browser")).unwrap();
        std::os::unix::fs::symlink(
            &record.binding.channel_version,
            user_data.join("RunningChromeVersion"),
        )
        .unwrap();
        let archive = root.path().join("runtime-artifacts.nexuswindow");
        source
            .export(
                std::slice::from_ref(&record.id),
                "transfer-password",
                &archive,
            )
            .unwrap();
        let report = target
            .import(&archive, "transfer-password", ImportMode::Preserve)
            .unwrap();
        assert_eq!(report.ids.as_slice(), std::slice::from_ref(&record.id));
        let imported = target.profiles.store.user_data_dir(&record.id).unwrap();
        assert_site_storage(&imported);
        for relative in ["Last Browser", "RunningChromeVersion", "Default/Cache"] {
            assert!(fs::symlink_metadata(imported.join(relative)).is_err());
        }
        let state: Value = json_file(
            &imported.parent().unwrap().join("portable-state.json"),
            MAX_STATE,
        )
        .unwrap();
        assert_eq!(
            state["storageState"]["cookies"][0]["value"],
            "portable-session"
        );
        assert!(fs::symlink_metadata(user_data.join("Last Browser")).is_ok());
        assert!(fs::symlink_metadata(user_data.join("RunningChromeVersion")).is_ok());
        assert_site_storage(&user_data);
    }

    #[test]
    fn encrypted_export_import_copies_browser_data_and_rebinds_only_the_local_binary_path() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("a"));
        let target = service(&root.path().join("b"));
        let record = window(&source);
        let path = root.path().join("window.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        let report = target
            .import(&path, "transfer-password", ImportMode::Copy)
            .unwrap();
        assert_eq!(report.window_count, 1);
        assert_ne!(report.ids[0], record.id);
        let imported = target.profiles.store.get(&report.ids[0]).unwrap();
        assert_eq!(imported.settings, record.settings);
        assert_eq!(
            imported.binding.channel_version,
            record.binding.channel_version
        );
        assert_ne!(imported.binary_path, record.binary_path);
        let folder = target.profiles.store.root().join(&report.ids[0]);
        assert_eq!(
            fs::read(folder.join("user-data/Default/Cookies")).unwrap(),
            b"machine-encrypted-database"
        );
        assert!(!folder.join("user-data/Default/Cache").exists());
        assert!(
            fs::read_to_string(folder.join("portable-state.json"))
                .unwrap()
                .contains("portable-session")
        );
        assert!(source.profiles.store.get(&record.id).is_ok());
    }

    #[test]
    fn encrypted_transfer_keeps_the_exact_kernel_package_revision() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        set_kernel_package(&source, "155.0.8059.39.2");
        set_kernel_package(&target, "155.0.8059.39.2");
        let record = window(&source);
        let path = root.path().join("revision.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        assert_eq!(
            source.inspect(&path, "transfer-password").unwrap()["windows"][0]["version"],
            "155.0.8059.39.2"
        );
        let imported = target
            .import(&path, "transfer-password", ImportMode::Copy)
            .unwrap();
        let imported = target.profiles.store.get(&imported.ids[0]).unwrap();
        assert_eq!(imported.binding.channel_version, "155.0.8059.39");
        assert_eq!(
            imported.binary_path,
            target.root.parent().unwrap().join("browser")
        );
    }

    #[test]
    fn outdated_manifests_are_rejected_before_any_runtime_or_profile_write() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let contents = root.path().join("contents");
        fs::create_dir(&contents).unwrap();
        write_json(
            &contents.join("manifest.json"),
            &json!({"schemaVersion": 1, "windows": []}),
        )
        .unwrap();
        let marker = root.path().join("runtime-started");
        fs::write(
            &service.profiles.runtime.browser_script,
            format!(
                "require('node:fs').writeFileSync({}, 'unexpected invocation');",
                serde_json::to_string(&marker).unwrap(),
            ),
        )
        .unwrap();
        let error = service.manifest(&contents).err().unwrap();
        assert!(error.contains("重新导出"));
        assert!(!marker.exists());
        assert!(service.profiles.store.list().unwrap().is_empty());
    }

    #[test]
    fn import_requires_activation_even_when_the_exact_kernel_is_cached() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        let record = window(&source);
        let archive = root.path().join("window.nexuswindow");
        source
            .export(
                std::slice::from_ref(&record.id),
                "transfer-password",
                &archive,
            )
            .unwrap();
        target.profiles.license_store.remove().unwrap();
        let error = target
            .import(&archive, "transfer-password", ImportMode::Copy)
            .unwrap_err();
        assert!(error.contains("激活码"));
        assert!(target.profiles.store.list().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(target.root.join("pending")).unwrap().count(),
            0
        );
    }

    #[test]
    fn import_rejects_a_newer_package_with_the_same_reported_chrome_version() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        set_kernel_package(&source, "155.0.8059.39.2");
        set_kernel_package(&target, "155.0.8059.39.3");
        write_json(
            &target.root.parent().unwrap().join("prepared-kernel.json"),
            &kernel_package(&target, "155.0.8059.39.3"),
        )
        .unwrap();
        let record = window(&source);
        let path = root.path().join("revision.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        let error = target
            .import(&path, "transfer-password", ImportMode::Copy)
            .expect_err(
                "a matching Chrome display version must not substitute another SDK revision",
            );
        assert!(error.contains("精确内核"));
        assert!(target.profiles.store.list().unwrap().is_empty());
    }

    #[test]
    fn import_accepts_a_prepared_package_whose_revision_is_not_printed_by_chrome() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        set_kernel_package(&source, "155.0.8059.39.2");
        write_json(
            &target.root.parent().unwrap().join("inventory.json"),
            &json!([]),
        )
        .unwrap();
        write_json(
            &target.root.parent().unwrap().join("prepared-kernel.json"),
            &kernel_package(&target, "155.0.8059.39.2"),
        )
        .unwrap();
        let record = window(&source);
        let path = root.path().join("revision.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        let report = target
            .import(&path, "transfer-password", ImportMode::Copy)
            .unwrap();
        assert_eq!(
            target
                .profiles
                .store
                .get(&report.ids[0])
                .unwrap()
                .binding
                .channel_version,
            "155.0.8059.39"
        );
    }

    #[test]
    fn import_rejects_a_binding_that_disagrees_with_the_actual_binary_display_version() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        set_kernel_package(&source, "155.0.8059.39.2");
        let record = window(&source);
        let original = root.path().join("original.nexuswindow");
        source
            .export(
                std::slice::from_ref(&record.id),
                "transfer-password",
                &original,
            )
            .unwrap();
        let extracted = root.path().join("edited");
        transfer_archive::unpack(&original, &extracted, "transfer-password").unwrap();
        let manifest_path = extracted.join("manifest.json");
        let mut manifest: Value = json_file(&manifest_path, MAX_MANIFEST).unwrap();
        let binding = &mut manifest["windows"][0]["record"]["binding"];
        binding["channel_version"] = json!("155.0.8059.39.2");
        binding["channel_id"] = json!("cloak:155.0.8059.39.2");
        write_json(&manifest_path, &manifest).unwrap();
        let malformed = root.path().join("wrong-display.nexuswindow");
        transfer_archive::pack(&extracted, &malformed, "transfer-password").unwrap();
        for cached in [true, false] {
            let target = service(&root.path().join(if cached { "cached" } else { "prepared" }));
            if cached {
                set_kernel_package(&target, "155.0.8059.39.2");
            } else {
                write_json(
                    &target.root.parent().unwrap().join("inventory.json"),
                    &json!([]),
                )
                .unwrap();
                write_json(
                    &target.root.parent().unwrap().join("prepared-kernel.json"),
                    &kernel_package(&target, "155.0.8059.39.2"),
                )
                .unwrap();
            }
            let error = target
                .import(&malformed, "transfer-password", ImportMode::Copy)
                .expect_err("the imported binding must match the binary's actual --version");
            assert!(error.contains("版本"));
            assert!(target.profiles.store.list().unwrap().is_empty());
            assert_eq!(
                fs::read_dir(target.root.join("pending")).unwrap().count(),
                0
            );
        }
    }

    #[test]
    fn replace_cannot_change_package_revision_with_the_same_chrome_version() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let target = service(&root.path().join("target"));
        let record = window(&source);
        let path = root.path().join("revision.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        target
            .import(&path, "transfer-password", ImportMode::Replace)
            .unwrap();
        set_kernel_package(&target, "155.0.8059.39.2");
        write_json(
            &target.root.parent().unwrap().join("prepared-kernel.json"),
            &kernel_package(&target, "155.0.8059.39.2"),
        )
        .unwrap();
        let data = target.profiles.store.user_data_dir(&record.id).unwrap();
        fs::write(data.join("Default/Cookies"), b"keep-local-session").unwrap();
        for version in ["155.0.8059.39.3", "155.0.8059.39.4"] {
            set_kernel_package(&source, version);
            let changed = root.path().join(format!("{version}.nexuswindow"));
            source
                .export(
                    std::slice::from_ref(&record.id),
                    "transfer-password",
                    &changed,
                )
                .unwrap();
            let error = target
                .import(&changed, "transfer-password", ImportMode::Replace)
                .expect_err("an existing window's exact kernel package is immutable");
            assert!(error.contains("不可更改"));
            assert_eq!(
                fs::read(data.join("Default/Cookies")).unwrap(),
                b"keep-local-session"
            );
        }
    }

    #[test]
    fn export_rejects_a_binary_without_an_identifiable_kernel_package() {
        let root = tempfile::tempdir().unwrap();
        let source = service(root.path());
        let record = window(&source);
        write_json(&root.path().join("inventory.json"), &json!([])).unwrap();
        let path = root.path().join("unknown.nexuswindow");
        assert!(
            source
                .export(std::slice::from_ref(&record.id), "transfer-password", &path)
                .is_err()
        );
        assert!(!path.exists());
    }

    #[test]
    fn failed_overwrite_restores_original_data_and_sqlite_record() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("a"));
        let target = service(&root.path().join("b"));
        let record = window(&source);
        let path = root.path().join("window.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        target
            .import(&path, "transfer-password", ImportMode::Replace)
            .unwrap();
        let data = target.profiles.store.user_data_dir(&record.id).unwrap();
        fs::write(data.join("Default/Cookies"), b"local-newer-session").unwrap();
        let db = open_database(&target.profiles.store.database_path()).unwrap();
        db.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON profile_records BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
        assert!(
            target
                .import(&path, "transfer-password", ImportMode::Replace)
                .is_err()
        );
        assert_eq!(
            fs::read(data.join("Default/Cookies")).unwrap(),
            b"local-newer-session"
        );
        assert_eq!(
            target
                .profiles
                .store
                .get(&record.id)
                .unwrap()
                .settings
                .fingerprint_seed,
            Some(12345)
        );
        assert_eq!(
            fs::read_dir(target.root.join("pending")).unwrap().count(),
            0
        );
    }

    #[test]
    fn transfer_guard_excludes_launch_edit_delete_and_releases_after_completion() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let record = window(&service);
        let guard = service
            .profiles
            .lock_transfer(std::slice::from_ref(&record.id))
            .unwrap();
        assert!(
            service
                .profiles
                .launch(&record.id)
                .unwrap_err()
                .contains("迁移")
        );
        assert!(
            service
                .profiles
                .delete(&record.id)
                .unwrap_err()
                .contains("迁移")
        );
        assert!(
            service
                .profiles
                .update(
                    &record.id,
                    record.name.clone(),
                    ProxySource::direct(),
                    record.settings.clone(),
                    None
                )
                .unwrap_err()
                .contains("迁移")
        );
        drop(guard);
        service
            .profiles
            .update(
                &record.id,
                "Renamed".into(),
                ProxySource::direct(),
                record.settings.clone(),
                None,
            )
            .unwrap();
    }

    #[test]
    fn recover_interrupted_import_removes_uncommitted_new_window() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let record = window(&service);
        let operation = service
            .root
            .join("pending")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(operation.join("backup")).unwrap();
        let journal = ImportJournal {
            committed: false,
            native_rolled_back: false,
            originals: vec![Original {
                id: record.id.clone(),
                record: None,
                group_id: None,
            }],
            groups: Vec::new(),
            receipts: Vec::new(),
        };
        write_json(&operation.join("journal.json"), &journal).unwrap();
        recover_pending(root.path()).unwrap();
        assert!(service.profiles.store.list().unwrap().is_empty());
        assert!(!service.profiles.store.root().join(&record.id).exists());
        assert!(!operation.exists());
    }

    #[test]
    fn missing_plugin_receipts_do_not_prevent_native_recovery_or_app_startup() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let record = window(&service);
        for (committed, originals) in [
            (true, Vec::new()),
            (
                false,
                vec![Original {
                    id: record.id.clone(),
                    record: None,
                    group_id: None,
                }],
            ),
        ] {
            let operation = service
                .root
                .join("pending")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&operation).unwrap();
            write_json(
                &operation.join("journal.json"),
                &ImportJournal {
                    committed,
                    native_rolled_back: false,
                    originals,
                    groups: Vec::new(),
                    receipts: vec![Receipt {
                        id: "studio.missing".into(),
                        capability: Capability::AccountPool,
                        receipt: Uuid::new_v4().to_string(),
                    }],
                },
            )
            .unwrap();
        }
        assert!(recover_pending(root.path()).is_ok());
        assert!(service.profiles.store.list().unwrap().is_empty());
        assert!(!service.profiles.store.root().join(record.id).exists());
        assert_eq!(
            fs::read_dir(service.root.join("pending")).unwrap().count(),
            2
        );
        let recovery = service.recovery_status().unwrap();
        assert_eq!(recovery["pending"], 2);
        assert_eq!(recovery["warnings"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn malformed_portable_state_never_replaces_an_existing_browser_environment() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let mut target = service(&root.path().join("target"));
        let record = window(&source);
        let original = root.path().join("original.nexuswindow");
        source
            .export(
                std::slice::from_ref(&record.id),
                "transfer-password",
                &original,
            )
            .unwrap();
        target
            .import(&original, "transfer-password", ImportMode::Replace)
            .unwrap();
        let data = target.profiles.store.user_data_dir(&record.id).unwrap();
        fs::write(data.join("Default/Cookies"), b"newer-local-cookie").unwrap();
        let extracted = root.path().join("edited");
        transfer_archive::unpack(&original, &extracted, "transfer-password").unwrap();
        write_json(
            &extracted
                .join("profiles")
                .join(&record.id)
                .join("portable-state.json"),
            &json!({"schemaVersion":1,"storageState":{}}),
        )
        .unwrap();
        let malformed = root.path().join("malformed.nexuswindow");
        transfer_archive::pack(&extracted, &malformed, "transfer-password").unwrap();
        Arc::get_mut(&mut target.profiles)
            .unwrap()
            .runtime
            .browser_script = RuntimePaths::development().browser_script;
        assert!(
            target
                .import(&malformed, "transfer-password", ImportMode::Replace)
                .is_err()
        );
        assert_eq!(
            fs::read(data.join("Default/Cookies")).unwrap(),
            b"newer-local-cookie"
        );
        assert_eq!(
            fs::read_dir(target.root.join("pending")).unwrap().count(),
            0
        );
    }

    #[test]
    fn complete_portable_state_is_accepted_by_the_real_runtime_validator() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("source"));
        let mut target = service(&root.path().join("target"));
        let record = window(&source);
        let path = root.path().join("valid.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        Arc::get_mut(&mut target.profiles)
            .unwrap()
            .runtime
            .browser_script = RuntimePaths::development().browser_script;
        let report = target
            .import(&path, "transfer-password", ImportMode::Copy)
            .unwrap();
        assert_eq!(report.window_count, 1);
        assert_ne!(report.ids[0], record.id);
    }

    #[test]
    fn portable_window_ids_cannot_alias_paths_on_case_insensitive_filesystems() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let mut record = window(&service);
        let id = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
        record.id = id.into();
        record.binding.profile_id = id.into();
        let contents = root.path().join("contents");
        write_json(
            &contents
                .join("profiles")
                .join(id)
                .join("portable-state.json"),
            &json!({"schemaVersion":1,"storageState":{"cookies":[],"origins":[]}}),
        )
        .unwrap();
        write_json(
            &contents.join("manifest.json"),
            &Manifest {
                schema_version: MANIFEST_VERSION,
                source_platform: std::env::consts::OS.into(),
                source_arch: std::env::consts::ARCH.into(),
                created_at: now(),
                windows: vec![PortableWindow {
                    record,
                    group: None,
                    kernel_version: "155.0.8059.39".into(),
                }],
                plugins: Vec::new(),
                warnings: Vec::new(),
            },
        )
        .unwrap();
        assert!(
            service.manifest(&contents).is_err(),
            "noncanonical IDs can refer to the same directory but different SQLite rows"
        );
    }

    #[test]
    #[cfg(unix)]
    fn failed_recovery_checkpoint_keeps_the_affected_window_blocked() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let record = window(&service);
        let guard = service
            .profiles
            .lock_transfer(std::slice::from_ref(&record.id))
            .unwrap();
        let operation = service
            .root
            .join("pending")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&operation).unwrap();
        let mut journal = ImportJournal {
            committed: false,
            native_rolled_back: false,
            originals: vec![Original {
                id: record.id.clone(),
                record: Some(serde_json::to_string(&record).unwrap()),
                group_id: None,
            }],
            groups: Vec::new(),
            receipts: Vec::new(),
        };
        write_json(&operation.join("journal.json"), &journal).unwrap();
        fs::set_permissions(&operation, fs::Permissions::from_mode(0o500)).unwrap();
        let rollback = service.rollback(&operation, &mut journal);
        fs::set_permissions(&operation, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(rollback.is_err());
        drop(guard);
        assert!(
            service
                .profiles
                .lock_transfer(std::slice::from_ref(&record.id))
                .is_err(),
            "an undurable native rollback must prevent a new migration for the same ID"
        );
        assert!(
            service
                .profiles
                .update(
                    &record.id,
                    "Later edit".into(),
                    ProxySource::direct(),
                    record.settings.clone(),
                    None
                )
                .is_err(),
            "later edits would otherwise be overwritten by replaying the old journal"
        );
        assert!(service.profiles.delete(&record.id).is_err());
        assert!(service.profiles.launch(&record.id).is_err());
        assert_eq!(service.recovery_status().unwrap()["pending"], 1);
        recover_pending(root.path()).unwrap();
        let restarted = ProfileService::with_runtime(
            service.profiles.store.root().to_owned(),
            None,
            service.profiles.license_store.clone(),
            service.profiles.runtime.clone(),
        )
        .unwrap();
        restarted
            .update(
                &record.id,
                "After durable recovery".into(),
                ProxySource::direct(),
                record.settings,
                None,
            )
            .unwrap();
        assert_eq!(
            restarted.store.get(&record.id).unwrap().name,
            "After durable recovery"
        );
    }

    #[test]
    fn rollback_preserves_groups_adopted_or_edited_after_the_import_started() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let record = window(&service);
        let groups = GroupStore::new(service.profiles.store.database_path()).unwrap();
        let adopted = groups.create("Imported group", "").unwrap();
        let edited = groups.create("Initial name", "").unwrap();
        let unused = groups.create("Unused", "").unwrap();
        service
            .profiles
            .store
            .update_with_group(
                &record.id,
                &record.name,
                ProxySource::direct(),
                record.settings,
                Some(&adopted.id),
            )
            .unwrap();
        groups.update(&edited.id, "User edited", "keep").unwrap();
        rollback_native(
            &service.profiles.store.database_path(),
            service.profiles.store.root(),
            &service.root.join("unused-operation"),
            &ImportJournal {
                committed: false,
                native_rolled_back: false,
                originals: Vec::new(),
                groups: [adopted, edited, unused.clone()]
                    .into_iter()
                    .map(|group| PortableGroup {
                        id: group.id,
                        name: group.name,
                        note: group.note,
                    })
                    .collect(),
                receipts: Vec::new(),
            },
        )
        .unwrap();
        assert!(
            service
                .profiles
                .store
                .group_id(&record.id)
                .unwrap()
                .is_some()
        );
        let remaining = groups.list().unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|group| group.name == "User edited"));
        assert!(!remaining.iter().any(|group| group.id == unused.id));
    }

    #[test]
    fn retrying_plugin_compensation_never_replays_already_restored_window_records() {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path());
        let record = window(&service);
        let operation = service
            .root
            .join("pending")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(operation.join("backup")).unwrap();
        let mut journal = ImportJournal {
            committed: false,
            native_rolled_back: false,
            originals: vec![Original {
                id: record.id.clone(),
                record: Some(serde_json::to_string(&record).unwrap()),
                group_id: None,
            }],
            groups: Vec::new(),
            receipts: vec![Receipt {
                id: "studio.missing".into(),
                capability: Capability::AccountPool,
                receipt: Uuid::new_v4().to_string(),
            }],
        };
        write_json(&operation.join("journal.json"), &journal).unwrap();
        assert!(
            rollback_import(
                &service.profiles.store.database_path(),
                service.profiles.store.root(),
                &operation,
                &mut journal,
                &service.host
            )
            .is_err()
        );
        service
            .profiles
            .store
            .update(
                &record.id,
                "Edited after recovery",
                ProxySource::direct(),
                record.settings,
            )
            .unwrap();
        let mut persisted: ImportJournal =
            json_file(&operation.join("journal.json"), MAX_MANIFEST).unwrap();
        assert!(persisted.native_rolled_back);
        assert!(
            rollback_import(
                &service.profiles.store.database_path(),
                service.profiles.store.root(),
                &operation,
                &mut persisted,
                &service.host
            )
            .is_err()
        );
        assert_eq!(
            service.profiles.store.get(&record.id).unwrap().name,
            "Edited after recovery"
        );
    }

    #[test]
    fn encrypted_bundle_remaps_plugin_proxy_credentials_and_account_binding() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("a"));
        let target = service(&root.path().join("b"));
        let plugins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
        for service in [&source, &target] {
            service.host.install(&plugins.join("proxy-pool")).unwrap();
            service
                .host
                .install(&plugins.join("vinted-accounts"))
                .unwrap();
        }
        let proxy = |service: &TransferService| {
            call(&service.host, "studio.proxy-pool", Capability::ProxyProvider, "proxy.create",
                json!({"name":"Portable proxy","host":"proxy.example","port":1080,"schemes":["socks5"],
                    "username":"shop-user","password":"private-proxy-password","enabled":true,"udp":false})).unwrap()
        };
        let source_proxy = proxy(&source);
        proxy(&target);
        let source_id = source_proxy["id"].as_str().unwrap().parse::<i64>().unwrap();
        call(
            &source.host,
            "studio.proxy-pool",
            Capability::ProxyProvider,
            "proxy.config.set",
            json!({"defaultEndpointId":source_id}),
        )
        .unwrap();
        let record = window(&source);
        source
            .profiles
            .store
            .update(
                &record.id,
                &record.name,
                ProxySource::plugin("studio.proxy-pool".into(), Some(source_id)),
                record.settings.clone(),
            )
            .unwrap();
        let saved = call(&source.host, "studio.vinted-accounts", Capability::AccountPool, "vinted.accounts.save",
            json!({"loginMethod":"email","account":"shop@example.test","password":"private-account-password",
                "phone":"","emailOtpUrl":"","smsOtpUrl":"","note":"Shop","status":"active","homepageUrl":""})).unwrap();
        call(
            &source.host,
            "studio.vinted-accounts",
            Capability::AccountPool,
            "vinted.accounts.bind",
            json!({"accountId":saved["item"]["id"],"windowId":record.id}),
        )
        .unwrap();
        let path = root.path().join("portable.nexuswindow");
        source
            .export(std::slice::from_ref(&record.id), "transfer-password", &path)
            .unwrap();
        let imported = target
            .import(&path, "transfer-password", ImportMode::Copy)
            .unwrap();
        let target_record = target.profiles.store.get(&imported.ids[0]).unwrap();
        assert_ne!(target_record.proxy_endpoint, Some(source_id));
        let resolved = target
            .host
            .resolve_browser_proxy(
                "studio.proxy-pool",
                &target_record.id,
                target_record.proxy_endpoint,
            )
            .unwrap();
        assert_eq!(
            resolved.connection_url,
            "socks5://shop-user:private-proxy-password@proxy.example:1080"
        );
        let accounts = call(
            &target.host,
            "studio.vinted-accounts",
            Capability::AccountPool,
            "vinted.accounts.list",
            json!({}),
        )
        .unwrap();
        assert_eq!(accounts["bindings"][0]["windowId"], imported.ids[0]);
        let transfer = call(
            &target.host,
            "studio.vinted-accounts",
            Capability::AccountPool,
            "transfer.export",
            json!({"windowIds":imported.ids,"endpointIds":[]}),
        )
        .unwrap();
        assert!(
            serde_json::to_string(&transfer)
                .unwrap()
                .contains("private-account-password")
        );
        source.host.shutdown();
        target.host.shutdown();
    }

    #[test]
    fn two_native_hosts_sync_an_encrypted_window_and_keep_independent_copies() {
        let root = tempfile::tempdir().unwrap();
        let source = service(&root.path().join("a"));
        let target = service(&root.path().join("b"));
        let plugin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/window-sync");
        source.host.install(&plugin).unwrap();
        target.host.install(&plugin).unwrap();
        let record = window(&source);
        let offer = source.offer(std::slice::from_ref(&record.id)).unwrap();
        let receive = target
            .receive(offer["invitation"].as_str().unwrap(), Some("127.0.0.1"))
            .unwrap();
        let id = receive["jobId"].as_str().unwrap();
        let started = Instant::now();
        loop {
            let status = target.sync_status(id).unwrap();
            match status["state"].as_str().unwrap() {
                "completed" => break,
                "failed" | "cancelled" => panic!("sync failed: {:?}", status["state"]),
                _ => assert!(started.elapsed() < Duration::from_secs(15)),
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let imported = target.sync_import(id, ImportMode::Copy).unwrap();
        assert_eq!(imported.window_count, 1);
        assert_eq!(record.id, imported.ids[0]);
        assert!(source.profiles.store.get(&record.id).is_ok());
        let copied = target.profiles.store.get(&imported.ids[0]).unwrap();
        assert_eq!(copied.settings, record.settings);
        assert!(
            target
                .profiles
                .store
                .root()
                .join(&copied.id)
                .join("portable-state.json")
                .is_file()
        );
        let target_data = target.profiles.store.user_data_dir(&copied.id).unwrap();
        fs::write(target_data.join("Default/Cookies"), b"changed-on-b").unwrap();
        assert_ne!(
            fs::read(target_data.join("Default/Cookies")).unwrap(),
            fs::read(
                source
                    .profiles
                    .store
                    .user_data_dir(&record.id)
                    .unwrap()
                    .join("Default/Cookies")
            )
            .unwrap()
        );
        source
            .sync_status(offer["offerId"].as_str().unwrap())
            .unwrap();
        let reverse = target.offer(std::slice::from_ref(&copied.id)).unwrap();
        let returning = source
            .receive(reverse["invitation"].as_str().unwrap(), Some("127.0.0.1"))
            .unwrap();
        let returning_id = returning["jobId"].as_str().unwrap();
        let started = Instant::now();
        loop {
            let status = source.sync_status(returning_id).unwrap();
            match status["state"].as_str().unwrap() {
                "completed" => break,
                "failed" | "cancelled" => panic!("reverse sync failed: {:?}", status["state"]),
                _ => assert!(started.elapsed() < Duration::from_secs(15)),
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            source
                .sync_import(returning_id, ImportMode::Copy)
                .unwrap_err()
                .contains("已有同标识")
        );
        source
            .sync_import(returning_id, ImportMode::Replace)
            .unwrap();
        assert_eq!(
            fs::read(
                source
                    .profiles
                    .store
                    .user_data_dir(&record.id)
                    .unwrap()
                    .join("Default/Cookies")
            )
            .unwrap(),
            b"changed-on-b"
        );
        target
            .sync_status(reverse["offerId"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            fs::read_dir(source.root.join("exchange")).unwrap().count(),
            0
        );
        assert_eq!(
            fs::read_dir(target.root.join("exchange")).unwrap().count(),
            0
        );
        source.host.shutdown();
        target.host.shutdown();
    }
}
