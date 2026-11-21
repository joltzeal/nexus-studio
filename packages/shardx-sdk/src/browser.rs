//! Browser launch + lifecycle. Spawns the ShardX engine with the same
//! spoofing flags the desktop launcher uses, plus pre-launch auto-resolve,
//! screen strategy, and UDP probe.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use crate::auto_resolve::{has_auto_fields, resolve_auto_fields};
use crate::geo::{geo_check_via, GeoInfo};
use crate::profile::{ensure_profile_stopped, user_data_dir, Profile, ProfileLock};
use crate::proxy::{parse_proxy, probe_udp, proxy_to_arg, ParsedProxy, ProxyScheme};
use crate::runtime::Runtime;
use crate::screen::{apply_screen_strategy, default_screen_mode_for, ScreenStrategy};

/// Deterministic non-zero 32-bit FNV-1a of `<id>::<slot>`.
fn noise_seed(id: &str, slot: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in format!("{id}::{slot}").bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    if h == 0 {
        1
    } else {
        h
    }
}

/// Add the default noise block when absent, then fill any seed-0 vector with a
/// stable per-profile value — without it every profile shares seed 0 and gets
/// an identical canvas/audio/WebGL fingerprint.
fn apply_noise_seeds(config: &mut serde_json::Value, id: &str) {
    let Some(obj) = config.as_object_mut() else {
        return;
    };
    obj.entry("noise").or_insert_with(|| {
        serde_json::json!({
            "canvas":       { "enabled": false, "seed": 0 },
            "webgl":        { "enabled": false, "seed": 0, "intensity": 0 },
            "audio":        { "enabled": false, "seed": 0 },
            "client_rects": { "enabled": false, "seed": 0, "max_offset": 0 },
            "sensors":      { "enabled": false, "seed": 0 },
            "fonts":        { "enabled": false, "seed": 0 }
        })
    });
    if let Some(noise) = obj.get_mut("noise").and_then(|n| n.as_object_mut()) {
        for (slot, block) in noise.iter_mut() {
            if let Some(b) = block.as_object_mut() {
                let needs = b
                    .get("seed")
                    .and_then(|v| v.as_u64())
                    .map(|n| n == 0)
                    .unwrap_or(true);
                if needs {
                    b.insert("seed".into(), serde_json::Value::from(noise_seed(id, slot)));
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum WebRtcMode {
    #[default]
    Auto,
    Block,
    TcpOnly,
}

#[derive(Default)]
pub struct LaunchOptions {
    pub proxy: Option<String>,
    /// HTTP(S) page opened as a positional argument after validated switches.
    pub start_url: Option<String>,
    pub cdp: bool,
    pub headless: bool,
    pub extra_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub webrtc: Option<WebRtcMode>,
    pub webrtc_public_ip: Option<String>,
    /// Override the UDP-probe auto-decision for QUIC.
    pub quic: Option<bool>,
    /// Defaults to `CapToHost` on macOS, `UseHost` on Win/Linux.
    pub screen_mode: Option<ScreenStrategy>,
    pub probe_timeout_ms: Option<u64>,
    /// Custom user-data-dir root. Defaults to `<profiles_root>/<id>/`.
    pub user_data_dir: Option<PathBuf>,
    /// When picking a random profile, filter by `navigator.platform` substring.
    pub platform: Option<String>,
    /// Re-pick hardware_concurrency / device_memory / platform_version.
    pub randomize: bool,
    /// Claim the protected-video support a phone has. Mobile profiles only.
    pub android_media: bool,
    /// No profile name in the address bar and the window title.
    pub hide_profile_name: bool,
    /// Managed hosts fail closed when a proxy cannot resolve identity fields.
    pub require_proxy_geo: bool,
    /// Unpacked extension roots selected from the managed ShardBrowser library.
    pub extensions: Vec<PathBuf>,
    /// The managed extension library root used by patched ShardBrowser engines.
    pub extension_library: Option<PathBuf>,
}

/// A running engine process + the decisions made at launch.
pub struct BrowserSession {
    pub pid: u32,
    pub user_data_dir: PathBuf,
    pub cdp_url: Option<String>,
    pub proxy_udp_ms: Option<u128>,
    pub quic_enabled: bool,
    pub webrtc_mode: WebRtcMode,
    pub geo: Option<GeoInfo>,
    child: Option<Child>,
    stopped: bool,
    _profile_lock: Option<ProfileLock>,
}

impl BrowserSession {
    /// Reap an exited child so a zombie cannot be mistaken for a live profile.
    pub fn exited(&mut self) -> std::io::Result<Option<bool>> {
        match self.child.as_mut() {
            Some(child) => Ok(Some(child.try_wait()?.is_some())),
            None => Ok(None),
        }
    }

    /// Leave a managed engine alive when its UI host exits. The next host
    /// verifies its PID and CDP identity before taking control again.
    pub fn detach(&mut self) {
        if let Some(mut child) = self.child.take() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                self._profile_lock.take();
                self.stopped = true;
                return;
            }
            let lock = self._profile_lock.take();
            std::thread::spawn(move || {
                let _lock = lock;
                let _ = child.wait();
            });
        }
        self.stopped = true;
    }
    fn clear_runtime_markers(&self) -> Result<()> {
        let lock_path = self.user_data_dir.join("SingletonLock");
        #[cfg(unix)]
        match std::fs::symlink_metadata(&lock_path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = std::fs::read_link(&lock_path)?;
                if !target
                    .to_string_lossy()
                    .ends_with(&format!("-{}", self.pid))
                {
                    anyhow::bail!("singleton lock belongs to another process");
                }
                std::fs::remove_file(&lock_path)?;
            }
            Ok(_) => anyhow::bail!("unexpected singleton lock"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        #[cfg(windows)]
        if lock_path.try_exists()? {
            anyhow::bail!("unresolved singleton lock");
        }
        match std::fs::remove_file(self.user_data_dir.join("DevToolsActivePort")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Close the engine. Idempotent. A session with CDP is closed the way the launcher
    /// closes it, with `Browser.close`; then SIGTERM on Unix; a kill is the last resort.
    pub async fn stop(&mut self) -> Result<()> {
        if self.stopped {
            if self._profile_lock.is_some() {
                self.clear_runtime_markers()?;
                self._profile_lock.take();
            }
            return Ok(());
        }
        let Some(child) = self.child.as_mut() else {
            anyhow::bail!("session no longer owns its child");
        };
        let mut gone = child.try_wait()?.is_some();
        if !gone {
            if let Some(ws) = &self.cdp_url {
                gone =
                    close_over_cdp(ws).await && exits_within(child, Duration::from_secs(5)).await;
            }
        }
        #[cfg(unix)]
        if !gone {
            // SAFETY: a plain signal to our own child's pid.
            unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
            gone = exits_within(child, Duration::from_secs(5)).await;
        }
        if !gone {
            child.kill()?;
            if !exits_within(child, Duration::from_secs(5)).await {
                anyhow::bail!("engine exit could not be confirmed");
            }
        }
        child.wait()?;
        self.child.take();
        self.stopped = true;
        self.clear_runtime_markers()?;
        self._profile_lock.take();
        Ok(())
    }
}

/// Asks the browser to quit with CDP `Browser.close`: it writes out what pages saved and
/// exits, where a kill can lose the last of it (#130). One masked text frame over a plain
/// socket. True when the request went out.
pub(crate) async fn close_over_cdp(ws_url: &str) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Some(rest) = ws_url.strip_prefix("ws://") else {
        return false;
    };
    let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let talk = async {
        let mut sock = tokio::net::TcpStream::connect(host).await.ok()?;
        let hello = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: c2hhcmR4LXNkay1jbG9zZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        sock.write_all(hello.as_bytes()).await.ok()?;
        let mut buf = [0u8; 1024];
        let n = sock.read(&mut buf).await.ok()?;
        if !buf[..n].starts_with(b"HTTP/1.1 101") {
            return None;
        }
        let payload = br#"{"id":1,"method":"Browser.close"}"#;
        let mask = [0x5a, 0x17, 0xc3, 0x8e];
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        sock.write_all(&frame).await.ok()
    };
    matches!(
        tokio::time::timeout(Duration::from_secs(2), talk).await,
        Ok(Some(()))
    )
}

/// Whether `child` exits within `limit`, polled rather than waited on, so it is still ours.
async fn exits_within(child: &mut Child, limit: Duration) -> bool {
    let until = std::time::Instant::now() + limit;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if std::time::Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

impl Drop for BrowserSession {
    fn drop(&mut self) {
        if !self.stopped {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                // Keep the lock until the process has exited, even outside a Tokio runtime.
                let lock = self._profile_lock.take();
                std::thread::spawn(move || {
                    let _lock = lock;
                    let _ = child.wait();
                });
            }
        }
    }
}

pub struct Browser {
    runtime: Arc<Runtime>,
}

impl Browser {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self { runtime }
    }

    pub async fn launch(&self, profile: Profile, opts: LaunchOptions) -> Result<BrowserSession> {
        self.runtime.install(false).await?;
        self.launch_inner(profile, opts, false).await
    }

    pub async fn launch_pinned(
        &self,
        profile: Profile,
        opts: LaunchOptions,
    ) -> Result<BrowserSession> {
        if opts.randomize {
            anyhow::bail!("a pinned identity cannot be randomized at launch");
        }
        for arg in &opts.extra_args {
            let name = arg.split('=').next().unwrap_or(arg);
            if !arg.starts_with("--")
                || [
                    "--user-data-dir",
                    "--fingerprint-profile",
                    "--proxy-server",
                    "--proxy-bypass-list",
                    "--no-proxy-server",
                    "--proxy-pac-url",
                    "--proxy-auto-detect",
                    "--remote-debugging-port",
                    "--remote-debugging-address",
                    "--remote-debugging-pipe",
                    "--load-extension",
                    "--disable-extensions-except",
                    "--shardx-extension-library",
                ]
                .contains(&name)
            {
                anyhow::bail!("pinned launch argument overrides managed identity or networking");
            }
        }
        self.launch_inner(profile, opts, true).await
    }

    async fn launch_inner(
        &self,
        mut profile: Profile,
        opts: LaunchOptions,
        pinned: bool,
    ) -> Result<BrowserSession> {
        let root = opts
            .user_data_dir
            .clone()
            .unwrap_or_else(|| self.runtime.profiles_root());
        let profile_lock = ProfileLock::acquire(&root, &profile.id)?;
        let udd = user_data_dir(&self.runtime, &profile.id, Some(&root))?;
        ensure_profile_stopped(&udd)?;
        let parsed: Option<ParsedProxy> = match &opts.proxy {
            Some(u) => Some(parse_proxy(u)?),
            None => None,
        };

        if opts.require_proxy_geo && parsed.is_none() {
            anyhow::bail!("required proxy is missing");
        }
        if let Some(start_url) = &opts.start_url {
            let url = url::Url::parse(start_url)?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                anyhow::bail!("invalid start URL");
            }
        }
        if pinned && parsed.is_some() && !opts.require_proxy_geo {
            anyhow::bail!("pinned proxy launches require a successful proxy-only preflight");
        }
        // ---- pre-launch: auto-resolve, screen strategy, UDP probe ----
        let mut geo: Option<GeoInfo> = None;
        if opts.require_proxy_geo && parsed.is_some() {
            let result = crate::geo::geo_check_via(parsed.as_ref(), "ipwho.is").await?;
            if result.ip.parse::<std::net::IpAddr>().is_err() || result.timezone.is_empty() {
                anyhow::bail!("proxy exit identity is unavailable");
            }
            if has_auto_fields(&profile.config) {
                crate::auto_resolve::apply_geo_fields(&mut profile.config, &result);
            }
            geo = Some(result);
        } else if has_auto_fields(&profile.config) {
            geo = resolve_auto_fields(&mut profile.config, parsed.as_ref()).await;
        }

        let mode = opts
            .screen_mode
            .unwrap_or_else(|| default_screen_mode_for(&profile.platform()));
        apply_screen_strategy(&mut profile.config, mode);

        let mut proxy_udp_ms: Option<u128> = None;
        if let Some(p) = &parsed {
            if p.scheme == ProxyScheme::Socks5
                && !(opts.quic == Some(false) && opts.webrtc == Some(WebRtcMode::TcpOnly))
            {
                let timeout = Duration::from_millis(opts.probe_timeout_ms.unwrap_or(6000));
                proxy_udp_ms =
                    tokio::time::timeout(timeout, probe_udp(p, timeout.as_millis() as u64))
                        .await
                        .ok()
                        .and_then(|result| result.ok());
            }
        }
        let udp_ok = proxy_udp_ms.is_some();
        let quic_enabled = opts.quic.unwrap_or(parsed.is_some() && udp_ok);
        let mut webrtc_mode = opts.webrtc.unwrap_or(WebRtcMode::Auto);
        if webrtc_mode == WebRtcMode::Auto && parsed.is_some() && !udp_ok {
            webrtc_mode = WebRtcMode::TcpOnly;
        }

        if !pinned {
            freeze_identity(&mut profile, &self.runtime);
        }
        let fp_file = udd.join("fingerprint.json");
        std::fs::write(&fp_file, serde_json::to_string(&profile.config)?)?;

        let mut argv: Vec<String> = vec![
            format!("--fingerprint-profile={}", fp_file.display()),
            format!("--user-data-dir={}", udd.display()),
            "--no-first-run".into(),
        ];
        // Match the launcher's OSCrypt mode so explicit Cookie import/export
        // uses the same v10 key as the browser writing this Profile's database.
        #[cfg(target_os = "macos")]
        argv.push("--use-mock-keychain".into());
        #[cfg(target_os = "linux")]
        argv.push("--password-store=basic".into());
        // A profile claiming desktop Linux keeps navigator.gpu and answers the
        // adapter request with nothing, which is what Chrome on Linux does;
        // disabling the feature would remove the object as well.
        if !profile.has_webgpu() && !profile.claims_linux_desktop() {
            argv.push("--disable-features=WebGPU".into());
        }
        if opts.android_media && profile.claims_mobile() {
            argv.push("--shardx-android-media".into());
        }
        if opts.hide_profile_name {
            argv.push("--shardx-hide-profile-name".into());
        }
        if !opts.headless && !opts.cdp {
            argv.push("--restore-last-session".into());
            argv.push("--hide-crash-restore-bubble".into());
        }
        if mode == ScreenStrategy::UseHost {
            argv.push("--shardx-real-screen".into());
        }
        if let Some(p) = &parsed {
            argv.push(format!("--proxy-server={}", proxy_to_arg(p)));
            // Chromium otherwise bypasses its proxy for loopback destinations.
            argv.push("--proxy-bypass-list=<-loopback>".into());
            argv.push(
                if quic_enabled {
                    "--enable-quic"
                } else {
                    "--disable-quic"
                }
                .into(),
            );
        }
        if parsed.is_none() {
            argv.push("--no-proxy-server".into());
        }
        match webrtc_mode {
            WebRtcMode::Block => {
                argv.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into());
                argv.push("--shardx-webrtc-policy=block".into());
            }
            WebRtcMode::TcpOnly => {
                argv.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into());
                argv.push("--shardx-webrtc-policy=tcp_only".into());
                // Engine spoofs the public side of ICE candidates with this IP.
                let mut ip = opts
                    .webrtc_public_ip
                    .clone()
                    .or_else(|| geo.as_ref().map(|g| g.ip.clone()).filter(|s| !s.is_empty()));
                if ip.is_none() {
                    if let Some(p) = &parsed {
                        if let Ok(g) = geo_check_via(Some(p), "ip-api.com").await {
                            if !g.ip.is_empty() {
                                ip = Some(g.ip);
                            }
                        }
                    }
                }
                if let Some(ip) = ip {
                    argv.push(format!("--shardx-webrtc-public-ip={ip}"));
                }
            }
            WebRtcMode::Auto => {}
        }
        if opts.cdp {
            let marker = udd.join("DevToolsActivePort");
            let _ = std::fs::remove_file(&marker);
            argv.push("--remote-debugging-port=0".into());
            argv.push("--remote-debugging-address=127.0.0.1".into());
            argv.push("--remote-allow-origins=*".into());
            // Gates the Motion domain, which every synthesised click and
            // keystroke goes through. Without it `Motion.createPointer` comes
            // back as "wasn't found": the domain is absent from
            // Schema.getDomains and /json/protocol rather than merely
            // disabled, which is what keeps it free when nobody uses it. The
            // launcher passes the same flag.
            argv.push("--shardx-automation".into());
        }
        if opts.headless {
            argv.push("--headless=new".into());
        }
        let extension_paths = validate_extension_paths(&opts.extensions)?;
        let extension_library = validate_extension_library(opts.extension_library.as_deref())?;
        let loads_alone =
            crate::runtime::engine_loads_extensions_alone(&self.runtime.binary_path());
        if !extension_paths.is_empty() {
            let joined = extension_paths
                .iter()
                .map(|path| path.to_string_lossy())
                .collect::<Vec<_>>()
                .join(",");
            if !loads_alone {
                argv.push(format!("--disable-extensions-except={joined}"));
            }
            argv.push(format!("--load-extension={joined}"));
        }
        if loads_alone {
            if let Some(library) = extension_library {
                argv.push(format!("--shardx-extension-library={}", library.display()));
            }
        }
        argv.extend(opts.extra_args.iter().cloned());
        if let Some(url) = &opts.start_url {
            argv.push(url.clone());
        }

        let mut cmd = Command::new(self.runtime.binary_path());
        cmd.args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        let child = cmd.spawn()?;
        // Own the child before the first await so cancellation kills and reaps it.
        let mut session = BrowserSession {
            pid: child.id(),
            user_data_dir: udd,
            cdp_url: None,
            proxy_udp_ms,
            quic_enabled,
            webrtc_mode,
            geo,
            child: Some(child),
            stopped: false,
            _profile_lock: Some(profile_lock),
        };
        if opts.cdp {
            session.cdp_url = tokio::time::timeout(
                Duration::from_secs(15),
                read_cdp_endpoint(&session.user_data_dir, 15_000),
            )
            .await
            .ok()
            .flatten();
        }
        Ok(session)
    }
}

fn validate_extension_paths(paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.is_absolute() || path.to_string_lossy().contains(',') {
            anyhow::bail!("invalid managed extension path");
        }
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            anyhow::bail!("invalid managed extension directory");
        }
        let canonical = std::fs::canonicalize(path)?;
        if canonical != *path || !canonical.join("manifest.json").is_file() {
            anyhow::bail!("managed extension directory is unavailable");
        }
        out.push(canonical);
    }
    Ok(out)
}

