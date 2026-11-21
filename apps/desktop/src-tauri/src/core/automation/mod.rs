//! Raccoon-owned automation persistence, engine host, and scoped desktop commands.
pub mod commands;
pub mod engine;
pub mod helper;
pub mod host;
pub mod http;
pub mod store;

pub use host::AutomationService;

#[cfg(test)]
mod tests;
