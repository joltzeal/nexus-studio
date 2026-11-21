use crate::core::browser::provider::{BrowserError, BrowserProviderId, BrowserResult};
use crate::core::network_proxy::NetworkProxyStore;
use crate::core::window_service::WindowService;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use shardx::{ShardX, ShardXOptions};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardKernel {
    pub version: String,
    pub binary_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardStatus {
    pub platform: &'static str,
    pub installed: Vec<ShardKernel>,
    pub downloading: bool,
    pub download: ShardDownload,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardDownload {
    pub phase: &'static str,
    pub label: Option<String>,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub error: Option<String>,
}

impl ShardDownload {
    fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            label: None,
            received_bytes: 0,
            total_bytes: None,
            percent: None,
            error: None,
        }
    }

    fn active(&self) -> bool {
        matches!(
            self.phase,
            "preparing" | "downloading" | "extracting" | "verifying"
        )
    }
}

#[derive(Deserialize)]
struct Manifest {
    installed_chromium_version: Option<String>,
}

pub struct ShardKernelService {
    root: PathBuf,
    network: Option<NetworkProxyStore>,
    download: Arc<Mutex<ShardDownload>>,
}

impl ShardKernelService {
    fn digest(path: &std::path::Path) -> Result<String, String> {
        let mut file = fs::File::open(path).map_err(|_| "无法读取内核文件")?;
        let mut sha = Sha256::new();
        let mut chunk = [0_u8; 128 * 1024];
        loop {
            let count = file.read(&mut chunk).map_err(|_| "无法校验内核文件")?;
            if count == 0 {
                break;
            }
            sha.update(&chunk[..count]);
        }
        Ok(format!("{:x}", sha.finalize()))
    }
    pub fn new(root: PathBuf, network: Option<NetworkProxyStore>) -> Self {
        Self {
            root,
            network,
            download: Arc::new(Mutex::new(ShardDownload::phase("idle"))),
        }
    }

    pub fn valid_version(version: &str) -> bool {
        version.len() <= 48
            && version.split('.').count() == 4
            && version.split('.').all(|part| {
                !part.is_empty()
                    && part.bytes().all(|byte| byte.is_ascii_digit())
                    && part.parse::<u32>().is_ok()
            })
    }

    fn sdk(&self, root: PathBuf) -> Result<ShardX, String> {
        let download = Arc::clone(&self.download);
        ShardX::new(ShardXOptions {
            cache_dir: Some(root),
            progress: Some(Arc::new(move |label, received, total| {
                if let Ok(mut job) = download.lock() {
                    let (phase, label) = if let Some(label) = label.strip_prefix("extracting:") {
                        ("extracting", label)
                    } else if let Some(label) = label.strip_prefix("verifying:") {
                        ("verifying", label)
                    } else {
                        ("downloading", label)
                    };
                    *job = ShardDownload {
                        phase,
                        label: Some(label.to_string()),
                        received_bytes: received,
                        total_bytes: (total > 0).then_some(total),
                        percent: (total > 0)
                            .then(|| (received as f64 / total as f64 * 100.0).clamp(0.0, 100.0)),
                        error: None,
                    };
                }
            })),
            ..Default::default()
        })
        .map_err(|_| "当前系统无法运行 ShardBrowser 内核".into())
    }

    pub fn pinned(&self, version: &str) -> Result<ShardX, String> {
        self.pinned_with_profiles(version, None)
    }

    pub fn pinned_with_profiles(
        &self,
        version: &str,
        profiles: Option<PathBuf>,
    ) -> Result<ShardX, String> {
        if !Self::valid_version(version) {
            return Err("内核版本无效".into());
        }
        let root = self.root.join(version);
        let meta = fs::symlink_metadata(&root).map_err(|_| "固定内核目录不存在")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("固定内核目录无效".into());
        }
        let sdk = ShardX::new(ShardXOptions {
            cache_dir: Some(root),
            profiles_dir: profiles,
            ..Default::default()
        })
        .map_err(|_| "当前系统无法运行 ShardBrowser 内核".to_string())?;
        sdk.runtime
            .use_installed(version)
            .map_err(|_| "固定内核缺失或已变化，请重新下载".to_string())?;
        let binary = sdk.runtime.binary_path();
        let binary_meta = fs::symlink_metadata(&binary).map_err(|_| "固定内核文件缺失")?;
        if !binary_meta.is_file() || binary_meta.len() == 0 {
            return Err("固定内核文件无效".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if binary_meta.permissions().mode() & 0o111 == 0 {
                return Err("固定内核不可执行".into());
            }
        }
        let hash_path = sdk.runtime.root.join("raccoon.sha256");
        let hash_meta = fs::symlink_metadata(&hash_path).map_err(|_| "固定内核缺少完整性记录")?;
        if !hash_meta.is_file() || hash_meta.len() != 64 {
            return Err("固定内核完整性记录无效".into());
        }
        let expected =
            fs::read_to_string(hash_path).map_err(|_| "固定内核缺少完整性记录".to_string())?;
        if expected.len() != 64
            || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
            || Self::digest(&sdk.runtime.binary_path())? != expected
        {
            return Err("固定内核文件已变化，请重新下载".into());
        }
        Ok(sdk)
    }

