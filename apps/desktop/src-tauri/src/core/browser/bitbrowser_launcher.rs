use super::provider::{BrowserError, BrowserResult};
use std::process::Command;

fn run(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|mut child| child.wait().is_ok_and(|status| status.success()))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn open_installed_app() -> BrowserResult<()> {
    for name in ["BitBrowser", "比特浏览器", "Bit Browser"] {
        if run("open", &["-a", name]) {
            return Ok(());
        }
    }
    Err(BrowserError::new(
        "unavailable",
        "未找到比特浏览器，请先安装后重试",
    ))
}

#[cfg(target_os = "windows")]
fn open_installed_app() -> BrowserResult<()> {
    use std::path::PathBuf;
    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in [
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
    ]
    .into_iter()
    .flatten()
    {
        let root = PathBuf::from(root);
        for name in ["BitBrowser", "比特浏览器"] {
            candidates.push(root.join(name).join("BitBrowser.exe"));
            candidates.push(root.join(name).join(format!("{name}.exe")));
        }
        candidates.push(
            root.join("Programs")
                .join("BitBrowser")
                .join("BitBrowser.exe"),
        );
    }
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        if run("cmd", &["/C", "start", "", &path.to_string_lossy()]) {
            return Ok(());
        }
    }
    Err(BrowserError::new(
        "unavailable",
        "未找到比特浏览器，请先安装后重试",
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_installed_app() -> BrowserResult<()> {
    if run("xdg-open", &["bitbrowser://"]) {
        return Ok(());
    }
    Err(BrowserError::new(
        "unavailable",
        "请手动启动比特浏览器后重试",
    ))
}

pub fn launch() -> BrowserResult<()> {
    open_installed_app()
}
