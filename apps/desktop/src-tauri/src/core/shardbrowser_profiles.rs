// Adapted from ProxyShard/ShardBrowser space/local/cookies.rs, commit
// 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
// MIT License
//
// Copyright (c) 2026 ShardBrowser
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

use crate::core::browser::provider::{BrowserError, BrowserProviderId, BrowserResult};
use crate::core::shardbrowser_fingerprints::connection;
use crate::core::window_service::WindowService;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

const MAX_COOKIES: usize = 50_000;
const MAX_BYTES: usize = 20 * 1024 * 1024;
const WIN_EPOCH_DELTA_SECS: f64 = 11_644_473_600.0;

#[derive(Clone, Serialize, Deserialize)]
pub struct Cookie {
    pub domain: String,
    pub name: String,
    pub value: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default, alias = "expirationDate")]
    pub expires: Option<f64>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, alias = "httpOnly")]
    pub http_only: bool,
    #[serde(default, alias = "sameSite")]
    pub same_site: Option<String>,
}

fn default_path() -> String {
    "/".into()
}
fn storage() -> BrowserError {
    BrowserError::new("storage_failed", "无法读写 Profile Cookie 数据")
}
fn invalid() -> BrowserError {
    BrowserError::new("invalid_config", "Cookie 数据格式无效")
}
fn crypt_error() -> BrowserError {
    BrowserError::new("cookie_crypto_failed", "无法解密或加密 Profile Cookie")
}

fn validate(cookies: &[Cookie]) -> BrowserResult<()> {
    if cookies.len() > MAX_COOKIES {
        return Err(invalid());
    }
    let mut bytes = 0usize;
    for cookie in cookies {
        bytes = bytes.saturating_add(
            cookie.domain.len() + cookie.name.len() + cookie.value.len() + cookie.path.len(),
        );
        let host = cookie.domain.strip_prefix('.').unwrap_or(&cookie.domain);
        if bytes > MAX_BYTES
            || host.is_empty()
            || cookie.domain.len() > 254
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            || cookie.name.is_empty()
            || cookie.name.len() + cookie.value.len() > 4096
            || cookie
                .name
                .bytes()
                .any(|b| b <= 0x20 || b"()<>@,;:\\\"/[]?={}".contains(&b))
            || cookie
                .value
                .bytes()
                .any(|b| b == 0 || b == b'\r' || b == b'\n')
            || !cookie.path.starts_with('/')
            || cookie.path.len() > 4096
            || cookie.path.contains('\0')
            || cookie
                .expires
                .is_some_and(|v| !v.is_finite() || v > 253_402_300_799.0 || v < -1.0)
            || cookie.same_site.as_ref().is_some_and(|v| {
                !["strict", "lax", "none", "unspecified", "no_restriction"]
                    .contains(&v.to_ascii_lowercase().as_str())
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn chromium_time(seconds: f64) -> i64 {
    ((seconds + WIN_EPOCH_DELTA_SECS) * 1_000_000.0) as i64
}

/// Reject symlinks along Chromium's known relative paths before SQLite opens
/// files or creates journals beneath the verified managed Profile directory.
fn safe_path(root: &Path, relative: &str) -> BrowserResult<PathBuf> {
    let mut path = root.to_path_buf();
    for part in Path::new(relative) {
        path.push(part);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(storage()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage()),
        }
    }
    Ok(path)
}

fn db_path(root: &Path) -> BrowserResult<PathBuf> {
    let primary = safe_path(root, "Default/Cookies")?;
    let alternate = safe_path(root, "Default/Network/Cookies")?;
    let path = if primary.exists() {
        primary
    } else if alternate.exists() {
        alternate
    } else {
        primary
    };
    for suffix in ["-wal", "-shm", "-journal"] {
        let name = format!(
            "{}{suffix}",
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(storage)?
        );
        safe_path(path.parent().ok_or_else(storage)?, &name)?;
    }
    Ok(path)
}

#[cfg(not(windows))]
fn os_key(_: &Path, _: bool) -> BrowserResult<Vec<u8>> {
    let mut key = vec![0u8; 16];
    #[cfg(target_os = "macos")]
    let (password, rounds): (&[u8], u32) = (b"mock_password", 1003);
    #[cfg(not(target_os = "macos"))]
    let (password, rounds): (&[u8], u32) = (b"peanuts", 1);
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA1,
        std::num::NonZeroU32::new(rounds).ok_or_else(crypt_error)?,
        b"saltysalt",
        password,
        &mut key,
    );
    Ok(key)
}

#[cfg(not(windows))]
fn encrypt(key: &[u8], host: &str, value: &str) -> BrowserResult<Vec<u8>> {
    use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
    let mut plain = Sha256::digest(host.as_bytes()).to_vec();
    plain.extend_from_slice(value.as_bytes());
    let cipher = cbc::Encryptor::<aes::Aes128>::new_from_slices(key, &[0x20; 16])
        .map_err(|_| crypt_error())?;
    let mut out = b"v10".to_vec();
    out.extend(cipher.encrypt_padded_vec_mut::<Pkcs7>(&plain));
    Ok(out)
}

fn checked_plain(host: &str, plain: Vec<u8>, version: i64) -> BrowserResult<String> {
    let value = if version >= 24 {
        if plain.len() < 32 || plain[..32] != Sha256::digest(host.as_bytes())[..] {
            return Err(crypt_error());
        }
        &plain[32..]
    } else {
        &plain[..]
    };
    String::from_utf8(value.to_vec()).map_err(|_| crypt_error())
}

#[cfg(not(windows))]
fn decrypt(
    key: &[u8],
    host: &str,
    value: &[u8],
    plain: String,
    version: i64,
) -> BrowserResult<String> {
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    if value.is_empty() {
        return Ok(plain);
    }
    // Linux's basic store uses v10, with the same CBC payload for v11.
    if !value.starts_with(b"v10") && !value.starts_with(b"v11") {
        return Err(crypt_error());
    }
    let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &[0x20; 16])
        .map_err(|_| crypt_error())?;
    let decrypted = cipher
        .decrypt_padded_vec_mut::<Pkcs7>(&value[3..])
        .map_err(|_| crypt_error())?;
    checked_plain(host, decrypted, version)
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> BrowserResult<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData},
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| crypt_error())?,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: source remains alive for the call. Windows allocates output and
    // LocalFree releases it after copying the returned bytes.
    unsafe {
        let ok = if protect {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(crypt_error());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(bytes)
    }
}