fn validate_extension_library(path: Option<&std::path::Path>) -> Result<Option<PathBuf>> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.is_absolute() || path.to_string_lossy().contains(',') {
        anyhow::bail!("invalid managed extension library");
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        anyhow::bail!("invalid managed extension library");
    }
    let canonical = std::fs::canonicalize(path)?;
    if canonical != path {
        anyhow::bail!("managed extension library must be canonical");
    }
    Ok(Some(canonical))
}

pub(crate) fn freeze_identity(profile: &mut Profile, runtime: &Runtime) {
    let (grease_brand, grease_version) = runtime.grease();
    let android = profile
        .claims_mobile()
        .then(|| runtime.android_chromium_version())
        .flatten();
    crate::profile::apply_engine_version(
        &mut profile.config,
        &runtime.chromium_version(),
        grease_brand.as_deref(),
        grease_version.as_deref(),
        runtime.tls().as_ref(),
        android.as_deref(),
    );
    crate::profile::adopt_library_fields(&mut profile.config, &runtime.fingerprints_dir());
    crate::profile::apply_apple_webgpu_features(&mut profile.config);
    crate::randomize::settle_platform_version(&mut profile.config);
    if profile.claims_mobile() {
        crate::profile::apply_chrome_brand(&mut profile.config);
    }
    apply_noise_seeds(&mut profile.config, &profile.id);
}

