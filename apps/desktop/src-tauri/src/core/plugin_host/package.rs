use super::manifest::PluginManifest;
use super::registry::digest;
use serde::Deserialize;

/// Container written by `scripts/pack-plugin.mjs`. The host only slices and
/// hashes: decryption happens inside the plugin process, so installing a
/// package needs no crypto code here.
pub const PACKAGE_MAGIC: &[u8; 4] = b"NXP1";
pub const PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const MAX_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_HEADER_BYTES: usize = 128 * 1024;
pub const MAX_FILES: usize = 64;
pub const MAX_PATH_BYTES: usize = 200;
/// Salt shared with the packer. It never ships inside a package, so a copy of
/// the store bucket alone cannot be decrypted.
const MARKET_SALT: &str = include_str!("market.salt");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    TooLarge,
    BadMagic,
    UnsupportedSchema,
    TruncatedHeader,
    MalformedHeader,
    TooManyFiles,
    UnsafePath,
    TruncatedBody,
    FileDigestMismatch,
    EntryMissing,
}

impl PackageError {
    pub fn message(self) -> &'static str {
        match self {
            PackageError::TooLarge => "插件包超过大小上限",
            PackageError::BadMagic => "不是有效的插件包",
            PackageError::UnsupportedSchema => "插件包格式版本不受支持",
            PackageError::TruncatedHeader => "插件包头不完整",
            PackageError::MalformedHeader => "插件包头无法解析",
            PackageError::TooManyFiles => "插件包文件数量超过上限",
            PackageError::UnsafePath => "插件包包含非法路径",
            PackageError::TruncatedBody => "插件包内容不完整",
            PackageError::FileDigestMismatch => "插件包内容校验失败",
            PackageError::EntryMissing => "插件包缺少入口文件",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageHeader {
    schema_version: u32,
    manifest: PluginManifest,
    entry: String,
    files: Vec<FileDescriptor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileDescriptor {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageContents {
    pub manifest: PluginManifest,
    pub entry: String,
    /// Relative path plus the verified bytes, in the order the header lists.
    pub files: Vec<(String, Vec<u8>)>,
}

impl PackageContents {
    pub fn read(&self, path: &str) -> Option<&[u8]> {
        self.files
            .iter()
            .find(|(name, _)| name == path)
            .map(|(_, bytes)| bytes.as_slice())
    }
}

pub fn parse(bytes: &[u8]) -> Result<PackageContents, PackageError> {
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err(PackageError::TooLarge);
    }
    if bytes.len() < PACKAGE_MAGIC.len() + 4 || &bytes[..PACKAGE_MAGIC.len()] != PACKAGE_MAGIC {
        return Err(PackageError::BadMagic);
    }
    let header_length = u32::from_be_bytes(bytes[4..8].try_into().expect("four bytes")) as usize;
    if header_length == 0 || header_length > MAX_HEADER_BYTES {
        return Err(PackageError::TruncatedHeader);
    }
    let header_end = 8 + header_length;
    if header_end > bytes.len() {
        return Err(PackageError::TruncatedHeader);
    }
    let header: PackageHeader =
        serde_json::from_slice(&bytes[8..header_end]).map_err(|_| PackageError::MalformedHeader)?;
    if header.schema_version != PACKAGE_SCHEMA_VERSION {
        return Err(PackageError::UnsupportedSchema);
    }
    if header.files.is_empty() || header.files.len() > MAX_FILES {
        return Err(PackageError::TooManyFiles);
    }
    header
        .manifest
        .validate()
        .map_err(|_| PackageError::MalformedHeader)?;

    let mut offset = header_end;
    let mut files = Vec::with_capacity(header.files.len());
    for descriptor in &header.files {
        if !safe_relative_path(&descriptor.path) {
            return Err(PackageError::UnsafePath);
        }
        let size = usize::try_from(descriptor.size).map_err(|_| PackageError::TruncatedBody)?;
        let end = offset
            .checked_add(size)
            .ok_or(PackageError::TruncatedBody)?;
        if end > bytes.len() {
            return Err(PackageError::TruncatedBody);
        }
        let data = &bytes[offset..end];
        if digest(data) != descriptor.sha256 {
            return Err(PackageError::FileDigestMismatch);
        }
        files.push((descriptor.path.clone(), data.to_vec()));
        offset = end;
    }
    if !files.iter().any(|(path, _)| *path == header.entry) {
        return Err(PackageError::EntryMissing);
    }
    Ok(PackageContents {
        manifest: header.manifest,
        entry: header.entry,
        files,
    })
}

/// The key handed to the plugin loader through `NEXUS_PLUGIN_KEY`. Must stay in
/// sync with `deriveKey` in `scripts/lib/market-package.mjs`.
pub fn key_for(plugin_id: &str, version: &str) -> String {
    digest(format!("{}\n{}\n{}", MARKET_SALT.trim(), plugin_id, version).as_bytes())
}

/// Only plain relative paths: no absolute prefix, no parent hop, no separator
/// other than `/`, and nothing that could escape the install directory.
pub fn safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\\') {
        return false;
    }
    if path.starts_with('/') || path.starts_with('.') || path.ends_with('/') {
        return false;
    }
    path.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    })
}
