use super::connection_store::BrowserConnection;
use super::provider::{
    BrowserError, BrowserProviderId, BrowserResult, ProxyMode, RemoteProfile, WindowState,
};
use crate::core::window_store::WindowRecord;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};
use url::{Host, Url};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_PAGES: usize = 1_000;
pub(crate) const PAGE_SIZE: usize = 100;
const MAX_DISCOVERY_BYTES: usize = 32 * 1024 * 1024;
const QUEUE_TIMEOUT: Duration = Duration::from_secs(20);
const DNS_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
pub(crate) enum RequestKind {
    Probe,
    Read,
    Write,
    Start,
}

impl RequestKind {
    fn is_write(self) -> bool {
        matches!(self, Self::Write | Self::Start)
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Probe => Duration::from_secs(5),
            Self::Read | Self::Write => Duration::from_secs(20),
            Self::Start => Duration::from_secs(120),
        }
    }
}

struct ValidatedEndpoint {
    url: Url,
    host: String,
    addresses: Vec<SocketAddr>,
}

fn loopback(ip: IpAddr) -> bool {
    ip.is_loopback()
        || matches!(ip, IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback()))
}

fn validate_endpoint_with(
    endpoint: &str,
    resolve: impl FnOnce(&str, u16) -> BrowserResult<Vec<SocketAddr>>,
) -> BrowserResult<ValidatedEndpoint> {
    let invalid = || BrowserError::new("invalid_config", "本地 API 地址必须使用回环地址");
    if endpoint.len() > 2048
        || endpoint
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\')
    {
        return Err(invalid());
    }
    let url = Url::parse(endpoint).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || endpoint
            .split_once("://")
            .is_some_and(|(_, authority)| authority.split('/').next().unwrap_or("").contains('@'))
    {
        return Err(invalid());
    }
    let port = url
        .port_or_known_default()
        .filter(|port| *port != 0)
        .ok_or_else(invalid)?;
    let host = match url.host().ok_or_else(invalid)? {
        Host::Domain(host) => host.to_string(),
        Host::Ipv4(ip) if ip.is_loopback() => ip.to_string(),
        Host::Ipv6(ip) if loopback(ip.into()) => ip.to_string(),
        _ => return Err(invalid()),
    };
    let addresses = resolve(&host, port)?;
    if addresses.is_empty()
        || addresses.len() > 32
        || addresses
            .iter()
            .any(|address| !loopback(address.ip()) || address.port() != port)
    {
        return Err(invalid());
    }
    Ok(ValidatedEndpoint {
        url,
        host,
        addresses,
    })
}

fn resolve_endpoint(host: &str, port: u16) -> BrowserResult<Vec<SocketAddr>> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    // Bound stalled OS DNS lookups as well as the caller's wait.
    static LOOKUPS: AtomicUsize = AtomicUsize::new(0);
    LOOKUPS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < 4).then_some(count + 1)
        })
        .map_err(|_| BrowserError::new("unavailable", "本地 API 地址解析繁忙，请稍后重试"))?;
    let host = host.to_string();
    let (sender, receiver) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("browser-api-dns".into())
        .spawn(move || {
            let result = (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.take(33).collect::<Vec<_>>());
            LOOKUPS.fetch_sub(1, Ordering::AcqRel);
            let _ = sender.send(result);
        });
    if spawned.is_err() {
        LOOKUPS.fetch_sub(1, Ordering::AcqRel);
        return Err(BrowserError::new("unavailable", "无法解析本地 API 地址"));
    }
    receiver
        .recv_timeout(DNS_TIMEOUT)
        .map_err(|_| BrowserError::new("unavailable", "本地 API 地址解析超时"))?
        .map_err(|_| BrowserError::new("unavailable", "无法解析本地 API 地址"))
}

struct GateState {
    reads: usize,
    writes: usize,
    next_request: Instant,
    profiles: HashSet<String>,
}

struct RequestGate {
    state: Mutex<GateState>,
    changed: Condvar,
    interval: Duration,
}

impl RequestGate {
    fn new(interval: Duration) -> Self {
        Self {
            state: Mutex::new(GateState {
                reads: 0,
                writes: 0,
                next_request: Instant::now(),
                profiles: HashSet::new(),
            }),
            changed: Condvar::new(),
            interval,
        }
    }

    fn acquire(
        self: &Arc<Self>,
        kind: RequestKind,
        deadline: Instant,
    ) -> BrowserResult<RequestPermit> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| pre_send_error(kind, "本地 API 请求队列不可用"))?;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(BrowserError::new(
                    if kind.is_write() {
                        "not_submitted"
                    } else {
                        "rate_limited"
                    },
                    "等待本地 API 请求超时，请求尚未发送",
                ));
            }
            let capacity = if kind.is_write() {
                state.writes < 2
            } else {
                state.reads < 1
            };
            if capacity && now >= state.next_request {
                if kind.is_write() {
                    state.writes += 1;
                } else {
                    state.reads += 1;
                }
                state.next_request = now + self.interval;
                return Ok(RequestPermit {
                    gate: self.clone(),
                    write: kind.is_write(),
                });
            }
            let delay = if capacity {
                state.next_request.saturating_duration_since(now)
            } else {
                deadline.saturating_duration_since(now)
            };
            state = self
                .changed
                .wait_timeout(state, delay.min(deadline.saturating_duration_since(now)))
                .map_err(|_| pre_send_error(kind, "本地 API 请求队列不可用"))?
                .0;
        }
    }
}

struct RequestPermit {
    gate: Arc<RequestGate>,
    write: bool,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            if self.write {
                state.writes -= 1;
            } else {
                state.reads -= 1;
            }
            self.gate.changed.notify_all();
        }
    }
}

