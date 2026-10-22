use super::manifest::{Capability, PluginManifest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 1;
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_PROTOCOL_ERRORS: u32 = 3;
pub const MAX_STDERR_BYTES: usize = 4096;
pub const MAX_DEADLINE_MS: u64 = 120_000;
/// Extra wait on top of the plugin deadline before the host gives up.
pub const DEADLINE_GRACE: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginErrorPayload {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl PluginErrorPayload {
    pub fn new(code: &str, message: &str, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            retryable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessError {
    SpawnFailed,
    HandshakeFailed(String),
    HandshakeTimeout,
    ManifestMismatch,
    NotReady,
    Failed(String),
    Timeout,
    Cancelled,
    Protocol(String),
    Plugin(PluginErrorPayload),
}

impl ProcessError {
    pub fn code(&self) -> &str {
        match self {
            ProcessError::SpawnFailed | ProcessError::HandshakeFailed(_) => "UNAVAILABLE",
            ProcessError::HandshakeTimeout | ProcessError::Timeout => "TIMEOUT",
            ProcessError::ManifestMismatch | ProcessError::Protocol(_) => "PROTOCOL_ERROR",
            ProcessError::NotReady | ProcessError::Failed(_) => "UNAVAILABLE",
            ProcessError::Cancelled => "CANCELLED",
            ProcessError::Plugin(payload) => payload.code.as_str(),
        }
    }

    pub fn message(&self) -> String {
        match self {
            ProcessError::SpawnFailed => "无法启动插件进程".into(),
            ProcessError::HandshakeFailed(reason) => format!("插件握手失败：{reason}"),
            ProcessError::HandshakeTimeout => "插件未在限定时间内完成握手".into(),
            ProcessError::ManifestMismatch => "插件进程报告的标识与已安装清单不一致".into(),
            ProcessError::NotReady => "插件进程尚未就绪".into(),
            ProcessError::Failed(reason) => format!("插件进程不可用：{reason}"),
            ProcessError::Timeout => "调用超过截止时间，结果作废".into(),
            ProcessError::Cancelled => "调用已取消".into(),
            ProcessError::Protocol(reason) => format!("插件违反宿主协议：{reason}"),
            ProcessError::Plugin(payload) => payload.message.clone(),
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            ProcessError::Plugin(payload) => payload.retryable,
            ProcessError::Timeout | ProcessError::NotReady | ProcessError::Failed(_) => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadyInfo {
    pub plugin_id: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub methods: Vec<String>,
    pub status: Value,
}

struct Inner {
    plugin_id: String,
    version: String,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Sender<Result<Value, PluginErrorPayload>>>>,
    ready: Mutex<Option<ReadyInfo>>,
    failed: Mutex<Option<String>>,
    stderr_tail: Mutex<String>,
    protocol_errors: Mutex<u32>,
}

impl Inner {
    fn write(&self, message: &Value) -> bool {
        let Ok(mut guard) = self.stdin.lock() else {
            return false;
        };
        let Some(stdin) = guard.as_mut() else {
            return false;
        };
        let line = format!("{message}\n");
        stdin.write_all(line.as_bytes()).is_ok() && stdin.flush().is_ok()
    }

    fn redact(&self, text: &str) -> String {
        scrub_url_credentials(text)
    }

    fn append_stderr(&self, line: &str) {
        let redacted = self.redact(line);
        if let Ok(mut tail) = self.stderr_tail.lock() {
            if !tail.is_empty() {
                tail.push('\n');
            }
            tail.push_str(&redacted);
            if tail.len() > MAX_STDERR_BYTES {
                let cut = tail.len() - MAX_STDERR_BYTES;
                let boundary = tail
                    .char_indices()
                    .find(|(index, _)| *index >= cut)
                    .map_or(tail.len(), |(index, _)| index);
                *tail = tail[boundary..].to_string();
            }
        }
    }

    fn fail(&self, reason: &str) {
        if let Ok(mut failed) = self.failed.lock()
            && failed.is_none()
        {
            *failed = Some(reason.to_string());
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }

    fn failure(&self) -> Option<String> {
        self.failed.lock().ok().and_then(|value| value.clone())
    }

    fn note_protocol_error(&self, reason: &str) {
        let count = {
            let Ok(mut count) = self.protocol_errors.lock() else {
                return;
            };
            *count += 1;
            *count
        };
        if count >= MAX_PROTOCOL_ERRORS {
            self.fail(&format!("连续协议错误：{reason}"));
        }
    }

    fn settle(&self, request_id: &str, outcome: Result<Value, PluginErrorPayload>) {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id));
        if let Some(sender) = sender {
            let _ = sender.send(outcome);
        }
    }
}

pub struct PluginProcess {
    inner: Arc<Inner>,
    child: Mutex<Child>,
    reader: Mutex<Option<JoinHandle<()>>>,
    stderr_reader: Mutex<Option<JoinHandle<()>>>,
}

impl PluginProcess {
    pub fn spawn(
        entry: &Path,
        storage_directory: Option<&Path>,
        manifest: PluginManifest,
        node: &Path,
    ) -> Result<(Arc<Self>, ReadyInfo), ProcessError> {
        let mut command = Command::new(node);
        command
            .arg(entry)
            .env("NEXUS_PLUGIN_ID", &manifest.id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = storage_directory {
            command.env("NEXUS_PLUGIN_STORAGE_DIR", directory);
        }
        let mut child = command.spawn().map_err(|_| ProcessError::SpawnFailed)?;
        let stdin = child.stdin.take().ok_or(ProcessError::SpawnFailed)?;
        let stdout = child.stdout.take().ok_or(ProcessError::SpawnFailed)?;
        let stderr = child.stderr.take().ok_or(ProcessError::SpawnFailed)?;

        let inner = Arc::new(Inner {
            plugin_id: manifest.id.clone(),
            version: manifest.version.clone(),
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            ready: Mutex::new(None),
            failed: Mutex::new(None),
            stderr_tail: Mutex::new(String::new()),
            protocol_errors: Mutex::new(0),
        });

        let (ready_tx, ready_rx) = mpsc::channel::<Result<ReadyInfo, ProcessError>>();
        let reader_inner = Arc::clone(&inner);
        let reader = thread::spawn(move || {
            read_stdout(BufReader::new(stdout), reader_inner, ready_tx);
        });

        let stderr_inner = Arc::clone(&inner);
        let stderr_reader = thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = String::new();
            loop {
                buffer.clear();
                match reader.read_line(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => stderr_inner.append_stderr(buffer.trim_end()),
                }
            }
        });

        let process = Arc::new(Self {
            inner,
            child: Mutex::new(child),
            reader: Mutex::new(Some(reader)),
            stderr_reader: Mutex::new(Some(stderr_reader)),
        });

        match ready_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(Ok(ready)) => Ok((process, ready)),
            Ok(Err(error)) => {
                process.shutdown();
                Err(error)
            }
            Err(_) => {
                process.shutdown();
                Err(ProcessError::HandshakeTimeout)
            }
        }
    }

    pub fn ready(&self) -> Option<ReadyInfo> {
        self.inner.ready.lock().ok().and_then(|value| value.clone())
    }

    pub fn failure(&self) -> Option<String> {
        self.inner.failure()
    }

    pub fn stderr_tail(&self) -> String {
        self.inner
            .stderr_tail
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn is_alive(&self) -> bool {
        match self.child.lock() {
            Ok(mut child) => matches!(child.try_wait(), Ok(None)),
            Err(_) => false,
        }
    }

    pub fn call(
        &self,
        capability: Capability,
        method: &str,
        payload: Value,
        deadline: Duration,
    ) -> Result<Value, ProcessError> {
        if let Some(reason) = self.inner.failure() {
            return Err(ProcessError::Failed(reason));
        }
        let ready = self.ready().ok_or(ProcessError::NotReady)?;
        if !ready.methods.iter().any(|entry| entry == method) {
            return Err(ProcessError::Plugin(PluginErrorPayload::new(
                "INVALID_REQUEST",
                "插件未声明该方法",
                false,
            )));
        }
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        {
            let Ok(mut pending) = self.inner.pending.lock() else {
                return Err(ProcessError::Failed("插件状态不可用".into()));
            };
            pending.insert(request_id.clone(), sender);
        }
        let deadline_ms = u64::try_from(deadline.as_millis())
            .unwrap_or(MAX_DEADLINE_MS)
            .min(MAX_DEADLINE_MS);
        let request = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "capability": capability.as_str(),
            "method": method,
            "deadlineMs": deadline_ms,
            "payload": payload,
        });
        if !self.inner.write(&request) {
            if let Ok(mut pending) = self.inner.pending.lock() {
                pending.remove(&request_id);
            }
            return Err(ProcessError::Failed("插件进程不可写".into()));
        }
        match receiver.recv_timeout(deadline + DEADLINE_GRACE) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(payload)) => Err(ProcessError::Plugin(payload)),
            Err(RecvTimeoutError::Timeout) => {
                let _ = self.inner.write(&json!({
                    "type": "cancel",
                    "requestId": request_id,
                }));
                if let Ok(mut pending) = self.inner.pending.lock() {
                    pending.remove(&request_id);
                }
                Err(ProcessError::Timeout)
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(ProcessError::Failed("插件进程已退出".into()))
            }
        }
    }

    /// Cooperative shutdown: close stdin, wait, then terminate.
    pub fn stop(&self) {
        if let Ok(mut guard) = self.inner.stdin.lock() {
            guard.take();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let exited = match self.child.lock() {
                Ok(mut child) => !matches!(child.try_wait(), Ok(None)),
                Err(_) => true,
            };
            if exited || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        self.shutdown();
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.stdin.lock() {
            guard.take();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.inner.fail("插件已停止");
        if let Ok(mut reader) = self.reader.lock()
            && let Some(handle) = reader.take()
        {
            let _ = handle.join();
        }
        if let Ok(mut reader) = self.stderr_reader.lock()
            && let Some(handle) = reader.take()
        {
            let _ = handle.join();
        }
    }
}

fn read_stdout(
    mut reader: impl BufRead,
    inner: Arc<Inner>,
    ready_tx: Sender<Result<ReadyInfo, ProcessError>>,
) {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match read_bounded_line(&mut reader, &mut buffer) {
            Ok(LineOutcome::EndOfStream) => break,
            Ok(LineOutcome::Oversized) => {
                inner.note_protocol_error("消息超过大小上限");
                continue;
            }
            Ok(LineOutcome::Line) => {}
            Err(_) => break,
        }
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim_end_matches(['\n', '\r']);
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            inner.note_protocol_error("消息不是有效 JSON");
            continue;
        };
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "hello" => {
                let id = message.get("pluginId").and_then(Value::as_str);
                let version = message.get("version").and_then(Value::as_str);
                let api = message.get("apiVersion").and_then(Value::as_u64);
                if id != Some(inner.plugin_id.as_str())
                    || version != Some(inner.version.as_str())
                    || api != Some(u64::from(super::manifest::PLUGIN_API_VERSION))
                {
                    let _ = ready_tx.send(Err(ProcessError::ManifestMismatch));
                    inner.fail("清单与进程不一致");
                    break;
                }
                inner.write(&json!({
                    "type": "handshake",
                    "protocolVersion": PROTOCOL_VERSION,
                }));
            }
            "ready" => {
                let ready = ReadyInfo {
                    plugin_id: message
                        .get("pluginId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    version: message
                        .get("version")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    capabilities: string_list(&message, "capabilities"),
                    methods: string_list(&message, "methods"),
                    status: message.get("status").cloned().unwrap_or(Value::Null),
                };
                if ready.plugin_id != inner.plugin_id {
                    let _ = ready_tx.send(Err(ProcessError::ManifestMismatch));
                    inner.fail("握手标识不一致");
                    break;
                }
                if let Ok(mut slot) = inner.ready.lock() {
                    *slot = Some(ready.clone());
                }
                let _ = ready_tx.send(Ok(ready));
            }
            _ => {
                let Some(request_id) = message.get("requestId").and_then(Value::as_str) else {
                    inner.note_protocol_error("响应缺少 requestId");
                    continue;
                };
                let ok = message.get("ok").and_then(Value::as_bool).unwrap_or(false);
                if ok {
                    inner.settle(
                        request_id,
                        Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    );
                } else {
                    let error = message.get("error");
                    let payload = PluginErrorPayload {
                        code: error
                            .and_then(|value| value.get("code"))
                            .and_then(Value::as_str)
                            .unwrap_or("UNAVAILABLE")
                            .to_string(),
                        message: error
                            .and_then(|value| value.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("插件调用失败")
                            .to_string(),
                        retryable: error
                            .and_then(|value| value.get("retryable"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    };
                    inner.settle(request_id, Err(payload));
                }
            }
        }
    }
    inner.fail("插件进程已退出");
    let _ = ready_tx.send(Err(ProcessError::HandshakeFailed(
        "插件进程在握手前退出".into(),
    )));
}

enum LineOutcome {
    Line,
    Oversized,
    EndOfStream,
}

/// Reads one newline-terminated message without buffering past the limit.
/// An oversized message is drained and reported so the caller can count a
/// protocol error instead of allocating without bound.
fn read_bounded_line(
    reader: &mut impl BufRead,
    buffer: &mut Vec<u8>,
) -> std::io::Result<LineOutcome> {
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if buffer.is_empty() && !oversized {
                LineOutcome::EndOfStream
            } else if oversized {
                LineOutcome::Oversized
            } else {
                LineOutcome::Line
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if !oversized {
            if buffer.len() + take > MAX_LINE_BYTES {
                buffer.clear();
                oversized = true;
            } else {
                buffer.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take);
        if newline.is_some() {
            return Ok(if oversized {
                LineOutcome::Oversized
            } else {
                LineOutcome::Line
            });
        }
    }
}

fn string_list(message: &Value, field: &str) -> Vec<String> {
    message
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Replaces `scheme://user:secret@host` userinfo with `***`.
pub fn scrub_url_credentials(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("://") {
        let (head, tail) = rest.split_at(start + 3);
        result.push_str(head);
        if let Some(end) = tail.find('@') {
            let candidate = &tail[..end];
            if !candidate.contains('/') && !candidate.contains(' ') && candidate.contains(':') {
                result.push_str("***@");
                rest = &tail[end + 1..];
                continue;
            }
        }
        rest = tail;
    }
    result.push_str(rest);
    result
}
