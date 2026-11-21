// SPDX-License-Identifier: MIT
// Adapted from ProxyShard/ShardBrowser src-tauri/src/api.rs at
// 99e780e2e685e5b3b5357c5baee8796e10b3ce1e (Axum, HS256 and automation routes).
// Copyright (c) 2026 ShardBrowser. MIT notice in engine/LICENSE.upstream.

use super::engine::model::Project;
use super::host::{AutomationService, blocking};
use super::store::{invalid, storage_error};
use crate::core::browser::provider::{BrowserError, BrowserResult};
use crate::core::database::open_database;
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, Uri, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const TOKEN_TTL: u64 = 60 * 60 * 24 * 365 * 10;
const BODY_LIMIT: usize = 32 * 1024 * 1024;
type Secret = Arc<RwLock<String>>;

// Explicit allowlist. The package is embedded at compile time and exported
// locally, with no runtime dependency on the repository or download service.
const MCP_FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../../../../../../packages/automation-mcp/package.json"),
    ),
    (
        "index.js",
        include_str!("../../../../../../packages/automation-mcp/index.js"),
    ),
    (
        "client.js",
        include_str!("../../../../../../packages/automation-mcp/client.js"),
    ),
    (
        "server.js",
        include_str!("../../../../../../packages/automation-mcp/server.js"),
    ),
    (
        "README.md",
        include_str!("../../../../../../packages/automation-mcp/README.md"),
    ),
    (
        "LICENSE.upstream",
        include_str!("../../../../../../packages/automation-mcp/LICENSE.upstream"),
    ),
    (
        "test/client.test.js",
        include_str!("../../../../../../packages/automation-mcp/test/client.test.js"),
    ),
    (
        "test/server.test.js",
        include_str!("../../../../../../packages/automation-mcp/test/server.test.js"),
    ),
];

fn write_mcp_package(dir: &str) -> BrowserResult<String> {
    use std::io::Write;
    let parent = std::path::Path::new(dir);
    if !parent.is_absolute() || !parent.is_dir() {
        return Err(invalid(
            "Select an existing absolute folder for the MCP package",
        ));
    }
    // Reserve a fresh directory atomically, including when another export is
    // running concurrently. Existing files, symlinks and directories are kept.
    let mut destination = None;
    for suffix in 0..1000 {
        let name = if suffix == 0 {
            "raccoon-automation-mcp".to_owned()
        } else {
            format!("raccoon-automation-mcp-{suffix}")
        };
        let candidate = parent.join(name);
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                destination = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(BrowserError::new(
                    "storage_failed",
                    "Unable to create the MCP package directory",
                ));
            }
        }
    }
    let destination = destination.ok_or_else(|| {
        BrowserError::new("conflict", "Choose another folder for the MCP package")
    })?;
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir(destination.join("test"))?;
        for (name, contents) in MCP_FILES {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination.join(name))?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        // Leave partial output available for inspection. Never remove a tree
        // that another process could have populated after its reservation.
        return Err(BrowserError::new(
            "storage_failed",
            "MCP package export was incomplete; choose a new destination and retry",
        ));
    }
    destination
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("The destination path must be valid Unicode"))
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: u64,
    exp: u64,
}