pub(crate) struct ProfilePermit {
    gate: Arc<RequestGate>,
    id: String,
}

impl Drop for ProfilePermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.profiles.remove(&self.id);
            self.gate.changed.notify_all();
        }
    }
}

fn connection_gate(connection: &BrowserConnection) -> BrowserResult<Arc<RequestGate>> {
    type Gates = HashMap<(BrowserProviderId, String), Arc<RequestGate>>;
    static GATES: OnceLock<Mutex<Gates>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| BrowserError::new("unavailable", "本地 API 请求队列不可用"))?;
    let key = (connection.provider_id, connection.id.clone());
    if let Some(gate) = gates.get(&key) {
        return Ok(gate.clone());
    }
    // Evict only idle, long-unused entries; a reconnect must not reset the rate limit.
    if gates.len() >= 256 {
        gates.retain(|_, gate| {
            Arc::strong_count(gate) > 1
                || gate
                    .state
                    .lock()
                    .map(|state| {
                        state.next_request + QUEUE_TIMEOUT > Instant::now()
                            || !state.profiles.is_empty()
                    })
                    .unwrap_or(true)
        });
        if gates.len() >= 256 {
            return Err(BrowserError::new(
                "rate_limited",
                "活动的本地 API 接入过多，请稍后重试",
            ));
        }
    }
    let gate = Arc::new(RequestGate::new(Duration::from_secs(1)));
    gates.insert(key, gate.clone());
    Ok(gate)
}

pub(crate) struct LocalApi {
    client: Client,
    endpoint: Url,
    provider: BrowserProviderId,
    enabled: bool,
    scope_confirmed: bool,
    gate: Arc<RequestGate>,
}

impl LocalApi {
    pub(crate) fn connect(
        connection: &BrowserConnection,
        provider: BrowserProviderId,
    ) -> BrowserResult<Self> {
        if connection.provider_id != provider || connection.id.is_empty() {
            return Err(BrowserError::new("invalid_config", "本地 API 接入配置无效"));
        }
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(key) = connection.api_key.as_deref().filter(|key| !key.is_empty()) {
            if provider != BrowserProviderId::AdsPower {
                return Err(BrowserError::unsupported(
                    "当前比特浏览器 API 的密钥鉴权方式尚未确认",
                ));
            }
            if key.len() > 4096 {
                return Err(BrowserError::new("invalid_config", "本地 API 鉴权配置无效"));
            }
            let mut value = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| BrowserError::new("invalid_config", "本地 API 鉴权配置无效"))?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        let endpoint = validate_endpoint_with(&connection.endpoint, resolve_endpoint)?;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .connect_timeout(DNS_TIMEOUT)
            .timeout(Duration::from_secs(20))
            .default_headers(headers)
            .resolve_to_addrs(&endpoint.host, &endpoint.addresses)
            .build()
            .map_err(|_| BrowserError::new("unavailable", "无法初始化本地 API 客户端"))?;
        Ok(Self {
            client,
            endpoint: endpoint.url,
            provider,
            enabled: connection.enabled,
            scope_confirmed: connection.scope_confirmed,
            gate: connection_gate(connection)?,
        })
    }

    pub(crate) fn lock_profile(&self, id: &str) -> BrowserResult<ProfilePermit> {
        let deadline = Instant::now() + QUEUE_TIMEOUT;
        let mut state = self
            .gate
            .state
            .lock()
            .map_err(|_| BrowserError::new("unavailable", "本地 API 请求队列不可用"))?;
        while state.profiles.contains(id) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(BrowserError::new(
                    "profile_busy",
                    "该环境还有操作正在处理，请稍后核对",
                ));
            }
            state = self
                .gate
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| BrowserError::new("unavailable", "本地 API 请求队列不可用"))?
                .0;
        }
        state.profiles.insert(id.into());
        Ok(ProfilePermit {
            gate: self.gate.clone(),
            id: id.into(),
        })
    }

    pub(crate) fn get(
        &self,
        path: &str,
        query: &[(&str, &str)],
        kind: RequestKind,
    ) -> BrowserResult<Value> {
        self.request(path, query, None, kind)
    }

    pub(crate) fn post(&self, path: &str, body: &Value, kind: RequestKind) -> BrowserResult<Value> {
        self.request(path, &[], Some(body), kind)
    }

    fn request(
        &self,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
        kind: RequestKind,
    ) -> BrowserResult<Value> {
        if kind.is_write() {
            require_mutation_access(self.enabled, self.scope_confirmed)?;
        }
        if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#', '\\']) {
            return Err(BrowserError::new("invalid_config", "本地 API 请求路径无效"));
        }
        let bytes = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| BrowserError::new("invalid_config", "本地 API 请求参数无效"))?;
        if bytes
            .as_ref()
            .is_some_and(|bytes| bytes.len() > MAX_REQUEST_BYTES)
        {
            return Err(BrowserError::new(
                "invalid_config",
                "本地 API 请求超过大小限制",
            ));
        }
        let mut url = self.endpoint.clone();
        url.set_path(path);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        let mut request = if let Some(bytes) = bytes {
            self.client
                .post(url)
                .header(CONTENT_TYPE, "application/json")
                .body(bytes)
        } else {
            self.client.get(url)
        };
        request = request.timeout(kind.timeout());
        let _permit = self.gate.acquire(kind, Instant::now() + QUEUE_TIMEOUT)?;
        let response = request.send().map_err(|error| {
            if error.is_connect() {
                pre_send_error(kind, "无法连接本地 API，请检查浏览器应用和接口设置")
            } else {
                response_error(kind, "未能确认本地 API 操作结果，请核对后再操作")
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            let code = match status.as_u16() {
                401 => "auth_required",
                403 => "permission_denied",
                429 => "rate_limited",
                404 | 405 => "unsupported",
                400 | 422 => "invalid_config",
                _ => {
                    return Err(response_error(
                        kind,
                        "未能确认本地 API 请求结果，请核对后再操作",
                    ));
                }
            };
            return Err(business_error(code, kind));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(response_error(kind, "本地 API 响应超过大小限制"));
        }
        let mut bytes = Vec::new();
        response
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| response_error(kind, "无法读取本地 API 响应，操作结果需要核对"))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(response_error(kind, "本地 API 响应超过大小限制"));
        }
        let envelope: Value = serde_json::from_slice(&bytes)
            .map_err(|_| response_error(kind, "本地 API 返回的 JSON 无效"))?;
        let success = match self.provider {
            BrowserProviderId::AdsPower => envelope
                .get("code")
                .and_then(Value::as_i64)
                .map(|code| code == 0),
            BrowserProviderId::BitBrowser => envelope.get("success").and_then(Value::as_bool),
            BrowserProviderId::CloakBrowser => None,
        }
        .ok_or_else(|| response_error(kind, "本地 API 响应缺少业务结果状态"))?;
        if !success {
            // Inspect vendor text only for classification. Never expose it, bodies, or URLs.
            let message = envelope
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let code = classify_business_error(envelope.get("code"), &message);
            return Err(business_error(code, kind));
        }
        Ok(envelope.get("data").cloned().unwrap_or(Value::Null))
    }
}

