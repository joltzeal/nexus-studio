//! ShardBrowser automation engine port.
//!
//! Upstream ProxyShard/ShardBrowser, MIT, commit
//! 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
//! The service owns persistence, resource leases and Provider dispatch through
//! [`host::EngineHost`]. It must initialize [`wasm::initialize`] once with the
//! v2 application root before using modules.

pub mod cdp;
mod chromium;
pub mod db;
pub mod host;
pub mod model;
pub mod modguard;
pub mod requests;
pub mod runner;
pub mod wasm;

pub use host::{BoxFuture, EngineHost, EngineScope};
pub use model::{Block, Branch, Project, RunSettings};

#[cfg(test)]
mod test_host;
