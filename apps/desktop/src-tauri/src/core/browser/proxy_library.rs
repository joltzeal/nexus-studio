use super::{
    local_api::parse_proxy,
    provider::{BrowserError, BrowserResult},
};
use crate::core::{
    database::open_database, window_service::WindowService, window_store::now_seconds,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    net::IpAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;
use uuid::Uuid;

const MAX_ENTRIES: usize = 10_000;
const MAX_BODY: u64 = 65_536;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Http,
    Https,
    Socks5,
}
impl ProxyKind {
    fn scheme(&self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
            Self::Socks5 => "socks5",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyEntry {
    pub id: String,
    pub name: String,
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub country: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyTestSnapshot {
    pub first_seen: String,
    pub last_seen: String,
    pub ip: String,
    pub country_code: String,
    pub country: String,
    pub region: String,
    pub city: String,
    pub isp: String,
    pub timezone: String,
    pub latitude: f64,
    pub longitude: f64,
    pub tcp_ms: Option<u64>,
    pub udp_ms: Option<u64>,
    pub udp_error: Option<String>,
    pub geo_error: Option<String>,
    pub provider: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyUsage {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub proxy_id: String,
}

fn storage(_: impl std::fmt::Display) -> BrowserError {
    BrowserError::new("storage_failed", "无法读写全局代理库")
}
fn invalid(message: &str) -> BrowserError {
    BrowserError::new("invalid_config", message)
}
fn missing() -> BrowserError {
    BrowserError::new("proxy_missing", "绑定的代理不存在，请重新选择代理")
}

fn credential(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            encoded.push(char::from(b"0123456789ABCDEF"[(byte & 15) as usize]));
        }
    }
    encoded
}

impl ProxyEntry {
    pub fn connection_url(&self) -> BrowserResult<String> {
        let host = self.host.trim();
        if host.is_empty()
            || host.len() > 253
            || host
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || "@/?#\\".contains(c))
            || self.port == 0
        {
            return Err(invalid("代理主机或端口无效"));
        }
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host.into()
        };
        let auth = if self.username.is_empty() && self.password.is_empty() {
            String::new()
        } else {
            format!(
                "{}:{}@",
                credential(&self.username),
                credential(&self.password)
            )
        };
        let raw = format!("{}://{auth}{host}:{}", self.kind.scheme(), self.port);
        parse_proxy(&raw)?;
        Ok(raw)
    }
    fn normalize(mut self) -> BrowserResult<Self> {
        if self.id.len() > 128
            || self.id.chars().any(char::is_control)
            || self.name.chars().count() > 200
            || self.notes.chars().count() > 4096
            || self.country.len() > 128
            || self.username.len() > 1024
            || self.password.len() > 1024
            || self.username.chars().any(char::is_control)
            || self.password.chars().any(char::is_control)
        {
            return Err(invalid("代理字段长度或内容无效"));
        }
        let config = parse_proxy(&self.connection_url()?)?;
        self.host = config.host;
        self.name = self.name.trim().into();
        self.country = self.country.trim().into();
        Ok(self)
    }
    fn same_endpoint(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.host == other.host
            && self.port == other.port
            && self.username == other.username
            && self.password == other.password
    }
}

