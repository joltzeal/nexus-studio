// Adapted from ProxyShard/ShardBrowser src-tauri/src/gpu_caps.rs (MIT),
// commit 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
//
// Copyright (c) 2026 ShardBrowser
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Probe the pinned Chromium engine itself, whose ANGLE capabilities are the
// capabilities available to Profiles. The launcher's WebView uses another GPU API.

use crate::core::browser::provider::{BrowserError, BrowserResult};
use crate::core::shardbrowser_fingerprints;
use crate::core::shardbrowser_kernels::ShardKernelService;
use crate::core::window_service::WindowService;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::State;

const PROBE_DEADLINE: Duration = Duration::from_secs(30);
const DISK_FORMAT: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HostGlCaps {
    pub renderer: String,
    pub vendor: String,
    pub webgl1: Vec<String>,
    pub webgl2: Vec<String>,
    /// None means the adapter request failed or timed out. Some([]) means a
    /// completed request found no adapter or features.
    #[serde(default)]
    pub webgpu: Option<Vec<String>>,
    pub engine_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Compat {
    pub compatible: bool,
    pub missing_webgl1: Vec<String>,
    pub missing_webgl2: Vec<String>,
    #[serde(default)]
    pub missing_webgpu: Vec<String>,
    pub profile_renderer: String,
}

#[derive(Serialize, Deserialize)]
struct Disk {
    #[serde(default)]
    format: u32,
    #[serde(flatten)]
    caps: HostGlCaps,
}

fn probe_error(message: impl Into<String>) -> BrowserError {
    BrowserError::new("gpu_probe_failed", message)
}

fn interrupted() -> BrowserError {
    BrowserError::new("task_interrupted", "GPU 探测任务中断")
}

fn worth_keeping(caps: &HostGlCaps, engine: &str) -> bool {
    !caps.webgl1.is_empty() && caps.webgpu.is_some() && caps.engine_version == engine
}

fn cached_for(path: &Path, engine: &str) -> Option<HostGlCaps> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
        return None;
    }
    let disk: Disk = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (disk.format == DISK_FORMAT && worth_keeping(&disk.caps, engine)).then_some(disk.caps)
}

/// Official probe expression, including the secure-context WebGPU request and
/// the distinction between an absent adapter and an unanswered request.
const PROBE_JS: &str = r#"(async () => {
  const c1 = document.createElement('canvas').getContext('webgl');
  const c2 = document.createElement('canvas').getContext('webgl2');
  const name = (g) => {
    if (!g) return '';
    const d = g.getExtension('WEBGL_debug_renderer_info');
    return d ? String(g.getParameter(d.UNMASKED_RENDERER_WEBGL)) : '';
  };
  const vend = (g) => {
    if (!g) return '';
    const d = g.getExtension('WEBGL_debug_renderer_info');
    return d ? String(g.getParameter(d.UNMASKED_VENDOR_WEBGL)) : '';
  };
  // No API or no adapter is an empty list: a real answer. A request that
  // throws or hangs is null: not asked, so not recorded as "no WebGPU".
  let webgpu = [];
  try {
    if (navigator.gpu) {
      const late = new Promise((_, no) => setTimeout(() => no(new Error('late')), 5000));
      const a = await Promise.race([navigator.gpu.requestAdapter(), late]);
      if (a) webgpu = [...a.features].sort();
    }
  } catch (e) { webgpu = null; }
  return JSON.stringify({
    renderer: name(c2) || name(c1),
    vendor: vend(c2) || vend(c1),
    webgl1: c1 ? c1.getSupportedExtensions() : [],
    webgl2: c2 ? c2.getSupportedExtensions() : [],
    webgpu,
  });
})()"#;

/// Select only the throwaway page owned by this probe, and validate the CDP
/// destination before opening the independently direct WebSocket connection.
async fn page_socket(http: &reqwest::Client, port: u16, page_url: &str) -> Option<String> {
    let mut response = http
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > 1024 * 1024 {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    let targets: Value = serde_json::from_slice(&body).ok()?;
    let page = targets
        .as_array()?
        .iter()
        .find(|target| target["type"] == "page" && target["url"] == page_url)?;
    let socket = url::Url::parse(page["webSocketDebuggerUrl"].as_str()?).ok()?;
    (socket.scheme() == "ws"
        && socket.host_str() == Some("127.0.0.1")
        && socket.port() == Some(port)
        && socket.username().is_empty()
        && socket.password().is_none()
        && socket.query().is_none()
        && socket.fragment().is_none()
        && socket.path().starts_with("/devtools/page/"))
    .then(|| socket.into())
}

async fn evaluate_in_core(port: u16, page_url: &str) -> BrowserResult<String> {
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| probe_error("无法初始化 GPU 探测连接"))?;
    let ws_url = loop {
        if let Some(socket) = page_socket(&http, port, page_url).await {
            break socket;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    let (mut socket, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|_| probe_error("无法连接内核 GPU 探测端口"))?;
    let message = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": PROBE_JS,
            "returnByValue": true,
            "awaitPromise": true,
        },
    });
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            message.to_string().into(),
        ))
        .await
        .map_err(|_| probe_error("无法发送 GPU 探测请求"))?;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|_| probe_error("内核 GPU 探测连接中断"))?;
        let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
            continue;
        };
        let value: Value =
            serde_json::from_str(&text).map_err(|_| probe_error("内核返回无效 GPU 探测响应"))?;
        if value["id"] == 1 {
            return value["result"]["result"]["value"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| probe_error("内核未返回 GPU 探测结果"));
        }
    }
    Err(probe_error("内核关闭了 GPU 探测连接"))
}

