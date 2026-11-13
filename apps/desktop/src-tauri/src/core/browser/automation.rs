use super::{BrowserError, BrowserResult};
use crate::core::runtime_paths::RuntimePaths;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use url::Url;

const MAX_FRAME: usize = 256 * 1024;
const PREFIX: &[u8] = b"NEXUS_AUTOMATION ";

pub enum AutomationSession {
    Managed(Arc<AutomationChannel>),
    Cdp(CdpEndpoint),
}

/// Only provider API responses may construct a CDP endpoint.
pub struct CdpEndpoint(String);

impl CdpEndpoint {
    pub fn websocket(raw: &str) -> BrowserResult<Self> {
        let invalid = || BrowserError::new("invalid_config", "Invalid local browser endpoint");
        if raw.len() > 2048
            || raw
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
        {
            return Err(invalid());
        }
        let mut url = Url::parse(raw).map_err(|_| invalid())?;
        if url.scheme() != "ws"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port().is_none_or(|port| port == 0)
        {
            return Err(invalid());
        }
        let host = url.host_str().ok_or_else(invalid)?;
        if host == "localhost" {
            url.set_host(Some("127.0.0.1")).map_err(|_| invalid())?;
        } else {
            let ip: IpAddr = host
                .trim_matches(['[', ']'])
                .parse()
                .map_err(|_| invalid())?;
            if !ip.is_loopback() {
                return Err(invalid());
            }
        }
        let id = url
            .path()
            .strip_prefix("/devtools/browser/")
            .ok_or_else(invalid)?;
        if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err(invalid());
        }
        Ok(Self(url.into()))
    }

    pub fn from_port(port: u16) -> BrowserResult<Self> {
        if port == 0 {
            return Err(BrowserError::new(
                "invalid_config",
                "Invalid local browser port",
            ));
        }
        let failure = || BrowserError::new("unavailable", "Local browser endpoint is unavailable");
        // The debug discovery request is local and independent of all application/window proxies.
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| failure())?;
        let response = client
            .get(format!("http://127.0.0.1:{port}/json/version"))
            .send()
            .map_err(|_| failure())?;
        if !response.status().is_success() {
            return Err(failure());
        }
        let mut bytes = Vec::new();
        response
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure())?;
        if bytes.len() > 16 * 1024 {
            return Err(failure());
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| failure())?;
        let endpoint = Self::websocket(body["webSocketDebuggerUrl"].as_str().ok_or_else(failure)?)?;
        if Url::parse(&endpoint.0).map_err(|_| failure())?.port() != Some(port) {
            return Err(failure());
        }
        Ok(endpoint)
    }
}

pub fn validate_request(request: &Value) -> BrowserResult<Duration> {
    let invalid = || BrowserError::new("invalid_config", "Invalid browser tool request");
    let body = request.as_object().ok_or_else(invalid)?;
    if body
        .keys()
        .any(|key| !["operation", "origin", "input", "timeoutMs"].contains(&key.as_str()))
        || !request["input"].is_object()
        || !matches!(
            request["operation"].as_str(),
            Some(
                "navigate"
                    | "snapshot"
                    | "click"
                    | "submit"
                    | "fill"
                    | "select"
                    | "upload"
                    | "readFields"
                    | "request"
            )
        )
        || serde_json::to_vec(request).map_err(|_| invalid())?.len() > MAX_FRAME - 512
    {
        return Err(invalid());
    }
    let raw = request["origin"].as_str().ok_or_else(invalid)?;
    let url = Url::parse(raw).map_err(|_| invalid())?;
    let host = url
        .host_str()
        .unwrap_or("")
        .strip_prefix("www.")
        .unwrap_or(url.host_str().unwrap_or(""));
    if raw != url.origin().ascii_serialization()
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(
            host,
            "vinted.com"
                | "vinted.co.uk"
                | "vinted.fr"
                | "vinted.de"
                | "vinted.nl"
                | "vinted.be"
                | "vinted.es"
                | "vinted.it"
                | "vinted.pt"
                | "vinted.pl"
                | "vinted.cz"
                | "vinted.sk"
                | "vinted.lt"
                | "vinted.at"
                | "vinted.lu"
                | "vinted.se"
                | "vinted.dk"
                | "vinted.fi"
                | "vinted.ro"
                | "vinted.hu"
                | "vinted.hr"
                | "vinted.gr"
                | "vinted.ie"
                | "vinted.ee"
                | "vinted.lv"
                | "vinted.si"
        )
    {
        return Err(invalid());
    }
    if request["operation"] == "upload" {
        let files = request["input"]["files"].as_array().ok_or_else(invalid)?;
        if files.is_empty()
            || files.len() > 20
            || files.iter().any(|file| {
                file.as_str().is_none_or(|path| {
                    path.len() > 2048
                        || !Path::new(path).is_absolute()
                        || path.chars().any(char::is_control)
                })
            })
        {
            return Err(invalid());
        }
    }
    if request["operation"] == "submit" {
        let raw = request["input"]["operationId"]
            .as_str()
            .ok_or_else(invalid)?;
        let id = uuid::Uuid::parse_str(raw).map_err(|_| invalid())?;
        if raw.len() != 36 || id.is_nil() || id.hyphenated().to_string() != raw {
            return Err(invalid());
        }
    }
    let timeout = match body.get("timeoutMs") {
        None => 30_000,
        Some(value) => value
            .as_u64()
            .filter(|n| (1..=120_000).contains(n))
            .ok_or_else(invalid)?,
    };
    Ok(Duration::from_millis(timeout))
}