fn classify_business_error(code: Option<&Value>, message: &str) -> &'static str {
    let contains = |words: &[&str]| words.iter().any(|word| message.contains(*word));
    if code.and_then(Value::as_i64) == Some(401)
        || contains(&[
            "unauthorized",
            "api key",
            "api_key",
            "apikey",
            "authentication",
            "token",
            "\u{767b}\u{5f55}",
        ])
    {
        "auth_required"
    } else if code.and_then(Value::as_i64) == Some(403)
        || contains(&[
            "permission",
            "forbidden",
            "access denied",
            "\u{6743}\u{9650}",
        ])
    {
        "permission_denied"
    } else if code.and_then(Value::as_i64) == Some(429)
        || contains(&[
            "rate limit",
            "too many",
            "frequency",
            "\u{9891}\u{7e41}",
            "\u{9891}\u{7387}",
        ])
    {
        "rate_limited"
    } else if contains(&[
        "not found",
        "not exist",
        "doesn't exist",
        "\u{4e0d}\u{5b58}\u{5728}",
    ]) {
        "profile_missing"
    } else if contains(&[
        "busy",
        "already open",
        "already running",
        "\u{5df2}\u{6253}\u{5f00}",
    ]) {
        "profile_busy"
    } else if contains(&[
        "not support",
        "unsupported",
        "upgrade",
        "\u{4e0d}\u{652f}\u{6301}",
    ]) {
        "unsupported"
    } else {
        "invalid_config"
    }
}

fn business_error(code: &str, kind: RequestKind) -> BrowserError {
    let message = match code {
        "auth_required" => "本地 API 鉴权失败，请检查密钥和登录状态",
        "permission_denied" => "当前账户没有本地 API 操作权限",
        "rate_limited" => "本地 API 请求过于频繁，请稍后重试",
        "profile_missing" => "远端环境不可访问，请核对账户和权限",
        "profile_busy" => "远端环境正在使用或处理其他操作",
        "unsupported" => "当前本地 API 不支持此操作，请检查浏览器应用版本",
        _ => "本地 API 拒绝了请求，请检查配置",
    };
    let mut error = BrowserError::new(code, message);
    if kind.is_write() {
        error.retryable = false;
    }
    error
}

fn response_error(kind: RequestKind, message: &str) -> BrowserError {
    BrowserError::new(
        if kind.is_write() {
            "operation_uncertain"
        } else {
            "unavailable"
        },
        message,
    )
}

fn pre_send_error(kind: RequestKind, message: &str) -> BrowserError {
    BrowserError::new(
        if kind.is_write() {
            "not_submitted"
        } else {
            "unavailable"
        },
        message,
    )
}

/// Only apply to setup and read failures before the operation's first mutating request.
pub(crate) fn preflight_error(error: BrowserError) -> BrowserError {
    if error.code == "unavailable" {
        BrowserError::new("not_submitted", error.message)
    } else {
        error
    }
}

pub(crate) fn invalid_response() -> BrowserError {
    BrowserError::new(
        "unavailable",
        "本地 API 返回的数据不完整或相互矛盾，请重新核对",
    )
}

pub(crate) fn account_page_bytes(total: &mut usize, data: &Value) -> BrowserResult<()> {
    *total += serde_json::to_vec(data)
        .map_err(|_| invalid_response())?
        .len();
    if *total > MAX_DISCOVERY_BYTES {
        return Err(BrowserError::new(
            "unavailable",
            "本地 API 环境列表超过大小限制，无法完成核对",
        ));
    }
    Ok(())
}

pub(crate) fn uncertain(message: &str) -> BrowserError {
    BrowserError::new("operation_uncertain", message)
}

pub(crate) fn valid_id(id: &str) -> BrowserResult<()> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(BrowserError::new("invalid_config", "远端环境标识无效"));
    }
    Ok(())
}

pub(crate) fn validate_binding(
    connection: &BrowserConnection,
    record: &WindowRecord,
    provider: BrowserProviderId,
) -> BrowserResult<()> {
    if record.schema_version != 2
        || record.binding.provider_id != provider
        || record.binding.connection_id != connection.id
        || connection.provider_id != provider
    {
        return Err(BrowserError::new(
            "invalid_config",
            "窗口绑定与当前浏览器接入不匹配",
        ));
    }
    valid_id(&record.binding.profile_id)
}

