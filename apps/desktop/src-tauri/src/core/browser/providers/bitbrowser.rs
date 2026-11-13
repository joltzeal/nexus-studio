use crate::core::browser::connection_store::BrowserConnection;
use crate::core::browser::local_api::{
    LocalApi, MAX_PAGES, PAGE_SIZE, RequestKind, account_page_bytes, create_remark,
    invalid_response, observed_states, operation_marker, parse_proxy, preflight_error,
    profile_config, proxy_changed, reconcile_marker, require_scope, timestamp, uncertain, valid_id,
    validate_binding, validate_create, validate_settings, validate_update, verify_identity,
    verify_observed_identities,
};
use crate::core::browser::provider::automation::{AutomationSession, CdpEndpoint};
use crate::core::browser::provider::{
    BrowserError, BrowserProvider, BrowserProviderId, BrowserResult, CreatedProfile,
    ObservedProfiles, ProviderGroup, ProviderProbe, ProxyMode, RemoteProfile, ResolvedProxy,
    UpdateEvidence,
};
use crate::core::window_store::WindowRecord;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

pub struct BitBrowserProvider;

impl Default for BitBrowserProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl BitBrowserProvider {
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

impl BrowserProvider for BitBrowserProvider {
    fn id(&self) -> BrowserProviderId {
        BrowserProviderId::BitBrowser
    }

    fn automation_session(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<AutomationSession> {
        validate_binding(connection, record, self.id())?;
        require_scope(connection)?;
        let api = LocalApi::connect(connection, self.id())?;
        let _profile = api.lock_profile(&record.binding.profile_id)?;
        let (remote, _) = read_profile(&api, &record.binding.profile_id)?;
        verify_identity(record, &remote)?;
        // /browser/ports is read-only; calling /browser/open to rediscover CDP
        // would replay a lifecycle write and could change an existing proxy.
        let data = api.post("/browser/ports", &json!({}), RequestKind::Read)?;
        let raw = data[&record.binding.profile_id]
            .as_str()
            .ok_or_else(invalid_response)?;
        if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid_response());
        }
        let port: u16 = raw.parse().map_err(|_| invalid_response())?;
        Ok(AutomationSession::Cdp(CdpEndpoint::from_port(port)?))
    }