struct Pending {
    id: String,
    reply: Option<mpsc::SyncSender<BrowserResult<Value>>>,
}
#[derive(Default)]
struct ChannelState {
    pending: Option<Pending>,
    disconnected: bool,
}
#[derive(Default)]
pub struct AutomationChannel {
    writer: Mutex<Option<ChildStdin>>,
    state: Mutex<ChannelState>,
}

fn unavailable() -> BrowserError {
    BrowserError::new(
        "automation_disconnected",
        "Browser automation disconnected; reconcile the window",
    )
}
fn pending() -> BrowserError {
    BrowserError::new("operation_pending", "Browser automation is still settling")
}

impl AutomationChannel {
    pub fn set_writer(&self, writer: ChildStdin) -> BrowserResult<()> {
        *self.writer.lock().map_err(|_| unavailable())? = Some(writer);
        Ok(())
    }

    pub fn idle(&self) -> BrowserResult<()> {
        if self
            .state
            .lock()
            .map_err(|_| unavailable())?
            .pending
            .is_some()
        {
            return Err(pending());
        }
        Ok(())
    }

    pub fn execute(self: &Arc<Self>, request: Value) -> BrowserResult<Value> {
        let timeout = validate_request(&request)?;
        self.call(request, timeout)
    }

    pub fn release(self: &Arc<Self>) -> BrowserResult<()> {
        self.idle()?;
        if self.state.lock().map_err(|_| unavailable())?.disconnected {
            return Ok(());
        }
        self.call(json!({"control":"release"}), Duration::from_secs(5))?;
        Ok(())
    }