#[cfg(windows)]
fn os_key(root: &Path, create: bool) -> BrowserResult<Vec<u8>> {
    use base64::Engine;
    let path = safe_path(root, "Local State")?;
    let mut state: serde_json::Value = if path.exists() {
        let meta = std::fs::metadata(&path).map_err(|_| storage())?;
        if meta.len() > MAX_BYTES as u64 {
            return Err(storage());
        }
        serde_json::from_slice(&std::fs::read(&path).map_err(|_| storage())?)
            .map_err(|_| storage())?
    } else {
        serde_json::json!({})
    };
    if let Some(encoded) = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(serde_json::Value::as_str)
    {
        let wrapped = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| crypt_error())?;
        let key = dpapi(
            wrapped.strip_prefix(b"DPAPI").ok_or_else(crypt_error)?,
            false,
        )?;
        if key.len() != 32 {
            return Err(crypt_error());
        }
        return Ok(key);
    }
    if !create {
        return Err(crypt_error());
    }
    let mut key = vec![0; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut key)
        .map_err(|_| crypt_error())?;
    let mut wrapped = b"DPAPI".to_vec();
    wrapped.extend(dpapi(&key, true)?);
    if !state.is_object() || state.get("os_crypt").is_some_and(|v| !v.is_object()) {
        return Err(storage());
    }
    if state.get("os_crypt").is_none() {
        state["os_crypt"] = serde_json::json!({});
    }
    state["os_crypt"]["encrypted_key"] = base64::engine::general_purpose::STANDARD
        .encode(wrapped)
        .into();
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|_| storage())?;
    serde_json::to_writer(file.as_file_mut(), &state).map_err(|_| storage())?;
    file.as_file().sync_all().map_err(|_| storage())?;
    file.persist(path).map_err(|_| storage())?;
    Ok(key)
}

