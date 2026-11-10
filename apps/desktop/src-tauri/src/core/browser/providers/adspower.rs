use crate::core::browser::connection_store::BrowserConnection;
use crate::core::browser::local_api::{
    LocalApi, MAX_PAGES, PAGE_SIZE, RequestKind, account_page_bytes, create_remark,
    invalid_response, observed_states, operation_marker, parse_proxy, preflight_error,
    profile_config, proxy_changed, reconcile_marker, require_scope, timestamp, uncertain, valid_id,
    validate_binding, validate_create, validate_settings, validate_update, verify_identity,
    verify_observed_identities,
};
use crate::core::browser::provider::{
    BrowserCapabilities, BrowserError, BrowserProvider, BrowserProviderId, BrowserResult,
    CreatedProfile, ObservedProfiles, ProviderGroup, ProviderProbe, ProxyMode, RemoteProfile,
    ResolvedProxy, UpdateEvidence, WindowState,
};
use crate::core::window_store::WindowRecord;
use serde_json::{Value, json};
use std::collections::HashSet;

const LIST: &str = "/api/v2/browser-profile/list";

pub struct AdsPowerProvider;

impl Default for AdsPowerProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AdsPowerProvider {
    pub fn new() -> Self {
        Self
    }

    fn validate_update_records(
        &self,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_update(previous, updated)?;
        if previous.schema_version != 2
            || updated.schema_version != 2
            || previous.binding.provider_id != self.id()
            || previous.binding.connection_id.is_empty()
        {
            return Err(BrowserError::new(
                "invalid_config",
                "窗口绑定与浏览器更新证据不匹配",
            ));
        }
        valid_id(&previous.binding.profile_id)?;
        validate_settings(updated)
    }
}

impl BrowserProvider for AdsPowerProvider {
    fn id(&self) -> BrowserProviderId {
        BrowserProviderId::AdsPower
    }

    fn capabilities(&self) -> BrowserCapabilities {
        let mut capabilities = BrowserCapabilities::for_provider(self.id());
        // V2 update requires fingerprints that the list endpoint cannot fully return.
        capabilities.update = false;
        capabilities.proxy_plugin = false;
        capabilities
    }