fn mint(secret: &str, ttl: u64) -> BrowserResult<String> {
    let now = super::store::now();
    encode(
        &Header::new(Algorithm::HS256),
        &Claims {
            sub: "raccoon-automation-api".into(),
            iat: now,
            exp: now.saturating_add(ttl),
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| BrowserError::new("authentication_failed", "Unable to issue automation token"))
}

fn verify(secret: &str, token: &str) -> bool {
    if secret.len() < 64 {
        return false;
    }
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.sub = Some("raccoon-automation-api".into());
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .is_ok_and(|token| token.claims.iat <= super::store::now())
}

fn generate_secret() -> BrowserResult<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| {
        BrowserError::new(
            "authentication_failed",
            "Unable to generate automation signing key",
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct ApiError(BrowserError);

impl From<BrowserError> for ApiError {
    fn from(error: BrowserError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.code.as_str() {
            "invalid_config" => StatusCode::BAD_REQUEST,
            "connection_missing" | "project_missing" | "module_missing" | "window_missing" => {
                StatusCode::NOT_FOUND
            }
            "scope_mismatch" | "permission_denied" => StatusCode::FORBIDDEN,
            "conflict" | "profile_busy" | "operation_uncertain" | "operation_pending" => {
                StatusCode::CONFLICT
            }
            "unsupported" | "unsupported_operation" => StatusCode::NOT_IMPLEMENTED,
            "unavailable" | "connection_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            Json(json!({"code": self.0.code, "error": self.0.message, "retryable": self.0.retryable})),
        )
            .into_response()
    }
}

type ApiResult = Result<Json<Value>, ApiError>;

fn answer(value: impl Serialize) -> ApiResult {
    Ok(Json(serde_json::to_value(value).map_err(storage_error)?))
}

fn authorized(headers: &HeaderMap, secret: &Secret) -> bool {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .is_some_and(|(_, token)| {
            secret
                .read()
                .is_ok_and(|secret| verify(&secret, token.trim()))
        })
}

async fn auth(State(secret): State<Secret>, request: Request, next: Next) -> Response {
    if !authorized(request.headers(), &secret) {
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Bearer")],
            Json(json!({"code":"unauthorized","error":"A valid automation Bearer token is required"})),
        )
            .into_response();
    }
    next.run(request).await
}

/// The canonical scope is the query on every automation request, including
/// writes. No selected desktop Workspace or payload can supply a fallback.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    connection_id: String,
}

fn parse_scope(uri: &Uri) -> BrowserResult<Scope> {
    let Query(scope) = Query::<Scope>::try_from_uri(uri)
        .map_err(|_| invalid("Exactly one connectionId query parameter is required"))?;
    if scope.connection_id.is_empty()
        || scope.connection_id.len() > 256
        || scope.connection_id.trim() != scope.connection_id
        || scope.connection_id.chars().any(char::is_control)
    {
        return Err(invalid(
            "A nonempty connectionId query parameter is required",
        ));
    }
    Ok(scope)
}

async fn scope(mut request: Request, next: Next) -> Response {
    let scope = match parse_scope(request.uri()) {
        Ok(scope) => scope,
        Err(error) => return ApiError(error).into_response(),
    };
    request.extensions_mut().insert(scope);
    next.run(request).await
}

fn router(service: Arc<AutomationService>, secret: Secret) -> Router {
    Router::new()
        .route(
            "/automation/projects",
            get(list_projects).post(create_project),
        )
        .route(
            "/automation/projects/:id",
            get(get_project).put(save_project).delete(delete_project),
        )
        .route(
            "/automation/projects/:id/duplicate",
            post(duplicate_project),
        )
        .route("/automation/projects/:id/export", get(export_project))
        .route("/automation/projects/:id/run", post(run_project))
        .route(
            "/automation/projects/:id/reconcile",
            post(reconcile_project),
        )
        .route("/automation/projects/:id/stop", post(stop_project))
        .route("/automation/projects/:id/status", get(project_status))
        .route("/automation/import", post(import_project))
        .route("/automation/runs", get(list_runs))
        .route(
            "/automation/modules",
            get(list_modules).post(install_module),
        )
        .route("/automation/modules/:id", delete(remove_module))
        .route(
            "/automation/modules/:id/permissions",
            get(module_permissions),
        )
        .route("/automation/modules/:id/grant", post(grant_module))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .route_layer(middleware::from_fn(scope))
        .route_layer(middleware::from_fn_with_state(secret, auth))
        .route("/health", get(health))
        .with_state(service)
}

async fn health() -> Json<Value> {
    Json(json!({"ok":true,"name":"raccoon-automation","version":env!("CARGO_PKG_VERSION")}))
}

async fn list_projects(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
) -> ApiResult {
    answer(service.list_projects(scope.connection_id).await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    #[serde(default)]
    name: String,
}

async fn create_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<CreateRequest>,
) -> ApiResult {
    answer(
        service
            .create_project(scope.connection_id, body.name)
            .await?,
    )
}

async fn get_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    answer(service.get_project(scope.connection_id, id).await?)
}

async fn save_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
    Json(mut body): Json<Value>,
) -> ApiResult {
    let object = body
        .as_object_mut()
        .ok_or_else(|| invalid("A project object is required"))?;
    object.insert("id".into(), json!(id));
    let project: Project =
        serde_json::from_value(body).map_err(|_| invalid("Invalid automation project"))?;
    answer(service.save_project(scope.connection_id, project).await?)
}

async fn delete_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    service
        .delete_project(scope.connection_id, id.clone())
        .await?;
    answer(json!({"deleted":true,"id":id}))
}

