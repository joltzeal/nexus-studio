use super::kernel_service::run_preparation;
use super::license_store::{LicenseStatus, LicenseStore};
use super::network_proxy::NetworkProxyStore;
use super::runtime_paths::RuntimePaths;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

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
            return Err("请输入激活码".into());
        }
        let license = self.validate_with_official_sdk(key)?;
        persist_validated_license(&self.store, key, &license)?;
        self.store.status()
    }

    fn validate_with_official_sdk(&self, key: &str) -> Result<ValidatedLicense, String> {
        let script = &self.runtime.browser_script;
        if !script.is_file() {
            return Err("安装包缺少激活校验组件，请重新安装应用".into());
        }
        // Explicit activation must reach the service, not accept the SDK's
        // 24-hour cache or its offline fallback to an older success.
        std::fs::create_dir_all(&self.cache_dir).map_err(|_| "无法创建激活校验目录")?;
        let validation_cache = tempfile::Builder::new()
            .prefix(".activation-check-")
            .tempdir_in(&self.cache_dir)
            .map_err(|_| "无法创建激活校验目录")?;
        let mut command = Command::new(&self.runtime.node);
        if let Some(network) = &self.network {
            network
                .get()?
                .apply_to_node(&mut command, &self.runtime.network_preload)?;
        }
        command
            .arg(script)
            .arg("validate-license")
            .env("CLOAKBROWSER_LICENSE_KEY", key)
            .env("CLOAKBROWSER_CACHE_DIR", validation_cache.path())
            .env_remove("CLOAKBROWSER_VERSION")
            .env_remove("CLOAKBROWSER_BINARY_PATH")
            .env_remove("CLOAKBROWSER_DOWNLOAD_URL")
            .env_remove("CLOAKBROWSER_RELEASE_CHANNEL");
        let output =
            run_preparation(&mut command, Duration::from_secs(20), None).map_err(|error| {
                if error.contains("超时") {
                    "激活校验超时，请检查应用代理或网络后重试"
                } else {
                    "无法运行激活校验组件，请重启或重新安装应用"
                }
            })?;
        if !output.status.success() {
            return Err("无法连接激活服务，请检查应用代理或网络后重试".into());
        }
        let value = output
            .stdout
            .split(|byte| *byte == b'\n')
            .rev()
            .find(|line| !line.is_empty())
            .ok_or("激活服务未返回校验结果，请稍后重试")?;
        let result: Option<ValidatedLicense> =
            serde_json::from_slice(value).map_err(|_| "无法读取激活校验结果，请稍后重试")?;
        result.ok_or_else(|| "无法连接激活服务，请检查应用代理或网络后重试".into())
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
        return Err("激活服务未接受此激活码；原有激活码未更改".into());
    }
    if license.plan.trim().is_empty() {
        return Err("激活校验结果异常；原有激活码未更改".into());
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
        .map_err(|_| "激活校验任务中断，请重试".to_string())?
}

#[tauri::command]
pub fn license_remove(state: tauri::State<'_, Arc<LicenseService>>) -> Result<(), String> {
    state.remove()
}