#[derive(Default)]
struct Memo {
    cache_path: PathBuf,
    engine: String,
    answer: Option<BrowserResult<HostGlCaps>>,
}

/// Held through the full probe, so the two page commands share one launch.
/// A failed forced refresh retains the previous good answer.
async fn probe(
    binary: PathBuf,
    engine: String,
    cache_path: PathBuf,
    force: bool,
) -> BrowserResult<HostGlCaps> {
    static FLIGHT: OnceLock<tokio::sync::Mutex<Memo>> = OnceLock::new();
    let mut memo = FLIGHT.get_or_init(Default::default).lock().await;
    let ours = memo.engine == engine && memo.cache_path == cache_path;
    if !force && ours {
        if let Some(answer) = &memo.answer {
            return answer.clone();
        }
    }
    if !force {
        if let Some(caps) = cached_for(&cache_path, &engine) {
            *memo = Memo {
                cache_path,
                engine,
                answer: Some(Ok(caps.clone())),
            };
            return Ok(caps);
        }
    }
    let answer = ask_engine(&binary, &engine, &cache_path).await;
    let had_good = ours && matches!(memo.answer, Some(Ok(_)));
    if answer.is_ok() || !had_good {
        *memo = Memo {
            cache_path,
            engine,
            answer: Some(answer.clone()),
        };
    }
    answer
}

async fn ask_engine(binary: &Path, engine: &str, cache_path: &Path) -> BrowserResult<HostGlCaps> {
    let raw = run_probe(binary).await?;
    let caps = parse_answer(&raw, engine)?;
    if worth_keeping(&caps, engine) {
        // The cache is disposable. An unwritable cache still permits this answer.
        let disk = Disk {
            format: DISK_FORMAT,
            caps: caps.clone(),
        };
        if let (Ok(body), Some(parent)) = (serde_json::to_vec_pretty(&disk), cache_path.parent()) {
            if let Ok(mut temporary) = tempfile::NamedTempFile::new_in(parent) {
                use std::io::Write;
                if temporary.write_all(&body).is_ok() && temporary.as_file().sync_all().is_ok() {
                    let _ = temporary.persist(cache_path);
                }
            }
        }
    }
    Ok(caps)
}

fn parse_answer(raw: &str, engine: &str) -> BrowserResult<HostGlCaps> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| probe_error("内核返回无效 GPU 能力数据"))?;
    let list = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let caps = HostGlCaps {
        renderer: parsed["renderer"].as_str().unwrap_or_default().to_owned(),
        vendor: parsed["vendor"].as_str().unwrap_or_default().to_owned(),
        webgl1: list(&parsed["webgl1"]),
        webgl2: list(&parsed["webgl2"]),
        webgpu: parsed["webgpu"].is_array().then(|| list(&parsed["webgpu"])),
        engine_version: engine.to_owned(),
    };
    if caps.webgl1.is_empty() {
        return Err(probe_error("内核未能获取 WebGL 能力"));
    }
    Ok(caps)
}

async fn run_probe(binary: &Path) -> BrowserResult<String> {
    // An exclusively created random directory prevents stale-PID or concurrent
    // probes from deleting one another's files.
    let scratch = tempfile::Builder::new()
        .prefix("raccoon-shardbrowser-gpu-")
        .tempdir()
        .map_err(|_| probe_error("无法创建 GPU 探测临时目录"))?;
    let answer = run_engine(binary, scratch.path()).await;
    remove_scratch(scratch.path()).await;
    answer
}

async fn run_engine(binary: &Path, scratch: &Path) -> BrowserResult<String> {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|_| probe_error("无法分配 GPU 探测端口"))?;
        listener
            .local_addr()
            .map_err(|_| probe_error("无法读取 GPU 探测端口"))?
            .port()
    };
    // A file URL is a trustworthy secure context for WebGPU. about:blank can
    // hide navigator.gpu and incorrectly cache the absence of an adapter.
    let page = scratch.join("probe.html");
    std::fs::write(&page, "<!doctype html><title>gl</title>")
        .map_err(|_| probe_error("无法写入 GPU 探测页面"))?;
    let page_url = url::Url::from_file_path(&page)
        .map_err(|_| probe_error("GPU 探测页面路径无效"))?
        .to_string();
    let mut command = tokio::process::Command::new(binary);
    command
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--remote-debugging-address=127.0.0.1")
        .arg(format!("--user-data-dir={}", scratch.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        // Match the official off-screen probe. Headless rendering can expose
        // software-rasterizer capabilities instead of the Profile's GPU.
        .arg("--window-position=-32000,-32000")
        .arg("--window-size=200,200")
        .arg(&page_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|_| probe_error("无法启动内核进行 GPU 探测"))?;
    let pid = child.id();
    let answer = tokio::time::timeout(PROBE_DEADLINE, async {
        tokio::select! {
            result = evaluate_in_core(port, &page_url) => result,
            status = child.wait() => Err(match status {
                Ok(status) => probe_error(format!("GPU 探测内核提前退出（{status}）")),
                Err(_) => probe_error("GPU 探测内核退出状态不可读"),
            }),
        }
    })
    .await
    .unwrap_or_else(|_| Err(probe_error("GPU 探测超过 30 秒")));
    kill_tree(&mut child, pid).await;
    answer
}

async fn kill_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The child leads a new process group. Signal its helpers as well.
        let _ = tokio::process::Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(windows)]
    if let (Some(pid), Some(_)) = (pid, child.id()) {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.kill().await;
}