async fn duplicate_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    answer(service.duplicate_project(scope.connection_id, id).await?)
}

async fn export_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    answer(service.export_bundle(&scope.connection_id, &id).await?)
}

async fn import_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<Value>,
) -> ApiResult {
    answer(service.import_bundle(&scope.connection_id, body).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunRequest {
    operation_id: String,
}

async fn run_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
    Json(body): Json<RunRequest>,
) -> ApiResult {
    if body.operation_id.trim().is_empty() || body.operation_id.len() > 256 {
        return Err(invalid("A stable operationId is required").into());
    }
    answer(
        service
            .run(scope.connection_id, id, body.operation_id)
            .await?,
    )
}

async fn stop_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    let returned_id = id.clone();
    blocking(move || service.stop(&scope.connection_id, &id)).await?;
    answer(json!({"project_id":returned_id,"stopping":true}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconcileRequest {
    confirmed: bool,
}

async fn reconcile_project(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
    Json(body): Json<ReconcileRequest>,
) -> ApiResult {
    answer(
        service
            .reconcile_run(scope.connection_id, id, body.confirmed)
            .await?,
    )
}

async fn project_status(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    answer(service.project_status(scope.connection_id, id).await?)
}

async fn list_runs(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
) -> ApiResult {
    answer(service.fleet(scope.connection_id).await?)
}

async fn list_modules(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
) -> ApiResult {
    answer(service.list_modules(scope.connection_id).await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallRequest {
    path: String,
}

async fn install_module(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Json(body): Json<InstallRequest>,
) -> ApiResult {
    if body.path.trim().is_empty() {
        return Err(invalid("A local WASM path is required").into());
    }
    answer(
        service
            .install_module(&scope.connection_id, body.path)
            .await?,
    )
}

async fn remove_module(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    service
        .remove_module(&scope.connection_id, id.clone())
        .await?;
    answer(json!({"deleted":true,"id":id}))
}

async fn module_permissions(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
) -> ApiResult {
    answer(service.module_permissions(scope.connection_id, id).await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRequest {
    modules: Vec<String>,
    flows: Vec<String>,
}

async fn grant_module(
    State(service): State<Arc<AutomationService>>,
    Extension(scope): Extension<Scope>,
    Path(id): Path<String>,
    Json(body): Json<GrantRequest>,
) -> ApiResult {
    answer(
        service
            .grant_module(scope.connection_id, id, body.modules, body.flows)
            .await?,
    )
}

struct Listener {
    port: u16,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}

impl Listener {
    async fn stop(self) {
        let Self {
            shutdown, mut task, ..
        } = self;
        let _ = shutdown.send(());
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}

/// Managed separately from AutomationService. Construction and application
/// startup leave the listener disabled, even after a previous explicit start.
pub struct AutomationHttpServer {
    service: Arc<AutomationService>,
    database: Mutex<Connection>,
    secret: Secret,
    listener: tokio::sync::Mutex<Option<Listener>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpStatus {
    pub running: bool,
    pub host: &'static str,
    pub port: Option<u16>,
    pub configured_port: u16,
}

impl AutomationHttpServer {
    pub fn new(service: Arc<AutomationService>, database: PathBuf) -> BrowserResult<Arc<Self>> {
        let mut database = open_database(&database).map_err(storage_error)?;
        let transaction = database.transaction().map_err(storage_error)?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS automation_http_settings(
               id INTEGER PRIMARY KEY CHECK(id=1),
               secret TEXT NOT NULL,
               port INTEGER NOT NULL DEFAULT 0 CHECK(port BETWEEN 0 AND 65535)
             );",
            )
            .map_err(storage_error)?;
        // INSERT OR IGNORE makes concurrent initialization keep a single key.
        transaction
            .execute(
                "INSERT OR IGNORE INTO automation_http_settings(id,secret,port) VALUES(1,?1,0)",
                [generate_secret()?],
            )
            .map_err(storage_error)?;
        let secret: String = transaction
            .query_row(
                "SELECT secret FROM automation_http_settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid("Stored automation signing key is invalid"));
        }
        transaction.commit().map_err(storage_error)?;
        Ok(Arc::new(Self {
            service,
            database: Mutex::new(database),
            secret: Arc::new(RwLock::new(secret)),
            listener: tokio::sync::Mutex::new(None),
        }))
    }

    fn configured_port(&self) -> BrowserResult<u16> {
        self.database
            .lock()
            .map_err(storage_error)?
            .query_row(
                "SELECT port FROM automation_http_settings WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    fn describe(&self, listener: &Option<Listener>) -> BrowserResult<HttpStatus> {
        Ok(HttpStatus {
            running: listener
                .as_ref()
                .is_some_and(|listener| !listener.task.is_finished()),
            host: "127.0.0.1",
            port: listener
                .as_ref()
                .filter(|listener| !listener.task.is_finished())
                .map(|listener| listener.port),
            configured_port: self.configured_port()?,
        })
    }

    /// None uses the persisted port. Some(0) requests an ephemeral loopback port.
    /// Explicit port changes reserve the new socket before draining the old
    /// listener. Bind or settings-write failures leave the old listener running.
    pub async fn start(&self, port: Option<u16>) -> BrowserResult<HttpStatus> {
        let mut current = self.listener.lock().await;
        let configured = self.configured_port()?;
        let requested = port.unwrap_or(configured);
        if current
            .as_ref()
            .is_some_and(|listener| !listener.task.is_finished())
            && requested == configured
        {
            return self.describe(&current);
        }
        // An ephemeral listener can already hold the newly requested fixed
        // port. Persist that choice without trying to bind its own live socket.
        if current.as_ref().is_some_and(|listener| {
            !listener.task.is_finished() && requested != 0 && listener.port == requested
        }) {
            self.database
                .lock()
                .map_err(storage_error)?
                .execute(
                    "UPDATE automation_http_settings SET port=?1 WHERE id=1",
                    [requested],
                )
                .map_err(storage_error)?;
            return self.describe(&current);
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, requested));
        let listener = tokio::net::TcpListener::bind(address).await.map_err(|_| {
            BrowserError::new(
                "unavailable",
                "Unable to bind the automation API loopback port",
            )
        })?;
        let port = listener
            .local_addr()
            .map_err(|_| {
                BrowserError::new("unavailable", "Unable to read the automation API port")
            })?
            .port();
        self.database
            .lock()
            .map_err(storage_error)?
            .execute(
                "UPDATE automation_http_settings SET port=?1 WHERE id=1",
                [requested],
            )
            .map_err(storage_error)?;
        if let Some(previous) = current.take() {
            previous.stop().await;
        }
        let app = router(self.service.clone(), self.secret.clone());
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
        });
        *current = Some(Listener {
            port,
            shutdown,
            task,
        });
        self.describe(&current)
    }

    pub async fn status(&self) -> BrowserResult<HttpStatus> {
        let listener = self.listener.lock().await;
        self.describe(&listener)
    }

    /// Stops accepting requests and drains for five seconds. Submitted runs
    /// remain owned by AutomationService and can be read after restarting HTTP.
    pub async fn stop(&self) -> BrowserResult<HttpStatus> {
        let mut current = self.listener.lock().await;
        if let Some(listener) = current.take() {
            listener.stop().await;
        }
        self.describe(&current)
    }

    /// Explicit credential retrieval for trusted desktop settings. HttpStatus
    /// and HTTP responses never contain the key or token.
    pub fn token(&self) -> BrowserResult<String> {
        let secret = self.secret.read().map_err(storage_error)?;
        mint(&secret, TOKEN_TTL)
    }

    pub fn rotate_token(&self) -> BrowserResult<String> {
        let replacement = generate_secret()?;
        let token = mint(&replacement, TOKEN_TTL)?;
        let mut secret = self.secret.write().map_err(storage_error)?;
        self.database
            .lock()
            .map_err(storage_error)?
            .execute(
                "UPDATE automation_http_settings SET secret=?1 WHERE id=1",
                [&replacement],
            )
            .map_err(storage_error)?;
        *secret = replacement;
        Ok(token)
    }

    pub async fn download_mcp(&self, dir: String) -> BrowserResult<String> {
        blocking(move || write_mcp_package(&dir)).await
    }
}

/// Call after host::initialize from the existing Tauri setup hook. This only
/// persists settings and registers state, with no network listener or token log.
pub fn initialize(app: &mut tauri::App) -> anyhow::Result<()> {
    use tauri::Manager;
    let root = crate::core::workspace_paths::workspace_root(&app.path().app_data_dir()?);
    let service = app.state::<Arc<AutomationService>>().inner().clone();
    app.manage(AutomationHttpServer::new(
        service,
        crate::core::workspace_paths::database_path(&root),
    )?);
    Ok(())
}

#[tauri::command]
pub async fn browser_automation_http_start(
    state: tauri::State<'_, Arc<AutomationHttpServer>>,
    port: Option<u16>,
) -> BrowserResult<HttpStatus> {
    state.start(port).await
}

#[tauri::command]
pub async fn browser_automation_http_status(
    state: tauri::State<'_, Arc<AutomationHttpServer>>,
) -> BrowserResult<HttpStatus> {
    state.status().await
}

#[tauri::command]
pub async fn browser_automation_http_stop(
    state: tauri::State<'_, Arc<AutomationHttpServer>>,
) -> BrowserResult<HttpStatus> {
    state.stop().await
}

#[tauri::command]
pub async fn browser_automation_http_token(
    state: tauri::State<'_, Arc<AutomationHttpServer>>,
) -> BrowserResult<String> {
    state.token()
}

#[tauri::command]
pub async fn browser_automation_http_rotate_token(
    state: tauri::State<'_, Arc<AutomationHttpServer>>,
) -> BrowserResult<String> {
    state.rotate_token()
}

#[tauri::command]
pub async fn browser_automation_mcp_download(
    state: tauri::State<'_, Arc<AutomationHttpServer>>,
    dir: String,
) -> BrowserResult<String> {
    state.download_mcp(dir).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> Secret {
        Arc::new(RwLock::new("a".repeat(64)))
    }

    #[test]
    fn scope_requires_one_explicit_nonempty_connection() {
        for path in [
            "/scope",
            "/scope?connectionId=",
            "/scope?connectionId=%20",
            "/scope?connectionId=a&connectionId=b",
            "/scope?providerId=adspower",
            "/scope?connectionId=a&workspace=b",
            "/scope?connectionId=a%00b",
        ] {
            assert!(parse_scope(&path.parse().unwrap()).is_err(), "{path}");
        }
        let first = parse_scope(&"/scope?connectionId=connection-a".parse().unwrap()).unwrap();
        let second = parse_scope(&"/scope?connectionId=connection-b".parse().unwrap()).unwrap();
        assert_eq!(first.connection_id, "connection-a");
        assert_eq!(second.connection_id, "connection-b");
    }

    #[test]
    fn bearer_header_and_live_rotation() {
        let secret = test_secret();
        let token = mint(&"a".repeat(64), 60).unwrap();
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, &secret));
        headers.insert(AUTHORIZATION, format!("bEaReR {token}").parse().unwrap());
        assert!(authorized(&headers, &secret));
        *secret.write().unwrap() = "b".repeat(64);
        assert!(!authorized(&headers, &secret));
        headers.insert(AUTHORIZATION, format!("Basic {token}").parse().unwrap());
        assert!(!authorized(&headers, &secret));
    }

    #[test]
    fn jwt_rejects_wrong_key_subject_expiry_and_empty_key() {
        let secret = "a".repeat(64);
        let token = mint(&secret, 60).unwrap();
        assert!(verify(&secret, &token));
        assert!(!verify(&"b".repeat(64), &token));
        assert!(!verify("", &token));
        assert!(!verify(&secret, "invalid"));
        let claims = Claims {
            sub: "other-api".into(),
            iat: 1,
            exp: u64::MAX / 2,
        };
        let wrong_subject = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert!(!verify(&secret, &wrong_subject));
        let claims = Claims {
            sub: "raccoon-automation-api".into(),
            iat: 1,
            exp: 2,
        };
        let expired = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert!(!verify(&secret, &expired));
    }

    #[test]
    fn mcp_export_uses_fresh_directories_and_the_exact_embedded_files() {
        let parent = tempfile::tempdir().unwrap();
        let existing = parent.path().join("raccoon-automation-mcp");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("user-file"), "keep").unwrap();
        let exported = write_mcp_package(parent.path().to_str().unwrap()).unwrap();
        assert_eq!(
            std::path::Path::new(&exported),
            parent.path().join("raccoon-automation-mcp-1")
        );
        assert_eq!(
            std::fs::read_to_string(existing.join("user-file")).unwrap(),
            "keep"
        );
        for (name, contents) in MCP_FILES {
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&exported).join(name)).unwrap(),
                *contents
            );
        }
        assert_eq!(std::fs::read_dir(&exported).unwrap().count(), 7);
        assert_eq!(
            std::fs::read_dir(std::path::Path::new(&exported).join("test"))
                .unwrap()
                .count(),
            2
        );
        assert!(write_mcp_package("relative-folder").is_err());
    }
}
