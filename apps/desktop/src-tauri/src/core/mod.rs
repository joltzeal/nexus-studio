pub mod external_url;
pub mod group_store;
pub mod kernel_service;
pub mod license_service;
pub mod license_store;
pub mod network_proxy;
pub mod plugin_host;
pub mod plugin_service;
pub mod plugins;
pub mod profile_service;
pub mod profile_store;
pub mod runtime_paths;
pub mod scheduler;
pub mod transfer_archive;
pub mod transfer_service;
pub mod updater_service;

use plugins::{Capability, PluginError, PluginRegistry, ProxyProviderPort};
use scheduler::{LaunchRequest, LaunchSnapshot, ProxyBinding, Scheduler, SchedulerError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyChoice {
    Direct,
    /// `endpoint_id` pins one row of the provider's inventory.
    Required {
        plugin_id: String,
        endpoint_id: Option<i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowIntent {
    pub window_id: String,
    pub profile_id: String,
    pub channel_id: String,
    pub proxy: ProxyChoice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    Scheduler(SchedulerError),
    Plugin(PluginError),
    ProxyResolutionFailed,
}

pub struct Core<P> {
    pub scheduler: Scheduler,
    pub plugins: PluginRegistry,
    proxy_port: P,
}

impl<P: ProxyProviderPort> Core<P> {
    pub fn new(proxy_port: P) -> Self {
        Self {
            scheduler: Scheduler::default(),
            plugins: PluginRegistry::default(),
            proxy_port,
        }
    }

    pub async fn reserve_window(
        &mut self,
        intent: WindowIntent,
    ) -> Result<LaunchSnapshot, CoreError> {
        let proxy = match &intent.proxy {
            ProxyChoice::Direct => ProxyBinding::Direct,
            ProxyChoice::Required {
                plugin_id,
                endpoint_id,
            } => {
                self.plugins
                    .require(plugin_id, Capability::ProxyProvider)
                    .map_err(CoreError::Plugin)?;
                let reference = self
                    .proxy_port
                    .resolve_proxy(plugin_id, &intent.window_id, *endpoint_id)
                    .await
                    .map_err(|_| CoreError::ProxyResolutionFailed)?;
                if reference.config_handle.trim().is_empty()
                    || reference
                        .secret_ref
                        .as_ref()
                        .is_some_and(|value| value.trim().is_empty())
                {
                    return Err(CoreError::ProxyResolutionFailed);
                }
                ProxyBinding::Required {
                    plugin_id: plugin_id.clone(),
                    config_handle: reference.config_handle,
                    secret_ref: reference.secret_ref,
                }
            }
        };
        self.scheduler
            .reserve(LaunchRequest {
                window_id: intent.window_id,
                profile_id: intent.profile_id,
                channel_id: intent.channel_id,
                proxy,
            })
            .map_err(CoreError::Scheduler)
    }
}

#[cfg(test)]
mod group_store_tests;
#[cfg(test)]
mod license_service_tests;
#[cfg(test)]
mod license_store_tests;
#[cfg(test)]
mod profile_launch_tests;
#[cfg(test)]
mod profile_store_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transfer_archive_tests;