pub(crate) fn validate_update(
    previous: &WindowRecord,
    updated: &WindowRecord,
) -> BrowserResult<()> {
    if previous.id != updated.id || previous.binding != updated.binding {
        return Err(BrowserError::new(
            "invalid_config",
            "已有窗口的浏览器环境绑定不可修改",
        ));
    }
    if previous.settings.fingerprint_seed != updated.settings.fingerprint_seed
        || previous.kernel_version != updated.kernel_version
        || previous.binary_path != updated.binary_path
    {
        return Err(BrowserError::unsupported(
            "不能在此修改外部浏览器的指纹种子或内核",
        ));
    }
    Ok(())
}

pub(crate) fn require_scope(connection: &BrowserConnection) -> BrowserResult<()> {
    require_mutation_access(connection.enabled, connection.scope_confirmed)
}

fn require_mutation_access(enabled: bool, scope_confirmed: bool) -> BrowserResult<()> {
    if !enabled {
        return Err(BrowserError::new(
            "invalid_config",
            "请先启用当前浏览器接入，再修改环境",
        ));
    }
    if !scope_confirmed {
        return Err(BrowserError::new(
            "scope_mismatch",
            "请先确认当前浏览器账户，再修改环境",
        ));
    }
    Ok(())
}

pub(crate) fn validate_create(
    connection: &BrowserConnection,
    record: &WindowRecord,
    provider: BrowserProviderId,
) -> BrowserResult<()> {
    require_scope(connection)?;
    if connection.provider_id != provider
        || record.binding.provider_id != provider
        || record.binding.connection_id != connection.id
        || record.schema_version != 2
        || !record.binding.profile_id.is_empty()
    {
        return Err(BrowserError::new(
            "invalid_config",
            "新建外部浏览器环境的绑定无效",
        ));
    }
    if record.settings.fingerprint_seed.is_some()
        || record.kernel_version.is_some()
        || record.binary_path.is_some()
    {
        return Err(BrowserError::unsupported(
            "外部浏览器的内核和指纹种子由其官方应用管理",
        ));
    }
    validate_settings(record)
}

pub(crate) fn validate_settings(record: &WindowRecord) -> BrowserResult<()> {
    if record.name.trim().is_empty()
        || record.name.chars().count() > 100
        || record.name.chars().any(char::is_control)
        || record.settings.timezone.len() > 64
        || record.settings.timezone.chars().any(char::is_control)
        || record.settings.locale.len() > 35
        || !record
            .settings
            .locale
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        || !matches!(
            record.settings.viewport.as_str(),
            "default" | "1440x900" | "1920x1080"
        )
    {
        return Err(BrowserError::new(
            "invalid_config",
            "外部浏览器环境配置无效",
        ));
    }
    if !record.settings.start_url.is_empty() {
        let url = Url::parse(&record.settings.start_url)
            .map_err(|_| BrowserError::new("invalid_config", "环境起始地址无效"))?;
        if record.settings.start_url.len() > 4096
            || !matches!(url.scheme(), "http" | "https")
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(BrowserError::new("invalid_config", "环境起始地址无效"));
        }
    }
    Ok(())
}

pub(crate) fn operation_marker(operation_id: &str) -> BrowserResult<String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrowserError::new("invalid_config", "浏览器操作标识无效"));
    }
    Ok(format!("[nexus:operation:{operation_id}]"))
}

pub(crate) fn create_remark(record: &WindowRecord, operation_id: &str) -> BrowserResult<String> {
    let marker = operation_marker(operation_id)?;
    let remark = record.provider_config["raw"]["remark"]
        .as_str()
        .unwrap_or("");
    if remark.len() > 16 * 1024 {
        return Err(BrowserError::new(
            "invalid_config",
            "远端环境备注超过大小限制",
        ));
    }
    if remark
        .lines()
        .any(|line| line.starts_with("[nexus:operation:") && line != marker)
    {
        return Err(BrowserError::new(
            "invalid_config",
            "该环境包含其他 Nexus 操作标记，请先核对",
        ));
    }
    if remark.lines().any(|line| line == marker) {
        Ok(remark.into())
    } else if remark.is_empty() {
        Ok(marker)
    } else {
        Ok(format!("{remark}\n{marker}"))
    }
}

pub(crate) fn reconcile_marker(
    profiles: Vec<RemoteProfile>,
    operation_id: &str,
) -> BrowserResult<Option<RemoteProfile>> {
    let marker = operation_marker(operation_id)?;
    let mut matches = profiles.into_iter().filter(|profile| {
        profile.provider_config["raw"]["remark"]
            .as_str()
            .is_some_and(|remark| remark.lines().any(|line| line == marker))
    });
    let profile = matches.next();
    if matches.next().is_some() {
        return Err(uncertain(
            "多个远端环境包含相同的 Nexus 操作标记，需要手动核对",
        ));
    }
    Ok(profile)
}

