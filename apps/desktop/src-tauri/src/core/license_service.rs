use super::license_store::{LicenseStatus, LicenseStore};
use super::network_proxy::NetworkProxyStore;
use super::runtime_paths::RuntimePaths;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ValidatedLicense {
    pub valid: bool,
    pub plan: String,
    pub expires: Option<String>,
}

#[derive(Clone)]
pub struct LicenseService {
    store: LicenseStore,
    cache_dir: PathBuf,
    runtime: RuntimePaths,
    network: Option<NetworkProxyStore>,
}

impl LicenseService {
    pub fn new(store: LicenseStore, cache_dir: PathBuf) -> Self {
        Self::with_runtime(store, cache_dir, RuntimePaths::development())
    }

    pub fn with_runtime(store: LicenseStore, cache_dir: PathBuf, runtime: RuntimePaths) -> Self {
        Self {
            store,
            cache_dir,
            runtime,
            network: None,
        }
    }

    pub fn with_network(mut self, network: NetworkProxyStore) -> Self {
        self.network = Some(network);
        self
    }

    pub fn status(&self) -> Result<LicenseStatus, String> {
        self.store.status()
    }

    pub fn set_key(&self, key: String) -> Result<LicenseStatus, String> {
        let key = key.trim();
        if key.is_empty() || key.len() > 1024 {
            return Err("请输入有效的 CloakBrowser 密钥".into());
        }
        let license = self.validate_with_official_sdk(key)?;
        persist_validated_license(&self.store, key, &license)?;
        self.store.status()
    }

    fn validate_with_official_sdk(&self, key: &str) -> Result<ValidatedLicense, String> {
        let script = &self.runtime.browser_script;
        if !script.is_file() {
            return Err("浏览器适配器未构建，请重新启动 Nexus 桌面开发命令".into());
        }
        let mut command = Command::new(&self.runtime.node);
        if let Some(network) = &self.network {
            network
                .get()?
                .apply_to_node(&mut command, &self.runtime.network_preload)?;
        }
        let output = command
            .arg(script)
            .arg("validate-license")
            .env("CLOAKBROWSER_LICENSE_KEY", key)
            .env("CLOAKBROWSER_CACHE_DIR", &self.cache_dir)
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| "未找到 Node.js 运行时，请重新启动 Nexus 桌面应用")?;
        if !output.status.success() {
            return Err("无法连接 CloakBrowser 授权服务，请检查网络后重试".into());
        }
        let value = output
            .stdout
            .split(|byte| *byte == b'\n')
            .rev()
            .find(|line| !line.is_empty())
            .ok_or("CloakBrowser 未返回授权校验结果")?;
        let result: Option<ValidatedLicense> =
            serde_json::from_slice(value).map_err(|_| "无法读取 CloakBrowser 授权校验结果")?;
        result.ok_or_else(|| "无法连接 CloakBrowser 授权服务，请检查网络后重试".into())
    }

    pub fn remove(&self) -> Result<(), String> {
        self.store.remove()
    }
}

pub fn persist_validated_license(
    store: &LicenseStore,
    key: &str,
    license: &ValidatedLicense,
) -> Result<(), String> {
    if !license.valid {
        return Err("CloakBrowser 密钥无效或已过期；原有密钥未更改".into());
    }
    if license.plan.trim().is_empty() {
        return Err("CloakBrowser 授权信息无效；原有密钥未更改".into());
    }
    store.save_validated(key, &license.plan, license.expires.as_deref())
}

#[tauri::command]
pub fn license_status(
    state: tauri::State<'_, Arc<LicenseService>>,
) -> Result<LicenseStatus, String> {
    state.status()
}

#[tauri::command]
pub async fn license_set(
    state: tauri::State<'_, Arc<LicenseService>>,
    key: String,
) -> Result<LicenseStatus, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.set_key(key))
        .await
        .map_err(|_| "CloakBrowser 授权校验任务中断".to_string())?
}

#[tauri::command]
pub fn license_remove(state: tauri::State<'_, Arc<LicenseService>>) -> Result<(), String> {
    state.remove()
}
