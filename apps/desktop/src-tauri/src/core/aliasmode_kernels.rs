use crate::core::network_proxy::NetworkProxyStore;
use crate::core::window_store::PreparedBinary;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(windows)]
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

const RELEASES: &str =
    "https://api.github.com/repos/aliasmode/aliasmode-chromium/releases?per_page=30";
const RELEASE_TAG: &str =
    "https://api.github.com/repos/aliasmode/aliasmode-chromium/releases/tags/";
const FIREFOX_RELEASES: &str =
    "https://api.github.com/repos/aliasmode/aliasmode-firefox/releases?per_page=30";
const FIREFOX_RELEASE_TAG: &str =
    "https://api.github.com/repos/aliasmode/aliasmode-firefox/releases/tags/";
const MAX_ARCHIVE: u64 = 350 * 1024 * 1024;
const MAX_UNPACKED: u64 = 1400 * 1024 * 1024;
const MANIFEST: &str = "raccoon-kernel.json";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AliasEngine {
    Chromium,
    Firefox,
}

impl AliasEngine {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "chromium" => Ok(Self::Chromium),
            "firefox" => Ok(Self::Firefox),
            _ => Err("浏览器类型无效".into()),
        }
    }
    fn repository(self) -> &'static str {
        match self {
            Self::Chromium => "aliasmode-chromium",
            Self::Firefox => "aliasmode-firefox",
        }
    }
    fn releases(self) -> &'static str {
        match self {
            Self::Chromium => RELEASES,
            Self::Firefox => FIREFOX_RELEASES,
        }
    }
    fn release_tag(self) -> &'static str {
        match self {
            Self::Chromium => RELEASE_TAG,
            Self::Firefox => FIREFOX_RELEASE_TAG,
        }
    }
    fn executable(self) -> &'static str {
        match self {
            Self::Chromium => EXECUTABLE,
            Self::Firefox => FIREFOX_EXECUTABLE,
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM: &str = "macos-arm64";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const PLATFORM: &str = "windows-x64";
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
const PLATFORM: &str = "unsupported";

#[cfg(target_os = "windows")]
const EXECUTABLE: &str = "chrome.exe";
#[cfg(not(target_os = "windows"))]
const EXECUTABLE: &str = "Chromium.app/Contents/MacOS/Chromium";
#[cfg(target_os = "windows")]
const FIREFOX_EXECUTABLE: &str = "aliasmode.exe";
#[cfg(not(target_os = "windows"))]
const FIREFOX_EXECUTABLE: &str = "AliasMode.app/Contents/MacOS/aliasmode";

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const FIREFOX_PLATFORM: &str = "mac.arm64";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const FIREFOX_PLATFORM: &str = "win.x86_64";
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
const FIREFOX_PLATFORM: &str = "unsupported";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasKernel {
    pub version: String,
    pub binary_path: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRelease {
    pub version: String,
    pub platform: String,
    pub checked_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasStatus {
    pub platform: String,
    pub installed: Vec<AliasKernel>,
    pub download: AliasJob,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasJob {
    pub phase: &'static str,
    pub percent: Option<u8>,
    pub error: Option<String>,
}
impl Default for AliasJob {
    fn default() -> Self {
        Self {
            phase: "idle",
            percent: None,
            error: None,
        }
    }
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KernelManifest {
    version: String,
    platform: String,
    #[serde(default)]
    engine: Option<String>,
    archive_sha256: String,
    executable_sha256: String,
}

pub struct AliasModeKernelService {
    root: PathBuf,
    engine: AliasEngine,
    network: Option<NetworkProxyStore>,
    operation: Mutex<()>,
    job: Mutex<AliasJob>,
}

impl AliasModeKernelService {
    pub fn binding_path(&self, version: &str) -> Result<PathBuf, String> {
        self.asset_for_version(version).ok_or("无效的内核版本")?;
        Ok(self.root.join(version).join(self.engine.executable()))
    }
    pub fn new(root: PathBuf, network: Option<NetworkProxyStore>) -> Self {
        Self::for_engine(root, network, AliasEngine::Chromium)
    }
    pub fn for_engine(
        root: PathBuf,
        network: Option<NetworkProxyStore>,
        engine: AliasEngine,
    ) -> Self {
        Self {
            root,
            engine,
            network,
            operation: Mutex::new(()),
            job: Mutex::new(AliasJob::default()),
        }
    }

    fn client(&self) -> Result<Client, String> {
        let mut builder = Client::builder()
            .user_agent("Raccoon/0.2")
            .timeout(Duration::from_secs(12 * 60));
        if let Some(network) = &self.network {
            // An unavailable selected proxy must not silently become a direct download.
            let setting = network.get()?;
            builder = builder.no_proxy();
            if let Some(proxy) = setting.resolve()? {
                builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "应用代理无效")?);
            }
        }
        builder.build().map_err(|_| "无法初始化内核下载连接".into())
    }

    fn release_response<T: for<'de> Deserialize<'de>>(&self, url: &str) -> Result<T, String> {
        if self.platform() == "unsupported" {
            return Err("AliasMode 暂不支持当前系统架构".into());
        }
        let response = self
            .client()?
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .map_err(|_| "无法连接 AliasMode 官方发行服务")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("官方没有发布该内核版本".into());
        }
        if !response.status().is_success() {
            return Err("AliasMode 官方发行服务暂不可用".into());
        }
        let mut body = Vec::new();
        response
            .take(512 * 1024 + 1)
            .read_to_end(&mut body)
            .map_err(|_| "无法读取发行信息")?;
        if body.len() > 512 * 1024 {
            return Err("发行信息超出大小限制".into());
        }
        serde_json::from_slice(&body).map_err(|_| "无法识别发行信息".into())
    }

    fn releases(&self) -> Result<Vec<GithubRelease>, String> {
        self.release_response(self.engine.releases())
    }

    fn platform(&self) -> &'static str {
        if self.engine == AliasEngine::Firefox {
            FIREFOX_PLATFORM
        } else {
            PLATFORM
        }
    }

    fn asset_for_version(&self, version: &str) -> Option<String> {
        match self.engine {
            AliasEngine::Chromium => Self::asset_name(&format!("v{version}")),
            AliasEngine::Firefox => {
                let body = version.strip_prefix("aliasmode-runtime-")?;
                let (core, revision) = body.rsplit_once("-r")?;
                (core.len() <= 48
                    && !core.is_empty()
                    && core
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
                    && !revision.is_empty()
                    && revision.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| format!("aliasmode-{core}-{}.zip", self.platform()))
            }
        }
    }
    pub fn valid_firefox_version(version: &str) -> bool {
        version
            .strip_prefix("aliasmode-runtime-")
            .and_then(|body| body.rsplit_once("-r"))
            .is_some_and(|(core, revision)| {
                core.len() <= 48
                    && !core.is_empty()
                    && core
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
                    && !revision.is_empty()
                    && revision.bytes().all(|byte| byte.is_ascii_digit())
            })
    }

    fn asset_name(version: &str) -> Option<String> {
        let core = version.strip_prefix('v')?.split("-aliasmode.").next()?;
        (core.split('.').count() == 4
            && core
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            && version
                .split("-aliasmode.")
                .nth(1)
                .is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            && version.len() <= 64)
            .then(|| format!("aliasmode-chromium-{core}-{PLATFORM}.zip"))
    }
    pub fn valid_version(version: &str) -> bool {
        Self::asset_name(&format!("v{version}")).is_some()
    }

    fn asset<'a>(
        &self,
        release: &'a GithubRelease,
    ) -> Option<(&'a ReleaseAsset, &'a ReleaseAsset)> {
        if release.draft {
            return None;
        }
        let name = self.asset_for_version(&self.version_from_tag(&release.tag_name))?;
        let prefix = format!(
            "https://github.com/aliasmode/{}/releases/download/{}/",
            self.engine.repository(),
            release.tag_name
        );
        let archive = release.assets.iter().find(|asset| {
            asset.name == name
                && asset.size > 0
                && asset.size <= MAX_ARCHIVE
                && asset.browser_download_url == format!("{prefix}{name}")
        })?;
        let checksums = release.assets.iter().find(|asset| {
            asset.name
                == if self.engine == AliasEngine::Firefox {
                    "SHA256SUMS"
                } else {
                    "SHA256SUMS.txt"
                }
                && asset.size <= 16 * 1024
                && asset.browser_download_url == format!("{prefix}{}", asset.name)
        })?;
        Some((archive, checksums))
    }

    pub fn check_latest(&self) -> Result<AliasRelease, String> {
        let release = self
            .releases()?
            .into_iter()
            .find(|r| self.asset(r).is_some())
            .ok_or("当前平台没有可下载的 AliasMode 内核")?;
        Ok(AliasRelease {
            version: self.version_from_tag(&release.tag_name),
            platform: self.platform().into(),
            checked_at: format!("{}", crate::core::window_store::now_seconds()),
        })
    }

    pub fn status(&self) -> Result<AliasStatus, String> {
        let mut installed = Vec::new();
        if self.root.is_dir() {
            for entry in fs::read_dir(&self.root).map_err(|_| "无法读取本机内核")? {
                let entry = entry.map_err(|_| "无法读取本机内核")?;
                if entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && let Some(version) = entry.file_name().to_str()
                    && let Ok(binary) = self.exact_binary(version)
                {
                    installed.push(AliasKernel {
                        version: version.into(),
                        binary_path: binary.binary_path,
                    });
                }
            }
        }
        installed.sort_by(|a, b| b.version.cmp(&a.version));
        Ok(AliasStatus {
            platform: self.platform().into(),
            installed,
            download: self.job()?,
        })
    }

    pub fn job(&self) -> Result<AliasJob, String> {
        self.job
            .lock()
            .map(|job| job.clone())
            .map_err(|_| "内核状态不可用".into())
    }

    pub fn exact_binary(&self, version: &str) -> Result<PreparedBinary, String> {
        self.asset_for_version(version).ok_or("无效的内核版本")?;
        let directory = self.root.join(version);
        if !fs::symlink_metadata(&directory)
            .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        {
            return Err("该内核未安装或安装不完整".into());
        }
        let manifest: KernelManifest = serde_json::from_slice(
            &fs::read(directory.join(MANIFEST)).map_err(|_| "该内核未安装或安装不完整")?,
        )
        .map_err(|_| "内核安装清单损坏")?;
        if manifest.version != version
            || manifest.platform != self.platform()
            || manifest.engine.as_deref()
                != match self.engine {
                    AliasEngine::Chromium => None,
                    AliasEngine::Firefox => Some("firefox"),
                }
            || !valid_hash(&manifest.archive_sha256)
            || !valid_hash(&manifest.executable_sha256)
        {
            return Err("内核安装清单与当前版本或平台不一致".into());
        }
        let binary = directory.join(self.engine.executable());
        let canonical = binary.canonicalize().map_err(|_| "内核可执行文件不存在")?;
        if !canonical.starts_with(directory.canonicalize().map_err(|_| "内核目录不可用")?) {
            return Err("内核路径不属于受管目录".into());
        }
        if sha256_file(&binary)? != manifest.executable_sha256 {
            return Err("本机内核文件校验失败，请重新下载".into());
        }
        Ok(PreparedBinary {
            version: version.into(),
            binary_path: binary,
        })
    }

    fn download_inner(&self, selected: Option<&str>) -> Result<String, String> {
        let releases = if let Some(version) = selected {
            self.asset_for_version(version).ok_or("发行版本无效")?;
            let tag = self.tag_from_version(version);
            vec![self.release_response::<GithubRelease>(&format!(
                "{}{tag}",
                self.engine.release_tag()
            ))?]
        } else {
            self.releases()?
        };
        let wanted = selected.map(|s| self.tag_from_version(s));
        let release = releases
            .iter()
            .find(|r| {
                wanted.as_ref().is_none_or(|tag| &r.tag_name == tag) && self.asset(r).is_some()
            })
            .ok_or("找不到当前平台对应的官方发行包")?;
        let version = self.version_from_tag(&release.tag_name);
        if self.exact_binary(&version).is_ok() {
            return Ok(version);
        }
        let (archive_asset, sums_asset) = self.asset(release).ok_or("发行包清单无效")?;
        let client = self.client()?;
        let response = client
            .get(&sums_asset.browser_download_url)
            .timeout(Duration::from_secs(20))
            .send()
            .map_err(|_| "无法下载校验清单")?;
        if !response.status().is_success() {
            return Err("无法下载校验清单".into());
        }
        let mut sums = String::new();
        response
            .take(16 * 1024 + 1)
            .read_to_string(&mut sums)
            .map_err(|_| "校验清单读取失败")?;
        if sums.len() > 16 * 1024 {
            return Err("校验清单过大".into());
        }
        let hash = sums
            .lines()
            .find_map(|line| {
                let (digest, name) = line.split_once("  ")?;
                (name == archive_asset.name && valid_hash(digest))
                    .then(|| digest.to_ascii_lowercase())
            })
            .ok_or("官方校验清单缺少该平台的校验值")?;
        fs::create_dir_all(&self.root).map_err(|_| "无法创建内核目录")?;
        let staging = tempfile::tempdir_in(&self.root).map_err(|_| "无法准备内核临时目录")?;
        let archive_path = staging.path().join("download.zip");
        let mut output = File::create(&archive_path).map_err(|_| "无法保存内核下载文件")?;
        let mut response = client
            .get(&archive_asset.browser_download_url)
            .send()
            .map_err(|_| "无法下载内核文件")?;
        if !response.status().is_success() {
            return Err("内核下载服务暂不可用".into());
        }
        let mut digest = Sha256::new();
        let mut downloaded = 0u64;
        let mut chunk = [0u8; 128 * 1024];
        loop {
            let count = response.read(&mut chunk).map_err(|_| "内核下载中断")?;
            if count == 0 {
                break;
            }
            downloaded += count as u64;
            if downloaded > MAX_ARCHIVE {
                return Err("发行文件超出大小限制".into());
            }
            digest.update(&chunk[..count]);
            output
                .write_all(&chunk[..count])
                .map_err(|_| "内核文件写入失败")?;
            if let Ok(mut job) = self.job.lock() {
                job.phase = "downloading";
                job.percent = Some(((downloaded * 100) / archive_asset.size).min(100) as u8);
            }
        }
        output.flush().map_err(|_| "内核文件写入失败")?;
        if downloaded != archive_asset.size || format!("{:x}", digest.finalize()) != hash {
            return Err("发行文件大小或 SHA256 校验失败".into());
        }
        if let Ok(mut job) = self.job.lock() {
            job.phase = "extracting";
            job.percent = None;
        }
        let destination = staging.path().join("unpacked");
        fs::create_dir(&destination).map_err(|_| "无法准备解压目录")?;
        let mut zip =
            zip::ZipArchive::new(File::open(archive_path).map_err(|_| "无法读取内核文件")?)
                .map_err(|_| "内核压缩包无效")?;
        let prefix = archive_asset.name.trim_end_matches(".zip");
        let mut unpacked = 0u64;
        let mut names = HashSet::new();
        #[cfg(unix)]
        let mut links = Vec::<(PathBuf, PathBuf)>::new();
        for index in 0..zip.len() {
            let entry = zip.by_index(index).map_err(|_| "压缩包条目损坏")?;
            let mode = entry.unix_mode();
            let name = Path::new(entry.name());
            let relative = if self.engine == AliasEngine::Firefox {
                name.to_path_buf()
            } else {
                name.strip_prefix(prefix)
                    .map_err(|_| "压缩包目录结构无效")?
                    .to_path_buf()
            };
            if relative.as_os_str().is_empty() {
                if entry.is_dir() {
                    continue;
                }
                return Err("压缩包目录结构无效".into());
            }
            if relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err("压缩包包含不安全路径".into());
            }
            if !names.insert(relative.clone()) {
                return Err("压缩包包含重复路径".into());
            }
            let target = destination.join(&relative);
            #[cfg(unix)]
            if mode.is_some_and(|mode| mode & 0o170000 == 0o120000) {
                let mut bytes = Vec::new();
                let size = entry.size();
                unpacked = unpacked
                    .checked_add(size)
                    .filter(|n| *n <= MAX_UNPACKED)
                    .ok_or("解压内容超出大小限制")?;
                let copied = entry
                    .take(4097)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "链接目标读取失败")?;
                if copied as u64 != size || bytes.len() > 4096 {
                    return Err("链接目标过长".into());
                }
                let link = std::str::from_utf8(&bytes).map_err(|_| "链接目标无效")?;
                let parent = relative.parent().ok_or("链接路径无效")?;
                let mut parts: Vec<_> = parent.components().collect();
                for component in Path::new(link).components() {
                    match component {
                        Component::CurDir => {}
                        Component::Normal(_) => parts.push(component),
                        Component::ParentDir if !parts.is_empty() => {
                            parts.pop();
                        }
                        _ => return Err("链接指向内核目录之外".into()),
                    }
                }
                links.push((target, PathBuf::from(link)));
                continue;
            }
            #[cfg(windows)]
            if mode.is_some_and(|mode| mode & 0o170000 == 0o120000) {
                return Err("压缩包包含不支持的链接".into());
            }
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|_| "无法创建内核目录")?;
                continue;
            }
            if mode.is_some_and(|mode| {
                let kind = mode & 0o170000;
                kind != 0 && kind != 0o100000
            }) {
                return Err("压缩包包含不支持的文件类型".into());
            }
            let size = entry.size();
            unpacked = unpacked
                .checked_add(size)
                .filter(|n| *n <= MAX_UNPACKED)
                .ok_or("解压内容超出大小限制")?;
            fs::create_dir_all(target.parent().ok_or("压缩包路径无效")?)
                .map_err(|_| "无法创建内核目录")?;
            let mut file = File::create(&target).map_err(|_| "无法写入内核文件")?;
            let copied =
                std::io::copy(&mut entry.take(size + 1), &mut file).map_err(|_| "内核解压失败")?;
            if copied != size {
                return Err("解压内容大小不一致".into());
            }
            #[cfg(unix)]
            if mode.is_some_and(|mode| mode & 0o111 != 0) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o755))
                    .map_err(|_| "无法设置内核执行权限")?;
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            for (path, link) in &links {
                let parent = path.parent().ok_or("链接路径无效")?;
                fs::create_dir_all(parent).map_err(|_| "无法创建链接目录")?;
                if !parent
                    .canonicalize()
                    .map_err(|_| "链接父目录不存在")?
                    .starts_with(&destination)
                {
                    return Err("链接父目录不属于内核".into());
                }
                symlink(link, path).map_err(|_| "无法恢复浏览器内部链接")?;
            }
            for (path, _) in links {
                if !path
                    .canonicalize()
                    .map_err(|_| "浏览器内部链接无效")?
                    .starts_with(&destination)
                {
                    return Err("浏览器内部链接越界".into());
                }
            }
        }
        let executable = destination.join(self.engine.executable());
        if !executable.is_file() {
            return Err("发行包缺少浏览器可执行文件".into());
        }
        let executable_sha256 = sha256_file(&executable)?;
        let manifest = KernelManifest {
            version: version.clone(),
            platform: self.platform().into(),
            engine: (self.engine == AliasEngine::Firefox).then(|| "firefox".into()),
            archive_sha256: hash,
            executable_sha256,
        };
        fs::write(
            destination.join(MANIFEST),
            serde_json::to_vec(&manifest).map_err(|_| "无法保存内核清单")?,
        )
        .map_err(|_| "无法保存内核清单")?;
        let installed = self.root.join(&version);
        if fs::symlink_metadata(&installed).is_ok() {
            // A damaged existing installation is never silently replaced.
            return Err("本机同版本内核已存在但校验失败，请检查安装目录".into());
        }
        fs::rename(destination, &installed).map_err(|_| "无法提交内核安装")?;
        #[cfg(windows)]
        {
            // Chromium AppContainer helpers need read/execute on the verified runtime.
            let _ = Command::new("icacls.exe")
                .arg(&installed)
                .args([
                    "/grant",
                    "*S-1-15-2-1:(OI)(CI)(RX)",
                    "*S-1-15-2-2:(OI)(CI)(RX)",
                    "/T",
                    "/Q",
                ])
                .status();
        }
        Ok(version)
    }

    pub fn download(&self, version: Option<String>) -> Result<String, String> {
        if let Some(version) = version.as_deref() {
            self.asset_for_version(version)
                .ok_or("请输入完整的 AliasMode 发行版本")?;
        }
        let _lock = self
            .operation
            .try_lock()
            .map_err(|_| "已有内核下载任务正在进行")?;
        *self.job.lock().map_err(|_| "内核状态不可用")? = AliasJob {
            phase: "preparing",
            percent: None,
            error: None,
        };
        let result = self.download_inner(version.as_deref());
        *self.job.lock().map_err(|_| "内核状态不可用")? = AliasJob {
            phase: if result.is_ok() { "ready" } else { "failed" },
            percent: None,
            error: result.as_ref().err().cloned(),
        };
        result
    }

    pub fn remove(&self, version: &str) -> Result<(), String> {
        if self.asset_for_version(version).is_none() {
            return Err("无效的内核版本".into());
        }
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| "内核正在下载，请稍后重试")?;
        self.exact_binary(version)?;
        let root = self.root.canonicalize().map_err(|_| "内核目录不可用")?;
        let directory = self.root.join(version);
        if directory
            .canonicalize()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            != Some(root)
        {
            return Err("内核目录无效，已阻止删除".into());
        }
        fs::remove_dir_all(directory).map_err(|_| "无法删除内核文件，请检查文件是否被占用".into())
    }

    fn version_from_tag(&self, tag: &str) -> String {
        if self.engine == AliasEngine::Firefox {
            tag.into()
        } else {
            tag.trim_start_matches('v').into()
        }
    }

    fn tag_from_version(&self, version: &str) -> String {
        if self.engine == AliasEngine::Firefox {
            version.into()
        } else {
            format!("v{version}")
        }
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "无法读取内核文件")?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|_| "无法校验内核文件")?;
        if size == 0 {
            break;
        }
        digest.update(&buffer[..size]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[tauri::command]
pub async fn aliasmode_kernel_status(
    state: State<'_, std::sync::Arc<AliasModeKernelService>>,
    firefox: State<'_, std::sync::Arc<FirefoxKernelService>>,
    engine: String,
) -> Result<AliasStatus, String> {
    let service = select_kernel(&state, &firefox, &engine)?;
    tauri::async_runtime::spawn_blocking(move || service.status())
        .await
        .map_err(|_| "内核状态读取中断".to_string())?
}
#[tauri::command]
pub fn aliasmode_kernel_job(
    state: State<'_, std::sync::Arc<AliasModeKernelService>>,
    firefox: State<'_, std::sync::Arc<FirefoxKernelService>>,
    engine: String,
) -> Result<AliasJob, String> {
    select_kernel(&state, &firefox, &engine)?.job()
}
#[tauri::command]
pub async fn aliasmode_kernel_check_latest(
    state: State<'_, std::sync::Arc<AliasModeKernelService>>,
    firefox: State<'_, std::sync::Arc<FirefoxKernelService>>,
    engine: String,
) -> Result<AliasRelease, String> {
    let service = select_kernel(&state, &firefox, &engine)?;
    tauri::async_runtime::spawn_blocking(move || service.check_latest())
        .await
        .map_err(|_| "版本查询中断".to_string())?
}
#[tauri::command]
pub async fn aliasmode_kernel_download(
    state: State<'_, std::sync::Arc<AliasModeKernelService>>,
    firefox: State<'_, std::sync::Arc<FirefoxKernelService>>,
    engine: String,
    version: Option<String>,
) -> Result<String, String> {
    let service = select_kernel(&state, &firefox, &engine)?;
    tauri::async_runtime::spawn_blocking(move || service.download(version))
        .await
        .map_err(|_| "内核下载中断，请刷新状态".to_string())?
}
#[tauri::command]
pub async fn aliasmode_kernel_delete(
    state: State<'_, std::sync::Arc<crate::core::window_service::WindowService>>,
    version: String,
    engine: String,
) -> Result<(), crate::core::browser::provider::BrowserError> {
    let engine = AliasEngine::parse(&engine)
        .map_err(|e| crate::core::browser::provider::BrowserError::new("invalid_config", e))?;
    let service = std::sync::Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        service.remove_managed_kernel(
            crate::core::browser::provider::BrowserProviderId::AliasMode,
            &version,
            engine,
        )
    })
    .await
    .map_err(|_| {
        crate::core::browser::provider::BrowserError::new("task_interrupted", "内核删除中断")
    })?
}

pub struct FirefoxKernelService(pub std::sync::Arc<AliasModeKernelService>);

fn select_kernel(
    chromium: &State<'_, std::sync::Arc<AliasModeKernelService>>,
    firefox: &State<'_, std::sync::Arc<FirefoxKernelService>>,
    engine: &str,
) -> Result<std::sync::Arc<AliasModeKernelService>, String> {
    match AliasEngine::parse(engine)? {
        AliasEngine::Chromium => Ok(std::sync::Arc::clone(chromium.inner())),
        AliasEngine::Firefox => Ok(std::sync::Arc::clone(&firefox.inner().0)),
    }
}
