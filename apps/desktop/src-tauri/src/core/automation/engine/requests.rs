// SPDX-License-Identifier: MIT
// Ported from ProxyShard/ShardBrowser requests.rs at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
// Copyright (c) ProxyShard. See LICENSE.upstream.

//! Requests the launcher sends itself.
//!
//! Not `fetch` in the page: this leaves the launcher process with a TLS and
//! HTTP/2 fingerprint chosen on purpose, through the profile's own proxy. An
//! API call made beside a browsing session therefore comes from the same
//! address and looks like the same client, which is the whole reason to send
//! it from here rather than from the page.
//!
//! Two modes, and the difference matters:
//!
//!   * **with a session** — the client is kept under a name, so cookies, the
//!     connection pool and the TLS session tickets carry from one step to the
//!     next. This is what a sequence of calls to one site should use.
//!   * **without** — a client is built for the request and dropped. Nothing
//!     carries over, which is what a one-off call to an unrelated service
//!     wants.

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Clients held open by name. Never keyed on the URL: a session is the
/// operator's idea of "the same visitor", and only they know which calls
/// belong to one.
#[derive(Clone)]
struct RequestSession {
    client: wreq::Client,
    proxy: Option<String>,
    fingerprint: Option<String>,
}

fn sessions() -> &'static Mutex<HashMap<String, RequestSession>> {
    static S: OnceLock<Mutex<HashMap<String, RequestSession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every fingerprint this build can wear, by the name it is chosen with —
/// chrome_140, firefox_133, safari_18, okhttp_5 and the rest. Read off the
/// library itself rather than kept in a list here, which would go stale the
/// first time it is updated.
pub fn fingerprints() -> Vec<String> {
    // wreq-util 0.1.0 exports Emulation and no VARIANTS without optional rand
    // dependencies. This inventory is copied from its pinned enum declaration.
    let mut out: Vec<String> = [
        wreq_util::Emulation::Chrome100,
        wreq_util::Emulation::Chrome101,
        wreq_util::Emulation::Chrome104,
        wreq_util::Emulation::Chrome105,
        wreq_util::Emulation::Chrome106,
        wreq_util::Emulation::Chrome107,
        wreq_util::Emulation::Chrome108,
        wreq_util::Emulation::Chrome109,
        wreq_util::Emulation::Chrome110,
        wreq_util::Emulation::Chrome114,
        wreq_util::Emulation::Chrome116,
        wreq_util::Emulation::Chrome117,
        wreq_util::Emulation::Chrome118,
        wreq_util::Emulation::Chrome119,
        wreq_util::Emulation::Chrome120,
        wreq_util::Emulation::Chrome123,
        wreq_util::Emulation::Chrome124,
        wreq_util::Emulation::Chrome126,
        wreq_util::Emulation::Chrome127,
        wreq_util::Emulation::Chrome128,
        wreq_util::Emulation::Chrome129,
        wreq_util::Emulation::Chrome130,
        wreq_util::Emulation::Chrome131,
        wreq_util::Emulation::Chrome132,
        wreq_util::Emulation::Chrome133,
        wreq_util::Emulation::Chrome134,
        wreq_util::Emulation::Chrome135,
        wreq_util::Emulation::Chrome136,
        wreq_util::Emulation::Chrome137,
        wreq_util::Emulation::SafariIos17_2,
        wreq_util::Emulation::SafariIos17_4_1,
        wreq_util::Emulation::SafariIos16_5,
        wreq_util::Emulation::Safari15_3,
        wreq_util::Emulation::Safari15_5,
        wreq_util::Emulation::Safari15_6_1,
        wreq_util::Emulation::Safari16,
        wreq_util::Emulation::Safari16_5,
        wreq_util::Emulation::Safari17_0,
        wreq_util::Emulation::Safari17_2_1,
        wreq_util::Emulation::Safari17_4_1,
        wreq_util::Emulation::Safari17_5,
        wreq_util::Emulation::Safari18,
        wreq_util::Emulation::SafariIPad18,
        wreq_util::Emulation::Safari18_2,
        wreq_util::Emulation::SafariIos18_1_1,
        wreq_util::Emulation::Safari18_3,
        wreq_util::Emulation::Safari18_3_1,
        wreq_util::Emulation::Safari18_5,
        wreq_util::Emulation::OkHttp3_9,
        wreq_util::Emulation::OkHttp3_11,
        wreq_util::Emulation::OkHttp3_13,
        wreq_util::Emulation::OkHttp3_14,
        wreq_util::Emulation::OkHttp4_9,
        wreq_util::Emulation::OkHttp4_10,
        wreq_util::Emulation::OkHttp4_12,
        wreq_util::Emulation::OkHttp5,
        wreq_util::Emulation::Edge101,
        wreq_util::Emulation::Edge122,
        wreq_util::Emulation::Edge127,
        wreq_util::Emulation::Edge131,
        wreq_util::Emulation::Edge134,
        wreq_util::Emulation::Firefox109,
        wreq_util::Emulation::Firefox117,
        wreq_util::Emulation::Firefox128,
        wreq_util::Emulation::Firefox133,
        wreq_util::Emulation::Firefox135,
        wreq_util::Emulation::FirefoxPrivate135,
        wreq_util::Emulation::FirefoxAndroid135,
        wreq_util::Emulation::Firefox136,
        wreq_util::Emulation::FirefoxPrivate136,
        wreq_util::Emulation::Firefox139,
        wreq_util::Emulation::Opera116,
        wreq_util::Emulation::Opera117,
        wreq_util::Emulation::Opera118,
        wreq_util::Emulation::Opera119,
    ]
    .iter()
    .filter_map(|profile| serde_json::to_value(profile).ok())
    .filter_map(|value| value.as_str().map(String::from))
    .collect();
    out.sort();
    out
}

