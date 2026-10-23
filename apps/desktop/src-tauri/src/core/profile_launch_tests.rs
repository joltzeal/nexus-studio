use super::license_store::LicenseStore;
use super::plugin_host::PluginHost;
use super::profile_service::ProfileService;
use super::profile_store::{
    PreparedBinary, ProfileRecord, ProfileStore, ProxySource, WindowSettings,
};
use super::runtime_paths::RuntimePaths;
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(10);
const PLUGIN_ID: &str = "test.delayed-proxy";
const CONNECTION: &str = "socks5://fixture:synthetic-password@proxy.example.test:1080";

const PROXY_PLUGIN: &str = r#"
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const readline = require('node:readline')
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nexus.plugin.json'), 'utf8'))
const barrier = JSON.parse(fs.readFileSync(path.join(__dirname, 'barrier.json'), 'utf8'))
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
send({
  type: 'hello', protocolVersion: 1, pluginId: manifest.id,
  version: manifest.version, apiVersion: 1, capabilities: manifest.capabilities,
})
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'handshake') {
    send({
      type: 'ready', protocolVersion: 1, pluginId: manifest.id,
      version: manifest.version, capabilities: manifest.capabilities,
      methods: ['proxy.resolve'], status: {},
    })
  } else if (message.method === 'proxy.resolve') {
    const socket = net.createConnection({ host: '127.0.0.1', port: barrier.port })
    socket.on('error', () => process.exit(1))
    socket.once('connect', () => socket.write(JSON.stringify(message.payload) + '\n'))
    readline.createInterface({ input: socket }).once('line', (signal) => {
      if (signal !== 'release') process.exit(2)
      send({
        protocolVersion: 1, requestId: message.requestId, ok: true,
        result: {
          configured: true, configHandle: 'fixture:endpoint:7', secretRef: null,
          connectionUrl: barrier.connection,
        },
      })
      socket.end()
    })
  }
})
"#;

const BROWSER_RUNNER: &str = r#"
const fs = require('node:fs')
const readline = require('node:readline')
let configured = false
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!configured) {
    fs.writeFileSync(__CAPTURE__, line)
    configured = true
    process.stdout.write('NEXUS_READY\n')
  } else if (line === 'stop') {
    process.exit(0)
  }
})
"#;

/// The plugin acknowledges receiving the RPC, then withholds its stdio reply
/// until this socket is released. No elapsed-time assumption establishes order.
struct ResolutionBarrier {
    address: SocketAddr,
    entered: mpsc::Receiver<std::io::Result<TcpStream>>,
    acceptor: Option<JoinHandle<()>>,
    pending: Option<TcpStream>,
}

impl ResolutionBarrier {
    fn new() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, entered) = mpsc::channel();
        let acceptor = thread::spawn(move || {
            let _ = sender.send(listener.accept().map(|(stream, _)| stream));
        });
        Self {
            address,
            entered,
            acceptor: Some(acceptor),
            pending: None,
        }
    }

    fn wait_for_resolution(&mut self) {
        self.pending = Some(
            self.entered
                .recv_timeout(DEADLINE)
                .expect("launch did not reach the real proxy.resolve RPC before the deadline")
                .unwrap(),
        );
        let socket = self.pending.as_ref().unwrap();
        socket.set_read_timeout(Some(DEADLINE)).unwrap();
        let mut payload = String::new();
        BufReader::new(socket).read_line(&mut payload).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap(),
            json!({ "endpointId": 7 }),
        );
    }

    fn release(&mut self) {
        if let Some(mut socket) = self.pending.take() {
            let _ = socket.write_all(b"release\n");
        }
    }
}

impl Drop for ResolutionBarrier {
    fn drop(&mut self) {
        self.release();
        if let Some(acceptor) = self.acceptor.take() {
            // Also wake accept() if setup failed before the plugin connected.
            let _ = TcpStream::connect(self.address);
            let _ = acceptor.join();
        }
    }
}

struct StopPlugin(Arc<PluginHost>);

impl Drop for StopPlugin {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

struct StopBrowser<'a>(&'a ProfileService, &'a str);

impl Drop for StopBrowser<'_> {
    fn drop(&mut self) {
        let _ = self.0.stop(self.1);
    }
}

