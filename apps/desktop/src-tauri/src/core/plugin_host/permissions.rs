use super::manifest::Capability;
use super::process::ReadyInfo;
use super::registry::InstalledPlugin;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionError {
    NotInstalled,
    NotEnabled,
    CapabilityUndeclared,
    CapabilityNotGranted,
    MethodNotDeclared,
    DomainUndeclared,
}

impl PermissionError {
    pub fn code(self) -> &'static str {
        match self {
            PermissionError::NotInstalled
            | PermissionError::NotEnabled
            | PermissionError::CapabilityUndeclared
            | PermissionError::CapabilityNotGranted
            | PermissionError::MethodNotDeclared
            | PermissionError::DomainUndeclared => "PERMISSION_DENIED",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            PermissionError::NotInstalled => "插件未安装",
            PermissionError::NotEnabled => "插件未启用",
            PermissionError::CapabilityUndeclared => "插件未声明该能力",
            PermissionError::CapabilityNotGranted => "该能力尚未获得授权",
            PermissionError::MethodNotDeclared => "插件未声明该方法",
            PermissionError::DomainUndeclared => "插件未声明该网络域名",
        }
    }
}

/// Every call passes through here before the request reaches the plugin
/// process. A manifest declaration alone is never treated as authorization:
/// the user grants capabilities explicitly and the grant is persisted.
pub fn check_call(
    plugin: &InstalledPlugin,
    ready: &ReadyInfo,
    capability: Capability,
    method: &str,
) -> Result<(), PermissionError> {
    if !plugin.manifest.declares(capability) {
        return Err(PermissionError::CapabilityUndeclared);
    }
    if !plugin.has_granted(capability) {
        return Err(PermissionError::CapabilityNotGranted);
    }
    if !plugin.enabled {
        return Err(PermissionError::NotEnabled);
    }
    if !ready.methods.iter().any(|entry| entry == method) {
        return Err(PermissionError::MethodNotDeclared);
    }
    Ok(())
}

pub fn check_domain(plugin: &InstalledPlugin, domain: &str) -> Result<(), PermissionError> {
    if plugin.manifest.declares_domain(domain) {
        Ok(())
    } else {
        Err(PermissionError::DomainUndeclared)
    }
}

/// Capabilities an installation grants: everything the manifest declares.
pub fn grantable(plugin: &InstalledPlugin) -> Vec<Capability> {
    plugin.manifest.capabilities.clone()
}
