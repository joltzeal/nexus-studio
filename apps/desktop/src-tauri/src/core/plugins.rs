use std::collections::HashMap;
use std::future::Future;

pub const PLUGIN_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    ProxyProvider,
    PlatformAdapter,
    VerificationCodeProvider,
    ImageProvider,
    EnvironmentConfigurator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginDescriptor {
    pub id: String,
    pub api_version: u32,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginError {
    InvalidDescriptor,
    UnsupportedApiVersion,
    AlreadyRegistered,
    NotRegistered,
    CapabilityMissing,
    Unavailable,
}

#[derive(Default)]
pub struct PluginRegistry {
    plugins: HashMap<String, PluginDescriptor>,
}

impl PluginRegistry {
    pub fn register(&mut self, descriptor: PluginDescriptor) -> Result<(), PluginError> {
        if descriptor.id.trim().is_empty() || descriptor.capabilities.is_empty() {
            return Err(PluginError::InvalidDescriptor);
        }
        if descriptor.api_version != PLUGIN_API_VERSION {
            return Err(PluginError::UnsupportedApiVersion);
        }
        if self.plugins.contains_key(&descriptor.id) {
            return Err(PluginError::AlreadyRegistered);
        }
        self.plugins.insert(descriptor.id.clone(), descriptor);
        Ok(())
    }

    pub fn require(&self, plugin_id: &str, capability: Capability) -> Result<(), PluginError> {
        let descriptor = self
            .plugins
            .get(plugin_id)
            .ok_or(PluginError::NotRegistered)?;
        if descriptor.capabilities.contains(&capability) {
            Ok(())
        } else {
            Err(PluginError::CapabilityMissing)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyReference {
    pub config_handle: String,
    pub secret_ref: Option<String>,
}

pub trait ProxyProviderPort {
    fn resolve_proxy(
        &self,
        plugin_id: &str,
        window_id: &str,
        endpoint_id: Option<i64>,
    ) -> impl Future<Output = Result<ProxyReference, PluginError>> + Send;
}
