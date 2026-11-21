//! # ShardX Rust SDK
//!
//! Self-contained SDK for the [ShardX](https://shardx.com?utm_source=shardx&utm_medium=referral&utm_campaign=shardx-launcher)
//! anti-detect browser. Mirrors the Python (`shardx`) and Node
//! (`@proxyshard/shardx`) SDKs: on first use it downloads the engine,
//! Widevine CDM, and the bundled fingerprint library from the ProxyShard
//! CDN into a per-user cache dir, then launches isolated profiles with the
//! same spoofing flags the desktop launcher uses.
//!
//! ```no_run
//! use shardx::{ShardX, ShardXOptions, LaunchOptions};
//!
//! # async fn run() -> anyhow::Result<()> {
//! let sdk = ShardX::new(ShardXOptions::default())?;
//!
//! // Launch a random profile through a proxy AND attach a CDP browser.
//! let profile = sdk.create_profile(None).await?;
//! let session = sdk
//!     .session(profile, LaunchOptions {
//!         proxy: Some("socks5://user:pass@host:1080".into()),
//!         ..Default::default()
//!     })
//!     .await?;
//!
//! let _page = session.new_page("https://example.com").await?;
//! // ... drive `session.browser` (chromiumoxide) ...
//! session.close().await?;
//! # Ok(())
//! # }
//! ```

mod auto_resolve;
mod browser;
#[cfg(feature = "control")]
mod control;
mod geo;
mod host;
#[cfg(feature = "control")]
pub mod motion;
mod profile;
mod proxy;
mod randomize;
mod runtime;
mod screen;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use rand::{seq::SliceRandom, SeedableRng};
use serde_json::Value;

pub use auto_resolve::{has_auto_fields, resolve_auto_fields};
pub use browser::{Browser, BrowserSession, LaunchOptions, WebRtcMode};
#[cfg(feature = "control")]
pub use chromiumoxide;
#[cfg(feature = "control")]
pub use control::Session;
pub use geo::{geo_check_via, GeoInfo};
pub use host::{host_logical_cores, host_ram_bucket_gb, host_ram_gb, host_screen_size, Size};
#[cfg(feature = "control")]
pub use motion::Motion;
pub use profile::{
    apply_engine_version, user_data_dir, validate_fingerprint_config, FingerprintLibrary, Profile,
};
pub use proxy::{parse_proxy, probe_udp, proxy_to_arg, ParsedProxy, ProxyScheme};
pub use randomize::{
    mac_hw_configs, randomize_hardware, randomize_platform_version, settle_platform_version,
    LINUX_PLATFORM_VERSIONS, MACOS_PLATFORM_VERSIONS, WINDOWS_PLATFORM_VERSIONS, X86_CORES,
};
pub use runtime::{
    default_cache_dir, engine_loads_extensions_alone, host_spec, Archive, HostSpec, ProgressCb,
    Runtime, CHROMIUM_VERSION, PUB_BASE,
};
pub use screen::{apply_screen_strategy, default_screen_mode_for, ScreenStrategy};

/// Conservative native PID existence check. Permission failures count as alive.
pub fn process_alive(pid: u32) -> bool {
    runtime::pid_alive(i64::from(pid))
}

/// Ask a previously verified managed CDP endpoint to close its browser.
pub async fn request_browser_close(websocket_url: &str) -> bool {
    let Ok(url) = url::Url::parse(websocket_url) else {
        return false;
    };
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/devtools/browser/")
    {
        return false;
    }
    browser::close_over_cdp(websocket_url).await
}

/// Construction options for [`ShardX`].
#[derive(Default)]
pub struct ShardXOptions {
    /// Where the engine, Widevine, and fingerprint library live
    /// (defaults to the per-OS app-data dir — see [`default_cache_dir`]).
    pub cache_dir: Option<PathBuf>,
    /// Per-profile user-data-dir root. Defaults to `<cache_dir>/profiles/`.
    pub profiles_dir: Option<PathBuf>,
    /// Optional download-progress callback `(label, received, total)`.
    pub progress: Option<ProgressCb>,
}