pub struct ProxyLibrary {
    path: PathBuf,
}
impl ProxyLibrary {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    fn db(&self) -> BrowserResult<Connection> {
        open_database(&self.path).map_err(storage)
    }
    pub fn list(&self) -> BrowserResult<Vec<ProxyEntry>> {
        let db = self.db()?;
        let mut query = db
            .prepare("SELECT record_json FROM browser_proxy_library ORDER BY rowid")
            .map_err(storage)?;
        query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage)?
            .map(|row| decode(&row.map_err(storage)?))
            .collect()
    }
    pub fn get(&self, id: &str) -> BrowserResult<ProxyEntry> {
        read_entry(&self.db()?, id)?.ok_or_else(missing)
    }
    pub fn save(&self, entry: ProxyEntry) -> BrowserResult<ProxyEntry> {
        let mut entry = entry.normalize()?;
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().to_string();
        }
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(previous) = read_entry(&tx, &entry.id)? {
            if !previous.same_endpoint(&entry) {
                tx.execute(
                    "DELETE FROM browser_proxy_tests WHERE proxy_id=?1",
                    [&entry.id],
                )
                .map_err(storage)?;
            }
        }
        write_entry(&tx, &entry)?;
        tx.commit().map_err(storage)?;
        Ok(entry)
    }
    pub(crate) fn save_inline(
        &self,
        connection_url: &str,
        reference: Option<&str>,
    ) -> BrowserResult<ProxyEntry> {
        let config = parse_proxy(connection_url)?;
        let kind = match config.protocol.as_str() {
            "http" => ProxyKind::Http,
            "https" => ProxyKind::Https,
            "socks5" => ProxyKind::Socks5,
            _ => return Err(invalid("代理协议无效")),
        };
        let mut entry = ProxyEntry {
            id: String::new(),
            name: format!("{}:{}", config.host, config.port),
            kind,
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            country: String::new(),
            notes: String::new(),
        }
        .normalize()?;
        let reference = reference
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if reference.is_empty()
            || reference.len() > 120
            || !reference
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(invalid("代理引用无效"));
        }
        entry.id = format!("inline-{reference}");
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if let Some(existing) = read_entry(&tx, &entry.id)? {
            if !existing.same_endpoint(&entry) {
                return Err(BrowserError::new(
                    "operation_conflict",
                    "同一操作引用的代理配置已改变",
                ));
            }
            return Ok(existing);
        }
        write_entry(&tx, &entry)?;
        tx.commit().map_err(storage)?;
        Ok(entry)
    }
    pub fn bulk_save(&self, entries: Vec<ProxyEntry>) -> BrowserResult<usize> {
        if entries.len() > MAX_ENTRIES {
            return Err(invalid("单次导入最多 10000 条代理"));
        }
        let entries = entries
            .into_iter()
            .map(ProxyEntry::normalize)
            .collect::<BrowserResult<Vec<_>>>()?;
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let mut added = 0;
        for mut entry in entries {
            let duplicate: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM browser_proxy_library WHERE json_extract(record_json,'$.kind')=?1
                 AND json_extract(record_json,'$.host')=?2 AND json_extract(record_json,'$.port')=?3
                 AND json_extract(record_json,'$.username')=?4 AND json_extract(record_json,'$.password')=?5)",
                params![entry.kind.scheme(),entry.host,entry.port,entry.username,entry.password], |row| row.get(0),
            ).map_err(storage)?;
            if duplicate {
                continue;
            }
            if entry.id.is_empty() || read_entry(&tx, &entry.id)?.is_some() {
                entry.id = Uuid::new_v4().to_string();
            }
            write_entry(&tx, &entry)?;
            added += 1;
        }
        tx.commit().map_err(storage)?;
        Ok(added)
    }
    pub fn delete(&self, id: &str) -> BrowserResult<()> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let referenced: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM profile_records WHERE json_extract(record_json,'$.proxy_id')=?1)
             OR EXISTS(SELECT 1 FROM browser_operations WHERE phase NOT IN('committed','failed','cancelled')
               AND (json_extract(record_json,'$.payload.record.proxy_id')=?1 OR json_extract(record_json,'$.payload.previous.proxy_id')=?1))",
            [id], |row| row.get(0),
        ).map_err(storage)?;
        if referenced {
            return Err(BrowserError::new(
                "proxy_in_use",
                "代理仍被 Profile 或待确认操作使用，请先解除绑定",
            ));
        }
        tx.execute("DELETE FROM browser_proxy_library WHERE id=?1", [id])
            .map_err(storage)?;
        tx.commit().map_err(storage)
    }
    pub fn usage(&self) -> BrowserResult<Vec<ProxyUsage>> {
        let db = self.db()?;
        let mut query = db.prepare(
            "SELECT id,json_extract(record_json,'$.name'),connection_id,json_extract(record_json,'$.proxy_id')
             FROM profile_records WHERE json_extract(record_json,'$.proxy_id') IS NOT NULL ORDER BY sort_order,id",
        ).map_err(storage)?;
        query
            .query_map([], |row| {
                Ok(ProxyUsage {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    connection_id: row.get(2)?,
                    proxy_id: row.get(3)?,
                })
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)
    }
    pub fn history(&self, id: &str) -> BrowserResult<Vec<ProxyTestSnapshot>> {
        let db = self.db()?;
        let mut query = db
            .prepare(
                "SELECT record_json FROM browser_proxy_tests WHERE proxy_id=?1 ORDER BY sequence",
            )
            .map_err(storage)?;
        query
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(storage)?
            .map(|row| serde_json::from_str(&row.map_err(storage)?).map_err(storage))
            .collect()
    }
    pub fn full_test(&self, entry: ProxyEntry) -> BrowserResult<ProxyTestSnapshot> {
        let entry = entry.normalize()?;
        let mut snapshot = probe(&entry)?;
        if entry.id.is_empty() {
            return Ok(snapshot);
        }
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        // Draft tests and tests racing an edit must never replace the saved endpoint's history.
        if let Some(mut saved) = read_entry(&tx, &entry.id)? {
            if saved.same_endpoint(&entry) {
                let first: Option<String> = tx.query_row(
                    "SELECT json_extract(record_json,'$.first_seen') FROM browser_proxy_tests
                     WHERE proxy_id=?1 AND json_extract(record_json,'$.ip')=?2 ORDER BY sequence LIMIT 1",
                    params![entry.id,snapshot.ip], |row| row.get(0),
                ).optional().map_err(storage)?;
                if !snapshot.ip.is_empty() {
                    if let Some(first) = first {
                        snapshot.first_seen = first;
                    }
                }
                tx.execute(
                    "INSERT INTO browser_proxy_tests(proxy_id,record_json) VALUES(?1,?2)",
                    params![entry.id, serde_json::to_string(&snapshot).map_err(storage)?],
                )
                .map_err(storage)?;
                tx.execute("DELETE FROM browser_proxy_tests WHERE proxy_id=?1 AND sequence NOT IN(SELECT sequence FROM browser_proxy_tests WHERE proxy_id=?1 ORDER BY sequence DESC LIMIT 20)", [&entry.id]).map_err(storage)?;
                if !snapshot.country_code.is_empty()
                    && (saved.country.is_empty() || saved.country == "—")
                {
                    saved.country = snapshot.country_code.clone();
                    write_entry(&tx, &saved)?;
                }
            }
        }
        tx.commit().map_err(storage)?;
        Ok(snapshot)
    }
}
fn decode(text: &str) -> BrowserResult<ProxyEntry> {
    let entry: ProxyEntry = serde_json::from_str(text).map_err(storage)?;
    entry.normalize().map_err(storage)
}
fn read_entry(db: &Connection, id: &str) -> BrowserResult<Option<ProxyEntry>> {
    let text: Option<String> = db
        .query_row(
            "SELECT record_json FROM browser_proxy_library WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    text.map(|text| decode(&text)).transpose()
}
fn write_entry(db: &Connection, entry: &ProxyEntry) -> BrowserResult<()> {
    db.execute("INSERT INTO browser_proxy_library(id,record_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json",
        params![entry.id,serde_json::to_string(entry).map_err(storage)?]).map_err(storage)?;
    Ok(())
}

pub fn bulk_parse(text: &str, kind: ProxyKind) -> BrowserResult<Vec<ProxyEntry>> {
    if text.len() > 8 * 1024 * 1024 {
        return Err(invalid("代理导入文本过大"));
    }
    let mut entries = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            return Err(invalid("单次导入最多 10000 条代理"));
        }
        let result = parse_line(line, &kind);
        entries.push(result.map_err(|_| invalid(&format!("第 {} 行代理格式无效", index + 1)))?);
    }
    Ok(entries)
}
fn parse_line(line: &str, default_kind: &ProxyKind) -> BrowserResult<ProxyEntry> {
    let (line, label) = match line.split_once("  # ") {
        Some((address, name)) => (address.trim(), Some(name.trim())),
        None => (line, None),
    };
    let (scheme, address) = match line.split_once("://") {
        Some((scheme, address)) => (scheme.to_ascii_lowercase(), address),
        None => (default_kind.scheme().into(), line),
    };
    let kind = match scheme.as_str() {
        "http" => ProxyKind::Http,
        "https" => ProxyKind::Https,
        "socks5" => ProxyKind::Socks5,
        _ => return Err(invalid("代理协议无效")),
    };
    let (host, port, username, password) = if address.contains('@') || address.starts_with('[') {
        // Bracketed IPv6 also accepts the host:port:user:password form.
        if address.starts_with('[') && !address.contains('@') {
            let (host, rest) = address
                .split_once(']')
                .ok_or_else(|| invalid("IPv6 格式无效"))?;
            let mut parts = rest
                .strip_prefix(':')
                .ok_or_else(|| invalid("代理端口缺失"))?
                .splitn(3, ':');
            (
                host.trim_start_matches('[').into(),
                parts
                    .next()
                    .unwrap_or("")
                    .parse::<u16>()
                    .map_err(|_| invalid("代理端口无效"))?,
                parts.next().unwrap_or("").into(),
                parts.next().unwrap_or("").into(),
            )
        } else {
            let config = parse_proxy(&format!("{scheme}://{address}"))?;
            (config.host, config.port, config.username, config.password)
        }
    } else {
        let mut parts = address.splitn(4, ':');
        (
            parts.next().unwrap_or("").into(),
            parts
                .next()
                .unwrap_or("")
                .parse::<u16>()
                .map_err(|_| invalid("代理端口无效"))?,
            parts.next().unwrap_or("").into(),
            parts.next().unwrap_or("").into(),
        )
    };
    ProxyEntry {
        id: Uuid::new_v4().to_string(),
        name: label
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{host}:{port}")),
        kind,
        host,
        port,
        username,
        password,
        country: String::new(),
        notes: String::new(),
    }
    .normalize()
}

