use super::discovery::Candidate;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Upper bound on copied entries so a hostile or accidental deep tree cannot
/// fill the disk during an install.
pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_DEPTH: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallError {
    SourceMissing,
    TooLarge,
    CopyFailed,
    DigestMismatch,
    EntryMissing,
    AlreadyInstalled,
    Io,
}

impl InstallError {
    pub fn message(self) -> &'static str {
        match self {
            InstallError::SourceMissing => "插件目录不存在",
            InstallError::TooLarge => "插件目录文件过多，已拒绝安装",
            InstallError::CopyFailed => "复制插件文件失败",
            InstallError::DigestMismatch => "插件清单在复制过程中发生变化，已拒绝安装",
            InstallError::EntryMissing => "插件缺少入口文件",
            InstallError::AlreadyInstalled => "该版本已安装",
            InstallError::Io => "无法写入插件目录",
        }
    }
}

pub fn version_directory(root: &Path, plugin_id: &str, version: &str) -> PathBuf {
    root.join("installed").join(plugin_id).join(version)
}

/// Copies a package into the host plugin directory. The copy is built in a
/// staging directory and renamed into place, so a failed install never leaves a
/// half-populated version behind.
pub fn install(candidate: &Candidate, root: &Path) -> Result<PathBuf, InstallError> {
    if !candidate.directory.is_dir() {
        return Err(InstallError::SourceMissing);
    }
    let target = version_directory(root, &candidate.manifest.id, &candidate.manifest.version);
    if target.exists() {
        return Err(InstallError::AlreadyInstalled);
    }
    let staging_root = root.join(".staging");
    fs::create_dir_all(&staging_root).map_err(|_| InstallError::Io)?;
    let staging = staging_root.join(Uuid::new_v4().to_string());
    fs::create_dir_all(&staging).map_err(|_| InstallError::Io)?;

    let mut copied = 0usize;
    let result = copy_tree(&candidate.directory, &staging, 0, &mut copied);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    // Re-read the copied manifest: what runs must be what was validated. The
    // path is relative to the package root, because a built package keeps its
    // manifest in `dist/`.
    let manifest_path = staging.join(&candidate.manifest_relative);
    let bytes = fs::read(&manifest_path).map_err(|_| {
        let _ = fs::remove_dir_all(&staging);
        InstallError::CopyFailed
    })?;
    if super::registry::digest(&bytes) != candidate.digest {
        let _ = fs::remove_dir_all(&staging);
        return Err(InstallError::DigestMismatch);
    }
    if !staging.join(&candidate.entry).is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err(InstallError::EntryMissing);
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| InstallError::Io)?;
    }
    if fs::rename(&staging, &target).is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err(InstallError::Io);
    }
    Ok(target)
}

pub fn uninstall(root: &Path, plugin_id: &str, version: &str) -> Result<(), InstallError> {
    let directory = version_directory(root, plugin_id, version);
    if directory.exists() {
        fs::remove_dir_all(&directory).map_err(|_| InstallError::Io)?;
    }
    if let Some(parent) = directory.parent() {
        // Drop the per-plugin directory once its last version is gone.
        if fs::read_dir(parent).is_ok_and(|mut entries| entries.next().is_none()) {
            let _ = fs::remove_dir(parent);
        }
    }
    Ok(())
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    depth: usize,
    copied: &mut usize,
) -> Result<(), InstallError> {
    if depth > MAX_DEPTH {
        return Err(InstallError::TooLarge);
    }
    for entry in fs::read_dir(source).map_err(|_| InstallError::CopyFailed)? {
        let entry = entry.map_err(|_| InstallError::CopyFailed)?;
        let name = entry.file_name();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        *copied += 1;
        if *copied > MAX_ENTRIES {
            return Err(InstallError::TooLarge);
        }
        let from = entry.path();
        let to = destination.join(&name);
        // `metadata` follows symlinks on purpose: pnpm links dependencies, and
        // the installed copy has to be self-contained.
        let metadata = fs::metadata(&from).map_err(|_| InstallError::CopyFailed)?;
        if metadata.is_dir() {
            fs::create_dir_all(&to).map_err(|_| InstallError::CopyFailed)?;
            copy_tree(&from, &to, depth + 1, copied)?;
        } else if metadata.is_file() {
            fs::copy(&from, &to).map_err(|_| InstallError::CopyFailed)?;
        }
    }
    Ok(())
}
