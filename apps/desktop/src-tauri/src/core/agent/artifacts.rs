use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::dto::*;
use super::{AgentResult, host_error, invalid, storage_error};
use crate::core::plugin_host::PluginHost;
use crate::core::plugin_host::manifest::Capability;

#[derive(Clone)]
pub struct Artifacts {
    root: PathBuf,
}

impl Artifacts {
    pub fn new(root: PathBuf) -> AgentResult<Self> {
        private_directory(&root)?;
        let root = fs::canonicalize(root).map_err(storage_error)?;
        Ok(Self { root })
    }

    pub fn begin(&self, batch_id: &str) -> AgentResult<()> {
        uuid(batch_id)?;
        let directory = self.root.join(batch_id);
        fs::create_dir(&directory).map_err(storage_error)?;
        private_directory(&directory)
    }

    pub fn discard(&self, batch_id: &str) {
        if uuid(batch_id).is_ok() {
            let _ = fs::remove_dir_all(self.root.join(batch_id));
        }
    }

    pub fn remove_retained_batch(&self, batch_id: &str) -> AgentResult<u64> {
        uuid(batch_id)?;
        let directory = self.root.join(batch_id);
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(storage_error(error)),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || fs::canonicalize(&directory).map_err(storage_error)? != directory
        {
            return Err(invalid(
                "Artifact cleanup directory is outside the controlled store",
            ));
        }
        let mut paths = Vec::new();
        for entry in fs::read_dir(&directory).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            let path = entry.path();
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| invalid("Unexpected artifact cleanup entry"))?;
            if uuid(stem).is_err()
                || !matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("png" | "jpg" | "webp")
                )
                || !entry.file_type().map_err(storage_error)?.is_file()
            {
                return Err(invalid("Unexpected artifact cleanup entry"));
            }
            paths.push((path, entry.metadata().map_err(storage_error)?.len()));
        }
        let mut freed = 0u64;
        for (path, bytes) in paths {
            fs::remove_file(path).map_err(storage_error)?;
            freed = freed.saturating_add(bytes);
        }
        fs::remove_dir(directory).map_err(storage_error)?;
        Ok(freed)
    }

    pub fn seal(&self, batch_id: &str) -> AgentResult<()> {
        uuid(batch_id)?;
        // Persist the new files and batch directory before SQLite can reference them.
        #[cfg(unix)]
        {
            File::open(self.root.join(batch_id))
                .and_then(|directory| directory.sync_all())
                .map_err(storage_error)?;
            File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(storage_error)?;
        }
        Ok(())
    }

    pub fn freeze(
        &self,
        host: &PluginHost,
        batch_id: &str,
        image: &Value,
        total_bytes: &mut u64,
        deadline: Instant,
    ) -> AgentResult<Value> {
        let id = image["id"]
            .as_str()
            .ok_or_else(|| invalid("Product image ID is missing"))?;
        uuid(id)?;
        let mime = image["mime"]
            .as_str()
            .ok_or_else(|| invalid("Product image MIME is missing"))?;
        let size = image["bytes"]
            .as_u64()
            .ok_or_else(|| invalid("Product image size is missing"))?;
        let expected = image["sha256"]
            .as_str()
            .ok_or_else(|| invalid("Product image digest is missing"))?;
        let name = image["name"]
            .as_str()
            .ok_or_else(|| invalid("Product image name is missing"))?;
        text(name, 1, 200)?;
        if !matches!(mime, "image/png" | "image/jpeg" | "image/webp")
            || size == 0
            || size > MAX_IMAGE_BYTES
            || expected.len() != 64
            || !expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || total_bytes
                .checked_add(size)
                .is_none_or(|bytes| bytes > MAX_ARTIFACT_BYTES)
        {
            return Err(invalid(
                "Product images exceed the allowed type, digest, size, or batch budget",
            ));
        }
        let artifact_id = Uuid::new_v4().to_string();
        let path = self.path(batch_id, &artifact_id, mime)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(storage_error)?;
        let mut offset = 0u64;
        let mut hash = Sha256::new();
        let mut prefix = Vec::new();
        while offset < size {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(invalid("Batch image snapshot deadline exceeded"));
            }
            let length = (size - offset).min(IMAGE_CHUNK as u64);
            let chunk = host
                .call(
                    "studio.products",
                    Capability::ProductCatalog,
                    "products.images.read",
                    json!({"imageId":id,"offset":offset,"length":length}),
                    remaining.min(Duration::from_secs(30)),
                )
                .map_err(host_error)?;
            let encoded = chunk["data"]
                .as_str()
                .filter(|value| value.len() <= IMAGE_CHUNK.div_ceil(3) * 4)
                .ok_or_else(|| invalid("Invalid product image chunk"))?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| invalid("Invalid product image encoding"))?;
            let next = offset + bytes.len() as u64;
            if bytes.is_empty()
                || bytes.len() > length as usize
                || next > size
                || chunk["next"].as_u64() != Some(next)
                || chunk["total"].as_u64() != Some(size)
                || chunk["done"].as_bool() != Some(next == size)
            {
                return Err(invalid("Product image chunk progress or size mismatch"));
            }
            if prefix.len() < 16 {
                prefix.extend_from_slice(&bytes[..bytes.len().min(16 - prefix.len())]);
            }
            hash.update(&bytes);
            file.write_all(&bytes).map_err(storage_error)?;
            offset = next;
        }
        if format!("{:x}", hash.finalize()) != expected || !matches_mime(mime, &prefix) {
            return Err(invalid(
                "Product image SHA-256 or MIME does not match its bytes",
            ));
        }
        file.sync_all().map_err(storage_error)?;
        *total_bytes += size;
        let mut frozen = image.clone();
        frozen["artifactId"] = json!(artifact_id);
        Ok(frozen)
    }

    fn path(&self, batch_id: &str, id: &str, mime: &str) -> AgentResult<PathBuf> {
        uuid(batch_id)?;
        uuid(id)?;
        let extension = match mime {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => return Err(invalid("Unsupported frozen artifact MIME type")),
        };
        let directory = self.root.join(batch_id);
        if fs::symlink_metadata(&directory)
            .map_err(storage_error)?
            .file_type()
            .is_symlink()
            || fs::canonicalize(&directory).map_err(storage_error)? != directory
        {
            return Err(invalid(
                "Artifact directory is not controlled by the agent store",
            ));
        }
        Ok(directory.join(format!("{id}.{extension}")))
    }

    pub fn resolve(
        &self,
        batch_id: &str,
        id: &str,
        mime: &str,
        size: u64,
        digest: &str,
    ) -> AgentResult<PathBuf> {
        let path = self.path(batch_id, id, mime)?;
        let metadata = fs::symlink_metadata(&path).map_err(storage_error)?;
        if !metadata.file_type().is_file() || metadata.len() != size || size > MAX_IMAGE_BYTES {
            return Err(invalid("Frozen artifact is missing or has changed size"));
        }
        let mut file = File::open(&path).map_err(storage_error)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut prefix = Vec::new();
        loop {
            let count = file.read(&mut buffer).map_err(storage_error)?;
            if count == 0 {
                break;
            }
            if prefix.is_empty() {
                prefix.extend_from_slice(&buffer[..count.min(16)]);
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != digest || !matches_mime(mime, &prefix) {
            return Err(invalid(
                "Frozen artifact failed SHA-256 or MIME verification",
            ));
        }
        Ok(path)
    }

    pub fn read(
        &self,
        batch_id: &str,
        id: &str,
        metadata: (&str, u64, &str),
        offset: u64,
        length: u64,
    ) -> AgentResult<Value> {
        let (mime, size, digest) = metadata;
        if length == 0 || length > IMAGE_CHUNK as u64 || offset > size {
            return Err(invalid("Invalid artifact chunk bounds"));
        }
        let path = self.resolve(batch_id, id, mime, size, digest)?;
        let mut file = File::open(path).map_err(storage_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(storage_error)?;
        let mut bytes = vec![0; length.min(size - offset) as usize];
        file.read_exact(&mut bytes).map_err(storage_error)?;
        let next = offset + bytes.len() as u64;
        Ok(json!({"data":STANDARD.encode(&bytes),"next":next,"done":next==size,"total":size}))
    }
}

fn private_directory(path: &Path) -> AgentResult<()> {
    fs::create_dir_all(path).map_err(storage_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(storage_error)?;
    }
    Ok(())
}

fn matches_mime(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}
