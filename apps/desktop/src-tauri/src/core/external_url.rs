use serde::Serialize;
use url::Url;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ExternalUrlError {
    InvalidUrl,
    OpenFailed,
    UnsupportedPlatform,
}

fn validated_url(input: &str) -> Result<Url, ExternalUrlError> {
    if input
        .bytes()
        .any(|byte| byte < 0x20 || byte == 0x7f || byte == b'\\')
    {
        return Err(ExternalUrlError::InvalidUrl);
    }
    let input = input.trim();
    let Some((scheme, _)) = input.split_once("://") else {
        return Err(ExternalUrlError::InvalidUrl);
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(ExternalUrlError::InvalidUrl);
    }
    let url = Url::parse(input).map_err(|_| ExternalUrlError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ExternalUrlError::InvalidUrl);
    }
    Ok(url)
}

#[tauri::command]
pub async fn external_url_open(url: String) -> Result<(), ExternalUrlError> {
    // Validate at the IPC boundary too; callers need not use the frontend adapter.
    let url = validated_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || open_browser(url.as_str()))
        .await
        .map_err(|_| ExternalUrlError::OpenFailed)?
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_browser(url: &str) -> Result<(), ExternalUrlError> {
    use std::process::{Command, Stdio};

    #[cfg(target_os = "macos")]
    const OPENER: &str = "/usr/bin/open";
    #[cfg(target_os = "linux")]
    const OPENER: &str = "/usr/bin/xdg-open";

    // One validated URL argument, no shell, browser selection or wait-for-app-exit flag.
    let status = Command::new(OPENER)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ExternalUrlError::OpenFailed)?;
    if status.success() {
        Ok(())
    } else {
        Err(ExternalUrlError::OpenFailed)
    }
}

#[cfg(target_os = "windows")]
fn open_browser(url: &str) -> Result<(), ExternalUrlError> {
    let url = url.to_owned();
    // A fresh thread gives Shell extensions their required STA COM apartment,
    // independent of any COM initialization on Tauri's shared blocking workers.
    std::thread::Builder::new()
        .name("nexus-external-url".into())
        .spawn(move || windows::open(&url))
        .map_err(|_| ExternalUrlError::OpenFailed)?
        .join()
        .map_err(|_| ExternalUrlError::OpenFailed)?
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn open_browser(_url: &str) -> Result<(), ExternalUrlError> {
    Err(ExternalUrlError::UnsupportedPlatform)
}

#[cfg(target_os = "windows")]
mod windows {
    use super::ExternalUrlError;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[link(name = "shell32")]
    unsafe extern "system" {
        #[link_name = "ShellExecuteW"]
        fn shell_execute(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> *mut c_void;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        #[link_name = "CoInitializeEx"]
        fn co_initialize(reserved: *mut c_void, flags: u32) -> i32;
        #[link_name = "CoUninitialize"]
        fn co_uninitialize();
    }

    pub(super) fn open(url: &str) -> Result<(), ExternalUrlError> {
        let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        // SAFETY: this fresh thread has no COM apartment, the reserved pointer is
        // null, and 0x2 | 0x4 is COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE.
        let initialized = unsafe { co_initialize(null_mut(), 0x2 | 0x4) };
        if initialized < 0 {
            return Err(ExternalUrlError::OpenFailed);
        }
        // SAFETY: both UTF-16 strings are NUL-terminated and live for the call.
        // Optional pointers are null, SW_SHOWNORMAL is 1, and the matching COM
        // uninitialize runs on the same thread after ShellExecuteW returns.
        let result = unsafe {
            let result = shell_execute(
                null_mut(),
                operation.as_ptr(),
                url.as_ptr(),
                null(),
                null(),
                1,
            );
            co_uninitialize();
            result as isize
        };
        if result > 32 {
            Ok(())
        } else {
            Err(ExternalUrlError::OpenFailed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_absolute_http_urls_without_changing_the_target() {
        for (input, expected) in [
            (
                " HTTPS://www.vinted.fr/items/123?ref=catalog#details ",
                "https://www.vinted.fr/items/123?ref=catalog#details",
            ),
            ("http://vinted.fr/member/123", "http://vinted.fr/member/123"),
        ] {
            assert_eq!(validated_url(input).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn rejects_unsafe_urls_at_the_native_boundary() {
        for input in [
            "",
            "not a URL",
            "//vinted.fr/items/1",
            "/items/1",
            "https:vinted.fr/items/1",
            "javascript:alert(1)",
            "file:///tmp/item.html",
            "data:text/html,hello",
            "mailto:seller@example.com",
            "vinted://items/1",
            "https://user:secret@vinted.fr/items/1",
            "https://user@vinted.fr/items/1",
            "https://vinted.fr\\@example.com/items/1",
            "https://vinted.fr/items/1\n",
            "https://vin\tted.fr/items/1",
            "https://vinted.fr/items/\0",
            "https://vinted.fr/items/\u{7f}",
        ] {
            assert_eq!(validated_url(input), Err(ExternalUrlError::InvalidUrl));
        }
    }
}
