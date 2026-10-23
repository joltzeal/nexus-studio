use super::network_proxy::{NetworkProxy, NetworkProxyStore};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{Manager, ResourceId, State, Webview};
use tauri_plugin_updater::{Error, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Serialize)]
pub struct UpdateFailure {
    code: &'static str,
}

impl UpdateFailure {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

fn updater_error(error: Error) -> UpdateFailure {
    let code = match error {
        Error::EmptyEndpoints | Error::InsecureTransportProtocol | Error::UrlParse(_) => {
            "updater_config"
        }
        Error::ReleaseNotFound => "update_source",
        Error::Serialization(_) | Error::Semver(_) => "manifest",
        Error::TargetNotFound(_)
        | Error::TargetsNotFound(_)
        | Error::UnsupportedArch
        | Error::UnsupportedOs => "platform",
        Error::Reqwest(error) if error.is_timeout() => "timeout",
        Error::Reqwest(error) if error.is_decode() => "manifest",
        Error::Reqwest(_) | Error::Network(_) => "network",
        _ => "check_failed",
    };
    UpdateFailure::new(code)
}

#[derive(Clone)]
struct UpdateNetwork {
    proxy: Option<reqwest::Proxy>,
}

impl UpdateNetwork {
    fn resolve(network: &NetworkProxy) -> Result<Self, UpdateFailure> {
        let proxy = network
            .resolve()
            .map_err(|_| UpdateFailure::new("proxy_config"))?
            .map(reqwest::Proxy::all)
            .transpose()
            .map_err(|_| UpdateFailure::new("proxy_config"))?;
        Ok(Self { proxy })
    }

    fn load(store: &NetworkProxyStore) -> Result<Self, UpdateFailure> {
        let network = store
            .get()
            .map_err(|_| UpdateFailure::new("proxy_settings"))?;
        Self::resolve(&network)
    }

