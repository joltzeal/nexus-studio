use crate::core::network_proxy::NetworkProxyStore;
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::{
    rand::SystemRandom,
    signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const FIRST_PARTY_PLUGIN_IDS: &[&str] = &[
    "studio.address-generator",
    "studio.ai-image",
    "studio.email",
    "studio.products",
    "studio.proxy-pool",
    "studio.sales-agent",
    "studio.shared-supply",
    "studio.sim8",
    "studio.vinted-accounts",
    "studio.vinted-monitor",
    "studio.window-sync",
];
const WORKER_URL: &str = "https://raccoon-license.bravesfly.workers.dev";
const MAX_RESPONSE_BYTES: u64 = 16 * 1024;
const REFRESH_RETRY_INITIAL: Duration = Duration::from_secs(30);
const REFRESH_RETRY_MAX: Duration = Duration::from_secs(5 * 60);

fn licensing_proxy_endpoint(endpoint: String) -> String {
    endpoint
        .strip_prefix("socks5://")
        .map(|authority| format!("socks5h://{authority}"))
        .unwrap_or(endpoint)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseError {
    NotActivated,
    Expired,
    Denied,
    Unavailable,
    Storage,
}

impl LicenseError {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotActivated => "插件尚未激活，请在插件中心输入激活码",
            Self::Expired => "插件授权已过期，请在插件中心重新激活",
            Self::Denied => "激活码不可用或该设备已被撤销",
            Self::Unavailable => "暂时无法连接插件核验服务，请稍后重试",
            Self::Storage => "插件授权资料无法读取或保存",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseStatus {
    pub state: String,
    pub expires_at: Option<i64>,
    pub device_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeasePayload {
    v: u8,
    license_id: String,
    plugin_id: String,
    device_public_key: String,
    issued_at: i64,
    expires_at: i64,
    offline_until: i64,
    refresh_after: i64,
    revision: u64,
    key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedLease {
    payload: LeasePayload,
    signature: String,
}

struct Device {
    plugin_id: String,
    private_key: Vec<u8>,
    public_key: String,
    lease: Option<SignedLease>,
    last_seen_at: i64,
}

struct RefreshBackoff {
    delay: Duration,
    next_at: Instant,
}

pub struct PluginLicenseStore {
    path: PathBuf,
    storage_lock: Mutex<()>,
    renewal: HashMap<&'static str, Mutex<Option<RefreshBackoff>>>,
    #[cfg(test)]
    test_signing_key: Mutex<Option<Vec<u8>>>,
}

impl PluginLicenseStore {
    pub fn new(path: PathBuf) -> Result<Self, LicenseError> {
        let connection = Connection::open(&path).map_err(|_| LicenseError::Storage)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS plugin_entitlements (
                    plugin_id TEXT PRIMARY KEY,
                    private_key BLOB NOT NULL,
                    public_key TEXT NOT NULL,
                    lease_json TEXT,
                    last_seen_at INTEGER NOT NULL DEFAULT 0
                )",
            )
            .map_err(|_| LicenseError::Storage)?;
        Ok(Self {
            path,
            storage_lock: Mutex::new(()),
            renewal: FIRST_PARTY_PLUGIN_IDS
                .iter()
                .map(|&id| (id, Mutex::new(None)))
                .collect(),
            #[cfg(test)]
            test_signing_key: Mutex::new(None),
        })
    }

    fn connection(&self) -> Result<Connection, LicenseError> {
        Connection::open(&self.path).map_err(|_| LicenseError::Storage)
    }

    fn renewal_slot(
        &self,
        plugin_id: &str,
    ) -> Result<&Mutex<Option<RefreshBackoff>>, LicenseError> {
        self.renewal.get(plugin_id).ok_or(LicenseError::Denied)
    }

    fn device(&self, connection: &Connection, plugin_id: &str) -> Result<Device, LicenseError> {
        let stored: Option<(Vec<u8>, String, Option<String>, i64)> = connection
            .query_row(
                "SELECT private_key, public_key, lease_json, last_seen_at
                 FROM plugin_entitlements WHERE plugin_id = ?1",
                [plugin_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| LicenseError::Storage)?;
        if let Some((private_key, public_key, lease, last_seen_at)) = stored {
            let lease = lease
                .map(|value| serde_json::from_str(&value).map_err(|_| LicenseError::Storage))
                .transpose()?;
            return Ok(Device {
                plugin_id: plugin_id.into(),
                private_key,
                public_key,
                lease,
                last_seen_at,
            });
        }
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| LicenseError::Storage)?;
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).map_err(|_| LicenseError::Storage)?;
        let public_key = STANDARD.encode(pair.public_key().as_ref());
        connection
            .execute(
                "INSERT INTO plugin_entitlements (plugin_id, private_key, public_key)
                 VALUES (?1, ?2, ?3)",
                params![plugin_id, pkcs8.as_ref(), public_key],
            )
            .map_err(|_| LicenseError::Storage)?;
        Ok(Device {
            plugin_id: plugin_id.into(),
            private_key: pkcs8.as_ref().to_vec(),
            public_key,
            lease: None,
            last_seen_at: 0,
        })
    }

    pub fn status(&self, plugin_id: &str) -> Result<LicenseStatus, LicenseError> {
        let device = {
            let _guard = self
                .storage_lock
                .lock()
                .map_err(|_| LicenseError::Storage)?;
            self.device(&self.connection()?, plugin_id)?
        };
        let now = now();
        let state = match &device.lease {
            None => "inactive",
            Some(lease) if self.verify(lease, &device, now).is_err() => "invalid",
            Some(lease) if now >= lease.payload.expires_at => "expired",
            Some(lease) if now >= lease.payload.offline_until => "needsConnection",
            Some(_) => "active",
        };
        Ok(LicenseStatus {
            state: state.into(),
            expires_at: device.lease.as_ref().map(|lease| lease.payload.expires_at),
            device_code: device.public_key,
        })
    }

    pub fn status_all(
        &self,
        plugin_ids: &[&str],
    ) -> Result<std::collections::BTreeMap<String, LicenseStatus>, LicenseError> {
        plugin_ids
            .iter()
            .map(|id| Ok(((*id).to_string(), self.status(id)?)))
            .collect()
    }

    pub fn activate(
        &self,
        plugin_id: &str,
        card: &str,
        network: Option<&NetworkProxyStore>,
    ) -> Result<LicenseStatus, LicenseError> {
        if card.trim().is_empty() || card.len() > 128 {
            return Err(LicenseError::Denied);
        }
        let mut retry = self
            .renewal_slot(plugin_id)?
            .lock()
            .map_err(|_| LicenseError::Storage)?;
        let device = {
            let _guard = self
                .storage_lock
                .lock()
                .map_err(|_| LicenseError::Storage)?;
            self.device(&self.connection()?, plugin_id)?
        };
        let reply = self.request(
            "/v1/cards/redeem",
            serde_json::json!({
                "card": card.trim(),
                "pluginId": plugin_id,
                "devicePublicKey": device.public_key
            }),
            &device,
            network,
        )?;
        let _guard = self
            .storage_lock
            .lock()
            .map_err(|_| LicenseError::Storage)?;
        let connection = self.connection()?;
        let device = self.device(&connection, plugin_id)?;
        self.verify_usable(&reply, &device, now())?;
        self.save(&connection, plugin_id, &reply)?;
        *retry = None;
        Ok(LicenseStatus {
            state: "active".into(),
            expires_at: Some(reply.payload.expires_at),
            device_code: device.public_key,
        })
    }

    pub fn require_for(
        &self,
        plugin_id: &str,
        network: Option<&NetworkProxyStore>,
    ) -> Result<(), LicenseError> {
        let mut retry = match self.renewal_slot(plugin_id)?.try_lock() {
            Ok(retry) => retry,
            Err(TryLockError::WouldBlock) => return self.require_local(plugin_id),
            Err(TryLockError::Poisoned(_)) => return Err(LicenseError::Storage),
        };
        let (device, license_id) = {
            let _guard = self
                .storage_lock
                .lock()
                .map_err(|_| LicenseError::Storage)?;
            let connection = self.connection()?;
            let device = self.device(&connection, plugin_id)?;
            let at = now();
            let lease = device.lease.as_ref().ok_or(LicenseError::NotActivated)?;
            self.verify_unexpired(lease, &device, at)?;
            let refresh_due =
                at >= lease.payload.refresh_after || at >= lease.payload.offline_until;
            let retry_due = retry
                .as_ref()
                .is_none_or(|retry| Instant::now() >= retry.next_at);
            if !refresh_due || !retry_due {
                return self.use_local_lease(&connection, lease, at);
            }
            let license_id = lease.payload.license_id.clone();
            (device, license_id)
        };
        let response = self.request(
            "/v1/leases/refresh",
            serde_json::json!({
                "licenseId": license_id,
                "devicePublicKey": device.public_key
            }),
            &device,
            network,
        );
        match response {
            Ok(refreshed) => {
                let _guard = self
                    .storage_lock
                    .lock()
                    .map_err(|_| LicenseError::Storage)?;
                let connection = self.connection()?;
                let device = self.device(&connection, plugin_id)?;
                self.verify_usable(&refreshed, &device, now())?;
                self.save(&connection, plugin_id, &refreshed)?;
                *retry = None;
                Ok(())
            }
            Err(LicenseError::Denied) => {
                let _guard = self
                    .storage_lock
                    .lock()
                    .map_err(|_| LicenseError::Storage)?;
                self.connection()?
                    .execute(
                        "UPDATE plugin_entitlements SET lease_json = NULL WHERE plugin_id = ?1",
                        [plugin_id],
                    )
                    .map_err(|_| LicenseError::Storage)?;
                *retry = None;
                Err(LicenseError::Denied)
            }
            Err(LicenseError::Unavailable) => {
                let delay = retry.as_ref().map_or(REFRESH_RETRY_INITIAL, |retry| {
                    (retry.delay * 2).min(REFRESH_RETRY_MAX)
                });
                *retry = Some(RefreshBackoff {
                    delay,
                    next_at: Instant::now() + delay,
                });
                self.require_local(plugin_id)
            }
            Err(error) => Err(error),
        }
    }

    pub fn require_local(&self, plugin_id: &str) -> Result<(), LicenseError> {
        let _guard = self
            .storage_lock
            .lock()
            .map_err(|_| LicenseError::Storage)?;
        let connection = self.connection()?;
        let device = self.device(&connection, plugin_id)?;
        let lease = device.lease.as_ref().ok_or(LicenseError::NotActivated)?;
        let at = now();
        self.verify_unexpired(lease, &device, at)?;
        self.use_local_lease(&connection, lease, at)
    }

    fn use_local_lease(
        &self,
        connection: &Connection,
        lease: &SignedLease,
        at: i64,
    ) -> Result<(), LicenseError> {
        if at >= lease.payload.offline_until {
            return Err(LicenseError::Unavailable);
        }
        connection
            .execute(
                "UPDATE plugin_entitlements SET last_seen_at = ?1
                 WHERE plugin_id = ?2 AND last_seen_at < ?1",
                params![at, lease.payload.plugin_id],
            )
            .map_err(|_| LicenseError::Storage)?;
        Ok(())
    }

    fn save(
        &self,
        connection: &Connection,
        plugin_id: &str,
        lease: &SignedLease,
    ) -> Result<(), LicenseError> {
        let json = serde_json::to_string(lease).map_err(|_| LicenseError::Storage)?;
        connection
            .execute(
                "UPDATE plugin_entitlements SET lease_json = ?1,
                 last_seen_at = MAX(last_seen_at, ?2) WHERE plugin_id = ?3",
                params![json, now(), plugin_id],
            )
            .map_err(|_| LicenseError::Storage)?;
        Ok(())
    }

    fn verify(&self, lease: &SignedLease, device: &Device, now: i64) -> Result<(), LicenseError> {
        #[cfg(test)]
        let test_key = self
            .test_signing_key
            .lock()
            .map_err(|_| LicenseError::Storage)?;
        #[cfg(test)]
        if let Some(pkcs8) = test_key.as_ref() {
            let pair = Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| LicenseError::Storage)?;
            let public = STANDARD.encode(pair.public_key().as_ref());
            return verify_lease(lease, device, now, "test-only", &public);
        }
        let pinned: serde_json::Value =
            serde_json::from_str(include_str!("license-public-key.json"))
                .map_err(|_| LicenseError::Storage)?;
        let key_id = pinned["keyId"].as_str().ok_or(LicenseError::Storage)?;
        let public = pinned["publicKey"].as_str().ok_or(LicenseError::Storage)?;
        verify_lease(lease, device, now, key_id, public)
    }

    fn verify_unexpired(
        &self,
        lease: &SignedLease,
        device: &Device,
        at: i64,
    ) -> Result<(), LicenseError> {
        self.verify(lease, device, at)?;
        if at >= lease.payload.expires_at {
            return Err(LicenseError::Expired);
        }
        Ok(())
    }

    fn verify_usable(
        &self,
        lease: &SignedLease,
        device: &Device,
        at: i64,
    ) -> Result<(), LicenseError> {
        self.verify_unexpired(lease, device, at)?;
        if at >= lease.payload.offline_until {
            return Err(LicenseError::Unavailable);
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn seed_test_license(&self, plugin_id: &str) -> Result<(), LicenseError> {
        let _guard = self
            .storage_lock
            .lock()
            .map_err(|_| LicenseError::Storage)?;
        let connection = self.connection()?;
        let device = self.device(&connection, plugin_id)?;
        let mut test_key = self
            .test_signing_key
            .lock()
            .map_err(|_| LicenseError::Storage)?;
        let pkcs8 = match test_key.as_ref() {
            Some(key) => key.clone(),
            None => {
                let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                    .map_err(|_| LicenseError::Storage)?
                    .as_ref()
                    .to_vec();
                *test_key = Some(key.clone());
                key
            }
        };
        let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).map_err(|_| LicenseError::Storage)?;
        let issued_at = now();
        let payload = LeasePayload {
            v: 1,
            license_id: uuid::Uuid::new_v4().to_string(),
            plugin_id: plugin_id.into(),
            device_public_key: device.public_key,
            issued_at,
            expires_at: issued_at + 86_400,
            offline_until: issued_at + 86_400,
            refresh_after: issued_at + 43_200,
            revision: 1,
            key_id: "test-only".into(),
        };
        let signature = STANDARD.encode(
            pair.sign(&serde_json::to_vec(&payload).map_err(|_| LicenseError::Storage)?)
                .as_ref(),
        );
        drop(test_key);
        self.save(&connection, plugin_id, &SignedLease { payload, signature })
    }

    fn request(
        &self,
        path: &str,
        input: serde_json::Value,
        device: &Device,
        network: Option<&NetworkProxyStore>,
    ) -> Result<SignedLease, LicenseError> {
        let body = serde_json::to_string(&input).map_err(|_| LicenseError::Storage)?;
        let pair =
            Ed25519KeyPair::from_pkcs8(&device.private_key).map_err(|_| LicenseError::Storage)?;
        let timestamp = now().to_string();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        let message = format!("v1\nPOST\n{path}\n{timestamp}\n{nonce}\n{hash}");
        let signature = STANDARD.encode(pair.sign(message.as_bytes()).as_ref());
        let endpoint = network
            .map(|store| store.get().map_err(|_| LicenseError::Unavailable))
            .transpose()?
            .unwrap_or_default()
            .resolve()
            .map_err(|_| LicenseError::Unavailable)?;
        let mut client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15));
        if let Some(endpoint) = endpoint {
            client = client.proxy(
                reqwest::Proxy::all(licensing_proxy_endpoint(endpoint))
                    .map_err(|_| LicenseError::Unavailable)?,
            );
        }
        let client = client.build().map_err(|_| LicenseError::Unavailable)?;
        let response = client
            .post(format!("{WORKER_URL}{path}"))
            .header("x-device-time", timestamp)
            .header("x-device-nonce", nonce)
            .header("x-device-signature", signature)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .map_err(|_| LicenseError::Unavailable)?;
        if response.status().as_u16() == 403 {
            return Err(LicenseError::Denied);
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|len| len > MAX_RESPONSE_BYTES)
        {
            return Err(LicenseError::Unavailable);
        }
        let bytes = response.bytes().map_err(|_| LicenseError::Unavailable)?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(LicenseError::Unavailable);
        }
        serde_json::from_slice(&bytes).map_err(|_| LicenseError::Unavailable)
    }
}

