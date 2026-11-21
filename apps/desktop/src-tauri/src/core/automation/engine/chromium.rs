// SPDX-License-Identifier: MIT
//! Standard Chromium adaptation for the upstream Motion/Script/Traffic calls.
//!
//! Input delivers ordered browser input. It does not reproduce ShardBrowser's
//! native Motion trajectories, timing, physical handset or fingerprint behavior.
//! The host must verify capabilities before selecting this adapter.

use super::{cdp::Session, host};
use anyhow::{Context, Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};

#[derive(Default)]
pub(super) struct State {
    pointer: Mutex<(f64, f64)>,
    rules: Mutex<Vec<(String, Value)>>,
    paused: Mutex<HashMap<String, Value>>,
    error: Mutex<Option<String>>,
}

impl State {
    pub(super) fn set_error(&self, error: anyhow::Error) {
        if let Ok(mut slot) = self.error.lock() {
            *slot = Some(error.to_string());
        }
    }
}

async fn raw(session: &Session, method: &str, params: Value, page: &str) -> Result<Value> {
    super::cdp::record_write(method);
    session.call(method, params, Some(page)).await
}

pub(super) async fn call(
    session: &Session,
    method: &str,
    params: Value,
    page: &str,
) -> Result<Value> {
    if let Some(reason) = session
        .adapter
        .error
        .lock()
        .map_err(|_| anyhow!("adapter lock"))?
        .as_ref()
    {
        return Err(host::outcome_unknown(format!(
            "request interception needs reconciliation: {reason}"
        )));
    }
    if method.starts_with("Motion.") {
        if !session.capabilities.chromium_input {
            return Err(anyhow!(
                "standard Chromium input capability is not verified"
            ));
        }
        return motion(session, method, params, page).await;
    }
    if method == "Script.run" {
        if !session.capabilities.script {
            return Err(anyhow!(
                "standard Chromium scripting capability is not verified"
            ));
        }
        let source = params
            .get("source")
            .and_then(Value::as_str)
            .context("script has no source")?;
        let mut arguments = json!({
            "expression": source, "awaitPromise": true, "returnByValue": true
        });
        if params.get("world").and_then(Value::as_str) != Some("main") {
            let tree = raw(session, "Page.getFrameTree", json!({}), page).await?;
            let frame = tree
                .pointer("/frameTree/frame/id")
                .and_then(Value::as_str)
                .context("no main frame")?;
            let world = raw(
                session,
                "Page.createIsolatedWorld",
                json!({
                    "frameId": frame, "worldName": "raccoon-automation"
                }),
                page,
            )
            .await?;
            arguments["contextId"] = world
                .get("executionContextId")
                .cloned()
                .context("no isolated context")?;
        }
        let result = raw(session, "Runtime.evaluate", arguments, page).await?;
        if result.get("exceptionDetails").is_some() {
            // User script may have performed writes before throwing.
            return Err(host::outcome_unknown("script threw after execution began"));
        }
        let value = result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null);
        return Ok(json!({ "result": serde_json::to_string(&value)? }));
    }
    if method.starts_with("Traffic.") {
        if method == "Traffic.setProxy" {
            return Err(anyhow!(
                "this Chromium adapter has no proxy hot swap capability"
            ));
        }
        if !session.capabilities.traffic {
            return Err(anyhow!(
                "standard Network/Fetch interception capability is not verified"
            ));
        }
        return traffic(session, method, params, page).await;
    }
    raw(session, method, params, page).await
}

fn number(params: &Value, name: &str, default: f64) -> f64 {
    params
        .get(name)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}

fn pointer(session: &Session) -> Result<(f64, f64)> {
    Ok(*session
        .adapter
        .pointer
        .lock()
        .map_err(|_| anyhow!("pointer lock"))?)
}