    fn probe(&self, connection: &BrowserConnection) -> BrowserResult<ProviderProbe> {
        let api = LocalApi::connect(connection, self.id())?;
        api.post("/health", &json!({}), RequestKind::Probe)?;
        let data = api.post(
            "/browser/list",
            &json!({"page": 0, "pageSize": 1}),
            RequestKind::Probe,
        )?;
        if !data["list"].is_array() {
            return Err(invalid_response());
        }
        Ok(ProviderProbe {
            connected: true,
            message: "比特浏览器本地 API 可访问，请确认当前账户".into(),
            scope_id: None,
            capabilities: self.capabilities(),
        })
    }

    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        let api = LocalApi::connect(connection, self.id())?;
        paginated(&api, "/browser/list", "id")?
            .into_iter()
            .map(remote_profile)
            .collect()
    }

    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        let api = LocalApi::connect(connection, self.id())?;
        paginated(&api, "/group/list", "id")?
            .into_iter()
            .map(|raw| {
                Ok(ProviderGroup {
                    id: raw["id"].as_str().ok_or_else(invalid_response)?.into(),
                    name: raw["groupName"]
                        .as_str()
                        .ok_or_else(invalid_response)?
                        .into(),
                })
            })
            .collect()
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
        let data = api.post("/browser/update", &body, RequestKind::Write)?;
        let id = data["id"]
            .as_str()
            .filter(|id| valid_id(id).is_ok())
            .ok_or_else(|| uncertain("比特浏览器创建响应缺少可核对的环境标识，请核对创建结果"))?;
        let (remote, _) = read_profile(&api, id)
            .map_err(|_| uncertain("比特浏览器已确认创建，但无法读回环境身份，请核对创建结果"))?;
        if reconcile_marker(vec![remote.clone()], operation_id)?.is_none() {
            return Err(uncertain("比特浏览器未确认 Nexus 创建标记，请核对创建结果"));
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
        let Some(body) = update_payload(previous, updated)? else {
            return Ok(());
        };
        require_scope(connection)?;
        let api = LocalApi::connect(connection, self.id()).map_err(preflight_error)?;
        let _profile = api
            .lock_profile(&previous.binding.profile_id)
            .map_err(preflight_error)?;
        let (remote, _) =
            read_profile(&api, &previous.binding.profile_id).map_err(preflight_error)?;
        verify_identity(previous, &remote)?;
        if body.get("proxyType").is_some()
            || body.get("url").is_some()
            || body["browserFingerPrint"]
                .as_object()
                .is_some_and(|object| !object.is_empty())
        {
            require_stopped(&api, &remote.id).map_err(preflight_error)?;
        }
        api.post("/browser/update/partial", &body, RequestKind::Write)?;
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
        api.post(
            "/browser/delete",
            &json!({"id": remote.id}),
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
        validate_settings(record)?;
        if proxy.mode != record.proxy_mode
            || (matches!(proxy.mode, ProxyMode::Direct | ProxyMode::Provider)
                && proxy.connection_url.is_some())
        {
            return Err(BrowserError::new(
                "invalid_config",
                "已解析的代理与窗口选择的来源不匹配",
            ));
        }
        let proxy_fields = match proxy.mode {
            ProxyMode::Provider => None,
            _ => Some(proxy_payload(proxy.mode, proxy.connection_url.as_deref())?),
        };
        let api = LocalApi::connect(connection, self.id()).map_err(preflight_error)?;
        let _profile = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let (remote, raw) =
            read_profile(&api, &record.binding.profile_id).map_err(preflight_error)?;
        verify_identity(record, &remote)?;
        if alive_pids(&api)
            .map_err(preflight_error)?
            .contains_key(&remote.id)
        {
            return Ok(());
        }
        let config_updated =
            proxy_fields.is_some() || raw["randomFingerprint"].as_bool() != Some(false);
        if config_updated {
            let mut body = partial_payload(&remote.id);
            if let Some(proxy_fields) = proxy_fields {
                extend(&mut body, proxy_fields)?;
                body["browserFingerPrint"] = fingerprint_payload(record, false)?;
            }
            api.post("/browser/update/partial", &body, RequestKind::Write)?;
        }
        api.post(
            "/browser/open",
            &json!({"id": remote.id}),
            RequestKind::Start,
        )
        .map_err(|error| {
            // A rejected open cannot undo the partial update that already succeeded.
            if config_updated {
                uncertain("比特浏览器环境配置已提交，但启动结果未确认，请核对后再操作")
            } else {
                error
            }
        })?;
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
            "/browser/close",
            &json!({"id": remote.id}),
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
        let profiles = paginated(&api, "/browser/list", "id")?
            .into_iter()
            .map(remote_profile)
            .collect::<BrowserResult<Vec<_>>>()?;
        let accessible = verify_observed_identities(records, &profiles)?;
        let pids = alive_pids(&api)?;
        let states = observed_states(records, &accessible, &pids.into_keys().collect())?;
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
        let mut fields = update_payload(previous, updated)?.unwrap_or_else(|| json!({}));
        let object = fields.as_object_mut().ok_or_else(invalid_response)?;
        object.remove("ids");
        if object
            .get("browserFingerPrint")
            .and_then(Value::as_object)
            .is_some_and(|fingerprint| fingerprint.is_empty())
        {
            // The empty partial-update container changes no existing fingerprint fields.
            object.remove("browserFingerPrint");
        }
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

fn paginated(api: &LocalApi, path: &str, id_key: &str) -> BrowserResult<Vec<Value>> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    let mut total = None;
    let mut bytes = 0;
    for page in 0..MAX_PAGES {
        let data = api.post(
            path,
            &json!({"page": page, "pageSize": PAGE_SIZE}),
            RequestKind::Read,
        )?;
        account_page_bytes(&mut bytes, &data)?;
        if let Some(count) = data.get("totalNum") {
            let count = count.as_u64().ok_or_else(invalid_response)?;
            if total.is_some_and(|previous| previous != count) {
                return Err(invalid_response());
            }
            total = Some(count);
        }
        let rows = data["list"].as_array().ok_or_else(invalid_response)?;
        if rows.is_empty() {
            if total.is_some_and(|total| total != records.len() as u64) {
                return Err(invalid_response());
            }
            return Ok(records);
        }
        if rows.len() > PAGE_SIZE {
            return Err(invalid_response());
        }
        for row in rows {
            let id = row[id_key].as_str().ok_or_else(invalid_response)?;
            valid_id(id)?;
            if !seen.insert(id.to_string()) {
                return Err(invalid_response());
            }
            records.push(row.clone());
        }
    }
    Err(invalid_response())
}

fn remote_profile(raw: Value) -> BrowserResult<RemoteProfile> {
    let id = raw["id"].as_str().ok_or_else(invalid_response)?;
    valid_id(id)?;
    let name = raw["name"].as_str().ok_or_else(invalid_response)?;
    let provider_config = profile_config(
        &raw,
        id,
        &[
            ("createdAt", "createdTime"),
            ("ownerId", "userId"),
            ("createdBy", "createdBy"),
            ("mainUserId", "mainUserId"),
        ],
    );
    Ok(RemoteProfile {
        id: id.into(),
        name: name.into(),
        kernel_version: raw["browserFingerPrint"]["coreVersion"]
            .as_str()
            .filter(|version| !version.is_empty())
            .map(str::to_string),
        created_at: timestamp(raw.get("createdTime")),
        provider_config,
    })
}

fn read_profile(api: &LocalApi, id: &str) -> BrowserResult<(RemoteProfile, Value)> {
    let raw = api.post("/browser/detail", &json!({"id": id}), RequestKind::Read)?;
    if raw.is_null() {
        return Err(BrowserError::new(
            "profile_missing",
            "比特浏览器环境不可访问，请核对账户和权限",
        ));
    }
    let remote = remote_profile(raw.clone())?;
    if remote.id != id {
        return Err(BrowserError::new(
            "scope_mismatch",
            "比特浏览器返回的环境身份与绑定不匹配，请重新核对接入",
        ));
    }
    Ok((remote, raw))
}

fn alive_pids(api: &LocalApi) -> BrowserResult<HashMap<String, u64>> {
    let data = api.post("/browser/pids/all", &json!({}), RequestKind::Read)?;
    let object = data.as_object().ok_or_else(invalid_response)?;
    object
        .iter()
        .map(|(id, pid)| {
            valid_id(id)?;
            let pid = pid
                .as_u64()
                .filter(|pid| *pid > 0)
                .ok_or_else(invalid_response)?;
            Ok((id.clone(), pid))
        })
        .collect()
}

fn require_stopped(api: &LocalApi, id: &str) -> BrowserResult<()> {
    if alive_pids(api)?.contains_key(id) {
        return Err(BrowserError::new(
            "profile_busy",
            "请先确认比特浏览器环境已停止，再修改或删除环境",
        ));
    }
    Ok(())
}

fn create_payload(
    connection: &BrowserConnection,
    record: &WindowRecord,
    operation_id: &str,
) -> BrowserResult<Value> {
    // Without a group the documented API can create a subaccount's profile under its parent.
    let group_id = connection.default_group_id.as_deref().ok_or_else(|| {
        BrowserError::new("invalid_config", "创建环境前请选择比特浏览器的目标分组")
    })?;
    valid_id(group_id)?;
    let mut body = json!({
        "groupId": group_id, "name": record.name,
        "remark": create_remark(record, operation_id)?,
        "platform": "", "platformIcon": "", "url": encoded_start_url(record),
        "userName": "", "password": "",
        "randomFingerprint": false,
        "browserFingerPrint": fingerprint_payload(record, true)?
    });
    extend(
        &mut body,
        proxy_payload(record.proxy_mode, record.proxy.as_deref())?,
    )?;
    Ok(body)
}

fn proxy_payload(mode: ProxyMode, connection_url: Option<&str>) -> BrowserResult<Value> {
    match mode {
        ProxyMode::Direct => Ok(json!({
            "proxyMethod": 2, "proxyType": "noproxy",
            "host": "", "port": 0, "proxyUserName": "", "proxyPassword": "",
            "isGlobalProxyInfo": false, "isDynamicIpChangeIp": false
        })),
        ProxyMode::Manual | ProxyMode::Plugin => {
            let proxy = parse_proxy(connection_url.ok_or_else(|| {
                BrowserError::new("invalid_config", "应用配置前必须先解析所需的浏览器代理")
            })?)?;
            Ok(json!({
                "proxyMethod": 2, "proxyType": proxy.protocol,
                "host": proxy.host, "port": proxy.port,
                "proxyUserName": proxy.username, "proxyPassword": proxy.password,
                "isIpv6": proxy.host.parse::<std::net::Ipv6Addr>().is_ok(),
                "isGlobalProxyInfo": false, "isDynamicIpChangeIp": false,
                "stopWhileNetError": true
            }))
        }
        ProxyMode::Provider => Err(BrowserError::unsupported(
            "新建比特浏览器环境需要明确选择代理来源",
        )),
    }
}

fn fingerprint_payload(record: &WindowRecord, include_size: bool) -> BrowserResult<Value> {
    let automatic = record.settings.geoip && record.proxy_mode != ProxyMode::Direct;
    let mut fingerprint = json!({
        "isIpCreateTimeZone": automatic && record.settings.timezone.is_empty(),
        "isIpCreateLanguage": automatic && record.settings.locale.is_empty(),
        "isIpCreatePosition": automatic,
        "position": if automatic { "1" } else { "2" },
        "webRTC": if automatic { "0" } else { "2" }
    });
    if !record.settings.timezone.is_empty() {
        // The reference also requires an offset for custom zones; no timezone database is
        // available here. Refuse rather than silently select an incorrect DST offset.
        return Err(BrowserError::unsupported(
            "比特浏览器自定义时区需要确认时差，请在官方应用中设置",
        ));
    }
    if !record.settings.locale.is_empty() {
        fingerprint["languages"] = json!(record.settings.locale);
    }
    if include_size {
        match record.settings.viewport.as_str() {
            "default" => {}
            "1440x900" => {
                fingerprint["openWidth"] = json!(1440);
                fingerprint["openHeight"] = json!(900);
            }
            "1920x1080" => {
                fingerprint["openWidth"] = json!(1920);
                fingerprint["openHeight"] = json!(1080);
            }
            _ => {
                return Err(BrowserError::new("invalid_config", "浏览器窗口尺寸无效"));
            }
        }
    }
    Ok(fingerprint)
}

fn partial_payload(id: &str) -> Value {
    json!({"ids": [id], "randomFingerprint": false, "browserFingerPrint": {}})
}

fn extend(target: &mut Value, values: Value) -> BrowserResult<()> {
    target
        .as_object_mut()
        .ok_or_else(invalid_response)?
        .extend(values.as_object().ok_or_else(invalid_response)?.clone());
    Ok(())
}

fn encoded_start_url(record: &WindowRecord) -> String {
    record.settings.start_url.replace(',', "%2C")
}

fn update_payload(previous: &WindowRecord, updated: &WindowRecord) -> BrowserResult<Option<Value>> {
    let mut body = partial_payload(&previous.binding.profile_id);
    let mut changed = false;
    if previous.name != updated.name {
        body["name"] = json!(updated.name);
        changed = true;
    }
    if updated.proxy_mode == ProxyMode::Provider {
        if previous.settings.geoip != updated.settings.geoip
            || previous.settings.timezone != updated.settings.timezone
            || previous.settings.locale != updated.settings.locale
        {
            return Err(BrowserError::unsupported(
                "沿用浏览器代理设置时，保留其现有时区、语言和网络配置",
            ));
        }
    } else {
        let proxy_changes = proxy_changed(previous, updated);
        if proxy_changes {
            extend(
                &mut body,
                proxy_payload(updated.proxy_mode, updated.proxy.as_deref())?,
            )?;
            changed = true;
        }
        let settings_changed = previous.settings.geoip != updated.settings.geoip
            || previous.settings.timezone != updated.settings.timezone
            || previous.settings.locale != updated.settings.locale;
        if settings_changed || proxy_changes {
            if !previous.settings.locale.is_empty()
                && updated.settings.locale.is_empty()
                && !(updated.settings.geoip && updated.proxy_mode != ProxyMode::Direct)
            {
                return Err(BrowserError::unsupported(
                    "尚未确认如何恢复比特浏览器默认语言，请选择具体语言或开启出口 IP 自动匹配",
                ));
            }
            let desired = fingerprint_payload(updated, false)?;
            let old = if previous.proxy_mode == ProxyMode::Provider {
                json!({})
            } else {
                fingerprint_payload(previous, false)?
            };
            let mut fields = Map::new();
            for (key, value) in desired.as_object().ok_or_else(invalid_response)? {
                if old.get(key) != Some(value) || previous.proxy_mode == ProxyMode::Provider {
                    fields.insert(key.clone(), value.clone());
                }
            }
            body["browserFingerPrint"] = Value::Object(fields);
            changed = true;
        }
    }
    if previous.settings.viewport != updated.settings.viewport {
        if updated.settings.viewport == "default" {
            return Err(BrowserError::unsupported(
                "尚未确认如何恢复比特浏览器默认窗口尺寸，请在官方应用中设置",
            ));
        }
        let dimensions = match updated.settings.viewport.as_str() {
            "1440x900" => (1440, 900),
            "1920x1080" => (1920, 1080),
            _ => {
                return Err(BrowserError::new("invalid_config", "浏览器窗口尺寸无效"));
            }
        };
        body["browserFingerPrint"]["openWidth"] = json!(dimensions.0);
        body["browserFingerPrint"]["openHeight"] = json!(dimensions.1);
        changed = true;
    }
    if previous.settings.start_url != updated.settings.start_url {
        body["url"] = json!(encoded_start_url(updated));
        changed = true;
    }
    Ok(changed.then_some(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::browser::local_api::tests::{MockResponse, MockServer, record};
    use crate::core::browser::provider::WindowState;
    use serde_json::json;

    fn response(data: Value) -> MockResponse {
        MockResponse::json(json!({"success": true, "data": data}))
    }

    fn remote(id: &str, remark: &str) -> Value {
        json!({
            "id": id, "name": "Remote", "remark": remark,
            "createdTime": "2026-11-10 10:00:00",
            "createdBy": "creator-1", "userId": "owner-1", "mainUserId": "team-1",
            "cookie": "private", "password": "private", "proxyPassword": "private",
            "randomFingerprint": false,
            "browserFingerPrint": {"canvasValue": 19281, "webRTC": "0"}
        })
    }

    #[test]
    fn automation_uses_read_only_port_discovery_and_rejects_missing_or_invalid_ports() {
        for port in [
            Value::Null,
            json!("0"),
            json!("65536"),
            json!("http://remote.invalid"),
        ] {
            let raw = remote("remote-1", "");
            let server = MockServer::new(vec![
                response(raw.clone()),
                response(json!({"remote-1":port})),
            ]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut window = record(&connection, "remote-1");
            window.proxy_mode = ProxyMode::Provider;
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let saved = serde_json::to_value(&window).unwrap();
            assert!(
                BitBrowserProvider::new()
                    .automation_session(&connection, &window)
                    .is_err()
            );
            assert_eq!(serde_json::to_value(&window).unwrap(), saved);
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[1].target, "/browser/ports");
            assert_eq!(requests[1].body, json!({}));
        }
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
                response(json!({})),
                response(json!({"list": []})),
                response(json!({"list": [{"id": "g-1", "groupName": "Group"}]})),
                response(json!({"list": []})),
                response(raw.clone()),
                response(json!({})),
            ]);
            let mut connection = server.connection(BrowserProviderId::BitBrowser);
            connection.enabled = enabled;
            connection.scope_confirmed = scope_confirmed;
            let provider = BitBrowserProvider::new();
            let probe = provider.probe(&connection).unwrap();
            assert!(probe.connected);
            assert_eq!(probe.scope_id, None);
            let groups = provider.list_groups(&connection).unwrap();
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].id, "g-1");
            assert_eq!(connection.enabled, enabled);
            assert_eq!(connection.scope_confirmed, scope_confirmed);
            let mut window = record(&connection, "remote-1");
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let creating = record(&connection, "");
            let mut updated = window.clone();
            updated.name = "Renamed".into();
            let proxy = ResolvedProxy {
                mode: ProxyMode::Direct,
                connection_url: None,
            };
            for error in [
                provider
                    .create_profile(&connection, &creating, "op-1")
                    .err()
                    .unwrap(),
                provider
                    .update_profile(&connection, &window, &updated)
                    .unwrap_err(),
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
            assert!(requests.iter().all(|request| request.method == "POST"));
            assert_eq!(requests[0].target, "/health");
            assert_eq!(requests[1].target, "/browser/list");
            assert_eq!(requests[2].target, "/group/list");
            assert_eq!(requests[2].body, json!({"page": 0, "pageSize": 100}));
            assert_eq!(requests[3].target, "/group/list");
            assert_eq!(requests[3].body, json!({"page": 1, "pageSize": 100}));
            connection.enabled = true;
            connection.scope_confirmed = true;
            provider.stop_profile(&connection, &window).unwrap();
            let requests = server.requests();
            assert_eq!(requests.len(), 6);
            assert_eq!(requests[4].target, "/browser/detail");
            assert_eq!(requests[5].target, "/browser/close");
            assert_eq!(requests[5].body, json!({"id": "remote-1"}));
        }
    }

    #[test]
    fn paginates_from_zero_without_group_filter_and_reconciles_by_exact_marker() {
        let server = MockServer::new(vec![
            response(json!({"list": [remote("a", "[nexus:operation:op-10]")]})),
            response(json!({"list": [remote("b", "memo\n[nexus:operation:op-1]")]})),
            response(json!({"list": []})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let profile = BitBrowserProvider::new()
            .reconcile_create(&connection, "op-1")
            .unwrap()
            .unwrap();
        assert_eq!(profile.id, "b");
        assert_eq!(profile.provider_config["identity"]["ownerId"], "owner-1");
        assert_eq!(profile.provider_config["identity"]["mainUserId"], "team-1");
        assert!(!profile.provider_config.to_string().contains("private"));
        for (page, request) in server.requests().iter().enumerate() {
            assert_eq!(request.target, "/browser/list");
            assert_eq!(request.body, json!({"page": page, "pageSize": 100}));
            assert!(!request.headers.to_lowercase().contains("authorization:"));
        }
    }

    #[test]
    fn creates_once_with_persistent_fingerprint_and_explicit_proxy_geoip_language() {
        let server = MockServer::new(vec![
            response(json!({"id": "remote-1"})),
            response(remote("remote-1", "memo\n[nexus:operation:op-1]")),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut window = record(&connection, "");
        window.proxy_mode = ProxyMode::Manual;
        window.proxy = Some("socks5://user%40test:p%3A%2F@proxy.test:1080".into());
        window.settings.locale = "en-GB".into();
        window.provider_config = json!({"raw": {"remark": "memo"}});
        let result = BitBrowserProvider::new()
            .create_profile(&connection, &window, "op-1")
            .unwrap();
        assert_eq!(result.profile_id, "remote-1");
        assert_eq!(result.provider_config["identity"]["ownerId"], "owner-1");
        let request = &server.requests()[0];
        assert_eq!(request.target, "/browser/update");
        assert!(request.body.get("id").is_none());
        assert_eq!(request.body["groupId"], "group-1");
        assert_eq!(request.body["randomFingerprint"], false);
        assert_eq!(request.body["proxyMethod"], 2);
        assert_eq!(request.body["proxyType"], "socks5");
        assert_eq!(request.body["proxyUserName"], "user@test");
        assert_eq!(request.body["proxyPassword"], "p:/");
        assert_eq!(request.body["port"], 1080);
        assert_eq!(request.body["stopWhileNetError"], true);
        let fingerprint = &request.body["browserFingerPrint"];
        assert_eq!(fingerprint["isIpCreateTimeZone"], true);
        assert_eq!(fingerprint["isIpCreateLanguage"], false);
        assert_eq!(fingerprint["languages"], "en-GB");
        assert_eq!(fingerprint["webRTC"], "0");
        assert!(fingerprint.get("canvasValue").is_none());
    }

    #[test]
    fn rename_uses_partial_update_preserves_remote_remark_and_never_regenerates() {
        let remote = remote("remote-1", "user memo\n[nexus:operation:op-1]");
        let server = MockServer::new(vec![response(remote.clone()), response(json!({}))]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut previous = record(&connection, "remote-1");
        previous.provider_config = remote_profile(remote).unwrap().provider_config;
        let mut updated = previous.clone();
        updated.name = "Renamed".into();
        updated.settings.note = "Nexus note".into();
        BitBrowserProvider::new()
            .update_profile(&connection, &previous, &updated)
            .unwrap();
        let request = &server.requests()[1];
        assert_eq!(request.target, "/browser/update/partial");
        assert_eq!(
            request.body,
            json!({
                "ids": ["remote-1"], "name": "Renamed",
                "randomFingerprint": false, "browserFingerPrint": {}
            })
        );
        assert!(request.body.get("remark").is_none());
        assert!(request.body.get("proxyType").is_none());
    }

    #[test]
    fn rename_with_unchanged_plugin_source_never_sends_proxy_fields() {
        for transient_url in [
            None,
            Some("socks5://fixture-user:fixture-pass@rotated.test:1080"),
        ] {
            let original = remote("remote-1", "user memo");
            let server = MockServer::new(vec![response(original.clone()), response(json!({}))]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut previous = record(&connection, "remote-1");
            previous.proxy_mode = ProxyMode::Plugin;
            previous.proxy_plugin = Some("studio.proxy-pool".into());
            previous.proxy_endpoint = Some(7);
            previous.provider_config = remote_profile(original).unwrap().provider_config;
            let mut updated = previous.clone();
            updated.name = "Renamed".into();
            updated.proxy = transient_url.map(str::to_string);
            let provider = BitBrowserProvider::new();
            let evidence = provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap();
            assert!(
                evidence
                    .matches_fields(
                        provider.id(),
                        &json!({"name": "Renamed", "randomFingerprint": false}),
                    )
                    .unwrap()
            );
            provider
                .update_profile(&connection, &previous, &updated)
                .unwrap();
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[1].target, "/browser/update/partial");
            assert_eq!(
                requests[1].body,
                json!({
                    "ids": ["remote-1"], "name": "Renamed",
                    "randomFingerprint": false, "browserFingerPrint": {}
                })
            );
            assert!(previous.proxy.is_none());
        }
    }

    #[test]
    fn changed_plugin_endpoint_sends_the_resolved_proxy() {
        let original = remote("remote-1", "user memo");
        let server = MockServer::new(vec![
            response(original.clone()),
            response(json!({})),
            response(json!({})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut previous = record(&connection, "remote-1");
        previous.proxy_mode = ProxyMode::Plugin;
        previous.proxy_plugin = Some("studio.proxy-pool".into());
        previous.proxy_endpoint = Some(7);
        previous.provider_config = remote_profile(original).unwrap().provider_config;
        let mut updated = previous.clone();
        updated.proxy_endpoint = Some(8);
        updated.proxy = Some("socks5://fixture-user:fixture-pass@next.proxy.test:1080".into());
        BitBrowserProvider::new()
            .update_profile(&connection, &previous, &updated)
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].target, "/browser/detail");
        assert_eq!(requests[1].target, "/browser/pids/all");
        assert_eq!(requests[2].target, "/browser/update/partial");
        let body = &requests[2].body;
        assert_eq!(body["ids"], json!(["remote-1"]));
        assert_eq!(body["proxyMethod"], 2);
        assert_eq!(body["proxyType"], "socks5");
        assert_eq!(body["host"], "next.proxy.test");
        assert_eq!(body["port"], 1080);
        assert_eq!(body["proxyUserName"], "fixture-user");
        assert_eq!(body["proxyPassword"], "fixture-pass");
        assert_eq!(body["randomFingerprint"], false);
        assert_eq!(body["browserFingerPrint"], json!({}));
        assert!(body.get("name").is_none());
        assert!(previous.proxy.is_none());
    }

    #[test]
    fn provider_proxy_start_leaves_proxy_and_fingerprint_untouched() {
        let mut remote = remote("remote-1", "memo");
        remote["randomFingerprint"] = json!(false);
        let server = MockServer::new(vec![
            response(remote.clone()),
            response(json!({})),
            response(json!({"ws": "ws://127.0.0.1:3333/"})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut window = record(&connection, "remote-1");
        window.proxy_mode = ProxyMode::Provider;
        window.provider_config = remote_profile(remote).unwrap().provider_config;
        BitBrowserProvider::new()
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
        assert_eq!(requests[1].target, "/browser/pids/all");
        assert_eq!(requests[2].target, "/browser/open");
        assert_eq!(requests[2].body, json!({"id": "remote-1"}));
    }

    #[test]
    fn refuses_missing_group_unsupported_auth_and_failed_proxy_before_creation() {
        let server = MockServer::new(vec![]);
        let mut connection = server.connection(BrowserProviderId::BitBrowser);
        connection.default_group_id = None;
        let window = record(&connection, "");
        let provider = BitBrowserProvider::new();
        assert_eq!(
            provider
                .create_profile(&connection, &window, "op-1")
                .unwrap_err()
                .code,
            "invalid_config"
        );
        connection.api_key = Some("not-a-documented-bit-key".into());
        assert_eq!(provider.probe(&connection).unwrap_err().code, "unsupported");
        connection.api_key = None;
        connection.default_group_id = Some("group-1".into());
        let mut plugin = window.clone();
        plugin.proxy_mode = ProxyMode::Plugin;
        assert_eq!(
            provider
                .create_profile(&connection, &plugin, "op-1")
                .unwrap_err()
                .code,
            "invalid_config"
        );
        assert!(server.requests().is_empty());
    }

    #[test]
    fn failed_or_duplicate_pages_do_not_become_empty_discovery() {
        let server = MockServer::new(vec![
            response(json!({"list": [remote("a", "")]})),
            response(json!({"list": [remote("a", "")]})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        assert!(
            BitBrowserProvider::new()
                .list_profiles(&connection)
                .is_err()
        );
        let server = MockServer::new(vec![MockResponse::json(json!({
            "success": false, "msg": "permission denied secret"
        }))]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let error = BitBrowserProvider::new()
            .list_profiles(&connection)
            .unwrap_err();
        assert_eq!(error.code, "permission_denied");
        assert!(!error.message.contains("secret"));
    }

    #[test]
    fn empty_observation_returns_no_states_or_profiles_without_requests() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let observed = BitBrowserProvider::new()
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
        raw_first["browserFingerPrint"]["coreVersion"] = json!("141");
        let raw_second = remote("remote-2", "");
        let server = MockServer::new(vec![
            response(json!({"list": [raw_first.clone()]})),
            response(json!({"list": [raw_second.clone()]})),
            response(json!({"list": []})),
            response(json!({"remote-1": 12345})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut first = record(&connection, "remote-1");
        first.provider_config = remote_profile(raw_first).unwrap().provider_config;
        let mut second = record(&connection, "remote-2");
        second.id = "nexus-2".into();
        second.provider_config = remote_profile(raw_second).unwrap().provider_config;
        let mut missing = record(&connection, "remote-missing");
        missing.id = "nexus-3".into();
        let observed = BitBrowserProvider::new()
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
            observed.profiles[0].provider_config["identity"]["ownerId"],
            "owner-1"
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
            assert_eq!(request.target, "/browser/list");
            assert_eq!(request.body, json!({"page": index, "pageSize": 100}));
        }
        assert_eq!(requests[3].target, "/browser/pids/all");
    }

    #[test]
    fn observation_rejects_identity_changes_in_inactive_profiles() {
        let original = remote("remote-1", "");
        let mut changed = original.clone();
        changed["userId"] = json!("other-owner");
        let server = MockServer::new(vec![
            response(json!({"list": [changed]})),
            response(json!({"list": []})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut window = record(&connection, "remote-1");
        window.provider_config = remote_profile(original).unwrap().provider_config;
        assert_eq!(
            BitBrowserProvider::new()
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
                response(json!({"list": [remote("remote-1", "")]})),
                MockResponse::json(json!({"success": false, "msg": "permission denied"})),
            ],
            vec![
                response(json!({"list": []})),
                response(json!({"remote-1": "unknown"})),
            ],
            vec![
                response(json!({"list": []})),
                response(json!({"remote-1": 12345})),
            ],
        ] {
            let server = MockServer::new(responses);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let window = record(&connection, "remote-1");
            assert!(
                BitBrowserProvider::new()
                    .observe_profiles(&connection, &[window])
                    .is_err()
            );
        }
        let server = MockServer::new(vec![response(json!({"list": []})), response(json!({}))]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let window = record(&connection, "remote-1");
        let states = BitBrowserProvider::new()
            .observe_profiles(&connection, &[window])
            .unwrap()
            .states;
        assert_eq!(states["remote-1"], WindowState::Missing);
    }

    #[test]
    fn owner_change_blocks_delete_before_a_write() {
        let old = remote("remote-1", "");
        let mut changed = old.clone();
        changed["userId"] = json!("other-owner");
        let server = MockServer::new(vec![response(changed)]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut window = record(&connection, "remote-1");
        window.provider_config = remote_profile(old).unwrap().provider_config;
        assert_eq!(
            BitBrowserProvider::new()
                .delete_profile(&connection, &window)
                .unwrap_err()
                .code,
            "scope_mismatch"
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn discovers_more_than_one_hundred_profiles_and_all_groups() {
        let rows: Vec<Value> = (0..100)
            .map(|index| remote(&format!("remote-{index}"), ""))
            .collect();
        let server = MockServer::new(vec![
            response(json!({"list": rows, "totalNum": 101})),
            response(json!({"list": [remote("remote-100", "")], "totalNum": 101})),
            response(json!({"list": [], "totalNum": 101})),
            response(json!({"list": [{"id": "g-1", "groupName": "Group"}], "totalNum": 1})),
            response(json!({"list": [], "totalNum": 1})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let provider = BitBrowserProvider::new();
        assert_eq!(provider.list_profiles(&connection).unwrap().len(), 101);
        let groups = provider.list_groups(&connection).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "g-1");
        assert_eq!(server.requests()[3].target, "/group/list");
        assert_eq!(
            server.requests()[3].body,
            json!({"page": 0, "pageSize": 100})
        );
    }

    #[test]
    fn maps_transient_plugin_url_in_create_update_and_start_without_echoing_secrets() {
        let raw = remote("remote-1", "memo\n[nexus:operation:op-1]");
        let server = MockServer::new(vec![
            response(json!({"id": "remote-1"})),
            response(raw.clone()),
            response(raw.clone()),
            response(json!({})),
            response(json!({})),
            response(raw),
            response(json!({})),
            response(json!({})),
            response(json!({"ws": "ws://127.0.0.1:3333/"})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let provider = BitBrowserProvider::new();
        let mut window = record(&connection, "");
        window.proxy_mode = ProxyMode::Plugin;
        window.proxy_plugin = Some("studio.proxy-pool".into());
        window.proxy_endpoint = Some(7);
        window.proxy = Some("socks5://plugin-user:fixture-pass@proxy.test:1080".into());
        window.provider_config = json!({"raw": {"remark": "memo"}});
        let created = provider
            .create_profile(&connection, &window, "op-1")
            .unwrap();
        assert!(!created.provider_config.to_string().contains("fixture-pass"));
        let mut previous = window.clone();
        previous.binding.profile_id = created.profile_id;
        previous.provider_config = created.provider_config;
        previous.proxy = None;
        let mut updated = previous.clone();
        updated.proxy_endpoint = Some(8);
        updated.proxy = window.proxy.clone();
        provider
            .update_profile(&connection, &previous, &updated)
            .unwrap();
        provider
            .start_profile(
                &connection,
                &previous,
                &ResolvedProxy {
                    mode: ProxyMode::Plugin,
                    connection_url: window.proxy,
                },
            )
            .unwrap();
        let requests = server.requests();
        for index in [0, 4, 7] {
            assert_eq!(requests[index].body["proxyType"], "socks5");
            assert_eq!(requests[index].body["proxyUserName"], "plugin-user");
            assert_eq!(requests[index].body["proxyPassword"], "fixture-pass");
            assert_eq!(requests[index].body["randomFingerprint"], false);
        }
        assert_eq!(requests[4].body["ids"], json!(["remote-1"]));
        assert_eq!(requests[7].body["ids"], json!(["remote-1"]));
        assert_eq!(requests[8].body, json!({"id": "remote-1"}));
    }

    #[test]
    fn stop_and_delete_target_remote_id_and_never_clear_remote_remark() {
        let raw = remote("remote-1", "user memo\n[nexus:operation:op-1]");
        let server = MockServer::new(vec![
            response(raw.clone()),
            response(json!({})),
            response(raw.clone()),
            response(json!({})),
            response(json!({})),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut window = record(&connection, "remote-1");
        window.provider_config = remote_profile(raw).unwrap().provider_config;
        let provider = BitBrowserProvider::new();
        provider.stop_profile(&connection, &window).unwrap();
        provider.delete_profile(&connection, &window).unwrap();
        let requests = server.requests();
        assert_eq!(requests[1].target, "/browser/close");
        assert_eq!(requests[4].target, "/browser/delete");
        for index in [1, 4] {
            assert_eq!(requests[index].body, json!({"id": "remote-1"}));
        }
    }

    #[test]
    fn uncertain_proxy_update_does_not_open_and_health_requires_business_success() {
        let raw = remote("remote-1", "");
        let server = MockServer::new(vec![
            response(raw.clone()),
            response(json!({})),
            MockResponse::raw(0, "", vec![]),
        ]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut window = record(&connection, "remote-1");
        window.proxy_mode = ProxyMode::Plugin;
        window.provider_config = remote_profile(raw).unwrap().provider_config;
        let error = BitBrowserProvider::new()
            .start_profile(
                &connection,
                &window,
                &ResolvedProxy {
                    mode: ProxyMode::Plugin,
                    connection_url: Some("http://proxy.test:3128".into()),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "operation_uncertain");
        assert_eq!(server.requests().len(), 3);
        assert!(
            server
                .requests()
                .iter()
                .all(|request| request.target != "/browser/open")
        );
        let server = MockServer::new(vec![MockResponse::json(json!({
            "success": false, "msg": "permission denied"
        }))]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        assert_eq!(
            BitBrowserProvider::new()
                .probe(&connection)
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }

    #[test]
    fn offline_create_is_not_submitted() {
        let server = MockServer::new(vec![]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        drop(server);
        let window = record(&connection, "");
        let error = BitBrowserProvider::new()
            .create_profile(&connection, &window, "op-offline")
            .unwrap_err();
        assert_eq!(error.code, "not_submitted");
        assert!(error.retryable);
    }

    #[test]
    fn failed_detail_preflight_never_submits_a_mutating_request() {
        for operation in ["update", "delete", "start", "stop"] {
            let server = MockServer::new(vec![MockResponse::raw(0, "", vec![])]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let window = record(&connection, "remote-1");
            let mut updated = window.clone();
            updated.name = "Renamed".into();
            let provider = BitBrowserProvider::new();
            let result = match operation {
                "update" => provider.update_profile(&connection, &window, &updated),
                "delete" => provider.delete_profile(&connection, &window),
                "start" => provider.start_profile(
                    &connection,
                    &window,
                    &ResolvedProxy {
                        mode: ProxyMode::Direct,
                        connection_url: None,
                    },
                ),
                "stop" => provider.stop_profile(&connection, &window),
                _ => unreachable!(),
            };
            assert_eq!(result.unwrap_err().code, "not_submitted", "{operation}");
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[0].body, json!({"id": "remote-1"}));
        }
    }

    #[test]
    fn failed_pid_preflight_does_not_submit_update_delete_or_start() {
        for operation in ["update", "delete", "start"] {
            let raw = remote("remote-1", "");
            let server = MockServer::new(vec![
                response(raw.clone()),
                MockResponse::raw(0, "", vec![]),
            ]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut window = record(&connection, "remote-1");
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let mut updated = window.clone();
            updated.settings.start_url = "https://example.test/updated".into();
            let provider = BitBrowserProvider::new();
            let result = match operation {
                "update" => provider.update_profile(&connection, &window, &updated),
                "delete" => provider.delete_profile(&connection, &window),
                "start" => provider.start_profile(
                    &connection,
                    &window,
                    &ResolvedProxy {
                        mode: ProxyMode::Direct,
                        connection_url: None,
                    },
                ),
                _ => unreachable!(),
            };
            assert_eq!(result.unwrap_err().code, "not_submitted", "{operation}");
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[1].target, "/browser/pids/all");
        }
    }

    #[test]
    fn refused_open_is_safe_only_before_any_partial_update() {
        for prepares_proxy in [false, true] {
            let raw = remote("remote-1", "");
            let mut responses = vec![response(raw.clone())];
            if prepares_proxy {
                responses.push(response(json!({})));
            }
            responses.push(response(json!({})).close_listener());
            let server = MockServer::new(responses);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut window = record(&connection, "remote-1");
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            window.proxy_mode = if prepares_proxy {
                ProxyMode::Direct
            } else {
                ProxyMode::Provider
            };
            let error = BitBrowserProvider::new()
                .start_profile(
                    &connection,
                    &window,
                    &ResolvedProxy {
                        mode: window.proxy_mode,
                        connection_url: None,
                    },
                )
                .unwrap_err();
            assert_eq!(
                error.code,
                if prepares_proxy {
                    "operation_uncertain"
                } else {
                    "not_submitted"
                }
            );
            assert_eq!(error.retryable, !prepares_proxy);
            let requests = server.requests();
            assert_eq!(requests.len(), if prepares_proxy { 3 } else { 2 });
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[1].target, "/browser/pids/all");
            if prepares_proxy {
                assert_eq!(requests[2].target, "/browser/update/partial");
                assert_eq!(requests[2].body["ids"], json!(["remote-1"]));
                assert_eq!(requests[2].body["randomFingerprint"], false);
            }
            assert!(
                requests
                    .iter()
                    .all(|request| request.target != "/browser/open")
            );
        }
    }

    #[test]
    fn lost_or_rejected_open_after_partial_update_stays_uncertain_without_retry() {
        for open_response in [
            MockResponse::raw(0, "", vec![]),
            MockResponse::raw(429, "", vec![]),
            MockResponse::raw(401, "", vec![]),
        ] {
            let raw = remote("remote-1", "");
            let server = MockServer::new(vec![
                response(raw.clone()),
                response(json!({})),
                response(json!({})),
                open_response,
                response(json!({})),
            ]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut window = record(&connection, "remote-1");
            window.provider_config = remote_profile(raw).unwrap().provider_config;
            let error = BitBrowserProvider::new()
                .start_profile(
                    &connection,
                    &window,
                    &ResolvedProxy {
                        mode: ProxyMode::Direct,
                        connection_url: None,
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, "operation_uncertain");
            assert!(!error.retryable);
            let requests = server.requests();
            assert_eq!(requests.len(), 4);
            assert_eq!(requests[2].target, "/browser/update/partial");
            assert_eq!(requests[3].target, "/browser/open");
            assert_eq!(requests[3].body, json!({"id": "remote-1"}));
        }
    }

    #[test]
    fn create_response_loss_and_failed_readback_stay_uncertain_without_resubmission() {
        for acknowledged in [false, true] {
            let mut responses = Vec::new();
            if acknowledged {
                responses.push(response(json!({"id": "remote-1"})));
            }
            responses.push(MockResponse::raw(0, "", vec![]));
            responses.push(response(json!({})));
            let server = MockServer::new(responses);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let window = record(&connection, "");
            let error = BitBrowserProvider::new()
                .create_profile(&connection, &window, "op-lost")
                .unwrap_err();
            assert_eq!(error.code, "operation_uncertain");
            assert!(!error.retryable);
            let requests = server.requests();
            assert_eq!(requests.len(), if acknowledged { 2 } else { 1 });
            assert_eq!(requests[0].target, "/browser/update");
            if acknowledged {
                assert_eq!(requests[1].target, "/browser/detail");
            }
        }
    }

    #[test]
    fn reconcile_update_checks_only_fields_sent_by_rename_and_never_writes() {
        for (name, random_fingerprint, expected) in [
            ("Renamed", false, true),
            ("Before", false, false),
            ("Renamed", true, false),
        ] {
            let original = remote("remote-1", "user memo");
            let mut actual = original.clone();
            actual["name"] = json!(name);
            actual["randomFingerprint"] = json!(random_fingerprint);
            actual["remark"] = json!("external memo edit");
            actual["browserFingerPrint"]["canvasValue"] = json!(12345);
            actual["proxyType"] = json!("https");
            let server = MockServer::new(vec![response(actual)]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut previous = record(&connection, "remote-1");
            previous.name = "Before".into();
            previous.provider_config = remote_profile(original).unwrap().provider_config;
            let mut updated = previous.clone();
            updated.name = "Renamed".into();
            let provider = BitBrowserProvider::new();
            let evidence = provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap();
            assert_eq!(
                provider
                    .reconcile_update(&connection, &previous, &updated, &evidence)
                    .unwrap(),
                expected
            );
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[0].body, json!({"id": "remote-1"}));
        }
    }

    #[test]
    fn reconcile_update_requires_exact_proxy_geoip_language_and_start_url_readback() {
        let original = remote("remote-1", "user memo\n[nexus:operation:op-1]");
        let mut confirmed = original.clone();
        for (key, value) in [
            ("proxyMethod", json!(2)),
            ("proxyType", json!("socks5")),
            ("host", json!("proxy.test")),
            ("port", json!(1080)),
            ("proxyUserName", json!("plugin-user")),
            ("proxyPassword", json!("fixture-pass")),
            ("isIpv6", json!(false)),
            ("isGlobalProxyInfo", json!(false)),
            ("isDynamicIpChangeIp", json!(false)),
            ("stopWhileNetError", json!(true)),
            ("url", json!("https://example.test/changed?item=a%2Cb")),
        ] {
            confirmed[key] = value;
        }
        confirmed["browserFingerPrint"] = json!({
            "isIpCreateTimeZone": false,
            "isIpCreateLanguage": false,
            "isIpCreatePosition": false,
            "position": "2",
            "webRTC": "2",
            "languages": "fr-FR",
            "timeZone": "Europe/Paris",
            "canvasValue": 54321
        });
        for mutation in [
            None,
            Some(("/proxyPassword", json!("***"))),
            Some(("/proxyUserName", json!("another-user"))),
            Some(("/port", json!("1080"))),
            Some(("/host", json!("another.test"))),
            Some(("/browserFingerPrint/isIpCreateTimeZone", json!(true))),
            Some(("/browserFingerPrint/languages", json!("en-US"))),
            Some(("/browserFingerPrint/webRTC", json!("0"))),
            Some(("/url", json!("https://example.test/old"))),
            Some(("/randomFingerprint", json!(true))),
            Some(("/stopWhileNetError", json!(false))),
        ] {
            let mut actual = confirmed.clone();
            let expected = mutation.is_none();
            if let Some((path, value)) = mutation {
                *actual.pointer_mut(path).unwrap() = value;
            }
            let server = MockServer::new(vec![response(actual)]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut previous = record(&connection, "remote-1");
            previous.proxy_mode = ProxyMode::Provider;
            previous.provider_config = remote_profile(original.clone()).unwrap().provider_config;
            let mut updated = previous.clone();
            updated.proxy_mode = ProxyMode::Plugin;
            updated.proxy = Some("socks5://plugin-user:fixture-pass@proxy.test:1080".into());
            updated.settings.geoip = false;
            updated.settings.locale = "fr-FR".into();
            updated.settings.start_url = "https://example.test/changed?item=a,b".into();
            let provider = BitBrowserProvider::new();
            let evidence = provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap();
            updated.proxy = None;
            updated.proxy_plugin = Some("studio.proxy-pool".into());
            updated.proxy_endpoint = Some(7);
            let result = provider
                .reconcile_update(&connection, &previous, &updated, &evidence)
                .unwrap();
            assert_eq!(result, expected);
            assert_eq!(server.requests().len(), 1);
            assert_eq!(server.requests()[0].target, "/browser/detail");
            assert!(
                !previous
                    .provider_config
                    .to_string()
                    .contains("fixture-pass")
            );
        }
    }

    #[test]
    fn reconcile_update_returns_false_when_changed_fields_are_missing() {
        let original = remote("remote-1", "");
        let mut actual = original.clone();
        actual["name"] = json!("Renamed");
        actual.as_object_mut().unwrap().remove("randomFingerprint");
        let server = MockServer::new(vec![response(actual)]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let mut previous = record(&connection, "remote-1");
        previous.provider_config = remote_profile(original).unwrap().provider_config;
        let mut updated = previous.clone();
        updated.name = "Renamed".into();
        let provider = BitBrowserProvider::new();
        let evidence = provider
            .prepare_update_evidence(&previous, &updated)
            .unwrap();
        assert!(
            !provider
                .reconcile_update(&connection, &previous, &updated, &evidence)
                .unwrap()
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn reconcile_update_verifies_identity_even_for_local_only_changes() {
        for (owner, expected_error) in [
            ("owner-1", None),
            ("different-owner", Some("scope_mismatch")),
        ] {
            let original = remote("remote-1", "");
            let mut actual = original.clone();
            actual["userId"] = json!(owner);
            actual["randomFingerprint"] = json!(true);
            let server = MockServer::new(vec![response(actual)]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut previous = record(&connection, "remote-1");
            previous.provider_config = remote_profile(original).unwrap().provider_config;
            let mut updated = previous.clone();
            updated.settings.note = "Local note".into();
            let provider = BitBrowserProvider::new();
            let evidence = provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap();
            let result = provider.reconcile_update(&connection, &previous, &updated, &evidence);
            if let Some(code) = expected_error {
                assert_eq!(result.unwrap_err().code, code);
            } else {
                assert!(result.unwrap());
            }
            assert_eq!(server.requests().len(), 1);
            assert_eq!(server.requests()[0].target, "/browser/detail");
        }
    }

    #[test]
    fn saved_plugin_update_evidence_matches_submitted_proxy_without_resolving_again() {
        for host in ["proxy-a.test", "proxy-b.test"] {
            let original = remote("remote-1", "user memo");
            let mut actual = original.clone();
            actual["proxyMethod"] = json!(2);
            actual["proxyType"] = json!("socks5");
            actual["host"] = json!(host);
            actual["port"] = json!(1080);
            actual["proxyUserName"] = json!("fixture-user-a");
            actual["proxyPassword"] = json!("fixture-pass-a");
            actual["isIpv6"] = json!(false);
            actual["isGlobalProxyInfo"] = json!(false);
            actual["isDynamicIpChangeIp"] = json!(false);
            actual["stopWhileNetError"] = json!(true);
            actual["browserFingerPrint"] = json!({
                "isIpCreateTimeZone": true, "isIpCreateLanguage": true,
                "isIpCreatePosition": true, "position": "1", "webRTC": "0",
                "canvasValue": 54321
            });
            let server = MockServer::new(vec![response(actual)]);
            let connection = server.connection(BrowserProviderId::BitBrowser);
            let mut previous = record(&connection, "remote-1");
            previous.proxy_mode = ProxyMode::Provider;
            previous.provider_config = remote_profile(original).unwrap().provider_config;
            let mut updated = previous.clone();
            updated.proxy_mode = ProxyMode::Plugin;
            updated.proxy_plugin = Some("studio.proxy-pool".into());
            updated.proxy_endpoint = Some(7);
            updated.proxy = Some("socks5://fixture-user-a:fixture-pass-a@proxy-a.test:1080".into());
            let provider = BitBrowserProvider::new();
            let evidence = provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap();
            let saved = serde_json::to_string(&evidence).unwrap();
            for secret in ["fixture-user-a", "fixture-pass-a", "proxy-a.test"] {
                assert!(!saved.contains(secret));
            }
            let evidence: UpdateEvidence = serde_json::from_str(&saved).unwrap();
            updated.proxy = None;
            assert_eq!(
                provider
                    .reconcile_update(&connection, &previous, &updated, &evidence)
                    .unwrap(),
                host == "proxy-a.test"
            );
            assert!(updated.proxy.is_none());
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].target, "/browser/detail");
            assert_eq!(requests[0].body, json!({"id": "remote-1"}));
        }
    }

    #[test]
    fn evidence_preparation_rejects_invalid_identity_and_unresolved_required_proxy() {
        let server = MockServer::new(vec![response(remote("remote-1", ""))]);
        let connection = server.connection(BrowserProviderId::BitBrowser);
        let previous = record(&connection, "remote-1");
        let provider = BitBrowserProvider::new();
        let mut updated = previous.clone();
        updated.binding.profile_id = "another-profile".into();
        assert_eq!(
            provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap_err()
                .code,
            "invalid_config"
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
        updated.proxy_mode = ProxyMode::Plugin;
        updated.proxy_plugin = Some("studio.proxy-pool".into());
        updated.proxy_endpoint = Some(7);
        assert_eq!(
            provider
                .prepare_update_evidence(&previous, &updated)
                .unwrap_err()
                .code,
            "invalid_config"
        );
        let evidence =
            UpdateEvidence::from_fields(BrowserProviderId::AdsPower, &json!({})).unwrap();
        assert!(
            provider
                .reconcile_update(&connection, &previous, &previous, &evidence)
                .is_err()
        );
        assert!(server.requests().is_empty());
    }
}
