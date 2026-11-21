// SPDX-License-Identifier: MIT
// Project payload from ProxyShard/ShardBrowser src-tauri/src/space/local/automation.rs
// at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e. See LICENSE.upstream.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One recorded step. `kind` and `params` are deliberately open: the block
/// palette grows without a storage migration, and a WASM module can add a kind
/// this build has never heard of.
/// What to do when a step does not work out.
///
/// A flat list cannot express a real script: half of what an operator writes is
/// "and if this is not there, do that instead". Every step therefore carries
/// its own branch, and the runner follows it rather than always falling to the
/// next line.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Branch {
    /// Fall through to the step below. The default.
    #[default]
    Next,
    /// End this profile's whole run.
    Stop,
    /// End this pass; the next one starts from the top.
    EndPass,
    /// Jump to a step by id. An id that no longer exists behaves as Next, so
    /// deleting a step cannot strand the run.
    Goto(String),
    /// Try this same step again, up to `0` more times, then take Next.
    Retry(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Where the block sits on the canvas. Layout only — the run follows the
    /// connections, never the coordinates.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// Where to go when the step succeeds.
    #[serde(default)]
    pub on_done: Branch,
    /// Parameter names whose values must never leave this machine. Emptied on
    /// export and asked for again on import, because a project shared with a
    /// password still in it is a password published.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// Where to go when it fails. Defaults to stopping, because silently
    /// carrying on after a click that found nothing is how a run ends up
    /// typing a password into the wrong page.
    #[serde(default = "stop_branch")]
    pub on_fail: Branch,
}

fn stop_branch() -> Branch {
    Branch::Stop
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSettings {
    /// Browsers running at once.
    #[serde(default = "one")]
    pub threads: u32,
    /// Passes over the block list. 0 means run until `hours` is up.
    #[serde(default = "one")]
    pub loops: u32,
    /// Only meaningful when `loops` is 0.
    #[serde(default)]
    pub hours: f64,
    /// Kept for projects saved before profiles became blocks; ignored.
    #[serde(default)]
    pub profiles: Vec<String>,
    /// Which block the run starts at. Empty means the first in the list, which
    /// is what a project built before the canvas expects.
    #[serde(default)]
    pub start: String,
}

fn one() -> u32 {
    1
}

impl Default for RunSettings {
    fn default() -> Self {
        Self {
            threads: 1,
            loops: 1,
            hours: 0.0,
            profiles: Vec::new(),
            start: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub run: RunSettings,
    /// Request-interception rules mounted (profile-scoped) before the first
    /// navigation of every profile this project drives. Each entry is a rule in
    /// the Traffic domain's JSON format; the launcher never interprets them, it
    /// hands the array to Traffic.mount.
    #[serde(default)]
    pub rules: Vec<Value>,
    /// Unix seconds.
    pub created_at: u64,
    pub updated_at: u64,
    /// A team's revision of it, as read; a save from an older one is stale. None here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}