async fn remove_scratch(dir: &Path) {
    // Windows may retain file handles briefly after terminating the tree.
    for _ in 0..20 {
        if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Report only declared features the host cannot provide. Extra host features
/// can be hidden by the engine without contradicting the selected fingerprint.
pub fn compat(payload: &Value, caps: &HostGlCaps) -> Compat {
    let host1: BTreeSet<&str> = caps.webgl1.iter().map(String::as_str).collect();
    let host2: BTreeSet<&str> = caps.webgl2.iter().map(String::as_str).collect();
    let declared = |key: &str| -> Vec<String> {
        payload["webgl"][key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let missing_webgl1: Vec<String> = declared("extensions")
        .into_iter()
        .filter(|e| !host1.contains(e.as_str()))
        .collect();
    let missing_webgl2: Vec<String> = declared("extensions_v2")
        .into_iter()
        .filter(|e| !host2.contains(e.as_str()))
        .collect();
    let missing_webgpu: Vec<String> = match caps.webgpu.as_ref() {
        None => Vec::new(),
        Some(host) => {
            let host_gpu: BTreeSet<&str> = host.iter().map(String::as_str).collect();
            payload["webgpu"]["features"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .filter(|f| !host_gpu.contains(f))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        }
    };
    Compat {
        compatible: missing_webgl1.is_empty()
            && missing_webgl2.is_empty()
            && missing_webgpu.is_empty(),
        missing_webgl1,
        missing_webgl2,
        missing_webgpu,
        profile_renderer: payload["webgl"]["renderer"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    }
}

async fn caps_for_connection(
    state: Arc<WindowService>,
    service: Arc<ShardKernelService>,
    connection_id: String,
    force: bool,
) -> BrowserResult<HostGlCaps> {
    let (binary, engine, cache_path) = tauri::async_runtime::spawn_blocking(
        move || -> BrowserResult<(PathBuf, String, PathBuf)> {
            shardbrowser_fingerprints::connection(&state, &connection_id)?;
            let installed = service
                .installed()
                .map_err(|_| probe_error("无法读取已安装的 ShardBrowser 内核"))?;
            let selected = installed
                .first()
                .ok_or_else(|| BrowserError::new("unavailable", "请先安装 ShardBrowser 内核"))?;
            let sdk = service
                .pinned(&selected.version)
                .map_err(|_| probe_error("固定 ShardBrowser 内核不可用"))?;
            Ok((
                sdk.runtime.binary_path(),
                selected.version.clone(),
                sdk.runtime.root.join("host-gl-caps.json"),
            ))
        },
    )
    .await
    .map_err(|_| interrupted())??;
    // Own the entire single-flight operation in a task. Dropping an IPC caller
    // keeps the deadline, process-tree cleanup and memo update running.
    tokio::spawn(probe(binary, engine, cache_path, force))
        .await
        .map_err(|_| interrupted())?
}

#[tauri::command]
pub async fn shardbrowser_gpu_caps(
    state: State<'_, Arc<WindowService>>,
    service: State<'_, Arc<ShardKernelService>>,
    connection_id: String,
    force: bool,
) -> BrowserResult<HostGlCaps> {
    caps_for_connection(
        Arc::clone(&state),
        Arc::clone(&service),
        connection_id,
        force,
    )
    .await
}

#[tauri::command]
pub async fn shardbrowser_gpu_compat(
    state: State<'_, Arc<WindowService>>,
    service: State<'_, Arc<ShardKernelService>>,
    connection_id: String,
) -> BrowserResult<BTreeMap<String, Compat>> {
    let state = Arc::clone(&state);
    // Preserve scope and library errors, while an unavailable GPU probe has the
    // official empty-map meaning of unknown compatibility.
    let entries = {
        let state = Arc::clone(&state);
        let connection_id = connection_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            shardbrowser_fingerprints::list(&state, &connection_id)
        })
        .await
        .map_err(|_| interrupted())??
    };
    let caps = match caps_for_connection(state, Arc::clone(&service), connection_id, false).await {
        Ok(caps) => caps,
        Err(_) => return Ok(BTreeMap::new()),
    };
    Ok(entries
        .into_iter()
        .map(|entry| (entry.id, compat(&entry.payload, &caps)))
        .collect())
}