#[cfg(windows)]
fn encrypt(key: &[u8], host: &str, value: &str) -> BrowserResult<Vec<u8>> {
    let key = ring::aead::LessSafeKey::new(
        ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, key).map_err(|_| crypt_error())?,
    );
    let mut nonce = [0; 12];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce)
        .map_err(|_| crypt_error())?;
    let mut body = Sha256::digest(host.as_bytes()).to_vec();
    body.extend_from_slice(value.as_bytes());
    key.seal_in_place_append_tag(
        ring::aead::Nonce::assume_unique_for_key(nonce),
        ring::aead::Aad::empty(),
        &mut body,
    )
    .map_err(|_| crypt_error())?;
    let mut out = b"v10".to_vec();
    out.extend(nonce);
    out.extend(body);
    Ok(out)
}

#[cfg(windows)]
fn decrypt(
    key: &[u8],
    host: &str,
    value: &[u8],
    plain: String,
    version: i64,
) -> BrowserResult<String> {
    if value.is_empty() {
        return Ok(plain);
    }
    let body = value.strip_prefix(b"v10").ok_or_else(crypt_error)?;
    if body.len() < 28 {
        return Err(crypt_error());
    }
    let nonce: [u8; 12] = body[..12].try_into().map_err(|_| crypt_error())?;
    let key = ring::aead::LessSafeKey::new(
        ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, key).map_err(|_| crypt_error())?,
    );
    let mut encrypted = body[12..].to_vec();
    let plain = key
        .open_in_place(
            ring::aead::Nonce::assume_unique_for_key(nonce),
            ring::aead::Aad::empty(),
            &mut encrypted,
        )
        .map_err(|_| crypt_error())?;
    checked_plain(host, plain.to_vec(), version)
}

pub(crate) fn export(root: &Path) -> BrowserResult<Vec<Cookie>> {
    let path = db_path(root)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let key = os_key(root, false)?;
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| storage())?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|_| storage())?;
    let tx = conn.unchecked_transaction().map_err(|_| storage())?;
    let version: i64 = tx
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|_| storage())?
        .parse()
        .map_err(|_| storage())?;
    let mut statement = tx.prepare("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite FROM cookies").map_err(|_| storage())?;
    let mut rows = statement.query([]).map_err(|_| storage())?;
    let mut cookies = Vec::new();
    while let Some(row) = rows.next().map_err(|_| storage())? {
        if cookies.len() >= MAX_COOKIES {
            return Err(storage());
        }
        let host: String = row.get(0).map_err(|_| storage())?;
        let encrypted: Vec<u8> = row.get(3).map_err(|_| storage())?;
        let plain = row.get(2).map_err(|_| storage())?;
        let expires: i64 = row.get(5).map_err(|_| storage())?;
        let persistent: bool = row.get(8).map_err(|_| storage())?;
        let same_site: i64 = row.get(9).map_err(|_| storage())?;
        cookies.push(Cookie {
            value: decrypt(&key, &host, &encrypted, plain, version)?,
            domain: host,
            name: row.get(1).map_err(|_| storage())?,
            path: row.get(4).map_err(|_| storage())?,
            expires: persistent.then_some(expires as f64 / 1_000_000.0 - WIN_EPOCH_DELTA_SECS),
            secure: row.get(6).map_err(|_| storage())?,
            http_only: row.get(7).map_err(|_| storage())?,
            same_site: Some(
                match same_site {
                    0 => "None",
                    1 => "Lax",
                    2 => "Strict",
                    _ => "unspecified",
                }
                .into(),
            ),
        });
    }
    if serde_json::to_vec(&cookies).map_err(|_| storage())?.len() > MAX_BYTES {
        return Err(storage());
    }
    Ok(cookies)
}