/// Result of [`ShardX::check_proxy`] — the same data the launcher uses to
/// decide QUIC + WebRTC policy.
#[derive(Debug, Clone)]
pub struct ProxyCheckResult {
    pub udp_ms: Option<u128>,
    pub geo: GeoInfo,
    pub would_enable_quic: bool,
    pub would_set_webrtc: WebRtcMode,
}

/// Fresh 128-bit hex id for a saved profile (its folder + state key).
fn new_profile_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// Top-level façade — bundles the runtime, fingerprint library, and browser
/// launcher. Mirrors the Python `ShardX` class / Node `ShardX`.
pub struct ShardX {
    pub runtime: Arc<Runtime>,
    library: FingerprintLibrary,
    browser: Browser,
}

impl ShardX {
    pub fn new(opts: ShardXOptions) -> Result<Self> {
        let runtime = Arc::new(Runtime::new(
            opts.cache_dir,
            opts.profiles_dir,
            opts.progress,
        )?);
        Ok(Self {
            library: FingerprintLibrary::new(runtime.clone()),
            browser: Browser::new(runtime.clone()),
            runtime,
        })
    }

    /// All bundled fingerprint ids, optionally filtered by `navigator.platform`
    /// substring. Auto-installs the fingerprint library on first call.
    pub async fn list_profiles(&self, platform: Option<&str>) -> Result<Vec<String>> {
        self.runtime.install(false).await?;
        Ok(match platform {
            Some(p) => self.library.filter(Some(p)),
            None => self.library.ids(),
        })
    }

    /// Pick a random profile from the library. Auto-installs on first call.
    pub async fn random_profile(&self, platform: Option<&str>) -> Result<Profile> {
        let ids = self.list_profiles(platform).await?;
        let id = ids.choose(&mut rand::thread_rng()).ok_or_else(|| {
            anyhow!(
                "No bundled profiles found{}.",
                platform
                    .map(|p| format!(" for platform={p}"))
                    .unwrap_or_default()
            )
        })?;
        self.library.load(id)
    }

    // ---- persistent profiles -------------------------------------------
    //
    // A *saved profile* is a frozen, uniquely-id'd copy of a library template
    // (or a random one) enriched with randomized hardware/platform_version —
    // the same thing the desktop launcher does on "create profile". It lives
    // in its own folder `<profiles_root>/<id>/` together with its browser
    // state, so you can reopen the exact same profile later or delete it.

    /// Create a new persistent profile from a library template (or a random
    /// template when `template` is `None`), enriched with randomized
    /// hardware + platform_version under a fresh unique id, and frozen to disk.
    /// Pass the returned profile straight to `launch` / `session`.
    pub async fn create_profile(&self, template: Option<&str>) -> Result<Profile> {
        self.create_profile_with(template, None).await
    }

