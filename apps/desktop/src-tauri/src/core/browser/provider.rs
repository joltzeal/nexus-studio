use super::connection_store::BrowserConnection;
use crate::core::window_store::WindowRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

#[path = "automation.rs"]
pub mod automation;

pub const BUILTIN_CONNECTION_ID: &str = "builtin-cloakbrowser";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserProviderId {
    CloakBrowser,
    AdsPower,
    BitBrowser,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserBinding {
    pub provider_id: BrowserProviderId,
    pub connection_id: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Unknown,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    Direct,
    Manual,
    Plugin,
    Provider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowOrigin {
    Created,
    Attached,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCapabilities {
    pub create: bool,
    pub update: bool,
    pub delete_environment: bool,
    pub attach: bool,
    pub manual_proxy: bool,
    pub proxy_plugin: bool,
    pub geoip: bool,
    pub fingerprint_seed: bool,
    pub kernel_selection: bool,
    pub transfer: bool,
}

impl BrowserCapabilities {
    pub fn for_provider(provider: BrowserProviderId) -> Self {
        let builtin = provider == BrowserProviderId::CloakBrowser;
        Self {
            create: true,
            update: true,
            delete_environment: true,
            attach: !builtin,
            manual_proxy: true,
            proxy_plugin: true,
            geoip: true,
            fingerprint_seed: builtin,
            kernel_selection: builtin,
            transfer: builtin,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl BrowserError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: matches!(code, "unavailable" | "rate_limited" | "not_submitted"),
        }
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new("unsupported", message)
    }
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BrowserError {}

pub type BrowserResult<T> = Result<T, BrowserError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbe {
    pub connected: bool,
    pub message: String,
    pub scope_id: Option<String>,
    pub capabilities: BrowserCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGroup {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfile {
    pub id: String,
    pub name: String,
    pub kernel_version: Option<String>,
    pub created_at: Option<i64>,
    pub provider_config: Value,
}

#[derive(Debug, Clone, Default)]
pub struct ObservedProfiles {
    pub states: HashMap<String, WindowState>,
    pub profiles: Vec<RemoteProfile>,
}

/// A complete running-profile observation from a provider with an authoritative limit.
/// Providers without such an API return None; plan names never imply a capacity.
#[derive(Debug, Clone)]
pub struct ProviderCapacity {
    pub max_running: u32,
    pub running_profiles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CreatedProfile {
    pub profile_id: String,
    pub kernel_version: Option<String>,
    pub binary_path: Option<PathBuf>,
    pub provider_config: Value,
}

#[derive(Debug, Clone)]
pub struct ResolvedProxy {
    pub mode: ProxyMode,
    pub connection_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateEvidence {
    pub schema_version: u32,
    pub provider_id: BrowserProviderId,
    pub fields: BTreeMap<String, String>,
}

impl UpdateEvidence {
    pub fn from_fields(provider_id: BrowserProviderId, fields: &Value) -> BrowserResult<Self> {
        fn collect(
            path: &str,
            value: &Value,
            fields: &mut BTreeMap<String, String>,
        ) -> BrowserResult<()> {
            if let Some(object) = value.as_object().filter(|object| !object.is_empty()) {
                for (key, value) in object {
                    let key = key.replace('~', "~0").replace('/', "~1");
                    collect(&format!("{path}/{key}"), value, fields)?;
                }
            } else {
                fields.insert(path.into(), UpdateEvidence::digest(value)?);
            }
            Ok(())
        }
        let object = fields
            .as_object()
            .ok_or_else(|| BrowserError::new("invalid_config", "配置确认数据无效"))?;
        let mut evidence = Self {
            schema_version: 1,
            provider_id,
            fields: BTreeMap::new(),
        };
        for (key, value) in object {
            let key = key.replace('~', "~0").replace('/', "~1");
            collect(&format!("/{key}"), value, &mut evidence.fields)?;
        }
        evidence.validate(provider_id)?;
        Ok(evidence)
    }

    fn digest(value: &Value) -> BrowserResult<String> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| BrowserError::new("invalid_config", "配置确认数据无效"))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }

    pub fn validate(&self, provider_id: BrowserProviderId) -> BrowserResult<()> {
        if self.schema_version != 1
            || self.provider_id != provider_id
            || self.fields.len() > 128
            || self.fields.iter().any(|(path, digest)| {
                !path.starts_with('/')
                    || path.len() > 512
                    || digest.len() != 64
                    || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(BrowserError::new(
                "invalid_config",
                "已提交配置的确认数据损坏，请人工核对操作",
            ));
        }
        Ok(())
    }

    pub fn matches_fields(
        &self,
        provider_id: BrowserProviderId,
        actual: &Value,
    ) -> BrowserResult<bool> {
        self.validate(provider_id)?;
        for (path, expected) in &self.fields {
            let Some(value) = actual.pointer(path) else {
                return Ok(false);
            };
            if &Self::digest(value)? != expected {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Provider operations never write Nexus business records or own plugin bindings.
pub trait BrowserProvider: Send + Sync {
    fn id(&self) -> BrowserProviderId;

    fn capabilities(&self) -> BrowserCapabilities {
        BrowserCapabilities::for_provider(self.id())
    }

    fn capacity(&self, _connection: &BrowserConnection) -> BrowserResult<Option<ProviderCapacity>> {
        Ok(None)
    }

    /// Read-only automation extension. It never starts or reconfigures a profile.
    fn automation_session(
        &self,
        _connection: &BrowserConnection,
        _record: &WindowRecord,
    ) -> BrowserResult<automation::AutomationSession> {
        Err(BrowserError::unsupported(
            "Browser automation is unavailable",
        ))
    }

    fn probe(&self, connection: &BrowserConnection) -> BrowserResult<ProviderProbe>;
    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>>;
    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>>;
    fn create_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        operation_id: &str,
    ) -> BrowserResult<CreatedProfile>;
    fn update_profile(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<()>;
    fn prepare_update_evidence(
        &self,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<UpdateEvidence>;
    fn delete_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()>;
    fn start_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        proxy: &ResolvedProxy,
    ) -> BrowserResult<()>;
    fn stop_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()>;
    fn observe_profiles(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles>;
    fn reconcile_create(
        &self,
        connection: &BrowserConnection,
        operation_id: &str,
    ) -> BrowserResult<Option<RemoteProfile>>;
    fn reconcile_update(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool>;
    fn reconcile_delete(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<bool> {
        Ok(!self
            .list_profiles(connection)?
            .iter()
            .any(|profile| profile.id == record.binding.profile_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn update_evidence_freezes_only_submitted_fields_without_reusable_proxy_credentials() {
        let expected = json!({
            "proxyUserName":"fixture-user", "proxyPassword":"fixture-secret",
            "browserFingerPrint":{"timeZone":"America/New_York","language":"en-US"}
        });
        let evidence =
            UpdateEvidence::from_fields(BrowserProviderId::BitBrowser, &expected).unwrap();
        let text = serde_json::to_string(&evidence).unwrap();
        assert!(!text.contains("fixture-user"));
        assert!(!text.contains("fixture-secret"));
        assert!(evidence.matches_fields(BrowserProviderId::BitBrowser, &json!({
            "name":"unchanged vendor name",
            "proxyUserName":"fixture-user", "proxyPassword":"fixture-secret",
            "browserFingerPrint":{"timeZone":"America/New_York","language":"en-US","extra":"retained"}
        })).unwrap());
        let mut changed = expected.clone();
        changed["proxyPassword"] = json!("different-secret");
        assert!(
            !evidence
                .matches_fields(BrowserProviderId::BitBrowser, &changed)
                .unwrap()
        );
        changed = expected;
        changed["browserFingerPrint"]
            .as_object_mut()
            .unwrap()
            .remove("language");
        assert!(
            !evidence
                .matches_fields(BrowserProviderId::BitBrowser, &changed)
                .unwrap()
        );
    }

    #[test]
    fn update_evidence_rejects_other_providers_versions_and_malformed_digests() {
        let mut evidence =
            UpdateEvidence::from_fields(BrowserProviderId::BitBrowser, &json!({"a/b~c":true}))
                .unwrap();
        assert!(
            evidence
                .matches_fields(BrowserProviderId::BitBrowser, &json!({"a/b~c":true}))
                .unwrap()
        );
        assert!(evidence.validate(BrowserProviderId::AdsPower).is_err());
        evidence.schema_version = 2;
        assert!(evidence.validate(BrowserProviderId::BitBrowser).is_err());
        evidence.schema_version = 1;
        evidence.fields.insert("/invalid".into(), "short".into());
        assert!(evidence.validate(BrowserProviderId::BitBrowser).is_err());
    }
}
