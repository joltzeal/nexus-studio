use serde::{Deserialize, Serialize};
use std::fmt;

pub const PLUGIN_API_VERSION: u32 = 1;
pub const CORE_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    #[serde(rename = "proxy.provider")]
    ProxyProvider,
    #[serde(rename = "address.generator")]
    AddressGenerator,
    #[serde(rename = "supply.catalog")]
    SupplyCatalog,
    #[serde(rename = "platform.adapter")]
    PlatformAdapter,
    #[serde(rename = "verification.provider")]
    VerificationProvider,
    #[serde(rename = "image.provider")]
    ImageProvider,
    #[serde(rename = "environment.configurator")]
    EnvironmentConfigurator,
}

impl Capability {
    pub const ALL: [Capability; 7] = [
        Capability::ProxyProvider,
        Capability::AddressGenerator,
        Capability::SupplyCatalog,
        Capability::PlatformAdapter,
        Capability::VerificationProvider,
        Capability::ImageProvider,
        Capability::EnvironmentConfigurator,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::ProxyProvider => "proxy.provider",
            Capability::AddressGenerator => "address.generator",
            Capability::SupplyCatalog => "supply.catalog",
            Capability::PlatformAdapter => "platform.adapter",
            Capability::VerificationProvider => "verification.provider",
            Capability::ImageProvider => "image.provider",
            Capability::EnvironmentConfigurator => "environment.configurator",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Capability::ALL
            .into_iter()
            .find(|capability| capability.as_str() == value)
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageScope {
    Private,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginPermissions {
    pub network_domains: Vec<String>,
    pub wants_browser_access: bool,
    pub storage: StorageScope,
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginManifest {
    pub api_version: u32,
    pub id: String,
    pub version: String,
    pub name: String,
    pub min_core_version: String,
    pub capabilities: Vec<Capability>,
    pub permissions: PluginPermissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestError {
    NotAnObject,
    UnknownField,
    UnsupportedApiVersion,
    InvalidId,
    InvalidVersion,
    InvalidName,
    NoCapabilities,
    DuplicateCapability,
    InvalidNetworkDomain,
    DuplicateNetworkDomain,
    InvalidSecretSlot,
    DuplicateSecretSlot,
    IncompatibleCore,
}

impl ManifestError {
    /// Stable code shared with the RPC error vocabulary.
    pub fn code(self) -> &'static str {
        match self {
            ManifestError::NotAnObject | ManifestError::UnknownField => "INVALID_REQUEST",
            ManifestError::UnsupportedApiVersion => "INVALID_REQUEST",
            ManifestError::IncompatibleCore => "INVALID_REQUEST",
            ManifestError::InvalidId
            | ManifestError::InvalidVersion
            | ManifestError::InvalidName
            | ManifestError::NoCapabilities
            | ManifestError::DuplicateCapability
            | ManifestError::InvalidNetworkDomain
            | ManifestError::DuplicateNetworkDomain
            | ManifestError::InvalidSecretSlot
            | ManifestError::DuplicateSecretSlot => "INVALID_REQUEST",
        }
    }

    /// Message shown to the user; never echoes the rejected value.
    pub fn message(self) -> &'static str {
        match self {
            ManifestError::NotAnObject => "插件清单不是 JSON 对象",
            ManifestError::UnknownField => "插件清单包含未知字段",
            ManifestError::UnsupportedApiVersion => "插件清单的 API 版本不受支持",
            ManifestError::InvalidId => "插件标识需要是反向域名风格",
            ManifestError::InvalidVersion => "插件版本需要是完整的 SemVer",
            ManifestError::InvalidName => "插件名称需要包含 1 至 80 个字符",
            ManifestError::NoCapabilities => "插件清单没有声明能力",
            ManifestError::DuplicateCapability => "插件清单重复声明了同一能力",
            ManifestError::InvalidNetworkDomain => "网络域名需要是精确主机名",
            ManifestError::DuplicateNetworkDomain => "插件清单重复声明了同一域名",
            ManifestError::InvalidSecretSlot => "密钥槽名称只能使用小写字母、数字和连字符",
            ManifestError::DuplicateSecretSlot => "插件清单重复声明了同一密钥槽",
            ManifestError::IncompatibleCore => "插件要求更高版本的 Nexus 核心",
        }
    }
}

impl PluginManifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| ManifestError::NotAnObject)?;
        if !value.is_object() {
            return Err(ManifestError::NotAnObject);
        }
        let manifest: PluginManifest =
            serde_json::from_value(value).map_err(|error| classify(&error))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Structural rules from the integration guide. Runs on every load, not
    /// only on install, so a hand-edited manifest cannot widen its own scope.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.api_version != PLUGIN_API_VERSION {
            return Err(ManifestError::UnsupportedApiVersion);
        }
        if !valid_plugin_id(&self.id) {
            return Err(ManifestError::InvalidId);
        }
        if semver::Version::parse(&self.version).is_err() {
            return Err(ManifestError::InvalidVersion);
        }
        let minimum = semver::Version::parse(&self.min_core_version)
            .map_err(|_| ManifestError::InvalidVersion)?;
        let name_length = self.name.trim().chars().count();
        if name_length == 0 || name_length > 80 {
            return Err(ManifestError::InvalidName);
        }
        if self.capabilities.is_empty() {
            return Err(ManifestError::NoCapabilities);
        }
        let mut seen = Vec::new();
        for capability in &self.capabilities {
            if seen.contains(capability) {
                return Err(ManifestError::DuplicateCapability);
            }
            seen.push(*capability);
        }
        if self
            .permissions
            .network_domains
            .iter()
            .any(|domain| !valid_domain(domain))
        {
            return Err(ManifestError::InvalidNetworkDomain);
        }
        if has_duplicates(&self.permissions.network_domains) {
            return Err(ManifestError::DuplicateNetworkDomain);
        }
        if self
            .permissions
            .secrets
            .iter()
            .any(|slot| !valid_secret_slot(slot))
        {
            return Err(ManifestError::InvalidSecretSlot);
        }
        if has_duplicates(&self.permissions.secrets) {
            return Err(ManifestError::DuplicateSecretSlot);
        }
        let core = semver::Version::parse(CORE_VERSION).expect("core version is a constant");
        if minimum > core {
            return Err(ManifestError::IncompatibleCore);
        }
        Ok(())
    }

    pub fn declares(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn declares_secret(&self, slot: &str) -> bool {
        self.permissions.secrets.iter().any(|entry| entry == slot)
    }

    pub fn declares_domain(&self, domain: &str) -> bool {
        self.permissions
            .network_domains
            .iter()
            .any(|entry| entry == domain)
    }
}