async fn mouse(
    session: &Session,
    page: &str,
    kind: &str,
    point: (f64, f64),
    button: &str,
    buttons: u8,
    count: u32,
) -> Result<Value> {
    raw(
        session,
        "Input.dispatchMouseEvent",
        json!({
            "type": kind, "x": point.0, "y": point.1,
            "button": button, "buttons": buttons, "clickCount": count,
        }),
        page,
    )
    .await
}

fn button_mask(button: &str) -> u8 {
    match button {
        "right" => 2,
        "middle" => 4,
        "back" => 8,
        "forward" => 16,
        _ => 1,
    }
}

async fn motion(session: &Session, method: &str, params: Value, page: &str) -> Result<Value> {
    let old = pointer(session)?;
    let point = (number(&params, "x", old.0), number(&params, "y", old.1));
    match method {
        "Motion.createPointer" | "Motion.glideTo" => {
            let result = mouse(session, page, "mouseMoved", point, "none", 0, 0).await?;
            *session
                .adapter
                .pointer
                .lock()
                .map_err(|_| anyhow!("pointer lock"))? = point;
            Ok(result)
        }
        "Motion.tap" => {
            let button = params
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or("left");
            let (button, count) = tap_button(button, number(&params, "clickCount", 1.0));
            for click in 1..=count {
                mouse(
                    session,
                    page,
                    "mousePressed",
                    point,
                    button,
                    button_mask(button),
                    click,
                )
                .await?;
                mouse(session, page, "mouseReleased", point, button, 0, click).await?;
            }
            Ok(json!({}))
        }
        "Motion.dragTo" => {
            let button = params
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or("left");
            mouse(
                session,
                page,
                "mousePressed",
                old,
                button,
                button_mask(button),
                1,
            )
            .await?;
            mouse(
                session,
                page,
                "mouseMoved",
                point,
                button,
                button_mask(button),
                1,
            )
            .await?;
            let result = mouse(session, page, "mouseReleased", point, button, 0, 1).await?;
            *session
                .adapter
                .pointer
                .lock()
                .map_err(|_| anyhow!("pointer lock"))? = point;
            Ok(result)
        }
        "Motion.wheel" => raw(
            session,
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel", "x": old.0, "y": old.1,
                "deltaX": number(&params, "deltaX", 0.0), "deltaY": number(&params, "deltaY", 0.0),
            }),
            page,
        )
        .await,
        "Motion.enterText" => {
            raw(
                session,
                "Input.insertText",
                json!({
                    "text": params.get("text").and_then(Value::as_str).unwrap_or("")
                }),
                page,
            )
            .await
        }
        "Motion.pressKey" => press_key(session, params, page).await,
        "Motion.touchTap"
        | "Motion.touchLongPress"
        | "Motion.touchSwipe"
        | "Motion.touchDrag"
        | "Motion.pinch" => {
            if !session.capabilities.touch {
                return Err(anyhow!("touch capability is not verified"));
            }
            touch(session, method, params, page).await
        }
        "Motion.setOrientation" => {
            if !session.capabilities.touch {
                return Err(anyhow!("orientation capability is not verified"));
            }
            let angle = number(&params, "angle", 0.0) as i64;
            let orientation = match angle {
                0 => "portraitPrimary",
                90 => "landscapePrimary",
                180 => "portraitSecondary",
                270 => "landscapeSecondary",
                _ => return Err(anyhow!("invalid screen angle")),
            };
            let metrics = raw(session, "Page.getLayoutMetrics", json!({}), page).await?;
            let viewport = metrics
                .get("cssLayoutViewport")
                .or_else(|| metrics.get("layoutViewport"))
                .context("no viewport metrics")?;
            let width = number(viewport, "clientWidth", 0.0) as i64;
            let height = number(viewport, "clientHeight", 0.0) as i64;
            if width <= 0 || height <= 0 {
                return Err(anyhow!("invalid viewport dimensions"));
            }
            let (short, long) = (width.min(height), width.max(height));
            let (width, height) = if angle % 180 == 0 {
                (short, long)
            } else {
                (long, short)
            };
            raw(
                session,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": width, "height": height, "deviceScaleFactor": 0, "mobile": true,
                    "screenWidth": width, "screenHeight": height,
                    "screenOrientation": { "angle": angle, "type": orientation }
                }),
                page,
            )
            .await?;
            Ok(json!({ "type": orientation }))
        }
        _ => Err(anyhow!("unknown Motion operation {method}")),
    }
}

