# `shardx` — Rust SDK

Self-contained Rust SDK for the **ShardBrowser anti-detect browser** by the
[ShardX](https://shardx.com?utm_source=shardx&utm_medium=referral&utm_campaign=shardx-launcher)
team (formerly ProxyShard). Same surface as the [Python](../python) and [Node](../node) SDKs: on
first use it downloads the engine, Widevine CDM, and the bundled fingerprint
library from the ProxyShard CDN into a per-user cache dir, then launches
isolated profiles with the exact spoofing flags the desktop launcher uses.

Supported hosts: **macOS arm64**, **Windows x64**, **Linux x64**.
On macOS/Linux the system `unzip` is used for extraction (preserves symlinks
and exec bits) — install it with `brew install unzip` / `apt install unzip`.

## Raccoon managed runtime changes

The vendored SDK adds offline `Runtime::use_installed`,
`ShardX::create_pinned_profile`, and `ShardX::launch_pinned_cdp` entry points.
The managed host pins the installed engine before use. These entry points do
all profile work locally and perform network preflight through the selected
proxy when launching. Downloads stay in the explicit kernel installation flow.

`create_pinned_profile` owns directory creation exclusively. Callers create the
profiles root and leave `<root>/<id>` absent. An existing directory causes an
error, preserving its fingerprint. A nonzero seed up to `2147483647` selects a
host-OS desktop template and seeds hardware and platform-version selection.
The saved JSON freezes engine-version normalization and noise seeds. A pinned
launch preserves that identity and applies the caller's launch settings to a
copy. Recreating an identity from a seed also depends on the library, SDK and
host hardware. The persisted JSON is the identity used on subsequent launches.

Launches and profile writes share an OS file lock per profile. Unix uses
`flock`, Windows uses an exclusive file handle. Locks stay on a stable file in
`.profile-locks`. Browser runtime markers also block launch and mutation after
host restart. `BrowserSession` owns its child before awaiting CDP discovery.
Dropping a launch future kills and reaps that child, while cancelling `stop`
retains ownership for retry. A detached session keeps a reaper and lock alive
until the browser exits or the host process exits. Browser sessions use native
processes and require a Tokio runtime only while async operations are polled.
They have no long-lived proxy relay task.

Managed proxy launches require a successful proxy-only geo preflight. Failed
preflight aborts launch. Raccoon proxy launches disable QUIC and use TCP-only
WebRTC. This also avoids the optional SDK STUN lookup. Explicit direct launches use `--no-proxy-server`.
Pinned extra arguments cannot replace the Profile path, proxy configuration or
CDP listener. CDP discovery compares the browser path in `DevToolsActivePort`
with the loopback `/json/version` response and has a bounded deadline.

The Raccoon Provider maps `timezone`, `locale`, `viewport`, `startUrl` and
`cpuCores` into launch JSON/options. Viewports are `default`, `1440x900` and
`1920x1080`. Start URLs accept HTTP(S) with a host and without userinfo.
CPU counts accept 1–64 and stay fixed after creation. `operatingSystem` accepts
`host` only, and `aliasEngine` stays absent. Manual timezone and locale override
automatic matching. Empty values with `geoip=false` use UTC and en-US, and skip
geo resolution. `geoip=true` resolves empty values and geolocation from the
selected connection. Name, note and Folder belong to the Raccoon metadata
store. Kernel selection and seed are immutable after creation.

The Provider persists a create intent before SDK creation, then publishes a
checksum receipt. It can reconcile a fully published identity after interruption
without recreating it. Incomplete or contradictory evidence stays uncertain.
JSON files are synced and published using an exclusive hard link to a complete
temporary file. Unix also syncs parent directories. Windows directory durability
and real browser behavior require target-system verification. A startup failure
or host crash with unresolved runtime markers can require manual reconciliation.
This source integration has no local Rust compilation, Rust test, Windows or
real-browser acceptance evidence.

## Install

```toml
[dependencies]
shardx = "0.1"
tokio = { version = "1", features = ["full"] }
```

## Quickstart — launch **and drive** the browser

`session()` launches the engine and attaches a [chromiumoxide](https://docs.rs/chromiumoxide)
CDP browser in one call (the Rust equivalent of patchright in the Python/Node
SDKs). It's behind the default `control` feature.

```rust
use shardx::{ShardX, ShardXOptions, LaunchOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let sdk = ShardX::new(ShardXOptions::default())?;

    // Create a persistent profile from a library template (or None for a
    // random one): enriches a COPY with randomized hw/platform_version and
    // freezes it under a unique id — the fingerprint library is read-only and
    // never launched directly. Do this once per profile.
    let profile = sdk.create_profile(Some("win-rtx4060")).await?;

    // Launch it through a proxy and get a driven browser. randomize: false
    // keeps the frozen fingerprint stable; cookies/cache persist across runs.
    let session = sdk
        .session(
            profile.clone(),
            LaunchOptions {
                proxy: Some("socks5://user:pass@host:1080".into()),
                randomize: false,
                ..Default::default()
            },
        )
        .await?;

    println!(
        "pid={}  quic={}  webrtc={:?}",
        session.engine.pid, session.engine.quic_enabled, session.engine.webrtc_mode,
    );

    // Drive it with chromiumoxide.
    let page = session.new_page("https://example.com").await?;
    println!("title: {:?}", page.get_title().await?);
    // `session.browser` is the full `chromiumoxide::Browser` for anything else.

    session.close().await?; // disconnect + stop the engine
    Ok(())
}
```

Pass `None` to `create_profile` for a **random** template. To launch your own
fingerprint, build a `Profile` (`Profile::from_file(path)` or
`Profile::new(serde_json::json!({ ... }), None)`) and hand it to `session` —
`launch`/`session` only take a `Profile`, never a raw library id.

### Without a driver (lighter build)

If you don't want the CDP client, disable the feature
(`shardx = { version = "0.1", default-features = false }`) and use
`launch` (no CDP) or `launch_cdp` (exposes `session.cdp_url` for your own
client):

```rust
let profile = sdk.create_profile(None).await?;
let mut engine = sdk.launch_cdp(profile, LaunchOptions::default()).await?;
println!("CDP: {:?}", engine.cdp_url);
engine.stop().await?;
```

## Persistent profiles

`list_profiles()` / random launches hand back **library templates** — launch
one and it re-reads the same template every time. For a profile you can
**return to** (same fingerprint *and* cookies/cache) or **delete**, create a
*saved profile*: it freezes a template (or a random one) with randomized
hardware/platform_version under a fresh unique id in its own folder
`<cache>/profiles/<id>/`, exactly like the desktop launcher's "create profile".

```rust
use shardx::{ShardX, ShardXOptions, LaunchOptions};

let sdk = ShardX::new(ShardXOptions::default())?;

// Create once (random template, or Some("win-rtx4060")).
let mut profile = sdk.create_profile(None).await?;
println!("{}", profile.id);
println!("{:?}", sdk.list_saved_profiles()?);          // ["<id>", ...]

// Launch it — randomize: false keeps the frozen fingerprint stable; cookies /
// cache persist in the profile's folder across runs.
let session = sdk.session(
    profile.clone(),
    LaunchOptions { randomize: false, ..Default::default() },
).await?;
// ... drive it, then session.close().await?; ...

// Later — even another process — reopen by id: same fingerprint + state.
let profile = sdk.open_profile(&profile.id)?;

// Remove the profile and all its state when you're done.
sdk.delete_profile(&profile.id)?;
```

Saved profiles never touch the bundled S3 library: templates stay read-only in
`<cache>/fingerprints/*.json`, saved profiles live in `<cache>/profiles/<id>/`
(holding `profile.json` + the browser's user-data-dir).

## Human input and finger gestures

`Motion` is the engine's own input domain: pointer trajectories that obey
Fitts's law, key-by-key typing with log-normal gaps, and the gestures a cursor
cannot make. It runs inside the browser process — nothing is injected into the
page — and it does not appear in `/json/protocol`, so a page cannot discover it.
Needs the default `control` feature.

```rust
use shardx::motion::Motion;

let session = sdk.session(profile, Default::default()).await?;
let page = session.new_page("about:blank").await?;
let motion = Motion::new(&page);

// desktop profile
motion.create_pointer(20.0, 20.0).await?;
motion.glide_to(640.0, 360.0, Some(220.0)).await?;   // the field's real width
motion.tap("left", 1).await?;
motion.enter_text("hello there", false).await?;
motion.destroy_pointer().await?;

// phone profile
motion.touch_swipe((200.0, 600.0), (200.0, 200.0), Some(true)).await?;
motion.touch_long_press(200.0, 300.0, None).await?;
motion.pinch(200.0, 400.0, 2.0, None).await?;
let o = motion.set_orientation(90, None).await?;
// o → { "angle": 90, "type": "landscape-primary", "screenWidth": 844, ... }
```

A profile that claims a touchscreen has no cursor, and the core enforces it
both ways: the pointer commands are refused on such a profile, and the finger
commands are refused on every other. There is no `touchScroll` and no fling
command — gestures are built in the browser out of the touch stream, so a real
swipe produces the scroll and the fling with the velocity the browser's own
tracker fitted. `touch_drag` differs from `touch_swipe` in the wait before the
travel: that wait is when a page's drag-and-drop starts, and a stroke that
begins earlier is a scroll.

`set_orientation` is physical and takes time — the sensors move first and the
picture commits at the end, the order a handset produces. It returns once the
new angle has reached the page, so `screen.width` read straight after is
already the turned one.

## Anti-fingerprint noise

Per-vector noise (canvas / WebGL / audio / DOMRect / sensors / fonts) is **off
by default**. `set_noise(...)` is **declarative** — exactly the vectors you list
are enabled (with soft defaults), every other one is turned off:

```rust
profile.set_noise(&["canvas", "audio", "webgl"]); // only these three on
profile.set_noise(&["canvas"]);                    // audio + webgl now off again
profile.set_noise(&[]);                            // all off
sdk.save_profile(&profile)?;                        // persist the choice
```

Seeds are derived **per-profile** at launch — stable across runs, unique per
profile — so two profiles with the same vectors enabled still produce different
canvas/audio/WebGL fingerprints. Soft defaults: WebGL `intensity 0.0005`,
DOMRect `max_offset 1`.

## Validate a proxy before binding it

```rust
let res = sdk.check_proxy("socks5://user:pass@host:1080").await?;
println!(
    "udp={:?}ms  quic={}  webrtc={:?}  exit={} ({})",
    res.udp_ms, res.would_enable_quic, res.would_set_webrtc,
    res.geo.ip, res.geo.country_code,
);
```

The same SOCKS5 `UDP_ASSOCIATE` probe the launcher runs decides whether QUIC
is enabled and whether WebRTC is forced to `tcp_only`.

## What `launch` does for you

Before spawning the engine the SDK reproduces the launcher's pre-flight:

* **auto-resolve** — fills `"auto"` timezone / language / geolocation from a
  live geo lookup *through the bound proxy* ([`resolve_auto_fields`]).
* **screen strategy** — `CapToHost` on macOS, `UseHost` on Win/Linux
  ([`apply_screen_strategy`]); override via `LaunchOptions::screen_mode`.
* **UDP probe** — decides QUIC + WebRTC policy from a live relay probe.

## Lower-level building blocks

Everything the façade uses is public and reusable:

```rust
use shardx::{Runtime, FingerprintLibrary, parse_proxy, probe_udp, geo_check_via,
             randomize_hardware, host_screen_size};
```

`Runtime` (download/cache/extract), `FingerprintLibrary` + `Profile`,
`parse_proxy` / `proxy_to_arg` / `probe_udp`, `geo_check_via`,
`randomize_hardware` / `randomize_platform_version`, `host_*` probes, and the
`screen` / `auto_resolve` helpers.

## Links

* **Site:**  [https://shardx.com](https://shardx.com?utm_source=shardx&utm_medium=referral&utm_campaign=shardx-launcher)
* **Docs:**  [https://docs.shardx.com](https://docs.shardx.com?utm_source=shardx&utm_medium=referral&utm_campaign=shardx-launcher)
* **Usage:** [https://docs.shardx.com/eng/usage-instructions/shardx-browser](https://docs.shardx.com/eng/usage-instructions/shardx-browser?utm_source=shardx&utm_medium=referral&utm_campaign=shardx-launcher)

MIT licensed.