    fn probe(&self, connection: &BrowserConnection) -> BrowserResult<ProviderProbe> {
        let api = LocalApi::connect(connection, self.id())?;
        api.get("/status", &[], RequestKind::Probe)?;
        let data = api.post(LIST, &json!({"page": 1, "limit": 1}), RequestKind::Probe)?;
        if !data["list"].is_array() {
            return Err(invalid_response());
        }
        Ok(ProviderProbe {
            connected: true,
            message: "AdsPower 本地 API 可访问，请确认当前账户".into(),
            scope_id: None,
            capabilities: self.capabilities(),
        })
    }

    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        let api = LocalApi::connect(connection, self.id())?;
        query_profiles(&api, None)?
            .into_iter()
            .map(remote_profile)
            .collect()
    }

    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        let api = LocalApi::connect(connection, self.id())?;
        let mut groups = Vec::new();
        let mut seen = HashSet::new();
        let mut bytes = 0;
        for page in 1..=MAX_PAGES {
            let page_text = page.to_string();
            let data = api.get(
                "/api/v1/group/list",
                &[("page", &page_text), ("page_size", "100")],
                RequestKind::Read,
            )?;
            account_page_bytes(&mut bytes, &data)?;
            let rows = data["list"].as_array().ok_or_else(invalid_response)?;
            if rows.is_empty() {
                return Ok(groups);
            }
            if rows.len() > PAGE_SIZE {
                return Err(invalid_response());
            }
            for row in rows {
                let id = row["group_id"].as_str().ok_or_else(invalid_response)?;
                valid_id(id)?;
                let name = row["group_name"].as_str().ok_or_else(invalid_response)?;
                if !seen.insert(id.to_string()) {
                    return Err(invalid_response());
                }
                groups.push(ProviderGroup {
                    id: id.into(),
                    name: name.into(),
                });
            }
        }
        Err(invalid_response())
    }

    fn create_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        operation_id: &str,
    ) -> BrowserResult<CreatedProfile> {
        validate_create(connection, record, self.id())?;
        let body = create_payload(connection, record, operation_id)?;
        let api = LocalApi::connect(connection, self.id()).map_err(preflight_error)?;
        let _operation = api
            .lock_profile(&format!("create:{}", operation_marker(operation_id)?))
            .map_err(preflight_error)?;
        let data = api.post("/api/v2/browser-profile/create", &body, RequestKind::Write)?;
        let id = data["profile_id"]
            .as_str()
            .filter(|id| valid_id(id).is_ok())
            .ok_or_else(|| uncertain("AdsPower 创建响应缺少可核对的环境标识，请核对创建结果"))?;
        let (remote, _) = read_profile(&api, id)
            .map_err(|_| uncertain("AdsPower 已确认创建，但无法读回环境身份，请核对创建结果"))?;
        if reconcile_marker(vec![remote.clone()], operation_id)?.is_none() {
            return Err(uncertain("AdsPower 未确认 Nexus 创建标记，请核对创建结果"));
        }
        Ok(CreatedProfile {
            profile_id: remote.id,
            kernel_version: remote.kernel_version,
            binary_path: None,
            provider_config: remote.provider_config,
        })
    }

    fn update_profile(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_binding(connection, previous, self.id())?;
        self.validate_update_records(previous, updated)?;
        if previous.name != updated.name || configuration_changed(previous, updated) {
            return Err(BrowserError::unsupported(
                "AdsPower 更新要求完整指纹，尚未确认未知指纹能够保留，请在 AdsPower 中修改配置",
            ));
        }
        Ok(())
    }

    fn delete_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_binding(connection, record, self.id())?;
        require_scope(connection)?;
        let api = LocalApi::connect(connection, self.id()).map_err(preflight_error)?;
        let _profile = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let (remote, _) =
            read_profile(&api, &record.binding.profile_id).map_err(preflight_error)?;
        verify_identity(record, &remote)?;
        require_stopped(&api, &remote.id).map_err(preflight_error)?;
        // The V2 reference spells this key "Profile_id". Never retry another spelling.
        api.post(
            "/api/v2/browser-profile/delete",
            &json!({"Profile_id": [&remote.id]}),
            RequestKind::Write,
        )?;
        Ok(())
    }

    fn start_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
        proxy: &ResolvedProxy,
    ) -> BrowserResult<()> {
        validate_binding(connection, record, self.id())?;
        require_scope(connection)?;
        if proxy.mode != record.proxy_mode
            || (matches!(proxy.mode, ProxyMode::Direct | ProxyMode::Provider)
                && proxy.connection_url.is_some())
        {
            return Err(BrowserError::new(
                "invalid_config",
                "已解析的代理与窗口选择的来源不匹配",
            ));
        }
        if matches!(proxy.mode, ProxyMode::Manual | ProxyMode::Plugin) {
            parse_proxy(proxy.connection_url.as_deref().ok_or_else(|| {
                BrowserError::new("invalid_config", "尚未解析出必需的浏览器代理，已阻止启动")
            })?)?;
        }
        let api = LocalApi::connect(connection, self.id()).map_err(preflight_error)?;
        let _profile = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let (remote, raw) =
            read_profile(&api, &record.binding.profile_id).map_err(preflight_error)?;
        verify_identity(record, &remote)?;
        match observe_one(&api, &remote.id).map_err(preflight_error)? {
            WindowState::Running => return Ok(()),
            WindowState::Stopped => {}
            _ => {
                return Err(BrowserError::new(
                    "not_submitted",
                    "启动前无法确认 AdsPower 环境状态，尚未发送启动请求",
                ));
            }
        }
        verify_start_proxy(&raw, proxy)?;
        api.post(
            "/api/v2/browser-profile/start",
            &json!({"profile_id": remote.id}),
            RequestKind::Start,
        )?;
        Ok(())
    }

    fn stop_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_binding(connection, record, self.id())?;
        require_scope(connection)?;
        let api = LocalApi::connect(connection, self.id()).map_err(preflight_error)?;
        let _profile = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let (remote, _) =
            read_profile(&api, &record.binding.profile_id).map_err(preflight_error)?;
        verify_identity(record, &remote)?;
        api.post(
            "/api/v2/browser-profile/stop",
            &json!({"profile_id": remote.id}),
            RequestKind::Write,
        )?;
        Ok(())
    }

    fn observe_profiles(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles> {
        if records.is_empty() {
            return Ok(ObservedProfiles::default());
        }
        for record in records {
            validate_binding(connection, record, self.id())?;
        }
        let api = LocalApi::connect(connection, self.id())?;
        let profiles = query_profiles(&api, None)?
            .into_iter()
            .map(remote_profile)
            .collect::<BrowserResult<Vec<_>>>()?;
        let accessible = verify_observed_identities(records, &profiles)?;
        let data = api.get("/api/v1/browser/local-active", &[], RequestKind::Read)?;
        let rows = data["list"].as_array().ok_or_else(invalid_response)?;
        let mut active = HashSet::new();
        for row in rows {
            let id = row["user_id"].as_str().ok_or_else(invalid_response)?;
            valid_id(id)?;
            if !active.insert(id.to_string()) {
                return Err(invalid_response());
            }
        }
        let states = observed_states(records, &accessible, &active)?;
        Ok(ObservedProfiles { states, profiles })
    }

    fn reconcile_create(
        &self,
        connection: &BrowserConnection,
        operation_id: &str,
    ) -> BrowserResult<Option<RemoteProfile>> {
        operation_marker(operation_id)?;
        reconcile_marker(self.list_profiles(connection)?, operation_id)
    }

    fn prepare_update_evidence(
        &self,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<UpdateEvidence> {
        self.validate_update_records(previous, updated)?;
        if configuration_changed(previous, updated) {
            return Err(BrowserError::unsupported(
                "AdsPower 更新要求完整指纹，尚未确认未知指纹能够保留，请在 AdsPower 中修改配置",
            ));
        }
        let fields = if previous.name != updated.name {
            json!({"name": updated.name})
        } else {
            json!({})
        };
        UpdateEvidence::from_fields(self.id(), &fields)
    }

    fn reconcile_update(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool> {
        validate_binding(connection, previous, self.id())?;
        self.validate_update_records(previous, updated)?;
        evidence.validate(self.id())?;
        let api = LocalApi::connect(connection, self.id())?;
        let _profile = api.lock_profile(&previous.binding.profile_id)?;
        let (remote, raw) = read_profile(&api, &previous.binding.profile_id)?;
        verify_identity(previous, &remote)?;
        evidence.matches_fields(self.id(), &raw)
    }
}

fn configuration_changed(previous: &WindowRecord, updated: &WindowRecord) -> bool {
    proxy_changed(previous, updated)
        || previous.settings.geoip != updated.settings.geoip
        || previous.settings.timezone != updated.settings.timezone
        || previous.settings.locale != updated.settings.locale
        || previous.settings.viewport != updated.settings.viewport
        || previous.settings.start_url != updated.settings.start_url
}

fn query_profiles(api: &LocalApi, id: Option<&str>) -> BrowserResult<Vec<Value>> {
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();
    let mut bytes = 0;
    for page in 1..=MAX_PAGES {
        let mut body = json!({
            "page": page, "limit": PAGE_SIZE,
            "sort_type": "profile_no", "sort_order": "asc"
        });
        if let Some(id) = id {
            body["profile_id"] = json!([id]);
        }
        let data = api.post(LIST, &body, RequestKind::Read)?;
        account_page_bytes(&mut bytes, &data)?;
        if data
            .get("page")
            .is_some_and(|value| value.as_u64() != Some(page as u64))
        {
            return Err(invalid_response());
        }
        let rows = data["list"].as_array().ok_or_else(invalid_response)?;
        if rows.is_empty() {
            return Ok(profiles);
        }
        if rows.len() > PAGE_SIZE {
            return Err(invalid_response());
        }
        for row in rows {
            let row_id = row["profile_id"].as_str().ok_or_else(invalid_response)?;
            valid_id(row_id)?;
            if !seen.insert(row_id.to_string()) || id.is_some_and(|id| id != row_id) {
                return Err(invalid_response());
            }
            profiles.push(row.clone());
        }
    }
    Err(invalid_response())
}

fn read_profile(api: &LocalApi, id: &str) -> BrowserResult<(RemoteProfile, Value)> {
    let mut profiles = query_profiles(api, Some(id))?;
    if profiles.len() > 1 {
        return Err(invalid_response());
    }
    let raw = profiles.pop().ok_or_else(|| {
        BrowserError::new("profile_missing", "AdsPower 环境不可访问，请核对账户和权限")
    })?;
    Ok((remote_profile(raw.clone())?, raw))
}

fn remote_profile(raw: Value) -> BrowserResult<RemoteProfile> {
    let id = raw["profile_id"].as_str().ok_or_else(invalid_response)?;
    valid_id(id)?;
    let name = raw["name"].as_str().ok_or_else(invalid_response)?;
    let provider_config = profile_config(
        &raw,
        id,
        &[
            ("createdAt", "created_time"),
            ("ownerId", "owner_id"),
            ("createdBy", "created_by"),
            ("teamId", "team_id"),
        ],
    );
    Ok(RemoteProfile {
        id: id.into(),
        name: name.into(),
        kernel_version: raw["fingerprint_config"]["browser_kernel_config"]["version"]
            .as_str()
            .filter(|version| !version.is_empty() && *version != "ua_auto")
            .map(str::to_string),
        created_at: timestamp(raw.get("created_time")),
        provider_config,
    })
}

fn observe_one(api: &LocalApi, id: &str) -> BrowserResult<WindowState> {
    let data = api.get(
        "/api/v2/browser-profile/active",
        &[("profile_id", id)],
        RequestKind::Read,
    )?;
    match data["status"].as_str() {
        Some("Active") => Ok(WindowState::Running),
        Some("Inactive") => Ok(WindowState::Stopped),
        Some(_) => Ok(WindowState::Unknown),
        None => Err(invalid_response()),
    }
}

fn require_stopped(api: &LocalApi, id: &str) -> BrowserResult<()> {
    if observe_one(api, id)? != WindowState::Stopped {
        return Err(BrowserError::new(
            "profile_busy",
            "请先确认 AdsPower 环境已停止，再删除环境",
        ));
    }
    Ok(())
}

fn create_payload(
    connection: &BrowserConnection,
    record: &WindowRecord,
    operation_id: &str,
) -> BrowserResult<Value> {
    if record.settings.viewport != "default" {
        return Err(BrowserError::unsupported(
            "AdsPower 自定义窗口尺寸尚未验证，请在官方应用中设置",
        ));
    }
    let group_id = connection.default_group_id.as_deref().unwrap_or("0");
    valid_id(group_id)?;
    let proxy = match record.proxy_mode {
        ProxyMode::Direct => json!({"proxy_soft": "no_proxy", "global_config": "0"}),
        ProxyMode::Manual | ProxyMode::Plugin => {
            let proxy = parse_proxy(record.proxy.as_deref().ok_or_else(|| {
                BrowserError::new("invalid_config", "创建环境前必须先解析所需代理")
            })?)?;
            json!({
                "proxy_soft": "other", "proxy_type": proxy.protocol,
                "proxy_host": proxy.host, "proxy_port": proxy.port.to_string(),
                "proxy_user": proxy.username, "proxy_password": proxy.password,
                "global_config": "0"
            })
        }
        ProxyMode::Provider => {
            return Err(BrowserError::unsupported(
                "新建 AdsPower 环境需要明确选择代理来源",
            ));
        }
    };
    let automatic = record.settings.geoip && record.proxy_mode != ProxyMode::Direct;
    let mut fingerprint = json!({
        "automatic_timezone": if automatic && record.settings.timezone.is_empty() { "1" } else { "0" },
        "language_switch": if automatic && record.settings.locale.is_empty() { "1" } else { "0" },
        "webrtc": if automatic { "proxy" } else { "disabled" }
    });
    if !record.settings.timezone.is_empty() {
        fingerprint["timezone"] = json!(record.settings.timezone);
    }
    if !record.settings.locale.is_empty() {
        fingerprint["language"] = json!([record.settings.locale]);
    }
    let mut body = json!({
        "name": record.name, "group_id": group_id,
        "remark": create_remark(record, operation_id)?,
        "user_proxy_config": proxy, "fingerprint_config": fingerprint
    });
    if !record.settings.start_url.is_empty() {
        body["tabs"] = json!([record.settings.start_url]);
    }
    Ok(body)
}

fn verify_start_proxy(raw: &Value, proxy: &ResolvedProxy) -> BrowserResult<()> {
    let config = &raw["user_proxy_config"];
    if proxy.mode != ProxyMode::Provider
        && config
            .get("global_config")
            .is_some_and(|value| value.as_str() != Some("0") && value.as_i64() != Some(0))
    {
        return Err(BrowserError::unsupported(
            "AdsPower 全局代理覆盖与窗口指定的代理来源不兼容",
        ));
    }
    let matches = match proxy.mode {
        ProxyMode::Provider => true,
        ProxyMode::Direct => config["proxy_soft"].as_str() == Some("no_proxy"),
        ProxyMode::Manual | ProxyMode::Plugin => {
            let expected = parse_proxy(proxy.connection_url.as_deref().ok_or_else(|| {
                BrowserError::new("invalid_config", "尚未解析出必需的浏览器代理，已阻止启动")
            })?)?;
            config["proxy_soft"].as_str() == Some("other")
                && config["proxy_type"].as_str() == Some(expected.protocol.as_str())
                && config["proxy_host"].as_str() == Some(expected.host.as_str())
                && config["proxy_port"].as_str() == Some(expected.port.to_string().as_str())
                && config["proxy_user"].as_str().unwrap_or("") == expected.username
                && config["proxy_password"].as_str().unwrap_or("") == expected.password
        }
    };
    if !matches {
        return Err(BrowserError::unsupported(
            "无法安全确认 AdsPower 代理配置，已阻止启动；请先在 AdsPower 中修改并核对代理",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::browser::local_api::tests::{MockResponse, MockServer, record};
    use serde_json::json;

    fn page(rows: Value, page: usize) -> MockResponse {
        MockResponse::json(json!({"code": 0, "data": {
            "list": rows, "page": page, "limit": 100
        }}))
    }

    fn remote(id: &str, remark: &str) -> Value {
        json!({
            "profile_id": id,
            "profile_no": id,
            "name": "Remote",
            "created_time": "1794268800",
            "remark": remark,
            "password": "private",
            "user_proxy_config": {"proxy_soft": "other", "proxy_password": "private"}
        })
    }

    #[test]
    fn disabled_or_unconfirmed_connections_can_probe_and_list_groups_before_activation() {
        for (enabled, scope_confirmed, expected) in [
            (false, false, "invalid_config"),
            (false, true, "invalid_config"),
            (true, false, "scope_mismatch"),
        ] {
            let raw = remote("remote-1", "user memo");
            let server = MockServer::new(vec![
                MockResponse::json(json!({"code": 0})),
                page(json!([]), 1),
                MockResponse::json(json!({"code": 0, "data": {
                    "list": [{"group_id": "0", "group_name": "Ungrouped"}]
                }})),
                MockResponse::json(json!({"code": 0, "data": {"list": []}})),
                page(json!([raw.clone()]), 1),
                page(json!([]), 2),
                MockResponse::json(json!({"code": 0})),
            ]);
            let mut connection = server.connection(BrowserProviderId::AdsPower);
            connection.enabled = enabled;
            connection.scope_confirmed = scope_confirmed;
            let provider = AdsPowerProvider::new();
            let probe = provider.probe(&connection).unwrap();
            assert!(probe.connected);
            assert_eq!(probe.scope_id, None);
            let groups = provider.list_groups(&connection).unwrap();
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].id, "0");
            assert_eq!(connection.enabled, enabled);
            assert_eq!(connection.scope_confirmed, scope_confirmed);
            let mut window = record(&connection, "remote-1");
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let creating = record(&connection, "");
            let proxy = ResolvedProxy {
                mode: ProxyMode::Direct,
                connection_url: None,
            };
            for error in [
                provider
                    .create_profile(&connection, &creating, "op-1")
                    .err()
                    .unwrap(),
                provider.delete_profile(&connection, &window).unwrap_err(),
                provider
                    .start_profile(&connection, &window, &proxy)
                    .unwrap_err(),
                provider.stop_profile(&connection, &window).unwrap_err(),
            ] {
                assert_eq!(error.code, expected);
            }
            let requests = server.requests();
            assert_eq!(requests.len(), 4);
            assert_eq!(requests[0].target, "/status");
            assert_eq!(requests[1].target, LIST);
            assert_eq!(
                requests[2].target,
                "/api/v1/group/list?page=1&page_size=100"
            );
            assert_eq!(
                requests[3].target,
                "/api/v1/group/list?page=2&page_size=100"
            );
            connection.enabled = true;
            connection.scope_confirmed = true;
            provider.stop_profile(&connection, &window).unwrap();
            let requests = server.requests();
            assert_eq!(requests.len(), 7);
            assert_eq!(requests[6].target, "/api/v2/browser-profile/stop");
            assert_eq!(requests[6].body, json!({"profile_id": "remote-1"}));
        }
    }

    #[test]
    fn reconciles_across_short_pages_and_keeps_identity_without_credentials() {
        let server = MockServer::new(vec![
            page(json!([remote("remote-1", "user remark")]), 1),
            page(
                json!([remote("remote-2", "user remark\n[nexus:operation:op-2]")]),
                2,
            ),
            page(json!([]), 3),
        ]);
        let mut connection = server.connection(BrowserProviderId::AdsPower);
        connection.api_key = Some("test-key".into());
        let profile = AdsPowerProvider::new()
            .reconcile_create(&connection, "op-2")
            .unwrap()
            .unwrap();
        assert_eq!(profile.id, "remote-2");
        assert_eq!(
            profile.provider_config["identity"]["createdAt"],
            "1794268800"
        );
        assert_eq!(
            profile.provider_config["raw"]["remark"],
            "user remark\n[nexus:operation:op-2]"
        );
        assert!(!profile.provider_config.to_string().contains("private"));
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        for (index, request) in requests.iter().enumerate() {
            assert_eq!(request.method, "POST");
            assert_eq!(request.target, "/api/v2/browser-profile/list");
            assert_eq!(request.body["page"], index + 1);
            assert_eq!(request.body["limit"], 100);
            assert_eq!(request.body["sort_order"], "asc");
            assert!(
                request
                    .headers
                    .to_lowercase()
                    .contains("authorization: bearer test-key")
            );
        }
    }

    #[test]
    fn refuses_ambiguous_marker_and_partial_pagination_results() {
        let marker = "[nexus:operation:op-1]";
        let server = MockServer::new(vec![
            page(json!([remote("a", marker)]), 1),
            page(json!([remote("b", marker)]), 2),
            page(json!([]), 3),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        assert_eq!(
            AdsPowerProvider::new()
                .reconcile_create(&connection, "op-1")
                .unwrap_err()
                .code,
            "operation_uncertain"
        );
        let server = MockServer::new(vec![
            page(json!([remote("a", marker)]), 1),
            MockResponse::json(json!({"code": -1, "msg": "permission denied"})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        assert!(
            AdsPowerProvider::new()
                .reconcile_create(&connection, "op-1")
                .is_err()
        );
    }

    #[test]
    fn creates_with_group_marker_and_proxy_credentials_without_nexus_id_as_remote_id() {
        let marker = "user remark\n[nexus:operation:op-1]";
        let server = MockServer::new(vec![
            MockResponse::json(json!({"code": 0, "data": {"profile_id": "remote-1"}})),
            page(json!([remote("remote-1", marker)]), 1),
            page(json!([]), 2),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut window = record(&connection, "");
        window.proxy_mode = ProxyMode::Manual;
        window.proxy = Some("socks5://user%40test:p%3A%2F@proxy.test:1080".into());
        window.provider_config = json!({"raw": {"remark": "user remark"}});
        let created = AdsPowerProvider::new()
            .create_profile(&connection, &window, "op-1")
            .unwrap();
        assert_eq!(created.profile_id, "remote-1");
        assert_eq!(
            created.provider_config["identity"]["createdAt"],
            "1794268800"
        );
        let request = &server.requests()[0];
        assert_eq!(request.target, "/api/v2/browser-profile/create");
        assert_eq!(request.body["group_id"], "group-1");
        assert_eq!(request.body["remark"], marker);
        assert!(request.body.get("profile_id").is_none());
        assert_eq!(
            request.body["user_proxy_config"],
            json!({
                "proxy_soft": "other", "proxy_type": "socks5",
                "proxy_host": "proxy.test", "proxy_port": "1080",
                "proxy_user": "user@test", "proxy_password": "p:/",
                "global_config": "0"
            })
        );
        assert_eq!(request.body["fingerprint_config"]["webrtc"], "proxy");
        assert_eq!(
            request.body["fingerprint_config"]["automatic_timezone"],
            "1"
        );
        assert!(request.headers.to_lowercase().contains("application/json"));
    }

    #[test]
    fn rejects_unsafe_updates_and_unresolved_proxy_start_before_any_request() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let previous = record(&connection, "remote-1");
        let mut updated = previous.clone();
        updated.name = "Rename".into();
        let provider = AdsPowerProvider::new();
        assert_eq!(
            provider
                .update_profile(&connection, &previous, &updated)
                .unwrap_err()
                .code,
            "unsupported"
        );
        let mut plugin = previous.clone();
        plugin.proxy_mode = ProxyMode::Plugin;
        let proxy = ResolvedProxy {
            mode: ProxyMode::Plugin,
            connection_url: None,
        };
        assert_eq!(
            provider
                .start_profile(&connection, &plugin, &proxy)
                .unwrap_err()
                .code,
            "invalid_config"
        );
        updated = previous.clone();
        updated.settings.note = "Nexus-only note".into();
        assert!(
            provider
                .update_profile(&connection, &previous, &updated)
                .is_ok()
        );
        assert!(server.requests().is_empty());
    }

    #[test]
    fn rename_evidence_confirms_only_official_name_and_matching_identity() {
        for (name, changed_identity, expected) in [
            ("Renamed", false, Some(true)),
            ("Original", false, Some(false)),
            ("Renamed", true, None),
        ] {
            let original = remote("remote-1", "user memo");
            let mut actual = original.clone();
            actual["name"] = json!(name);
            if changed_identity {
                actual["created_time"] = json!("1794269999");
            }
            let server = MockServer::new(vec![page(json!([actual]), 1), page(json!([]), 2)]);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let mut previous = record(&connection, "remote-1");
            previous.provider_config = remote_profile(original).unwrap().provider_config;
            let mut updated = previous.clone();
            updated.name = "Renamed".into();
            let provider = AdsPowerProvider::new();
            let evidence = provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap();
            let result = provider.reconcile_update(&connection, &previous, &updated, &evidence);
            if let Some(expected) = expected {
                assert_eq!(result.unwrap(), expected);
            } else {
                assert_eq!(result.unwrap_err().code, "scope_mismatch");
            }
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert!(requests.iter().all(|request| request.target == LIST));
            assert_eq!(requests[0].body["profile_id"], json!(["remote-1"]));
        }
    }

    #[test]
    fn evidence_rejects_unsafe_configuration_and_preserves_local_only_updates() {
        let server = MockServer::new(vec![
            page(json!([remote("remote-1", "")]), 1),
            page(json!([]), 2),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let previous = record(&connection, "remote-1");
        let provider = AdsPowerProvider::new();
        let mut updated = previous.clone();
        updated.settings.locale = "fr-FR".into();
        assert_eq!(
            provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap_err()
                .code,
            "unsupported"
        );
        updated = previous.clone();
        updated.schema_version = 1;
        assert_eq!(
            provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap_err()
                .code,
            "invalid_config"
        );
        updated = previous.clone();
        updated.settings.note = "Nexus-only note".into();
        let evidence = provider
            .prepare_update_evidence(&previous, &updated)
            .unwrap();
        assert!(evidence.matches_fields(provider.id(), &json!({})).unwrap());
        let evidence =
            UpdateEvidence::from_fields(BrowserProviderId::BitBrowser, &json!({})).unwrap();
        assert!(
            provider
                .reconcile_update(&connection, &previous, &updated, &evidence)
                .is_err()
        );
        assert!(server.requests().is_empty());
    }

    #[test]
    fn refuses_binding_changes_and_uses_only_remote_id_for_stop() {
        let server = MockServer::new(vec![
            page(json!([remote("remote-1", "")]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code": 0})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut window = record(&connection, "remote-1");
        let mut changed = window.clone();
        changed.binding.profile_id = "another-profile".into();
        let provider = AdsPowerProvider::new();
        assert_eq!(
            provider
                .update_profile(&connection, &window, &changed)
                .unwrap_err()
                .code,
            "invalid_config"
        );
        window.provider_config = remote_profile(remote("remote-1", ""))
            .unwrap()
            .provider_config;
        provider.stop_profile(&connection, &window).unwrap();
        let requests = server.requests();
        assert_eq!(requests[2].target, "/api/v2/browser-profile/stop");
        assert_eq!(requests[2].body, json!({"profile_id": "remote-1"}));
    }

    #[test]
    fn unknown_status_and_connection_failure_are_never_stopped() {
        let server = MockServer::new(vec![MockResponse::json(json!({
            "code": 0, "data": {"status": "unexpected"}
        }))]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let api = LocalApi::connect(&connection, BrowserProviderId::AdsPower).unwrap();
        assert_eq!(observe_one(&api, "remote-1").unwrap(), WindowState::Unknown);
        let server = MockServer::new(vec![MockResponse::raw(0, "", vec![])]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let window = record(&connection, "remote-1");
        assert!(
            AdsPowerProvider::new()
                .observe_profiles(&connection, &[window])
                .is_err()
        );
    }

    #[test]
    fn offline_create_is_not_submitted() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        drop(server);
        let window = record(&connection, "");
        let error = AdsPowerProvider::new()
            .create_profile(&connection, &window, "op-offline")
            .unwrap_err();
        assert_eq!(error.code, "not_submitted");
        assert!(error.retryable);
    }

    #[test]
    fn failed_identity_read_is_not_submitted_and_never_reaches_mutation() {
        for operation in ["delete", "start", "stop"] {
            let server = MockServer::new(vec![MockResponse::raw(0, "", vec![])]);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let mut window = record(&connection, "remote-1");
            window.proxy_mode = ProxyMode::Provider;
            let provider = AdsPowerProvider::new();
            let result = match operation {
                "delete" => provider.delete_profile(&connection, &window),
                "start" => provider.start_profile(
                    &connection,
                    &window,
                    &ResolvedProxy {
                        mode: ProxyMode::Provider,
                        connection_url: None,
                    },
                ),
                "stop" => provider.stop_profile(&connection, &window),
                _ => unreachable!(),
            };
            assert_eq!(result.unwrap_err().code, "not_submitted", "{operation}");
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].target, LIST);
            assert_eq!(requests[0].body["profile_id"], json!(["remote-1"]));
        }
    }

    #[test]
    fn failed_activity_preflight_does_not_submit_start_or_delete() {
        for operation in ["delete", "start"] {
            let raw = remote("remote-1", "");
            let server = MockServer::new(vec![
                page(json!([raw.clone()]), 1),
                page(json!([]), 2),
                MockResponse::raw(0, "", vec![]),
            ]);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let mut window = record(&connection, "remote-1");
            window.proxy_mode = ProxyMode::Provider;
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let provider = AdsPowerProvider::new();
            let result = if operation == "delete" {
                provider.delete_profile(&connection, &window)
            } else {
                provider.start_profile(
                    &connection,
                    &window,
                    &ResolvedProxy {
                        mode: ProxyMode::Provider,
                        connection_url: None,
                    },
                )
            };
            assert_eq!(result.unwrap_err().code, "not_submitted", "{operation}");
            let requests = server.requests();
            assert_eq!(requests.len(), 3);
            assert!(requests[..2].iter().all(|request| request.target == LIST));
            assert_eq!(
                requests[2].target,
                "/api/v2/browser-profile/active?profile_id=remote-1"
            );
        }
    }

    #[test]
    fn unknown_activity_before_start_is_a_conclusive_non_submission() {
        let raw = remote("remote-1", "");
        let server = MockServer::new(vec![
            page(json!([raw.clone()]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code": 0, "data": {"status": "unexpected"}})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut window = record(&connection, "remote-1");
        window.proxy_mode = ProxyMode::Provider;
        window.provider_config = remote_profile(raw).unwrap().provider_config;
        let error = AdsPowerProvider::new()
            .start_profile(
                &connection,
                &window,
                &ResolvedProxy {
                    mode: ProxyMode::Provider,
                    connection_url: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "not_submitted");
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn create_response_loss_and_failed_readback_stay_uncertain_without_resubmission() {
        for acknowledged in [false, true] {
            let mut responses = Vec::new();
            if acknowledged {
                responses.push(MockResponse::json(
                    json!({"code": 0, "data": {"profile_id": "remote-1"}}),
                ));
            }
            responses.push(MockResponse::raw(0, "", vec![]));
            responses.push(MockResponse::json(json!({"code": 0})));
            let server = MockServer::new(responses);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let window = record(&connection, "");
            let error = AdsPowerProvider::new()
                .create_profile(&connection, &window, "op-lost")
                .unwrap_err();
            assert_eq!(error.code, "operation_uncertain");
            assert!(!error.retryable);
            let requests = server.requests();
            assert_eq!(requests.len(), if acknowledged { 2 } else { 1 });
            assert_eq!(requests[0].target, "/api/v2/browser-profile/create");
            if acknowledged {
                assert_eq!(requests[1].target, LIST);
            }
        }
    }

    #[test]
    fn discovers_more_than_one_hundred_profiles_and_all_groups() {
        let rows: Vec<Value> = (0..100)
            .map(|index| remote(&format!("remote-{index}"), ""))
            .collect();
        let server = MockServer::new(vec![
            page(json!(rows), 1),
            page(json!([remote("remote-100", "")]), 2),
            page(json!([]), 3),
            MockResponse::json(json!({"code": 0, "data": {
                "list": [{"group_id": "0", "group_name": "Ungrouped"}]
            }})),
            MockResponse::json(json!({"code": 0, "data": {"list": []}})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let provider = AdsPowerProvider::new();
        assert_eq!(provider.list_profiles(&connection).unwrap().len(), 101);
        let groups = provider.list_groups(&connection).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "0");
        assert_eq!(
            server.requests()[3].target,
            "/api/v1/group/list?page=1&page_size=100"
        );
    }

    #[test]
    fn deletion_requires_identity_and_stopped_state_and_uses_documented_case_once() {
        let raw = remote("remote-1", "user memo");
        let server = MockServer::new(vec![
            page(json!([raw.clone()]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code": 0, "data": {"status": "Inactive"}})),
            MockResponse::json(json!({"code": 0})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut window = record(&connection, "remote-1");
        window.provider_config = remote_profile(raw).unwrap().provider_config;
        AdsPowerProvider::new()
            .delete_profile(&connection, &window)
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[3].target, "/api/v2/browser-profile/delete");
        assert_eq!(requests[3].body, json!({"Profile_id": ["remote-1"]}));
    }

    #[test]
    fn provider_mode_start_sends_only_remote_id_and_probe_does_not_invent_scope() {
        let raw = remote("remote-1", "memo");
        let server = MockServer::new(vec![
            MockResponse::json(json!({"code": 0})),
            page(json!([]), 1),
            page(json!([raw.clone()]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code": 0, "data": {"status": "Inactive"}})),
            MockResponse::json(json!({"code": 0, "data": {}})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let provider = AdsPowerProvider::new();
        let probe = provider.probe(&connection).unwrap();
        assert!(probe.connected);
        assert_eq!(probe.scope_id, None);
        assert!(!probe.capabilities.update);
        assert!(!probe.capabilities.proxy_plugin);
        let mut window = record(&connection, "remote-1");
        window.proxy_mode = ProxyMode::Provider;
        window.provider_config = remote_profile(raw).unwrap().provider_config;
        provider
            .start_profile(
                &connection,
                &window,
                &ResolvedProxy {
                    mode: ProxyMode::Provider,
                    connection_url: None,
                },
            )
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests[5].target, "/api/v2/browser-profile/start");
        assert_eq!(requests[5].body, json!({"profile_id": "remote-1"}));
    }

    #[test]
    fn plugin_start_requires_exact_existing_proxy_and_never_issues_fingerprint_update() {
        for (actual_password, expected) in [
            ("fixture-pass", None),
            ("different-pass", Some("unsupported")),
        ] {
            let mut raw = remote("remote-1", "memo");
            raw["user_proxy_config"] = json!({
                "proxy_soft": "other", "proxy_type": "socks5",
                "proxy_host": "proxy.test", "proxy_port": "1080",
                "proxy_user": "plugin-user", "proxy_password": actual_password
            });
            let mut responses = vec![
                page(json!([raw.clone()]), 1),
                page(json!([]), 2),
                MockResponse::json(json!({"code": 0, "data": {"status": "Inactive"}})),
            ];
            if expected.is_none() {
                responses.push(MockResponse::json(json!({"code": 0})));
            }
            let server = MockServer::new(responses);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let mut window = record(&connection, "remote-1");
            window.proxy_mode = ProxyMode::Plugin;
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let result = AdsPowerProvider::new().start_profile(
                &connection,
                &window,
                &ResolvedProxy {
                    mode: ProxyMode::Plugin,
                    connection_url: Some(
                        "socks5://plugin-user:fixture-pass@proxy.test:1080".into(),
                    ),
                },
            );
            if let Some(expected) = expected {
                assert_eq!(result.unwrap_err().code, expected);
                assert_eq!(server.requests().len(), 3);
            } else {
                result.unwrap();
                assert_eq!(server.requests()[3].target, "/api/v2/browser-profile/start");
                assert_eq!(server.requests()[3].body, json!({"profile_id": "remote-1"}));
            }
            assert!(
                server
                    .requests()
                    .iter()
                    .all(|request| request.target != "/api/v2/browser-profile/update")
            );
        }
    }

    #[test]
    fn empty_observation_returns_no_states_or_profiles_without_requests() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let observed = AdsPowerProvider::new()
            .observe_profiles(&connection, &[])
            .unwrap();
        assert!(observed.states.is_empty());
        assert!(observed.profiles.is_empty());
        assert!(server.requests().is_empty());
    }

    #[test]
    fn observation_uses_remote_ids_and_one_complete_discovery_for_the_batch() {
        let mut raw_first = remote("remote-1", "");
        raw_first["name"] = json!("Official renamed");
        raw_first["fingerprint_config"] = json!({"browser_kernel_config": {"version": "141"}});
        let raw_second = remote("remote-2", "");
        let server = MockServer::new(vec![
            page(json!([raw_first.clone()]), 1),
            page(json!([raw_second.clone()]), 2),
            page(json!([]), 3),
            MockResponse::json(json!({
                "code": 0, "data": {"list": [{"user_id": "remote-1"}]}
            })),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut first = record(&connection, "remote-1");
        first.provider_config = remote_profile(raw_first).unwrap().provider_config;
        let mut second = record(&connection, "remote-2");
        second.id = "nexus-2".into();
        second.provider_config = remote_profile(raw_second).unwrap().provider_config;
        let mut missing = record(&connection, "remote-missing");
        missing.id = "nexus-3".into();
        let observed = AdsPowerProvider::new()
            .observe_profiles(&connection, &[first, second, missing])
            .unwrap();
        let states = &observed.states;
        assert_eq!(states.len(), 3);
        assert_eq!(states["remote-1"], WindowState::Running);
        assert_eq!(states["remote-2"], WindowState::Stopped);
        assert_eq!(states["remote-missing"], WindowState::Missing);
        assert!(!states.contains_key("nexus-window"));
        assert_eq!(observed.profiles.len(), 2);
        assert_eq!(observed.profiles[0].id, "remote-1");
        assert_eq!(observed.profiles[0].name, "Official renamed");
        assert_eq!(observed.profiles[0].kernel_version.as_deref(), Some("141"));
        assert_eq!(
            observed.profiles[0].provider_config["identity"]["createdAt"],
            "1794268800"
        );
        assert_eq!(observed.profiles[1].id, "remote-2");
        assert!(
            observed
                .profiles
                .iter()
                .all(|profile| { !profile.provider_config.to_string().contains("private") })
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        for (index, request) in requests[..3].iter().enumerate() {
            assert_eq!(request.target, LIST);
            assert_eq!(request.body["page"], index + 1);
            assert!(request.body.get("profile_id").is_none());
        }
        assert_eq!(requests[3].target, "/api/v1/browser/local-active");
    }

    #[test]
    fn observation_rejects_identity_changes_in_inactive_profiles() {
        let original = remote("remote-1", "");
        let mut changed = original.clone();
        changed["created_time"] = json!("1794269999");
        let server = MockServer::new(vec![page(json!([changed]), 1), page(json!([]), 2)]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut window = record(&connection, "remote-1");
        window.provider_config = remote_profile(original).unwrap().provider_config;
        assert_eq!(
            AdsPowerProvider::new()
                .observe_profiles(&connection, &[window])
                .unwrap_err()
                .code,
            "scope_mismatch"
        );
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn observation_does_not_infer_stopped_from_incomplete_or_conflicting_data() {
        for responses in [
            vec![
                page(json!([remote("remote-1", "")]), 1),
                MockResponse::json(json!({"code": -1, "msg": "permission denied"})),
            ],
            vec![
                page(json!([]), 1),
                MockResponse::json(json!({"code": 0, "data": {}})),
            ],
            vec![
                page(json!([]), 1),
                MockResponse::json(json!({
                    "code": 0, "data": {"list": [{"user_id": "remote-1"}]}
                })),
            ],
        ] {
            let server = MockServer::new(responses);
            let connection = server.connection(BrowserProviderId::AdsPower);
            let window = record(&connection, "remote-1");
            assert!(
                AdsPowerProvider::new()
                    .observe_profiles(&connection, &[window])
                    .is_err()
            );
        }
        let server = MockServer::new(vec![
            page(json!([]), 1),
            MockResponse::json(json!({"code": 0, "data": {"list": []}})),
        ]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let window = record(&connection, "remote-1");
        let states = AdsPowerProvider::new()
            .observe_profiles(&connection, &[window])
            .unwrap()
            .states;
        assert_eq!(states["remote-1"], WindowState::Missing);
    }

    #[test]
    fn explicit_proxy_source_cannot_inherit_global_proxy_overrides() {
        let raw = json!({"user_proxy_config": {
            "proxy_soft": "no_proxy", "global_config": "1"
        }});
        assert_eq!(
            verify_start_proxy(
                &raw,
                &ResolvedProxy {
                    mode: ProxyMode::Direct,
                    connection_url: None,
                }
            )
            .unwrap_err()
            .code,
            "unsupported"
        );
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::AdsPower);
        let mut window = record(&connection, "");
        window.proxy_mode = ProxyMode::Plugin;
        window.proxy = Some("http://user:fixture-pass@proxy.test:3128".into());
        let body = create_payload(&connection, &window, "op-1").unwrap();
        assert_eq!(body["user_proxy_config"]["global_config"], "0");
        assert_eq!(body["user_proxy_config"]["proxy_type"], "http");
        assert_eq!(body["user_proxy_config"]["proxy_user"], "user");
        assert_eq!(body["user_proxy_config"]["proxy_password"], "fixture-pass");
    }
}