pub(crate) fn sanitized_config(raw: &Value) -> Value {
    fn sanitize(value: &Value, depth: usize) -> Value {
        if depth > 32 {
            return Value::Null;
        }
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .filter(|(key, _)| {
                        let key: String = key
                            .chars()
                            .filter(|ch| ch.is_ascii_alphanumeric())
                            .flat_map(char::to_lowercase)
                            .collect();
                        ![
                            "cookie",
                            "password",
                            "passwd",
                            "token",
                            "secret",
                            "authorization",
                            "apikey",
                            "fakey",
                            "username",
                            "proxyuser",
                            "proxyurl",
                            "dynamicipurl",
                            "connectionurl",
                        ]
                        .iter()
                        .any(|secret| key.contains(*secret))
                    })
                    .map(|(key, value)| (key.clone(), sanitize(value, depth + 1)))
                    .collect(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| sanitize(value, depth + 1))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    sanitize(raw, 0)
}

pub(crate) fn profile_config(raw: &Value, id: &str, fields: &[(&str, &str)]) -> Value {
    let mut identity = serde_json::Map::new();
    identity.insert("profileId".into(), json!(id));
    for &(target, source) in fields {
        if let Some(value) = raw.get(source).filter(|value| {
            value.is_number() || value.as_str().is_some_and(|value| !value.is_empty())
        }) {
            identity.insert(target.into(), value.clone());
        }
    }
    json!({"identity": identity, "raw": sanitized_config(raw)})
}

pub(crate) fn verify_identity(record: &WindowRecord, remote: &RemoteProfile) -> BrowserResult<()> {
    let saved = record.provider_config["identity"].as_object();
    let current = remote.provider_config["identity"].as_object();
    let verified = saved.zip(current).is_some_and(|(saved, current)| {
        saved.get("profileId").and_then(Value::as_str) == Some(remote.id.as_str())
            && ["createdAt", "ownerId", "createdBy", "mainUserId"]
                .iter()
                .any(|key| saved.contains_key(*key))
            && saved
                .iter()
                .all(|(key, value)| current.get(key) == Some(value))
    });
    if !verified {
        return Err(BrowserError::new(
            "scope_mismatch",
            "远端环境身份发生变化或无法确认，请重新核对接入",
        ));
    }
    Ok(())
}

pub(crate) fn verify_observed_identities(
    records: &[WindowRecord],
    profiles: &[RemoteProfile],
) -> BrowserResult<HashSet<String>> {
    let profiles: HashMap<&str, &RemoteProfile> = profiles
        .iter()
        .map(|profile| (profile.id.as_str(), profile))
        .collect();
    for record in records {
        if let Some(remote) = profiles.get(record.binding.profile_id.as_str()) {
            verify_identity(record, remote)?;
        }
    }
    Ok(profiles.into_keys().map(str::to_string).collect())
}

pub(crate) fn observed_states(
    records: &[WindowRecord],
    accessible: &HashSet<String>,
    active: &HashSet<String>,
) -> BrowserResult<HashMap<String, WindowState>> {
    records
        .iter()
        .map(|record| {
            let id = &record.binding.profile_id;
            let state = match (accessible.contains(id), active.contains(id)) {
                (true, true) => WindowState::Running,
                (true, false) => WindowState::Stopped,
                (false, false) => WindowState::Missing,
                // Discovery and activity may race, but cannot prove the same identity.
                (false, true) => return Err(invalid_response()),
            };
            Ok((id.clone(), state))
        })
        .collect()
}

pub(crate) fn timestamp(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| *value > 0)
}

pub(crate) struct ProxyConfig {
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

pub(crate) fn parse_proxy(value: &str) -> BrowserResult<ProxyConfig> {
    let invalid = || BrowserError::new("invalid_config", "必需的浏览器代理配置无效");
    if value.len() > 8192
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || ch == '\\')
    {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https" | "socks5")
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let host = match url.host().ok_or_else(invalid)? {
        Host::Domain(host) => host.to_string(),
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => ip.to_string(),
    };
    let port = url
        .port_or_known_default()
        .filter(|port| *port != 0)
        .ok_or_else(invalid)?;
    Ok(ProxyConfig {
        protocol: url.scheme().into(),
        host,
        port,
        username: decode_credential(url.username())?,
        password: decode_credential(url.password().unwrap_or(""))?,
    })
}

fn decode_credential(value: &str) -> BrowserResult<String> {
    let invalid = || BrowserError::new("invalid_config", "浏览器代理鉴权信息无效");
    let mut result = Vec::new();
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let a = (bytes.next().ok_or_else(invalid)? as char)
                .to_digit(16)
                .ok_or_else(invalid)?;
            let b = (bytes.next().ok_or_else(invalid)? as char)
                .to_digit(16)
                .ok_or_else(invalid)?;
            result.push((a * 16 + b) as u8);
        } else {
            result.push(byte);
        }
    }
    let decoded = String::from_utf8(result).map_err(|_| invalid())?;
    if decoded.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(decoded)
}