    pub fn installed(&self) -> Result<Vec<ShardKernel>, String> {
        let mut installed = Vec::new();
        if !self.root.exists() {
            return Ok(installed);
        }
        for entry in fs::read_dir(&self.root).map_err(|_| "无法读取本机内核")? {
            let entry = entry.map_err(|_| "无法读取本机内核")?;
            let version = entry.file_name().to_string_lossy().into_owned();
            if !Self::valid_version(&version)
                || !entry.file_type().map_err(|_| "无法读取本机内核")?.is_dir()
            {
                continue;
            }
            if let Ok(sdk) = self.pinned(&version) {
                installed.push(ShardKernel {
                    version,
                    binary_path: sdk.runtime.binary_path(),
                });
            }
        }
        installed.sort_by(|a, b| {
            let numeric = |version: &str| {
                version
                    .split('.')
                    .map(|part| part.parse::<u64>().unwrap_or(0))
                    .collect::<Vec<_>>()
            };
            numeric(&b.version).cmp(&numeric(&a.version))
        });
        Ok(installed)
    }

    pub fn status(&self) -> Result<ShardStatus, String> {
        let platform = if shardx::host_spec().is_ok() {
            "supported"
        } else {
            "unsupported"
        };
        // Inventory verification can take time. Read the job afterwards so a
        // completed inventory read cannot replace newer progress with a snapshot.
        let installed = self.installed()?;
        let download = self.download.lock().map_err(|_| "内核状态不可用")?.clone();
        Ok(ShardStatus {
            platform,
            installed,
            downloading: download.active(),
            download,
        })
    }

    pub fn download(&self) -> Result<String, String> {
        {
            let mut job = self.download.lock().map_err(|_| "下载状态不可用")?;
            if job.active() {
                return Err("内核下载正在进行".into());
            }
            *job = ShardDownload::phase("preparing");
        }
        let result = self.download_inner();
        let mut job = self.download.lock().map_err(|_| "下载状态不可用")?;
        *job = ShardDownload::phase(if result.is_ok() { "ready" } else { "failed" });
        job.error = result.as_ref().err().cloned();
        result
    }

    fn download_inner(&self) -> Result<String, String> {
        fs::create_dir_all(&self.root).map_err(|_| "无法创建内核目录")?;
        let staging = self.root.join(format!(".install-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let sdk = self.sdk(staging.clone())?;
            if let Some(network) = &self.network {
                let proxy = network.get()?.resolve()?;
                sdk.runtime
                    .set_download_proxy(proxy.as_deref())
                    .map_err(|_| "下载代理配置无效")?;
            }
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "无法启动内核下载任务")?;
            runtime
                .block_on(sdk.runtime.install(false))
                .map_err(|_| "内核下载失败，请检查网络与磁盘空间".to_string())?;
            *self.download.lock().map_err(|_| "下载状态不可用")? =
                ShardDownload::phase("verifying");
            let manifest: Manifest = serde_json::from_slice(
                &fs::read(sdk.runtime.manifest_path()).map_err(|_| "内核清单缺失")?,
            )
            .map_err(|_| "内核清单损坏")?;
            let version = manifest.installed_chromium_version.ok_or("内核版本缺失")?;
            if !Self::valid_version(&version) || !sdk.runtime.installed() {
                return Err("下载的内核版本无效".into());
            }
            sdk.runtime
                .use_installed(&version)
                .map_err(|_| "下载的内核不完整")?;
            let dest = self.root.join(&version);
            if dest.exists() {
                self.pinned(&version)?;
                return Ok(version);
            }
            let digest = Self::digest(&sdk.runtime.binary_path())?;
            let mut hash = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(staging.join("raccoon.sha256"))
                .map_err(|_| "无法写入内核完整性记录")?;
            hash.write_all(digest.as_bytes())
                .map_err(|_| "无法写入内核完整性记录")?;
            hash.sync_all().map_err(|_| "无法写入内核完整性记录")?;
            fs::rename(&staging, dest).map_err(|_| "无法保存已下载内核")?;
            #[cfg(unix)]
            fs::File::open(&self.root)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| "无法保存内核目录")?;
            Ok(version)
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(staging);
        }
        result
    }

    pub fn remove(&self, version: &str) -> Result<(), String> {
        if !Self::valid_version(version) {
            return Err("内核版本无效".into());
        }
        let download = self.download.lock().map_err(|_| "内核状态不可用")?;
        if download.active() {
            return Err("内核正在下载".into());
        }
        let root = self.root.join(version);
        let meta = fs::symlink_metadata(&root).map_err(|_| "内核不存在")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("内核目录无效".into());
        }
        fs::remove_dir_all(root).map_err(|_| "无法删除内核".into())
    }
}

#[tauri::command]
pub async fn shardbrowser_kernel_status(
    service: State<'_, Arc<ShardKernelService>>,
) -> Result<ShardStatus, String> {
    let service = Arc::clone(&service);
    tauri::async_runtime::spawn_blocking(move || service.status())
        .await
        .map_err(|_| "内核任务中断".to_string())?
}

#[tauri::command]
pub async fn shardbrowser_kernel_download(
    service: State<'_, Arc<ShardKernelService>>,
) -> Result<String, String> {
    let service = Arc::clone(&service);
    tauri::async_runtime::spawn_blocking(move || service.download())
        .await
        .map_err(|_| "内核任务中断".to_string())?
}

#[tauri::command]
pub async fn shardbrowser_kernel_delete(
    state: State<'_, Arc<WindowService>>,
    version: String,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.remove_managed_kernel(
            BrowserProviderId::ShardBrowser,
            &version,
            crate::core::aliasmode_kernels::AliasEngine::Chromium,
        )
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "内核删除任务中断"))?
}

#[cfg(test)]
mod tests {
    use super::ShardKernelService;

    #[test]
    fn versions_require_four_bounded_numeric_components() {
        assert!(ShardKernelService::valid_version("157.0.8103.39"));
        for version in [
            "",
            "157.0.8103",
            "157.0.8103.39.1",
            "../157.0.8103.39",
            "157.0.8103.4294967296",
        ] {
            assert!(!ShardKernelService::valid_version(version), "{version}");
        }
    }
}