fn key_code(key: &str) -> u32 {
    match key {
        "Backspace" => 8,
        "Tab" => 9,
        "Enter" => 13,
        "Shift" => 16,
        "Control" => 17,
        "Alt" => 18,
        "Escape" | "Esc" => 27,
        " " | "Space" => 32,
        "PageUp" => 33,
        "PageDown" => 34,
        "End" => 35,
        "Home" => 36,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "Insert" => 45,
        "Delete" => 46,
        "Meta" => 91,
        _ if key.len() == 1 => key.as_bytes()[0].to_ascii_uppercase() as u32,
        _ => key
            .strip_prefix('F')
            .and_then(|number| number.parse::<u32>().ok())
            .filter(|number| (1..=24).contains(number))
            .map(|number| 111 + number)
            .unwrap_or(0),
    }
}

fn tap_button(button: &str, count: f64) -> (&str, u32) {
    match button {
        "double" => ("left", 2),
        _ => (button, count.clamp(1.0, 3.0) as u32),
    }
}

async fn press_key(session: &Session, params: Value, page: &str) -> Result<Value> {
    let key = params
        .get("key")
        .and_then(Value::as_str)
        .context("no key")?;
    let mut modifiers = 0;
    if let Some(names) = params.get("modifiers").and_then(Value::as_array) {
        for name in names {
            modifiers |= match name.as_str().unwrap_or("").to_ascii_lowercase().as_str() {
                "alt" => 1,
                "control" | "ctrl" => 2,
                "meta" | "command" | "cmd" => 4,
                "shift" => 8,
                "accel" => {
                    if cfg!(target_os = "macos") {
                        4
                    } else {
                        2
                    }
                }
                other => return Err(anyhow!("unknown keyboard modifier {other}")),
            };
        }
    }
    let mut arguments = json!({ "type": "keyDown", "key": key, "modifiers": modifiers,
        "windowsVirtualKeyCode": key_code(key) });
    if key.chars().count() == 1 && modifiers & 7 == 0 {
        arguments["text"] = json!(key);
    }
    raw(session, "Input.dispatchKeyEvent", arguments.clone(), page).await?;
    let hold = number(&params, "holdMs", 0.0).clamp(0.0, 60_000.0);
    if hold > 0.0 {
        tokio::time::sleep(Duration::from_secs_f64(hold / 1000.0)).await;
    }
    arguments["type"] = json!("keyUp");
    arguments.as_object_mut().expect("key event").remove("text");
    raw(session, "Input.dispatchKeyEvent", arguments, page).await
}