async fn read_cdp_endpoint(udd: &std::path::Path, timeout_ms: u64) -> Option<String> {
    let marker = udd.join("DevToolsActivePort");
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(1))
        .build()
        .ok()?;
    while tokio::time::Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(&marker) {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (
                lines.next().and_then(|p| p.parse::<u16>().ok()),
                lines.next(),
            ) {
                if port != 0 && path.starts_with("/devtools/browser/") && path.len() > 18 {
                    let expected = format!("ws://127.0.0.1:{port}{path}");
                    if let Ok(resp) = client
                        .get(format!("http://127.0.0.1:{port}/json/version"))
                        .send()
                        .await
                    {
                        if resp.status().is_success() {
                            if let Ok(value) = resp.json::<serde_json::Value>().await {
                                if value.get("webSocketDebuggerUrl").and_then(|v| v.as_str())
                                    == Some(expected.as_str())
                                {
                                    return Some(expected);
                                }
                            }
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

#[cfg(test)]
mod close_over_cdp_tests {
    use super::close_over_cdp;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// #130: a CDP session is stopped with Browser.close, the way the launcher closes a profile.
    #[tokio::test]
    async fn browser_close_goes_out_as_one_masked_frame_after_the_upgrade() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut c, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let n = c.read(&mut buf).await.unwrap();
            assert!(buf[..n].starts_with(b"GET /devtools/browser/x HTTP/1.1\r\n"));
            c.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").await.unwrap();
            let n = c.read(&mut buf).await.unwrap();
            let (len, mask) = ((buf[1] & 0x7f) as usize, [buf[2], buf[3], buf[4], buf[5]]);
            assert_eq!(n, 6 + len);
            buf[6..6 + len]
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ mask[i % 4])
                .collect::<Vec<u8>>()
        });
        assert!(close_over_cdp(&format!("ws://127.0.0.1:{port}/devtools/browser/x")).await);
        let payload: serde_json::Value = serde_json::from_slice(&server.await.unwrap()).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "id": 1, "method": "Browser.close" })
        );
    }

    #[tokio::test]
    async fn nothing_listening_is_a_no() {
        assert!(!close_over_cdp("ws://127.0.0.1:1/devtools/browser/x").await);
    }
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_stop_keeps_ownership_and_can_be_retried() {
        let root =
            std::env::temp_dir().join(format!("shardx-lifecycle-{:032x}", rand::random::<u128>()));
        std::fs::create_dir_all(&root).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut session = BrowserSession {
            pid: child.id(),
            user_data_dir: root.clone(),
            cdp_url: Some(format!(
                "ws://{}/devtools/browser/fixture",
                listener.local_addr().unwrap()
            )),
            proxy_udp_ms: None,
            quic_enabled: false,
            webrtc_mode: WebRtcMode::Block,
            geo: None,
            child: Some(child),
            stopped: false,
            _profile_lock: Some(ProfileLock::acquire(&root, "fixture").unwrap()),
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(20), session.stop())
                .await
                .is_err()
        );
        assert!(session.child.is_some());
        assert!(!session.stopped);
        assert!(ProfileLock::acquire(&root, "fixture").is_err());
        session.cdp_url = None;
        session.stop().await.unwrap();
        assert!(!crate::process_alive(session.pid));
        session.stop().await.unwrap();
        let lock = ProfileLock::acquire(&root, "fixture").unwrap();
        drop(lock);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod pinned_options_tests {
    use super::*;

    #[tokio::test]
    async fn protected_arguments_and_randomization_are_rejected_before_spawn() {
        let root =
            std::env::temp_dir().join(format!("shardx-options-{:032x}", rand::random::<u128>()));
        let runtime = Arc::new(Runtime::new(Some(root.clone()), None, None).unwrap());
        let browser = Browser::new(runtime);
        for argument in [
            "--user-data-dir=/other",
            "--proxy-server=direct://",
            "--remote-debugging-address=0.0.0.0",
            "https://extra.example/",
        ] {
            let profile = Profile::new(serde_json::json!({"navigator":{}}), Some("fixture".into()));
            assert!(browser
                .launch_pinned(
                    profile,
                    LaunchOptions {
                        extra_args: vec![argument.into()],
                        ..Default::default()
                    }
                )
                .await
                .is_err());
        }
        let profile = Profile::new(serde_json::json!({"navigator":{}}), Some("fixture".into()));
        assert!(browser
            .launch_pinned(
                profile,
                LaunchOptions {
                    randomize: true,
                    ..Default::default()
                }
            )
            .await
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
