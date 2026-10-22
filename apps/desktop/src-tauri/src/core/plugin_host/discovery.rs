use super::manifest::PluginManifest;
use super::registry::digest;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = "nexus.plugin.json";
pub const DEFAULT_ENTRY: &str = "dist/src/index.js";
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateSource {
    /// Copied into the host plugin directory by an install.
    Installed,
    /// Pointed at by `NEXUS_PLUGIN_DEV_ROOTS`.
    Development,
    /// `plugins/*` inside this repository, used while developing the host.
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub manifest: PluginManifest,
    pub directory: PathBuf,
    /// Manifest path relative to `directory`, so a package whose manifest lives
    /// in `dist/` keeps that layout after being copied.
    pub manifest_relative: PathBuf,
    pub entry: String,
    pub digest: String,
    pub source: CandidateSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryProblem {
    MissingManifest,
    UnreadableManifest,
    InvalidManifest(String),
    MissingEntry,
    DuplicateId(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiscoveryReport {
    pub candidates: Vec<Candidate>,
    pub problems: Vec<(PathBuf, DiscoveryProblem)>,
}

/// Reads one package directory. Returns `Ok(None)` when the directory is not a
/// plugin package at all, so unrelated folders are skipped without noise.
pub fn inspect(
    directory: &Path,
    source: CandidateSource,
) -> Result<Option<Candidate>, DiscoveryProblem> {
    let root_manifest = directory.join(MANIFEST_FILE);
    let manifest_path = if root_manifest.is_file() {
        root_manifest
    } else {
        directory.join("dist").join(MANIFEST_FILE)
    };
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(&manifest_path).map_err(|_| DiscoveryProblem::UnreadableManifest)?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(DiscoveryProblem::InvalidManifest("清单文件过大".into()));
    }
    let bytes = fs::read(&manifest_path).map_err(|_| DiscoveryProblem::UnreadableManifest)?;
    let manifest = PluginManifest::parse(&bytes)
        .map_err(|error| DiscoveryProblem::InvalidManifest(error.message().to_string()))?;
    let entry = read_entry(directory);
    if !directory.join(&entry).is_file() {
        return Err(DiscoveryProblem::MissingEntry);
    }
    let manifest_relative = manifest_path
        .strip_prefix(directory)
        .map_or_else(|_| PathBuf::from(MANIFEST_FILE), Path::to_path_buf);
    Ok(Some(Candidate {
        digest: digest(&bytes),
        manifest,
        directory: directory.to_path_buf(),
        manifest_relative,
        entry,
        source,
    }))
}

fn read_entry(directory: &Path) -> String {
    let package = directory.join("package.json");
    let Ok(bytes) = fs::read(&package) else {
        return DEFAULT_ENTRY.to_string();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return DEFAULT_ENTRY.to_string();
    };
    value
        .get("main")
        .and_then(|main| main.as_str())
        .filter(|main| {
            !main.is_empty()
                && !main.starts_with('/')
                && !main.contains("..")
                && (main.ends_with(".js") || main.ends_with(".cjs") || main.ends_with(".mjs"))
        })
        .map_or_else(|| DEFAULT_ENTRY.to_string(), ToString::to_string)
}

/// Scans each root. A root is either a package directory itself or a directory
/// whose children are packages.
pub fn scan_roots(roots: &[(PathBuf, CandidateSource)]) -> DiscoveryReport {
    let mut report = DiscoveryReport::default();
    let mut seen: Vec<String> = Vec::new();
    for (root, source) in roots {
        if !root.is_dir() {
            continue;
        }
        let mut directories = vec![root.clone()];
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    directories.push(entry.path());
                }
            }
        }
        for directory in directories {
            match inspect(&directory, *source) {
                Ok(Some(candidate)) => {
                    if seen.contains(&candidate.manifest.id) {
                        report.problems.push((
                            candidate.directory,
                            DiscoveryProblem::DuplicateId(candidate.manifest.id),
                        ));
                        continue;
                    }
                    seen.push(candidate.manifest.id.clone());
                    report.candidates.push(candidate);
                }
                Ok(None) => {}
                Err(problem) => report.problems.push((directory, problem)),
            }
        }
    }
    report
        .candidates
        .sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    report
}

/// Development roots: explicit env first, then this repository's `plugins/`.
pub fn development_roots() -> Vec<(PathBuf, CandidateSource)> {
    let mut roots = Vec::new();
    if let Ok(value) = std::env::var("NEXUS_PLUGIN_DEV_ROOTS") {
        for part in value.split(':').filter(|part| !part.trim().is_empty()) {
            roots.push((PathBuf::from(part), CandidateSource::Development));
        }
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
    if workspace.is_dir() {
        roots.push((workspace, CandidateSource::Workspace));
    }
    roots
}
