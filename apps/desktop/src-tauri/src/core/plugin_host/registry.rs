use super::manifest::{Capability, PluginManifest};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const REGISTRY_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub manifest: PluginManifest,
    /// Absolute directory that holds the copied package.
    pub directory: PathBuf,
    /// Entry file relative to `directory`.
    pub entry: String,
    /// SHA-256 over the manifest bytes accepted at install time.
    pub manifest_digest: String,
    pub enabled: bool,
    pub granted_capabilities: Vec<Capability>,
    pub granted_domains: Vec<String>,
    pub installed_at: String,
}

impl InstalledPlugin {
    pub fn has_granted(&self, capability: Capability) -> bool {
        self.granted_capabilities.contains(&capability)
    }

    pub fn entry_path(&self) -> PathBuf {
        self.directory.join(&self.entry)
    }

    pub fn storage_directory(&self, plugins_root: &Path) -> PathBuf {
        plugins_root.join("data").join(&self.id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RegistryDocument {
    pub schema_version: u8,
    pub plugins: Vec<InstalledPlugin>,
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            plugins: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryError {
    Corrupt,
    Io,
}

/// Single JSON file owned by the host. Writes go through a temporary file and
/// a rename so an interrupted write cannot leave a half registry behind.
pub struct RegistryStore {
    path: PathBuf,
}

impl RegistryStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<RegistryDocument, RegistryError> {
        if !self.path.exists() {
            return Ok(RegistryDocument::default());
        }
        let bytes = fs::read(&self.path).map_err(|_| RegistryError::Io)?;
        if bytes.len() > 256 * 1024 {
            return Err(RegistryError::Corrupt);
        }
        let document: RegistryDocument =
            serde_json::from_slice(&bytes).map_err(|_| RegistryError::Corrupt)?;
        if document.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(RegistryError::Corrupt);
        }
        // A registry entry that no longer satisfies the manifest rules is not
        // silently repaired: it is reported so the user can reinstall.
        for plugin in &document.plugins {
            if plugin.manifest.id != plugin.id
                || plugin.manifest.version != plugin.version
                || plugin.manifest.validate().is_err()
            {
                return Err(RegistryError::Corrupt);
            }
        }
        Ok(document)
    }

    pub fn save(&self, document: &RegistryDocument) -> Result<(), RegistryError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| RegistryError::Io)?;
        }
        let bytes = serde_json::to_vec_pretty(document).map_err(|_| RegistryError::Io)?;
        let temporary = self.path.with_extension("json.tmp");
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temporary)
                .map_err(|_| RegistryError::Io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
            }
            file.write_all(&bytes).map_err(|_| RegistryError::Io)?;
            file.sync_all().map_err(|_| RegistryError::Io)?;
        }
        fs::rename(&temporary, &self.path).map_err(|_| RegistryError::Io)
    }
}

pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