    /// Create a saved identity only from a previously pinned local install.
    pub fn create_pinned_profile(
        &self,
        template: Option<&str>,
        id: &str,
        seed: u32,
    ) -> Result<Profile> {
        profile::validate_profile_id(id)?;
        if seed == 0 || seed > 0x7fff_ffff {
            anyhow::bail!("invalid fingerprint seed");
        }
        let root = self.runtime.profiles_root();
        let _lock = profile::ProfileLock::acquire(&root, id)?;
        let dir = root.join(id);
        if dir.try_exists()? {
            anyhow::bail!("profile directory already exists");
        }
        let mut rng = rand::rngs::StdRng::seed_from_u64(u64::from(seed));
        let mut config = match template {
            Some(template) => self.library.load(template)?.config,
            None => {
                let platform = if cfg!(target_os = "macos") {
                    "macOS"
                } else if cfg!(target_os = "windows") {
                    "Windows"
                } else {
                    "Linux"
                };
                let ids: Vec<_> = self
                    .library
                    .filter(Some(platform))
                    .into_iter()
                    .filter(|id| self.library.load(id).is_ok_and(|p| !p.claims_mobile()))
                    .collect();
                let selected = ids
                    .choose(&mut rng)
                    .ok_or_else(|| anyhow!("fingerprint library is empty"))?;
                self.library.load(selected)?.config
            }
        };
        let template_id = config
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned);
        randomize::randomize_hardware_with_rng(&mut config, template_id.as_deref(), &mut rng);
        randomize::randomize_platform_version_with_rng(&mut config, &mut rng);
        let mut profile = Profile::new(config, Some(id.to_string()));
        browser::freeze_identity(&mut profile, &self.runtime);
        fs::create_dir_all(&root)?;
        fs::create_dir(&dir)?;
        profile::write_new_json(&dir.join("profile.json"), &profile.config)?;
        #[cfg(unix)]
        fs::File::open(&root)?.sync_all()?;
        Ok(profile)
    }

    /// Freeze the official editor's complete payload using the pinned runtime only.
    pub fn create_pinned_profile_config(
        &self,
        config: Value,
        id: &str,
        seed: u32,
    ) -> Result<Profile> {
        profile::validate_profile_id(id)?;
        validate_fingerprint_config(&config)?;
        if seed == 0 || seed > 0x7fff_ffff {
            anyhow::bail!("invalid fingerprint seed");
        }
        let root = self.runtime.profiles_root();
        let _lock = profile::ProfileLock::acquire(&root, id)?;
        let dir = root.join(id);
        if dir.try_exists()? {
            anyhow::bail!("profile directory already exists");
        }
        // The official editor already enriched the preset before the operator's
        // hardware/version choices. Preserve those explicit choices on save.
        let profile = self.normalize_pinned_profile_config(config, id)?;
        fs::create_dir_all(&root)?;
        fs::create_dir(&dir)?;
        profile::write_new_json(&dir.join("profile.json"), &profile.config)?;
        #[cfg(unix)]
        fs::File::open(&root)?.sync_all()?;
        Ok(profile)
    }

    /// Normalize an in-memory edited snapshot without randomization or disk writes.
    pub fn normalize_pinned_profile_config(&self, config: Value, id: &str) -> Result<Profile> {
        profile::validate_profile_id(id)?;
        validate_fingerprint_config(&config)?;
        let mut profile = Profile::new(config, Some(id.to_owned()));
        browser::freeze_identity(&mut profile, &self.runtime);
        if !profile.config.get("_meta").is_some_and(Value::is_object) {
            profile.config["_meta"] = serde_json::json!({});
        }
        profile.config["_meta"]["id"] = Value::String(id.to_owned());
        if profile
            .config
            .pointer("/_meta/real_gpu")
            .and_then(Value::as_bool)
            == Some(true)
        {
            let obj = profile
                .config
                .as_object_mut()
                .ok_or_else(|| anyhow!("invalid config"))?;
            obj.remove("webgl");
            obj.remove("webgpu");
        }
        Ok(profile)
    }

    /// `create_profile` plus the claimed display refresh rate in Hz.
    ///
    /// No web API reports the refresh rate; a page measures it by timing
    /// requestAnimationFrame. Leaving it out is not neutral — the engine then
    /// claims 60, which is what most machines report, rather than the host's
    /// own screen. Frames can only be slowed, so a rate above the host's panel
    /// runs at the panel's.
    pub async fn create_profile_with(
        &self,
        template: Option<&str>,
        refresh_rate: Option<u32>,
    ) -> Result<Profile> {
        self.runtime.install(false).await?;
        let mut config = match template {
            Some(id) => self.library.load(id)?.config,
            None => self.random_profile(None).await?.config,
        };
        let id = new_profile_id();
        // Seed hardware by the new id so the pick is stable across reopens.
        randomize_hardware(&mut config, Some(&id));
        randomize_platform_version(&mut config);
        if let Some(hz) = refresh_rate {
            if !(24..=480).contains(&hz) {
                anyhow::bail!("refresh_rate must be 24..480, got {hz}");
            }
            let obj = config
                .as_object_mut()
                .ok_or_else(|| anyhow!("fingerprint config is not an object"))?;
            let screen = obj
                .entry("screen")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            match screen.as_object_mut() {
                Some(o) => {
                    o.insert("refresh_rate".into(), serde_json::json!(hz));
                }
                None => anyhow::bail!("`screen` is not an object"),
            }
        }
        let profile = Profile::new(config, Some(id));
        self.save_profile(&profile)?;
        Ok(profile)
    }

    /// Hold the same OS lock as profile launches while accessing stopped data.
    pub fn lock_stopped_profile(&self, id: &str) -> Result<impl Drop> {
        let root = self.runtime.profiles_root();
        let guard = profile::ProfileLock::acquire(&root, id)?;
        profile::ensure_profile_stopped(&root.join(id))?;
        Ok(guard)
    }

    /// Persist a profile's current config to its on-disk folder. Call this
    /// after mutating a reopened profile (e.g. `set_noise`) to keep changes.
    pub fn save_profile(&self, profile: &Profile) -> Result<()> {
        profile::validate_profile_id(&profile.id)?;
        let _lock = profile::ProfileLock::acquire(&self.runtime.profiles_root(), &profile.id)?;
        profile::ensure_profile_stopped(&self.runtime.profiles_root().join(&profile.id))?;
        let directory = user_data_dir(&self.runtime, &profile.id, None)?;
        let path = directory.join("profile.json");
        if path
            .parent()
            .is_some_and(|parent| parent.join("create.json").exists())
        {
            anyhow::bail!("managed fingerprint identity is immutable");
        }
        let temporary = path.with_file_name(format!(".save-{:032x}.json", rand::random::<u128>()));
        let result = (|| -> Result<()> {
            profile::write_new_json(&temporary, &profile.config)?;
            fs::rename(&temporary, &path)?;
            #[cfg(unix)]
            fs::File::open(
                path.parent()
                    .ok_or_else(|| anyhow!("missing profile directory"))?,
            )?
            .sync_all()?;
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result?;
        Ok(())
    }

    /// Reopen a previously created profile by id (same fingerprint + state).
    pub fn open_profile(&self, id: &str) -> Result<Profile> {
        profile::validate_profile_id(id)?;
        let path = self.profile_json_path(id);
        let directory = path
            .parent()
            .ok_or_else(|| anyhow!("missing profile directory"))?;
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            anyhow::bail!("invalid profile directory");
        }
        if !path.exists() {
            return Err(anyhow!("saved profile '{id}' not found"));
        }
        let config: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        Ok(Profile::new(config, Some(id.to_string())))
    }

    /// Ids of every saved profile, sorted.
    pub fn list_saved_profiles(&self) -> Result<Vec<String>> {
        let root = self.runtime.profiles_root();
        let mut out = Vec::new();
        if root.exists() {
            for entry in fs::read_dir(&root)? {
                let entry = entry?;
                if entry.path().join("profile.json").exists() {
                    if let Some(name) = entry.file_name().to_str() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Delete a saved profile and all its state (cookies, cache, …).
    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let root = self.runtime.profiles_root();
        let _lock = profile::ProfileLock::acquire(&root, id)?;
        let dir = root.join(id);
        profile::ensure_profile_stopped(&dir)?;
        match fs::symlink_metadata(&dir) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                fs::remove_dir_all(&dir)?
            }
            Ok(_) => anyhow::bail!("invalid profile directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn profile_json_path(&self, id: &str) -> PathBuf {
        self.runtime.profiles_root().join(id).join("profile.json")
    }

    /// Launch a `Profile`. Get one from [`ShardX::create_profile`] (the
    /// recommended path — a persistent profile frozen from a library template
    /// or a random one), [`Profile::from_file`], or [`Profile::new`] for your
    /// own config. Library templates are never launched directly — go through
    /// `create_profile` so each run has a stable identity and the bundled
    /// fingerprint library stays untouched.
    ///
    /// `opts.randomize` re-rolls hardware_concurrency / device_memory /
    /// platform_version before launch (off by default; leave it off for a
    /// saved profile or its frozen fingerprint will drift).
    pub async fn launch(
        &self,
        mut profile: Profile,
        opts: LaunchOptions,
    ) -> Result<BrowserSession> {
        self.runtime.install(false).await?;
        if opts.randomize {
            let id = profile.id.clone();
            randomize_hardware(&mut profile.config, Some(&id));
            randomize_platform_version(&mut profile.config);
        }
        self.browser.launch(profile, opts).await
    }

    /// Launch a profile **and connect a CDP browser** in one call (forces
    /// `cdp = true`). Returns a [`Session`] that owns both the driven
    /// `chromiumoxide` browser and the engine process; call
    /// [`Session::close`] to tear both down.
    ///
    /// Requires the default `control` feature.
    #[cfg(feature = "control")]
    pub async fn session(&self, profile: Profile, mut opts: LaunchOptions) -> Result<Session> {
        opts.cdp = true;
        let engine = self.launch(profile, opts).await?;
        if engine.cdp_url.is_none() {
            let mut engine = engine;
            let _ = engine.stop().await;
            return Err(anyhow!(
                "CDP endpoint unavailable — engine failed to expose remote-debugging port"
            ));
        }
        Session::connect(engine).await
    }

    /// Launch with the CDP endpoint enabled but **without** attaching a
    /// driver — returns the raw [`BrowserSession`]; connect your own CDP
    /// client to [`BrowserSession::cdp_url`]. Always available (no `control`
    /// feature needed).
    pub async fn launch_cdp(
        &self,
        profile: Profile,
        mut opts: LaunchOptions,
    ) -> Result<BrowserSession> {
        opts.cdp = true;
        let mut session = self.launch(profile, opts).await?;
        if session.cdp_url.is_none() {
            let _ = session.stop().await;
            return Err(anyhow!(
                "CDP endpoint unavailable — engine failed to expose remote-debugging port"
            ));
        }
        Ok(session)
    }

    /// Launch a locally pinned identity; never fetch or replace its engine.
    pub async fn launch_pinned_cdp(
        &self,
        profile: Profile,
        mut opts: LaunchOptions,
    ) -> Result<BrowserSession> {
        opts.cdp = true;
        let mut session = self.browser.launch_pinned(profile, opts).await?;
        if session.cdp_url.is_none() {
            let _ = session.stop().await;
            anyhow::bail!("pinned engine did not expose a CDP endpoint");
        }
        Ok(session)
    }

    /// Validate a proxy URL before binding it to a profile.
    pub async fn check_proxy(&self, proxy_url: &str) -> Result<ProxyCheckResult> {
        let parsed = parse_proxy(proxy_url)?;
        let udp_ms = if parsed.scheme == ProxyScheme::Socks5 {
            probe_udp(&parsed, 6000).await.ok()
        } else {
            None
        };
        let geo = geo_check_via(Some(&parsed), "ip-api.com").await?;
        let udp_ok = udp_ms.is_some();
        Ok(ProxyCheckResult {
            udp_ms,
            geo,
            would_enable_quic: udp_ok,
            would_set_webrtc: if udp_ok {
                WebRtcMode::Auto
            } else {
                WebRtcMode::TcpOnly
            },
        })
    }
}

#[cfg(test)]
mod managed_profile_tests {
    use super::*;

    #[test]
    fn pinned_creation_is_exclusive_deterministic_and_confined() {
        let root =
            std::env::temp_dir().join(format!("shardx-test-{:032x}", rand::random::<u128>()));
        let sdk = ShardX::new(ShardXOptions {
            cache_dir: Some(root.clone()),
            ..Default::default()
        })
        .unwrap();
        fs::write(
            sdk.runtime.fingerprints_dir().join("fixture.json"),
            r#"{"name":"fixture","navigator":{"platform":"Windows"},"client_hints":{}}"#,
        )
        .unwrap();
        let a = sdk
            .create_pinned_profile(Some("fixture"), "one", 123)
            .unwrap();
        let original = fs::read(sdk.profile_json_path("one")).unwrap();
        assert!(sdk
            .create_pinned_profile(Some("fixture"), "one", 456)
            .is_err());
        assert_eq!(fs::read(sdk.profile_json_path("one")).unwrap(), original);
        let b = sdk
            .create_pinned_profile(Some("fixture"), "two", 123)
            .unwrap();
        assert_eq!(a.config["navigator"], b.config["navigator"]);
        assert_eq!(a.config["client_hints"], b.config["client_hints"]);
        for id in ["../escape", "/escape", "a/b", "..", ""] {
            assert!(sdk.create_pinned_profile(Some("fixture"), id, 123).is_err());
            assert!(sdk.open_profile(id).is_err());
            assert!(sdk.delete_profile(id).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
