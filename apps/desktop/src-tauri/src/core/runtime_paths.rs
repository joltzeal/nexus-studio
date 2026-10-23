use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone)]
pub struct RuntimePaths {
    pub node: PathBuf,
    pub browser_script: PathBuf,
    pub network_preload: PathBuf,
}

impl RuntimePaths {
    pub fn development() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        Self {
            node: PathBuf::from("node"),
            browser_script: root.join("packages/browser-runtime/dist/profile-runner.js"),
            network_preload: root.join("packages/browser-runtime/dist/network-preload.js"),
        }
    }

    pub fn for_app(app: &impl Manager<tauri::Wry>) -> Result<Self, String> {
        if cfg!(debug_assertions) {
            return Ok(Self::development());
        }
        let resources = app.path().resource_dir().map_err(|_| "无法定位应用资源")?;
        let executable = std::env::current_exe().map_err(|_| "无法定位应用程序")?;
        Self::bundled(&resources, &executable)
    }

    fn bundled(resources: &Path, executable: &Path) -> Result<Self, String> {
        let node = if cfg!(target_os = "macos") {
            resources
                .parent()
                .ok_or("无法定位应用运行时")?
                .join("Helpers/node")
        } else {
            executable
                .parent()
                .ok_or("无法定位应用运行时")?
                .join(if cfg!(windows) { "node.exe" } else { "node" })
        };
        let browser_script = resources.join("runtime/browser-runtime/dist/profile-runner.js");
        let network_preload = resources.join("runtime/browser-runtime/dist/network-preload.js");
        // Plugins are installed from the store, so the bundle only has to carry
        // the Node binary and the browser adapter.
        if !node.is_file() || !browser_script.is_file() || !network_preload.is_file() {
            return Err("安装包缺少浏览器运行时，请重新安装 Nexus".into());
        }
        Ok(Self {
            node,
            browser_script,
            network_preload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimePaths;
    use std::fs;

    #[test]
    fn bundled_runtime_requires_node_and_browser_runner() {
        let root = tempfile::tempdir().unwrap();
        let contents = root.path().join("Nexus.app/Contents");
        let resources = if cfg!(windows) {
            root.path().join("resources")
        } else {
            contents.join("Resources")
        };
        let executable = if cfg!(windows) {
            root.path().join("nexus.exe")
        } else {
            contents.join("MacOS/nexus")
        };
        let node = if cfg!(windows) {
            root.path().join("node.exe")
        } else {
            contents.join("Helpers/node")
        };
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::write(&node, b"node").unwrap();
        let runner = resources.join("runtime/browser-runtime/dist/profile-runner.js");
        fs::create_dir_all(runner.parent().unwrap()).unwrap();
        fs::write(&runner, b"runner").unwrap();
        fs::write(
            resources.join("runtime/browser-runtime/dist/network-preload.js"),
            b"preload",
        )
        .unwrap();
        // Without the bundled Node binary the app must refuse to start rather
        // than fall back to whatever `node` happens to be on the PATH.
        fs::remove_file(&node).unwrap();
        assert!(RuntimePaths::bundled(&resources, &executable).is_err());
        fs::write(&node, b"node").unwrap();
        let resolved = RuntimePaths::bundled(&resources, &executable).unwrap();
        assert_eq!(resolved.node, node);
        assert_eq!(resolved.browser_script, runner);
    }
}
