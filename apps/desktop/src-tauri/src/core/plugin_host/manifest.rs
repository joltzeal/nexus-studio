use serde::{Deserialize, Serialize};
use std::fmt;

pub const PLUGIN_API_VERSION: u32 = 1;
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    #[serde(rename = "monitor.collector")]
    MonitorCollector,
    #[serde(rename = "account.pool")]
    AccountPool,
    #[serde(rename = "window.sync")]
    WindowSync,
    #[serde(rename = "email.provider")]
    EmailProvider,
    #[serde(rename = "product.catalog")]
    ProductCatalog,
    #[serde(rename = "sales.agent")]
    SalesAgent,
}

impl Capability {
    pub const ALL: [Capability; 13] = [
        Capability::ProxyProvider,
        Capability::AddressGenerator,
        Capability::SupplyCatalog,
        Capability::PlatformAdapter,
        Capability::VerificationProvider,
        Capability::ImageProvider,
        Capability::EnvironmentConfigurator,
        Capability::MonitorCollector,
        Capability::AccountPool,
        Capability::WindowSync,
        Capability::EmailProvider,
        Capability::ProductCatalog,
        Capability::SalesAgent,
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
            Capability::MonitorCollector => "monitor.collector",
            Capability::AccountPool => "account.pool",
            Capability::WindowSync => "window.sync",
            Capability::EmailProvider => "email.provider",
            Capability::ProductCatalog => "product.catalog",
            Capability::SalesAgent => "sales.agent",
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
pub struct PluginIcon {
    pub view_box: String,
    pub paths: Vec<String>,
}

impl PluginIcon {
    fn valid(&self) -> bool {
        self.view_box == "0 0 24 24"
            && (1..=8).contains(&self.paths.len())
            && self.paths.iter().all(|path| {
                (1..=8192).contains(&path.len())
                    && path.bytes().all(|byte| {
                        byte.is_ascii_digit()
                            || byte.is_ascii_whitespace()
                            || b"MmZzLlHhVvCcSsQqTtAaEe.,+-\x0b".contains(&byte)
                    })
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginNavigation {
    pub icon: PluginIcon,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProfileTableEntry {
    pub title: String,
    pub view_id: String,
    pub capability: Capability,
    pub icon: PluginIcon,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginUiService {
    pub id: String,
    pub plugin_id: String,
    pub capability: Capability,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginUi {
    pub protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigation: Option<PluginNavigation>,
    #[serde(default)]
    pub services: Vec<PluginUiService>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_table: Option<ProfileTableEntry>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<PluginUi>,
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
            ManifestError::IncompatibleCore => "插件要求更高版本的 Raccoon 核心",
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
        if let Some(ui) = &self.ui {
            if ui.protocol_version != 1
                || (ui.navigation.is_none() && ui.profile_table.is_none())
                || (ui.profile_table.is_none() && !ui.services.is_empty())
                || ui
                    .navigation
                    .as_ref()
                    .is_some_and(|entry| !entry.icon.valid())
                || ui.profile_table.as_ref().is_some_and(|entry| {
                    entry.title.trim().is_empty()
                        || entry.title.chars().count() > 200
                        || !valid_ui_id(&entry.view_id)
                        || !self.capabilities.contains(&entry.capability)
                        || !entry.icon.valid()
                })
                || ui.services.len() > 10
                || has_duplicates(
                    &ui.services
                        .iter()
                        .map(|service| service.id.clone())
                        .collect::<Vec<_>>(),
                )
                || ui.services.iter().any(|service| {
                    !valid_ui_id(&service.id)
                        || !valid_plugin_id(&service.plugin_id)
                        || service.plugin_id == self.id
                        || service.methods.is_empty()
                        || service.methods.len() > 20
                        || has_duplicates(&service.methods)
                        || service.methods.iter().any(|method| {
                            !valid_ui_id(method)
                                || super::super::plugin_service::webview_method_capability(
                                    service.capability,
                                    method,
                                )
                                .is_err()
                        })
                })
            {
                return Err(ManifestError::UnknownField);
            }
        }
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

pub(crate) fn valid_ui_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
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

#[cfg(test)]
mod version_tests {
    use super::*;

    fn ui_manifest() -> serde_json::Value {
        serde_json::json!({
            "apiVersion":1,"id":"example.panel","version":"1.0.0",
            "name":"Panel","minCoreVersion":env!("CARGO_PKG_VERSION"),
            "capabilities":["account.pool"],"permissions":{
                "networkDomains":[],"wantsBrowserAccess":false,"storage":"private","secrets":[]
            },"ui":{
                "protocolVersion":1,"profileTable":{
                    "title":"Details","viewId":"details","capability":"account.pool",
                    "icon":{"viewBox":"0 0 24 24","paths":["M0 0 L1 1"]}
                }
            }
        })
    }

    fn with_service(methods: serde_json::Value) -> serde_json::Value {
        let mut manifest = ui_manifest();
        manifest["ui"]["services"] = serde_json::json!([{
            "id":"catalog","pluginId":"example.catalog","capability":"product.catalog","methods":methods
        }]);
        manifest
    }

    #[test]
    fn navigation_alone_has_no_profile_entry_or_services() {
        let mut manifest = ui_manifest();
        manifest["ui"] = serde_json::json!({
            "protocolVersion": 1,
            "navigation": { "icon": { "viewBox": "0 0 24 24", "paths": ["M1 2h3z"] } }
        });
        let ui = PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap())
            .unwrap()
            .ui
            .unwrap();
        assert!(ui.profile_table.is_none());
        assert!(ui.services.is_empty());
        assert_eq!(ui.navigation.unwrap().icon.paths, ["M1 2h3z"]);
        manifest["ui"]["services"] =
            with_service(serde_json::json!(["items.list"]))["ui"]["services"].clone();
        assert!(PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap()).is_err());
        manifest["ui"].as_object_mut().unwrap().remove("services");
        manifest["ui"]["navigation"]["icon"]["paths"] = serde_json::json!(["<script>"]);
        assert!(PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap()).is_err());
    }

    #[test]
    fn ui_services_default_to_empty_and_require_explicit_safe_methods() {
        let parsed = PluginManifest::parse(&serde_json::to_vec(&ui_manifest()).unwrap()).unwrap();
        assert!(parsed.ui.unwrap().services.is_empty());
        let manifest = with_service(serde_json::json!(["items.list"]));
        let parsed = PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(parsed.ui.unwrap().services[0].methods, ["items.list"]);
        for method in [
            "ui.tasks.poll",
            "transfer.export",
            "window.detach",
            "products.publications.record",
        ] {
            let invalid = with_service(serde_json::json!([method]));
            assert!(PluginManifest::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn ui_services_reject_duplicate_ids_methods_self_targets_and_unknown_fields() {
        let mut duplicate = with_service(serde_json::json!(["items.list"]));
        let service = duplicate["ui"]["services"][0].clone();
        duplicate["ui"]["services"]
            .as_array_mut()
            .unwrap()
            .push(service);
        assert!(PluginManifest::parse(&serde_json::to_vec(&duplicate).unwrap()).is_err());
        let duplicate_methods = with_service(serde_json::json!(["items.list", "items.list"]));
        assert!(PluginManifest::parse(&serde_json::to_vec(&duplicate_methods).unwrap()).is_err());
        let mut self_target = with_service(serde_json::json!(["items.list"]));
        self_target["ui"]["services"][0]["pluginId"] = serde_json::json!("example.panel");
        assert!(PluginManifest::parse(&serde_json::to_vec(&self_target).unwrap()).is_err());
        let mut unknown = with_service(serde_json::json!(["items.list"]));
        unknown["ui"]["services"][0]["network"] = serde_json::json!(true);
        assert!(PluginManifest::parse(&serde_json::to_vec(&unknown).unwrap()).is_err());
    }

    #[test]
    fn ui_services_and_method_lists_are_bounded() {
        let mut too_many_services = with_service(serde_json::json!(["items.list"]));
        too_many_services["ui"]["services"] = serde_json::Value::Array((0..11).map(|index| {
            serde_json::json!({"id":format!("catalog-{index}"),"pluginId":"example.catalog", "capability":"product.catalog","methods":["items.list"]})
        }).collect());
        assert!(PluginManifest::parse(&serde_json::to_vec(&too_many_services).unwrap()).is_err());
        let methods: Vec<_> = (0..21).map(|index| format!("items.list{index}")).collect();
        let too_many_methods = with_service(serde_json::json!(methods));
        assert!(PluginManifest::parse(&serde_json::to_vec(&too_many_methods).unwrap()).is_err());
        let invalid_method = with_service(serde_json::json!(["items list"]));
        assert!(PluginManifest::parse(&serde_json::to_vec(&invalid_method).unwrap()).is_err());
    }

    #[test]
    fn product_catalog_needs_neither_browser_nor_network_permissions() {
        assert_eq!(
            Capability::parse("product.catalog"),
            Some(Capability::ProductCatalog)
        );
        let manifest = serde_json::json!({
            "apiVersion":1,"id":"studio.products","version":"1.0.0",
            "name":"Products","minCoreVersion":env!("CARGO_PKG_VERSION"),
            "capabilities":["product.catalog"],"permissions":{
                "networkDomains":[],
                "wantsBrowserAccess":false,"storage":"private","secrets":[]
            }
        });
        let parsed = PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(parsed.declares(Capability::ProductCatalog));
        assert!(!parsed.permissions.wants_browser_access);
        assert!(parsed.permissions.network_domains.is_empty());
    }

    #[test]
    fn email_capability_is_distinct_from_account_lifecycle() {
        assert_eq!(
            Capability::parse("email.provider"),
            Some(Capability::EmailProvider)
        );
        let manifest = serde_json::json!({
            "apiVersion":1,"id":"studio.email","version":"1.0.0",
            "name":"Mailbox","minCoreVersion":env!("CARGO_PKG_VERSION"),
            "capabilities":["email.provider"],"permissions":{
                "networkDomains":["graph.microsoft.com"],
                "wantsBrowserAccess":false,"storage":"private","secrets":[]
            }
        });
        let parsed = PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(parsed.declares(Capability::EmailProvider));
        assert!(!parsed.declares(Capability::AccountPool));
    }

    #[test]
    fn a_plugin_requiring_the_running_application_version_is_compatible() {
        let manifest = serde_json::json!({
            "apiVersion":1,"id":"studio.window-sync","version":"1.0.0",
            "name":"Window sync","minCoreVersion":env!("CARGO_PKG_VERSION"),
            "capabilities":["window.sync"],"permissions":{
                "networkDomains":[],"wantsBrowserAccess":false,"storage":"private","secrets":[]
            }
        });
        let parsed = PluginManifest::parse(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(parsed.declares(Capability::WindowSync));
    }
}
