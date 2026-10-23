use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkProxy {
    pub mode: ProxyMode,
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    Direct,
    System,
    Manual,
}

impl Default for NetworkProxy {
    fn default() -> Self {
        Self {
            mode: ProxyMode::Direct,
            url: None,
        }
    }
}

#[derive(Clone)]
pub struct NetworkProxyStore {
    path: PathBuf,
}

impl NetworkProxyStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let store = Self { path };
        store.connect()?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法创建代理设置目录")?;
        }
        let conn = Connection::open(&self.path).map_err(|_| "无法打开代理设置数据库")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS network_proxy (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, url TEXT)",
            [],
        )
        .map_err(|_| "无法初始化代理设置")?;
        Ok(conn)
    }

    pub fn get(&self) -> Result<NetworkProxy, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT mode, url FROM network_proxy WHERE id = 1",
            [],
            |row| {
                let mode: String = row.get(0)?;
                let url = row.get(1)?;
                Ok((mode, url))
            },
        )
        .optional()
        .map_err(|_| "无法读取代理设置")?
        .map(|(mode, url)| {
            let mode = match mode.as_str() {
                "direct" => ProxyMode::Direct,
                "system" => ProxyMode::System,
                "manual" => ProxyMode::Manual,
                _ => return Err("代理设置已损坏，请检查本地数据库".into()),
            };
            Ok(NetworkProxy { mode, url })
        })
        .unwrap_or_else(|| Ok(NetworkProxy::default()))
    }

    pub fn set(&self, value: NetworkProxy) -> Result<NetworkProxy, String> {
        let url = match value.mode {
            ProxyMode::Manual => Some(validate_url(value.url.as_deref().unwrap_or_default())?),
            _ => None,
        };
        let value = NetworkProxy {
            mode: value.mode,
            url,
        };
        // Resolve the system setting before accepting it: PAC and malformed
        // configurations must not silently turn a selected proxy into direct.
        value.resolve()?;
        let conn = self.connect()?;
        let mode = match value.mode {
            ProxyMode::Direct => "direct",
            ProxyMode::System => "system",
            ProxyMode::Manual => "manual",
        };
        conn.execute(
            "INSERT INTO network_proxy (id, mode, url) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, url = excluded.url",
            params![mode, value.url],
        )
        .map_err(|_| "无法保存代理设置")?;
        Ok(value)
    }
}

fn validate_url(input: &str) -> Result<String, String> {
    let parsed = url::Url::parse(input.trim()).map_err(|_| "代理地址格式无效")?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5")
        || parsed.host_str().is_none()
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("请输入无凭据的 http、https 或 socks5 代理地址及端口".into());
    }
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}

impl NetworkProxy {
    pub fn resolve(&self) -> Result<Option<String>, String> {
        match self.mode {
            ProxyMode::Direct => Ok(None),
            ProxyMode::Manual => self
                .url
                .as_deref()
                .map(validate_url)
                .transpose()
                .and_then(|url| url.map(Some).ok_or_else(|| "请填写代理地址".into())),
            ProxyMode::System => system_proxy(),
        }
    }

