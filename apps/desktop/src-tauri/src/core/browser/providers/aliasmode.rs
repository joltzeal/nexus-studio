use crate::core::browser::connection_store::BrowserConnection;
use crate::core::browser::local_api::{
    LocalApi, MAX_PAGES, PAGE_SIZE, RequestKind, account_page_bytes, invalid_response,
    observed_states, operation_marker, preflight_error, profile_config, require_scope, uncertain,
    valid_id, validate_binding, validate_create, validate_update, verify_identity,
    verify_observed_identities,
};
use crate::core::browser::provider::automation::{AutomationSession, CdpEndpoint};
use crate::core::browser::provider::{
    BrowserCapabilities, BrowserError, BrowserProvider, BrowserProviderId, BrowserResult,
    CreatedProfile, ObservedProfiles, ProviderGroup, ProviderProbe, ProxyMode, RemoteProfile,
    ResolvedProxy, UpdateEvidence, WindowState,
};
use crate::core::window_store::WindowRecord;
use serde_json::{Value, json};
use std::collections::HashSet;

pub struct AliasModeProvider;

fn api(connection: &BrowserConnection) -> BrowserResult<LocalApi> {
    if connection.api_key.is_some() {
        return Err(BrowserError::unsupported(
            "AliasMode 本机接口不支持 API Key",
        ));
    }
    LocalApi::connect(connection, BrowserProviderId::AliasMode)
}

fn profile(row: Value) -> BrowserResult<RemoteProfile> {
    let id = row["user_id"].as_str().ok_or_else(invalid_response)?;
    valid_id(id)?;
    let name = row["name"].as_str().ok_or_else(invalid_response)?;
    let created = row["created_time"]
        .as_i64()
        .filter(|value| *value >= 0)
        .ok_or_else(invalid_response)?;
    let config = profile_config(&row, id, &[("createdAt", "created_time")]);
    Ok(RemoteProfile {
        id: id.into(),
        name: name.into(),
        kernel_version: None,
        created_at: (created > 0).then_some(created),
        provider_config: config,
    })
}

fn profiles(api: &LocalApi) -> BrowserResult<Vec<RemoteProfile>> {
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    let mut bytes = 0;
    for page in 1..=MAX_PAGES {
        let page_text = page.to_string();
        let size = PAGE_SIZE.to_string();
        let data = api.get(
            "/api/v1/user/list",
            &[("page", &page_text), ("page_size", &size)],
            RequestKind::Read,
        )?;
        account_page_bytes(&mut bytes, &data)?;
        if data["page"].as_u64() != Some(page as u64) {
            return Err(invalid_response());
        }
        let rows = data["list"].as_array().ok_or_else(invalid_response)?;
        if rows.is_empty() {
            return Ok(result);
        }
        if rows.len() > PAGE_SIZE {
            return Err(invalid_response());
        }
        for row in rows {
            let remote = profile(row.clone())?;
            if !ids.insert(remote.id.clone()) {
                return Err(invalid_response());
            }
            result.push(remote);
        }
    }
    Err(invalid_response())
}

fn active(api: &LocalApi, id: &str) -> BrowserResult<(WindowState, Value)> {
    let data = api.get(
        "/api/v1/browser/active",
        &[("user_id", id)],
        RequestKind::Read,
    )?;
    let state = match (data["status"].as_str(), data["lifecycle"].as_str()) {
        (Some("Inactive"), None) => WindowState::Stopped,
        (Some("Active"), Some("running")) => WindowState::Running,
        (Some("Active"), Some("starting")) => WindowState::Starting,
        (Some("Active"), Some("stopping")) => WindowState::Stopping,
        (Some("Active"), Some("uncertain")) => WindowState::Unknown,
        (Some("Active"), None) => WindowState::Unknown,
        _ => return Err(invalid_response()),
    };
    Ok((state, data))
}

impl BrowserProvider for AliasModeProvider {
    fn id(&self) -> BrowserProviderId {
        BrowserProviderId::AliasMode
    }