    fn call(self: &Arc<Self>, request: Value, timeout: Duration) -> BrowserResult<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            if state.pending.is_some() {
                return Err(pending());
            }
            if state.disconnected {
                return Err(unavailable());
            }
            state.pending = Some(Pending {
                id: id.clone(),
                reply: Some(sender),
            });
        }
        let mut envelope = request;
        envelope["requestId"] = json!(id);
        let mut bytes = serde_json::to_vec(&envelope).map_err(|_| unavailable())?;
        bytes.push(b'\n');
        let channel = self.clone();
        std::thread::spawn(move || {
            let result = (|| {
                let mut writer = channel.writer.lock().map_err(|_| ())?;
                writer.as_mut().ok_or(())?.write_all(&bytes).map_err(|_| ())
            })();
            if result.is_err() {
                channel.disconnect();
            }
        });
        receiver
            .recv_timeout(timeout + Duration::from_secs(2))
            .unwrap_or_else(|_| {
                Err(BrowserError::new(
                    "automation_timeout",
                    "Browser operation timed out; do not replay",
                ))
            })
    }

    pub fn stop(&self) {
        if let Ok(mut writer) = self.writer.lock()
            && let Some(mut stdin) = writer.take()
        {
            let _ = stdin.write_all(b"stop\n");
        }
    }

    fn disconnect(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.disconnected = true;
            if let Some(sender) = state
                .pending
                .as_mut()
                .and_then(|pending| pending.reply.take())
            {
                let _ = sender.try_send(Err(unavailable()));
            }
            // A missing final receipt does not prove the external action settled.
        }
    }

    fn response(&self, value: Value) {
        let valid = value.as_object().is_some_and(|body| {
            body.len() == 3
                && body.get("requestId").is_some_and(Value::is_string)
                && match body.get("ok").and_then(Value::as_bool) {
                    Some(true) => body.contains_key("result"),
                    Some(false) => {
                        body.get("error")
                            .and_then(Value::as_object)
                            .is_some_and(|error| {
                                error.len() == 2
                                    && error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .is_some_and(|message| message.len() <= 128)
                                    && error.get("code").and_then(Value::as_str).is_some_and(
                                        |code| {
                                            code.starts_with("AUTOMATION_")
                                                && code.len() <= 64
                                                && code.bytes().all(|byte| {
                                                    byte.is_ascii_uppercase() || byte == b'_'
                                                })
                                        },
                                    )
                            })
                    }
                    None => false,
                }
        });
        if !valid {
            self.disconnect();
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let Some(waiting) = state.pending.as_mut() else {
            return;
        };
        if value["requestId"].as_str() != Some(waiting.id.as_str()) {
            return;
        }
        let code = value["error"]["code"]
            .as_str()
            .unwrap_or("AUTOMATION_FAILED");
        let result = if value["ok"] == true && value.get("result").is_some() {
            Ok(value["result"].clone())
        } else {
            let code = match code {
                "AUTOMATION_TIMEOUT" => "automation_timeout",
                "AUTOMATION_BUSY" => "operation_pending",
                "AUTOMATION_ORIGIN_MISMATCH" | "AUTOMATION_ORIGIN" | "AUTOMATION_TARGET_SCOPE" => {
                    "scope_mismatch"
                }
                "AUTOMATION_SETTLED" => "automation_settled",
                "AUTOMATION_SUBMIT_REQUIRED" => "submit_required",
                "AUTOMATION_SUBMIT_REPLAY" => "operation_conflict",
                _ => "automation_failed",
            };
            Err(BrowserError::new(
                code,
                "Browser tool failed; reconcile before retrying writes",
            ))
        };
        if let Some(sender) = waiting.reply.take() {
            let _ = sender.try_send(result);
        }
        if code != "AUTOMATION_TIMEOUT" {
            state.pending = None;
        }
    }
}

pub fn stdout_pump(
    mut stdout: impl Read + Send + 'static,
    channel: Arc<AutomationChannel>,
) -> mpsc::Receiver<bool> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        let mut line = Vec::new();
        let mut overlong = false;
        let mut notified = false;
        loop {
            let length = match stdout.read(&mut buffer) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(0) | Err(_) => break,
                Ok(length) => length,
            };
            for byte in &buffer[..length] {
                if *byte == b'\n' {
                    if !overlong {
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        if !notified && line == b"NEXUS_READY" {
                            let _ = sender.try_send(true);
                            notified = true;
                        } else if let Some(json) = line.strip_prefix(PREFIX) {
                            match serde_json::from_slice(json) {
                                Ok(value) => channel.response(value),
                                Err(_) => channel.disconnect(),
                            }
                        }
                    } else {
                        channel.disconnect();
                    }
                    line.clear();
                    overlong = false;
                } else if line.len() < MAX_FRAME {
                    line.push(*byte);
                } else {
                    overlong = true;
                }
            }
        }
        if !notified {
            let _ = sender.try_send(false);
        }
        channel.disconnect();
    });
    receiver
}

pub struct CdpActor {
    child: Mutex<Child>,
    pub channel: Arc<AutomationChannel>,
}

impl CdpActor {
    pub fn attach(runtime: &RuntimePaths, endpoint: CdpEndpoint) -> BrowserResult<Self> {
        let child = Command::new(&runtime.node)
            .arg(&runtime.browser_script)
            .arg("automation-cdp")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .env_remove("all_proxy")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| unavailable())?;
        let channel = Arc::new(AutomationChannel::default());
        let actor = Self {
            child: Mutex::new(child),
            channel: channel.clone(),
        };
        let ready = {
            let mut process = actor.child.lock().map_err(|_| unavailable())?;
            let mut stdin = process.stdin.take().ok_or_else(unavailable)?;
            let config = format!("{}\n", json!({"endpoint":endpoint.0}));
            stdin
                .write_all(config.as_bytes())
                .map_err(|_| unavailable())?;
            channel.set_writer(stdin)?;
            let stdout = process.stdout.take().ok_or_else(unavailable)?;
            let ready = stdout_pump(stdout, channel.clone());
            if let Some(mut stderr) = process.stderr.take() {
                std::thread::spawn(move || {
                    let _ = std::io::copy(&mut stderr, &mut std::io::sink());
                });
            }
            ready
        };
        if !matches!(ready.recv_timeout(Duration::from_secs(35)), Ok(true)) {
            return Err(unavailable());
        }
        Ok(actor)
    }
}