    fn configure(&self, client: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        // Tauri retains this hook on Update, so checks and downloads use the same
        // explicit route, without inheriting environment proxies or NO_PROXY.
        let client = client.no_proxy();
        match &self.proxy {
            Some(proxy) => client.proxy(proxy.clone()),
            None => client,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    raw_json: Value,
}

#[tauri::command]
pub async fn app_update_check(
    webview: Webview,
    network: State<'_, NetworkProxyStore>,
) -> Result<Option<UpdateMetadata>, UpdateFailure> {
    // The updater plugin is registered only in release builds.
    if cfg!(debug_assertions) {
        return Err(UpdateFailure::new("updater_config"));
    }
    let network = UpdateNetwork::load(&network)?;
    let updater = webview
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(move |client| network.configure(client))
        .build()
        .map_err(updater_error)?;
    let Some(mut update) = updater.check().await.map_err(updater_error)? else {
        return Ok(None);
    };
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut metadata = UpdateMetadata {
        rid: 0,
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(Value::as_str)
            .map(str::to_owned),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
    };
    metadata.rid = webview.resources_table().add(update);
    Ok(Some(metadata))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::network_proxy::ProxyMode;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    fn request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        String::from_utf8(bytes).unwrap()
    }

    fn respond(stream: &mut TcpStream) {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
    }

    fn fetch(network: &UpdateNetwork, url: &str) -> Result<String, reqwest::Error> {
        tauri::async_runtime::block_on(async {
            // Seed a stale proxy to prove the application route overrides it.
            let client = network
                .configure(
                    reqwest::Client::builder()
                        .proxy(reqwest::Proxy::all("http://127.0.0.1:9").unwrap())
                        .timeout(Duration::from_secs(3)),
                )
                .build()?;
            client.get(url).send().await?.text().await
        })
    }

    #[test]
    fn direct_ignores_inherited_proxies() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let received = request(&mut stream);
            respond(&mut stream);
            received
        });
        let dir = tempfile::tempdir().unwrap();
        let store = NetworkProxyStore::new(dir.path().join("network.sqlite")).unwrap();
        let network = UpdateNetwork::load(&store).unwrap();
        assert_eq!(
            fetch(&network, &format!("http://{address}/latest.json")).unwrap(),
            "ok"
        );
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("GET /latest.json HTTP/1.1")
        );
    }

    #[test]
    fn manual_http_proxy_carries_both_manifest_and_package_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(request(&mut stream));
                respond(&mut stream);
            }
            requests
        });
        let dir = tempfile::tempdir().unwrap();
        let store = NetworkProxyStore::new(dir.path().join("network.sqlite")).unwrap();
        store
            .set(NetworkProxy {
                mode: ProxyMode::Manual,
                url: Some(format!("http://{address}")),
            })
            .unwrap();
        let network = UpdateNetwork::load(&store).unwrap();
        for path in ["latest.json", "Nexus.app.tar.gz"] {
            assert_eq!(
                fetch(&network, &format!("http://updates.invalid/{path}")).unwrap(),
                "ok"
            );
        }
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET http://updates.invalid/latest.json HTTP/1.1"));
        assert!(requests[1].starts_with("GET http://updates.invalid/Nexus.app.tar.gz HTTP/1.1"));
    }

    #[test]
    fn manual_socks5_proxy_transports_the_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut greeting = [0; 2];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting[0], 5);
            let mut methods = vec![0; greeting[1] as usize];
            stream.read_exact(&mut methods).unwrap();
            assert!(methods.contains(&0));
            stream.write_all(&[5, 0]).unwrap();
            let mut connect = [0; 4];
            stream.read_exact(&mut connect).unwrap();
            assert_eq!(&connect[..3], &[5, 1, 0]);
            let length = match connect[3] {
                1 => 4,
                4 => 16,
                3 => {
                    let mut length = [0];
                    stream.read_exact(&mut length).unwrap();
                    length[0] as usize
                }
                _ => panic!("invalid SOCKS address type"),
            };
            let mut target = vec![0; length + 2];
            stream.read_exact(&mut target).unwrap();
            stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 9]).unwrap();
            let received = request(&mut stream);
            respond(&mut stream);
            received
        });
        let network = UpdateNetwork::resolve(&NetworkProxy {
            mode: ProxyMode::Manual,
            url: Some(format!("socks5://{address}")),
        })
        .unwrap();
        assert_eq!(
            fetch(&network, "http://127.0.0.1:9/latest.json").unwrap(),
            "ok"
        );
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("GET /latest.json HTTP/1.1")
        );
    }

    #[test]
    fn unreachable_proxy_never_falls_back_to_the_reachable_origin() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        origin.set_nonblocking(true).unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = proxy.local_addr().unwrap();
        drop(proxy);
        let network = UpdateNetwork::resolve(&NetworkProxy {
            mode: ProxyMode::Manual,
            url: Some(format!("http://{proxy_address}")),
        })
        .unwrap();
        assert!(
            fetch(
                &network,
                &format!("http://{}/latest.json", origin.local_addr().unwrap())
            )
            .is_err()
        );
        assert_eq!(
            origin.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn invalid_saved_proxy_blocks_the_check_without_exposing_its_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.sqlite");
        let store = NetworkProxyStore::new(path.clone()).unwrap();
        let connection = rusqlite::Connection::open(path).unwrap();
        connection
            .execute(
                "INSERT INTO network_proxy (id, mode, url) VALUES (1, 'manual', ?1)",
                ["http://user:private@127.0.0.1:7890"],
            )
            .unwrap();
        let error = UpdateNetwork::load(&store).err().unwrap();
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"code":"proxy_config"}"#
        );
    }

    #[test]
    fn unreadable_settings_do_not_silently_select_direct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.sqlite");
        let store = NetworkProxyStore::new(path.clone()).unwrap();
        std::fs::write(path, b"not sqlite").unwrap();
        assert_eq!(
            UpdateNetwork::load(&store).err().unwrap().code,
            "proxy_settings"
        );
    }

    #[test]
    fn missing_release_and_malformed_manifests_have_distinct_error_codes() {
        assert_eq!(updater_error(Error::ReleaseNotFound).code, "update_source");
        let error = serde_json::from_str::<Value>("{").unwrap_err();
        assert_eq!(updater_error(Error::Serialization(error)).code, "manifest");
        assert_eq!(
            updater_error(Error::TargetNotFound("darwin-aarch64".into())).code,
            "platform"
        );
    }

    #[test]
    fn invalid_json_from_the_update_server_is_a_manifest_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n{")
                .unwrap();
        });
        let error = tauri::async_runtime::block_on(async {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap()
                .get(format!("http://{address}/latest.json"))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap_err()
        });
        server.join().unwrap();
        assert_eq!(updater_error(Error::Reqwest(error)).code, "manifest");
    }

    #[test]
    fn resource_metadata_matches_the_official_typescript_update_constructor() {
        let metadata = UpdateMetadata {
            rid: 42,
            current_version: "0.1.1".into(),
            version: "0.1.2".into(),
            date: None,
            body: None,
            raw_json: serde_json::json!({ "version": "0.1.2" }),
        };
        assert_eq!(
            serde_json::to_value(metadata).unwrap(),
            serde_json::json!({
                "rid": 42,
                "currentVersion": "0.1.1",
                "version": "0.1.2",
                "rawJson": { "version": "0.1.2" },
            })
        );
    }
}