pub(crate) fn proxy_changed(previous: &WindowRecord, updated: &WindowRecord) -> bool {
    previous.proxy_mode != updated.proxy_mode
        || match updated.proxy_mode {
            ProxyMode::Manual => previous.proxy != updated.proxy,
            ProxyMode::Plugin => {
                previous.proxy_plugin != updated.proxy_plugin
                    || previous.proxy_endpoint != updated.proxy_endpoint
            }
            ProxyMode::Direct | ProxyMode::Provider => false,
        }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::{self, JoinHandle};

    #[derive(Clone)]
    pub(crate) struct CapturedRequest {
        pub method: String,
        pub target: String,
        pub headers: String,
        pub body: Value,
    }

    pub(crate) struct MockResponse {
        status: u16,
        headers: String,
        body: Vec<u8>,
        close_listener: bool,
    }

    impl MockResponse {
        pub(crate) fn json(value: Value) -> Self {
            Self::raw(200, "", serde_json::to_vec(&value).unwrap())
        }

        pub(crate) fn raw(status: u16, headers: &str, body: Vec<u8>) -> Self {
            Self {
                status,
                headers: headers.into(),
                body,
                close_listener: false,
            }
        }

        pub(crate) fn close_listener(mut self) -> Self {
            self.close_listener = true;
            self
        }
    }

    pub(crate) struct MockServer {
        pub endpoint: String,
        requests: Arc<Mutex<Vec<CapturedRequest>>>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl MockServer {
        pub(crate) fn new(responses: Vec<MockResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let worker = thread::spawn(move || {
                let mut listener = Some(listener);
                for response in responses {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    let mut stream = loop {
                        if stopped.load(Ordering::Acquire) || Instant::now() >= deadline {
                            return;
                        }
                        match listener.as_ref().unwrap().accept() {
                            Ok((stream, _)) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(5));
                            }
                            Err(error) => panic!("mock accept: {error}"),
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    loop {
                        let mut byte = [0];
                        stream.read_exact(&mut byte).unwrap();
                        bytes.push(byte[0]);
                        if bytes.ends_with(b"\r\n\r\n") {
                            break;
                        }
                        assert!(bytes.len() < 16 * 1024);
                    }
                    let headers = String::from_utf8(bytes).unwrap();
                    let length = headers
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    stream.read_exact(&mut body).unwrap();
                    let mut request_line = headers.lines().next().unwrap().split_whitespace();
                    captured.lock().unwrap().push(CapturedRequest {
                        method: request_line.next().unwrap().into(),
                        target: request_line.next().unwrap().into(),
                        headers,
                        body: if body.is_empty() {
                            Value::Null
                        } else {
                            serde_json::from_slice(&body).unwrap()
                        },
                    });
                    // Close before responding so a subsequent connect is deterministically refused.
                    if response.close_listener {
                        drop(listener.take());
                    }
                    if response.status != 0 {
                        let head = format!(
                            "HTTP/1.1 {} Mock\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
                            response.status,
                            response.body.len(),
                            response.headers
                        );
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(&response.body);
                    }
                    if response.close_listener {
                        return;
                    }
                }
            });
            Self {
                endpoint,
                requests,
                stop,
                worker: Some(worker),
            }
        }

        pub(crate) fn requests(&self) -> Vec<CapturedRequest> {
            self.requests.lock().unwrap().clone()
        }

        pub(crate) fn connection(&self, provider_id: BrowserProviderId) -> BrowserConnection {
            BrowserConnection {
                id: uuid::Uuid::new_v4().to_string(),
                provider_id,
                name: "Mock connection".into(),
                endpoint: self.endpoint.clone(),
                api_key: None,
                default_group_id: Some("group-1".into()),
                scope_label: "Test scope".into(),
                scope_id: None,
                scope_confirmed: true,
                enabled: true,
                revision: 1,
            }
        }
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            let result = self.worker.take().unwrap().join();
            if !thread::panicking() {
                result.expect("mock server worker failed");
            }
        }
    }

    #[test]
    fn mock_server_waits_for_request_bytes_after_accepting_a_connection() {
        let server = MockServer::new(vec![MockResponse::json(json!({"code":0}))]);
        let mut client =
            std::net::TcpStream::connect(server.endpoint.strip_prefix("http://").unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        client
            .write_all(b"GET /delayed HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].target, "/delayed");
    }

    pub(crate) fn record(connection: &BrowserConnection, id: &str) -> WindowRecord {
        WindowRecord {
            schema_version: 2,
            id: "nexus-window".into(),
            name: "Window".into(),
            binding: super::super::provider::BrowserBinding {
                provider_id: connection.provider_id,
                connection_id: connection.id.clone(),
                profile_id: id.into(),
            },
            binary_path: None,
            kernel_version: None,
            proxy: None,
            proxy_plugin: None,
            proxy_endpoint: None,
            proxy_mode: ProxyMode::Direct,
            settings: Default::default(),
            origin: super::super::provider::WindowOrigin::Created,
            provider_config: json!({}),
            created_at: 1,
            last_opened_at: None,
            sort_order: 0,
        }
    }

    #[test]
    fn rejects_remote_mixed_and_empty_dns_results() {
        for addresses in [
            vec!["203.0.113.1:50325".parse().unwrap()],
            vec![
                "127.0.0.1:50325".parse().unwrap(),
                "203.0.113.1:50325".parse().unwrap(),
            ],
            vec![],
        ] {
            let result =
                validate_endpoint_with("http://local.adspower.net:50325", |_, _| Ok(addresses));
            assert_eq!(result.err().unwrap().code, "invalid_config");
        }
    }

    #[test]
    fn accepts_dns_loopback_alias_and_ipv6_but_rejects_unsafe_url_parts() {
        let endpoint = validate_endpoint_with("http://local.adspower.net:50325", |host, port| {
            assert_eq!((host, port), ("local.adspower.net", 50325));
            Ok(vec!["127.0.0.1:50325".parse().unwrap()])
        })
        .unwrap();
        assert_eq!(endpoint.addresses[0].ip().to_string(), "127.0.0.1");
        assert!(
            validate_endpoint_with("http://[::1]:54345/", |_, _| {
                Ok(vec!["[::1]:54345".parse().unwrap()])
            })
            .is_ok()
        );
        for url in [
            "file:///etc/passwd",
            "http://user:secret@127.0.0.1:50325",
            "http://127.0.0.1:50325/base",
            "http://127.0.0.1:50325?api_key=secret",
            "http://127.0.0.1:50325/#fragment",
            "http://127.0.0.1:0",
            "http://0.0.0.0:50325",
            "http://[::]:50325",
            " http://127.0.0.1:50325",
            "http://127.0.0.1:50325\\evil",
        ] {
            assert!(
                validate_endpoint_with(url, |_, _| {
                    Ok(vec!["127.0.0.1:50325".parse().unwrap()])
                })
                .is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn mutations_require_enabled_confirmed_access_cached_by_the_client() {
        for (enabled, scope_confirmed, expected) in [
            (false, false, "invalid_config"),
            (false, true, "invalid_config"),
            (true, false, "scope_mismatch"),
        ] {
            let server = MockServer::new(vec![
                MockResponse::json(json!({"code": 0})),
                MockResponse::json(json!({"code": 0})),
            ]);
            let mut connection = server.connection(BrowserProviderId::AdsPower);
            connection.enabled = enabled;
            connection.scope_confirmed = scope_confirmed;
            let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
            assert_eq!(require_scope(&connection).unwrap_err().code, expected);
            for kind in [RequestKind::Write, RequestKind::Start] {
                assert_eq!(
                    api.post("/mutation", &json!({"id": "remote-1"}), kind)
                        .unwrap_err()
                        .code,
                    expected
                );
                assert_eq!(api.get("/mutation", &[], kind).unwrap_err().code, expected);
            }
            assert!(server.requests().is_empty());
            connection.enabled = true;
            connection.scope_confirmed = true;
            assert!(require_scope(&connection).is_ok());
            assert_eq!(
                api.post("/mutation", &json!({}), RequestKind::Write)
                    .unwrap_err()
                    .code,
                expected
            );
            let active = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
            active
                .post("/write", &json!({"id": "remote-1"}), RequestKind::Write)
                .unwrap();
            active
                .get("/start", &[("id", "remote-1")], RequestKind::Start)
                .unwrap();
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].method, "POST");
            assert_eq!(requests[0].target, "/write");
            assert_eq!(requests[0].body, json!({"id": "remote-1"}));
            assert_eq!(requests[1].method, "GET");
            assert_eq!(requests[1].target, "/start?id=remote-1");
        }
    }

    #[test]
    fn does_not_follow_redirects_or_retry_submitted_writes() {
        let server = MockServer::new(vec![
            MockResponse::raw(302, "Location: http://203.0.113.1/\r\n", Vec::new()),
            MockResponse::json(json!({"code": 0, "data": {}})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
        let error = api
            .post("/write", &json!({"id": "remote-1"}), RequestKind::Write)
            .unwrap_err();
        assert_eq!(error.code, "operation_uncertain");
        assert!(!error.retryable);
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn rejects_oversized_and_malformed_success_without_echoing_secrets() {
        for response in [
            MockResponse::raw(200, "", vec![b'x'; MAX_RESPONSE_BYTES + 1]),
            MockResponse::raw(200, "", b"{secret-password".to_vec()),
            MockResponse::json(json!({"data": {}, "msg": "secret-password"})),
        ] {
            let server = MockServer::new(vec![response]);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
            let error = api
                .post("/write", &json!({}), RequestKind::Write)
                .unwrap_err();
            assert_eq!(error.code, "operation_uncertain");
            assert!(!error.message.contains("secret-password"));
        }
    }

    #[test]
    fn classifies_http_and_business_failures_even_at_http_200() {
        for (response, expected) in [
            (MockResponse::raw(401, "", Vec::new()), "auth_required"),
            (MockResponse::raw(403, "", Vec::new()), "permission_denied"),
            (
                MockResponse::json(json!({"code": -1, "msg": "rate limit exceeded"})),
                "rate_limited",
            ),
            (
                MockResponse::json(json!({"code": -1, "msg": "profile not found"})),
                "profile_missing",
            ),
            (
                MockResponse::json(json!({"code": -1, "msg": "invalid config secret"})),
                "invalid_config",
            ),
        ] {
            let server = MockServer::new(vec![response]);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
            let error = api.get("/read", &[], RequestKind::Read).unwrap_err();
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("secret"));
        }
    }

    #[test]
    fn keeps_read_capacity_and_enforces_mutation_concurrency_and_spacing() {
        let gate = Arc::new(RequestGate::new(Duration::from_millis(15)));
        let deadline = Instant::now() + Duration::from_secs(1);
        let start = Instant::now();
        let first = gate.acquire(RequestKind::Write, deadline).unwrap();
        let second = gate.acquire(RequestKind::Write, deadline).unwrap();
        assert!(start.elapsed() >= Duration::from_millis(15));
        let read = gate.acquire(RequestKind::Read, deadline).unwrap();
        for (kind, expected) in [
            (RequestKind::Write, "not_submitted"),
            (RequestKind::Start, "not_submitted"),
            (RequestKind::Read, "rate_limited"),
        ] {
            let error = gate
                .acquire(kind, Instant::now() + Duration::from_millis(20))
                .err()
                .unwrap();
            assert_eq!(error.code, expected);
        }
        drop((first, second, read));
        assert!(gate.acquire(RequestKind::Write, deadline).is_ok());
    }

    #[test]
    fn proxy_change_detection_uses_only_the_selected_source() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut previous = record(&connection, "remote-1");
        previous.proxy_mode = ProxyMode::Plugin;
        previous.proxy_plugin = Some("studio.proxy-pool".into());
        previous.proxy_endpoint = Some(7);
        let mut updated = previous.clone();
        updated.proxy = Some("socks5://fixture-user:fixture-pass@rotated.test:1080".into());
        assert!(!proxy_changed(&previous, &updated));
        updated.proxy_endpoint = Some(8);
        assert!(proxy_changed(&previous, &updated));
        updated.proxy_endpoint = previous.proxy_endpoint;
        updated.proxy_plugin = Some("studio.another-proxy".into());
        assert!(proxy_changed(&previous, &updated));
        updated = previous.clone();
        updated.proxy_mode = ProxyMode::Direct;
        assert!(proxy_changed(&previous, &updated));

        previous.proxy_mode = ProxyMode::Manual;
        previous.proxy = Some("http://manual-a.test:8080".into());
        updated = previous.clone();
        updated.proxy_plugin = None;
        updated.proxy_endpoint = None;
        assert!(!proxy_changed(&previous, &updated));
        updated.proxy = Some("http://manual-b.test:8080".into());
        assert!(proxy_changed(&previous, &updated));
        for mode in [ProxyMode::Direct, ProxyMode::Provider] {
            previous.proxy_mode = mode;
            updated.proxy_mode = mode;
            assert!(!proxy_changed(&previous, &updated));
        }
    }

    #[test]
    fn decodes_proxy_credentials_and_strips_sensitive_remote_fields_recursively() {
        let proxy = parse_proxy("socks5://user%40test:p%3A%2F%25@proxy.test:1080").unwrap();
        assert_eq!(proxy.username, "user@test");
        assert_eq!(proxy.password, "p:/%");
        assert_eq!(proxy.port, 1080);
        assert!(parse_proxy("socks5://proxy.test:1080/path").is_err());
        assert!(parse_proxy("http://proxy.test:80/?token=secret").is_err());
        let safe = sanitized_config(&json!({
            "createdTime": "2026-11-10 10:00:00",
            "Cookie": "secret",
            "password": "secret",
            "proxyPassword": "secret",
            "fakey": "secret",
            "nested": [{"proxy_password": "secret", "canvas": "fixed"}]
        }));
        assert_eq!(
            safe,
            json!({
                "createdTime": "2026-11-10 10:00:00",
                "nested": [{"canvas": "fixed"}]
            })
        );
    }

    #[test]
    fn bypasses_proxy_environment_and_sends_only_documented_auth() {
        const CHILD_ENV: &str = "NEXUS_LOCAL_API_PROXY_TEST_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .arg("local_api::tests::bypasses_proxy_environment_and_sends_only_documented_auth")
                .arg("--nocapture")
                .env(CHILD_ENV, "1");
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                command.env(key, "http://192.0.2.1:9");
            }
            command.env("NO_PROXY", "").env("no_proxy", "");
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let server = MockServer::new(vec![MockResponse::json(json!({"code": 0}))]);
        let mut connection = server.connection(BrowserProviderId::AdsPower);
        connection.api_key = Some("fixture-key".into());
        let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
        api.get(
            "/read",
            &[("profile_id", "remote id/+?")],
            RequestKind::Read,
        )
        .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].target, "/read?profile_id=remote+id%2F%2B%3F");
        assert!(
            requests[0]
                .headers
                .to_lowercase()
                .contains("authorization: bearer fixture-key")
        );
    }

    #[test]
    fn submitted_disconnect_and_business_rejection_are_never_retried() {
        for kind in [RequestKind::Write, RequestKind::Start] {
            for (response, expected) in [
                (MockResponse::raw(0, "", vec![]), "operation_uncertain"),
                (MockResponse::raw(429, "", vec![]), "rate_limited"),
                (
                    MockResponse::json(json!({"code": -1, "msg": "rate limit"})),
                    "rate_limited",
                ),
                (MockResponse::raw(401, "", vec![]), "auth_required"),
                (MockResponse::raw(403, "", vec![]), "permission_denied"),
                (MockResponse::raw(400, "", vec![]), "invalid_config"),
                (MockResponse::raw(405, "", vec![]), "unsupported"),
            ] {
                let server =
                    MockServer::new(vec![response, MockResponse::json(json!({"code": 0}))]);
                let connection = server.connection(BrowserProviderId::AdsPower);
                let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
                let error = api
                    .post("/write", &json!({"id": "remote-1"}), kind)
                    .unwrap_err();
                assert_eq!(error.code, expected);
                assert!(!error.retryable);
                let requests = server.requests();
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0].target, "/write");
                assert_eq!(requests[0].body, json!({"id": "remote-1"}));
            }
        }
    }

    #[test]
    fn connection_refusal_is_not_submitted_only_for_mutations() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        drop(server);
        let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
        for (kind, expected) in [
            (RequestKind::Write, "not_submitted"),
            (RequestKind::Start, "not_submitted"),
            (RequestKind::Read, "unavailable"),
            (RequestKind::Probe, "unavailable"),
        ] {
            let error = api.post("/attempt", &json!({}), kind).unwrap_err();
            assert_eq!(error.code, expected);
            assert!(error.retryable);
        }
    }

    #[test]
    fn preflight_mapping_preserves_definite_errors_and_existing_uncertainty() {
        let error = preflight_error(BrowserError::new("unavailable", "本地 API 不可访问"));
        assert_eq!(error.code, "not_submitted");
        assert!(error.retryable);
        for code in [
            "invalid_config",
            "auth_required",
            "permission_denied",
            "unsupported",
            "rate_limited",
            "profile_busy",
            "profile_missing",
            "scope_mismatch",
            "operation_uncertain",
        ] {
            let mut original = BrowserError::new(code, "原始错误");
            original.retryable = false;
            let error = preflight_error(original);
            assert_eq!(error.code, code);
            assert_eq!(error.message, "原始错误");
            assert!(!error.retryable);
        }
    }

    #[test]
    fn serializes_same_profile_without_holding_network_read_slots() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let first_api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
        let second_api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
        assert!(Arc::ptr_eq(&first_api.gate, &second_api.gate));
        let profile = first_api.lock_profile("remote-1").unwrap();
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            ready_sender.send(()).unwrap();
            let permit = second_api.lock_profile("remote-1").unwrap();
            sender.send(()).unwrap();
            drop(permit);
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        let read = first_api
            .gate
            .acquire(RequestKind::Read, Instant::now() + Duration::from_secs(1))
            .unwrap();
        drop((profile, read));
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
    }
}