#[test]
fn pending_proxy_resolution_excludes_transfer_edit_and_delete_before_launch() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let barrier = ResolutionBarrier::new();
    let package = root.join("proxy-plugin");
    fs::create_dir_all(package.join("dist")).unwrap();
    fs::write(
        package.join("nexus.plugin.json"),
        serde_json::to_vec(&json!({
            "apiVersion": 1,
            "id": PLUGIN_ID,
            "version": "1.0.0",
            "name": "Delayed proxy fixture",
            "minCoreVersion": "0.1.0",
            "capabilities": ["proxy.provider"],
            "permissions": {
                "networkDomains": [],
                "wantsBrowserAccess": false,
                "storage": "private",
                "secrets": [],
            },
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"name":"delayed-proxy-fixture","main":"dist/index.cjs"}"#,
    )
    .unwrap();
    fs::write(package.join("dist/index.cjs"), PROXY_PLUGIN).unwrap();
    fs::write(
        package.join("dist/barrier.json"),
        serde_json::to_vec(&json!({
            "port": barrier.address.port(),
            "connection": CONNECTION,
        }))
        .unwrap(),
    )
    .unwrap();
    let host = Arc::new(PluginHost::open(root.join("plugins"), Vec::new()).unwrap());
    let _stop_plugin = StopPlugin(Arc::clone(&host));
    let installed = host.install(&package).unwrap();
    assert_eq!(installed.state, "running");

    let binary_path = root.join("browser");
    fs::write(&binary_path, b"browser-fixture").unwrap();
    let profiles = root.join("profiles");
    let original = ProfileStore::new(profiles.clone())
        .create_with_group(
            "Original window",
            ProxySource::plugin(PLUGIN_ID.into(), Some(7)),
            WindowSettings {
                fingerprint_seed: Some(12345),
                ..WindowSettings::default()
            },
            PreparedBinary {
                version: "145.0.7632.109".into(),
                binary_path,
            },
            None,
        )
        .unwrap();
    let capture = root.join("launched.json");
    let runner = root.join("browser-runner.cjs");
    fs::write(
        &runner,
        BROWSER_RUNNER.replace("__CAPTURE__", &serde_json::to_string(&capture).unwrap()),
    )
    .unwrap();
    let service = ProfileService::with_runtime(
        profiles,
        Some(host),
        LicenseStore::new(root.join("nexus.sqlite")).unwrap(),
        RuntimePaths {
            node: "node".into(),
            browser_script: runner,
            network_preload: root.join("unused-preload.cjs"),
        },
    )
    .unwrap();
    let user_data = service.store.user_data_dir(&original.id).unwrap();
    fs::create_dir_all(&user_data).unwrap();
    let marker = user_data.join("browser-state");
    fs::write(&marker, b"original browser data").unwrap();
    let _stop_browser = StopBrowser(&service, &original.id);

    thread::scope(|scope| {
        let launching = scope.spawn(|| service.launch(&original.id));
        // Drop this inside the scope so unwinding releases the RPC before the
        // scoped thread is joined.
        let mut barrier = barrier;
        barrier.wait_for_resolution();
        assert!(!launching.is_finished());
        assert!(
            !capture.exists(),
            "the runner must wait for proxy resolution"
        );

        let transfer_blocked = match service.lock_transfer(std::slice::from_ref(&original.id)) {
            Ok(guard) => {
                drop(guard);
                false
            }
            Err(_) => true,
        };
        let edit = service.update(
            &original.id,
            "Changed during proxy resolution".into(),
            ProxySource::plugin(PLUGIN_ID.into(), Some(99)),
            original.settings.clone(),
            None,
        );
        let delete = service.delete(&original.id);
        let saved_while_pending = service.store.get(&original.id);
        let data_while_pending = fs::read(&marker);

        barrier.release();
        let launched = launching.join().unwrap();

        assert!(
            transfer_blocked,
            "transfer acquired a live guard while proxy.resolve was pending; edit={edit:?}, delete={delete:?}",
        );
        assert!(
            edit.is_err(),
            "edit must be excluded during proxy resolution"
        );
        assert!(
            delete.is_err(),
            "delete must be excluded during proxy resolution",
        );
        assert_eq!(saved_while_pending.unwrap(), original);
        assert_eq!(data_while_pending.unwrap(), b"original browser data");
        launched.expect("the original launch should succeed after releasing proxy resolution");
        let launching_record: ProfileRecord =
            serde_json::from_slice(&fs::read(&capture).unwrap()).unwrap();
        assert_eq!(launching_record.proxy.as_deref(), Some(CONNECTION));
        assert_eq!(launching_record.proxy_endpoint, Some(7));
        assert_eq!(launching_record.binding, original.binding);
    });
}