fn read_json(client: &reqwest::blocking::Client, endpoint: &str) -> BrowserResult<Value> {
    let response = client
        .get(endpoint)
        .send()
        .map_err(|_| BrowserError::new("proxy_test_failed", "代理请求失败或超时"))?;
    if !response.status().is_success() {
        return Err(BrowserError::new(
            "proxy_test_failed",
            "代理检测服务返回错误状态",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BrowserError::new("proxy_test_failed", "无法读取代理检测结果"))?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(BrowserError::new("proxy_test_failed", "代理检测响应过大"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| BrowserError::new("proxy_test_failed", "代理检测响应格式无效"))
}
fn probe(entry: &ProxyEntry) -> BrowserResult<ProxyTestSnapshot> {
    let raw = entry.connection_url()?;
    // Remote DNS for SOCKS keeps detection traffic inside the selected proxy.
    let raw = if entry.kind == ProxyKind::Socks5 {
        raw.replacen("socks5://", "socks5h://", 1)
    } else {
        raw
    };
    let proxy = reqwest::Proxy::all(&raw).map_err(|_| invalid("代理配置无效"))?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| invalid("无法初始化代理检测"))?;
    let stamp = format!("@{}", now_seconds());
    let mut snapshot = ProxyTestSnapshot {
        first_seen: stamp.clone(),
        last_seen: stamp,
        ip: String::new(),
        country_code: String::new(),
        country: String::new(),
        region: String::new(),
        city: String::new(),
        isp: String::new(),
        timezone: String::new(),
        latitude: 0.0,
        longitude: 0.0,
        tcp_ms: None,
        udp_ms: None,
        udp_error: Some("UDP 未检测（当前仅检测经代理的 HTTPS 连接）".into()),
        geo_error: None,
        provider: "ipify / ipwho.is".into(),
    };
    let started = Instant::now();
    let result = (|| -> BrowserResult<()> {
        let ip_data = read_json(&client, "https://api.ipify.org?format=json")?;
        let ip: IpAddr = ip_data["ip"]
            .as_str()
            .and_then(|ip| ip.parse().ok())
            .ok_or_else(|| BrowserError::new("proxy_test_failed", "出口 IP 响应无效"))?;
        snapshot.ip = ip.to_string();
        snapshot.tcp_ms = Some(started.elapsed().as_millis().max(1) as u64);
        let geo = read_json(&client, &format!("https://ipwho.is/{ip}"))?;
        if geo["success"].as_bool() != Some(true)
            || geo["ip"].as_str().and_then(|ip| ip.parse::<IpAddr>().ok()) != Some(ip)
        {
            return Err(BrowserError::new(
                "proxy_geo_failed",
                "出口 IP 地理位置查询失败",
            ));
        }
        let text = |key: &str| geo[key].as_str().unwrap_or("").to_string();
        snapshot.country_code = text("country_code");
        snapshot.country = text("country");
        snapshot.region = text("region");
        snapshot.city = text("city");
        snapshot.isp = geo["connection"]["isp"].as_str().unwrap_or("").into();
        snapshot.timezone = geo["timezone"]["id"].as_str().unwrap_or("").into();
        snapshot.latitude = geo["latitude"].as_f64().unwrap_or(0.0);
        snapshot.longitude = geo["longitude"].as_f64().unwrap_or(0.0);
        Ok(())
    })();
    if let Err(error) = result {
        snapshot.geo_error = Some(error.message);
    }
    snapshot.last_seen = format!("@{}", now_seconds());
    Ok(snapshot)
}

fn library(state: &WindowService) -> ProxyLibrary {
    ProxyLibrary::new(state.store.database_path())
}
async fn run<T: Send + 'static>(
    job: impl FnOnce() -> BrowserResult<T> + Send + 'static,
) -> BrowserResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| BrowserError::new("task_interrupted", "代理操作任务中断，请重新读取结果"))?
}
#[tauri::command]
pub async fn browser_proxy_list(
    state: State<'_, Arc<WindowService>>,
) -> BrowserResult<Vec<ProxyEntry>> {
    let lib = library(&state);
    run(move || lib.list()).await
}
#[tauri::command]
pub async fn browser_proxy_save(
    state: State<'_, Arc<WindowService>>,
    entry: ProxyEntry,
) -> BrowserResult<ProxyEntry> {
    let lib = library(&state);
    run(move || lib.save(entry)).await
}
#[tauri::command]
pub async fn browser_proxy_delete(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<()> {
    let lib = library(&state);
    run(move || lib.delete(&id)).await
}
#[tauri::command]
pub async fn browser_proxy_usage(
    state: State<'_, Arc<WindowService>>,
) -> BrowserResult<Vec<ProxyUsage>> {
    let lib = library(&state);
    run(move || lib.usage()).await
}
#[tauri::command]
pub async fn browser_proxy_bulk_parse(
    text: String,
    kind: ProxyKind,
) -> BrowserResult<Vec<ProxyEntry>> {
    run(move || bulk_parse(&text, kind)).await
}
#[tauri::command]
pub async fn browser_proxy_bulk_save(
    state: State<'_, Arc<WindowService>>,
    entries: Vec<ProxyEntry>,
) -> BrowserResult<usize> {
    let lib = library(&state);
    run(move || lib.bulk_save(entries)).await
}
#[tauri::command]
pub async fn browser_proxy_bulk_import(
    state: State<'_, Arc<WindowService>>,
    text: String,
    kind: ProxyKind,
) -> BrowserResult<usize> {
    let lib = library(&state);
    run(move || lib.bulk_save(bulk_parse(&text, kind)?)).await
}
#[tauri::command]
pub async fn browser_proxy_full_test(
    state: State<'_, Arc<WindowService>>,
    entry: ProxyEntry,
) -> BrowserResult<ProxyTestSnapshot> {
    let lib = library(&state);
    run(move || lib.full_test(entry)).await
}
#[tauri::command]
pub async fn browser_proxy_history(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<Vec<ProxyTestSnapshot>> {
    let lib = library(&state);
    run(move || lib.history(&id)).await
}
#[tauri::command]
pub async fn browser_proxy_last_test(
    state: State<'_, Arc<WindowService>>,
    id: String,
) -> BrowserResult<Option<ProxyTestSnapshot>> {
    let lib = library(&state);
    run(move || Ok(lib.history(&id)?.pop())).await
}