pub(crate) fn import(root: &Path, cookies: &[Cookie]) -> BrowserResult<usize> {
    validate(cookies)?;
    if cookies.is_empty() {
        return Ok(0);
    }
    let path = db_path(root)?;
    let parent = path.parent().ok_or_else(storage)?;
    std::fs::create_dir_all(parent).map_err(|_| storage())?;
    let key = os_key(root, true)?;
    let conn = rusqlite::Connection::open(path).map_err(|_| storage())?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|_| storage())?;
    let tx = conn.unchecked_transaction().map_err(|_| storage())?;
    ensure_schema(&tx)?;
    let version: String = tx
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
            row.get(0)
        })
        .map_err(|_| storage())?;
    if version.parse::<i64>().map_err(|_| storage())? < 24 {
        return Err(BrowserError::unsupported("Cookie 数据库版本不支持直接导入"));
    }
    let now = chromium_time(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| storage())?
            .as_secs_f64(),
    );
    {
        let mut stmt = tx.prepare("INSERT OR REPLACE INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?1, ?2, '', ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?14, ?15, 0, 1)").map_err(|_| storage())?;
        for cookie in cookies {
            let expires = cookie.expires.filter(|v| *v >= 0.0);
            let same_site = match cookie
                .same_site
                .as_ref()
                .map(|v| v.to_ascii_lowercase())
                .as_deref()
            {
                Some("none" | "no_restriction") => 0,
                Some("lax") => 1,
                Some("strict") => 2,
                _ => -1,
            };
            stmt.execute(rusqlite::params![
                now,
                cookie.domain,
                cookie.name,
                encrypt(&key, &cookie.domain, &cookie.value)?,
                cookie.path,
                expires.map(chromium_time).unwrap_or(0),
                cookie.secure,
                cookie.http_only,
                now,
                expires.is_some(),
                expires.is_some(),
                same_site,
                if cookie.secure { 2 } else { 1 },
                if cookie.secure { 443 } else { 80 },
                now
            ])
            .map_err(|_| storage())?;
        }
    }
    tx.commit().map_err(|_| storage())?;
    Ok(cookies.len())
}

fn ensure_schema(conn: &rusqlite::Connection) -> BrowserResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);\
         INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '24');\
         INSERT OR IGNORE INTO meta (key, value) VALUES ('last_compatible_version', '24');\
         CREATE TABLE IF NOT EXISTS cookies (\
            creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, \
            top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, \
            encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, \
            is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, \
            has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, \
            samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, \
            last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL, \
            has_cross_site_ancestor INTEGER NOT NULL);\
         CREATE UNIQUE INDEX IF NOT EXISTS cookies_unique_index ON cookies (\
            host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);",
    ).map_err(|_| storage())?;
    Ok(())
}

fn record(
    state: &WindowService,
    connection_id: &str,
    id: &str,
) -> BrowserResult<crate::core::window_store::WindowRecord> {
    uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    let record = state
        .store
        .get(id)
        .map_err(|_| BrowserError::new("not_found", "Profile 不存在"))?;
    if record.binding.connection_id != connection_id
        || record.binding.provider_id != BrowserProviderId::ShardBrowser
    {
        return Err(BrowserError::new(
            "scope_mismatch",
            "Profile 不属于此 ShardBrowser 接入",
        ));
    }
    Ok(record)
}

#[derive(Serialize)]
pub struct CdpInfo {
    pub port: u16,
    pub http_url: String,
    pub web_socket_debugger_url: String,
}

#[tauri::command]
pub async fn browser_window_set_pin(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    id: String,
    pinned: bool,
) -> BrowserResult<bool> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.with_profile_access(&id, || {
            let connection = connection(&state, &connection_id)?;
            let record = record(&state, &connection_id, &id)?;
            let fallback = state.shard.editable_profile(&connection, &record)?.config;
            state
                .store
                .set_shardbrowser_pin(&id, &connection_id, pinned, fallback)
                .map_err(|_| storage())
        })
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "Profile 置顶任务中断"))?
}