fn parse_fingerprint(name: &str) -> Result<wreq_util::Emulation> {
    serde_json::from_value(Value::String(name.trim().to_string()))
        .map_err(|_| anyhow!("unknown TLS fingerprint \"{name}\""))
}

/// What one call needs. Everything optional has a sane absence: no
/// fingerprint means wreq's own default, no session means a throwaway client,
/// no proxy means straight out of this machine.
pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub fingerprint: Option<String>,
    pub session: Option<String>,
    pub proxy: Option<String>,
    pub timeout_s: f64,
}

fn build_client(
    fingerprint: Option<&str>,
    proxy: Option<&str>,
    timeout: Duration,
    keep_cookies: bool,
) -> Result<wreq::Client> {
    let mut b = wreq::Client::builder().no_proxy().timeout(timeout);
    if let Some(name) = fingerprint.filter(|s| !s.trim().is_empty()) {
        b = b.emulation(parse_fingerprint(name)?);
    }
    if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
        b = b.proxy(wreq::Proxy::all(p).context("invalid request proxy")?);
    }
    // Only a session keeps a jar. A throwaway client that stored cookies would
    // still throw them away, and asking for one costs a lock per request.
    b = b.cookie_store(keep_cookies);
    b.build().context("building the request client")
}

/// Sends one request and returns `{ status, headers, body }`.
pub async fn send(req: Request) -> Result<Value> {
    if !req.timeout_s.is_finite() {
        return Err(anyhow!("request timeout must be finite"));
    }
    let timeout = Duration::from_secs_f64(req.timeout_s.clamp(1.0, 600.0));
    let session = req.session.as_deref().filter(|s| !s.trim().is_empty());

    let client = match session {
        Some(name) => {
            // Built once and reused. A session that changed its fingerprint or
            // its proxy halfway would be two visitors wearing one name, so the
            // first call's choices are the session's for its whole life — say
            // so rather than silently ignoring the later ones.
            let mut sessions = sessions()
                .lock()
                .map_err(|_| anyhow!("session lock poisoned"))?;
            match sessions.get(name) {
                Some(existing) => {
                    validate_session(existing, req.proxy.as_deref(), req.fingerprint.as_deref())?;
                    existing.client.clone()
                }
                None => {
                    let client = build_client(
                        req.fingerprint.as_deref(),
                        req.proxy.as_deref(),
                        timeout,
                        true,
                    )?;
                    sessions.insert(
                        name.to_string(),
                        RequestSession {
                            client: client.clone(),
                            proxy: req.proxy.clone(),
                            fingerprint: req.fingerprint.clone(),
                        },
                    );
                    client
                }
            }
        }

        None => build_client(
            req.fingerprint.as_deref(),
            req.proxy.as_deref(),
            timeout,
            false,
        )?,
    };

    let method: wreq::Method = req
        .method
        .trim()
        .to_uppercase()
        .parse()
        .map_err(|_| anyhow!("\"{}\" is not an HTTP method", req.method))?;

    let mut rb = client.request(method, req.url.trim()).timeout(timeout);
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(body) = req.body.filter(|b| !b.is_empty()) {
        rb = rb.body(body);
    }

    super::cdp::record_effect();
    let resp = rb.send().await.map_err(super::host::outcome_unknown)?;
    let status = resp.status().as_u16();
    let mut headers = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        headers.insert(
            k.as_str().to_string(),
            Value::String(v.to_str().unwrap_or("").to_string()),
        );
    }
    let body = resp.text().await.map_err(super::host::outcome_unknown)?;
    Ok(json!({ "status": status, "headers": headers, "body": body }))
}

/// Forgets a session, cookies and all. A run that ends without this leaves its
/// jar behind for the next one, which is a logged-in visitor arriving out of
/// nowhere.
pub fn drop_session(name: &str) {
    if let Ok(mut g) = sessions().lock() {
        g.remove(name);
    }
}

/// Forgets every session. Called when a run finishes.
pub fn drop_all_sessions() {
    if let Ok(mut g) = sessions().lock() {
        g.clear();
    }
}

/// Drop handles for exactly one connection/run. Worker names retain this prefix.
pub fn drop_scope(scope: &str) {
    if let Ok(mut handles) = sessions().lock() {
        let prefix = format!("{scope}:");
        handles.retain(|name, _| !name.starts_with(&prefix));
    }
}

fn validate_session(
    session: &RequestSession,
    proxy: Option<&str>,
    fingerprint: Option<&str>,
) -> Result<()> {
    if session.proxy.as_deref() != proxy || session.fingerprint.as_deref() != fingerprint {
        return Err(anyhow!(
            "HTTP session routing or fingerprint changed; end this session or choose another name"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_session_refuses_proxy_and_fingerprint_changes() {
        let session = RequestSession {
            client: wreq::Client::new(),
            proxy: Some("socks5://127.0.0.1:18080".into()),
            fingerprint: Some("chrome_133".into()),
        };
        assert!(
            validate_session(
                &session,
                Some("socks5://127.0.0.1:18080"),
                Some("chrome_133")
            )
            .is_ok()
        );
        assert!(validate_session(&session, None, Some("chrome_133")).is_err());
        assert!(
            validate_session(
                &session,
                Some("socks5://127.0.0.1:18081"),
                Some("chrome_133")
            )
            .is_err()
        );
        assert!(
            validate_session(
                &session,
                Some("socks5://127.0.0.1:18080"),
                Some("firefox_133")
            )
            .is_err()
        );
    }
}
