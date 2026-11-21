use std::path::{Path, PathBuf};

pub const DATABASE_FILE: &str = "raccoon.sqlite";

pub fn workspace_root(app_data: &Path) -> PathBuf {
    app_data.join("v2")
}

pub fn database_path(root: &Path) -> PathBuf {
    root.join(DATABASE_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_workspace_does_not_reuse_the_previous_database() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("nexus.sqlite");
        std::fs::write(&old, b"old workspace").unwrap();
        let new = workspace_root(root.path());

        assert_eq!(database_path(&new), root.path().join("v2/raccoon.sqlite"));
        assert_eq!(std::fs::read(old).unwrap(), b"old workspace");
        assert!(!new.exists());
    }
}