async fn touch(session: &Session, method: &str, params: Value, page: &str) -> Result<Value> {
    let from = (
        number(&params, "fromX", number(&params, "x", 0.0)),
        number(&params, "fromY", number(&params, "y", 0.0)),
    );
    if method == "Motion.pinch" {
        return raw(
            session,
            "Input.synthesizePinchGesture",
            json!({
                "x": from.0, "y": from.1, "scaleFactor": number(&params, "scale", 2.0),
                "gestureSourceType": "touch",
            }),
            page,
        )
        .await;
    }
    let count = number(&params, "tapCount", 1.0).clamp(1.0, 3.0) as usize;
    for _ in 0..count {
        raw(
            session,
            "Input.dispatchTouchEvent",
            json!({
                "type": "touchStart", "touchPoints": [{ "x": from.0, "y": from.1, "id": 1 }]
            }),
            page,
        )
        .await?;
        let hold = if method == "Motion.touchLongPress" {
            650.0
        } else {
            number(&params, "holdMs", 0.0)
        };
        if hold > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(hold.clamp(0.0, 60_000.0) / 1000.0)).await;
        }
        if matches!(method, "Motion.touchSwipe" | "Motion.touchDrag") {
            let to = (
                number(&params, "toX", from.0),
                number(&params, "toY", from.1),
            );
            for index in 1..=12 {
                let fraction = index as f64 / 12.0;
                raw(
                    session,
                    "Input.dispatchTouchEvent",
                    json!({
                        "type": "touchMove", "touchPoints": [{
                            "x": from.0 + (to.0 - from.0) * fraction,
                            "y": from.1 + (to.1 - from.1) * fraction, "id": 1
                        }]
                    }),
                    page,
                )
                .await?;
                tokio::time::sleep(Duration::from_millis(16)).await;
            }
        }
        raw(
            session,
            "Input.dispatchTouchEvent",
            json!({ "type": "touchEnd", "touchPoints": [] }),
            page,
        )
        .await?;
    }
    Ok(json!({}))
}

fn validate_rule(rule: &Value) -> Result<()> {
    let matcher = rule
        .get("match")
        .and_then(Value::as_object)
        .context("rule has no match")?;
    for (name, value) in matcher {
        if !["url", "host", "method", "resource", "urlRegex", "hostRegex"].contains(&name.as_str())
            || !value.is_string()
        {
            return Err(anyhow!("unsupported Chromium traffic match field {name}"));
        }
        if name.ends_with("Regex") {
            regex::Regex::new(value.as_str().unwrap_or("")).context("invalid traffic regex")?;
        }
    }
    let action = rule
        .get("action")
        .and_then(Value::as_object)
        .context("rule has no action")?;
    let kind = action
        .get("type")
        .and_then(Value::as_str)
        .context("rule has no action type")?;
    if !["continue", "modify", "block", "redirect", "fulfill"].contains(&kind) {
        return Err(anyhow!("unsupported traffic action {kind}"));
    }
    for name in action.keys() {
        if ![
            "type",
            "setHeaders",
            "removeHeaders",
            "setMethod",
            "setUrl",
            "setBody",
            "delayMs",
            "blockReason",
            "status",
            "responseHeaders",
            "responseBody",
            "setResponseHeaders",
            "removeResponseHeaders",
            "setStatus",
            "setResponseBody",
        ]
        .contains(&name.as_str())
        {
            return Err(anyhow!("unsupported traffic action field {name}"));
        }
    }
    Ok(())
}

async fn enable_fetch(session: &Session, page: &str) -> Result<Value> {
    raw(
        session,
        "Fetch.enable",
        json!({ "patterns": [
        { "urlPattern": "*", "requestStage": "Request" },
        { "urlPattern": "*", "requestStage": "Response" }
    ] }),
        page,
    )
    .await
}

