// SPDX-License-Identifier: MIT
// Helper protocol adapted from ProxyShard/ShardBrowser sync_bus.rs and launch.rs
// at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e. See engine/LICENSE.upstream.
//! Focused loopback transport for the kernel's generated-person helper.
use super::host::AutomationService;
use super::store::{invalid, storage_error};
use crate::core::browser::provider::{BrowserError, BrowserProviderId, BrowserResult};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

static BUS: OnceLock<Arc<HelperBus>> = OnceLock::new();
const MAX_REPORT: usize = 1024 * 1024;

struct Admission {
    connection: String,
    profile: String,
}

struct Member {
    generation: String,
    writer: TcpStream,
}

struct HelperBus {
    port: u16,
    service: Weak<AutomationService>,
    admissions: Mutex<HashMap<String, Admission>>,
    members: Mutex<HashMap<String, Member>>,
}

#[derive(Deserialize)]
struct Hello {
    hello: String,
    token: String,
    profile: String,
}

pub fn initialize(service: &Arc<AutomationService>) -> BrowserResult<()> {
    if let Some(bus) = BUS.get() {
        if bus
            .service
            .upgrade()
            .is_some_and(|current| Arc::ptr_eq(&current, service))
        {
            return Ok(());
        }
        return Err(invalid("Helper bus is already initialized"));
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(storage_error)?;
    listener.set_nonblocking(true).map_err(storage_error)?;
    let bus = Arc::new(HelperBus {
        port: listener.local_addr().map_err(storage_error)?.port(),
        service: Arc::downgrade(service),
        admissions: Mutex::new(HashMap::new()),
        members: Mutex::new(HashMap::new()),
    });
    BUS.set(bus.clone())
        .map_err(|_| invalid("Helper bus initialization raced"))?;
    std::thread::spawn(move || {
        while bus.service.strong_count() > 0 {
            match listener.accept() {
                Ok((stream, peer)) if peer.ip().is_loopback() => {
                    let bus = bus.clone();
                    std::thread::spawn(move || bus.serve(stream));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });
    Ok(())
}

/// Called only by the managed ShardBrowser launch path, before process spawn.
/// Token admission is bound to the Raccoon UUID and immutable connection.
pub fn launch_args(connection_id: &str, profile_id: &str) -> BrowserResult<Vec<String>> {
    let bus = BUS
        .get()
        .ok_or_else(|| BrowserError::new("unavailable", "Kernel helper bus is not initialized"))?;
    let service = bus
        .service
        .upgrade()
        .ok_or_else(|| BrowserError::new("unavailable", "Automation service is closed"))?;
    let record = service.require_profile(connection_id, profile_id)?;
    if record.binding.provider_id != BrowserProviderId::ShardBrowser {
        return Err(BrowserError::unsupported(
            "The native helper bus requires ShardBrowser",
        ));
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut admissions = bus.admissions.lock().map_err(storage_error)?;
    admissions.retain(|_, admission| admission.profile != profile_id);
    admissions.insert(
        token.clone(),
        Admission {
            connection: connection_id.into(),
            profile: profile_id.into(),
        },
    );
    Ok(vec![
        format!("--shardx-bus=127.0.0.1:{}", bus.port),
        format!("--shardx-bus-token={token}"),
        format!("--shardx-sync-profile={profile_id}"),
        "--shardx-helper".into(),
    ])
}

pub fn fill(connection: &str, profile: &str) -> BrowserResult<usize> {
    let bus = BUS
        .get()
        .ok_or_else(|| BrowserError::new("unavailable", "Kernel helper bus is not initialized"))?;
    let key = serde_json::to_string(&(connection, profile)).map_err(storage_error)?;
    let mut members = bus.members.lock().map_err(storage_error)?;
    let member = members.get_mut(&key).ok_or_else(|| {
        BrowserError::new(
            "unavailable",
            "This running kernel has no helper bus connection",
        )
    })?;
    member.writer.write_all(b"{\"fill\":true}\n").map_err(|_| {
        BrowserError::new(
            "operation_uncertain",
            "Kernel helper fill result requires inspection",
        )
    })?;
    Ok(1)
}

pub fn shutdown() {
    if let Some(bus) = BUS.get() {
        if let Ok(mut members) = bus.members.lock() {
            for member in members.values() {
                let _ = member.writer.shutdown(std::net::Shutdown::Both);
            }
            members.clear();
        }
        if let Ok(mut admissions) = bus.admissions.lock() {
            admissions.clear();
        }
    }
}

fn read_line(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::other("Incomplete helper frame"))
            };
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |offset| offset + 1);
        if bytes.len() + count > MAX_REPORT {
            return Err(std::io::Error::other("Helper frame exceeds limit"));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(std::io::Error::other);
        }
    }
}

impl HelperBus {
    fn serve(&self, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let Ok(writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let Ok(Some(first)) = read_line(&mut reader) else {
            return;
        };
        let Ok(hello) = serde_json::from_str::<Hello>(&first) else {
            return;
        };
        if hello.hello.len() > 256 {
            return;
        }
        let admission = self.admissions.lock().ok().and_then(|admissions| {
            admissions
                .get(&hello.token)
                .filter(|admission| admission.profile == hello.profile)
                .map(|admission| (admission.connection.clone(), admission.profile.clone()))
        });
        let Some((connection, profile)) = admission else {
            return;
        };
        let Some(service) = self.service.upgrade() else {
            return;
        };
        if service.require_profile(&connection, &profile).is_err() {
            return;
        }
        let key = match serde_json::to_string(&(&connection, &profile)) {
            Ok(key) => key,
            Err(_) => return,
        };
        let generation = uuid::Uuid::new_v4().to_string();
        let Ok(mut members) = self.members.lock() else {
            return;
        };
        members.insert(
            key.clone(),
            Member {
                generation: generation.clone(),
                writer,
            },
        );
        drop(members);
        let _ = reader.get_ref().set_read_timeout(None);
        while let Ok(Some(line)) = read_line(&mut reader) {
            let current = self.members.lock().ok().is_some_and(|members| {
                members
                    .get(&key)
                    .is_some_and(|member| member.generation == generation)
            });
            if !current {
                break;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            if let Some(report) = message.get("helper") {
                if service
                    .helper_report(&connection, &profile, Some(report.clone()))
                    .is_err()
                {
                    break;
                }
            }
        }
        if let Ok(mut members) = self.members.lock() {
            if members
                .get(&key)
                .is_some_and(|member| member.generation == generation)
            {
                members.remove(&key);
                let _ = service.helper_report(&connection, &profile, None);
            }
        }
    }
}