async fn focus(info: CdpInfo) -> BrowserResult<()> {
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio_tungstenite::tungstenite::Message;
    let unavailable = || BrowserError::new("unavailable", "无法显示 Profile 浏览器窗口");
    let (mut socket, _) = tokio_tungstenite::connect_async(&info.web_socket_debugger_url)
        .await
        .map_err(|_| unavailable())?;
    // CDP asks Chromium to restore and raise its own window. It requires no
    // cross-application Accessibility grant or scripting permissions.
    let mut target = String::new();
    let mut window_id = 0_i64;
    for id in 1..=4 {
        let (method, params) = match id {
            1 => ("Target.getTargets", json!({})),
            2 => ("Browser.getWindowForTarget", json!({"targetId": target})),
            3 => (
                "Browser.setWindowBounds",
                json!({"windowId": window_id, "bounds": {"windowState":"normal"}}),
            ),
            _ => ("Target.activateTarget", json!({"targetId": target})),
        };
        socket
            .send(Message::Text(
                json!({"id":id, "method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|_| unavailable())?;
        let reply = loop {
            let frame = socket
                .next()
                .await
                .ok_or_else(unavailable)?
                .map_err(|_| unavailable())?;
            match frame {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).map_err(|_| unavailable())?;
                    if value["id"] == id {
                        break value;
                    }
                }
                Message::Close(_) => return Err(unavailable()),
                _ => {}
            }
        };
        if reply.get("error").is_some() {
            return Err(unavailable());
        }
        if id == 1 {
            target = reply["result"]["targetInfos"]
                .as_array()
                .ok_or_else(unavailable)?
                .iter()
                .find(|item| item["type"] == "page")
                .and_then(|item| item["targetId"].as_str())
                .ok_or_else(unavailable)?
                .to_owned();
        }
        if id == 2 {
            window_id = reply["result"]["windowId"]
                .as_i64()
                .ok_or_else(unavailable)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn shardbrowser_profile_cdp(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    profile_id: String,
) -> BrowserResult<CdpInfo> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.with_profile_access(&profile_id, || {
            let connection = connection(&state, &connection_id)?;
            let record = record(&state, &connection_id, &profile_id)?;
            state.shard.with_profile_cdp(&connection, &record, Ok)
        })
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "调试地址读取中断"))?
}

#[tauri::command]
pub async fn shardbrowser_profile_focus(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    profile_id: String,
) -> BrowserResult<()> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.with_profile_access(&profile_id, || {
            let connection = connection(&state, &connection_id)?;
            let record = record(&state, &connection_id, &profile_id)?;
            state.shard.with_profile_cdp(&connection, &record, |info| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| BrowserError::new("unavailable", "无法初始化窗口显示操作"))?;
                runtime.block_on(async {
                    tokio::time::timeout(Duration::from_secs(5), focus(info))
                        .await
                        .map_err(|_| BrowserError::new("unavailable", "显示窗口操作超时"))?
                })
            })
        })
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "显示窗口任务中断"))?
}

#[tauri::command]
pub async fn shardbrowser_cookies_import(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    profile_id: String,
    cookies: Vec<Cookie>,
) -> BrowserResult<usize> {
    validate(&cookies)?;
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.with_profile_access(&profile_id, || {
            let connection = connection(&state, &connection_id)?;
            let record = record(&state, &connection_id, &profile_id)?;
            state.shard.import_cookies(&connection, &record, &cookies)
        })
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "Cookie 导入任务中断"))?
}

#[tauri::command]
pub async fn shardbrowser_cookies_export_to_file(
    state: State<'_, Arc<WindowService>>,
    connection_id: String,
    profile_id: String,
    path: PathBuf,
) -> BrowserResult<usize> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        state.with_profile_access(&profile_id, || {
            let connection = connection(&state, &connection_id)?;
            let record = record(&state, &connection_id, &profile_id)?;
            let parent = path
                .parent()
                .filter(|_| path.is_absolute())
                .ok_or_else(invalid)?;
            let directory = std::fs::canonicalize(parent).map_err(|_| storage())?;
            // A JSON export must never replace managed databases, kernel files
            // or a Profile's receipts when the user chooses a destination.
            let managed = state.store.root().parent().ok_or_else(storage)?;
            if directory.starts_with(std::fs::canonicalize(managed).map_err(|_| storage())?) {
                return Err(BrowserError::new(
                    "invalid_config",
                    "请将 Cookie 导出到应用数据目录以外",
                ));
            }
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                    return Err(storage());
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(storage()),
            }
            let cookies = state.shard.export_cookies(&connection, &record)?;
            let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|_| storage())?;
            serde_json::to_writer_pretty(file.as_file_mut(), &cookies).map_err(|_| storage())?;
            file.flush().map_err(|_| storage())?;
            file.as_file().sync_all().map_err(|_| storage())?;
            file.persist(&path).map_err(|_| storage())?;
            #[cfg(unix)]
            std::fs::File::open(&directory)
                .and_then(|file| file.sync_all())
                .map_err(|_| storage())?;
            Ok(cookies.len())
        })
    })
    .await
    .map_err(|_| BrowserError::new("task_interrupted", "Cookie 导出任务中断"))?
}
