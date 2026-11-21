use super::browser::provider::{BrowserError, BrowserResult};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

const MAX_TEXT: usize = 8 * 1024 * 1024;
fn failed() -> BrowserError {
    BrowserError::new("clipboard_failed", "无法访问系统剪贴板")
}

#[cfg(target_os = "macos")]
fn read_command() -> Command {
    let mut command = Command::new("/usr/bin/pbpaste");
    command.args(["-Prefer", "txt"]);
    command.env("LC_CTYPE", "en_US.UTF-8");
    command
}
#[cfg(target_os = "macos")]
fn write_command() -> Command {
    let mut command = Command::new("/usr/bin/pbcopy");
    command.env("LC_CTYPE", "en_US.UTF-8");
    command
}
#[cfg(target_os = "windows")]
fn powershell(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        script,
    ]);
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
    command
}
#[cfg(target_os = "windows")]
fn read_command() -> Command {
    powershell(
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Write((Get-Clipboard -Raw))",
    )
}
#[cfg(target_os = "windows")]
fn write_command() -> Command {
    powershell(
        "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $text=[Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn read_text() -> BrowserResult<String> {
    let mut child = read_command()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failed())?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or_else(failed)?
        .take((MAX_TEXT + 1) as u64)
        .read_to_end(&mut bytes);
    if read.is_err() || bytes.len() > MAX_TEXT {
        let _ = child.kill();
        let _ = child.wait();
        return Err(failed());
    }
    if !child.wait().map_err(|_| failed())?.success() {
        return Err(failed());
    }
    String::from_utf8(bytes).map_err(|_| failed())
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn write_text(text: &str) -> BrowserResult<()> {
    if text.len() > MAX_TEXT {
        return Err(BrowserError::new("invalid_config", "剪贴板文本超过 8 MiB"));
    }
    let mut child = write_command()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failed())?;
    let write = child
        .stdin
        .take()
        .ok_or_else(failed)?
        .write_all(text.as_bytes());
    if write.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(failed());
    }
    if !child.wait().map_err(|_| failed())?.success() {
        return Err(failed());
    }
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_text() -> BrowserResult<String> {
    Err(BrowserError::unsupported("当前系统尚未接入原生剪贴板"))
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn write_text(_: &str) -> BrowserResult<()> {
    Err(BrowserError::unsupported("当前系统尚未接入原生剪贴板"))
}

#[tauri::command]
pub async fn browser_clipboard_read() -> BrowserResult<String> {
    tauri::async_runtime::spawn_blocking(read_text)
        .await
        .map_err(|_| failed())?
}
#[tauri::command]
pub async fn browser_clipboard_write(text: String) -> BrowserResult<()> {
    tauri::async_runtime::spawn_blocking(move || write_text(&text))
        .await
        .map_err(|_| failed())?
}