    fn capabilities(&self) -> BrowserCapabilities {
        let mut capabilities = BrowserCapabilities::for_provider(self.id());
        capabilities.attach = false;
        capabilities
    }

    fn probe(&self, connection: &BrowserConnection) -> BrowserResult<ProviderProbe> {
        let api = api(connection)?;
        api.get("/status", &[], RequestKind::Probe)?;
        profiles(&api)?;
        Ok(ProviderProbe {
            connected: true,
            message: "AliasMode 本机接口已连接".into(),
            scope_id: None,
            capabilities: self.capabilities(),
        })
    }

    fn list_profiles(&self, connection: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        profiles(&api(connection)?)
    }

    fn list_groups(&self, connection: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        let api = api(connection)?;
        let mut result = Vec::new();
        let mut ids = HashSet::new();
        for page in 1..=MAX_PAGES {
            let page_text = page.to_string();
            let size = PAGE_SIZE.to_string();
            let data = api.get(
                "/api/v1/group/list",
                &[("page", &page_text), ("page_size", &size)],
                RequestKind::Read,
            )?;
            let rows = data["list"].as_array().ok_or_else(invalid_response)?;
            if rows.is_empty() {
                return Ok(result);
            }
            if rows.len() > PAGE_SIZE {
                return Err(invalid_response());
            }
            for row in rows {
                let id = row["group_id"].as_str().ok_or_else(invalid_response)?;
                let name = row["group_name"].as_str().ok_or_else(invalid_response)?;
                valid_id(id)?;
                if !ids.insert(id.to_owned()) {
                    return Err(invalid_response());
                }
                result.push(ProviderGroup {
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
        if record.proxy_mode != ProxyMode::Direct
            || record.settings.geoip
            || !record.settings.timezone.is_empty()
            || !record.settings.locale.is_empty()
            || record.settings.viewport != "default"
            || !record.settings.start_url.is_empty()
        {
            return Err(BrowserError::unsupported(
                "AliasMode 接入目前仅支持默认指纹与直连；请清空自定义地域、窗口尺寸和起始地址",
            ));
        }
        let marker = operation_marker(operation_id)?;
        let name = format!("{marker} {}", record.name);
        let api = api(connection).map_err(preflight_error)?;
        let _lock = api
            .lock_profile(&format!("create:{marker}"))
            .map_err(preflight_error)?;
        let data = api.post(
            "/api/v1/user/create",
            &json!({"name":name,"engine":"chromium"}),
            RequestKind::Write,
        )?;
        let id = data["id"]
            .as_str()
            .filter(|id| valid_id(id).is_ok())
            .ok_or_else(|| uncertain("AliasMode 创建已提交但未返回环境标识，请核对结果"))?;
        let remote = profiles(&api)
            .map_err(|_| uncertain("AliasMode 创建后无法核对环境身份，请核对结果"))?
            .into_iter()
            .find(|row| row.id == id)
            .ok_or_else(|| uncertain("AliasMode 新环境暂不可见，请核对结果"))?;
        if remote.name != name {
            return Err(uncertain("AliasMode 创建结果的名称不匹配，请核对结果"));
        }
        if remote.created_at.is_none() {
            return Err(uncertain("AliasMode 未返回稳定创建时间，无法确认环境身份"));
        }
        Ok(CreatedProfile {
            profile_id: remote.id,
            kernel_version: None,
            binary_path: None,
            provider_config: remote.provider_config,
        })
    }

    fn prepare_update_evidence(
        &self,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<UpdateEvidence> {
        validate_update(previous, updated)?;
        if previous.name != updated.name
            || previous.proxy_mode != updated.proxy_mode
            || previous.proxy != updated.proxy
            || previous.proxy_plugin != updated.proxy_plugin
            || previous.proxy_endpoint != updated.proxy_endpoint
            || previous.settings != updated.settings
        {
            return Err(BrowserError::unsupported(
                "AliasMode 配置修改暂不可安全核对，请在 AliasMode 中修改",
            ));
        }
        UpdateEvidence::from_fields(self.id(), &json!({}))
    }

    fn update_profile(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_binding(connection, previous, self.id())?;
        self.prepare_update_evidence(previous, updated)?;
        Ok(())
    }

    fn reconcile_update(
        &self,
        connection: &BrowserConnection,
        previous: &WindowRecord,
        updated: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool> {
        validate_binding(connection, previous, self.id())?;
        self.prepare_update_evidence(previous, updated)?;
        evidence.validate(self.id())?;
        Ok(self.list_profiles(connection)?.into_iter().any(|row| {
            row.id == previous.binding.profile_id && verify_identity(previous, &row).is_ok()
        }))
    }

    fn reconcile_create(
        &self,
        connection: &BrowserConnection,
        operation_id: &str,
    ) -> BrowserResult<Option<RemoteProfile>> {
        let marker = operation_marker(operation_id)?;
        let mut matches = self
            .list_profiles(connection)?
            .into_iter()
            .filter(|row| row.name.starts_with(&format!("{marker} ")));
        let first = matches.next();
        if matches.next().is_some() {
            return Err(uncertain("AliasMode 存在重复创建标记，请人工核对"));
        }
        if first.as_ref().is_some_and(|row| row.created_at.is_none()) {
            return Err(uncertain("AliasMode 未返回稳定创建时间，无法确认环境身份"));
        }
        Ok(first)
    }

    fn delete_profile(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<()> {
        validate_binding(connection, record, self.id())?;
        require_scope(connection)?;
        let api = api(connection).map_err(preflight_error)?;
        let _lock = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let remote = profiles(&api)?
            .into_iter()
            .find(|row| row.id == record.binding.profile_id)
            .ok_or_else(|| BrowserError::new("profile_missing", "AliasMode 环境不可见"))?;
        verify_identity(record, &remote)?;
        if active(&api, &remote.id)?.0 != WindowState::Stopped {
            return Err(BrowserError::new(
                "profile_busy",
                "请先确认 AliasMode 环境已停止",
            ));
        }
        let data = api.post(
            "/api/v1/user/delete",
            &json!({"user_ids":[remote.id]}),
            RequestKind::Write,
        )?;
        if data["deleted"].as_u64() != Some(1)
            || data["locked"]
                .as_array()
                .is_none_or(|locked| !locked.is_empty())
        {
            return Err(uncertain("AliasMode 未确认环境删除，请核对结果"));
        }
        if profiles(&api)
            .map_err(|_| uncertain("AliasMode 删除后无法核对环境列表，请核对结果"))?
            .iter()
            .any(|row| row.id == record.binding.profile_id)
        {
            return Err(uncertain("AliasMode 环境删除后仍可见，请核对结果"));
        }
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
        if proxy.mode != ProxyMode::Direct
            || proxy.connection_url.is_some()
            || record.proxy_mode != ProxyMode::Direct
        {
            return Err(BrowserError::unsupported(
                "AliasMode 代理配置无法核验，已阻止启动",
            ));
        }
        let api = api(connection).map_err(preflight_error)?;
        let _lock = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let remote = profiles(&api)?
            .into_iter()
            .find(|row| row.id == record.binding.profile_id)
            .ok_or_else(|| BrowserError::new("profile_missing", "AliasMode 环境不可见"))?;
        verify_identity(record, &remote)?;
        match active(&api, &remote.id)?.0 {
            WindowState::Running => return Ok(()),
            WindowState::Stopped => (),
            _ => {
                return Err(BrowserError::new(
                    "not_submitted",
                    "AliasMode 环境状态未确定，尚未启动",
                ));
            }
        }
        api.get(
            "/api/v1/browser/start",
            &[("user_id", &remote.id)],
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
        let api = api(connection).map_err(preflight_error)?;
        let _lock = api
            .lock_profile(&record.binding.profile_id)
            .map_err(preflight_error)?;
        let remote = profiles(&api)?
            .into_iter()
            .find(|row| row.id == record.binding.profile_id)
            .ok_or_else(|| BrowserError::new("profile_missing", "AliasMode 环境不可见"))?;
        verify_identity(record, &remote)?;
        if active(&api, &remote.id)?.0 == WindowState::Stopped {
            return Ok(());
        }
        api.get(
            "/api/v1/browser/stop",
            &[("user_id", &remote.id)],
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
        let api = api(connection)?;
        let profiles = profiles(&api)?;
        let accessible = verify_observed_identities(records, &profiles)?;
        let mut active_ids = HashSet::new();
        let mut transitional = Vec::new();
        for record in records {
            if !accessible.contains(&record.binding.profile_id) {
                continue;
            }
            let (state, _) = active(&api, &record.binding.profile_id)?;
            if state == WindowState::Running {
                active_ids.insert(record.binding.profile_id.clone());
            } else if state != WindowState::Stopped {
                transitional.push((record.binding.profile_id.clone(), state));
            }
        }
        let mut states = observed_states(records, &accessible, &active_ids)?;
        for (id, state) in transitional {
            states.insert(id, state);
        }
        Ok(ObservedProfiles { states, profiles })
    }

    fn automation_session(
        &self,
        connection: &BrowserConnection,
        record: &WindowRecord,
    ) -> BrowserResult<AutomationSession> {
        validate_binding(connection, record, self.id())?;
        require_scope(connection)?;
        let api = api(connection)?;
        let _lock = api.lock_profile(&record.binding.profile_id)?;
        let remote = profiles(&api)?
            .into_iter()
            .find(|row| row.id == record.binding.profile_id)
            .ok_or_else(|| BrowserError::new("profile_missing", "AliasMode 环境不可见"))?;
        verify_identity(record, &remote)?;
        let (state, data) = active(&api, &remote.id)?;
        if state != WindowState::Running {
            return Err(BrowserError::new("unavailable", "AliasMode 浏览器尚未运行"));
        }
        let ws = data["ws"]["puppeteer"]
            .as_str()
            .ok_or_else(|| BrowserError::unsupported("当前 AliasMode 环境不提供 Chromium CDP"))?;
        Ok(AutomationSession::Cdp(CdpEndpoint::websocket(ws)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::browser::local_api::tests::{MockResponse, MockServer, record};

    fn page(rows: Value, number: u32) -> MockResponse {
        MockResponse::json(
            json!({"code":0,"msg":"success","data":{"list":rows,"page":number,"page_size":100}}),
        )
    }

    fn row(id: &str, name: &str) -> Value {
        json!({"user_id":id,"name":name,"created_time":1794268800,"group_id":"","serial_number":"1","last_open_time":0,"fp_verdict":"","fp_captured_at":""})
    }

    #[test]
    fn creates_and_reconciles_by_exact_operation_name() {
        let operation = "fixture-operation";
        let marker = operation_marker(operation).unwrap();
        let name = format!("{marker} Window");
        let server = MockServer::new(vec![
            MockResponse::json(json!({"code":0,"data":{"id":"profile-1"}})),
            page(json!([row("profile-1", &name)]), 1),
            page(json!([]), 2),
            page(json!([row("profile-1", &name)]), 1),
            page(json!([]), 2),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "");
        record.settings.geoip = false;
        let provider = AliasModeProvider;
        let created = provider
            .create_profile(&connection, &record, operation)
            .unwrap();
        assert_eq!(created.profile_id, "profile-1");
        assert_eq!(
            provider
                .reconcile_create(&connection, operation)
                .unwrap()
                .unwrap()
                .id,
            "profile-1"
        );
        let requests = server.requests();
        assert_eq!(requests[0].target, "/api/v1/user/create");
        assert_eq!(requests[0].body["name"], name);
        assert_eq!(requests[0].body["engine"], "chromium");
    }

    #[test]
    fn rejects_created_profile_without_a_stable_identity_timestamp() {
        let operation = "fixture-operation";
        let mut missing_timestamp = row(
            "profile-1",
            &format!("{} Window", operation_marker(operation).unwrap()),
        );
        missing_timestamp["created_time"] = json!(0);
        let server = MockServer::new(vec![
            MockResponse::json(json!({"code":0,"data":{"id":"profile-1"}})),
            page(json!([missing_timestamp]), 1),
            page(json!([]), 2),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "");
        record.settings.geoip = false;
        assert_eq!(
            AliasModeProvider
                .create_profile(&connection, &record, operation)
                .unwrap_err()
                .code,
            "operation_uncertain"
        );
    }

    #[test]
    fn start_requires_confirmed_identity_and_blocks_proxy_without_api_call() {
        let server = MockServer::new(vec![
            page(json!([row("profile-1", "Window")]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code":0,"data":{"status":"Inactive"}})),
            MockResponse::json(json!({"code":0,"data":{}})),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "profile-1");
        record.provider_config = profile(row("profile-1", "Window")).unwrap().provider_config;
        let provider = AliasModeProvider;
        assert_eq!(
            provider
                .start_profile(
                    &connection,
                    &record,
                    &ResolvedProxy {
                        mode: ProxyMode::Manual,
                        connection_url: Some("socks5://127.0.0.1:7890".into())
                    }
                )
                .unwrap_err()
                .code,
            "unsupported"
        );
        assert!(server.requests().is_empty());
        provider
            .start_profile(
                &connection,
                &record,
                &ResolvedProxy {
                    mode: ProxyMode::Direct,
                    connection_url: None,
                },
            )
            .unwrap();
        let requests = server.requests();
        assert_eq!(
            requests[3].target,
            "/api/v1/browser/start?user_id=profile-1"
        );
    }

    #[test]
    fn unknown_lifecycle_never_becomes_stopped() {
        let server = MockServer::new(vec![
            page(json!([row("profile-1", "Window")]), 1),
            page(json!([]), 2),
            MockResponse::json(
                json!({"code":0,"data":{"status":"Active","lifecycle":"uncertain"}}),
            ),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "profile-1");
        record.provider_config = profile(row("profile-1", "Window")).unwrap().provider_config;
        let observed = AliasModeProvider
            .observe_profiles(&connection, &[record])
            .unwrap();
        assert_eq!(observed.states["profile-1"], WindowState::Unknown);
    }

    #[test]
    fn deletes_only_the_confirmed_stopped_profile() {
        let server = MockServer::new(vec![
            page(json!([row("profile-1", "Window")]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code":0,"data":{"status":"Inactive"}})),
            MockResponse::json(json!({"code":0,"data":{"deleted":1,"locked":[]}})),
            page(json!([]), 1),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "profile-1");
        record.provider_config = profile(row("profile-1", "Window")).unwrap().provider_config;
        let provider = AliasModeProvider;
        assert!(provider.capabilities().delete_environment);
        provider.delete_profile(&connection, &record).unwrap();
        let requests = server.requests();
        assert_eq!(requests[3].target, "/api/v1/user/delete");
        assert_eq!(requests[3].body, json!({"user_ids":["profile-1"]}));
    }

    #[test]
    fn refuses_to_delete_an_active_profile_without_mutation() {
        let server = MockServer::new(vec![
            page(json!([row("profile-1", "Window")]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code":0,"data":{"status":"Active","lifecycle":"running"}})),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "profile-1");
        record.provider_config = profile(row("profile-1", "Window")).unwrap().provider_config;
        assert_eq!(
            AliasModeProvider
                .delete_profile(&connection, &record)
                .unwrap_err()
                .code,
            "profile_busy"
        );
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn locked_delete_remains_uncertain() {
        let server = MockServer::new(vec![
            page(json!([row("profile-1", "Window")]), 1),
            page(json!([]), 2),
            MockResponse::json(json!({"code":0,"data":{"status":"Inactive"}})),
            MockResponse::json(json!({"code":0,"data":{"deleted":0,"locked":["profile-1"]}})),
        ]);
        let connection = server.connection(BrowserProviderId::AliasMode);
        let mut record = record(&connection, "profile-1");
        record.provider_config = profile(row("profile-1", "Window")).unwrap().provider_config;
        assert_eq!(
            AliasModeProvider
                .delete_profile(&connection, &record)
                .unwrap_err()
                .code,
            "operation_uncertain"
        );
    }
}
