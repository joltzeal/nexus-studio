use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;
use url::Url;

const MAX_HEADER: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

pub(super) struct ProxyRelay {
    port: u16,
    running: Arc<AtomicBool>,
}

impl ProxyRelay {
    pub fn start(url: &Url) -> Result<Self, String> {
        if !matches!(url.scheme(), "http" | "socks5" | "socks5h") {
            return Err("该代理协议暂不支持本机中继".into());
        }
        let upstream = url
            .host_str()
            .ok_or("代理地址无效")?
            .trim_matches(['[', ']'])
            .to_string();
        let upstream_port = url.port().ok_or("代理端口无效")?;
        let decode = |raw: &str| -> Result<String, String> {
            let query = format!("value={}", raw.replace('+', "%2B"));
            url::form_urlencoded::parse(query.as_bytes())
                .next()
                .map(|(_, value)| value.into_owned())
                .ok_or_else(|| "代理凭据无效".into())
        };
        let username = decode(url.username())?;
        let password = decode(url.password().unwrap_or(""))?;
        if username.len() > 255 || password.len() > 255 {
            return Err("代理用户名或密码过长".into());
        }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "无法建立本机代理中继")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法启动本机代理中继")?;
        let port = listener
            .local_addr()
            .map_err(|_| "无法读取本机代理端口")?
            .port();
        let running = Arc::new(AtomicBool::new(true));
        let active = Arc::clone(&running);
        let scheme = url.scheme().to_string();
        thread::spawn(move || {
            while active.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((client, _)) => {
                        let upstream = upstream.clone();
                        let username = username.clone();
                        let password = password.clone();
                        let scheme = scheme.clone();
                        thread::spawn(move || {
                            let mut reply = client.try_clone().ok();
                            if relay(
                                client,
                                &upstream,
                                upstream_port,
                                &scheme,
                                &username,
                                &password,
                            )
                            .is_err()
                                && let Some(client) = reply.as_mut()
                            {
                                let _ = client.write_all(
                                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                );
                            }
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self { port, running })
    }

    pub fn address(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for ProxyRelay {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

fn invalid() -> std::io::Error {
    std::io::ErrorKind::InvalidData.into()
}

fn read_header(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEADER {
            return Err(invalid());
        }
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        head.push(byte[0]);
    }
    String::from_utf8(head).map_err(|_| invalid())
}

fn connect_upstream(host: &str, port: u16) -> std::io::Result<TcpStream> {
    for address in (host, port).to_socket_addrs()? {
        if let Ok(stream) = TcpStream::connect_timeout(&address, TIMEOUT) {
            stream.set_read_timeout(Some(TIMEOUT))?;
            stream.set_write_timeout(Some(TIMEOUT))?;
            return Ok(stream);
        }
    }
    Err(std::io::ErrorKind::NotConnected.into())
}

fn socks_tunnel(
    server: &mut TcpStream,
    destination: &str,
    port: u16,
    username: &str,
    password: &str,
) -> std::io::Result<()> {
    server.write_all(if username.is_empty() && password.is_empty() {
        &[5, 1, 0][..]
    } else {
        &[5, 1, 2][..]
    })?;
    let mut reply = [0; 2];
    server.read_exact(&mut reply)?;
    if reply[0] != 5 {
        return Err(invalid());
    }
    if reply[1] == 2 {
        server.write_all(&[1, username.len() as u8])?;
        server.write_all(username.as_bytes())?;
        server.write_all(&[password.len() as u8])?;
        server.write_all(password.as_bytes())?;
        server.read_exact(&mut reply)?;
        if reply != [1, 0] {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
    } else if reply[1] != 0 || !username.is_empty() || !password.is_empty() {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let host = destination.as_bytes();
    if host.is_empty() || host.len() > 255 || port == 0 {
        return Err(invalid());
    }
    if let Ok(ip) = destination.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(ip) => {
                server.write_all(&[5, 1, 0, 1])?;
                server.write_all(&ip.octets())?;
            }
            std::net::IpAddr::V6(ip) => {
                server.write_all(&[5, 1, 0, 4])?;
                server.write_all(&ip.octets())?;
            }
        }
    } else {
        server.write_all(&[5, 1, 0, 3, host.len() as u8])?;
        server.write_all(host)?;
    }
    server.write_all(&port.to_be_bytes())?;
    let mut response = [0; 4];
    server.read_exact(&mut response)?;
    if response[0] != 5 || response[1] != 0 {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let length = match response[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut count = [0];
            server.read_exact(&mut count)?;
            count[0] as usize
        }
        _ => return Err(invalid()),
    };
    let mut discard = vec![0; length + 2];
    server.read_exact(&mut discard)?;
    Ok(())
}

fn relay(
    mut client: TcpStream,
    host: &str,
    port: u16,
    scheme: &str,
    username: &str,
    password: &str,
) -> std::io::Result<()> {
    client.set_read_timeout(Some(TIMEOUT))?;
    client.set_write_timeout(Some(TIMEOUT))?;
    let head = read_header(&mut client)?;
    let mut lines = head.split("\r\n");
    let request = lines.next().ok_or_else(invalid)?;
    let parts: Vec<_> = request.split_whitespace().collect();
    if parts.len() != 3 || !parts[2].starts_with("HTTP/1.") {
        return Err(invalid());
    }
    let is_connect = parts[0].eq_ignore_ascii_case("CONNECT");
    let target = if is_connect {
        Url::parse(&format!("http://{}", parts[1])).map_err(|_| invalid())?
    } else {
        Url::parse(parts[1]).map_err(|_| invalid())?
    };
    if (is_connect && target.port().is_none())
        || (!is_connect && target.scheme() != "http")
        || target.host_str().is_none()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err(invalid());
    }
    let destination = target.host_str().ok_or_else(invalid)?;
    let target_port = target.port_or_known_default().ok_or_else(invalid)?;
    let mut server = connect_upstream(host, port)?;
    let auth = (!username.is_empty() || !password.is_empty())
        .then(|| STANDARD.encode(format!("{username}:{password}")));
    if is_connect {
        if scheme == "http" {
            server.write_all(
                format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n", parts[1], parts[1]).as_bytes(),
            )?;
            if let Some(auth) = &auth {
                server.write_all(format!("Proxy-Authorization: Basic {auth}\r\n").as_bytes())?;
            }
            server.write_all(b"\r\n")?;
            let response = read_header(&mut server)?;
            if !response.lines().next().is_some_and(|line| {
                line.split_whitespace()
                    .nth(1)
                    .is_some_and(|code| code.starts_with('2'))
            }) {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
        } else {
            socks_tunnel(&mut server, destination, target_port, username, password)?;
        }
        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
    } else {
        if scheme != "http" {
            socks_tunnel(&mut server, destination, target_port, username, password)?;
        }
        let request_line = if scheme == "http" {
            request.to_string()
        } else {
            format!(
                "{} {}{} HTTP/1.1",
                parts[0],
                target.path(),
                target
                    .query()
                    .map_or(String::new(), |query| format!("?{query}"))
            )
        };
        server.write_all(format!("{request_line}\r\n").as_bytes())?;
        for line in lines.take_while(|line| !line.is_empty()) {
            if !line.split_once(':').is_some_and(|(name, _)| {
                name.eq_ignore_ascii_case("proxy-authorization")
                    || name.eq_ignore_ascii_case("proxy-connection")
                    || name.eq_ignore_ascii_case("connection")
            }) {
                server.write_all(format!("{line}\r\n").as_bytes())?;
            }
        }
        if scheme == "http"
            && let Some(auth) = &auth
        {
            server.write_all(format!("Proxy-Authorization: Basic {auth}\r\n").as_bytes())?;
        }
        server.write_all(b"Connection: close\r\n\r\n")?;
    }
    client.set_read_timeout(None)?;
    server.set_read_timeout(None)?;
    let mut from_client = client.try_clone()?;
    let mut to_server = server.try_clone()?;
    thread::spawn(move || {
        let _ = std::io::copy(&mut from_client, &mut to_server);
        let _ = to_server.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut server, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Write);
    Ok(())
}