async fn traffic(session: &Session, method: &str, params: Value, page: &str) -> Result<Value> {
    match method {
        "Traffic.observe" => {
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            raw(
                session,
                if enabled {
                    "Network.enable"
                } else {
                    "Network.disable"
                },
                json!({}),
                page,
            )
            .await
        }
        "Traffic.mount" => {
            let rules: Vec<Value> = serde_json::from_str(
                params
                    .get("rules")
                    .and_then(Value::as_str)
                    .context("rules must be JSON")?,
            )?;
            for rule in &rules {
                validate_rule(rule)?;
            }
            let id = uuid::Uuid::new_v4().to_string();
            enable_fetch(session, page).await?;
            session
                .adapter
                .rules
                .lock()
                .map_err(|_| anyhow!("rules lock"))?
                .extend(rules.into_iter().map(|rule| (id.clone(), rule)));
            Ok(json!({ "ruleSetId": id }))
        }
        "Traffic.unmount" | "Traffic.clear" => {
            let empty = {
                let mut rules = session
                    .adapter
                    .rules
                    .lock()
                    .map_err(|_| anyhow!("rules lock"))?;
                if method == "Traffic.clear" {
                    rules.clear();
                } else {
                    rules.retain(|(id, _)| {
                        Some(id.as_str()) != params.get("ruleSetId").and_then(Value::as_str)
                    });
                }
                rules.is_empty()
            };
            if empty {
                raw(session, "Fetch.disable", json!({}), page).await?;
            }
            Ok(json!({}))
        }
        "Traffic.list" => {
            let rules: Vec<Value> = session
                .adapter
                .rules
                .lock()
                .map_err(|_| anyhow!("rules lock"))?
                .iter()
                .map(|(_, rule)| rule.clone())
                .collect();
            Ok(json!({ "rulesJson": serde_json::to_string(&rules)? }))
        }
        "Traffic.resolve" => {
            let id = params
                .get("requestId")
                .and_then(Value::as_str)
                .context("no request id")?;
            let event = session
                .adapter
                .paused
                .lock()
                .map_err(|_| anyhow!("paused lock"))?
                .get(id)
                .cloned()
                .context("request is not paused")?;
            let action = match params.get("action").and_then(Value::as_str) {
                Some(action) => serde_json::from_str(action)?,
                None => json!({ "type": "continue" }),
            };
            resolve(session, &event, &action, page).await?;
            session
                .adapter
                .paused
                .lock()
                .map_err(|_| anyhow!("paused lock"))?
                .remove(id);
            Ok(json!({}))
        }
        _ => Err(anyhow!("unknown Traffic operation {method}")),
    }
}

fn glob(pattern: &str, value: &str) -> bool {
    let escaped = regex::escape(pattern)
        .replace("\\*", ".*")
        .replace("\\?", ".");
    regex::Regex::new(&format!("^{escaped}$"))
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}

fn matches(rule: &Value, event: &Value) -> bool {
    let Some(matcher) = rule.get("match").and_then(Value::as_object) else {
        return false;
    };
    let url = event
        .pointer("/request/url")
        .and_then(Value::as_str)
        .unwrap_or("");
    let parsed = url::Url::parse(url).ok();
    matcher.iter().all(|(name, pattern)| {
        let value = match name.as_str() {
            "url" | "urlRegex" => url,
            "host" | "hostRegex" => parsed.as_ref().and_then(url::Url::host_str).unwrap_or(""),
            "method" => event
                .pointer("/request/method")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "resource" => event
                .get("resourceType")
                .and_then(Value::as_str)
                .unwrap_or(""),
            _ => return false,
        };
        let pattern = pattern.as_str().unwrap_or("");
        if name.ends_with("Regex") {
            regex::Regex::new(pattern)
                .map(|regex| regex.is_match(value))
                .unwrap_or(false)
        } else if name == "method" || name == "resource" {
            glob(&pattern.to_ascii_lowercase(), &value.to_ascii_lowercase())
        } else {
            glob(pattern, value)
        }
    })
}