impl Drop for CdpActor {
    fn drop(&mut self) {
        self.channel.stop();
        if let Ok(mut child) = self.child.lock() {
            // Only the attached Node actor is terminated, never the vendor browser.
            if !matches!(child.try_wait(), Ok(Some(_))) && child.kill().is_ok() {
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn endpoints_reject_remote_hosts_credentials_and_non_browser_targets() {
        for endpoint in [
            "ws://remote.invalid:9000/devtools/browser/a",
            "ws://127.0.0.1:9000/devtools/page/a",
            "ws://user:secret@127.0.0.1:9000/devtools/browser/a",
            "ws://127.0.0.1:9000/devtools/browser/a?key=x",
            "http://127.0.0.1:9000",
        ] {
            assert!(CdpEndpoint::websocket(endpoint).is_err());
        }
        assert_eq!(
            CdpEndpoint::websocket("ws://localhost:9000/devtools/browser/a")
                .unwrap()
                .0,
            "ws://127.0.0.1:9000/devtools/browser/a"
        );
    }

    #[test]
    fn late_receipts_release_only_the_matching_request_after_timeout() {
        let channel = AutomationChannel::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        channel.state.lock().unwrap().pending = Some(Pending {
            id: "one".into(),
            reply: Some(sender),
        });
        channel.response(json!({"requestId":"other","ok":true,"result":{}}));
        assert!(channel.idle().is_err());
        channel
            .response(json!({"requestId":"one","ok":false,"error":{"code":"AUTOMATION_TIMEOUT","message":"AUTOMATION_TIMEOUT"}}));
        assert_eq!(
            receiver.recv().unwrap().unwrap_err().code,
            "automation_timeout"
        );
        assert!(channel.idle().is_err());
        channel
            .response(json!({"requestId":"one","ok":false,"error":{"code":"AUTOMATION_SETTLED","message":"AUTOMATION_SETTLED"}}));
        assert!(channel.idle().is_ok());
    }

    #[test]
    fn malformed_matching_reply_preserves_quarantine() {
        let channel = AutomationChannel::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        channel.state.lock().unwrap().pending = Some(Pending {
            id: "one".into(),
            reply: Some(sender),
        });
        channel.response(json!({"requestId":"one","ok":true}));
        assert_eq!(
            receiver.recv().unwrap().unwrap_err().code,
            "automation_disconnected"
        );
        assert!(channel.idle().is_err());
    }

    #[test]
    fn bit_debug_discovery_reads_only_the_local_version_and_checks_its_returned_port() {
        for mismatch in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 4096];
                let length = socket.read(&mut buffer).unwrap();
                assert!(
                    String::from_utf8_lossy(&buffer[..length]).starts_with("GET /json/version ")
                );
                let returned_port = if mismatch {
                    if port == 65535 { port - 1 } else { port + 1 }
                } else {
                    port
                };
                let body = json!({"webSocketDebuggerUrl":format!("ws://127.0.0.1:{returned_port}/devtools/browser/fixture")}).to_string();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            assert_eq!(CdpEndpoint::from_port(port).is_ok(), !mismatch);
            worker.join().unwrap();
        }
    }

    #[test]
    fn pump_preserves_readiness_and_bounds_lines_and_disconnects_without_releasing_pending() {
        let channel = Arc::new(AutomationChannel::default());
        let bytes = [
            b"NEXUS_READY\n".as_slice(),
            &vec![b'x'; MAX_FRAME + 1],
            b"\n",
        ]
        .concat();
        assert!(
            stdout_pump(Cursor::new(bytes), channel.clone())
                .recv()
                .unwrap()
        );
        let (sender, _) = mpsc::sync_channel(1);
        channel.state.lock().unwrap().pending = Some(Pending {
            id: "one".into(),
            reply: Some(sender),
        });
        channel.disconnect();
        assert!(channel.idle().is_err());
    }
}