    pub fn apply_to_node(&self, command: &mut Command, preload: &Path) -> Result<(), String> {
        let proxy = self.resolve()?;
        if !preload.is_file() {
            return Err("应用缺少代理运行时，请重新安装 Nexus".into());
        }
        let preload_url = url::Url::from_file_path(preload).map_err(|_| "代理运行时路径无效")?;
        command
            .arg("--import")
            .arg(preload_url.as_str())
            .env(
                "NEXUS_NETWORK_MODE",
                match self.mode {
                    ProxyMode::Direct => "direct",
                    ProxyMode::System => "system",
                    ProxyMode::Manual => "manual",
                },
            )
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .env_remove("all_proxy")
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .env_remove("NODE_USE_ENV_PROXY");
        if let Some(proxy) = proxy {
            command.env("NEXUS_NETWORK_PROXY", proxy);
        } else {
            command.env_remove("NEXUS_NETWORK_PROXY");
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn system_proxy() -> Result<Option<String>, String> {
    let output = Command::new("scutil")
        .arg("--proxy")
        .output()
        .map_err(|_| "无法读取系统代理")?;
    if !output.status.success() {
        return Err("无法读取系统代理".into());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "系统代理配置无效")?;
    let field = |name: &str| -> Option<&str> {
        text.lines()
            .filter_map(|line| line.trim().split_once(" : "))
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.trim())
    };
    if field("ProxyAutoConfigEnable") == Some("1") || field("ProxyAutoDiscoveryEnable") == Some("1")
    {
        return Err("当前系统使用自动代理配置，暂不支持 PAC；请填写手动代理地址".into());
    }
    for (prefix, scheme) in [("SOCKS", "socks5"), ("HTTPS", "http"), ("HTTP", "http")] {
        if field(&format!("{prefix}Enable")) == Some("1") {
            let host = field(&format!("{prefix}Proxy")).ok_or("系统代理缺少主机")?;
            let port = field(&format!("{prefix}Port")).ok_or("系统代理缺少端口")?;
            return validate_url(&format!("{scheme}://{host}:{port}")).map(Some);
        }
    }
    Ok(None)
}

#[cfg(target_os = "windows")]
fn system_proxy() -> Result<Option<String>, String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let read = |name: &str| -> Result<Option<String>, String> {
        let output = Command::new("reg")
            .args(["query", key, "/v", name])
            .output()
            .map_err(|_| "无法读取系统代理")?;
        if !output.status.success() {
            return Ok(None);
        }
        let text = String::from_utf8(output.stdout).map_err(|_| "系统代理配置无效")?;
        Ok(text
            .lines()
            .find(|line| line.trim_start().starts_with(name))
            .and_then(|line| line.split_whitespace().last())
            .map(str::to_owned))
    };
    if read("AutoConfigURL")?.is_some() {
        return Err("当前系统使用自动代理配置，暂不支持 PAC；请填写手动代理地址".into());
    }
    if read("ProxyEnable")?.as_deref() != Some("0x1") {
        return Ok(None);
    }
    let server = read("ProxyServer")?.ok_or("系统代理缺少主机")?;
    let socks = server
        .split(';')
        .find_map(|item| item.strip_prefix("socks="));
    let server = socks
        .or_else(|| {
            server
                .split(';')
                .find_map(|item| item.strip_prefix("https="))
        })
        .or_else(|| {
            server
                .split(';')
                .find_map(|item| item.strip_prefix("http="))
        })
        .unwrap_or(&server);
    let scheme = if socks.is_some() { "socks5" } else { "http" };
    validate_url(&format!("{scheme}://{server}")).map(Some)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn system_proxy() -> Result<Option<String>, String> {
    Err("此平台暂不支持读取系统代理".into())
}

#[tauri::command]
pub fn network_proxy_get(state: State<'_, NetworkProxyStore>) -> Result<NetworkProxy, String> {
    state.get()
}

#[tauri::command]
pub fn network_proxy_set(
    state: State<'_, NetworkProxyStore>,
    host: State<'_, std::sync::Arc<super::plugin_host::PluginHost>>,
    value: NetworkProxy,
) -> Result<NetworkProxy, String> {
    let saved = state.set(value)?;
    host.restart_for_network_change();
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_is_persisted_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let store = NetworkProxyStore::new(dir.path().join("settings.sqlite")).unwrap();
        assert_eq!(store.get().unwrap(), NetworkProxy::default());
        assert!(
            store
                .set(NetworkProxy {
                    mode: ProxyMode::Manual,
                    url: Some("socks5://user:pw@127.0.0.1:7890".into()),
                })
                .is_err()
        );
        let expected = NetworkProxy {
            mode: ProxyMode::Manual,
            url: Some("socks5://127.0.0.1:7890".into()),
        };
        assert_eq!(store.set(expected.clone()).unwrap(), expected);
        assert_eq!(store.get().unwrap(), expected);
        assert_eq!(
            NetworkProxyStore::new(dir.path().join("settings.sqlite"))
                .unwrap()
                .get()
                .unwrap(),
            expected
        );
        let preload = dir.path().join("network-preload.js");
        std::fs::write(&preload, b"").unwrap();
        let mut command = Command::new("node");
        expected.apply_to_node(&mut command, &preload).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(args[0], "--import");
        assert_eq!(
            args[1],
            url::Url::from_file_path(&preload).unwrap().as_str()
        );
    }
}