fn verify_lease(
    lease: &SignedLease,
    device: &Device,
    now: i64,
    key_id: &str,
    public: &str,
) -> Result<(), LicenseError> {
    let key = STANDARD.decode(public).map_err(|_| LicenseError::Storage)?;
    let signature = STANDARD
        .decode(&lease.signature)
        .map_err(|_| LicenseError::Denied)?;
    let bytes = serde_json::to_vec(&lease.payload).map_err(|_| LicenseError::Denied)?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&bytes, &signature)
        .map_err(|_| LicenseError::Denied)?;
    let payload = &lease.payload;
    if payload.v != 1
        || payload.key_id != key_id
        || payload.plugin_id != device.plugin_id
        || payload.device_public_key != device.public_key
        || payload.license_id.is_empty()
        || payload.revision == 0
        || payload.issued_at > now + 300
        || now + 300 < device.last_seen_at
        || payload.expires_at <= payload.issued_at
        || payload.refresh_after > payload.expires_at
        || payload.offline_until > payload.expires_at
    {
        return Err(LicenseError::Denied);
    }
    Ok(())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socks5_license_requests_delegate_dns_resolution_to_the_proxy() {
        assert_eq!(
            licensing_proxy_endpoint("socks5://127.0.0.1:7890".into()),
            "socks5h://127.0.0.1:7890"
        );
        assert_eq!(
            licensing_proxy_endpoint("http://127.0.0.1:7890".into()),
            "http://127.0.0.1:7890"
        );
    }

    #[test]
    fn signed_lease_requires_pinned_key_device_and_plugin() {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let device = Device {
            plugin_id: "studio.sim8".into(),
            private_key: Vec::new(),
            public_key: "device-key".into(),
            lease: None,
            last_seen_at: 0,
        };
        let issued_at = now();
        let payload = LeasePayload {
            v: 1,
            license_id: "license-1".into(),
            plugin_id: "studio.sim8".into(),
            device_public_key: device.public_key.clone(),
            issued_at,
            expires_at: issued_at + 3600,
            refresh_after: issued_at + 1200,
            offline_until: issued_at + 3600,
            revision: 1,
            key_id: "test-key".into(),
        };
        let sign = |payload: LeasePayload| SignedLease {
            signature: STANDARD.encode(pair.sign(&serde_json::to_vec(&payload).unwrap()).as_ref()),
            payload,
        };
        let public = STANDARD.encode(pair.public_key().as_ref());
        let lease = sign(payload.clone());
        assert!(verify_lease(&lease, &device, issued_at, "test-key", &public).is_ok());
        assert_eq!(
            verify_lease(&lease, &device, issued_at, "other-key", &public),
            Err(LicenseError::Denied)
        );
        let changed = SignedLease {
            payload: LeasePayload {
                plugin_id: "studio.sales-agent".into(),
                ..payload.clone()
            },
            signature: lease.signature.clone(),
        };
        assert_eq!(
            verify_lease(&changed, &device, issued_at, "test-key", &public),
            Err(LicenseError::Denied)
        );
        let another_device = Device {
            plugin_id: "studio.other".into(),
            public_key: "other-device".into(),
            ..device
        };
        assert_eq!(
            verify_lease(&lease, &another_device, issued_at, "test-key", &public),
            Err(LicenseError::Denied)
        );
        assert_eq!(
            verify_lease(&lease, &another_device, issued_at, "test-key", "invalid"),
            Err(LicenseError::Storage)
        );
    }

    #[test]
    fn test_lease_is_valid_only_for_its_plugin() {
        let directory = tempfile::tempdir().unwrap();
        let store = PluginLicenseStore::new(directory.path().join("license.sqlite")).unwrap();
        store.seed_test_license("studio.sales-agent").unwrap();
        assert_eq!(store.status("studio.sales-agent").unwrap().state, "active");
        assert_eq!(
            store.status("studio.window-sync").unwrap().state,
            "inactive"
        );
        assert!(store.require_for("studio.sales-agent", None).is_ok());
        assert_eq!(
            store.require_for("studio.window-sync", None),
            Err(LicenseError::NotActivated)
        );
    }
}