/// Runs outside the socket reader, so CDP replies can continue to arrive.
pub(super) async fn intercept(session: &Session, event: Value) -> Result<()> {
    let _gate = session.interception_gate.lock().await;
    if session.releasing.load(std::sync::atomic::Ordering::Acquire) {
        // Fetch.disable releases requests that arrive while teardown drains.
        return Ok(());
    }
    let page = session.page().context("interception lost target")?;
    let response =
        event.get("responseStatusCode").is_some() || event.get("responseErrorReason").is_some();
    let selected = {
        let rules = session
            .adapter
            .rules
            .lock()
            .map_err(|_| anyhow!("rules lock"))?;
        rules
            .iter()
            .find(|(_, rule)| {
                let action = &rule["action"];
                let response_action = [
                    "setResponseHeaders",
                    "removeResponseHeaders",
                    "setStatus",
                    "setResponseBody",
                ]
                .iter()
                .any(|key| action.get(*key).is_some());
                response == response_action && matches(rule, &event)
            })
            .map(|(_, rule)| rule.clone())
    };
    if let Some(rule) = selected {
        if rule.get("await").and_then(Value::as_bool).unwrap_or(false) {
            let id = event
                .get("requestId")
                .and_then(Value::as_str)
                .context("no paused request id")?;
            session
                .adapter
                .paused
                .lock()
                .map_err(|_| anyhow!("paused lock"))?
                .insert(id.into(), event);
            return Ok(());
        }
        resolve(session, &event, &rule["action"], &page).await
    } else {
        resolve(session, &event, &json!({ "type": "continue" }), &page).await
    }
}

pub(super) async fn release(session: &Session, page: &str) -> Result<()> {
    let pending: Vec<Value> = session
        .adapter
        .paused
        .lock()
        .map_err(|_| anyhow!("paused lock"))?
        .values()
        .cloned()
        .collect();
    // Each confirmation retires only its own paused request. On a disconnect,
    // leave the remaining state available to the caller's reconciliation.
    for event in pending {
        let method = if event.get("responseStatusCode").is_some()
            || event.get("responseErrorReason").is_some()
        {
            "Fetch.continueResponse"
        } else {
            "Fetch.continueRequest"
        };
        session
            .call_cleanup(
                method,
                json!({ "requestId": event.get("requestId").context("no paused request id")? }),
                Some(page),
            )
            .await?;
        if let Some(id) = event.get("requestId").and_then(Value::as_str) {
            session
                .adapter
                .paused
                .lock()
                .map_err(|_| anyhow!("paused lock"))?
                .remove(id);
        }
    }
    session
        .call_cleanup("Fetch.disable", json!({}), Some(page))
        .await?;
    session
        .call_cleanup("Network.disable", json!({}), Some(page))
        .await?;
    session
        .adapter
        .rules
        .lock()
        .map_err(|_| anyhow!("rules lock"))?
        .clear();
    Ok(())
}

fn headers(existing: &Value, set: Option<&Value>, remove: Option<&Value>) -> Vec<Value> {
    let mut result: Vec<Value> = match existing {
        Value::Array(headers) => headers.clone(),
        Value::Object(headers) => headers
            .iter()
            .map(|(name, value)| {
                json!({
                    "name": name, "value": value.as_str().unwrap_or("")
                })
            })
            .collect(),
        _ => Vec::new(),
    };
    let remove: Vec<&str> = remove
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    result.retain(|header| {
        !remove.iter().any(|name| {
            header
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .eq_ignore_ascii_case(name)
        })
    });
    if let Some(set) = set.and_then(Value::as_array) {
        for header in set {
            let name = header.get("name").and_then(Value::as_str).unwrap_or("");
            result.retain(|existing| {
                !existing
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .eq_ignore_ascii_case(name)
            });
            result.push(header.clone());
        }
    }
    result
}