fn classify(error: &serde_json::Error) -> ManifestError {
    // serde reports unknown fields with a stable prefix; everything else is a
    // structural mismatch that the user fixes by editing the manifest.
    let text = error.to_string();
    if text.contains("unknown field") {
        ManifestError::UnknownField
    } else if text.contains("capabilities") {
        ManifestError::NoCapabilities
    } else {
        ManifestError::NotAnObject
    }
}

fn has_duplicates(values: &[String]) -> bool {
    let mut sorted: Vec<&str> = values.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.windows(2).any(|pair| pair[0] == pair[1])
}

pub fn valid_plugin_id(id: &str) -> bool {
    if id.len() > 96 || !id.contains('.') {
        return false;
    }
    id.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 48
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

pub fn valid_secret_slot(slot: &str) -> bool {
    !slot.is_empty()
        && slot.len() <= 64
        && slot
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !slot.starts_with('-')
        && !slot.ends_with('-')
}

/// Exact hostname only: no scheme, port, path, wildcard, IP literal or
/// single-label name. `localhost` is rejected explicitly.
pub fn valid_domain(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > 253 || domain == "localhost" {
        return false;
    }
    if domain.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    if labels.iter().any(|label| {
        label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
    }) {
        return false;
    }
    if !labels.iter().all(|label| {
        label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return false;
    }
    let tld = labels[labels.len() - 1];
    tld.len() >= 2 && tld.bytes().all(|byte| byte.is_ascii_alphabetic())
}