async fn resolve(session: &Session, event: &Value, action: &Value, page: &str) -> Result<()> {
    let id = event.get("requestId").cloned().context("no request id")?;
    let delay = number(action, "delayMs", 0.0).clamp(0.0, 60_000.0);
    if delay > 0.0 {
        tokio::time::sleep(Duration::from_secs_f64(delay / 1000.0)).await;
    }
    let response =
        event.get("responseStatusCode").is_some() || event.get("responseErrorReason").is_some();
    let kind = action
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("continue");
    if kind == "block" {
        raw(
            session,
            "Fetch.failRequest",
            json!({
                "requestId": id, "errorReason": "BlockedByClient"
            }),
            page,
        )
        .await?;
    } else if kind == "fulfill" || response && kind == "modify" {
        let body = if let Some(body) = action
            .get("responseBody")
            .or_else(|| action.get("setResponseBody"))
        {
            STANDARD.encode(body.as_str().unwrap_or("").as_bytes())
        } else if response {
            let result = raw(
                session,
                "Fetch.getResponseBody",
                json!({ "requestId": id }),
                page,
            )
            .await?;
            let body = result.get("body").and_then(Value::as_str).unwrap_or("");
            if result
                .get("base64Encoded")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                body.into()
            } else {
                STANDARD.encode(body.as_bytes())
            }
        } else {
            String::new()
        };
        let mut hs = headers(
            event.get("responseHeaders").unwrap_or(&Value::Null),
            action
                .get("responseHeaders")
                .or_else(|| action.get("setResponseHeaders")),
            action.get("removeResponseHeaders"),
        );
        // Chromium's body is already decoded. Old wire lengths and compression
        // headers would describe different bytes after fulfillment.
        hs.retain(|header| {
            !["content-length", "content-encoding", "transfer-encoding"]
                .iter()
                .any(|name| {
                    header
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .eq_ignore_ascii_case(name)
                })
        });
        raw(session, "Fetch.fulfillRequest", json!({
            "requestId": id, "responseCode": action.get("status").or_else(|| action.get("setStatus"))
                .or_else(|| event.get("responseStatusCode")).cloned().unwrap_or(json!(200)),
            "responseHeaders": hs, "body": body,
        }), page).await?;
    } else if response {
        raw(
            session,
            "Fetch.continueResponse",
            json!({ "requestId": id }),
            page,
        )
        .await?;
    } else {
        let mut arguments = json!({ "requestId": id });
        for (from, to) in [("setUrl", "url"), ("setMethod", "method")] {
            if let Some(value) = action.get(from) {
                arguments[to] = value.clone();
            }
        }
        if let Some(body) = action.get("setBody").and_then(Value::as_str) {
            arguments["postData"] = json!(STANDARD.encode(body.as_bytes()));
        }
        if action.get("setHeaders").is_some() || action.get("removeHeaders").is_some() {
            arguments["headers"] = json!(headers(
                event.pointer("/request/headers").unwrap_or(&Value::Null),
                action.get("setHeaders"),
                action.get("removeHeaders")
            ));
        }
        raw(session, "Fetch.continueRequest", arguments, page).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_double_button_maps_to_left_double_click() {
        assert_eq!(tap_button("double", 1.0), ("left", 2));
        assert_eq!(tap_button("right", 1.0), ("right", 1));
        assert_eq!(tap_button("left", 2.0), ("left", 2));
    }

    #[test]
    fn traffic_matching_combines_url_host_method_and_regex() {
        let rule = json!({ "match": { "host": "*.example.test", "method": "post",
            "urlRegex": "/orders/[0-9]+$" }, "action": { "type": "block" } });
        assert!(validate_rule(&rule).is_ok());
        assert!(matches(
            &rule,
            &json!({ "request": {
            "url": "https://api.example.test/orders/42", "method": "POST" } })
        ));
        assert!(!matches(
            &rule,
            &json!({ "request": {
            "url": "https://api.example.test/orders/42", "method": "GET" } })
        ));
    }

    #[test]
    fn header_replacements_and_removals_ignore_case() {
        let existing = json!({ "X-Token": "old", "Accept": "text/plain" });
        let set = json!([{ "name": "x-token", "value": "new" }]);
        let remove = json!(["ACCEPT"]);
        assert_eq!(
            headers(&existing, Some(&set), Some(&remove)),
            vec![json!({
                "name": "x-token", "value": "new"
            })]
        );
    }

    #[test]
    fn unknown_traffic_fields_fail_before_interception() {
        assert!(
            validate_rule(&json!({ "match": { "futureField": "x" },
            "action": { "type": "block" } }))
            .is_err()
        );
    }
}
