use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

#[derive(Default)]
struct FakeProvider {
    provider_id: Option<BrowserProviderId>,
    profiles: Mutex<HashMap<String, WindowState>>,
    metadata: Mutex<HashMap<String, RemoteProfile>>,
    minimum_revision: AtomicU64,
    markers: Mutex<HashMap<String, String>>,
    creates: AtomicUsize,
    starts: AtomicUsize,
    updates: AtomicUsize,
    create_timeout: AtomicBool,
    create_rejected: AtomicBool,
    start_timeout: AtomicBool,
    start_rejected: AtomicBool,
    update_timeout: AtomicBool,
    update_confirmed: AtomicBool,
    marker_ambiguous: AtomicBool,
    offline: AtomicBool,
    observation_pause: Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
}
impl FakeProvider {
    fn remote(&self, id: &str) -> RemoteProfile {
        if let Some(remote) = self.metadata.lock().unwrap().get(id).cloned() {
            return remote;
        }
        RemoteProfile {
            id: id.into(),
            name: "External".into(),
            kernel_version: None,
            created_at: Some(1),
            provider_config: json!({"identity":{"profileId":id,"createdAt":1}}),
        }
    }
}
impl BrowserProvider for FakeProvider {
    fn id(&self) -> BrowserProviderId {
        self.provider_id.unwrap_or(BrowserProviderId::AdsPower)
    }
    fn probe(&self, _: &BrowserConnection) -> BrowserResult<ProviderProbe> {
        Ok(ProviderProbe {
            connected: true,
            message: "ok".into(),
            scope_id: None,
            capabilities: self.capabilities(),
        })
    }
    fn list_profiles(&self, _: &BrowserConnection) -> BrowserResult<Vec<RemoteProfile>> {
        if self.offline.load(Ordering::SeqCst) {
            return Err(BrowserError::new("unavailable", "offline"));
        }
        Ok(self
            .profiles
            .lock()
            .unwrap()
            .keys()
            .map(|id| self.remote(id))
            .collect())
    }
    fn list_groups(&self, _: &BrowserConnection) -> BrowserResult<Vec<ProviderGroup>> {
        Ok(vec![])
    }
    fn create_profile(
        &self,
        _: &BrowserConnection,
        _: &WindowRecord,
        operation: &str,
    ) -> BrowserResult<CreatedProfile> {
        let count = self.creates.fetch_add(1, Ordering::SeqCst);
        if self.create_rejected.swap(false, Ordering::SeqCst) {
            return Err(BrowserError::new("permission_denied", "rejected"));
        }
        let id = format!("vendor-{count}");
        self.profiles
            .lock()
            .unwrap()
            .insert(id.clone(), WindowState::Stopped);
        self.markers
            .lock()
            .unwrap()
            .insert(operation.into(), id.clone());
        if self.create_timeout.swap(false, Ordering::SeqCst) {
            return Err(BrowserError::new("operation_uncertain", "response lost"));
        }
        Ok(CreatedProfile {
            profile_id: id.clone(),
            kernel_version: None,
            binary_path: None,
            provider_config: self.remote(&id).provider_config,
        })
    }
    fn update_profile(
        &self,
        _: &BrowserConnection,
        _: &WindowRecord,
        _: &WindowRecord,
    ) -> BrowserResult<()> {
        self.updates.fetch_add(1, Ordering::SeqCst);
        self.update_confirmed.store(true, Ordering::SeqCst);
        if self.update_timeout.swap(false, Ordering::SeqCst) {
            return Err(uncertain());
        }
        Ok(())
    }
    fn prepare_update_evidence(
        &self,
        _: &WindowRecord,
        updated: &WindowRecord,
    ) -> BrowserResult<UpdateEvidence> {
        UpdateEvidence::from_fields(self.id(), &json!({"name":updated.name}))
    }
    fn reconcile_update(
        &self,
        _: &BrowserConnection,
        _: &WindowRecord,
        _: &WindowRecord,
        evidence: &UpdateEvidence,
    ) -> BrowserResult<bool> {
        evidence.validate(self.id())?;
        Ok(self.update_confirmed.load(Ordering::SeqCst))
    }
    fn delete_profile(&self, _: &BrowserConnection, record: &WindowRecord) -> BrowserResult<()> {
        self.profiles
            .lock()
            .unwrap()
            .remove(&record.binding.profile_id);
        Ok(())
    }
    fn start_profile(
        &self,
        _: &BrowserConnection,
        record: &WindowRecord,
        _: &ResolvedProxy,
    ) -> BrowserResult<()> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        if self.start_rejected.swap(false, Ordering::SeqCst) {
            return Err(BrowserError::new("invalid_config", "rejected"));
        }
        self.profiles
            .lock()
            .unwrap()
            .insert(record.binding.profile_id.clone(), WindowState::Running);
        if self.start_timeout.swap(false, Ordering::SeqCst) {
            return Err(BrowserError::new("operation_uncertain", "response lost"));
        }
        Ok(())
    }
    fn stop_profile(&self, _: &BrowserConnection, record: &WindowRecord) -> BrowserResult<()> {
        self.profiles
            .lock()
            .unwrap()
            .insert(record.binding.profile_id.clone(), WindowState::Stopped);
        Ok(())
    }
    fn observe_profiles(
        &self,
        connection: &BrowserConnection,
        records: &[WindowRecord],
    ) -> BrowserResult<ObservedProfiles> {
        if self.offline.load(Ordering::SeqCst) {
            return Err(BrowserError::new("unavailable", "offline"));
        }
        let observed: HashMap<_, _> = {
            let profiles = self.profiles.lock().unwrap();
            records
                .iter()
                .map(|r| {
                    (
                        r.binding.profile_id.clone(),
                        if connection.revision < self.minimum_revision.load(Ordering::SeqCst) {
                            WindowState::Stopped
                        } else {
                            profiles
                                .get(&r.binding.profile_id)
                                .copied()
                                .unwrap_or(WindowState::Missing)
                        },
                    )
                })
                .collect()
        };
        let profiles = observed
            .iter()
            .filter(|(_, state)| **state != WindowState::Missing)
            .map(|(id, _)| self.remote(id))
            .collect();
        let pause = self.observation_pause.lock().unwrap().take();
        if let Some((captured, resume)) = pause {
            captured.wait();
            resume.wait();
        }
        Ok(ObservedProfiles {
            states: observed,
            profiles,
        })
    }
    fn reconcile_create(
        &self,
        _: &BrowserConnection,
        operation: &str,
    ) -> BrowserResult<Option<RemoteProfile>> {
        if self.marker_ambiguous.load(Ordering::SeqCst) {
            return Err(uncertain());
        }
        Ok(self
            .markers
            .lock()
            .unwrap()
            .get(operation)
            .map(|id| self.remote(id)))
    }
}
fn fixture() -> (tempfile::TempDir, WindowService, Arc<FakeProvider>, String) {
    let root = tempfile::tempdir().unwrap();
    let license = LicenseStore::new(root.path().join("nexus.sqlite")).unwrap();
    let mut service = WindowService::with_runtime(
        root.path().join("profiles"),
        None,
        license,
        RuntimePaths::development(),
    )
    .unwrap();
    let provider = Arc::new(FakeProvider::default());
    service.registry.register(provider.clone());
    let connection = service
        .connections
        .save(ConnectionInput {
            id: None,
            provider_id: BrowserProviderId::AdsPower,
            name: "Ads".into(),
            endpoint: "http://127.0.0.1:50325".into(),
            api_key: None,
            default_group_id: None,
            scope_label: "Test account".into(),
        })
        .unwrap();
    service
        .connections
        .confirm(&connection.id, "Test account", None, connection.revision)
        .unwrap();
    (root, service, provider, connection.id)
}
fn input(connection: &str) -> CreateWindowInput {
    CreateWindowInput {
        operation_id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection.into(),
        name: "External".into(),
        proxy_mode: ProxyMode::Direct,
        proxy: None,
        proxy_plugin: None,
        proxy_endpoint: None,
        settings: WindowSettings::default(),
        group_id: None,
        kernel_version: None,
    }
}

#[test]
fn agent_lease_blocks_manual_operations_and_requires_the_dedicated_start() {
    let (_root, service, provider, connection) = fixture();
    let record = service.create(input(&connection)).unwrap();
    service.acquire_agent_window(&record.id, "job-one").unwrap();
    service.acquire_agent_window(&record.id, "job-one").unwrap();
    assert_eq!(
        service
            .acquire_agent_window(&record.id, "job-two")
            .unwrap_err()
            .code,
        "profile_busy"
    );
    assert_eq!(
        service.start_window(&record.id).unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(service.stop(&record.id).unwrap_err().code, "profile_busy");
    assert_eq!(
        service.update_note(&record.id, "edit").unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(
        service.delete_window(&record.id, false).unwrap_err().code,
        "profile_busy"
    );
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_err()
    );
    assert_eq!(
        service
            .start_agent_window(&record.id, "job-two")
            .unwrap_err()
            .code,
        "permission_denied"
    );
    service.start_agent_window(&record.id, "job-one").unwrap();
    assert_eq!(provider.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        service
            .release_agent_window(&record.id, "job-two")
            .unwrap_err()
            .code,
        "permission_denied"
    );
    service.release_agent_window(&record.id, "job-one").unwrap();
    service.stop(&record.id).unwrap();
}

#[test]
fn agent_snapshot_has_only_allowlisted_identity_fields_and_actual_state() {
    let (_root, service, _provider, connection) = fixture();
    let record = service.create(input(&connection)).unwrap();
    let snapshot = service.agent_window_snapshot(&record.id).unwrap();
    let mut keys = snapshot
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "connectionId",
            "id",
            "name",
            "profileId",
            "providerId",
            "state"
        ]
    );
    assert_eq!(snapshot["state"], "stopped");
    assert_eq!(snapshot["profileId"], record.provider_profile_id);
    assert_eq!(
        service
            .agent_browser_execute(
                &record.id,
                json!({
                    "operation":"snapshot","origin":"https://www.vinted.fr","input":{}
                })
            )
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

#[test]
fn acquiring_does_not_steal_an_existing_manual_or_transfer_operation() {
    let (_root, service, _provider, connection) = fixture();
    let record = service.create(input(&connection)).unwrap();
    let guard = service.hold(&record.id).unwrap();
    assert!(service.acquire_agent_window(&record.id, "job").is_err());
    assert!(service.restore_agent_window(&record.id, "job").is_err());
    drop(guard);
    let transfer = service
        .lock_transfer(std::slice::from_ref(&record.id))
        .unwrap();
    assert!(service.acquire_agent_window(&record.id, "job").is_err());
    assert!(service.restore_agent_window(&record.id, "job").is_err());
    drop(transfer);
    service.acquire_agent_window(&record.id, "job").unwrap();
    assert!(
        service
            .hold_connections(BrowserProviderId::AdsPower, false)
            .is_err()
    );
    service.release_agent_window(&record.id, "job").unwrap();
}

#[test]
fn restart_restores_agent_ownership_without_reconciling_unknown_provider_operations() {
    let (_root, service, provider, connection) = fixture();
    let record = service.create(input(&connection)).unwrap();
    let mut operation = service
        .operations
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            &record.id,
            &connection,
            "start",
            json!({"record": service.store.get(&record.id).unwrap()}),
        )
        .unwrap();
    service
        .operations
        .phase(&mut operation, "uncertain", Some("Result unknown".into()))
        .unwrap();
    service
        .observations
        .set(&record.id, WindowState::Unknown, true)
        .unwrap();
    let expected_operation = serde_json::to_value(&operation).unwrap();
    let expected_observation =
        serde_json::to_value(service.observations.get(&record.id).unwrap()).unwrap();
    let profiles = service.store.root().to_path_buf();
    let license = service.builtin.license_store.clone();
    drop(service);
    let mut service =
        WindowService::with_runtime(profiles, None, license, RuntimePaths::development()).unwrap();
    service.registry.register(provider.clone());
    provider.offline.store(true, Ordering::SeqCst);
    let owner = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        service
            .acquire_agent_window(&record.id, &owner)
            .unwrap_err()
            .code,
        "operation_uncertain"
    );
    service.restore_agent_window(&record.id, &owner).unwrap();
    service.restore_agent_window(&record.id, &owner).unwrap();
    assert_eq!(
        service
            .restore_agent_window(&record.id, "other-owner")
            .unwrap_err()
            .code,
        "profile_busy"
    );
    assert_eq!(
        service.start_window(&record.id).unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(service.stop(&record.id).unwrap_err().code, "profile_busy");
    assert_eq!(
        service.update_note(&record.id, "edit").unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(
        service.delete_window(&record.id, false).unwrap_err().code,
        "profile_busy"
    );
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(service.operations.get(&operation.id).unwrap().unwrap()).unwrap(),
        expected_operation
    );
    assert_eq!(
        serde_json::to_value(service.observations.get(&record.id).unwrap()).unwrap(),
        expected_observation
    );
    assert!(service.agent_actors.lock().unwrap().is_empty());
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
    assert_eq!(provider.updates.load(Ordering::SeqCst), 0);
}

#[test]
fn quiescing_retains_the_agent_owner_until_an_explicit_release() {
    let (_root, service, _provider, connection) = fixture();
    let record = service.create(input(&connection)).unwrap();
    let owner = uuid::Uuid::new_v4().to_string();
    service.acquire_agent_window(&record.id, &owner).unwrap();
    assert_eq!(
        service
            .quiesce_agent_window(&record.id, "other-owner")
            .unwrap_err()
            .code,
        "permission_denied"
    );
    service.quiesce_agent_window(&record.id, &owner).unwrap();
    service.quiesce_agent_window(&record.id, &owner).unwrap();
    assert_eq!(
        service.start_window(&record.id).unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(service.stop(&record.id).unwrap_err().code, "profile_busy");
    assert_eq!(
        service.update_note(&record.id, "edit").unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(
        service.delete_window(&record.id, false).unwrap_err().code,
        "profile_busy"
    );
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_err()
    );
    assert_eq!(
        service
            .acquire_agent_window(&record.id, "other-owner")
            .unwrap_err()
            .code,
        "profile_busy"
    );
    service.acquire_agent_window(&record.id, &owner).unwrap();
    service.release_agent_window(&record.id, &owner).unwrap();
    service.update_note(&record.id, "editable").unwrap();
}

fn native_fixture() -> (
    tempfile::TempDir,
    WindowService,
    Arc<FakeProvider>,
    WindowRecord,
) {
    let (root, mut service, _, _) = fixture();
    let provider = Arc::new(FakeProvider {
        provider_id: Some(BrowserProviderId::CloakBrowser),
        ..Default::default()
    });
    service.registry.register(provider.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let record = WindowRecord {
        schema_version: 2,
        id: id.clone(),
        name: "Native".into(),
        binding: BrowserBinding {
            provider_id: BrowserProviderId::CloakBrowser,
            connection_id: BUILTIN_CONNECTION_ID.into(),
            profile_id: id.clone(),
        },
        binary_path: Some(root.path().join("chromium-155.0.8059.39.5-pro/browser")),
        kernel_version: Some("155.0.8059.39.5".into()),
        proxy: None,
        proxy_plugin: None,
        proxy_endpoint: None,
        proxy_mode: ProxyMode::Direct,
        settings: WindowSettings {
            fingerprint_seed: Some(12345),
            ..Default::default()
        },
        origin: WindowOrigin::Created,
        provider_config: json!({}),
        created_at: now_seconds(),
        last_opened_at: None,
        sort_order: service.sequence().unwrap(),
    };
    service.store.insert(&record, None).unwrap();
    provider
        .profiles
        .lock()
        .unwrap()
        .insert(id, WindowState::Stopped);
    (root, service, provider, record)
}

#[test]
fn batch_group_moves_are_local_even_when_an_external_browser_is_running_or_offline() {
    let (_root, service, provider, connection) = fixture();
    let a = service.create(input(&connection)).unwrap();
    let b = service.create(input(&connection)).unwrap();
    provider
        .profiles
        .lock()
        .unwrap()
        .insert(a.provider_profile_id.clone(), WindowState::Running);
    provider.offline.store(true, Ordering::SeqCst);
    let groups = super::super::group_store::GroupStore::new(service.store.database_path()).unwrap();
    let group = groups.create("Moved", "").unwrap();
    let before = service.store.get(&a.id).unwrap();
    let request = MoveWindowsGroupInput {
        connection_id: connection,
        ids: vec![a.id.clone(), b.id.clone()],
        group_id: Some(group.id.clone()),
    };
    let receipt = service.move_group(request.clone()).unwrap();
    assert_eq!(receipt.ids, request.ids);
    assert_eq!(receipt.connection_id, request.connection_id);
    assert_eq!(receipt.group_id, request.group_id);
    assert_eq!(groups.list().unwrap()[0].window_count, 2);
    assert_eq!(service.store.get(&a.id).unwrap(), before);
    assert_eq!(provider.updates.load(Ordering::SeqCst), 0);
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
}

#[test]
fn batch_group_moves_reject_cross_connection_busy_and_pending_windows_before_writing() {
    let (_root, service, _provider, connection) = fixture();
    let a = service.create(input(&connection)).unwrap();
    let b = service.create(input(&connection)).unwrap();
    let groups = super::super::group_store::GroupStore::new(service.store.database_path()).unwrap();
    let group = groups.create("Target", "").unwrap();
    let request = MoveWindowsGroupInput {
        connection_id: connection.clone(),
        ids: vec![a.id.clone(), b.id.clone()],
        group_id: Some(group.id.clone()),
    };
    {
        let _held = service.hold(&b.id).unwrap();
        assert_eq!(
            service.move_group(request.clone()).unwrap_err().code,
            "profile_busy"
        );
        assert_eq!(service.store.group_id(&a.id).unwrap(), None);
    }
    assert_eq!(
        service
            .move_group(MoveWindowsGroupInput {
                connection_id: BUILTIN_CONNECTION_ID.into(),
                ..request.clone()
            })
            .unwrap_err()
            .code,
        "scope_mismatch"
    );
    let operation = service
        .operations
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            &b.id,
            &connection,
            "update",
            json!({}),
        )
        .unwrap();
    assert_eq!(
        service.move_group(request.clone()).unwrap_err().code,
        "operation_uncertain"
    );
    assert_eq!(service.store.group_id(&a.id).unwrap(), None);
    assert_eq!(groups.list().unwrap()[0].window_count, 0);
    let mut operation = operation;
    service
        .operations
        .phase(&mut operation, "failed", None)
        .unwrap();
    service.move_group(request).unwrap();
    assert_eq!(groups.list().unwrap()[0].window_count, 2);
}

#[test]
fn external_creation_does_not_require_builtin_license_and_retries_use_one_vendor_profile() {
    let (_root, service, provider, connection) = fixture();
    provider.create_timeout.store(true, Ordering::SeqCst);
    let request = input(&connection);
    assert!(service.create(request.clone()).is_err());
    assert_eq!(
        service.operations.list(Some(&connection)).unwrap()[0].phase,
        "uncertain"
    );
    let window = service.create(request.clone()).unwrap();
    assert_eq!(window.provider_id, BrowserProviderId::AdsPower);
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    assert_eq!(service.create(request).unwrap().id, window.id);
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn created_window_cannot_be_retried_with_another_configuration() {
    let (_root, service, provider, connection) = fixture();
    let mut request = input(&connection);
    service.create(request.clone()).unwrap();
    request.name = "Changed".into();
    assert_eq!(
        service.create(request).unwrap_err().code,
        "operation_conflict"
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn uncertain_start_is_reconciled_without_starting_a_second_session() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    provider.start_timeout.store(true, Ordering::SeqCst);
    assert!(service.start_window(&window.id).is_err());
    assert!(service.start_window(&window.id).is_err());
    let op = service.operations.list(None).unwrap().remove(0);
    assert_eq!(
        service.reconcile(&op.id).unwrap().unwrap().state,
        WindowState::Running
    );
    assert_eq!(provider.starts.load(Ordering::SeqCst), 1);
    service.stop(&window.id).unwrap();
    assert_eq!(
        service.list(Some(&connection)).unwrap()[0].state,
        WindowState::Stopped
    );
}

#[test]
fn disconnect_marks_unknown_and_requires_scope_reconfirmation_without_removing_accounts() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    service.start_window(&window.id).unwrap();
    provider.offline.store(true, Ordering::SeqCst);
    assert_eq!(
        service.list(Some(&connection)).unwrap()[0].state,
        WindowState::Unknown
    );
    assert!(
        !service
            .connections
            .get(&connection)
            .unwrap()
            .scope_confirmed
    );
    assert!(service.store.get(&window.id).is_ok());
}

#[test]
fn removing_association_keeps_vendor_environment_running() {
    let (_root, service, provider, connection) = fixture();
    provider
        .profiles
        .lock()
        .unwrap()
        .insert("existing".into(), WindowState::Running);
    let windows = service.attach(&connection, &["existing".into()]).unwrap();
    service.delete_window(&windows[0].id, false).unwrap();
    assert_eq!(
        provider.profiles.lock().unwrap().get("existing"),
        Some(&WindowState::Running)
    );
    assert!(service.store.list().unwrap().is_empty());
}

#[test]
fn plugin_proxy_failure_blocks_before_a_browser_start_request() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let mut record = service.store.get(&window.id).unwrap();
    record.proxy_mode = ProxyMode::Plugin;
    record.proxy_plugin = Some("studio.proxy-pool".into());
    service.store.save(&record, None).unwrap();
    assert!(service.start_window(&window.id).is_err());
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
}

#[test]
fn stable_external_sessions_do_not_block_updating_nexus() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    service.start_window(&window.id).unwrap();
    let service = Arc::new(service);
    let guard = service.lock_app_install().unwrap();
    drop(guard);
    assert_eq!(
        provider
            .profiles
            .lock()
            .unwrap()
            .get(&window.provider_profile_id),
        Some(&WindowState::Running)
    );
}

#[test]
fn a_known_rejected_creation_retries_the_same_draft_and_uuid() {
    let (_root, service, provider, connection) = fixture();
    provider.create_rejected.store(true, Ordering::SeqCst);
    let request = input(&connection);
    assert_eq!(
        service.create(request.clone()).unwrap_err().code,
        "permission_denied"
    );
    let original = service
        .operations
        .get(&request.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(original.phase, "failed");
    let window = service.create(request.clone()).unwrap();
    assert_eq!(window.id, original.window_id);
    assert_eq!(
        service
            .operations
            .get(&request.operation_id)
            .unwrap()
            .unwrap()
            .request_hash,
        original.request_hash
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 2);
    assert_eq!(provider.profiles.lock().unwrap().len(), 1);
}

#[test]
fn a_definitively_rejected_start_releases_the_slot_for_retry() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    provider.start_rejected.store(true, Ordering::SeqCst);
    assert_eq!(
        service.start_window(&window.id).unwrap_err().code,
        "invalid_config"
    );
    assert!(service.operations.list(None).unwrap().is_empty());
    assert!(service.state.lock().unwrap().scheduler.is_idle());
    assert_eq!(
        service.list(Some(&connection)).unwrap()[0].state,
        WindowState::Stopped
    );
    service.start_window(&window.id).unwrap();
    assert_eq!(provider.starts.load(Ordering::SeqCst), 2);
}

#[test]
fn update_response_loss_is_read_back_without_repeating_the_write() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    provider.update_timeout.store(true, Ordering::SeqCst);
    let mut settings = window.settings.clone();
    settings.start_url = "https://example.com".into();
    assert!(
        service
            .update(UpdateWindowInput {
                id: window.id.clone(),
                name: "Updated".into(),
                proxy_mode: ProxyMode::Direct,
                proxy: None,
                proxy_plugin: None,
                proxy_endpoint: None,
                settings,
                group_id: None,
            })
            .is_err()
    );
    let op = service.operations.list(None).unwrap().remove(0);
    assert_eq!(service.reconcile(&op.id).unwrap().unwrap().name, "Updated");
    assert_eq!(provider.updates.load(Ordering::SeqCst), 1);
    assert!(service.operations.list(None).unwrap().is_empty());
}

#[test]
fn a_confirmed_delete_finishes_locally_after_the_vendor_disconnects() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let db = super::super::database::open_database(&service.store.database_path()).unwrap();
    db.execute_batch("CREATE TRIGGER prevent_delete BEFORE DELETE ON profile_records BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
    assert!(service.delete_window(&window.id, true).is_err());
    let op = service.operations.list(None).unwrap().remove(0);
    assert_eq!(op.phase, "confirmed");
    assert!(provider.profiles.lock().unwrap().is_empty());
    provider.offline.store(true, Ordering::SeqCst);
    let observed = service.connections.get(&connection).unwrap();
    service
        .connections
        .unconfirm(&connection, observed.revision)
        .unwrap();
    db.execute_batch("DROP TRIGGER prevent_delete;").unwrap();
    assert!(service.reconcile(&op.id).unwrap().is_none());
    assert!(service.store.list().unwrap().is_empty());
    assert!(service.operations.list(None).unwrap().is_empty());
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn operation_reconciliation_uses_the_same_window_lock_as_mutations() {
    let (_root, service, provider, connection) = fixture();
    provider.create_timeout.store(true, Ordering::SeqCst);
    let request = input(&connection);
    assert!(service.create(request.clone()).is_err());
    let op = service
        .operations
        .get(&request.operation_id)
        .unwrap()
        .unwrap();
    let guard = service.hold(&op.window_id).unwrap();
    assert_eq!(service.reconcile(&op.id).unwrap_err().code, "profile_busy");
    drop(guard);
    service.reconcile(&op.id).unwrap();
}

#[test]
fn local_business_fields_can_be_saved_without_changing_a_running_vendor_profile() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    service.start_window(&window.id).unwrap();
    let mut settings = window.settings.clone();
    settings.note = "Business note".into();
    settings.platform = "Vinted".into();
    provider.offline.store(true, Ordering::SeqCst);
    service
        .update(UpdateWindowInput {
            id: window.id.clone(),
            name: window.name,
            proxy_mode: window.proxy_mode,
            proxy: window.proxy,
            proxy_plugin: window.proxy_plugin,
            proxy_endpoint: window.proxy_endpoint,
            settings,
            group_id: None,
        })
        .unwrap();
    assert_eq!(
        service.store.get(&window.id).unwrap().settings.note,
        "Business note"
    );
    assert_eq!(provider.updates.load(Ordering::SeqCst), 0);
}

#[test]
fn a_pending_operation_does_not_block_setting_up_another_browser_provider() {
    let (_root, service, provider, connection) = fixture();
    provider.create_timeout.store(true, Ordering::SeqCst);
    assert!(service.create(input(&connection)).is_err());
    assert!(
        service
            .hold_connections(BrowserProviderId::AdsPower, false)
            .is_err()
    );
    let other = service
        .hold_connections(BrowserProviderId::BitBrowser, false)
        .unwrap();
    drop(other);
}

#[test]
fn an_inactive_connection_can_be_verified_then_activated_without_enabling_early_mutations() {
    let (_root, service, provider, original_id) = fixture();
    let original = service.create(input(&original_id)).unwrap();
    let saved = service
        .connections
        .save(ConnectionInput {
            id: None,
            provider_id: BrowserProviderId::AdsPower,
            name: "Second connection".into(),
            endpoint: "http://127.0.0.1:50326".into(),
            api_key: None,
            default_group_id: None,
            scope_label: "Second account".into(),
        })
        .unwrap();
    assert!(!saved.enabled);
    assert!(service.probe_connection(&saved.id).unwrap().connected);
    assert!(service.connection_groups(&saved.id).unwrap().is_empty());
    assert!(
        service
            .confirm_connection(&saved.id, "Second account")
            .unwrap()
            .connection
            .scope_confirmed
    );
    assert_eq!(
        service.create(input(&saved.id)).unwrap_err().code,
        "unavailable"
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    assert!(
        service
            .activate_connection(&saved.id)
            .unwrap()
            .connection
            .enabled
    );
    service.create(input(&saved.id)).unwrap();
    service.connections.reset_confirmations().unwrap();
    assert!(!service.connections.get(&original_id).unwrap().enabled);
    assert!(service.probe_connection(&original_id).unwrap().connected);
    service
        .confirm_connection(&original_id, "Test account")
        .unwrap();
    service.activate_connection(&original_id).unwrap();
    assert_eq!(
        service
            .store
            .get(&original.id)
            .unwrap()
            .binding
            .connection_id,
        original_id
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 2);
}

#[test]
fn reconciled_native_start_retains_occupancy_until_confirmed_stop() {
    let (_root, service, provider, record) = native_fixture();
    let db = super::super::database::open_database(&service.store.database_path()).unwrap();
    db.execute_batch("CREATE TRIGGER fail_start_journal BEFORE UPDATE ON browser_operations WHEN NEW.kind='start' AND NEW.phase='confirmed' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(service.start_window(&record.id).is_err());
    let operation = service.operations.list(None).unwrap().remove(0);
    assert_eq!(operation.phase, "submitted");
    db.execute_batch("DROP TRIGGER fail_start_journal;")
        .unwrap();
    assert_eq!(
        service.reconcile(&operation.id).unwrap().unwrap().state,
        WindowState::Running
    );
    assert_eq!(
        service
            .state
            .lock()
            .unwrap()
            .scheduler
            .status(&record.id)
            .unwrap()
            .state,
        WindowState::Running
    );
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_err()
    );
    let service = Arc::new(service);
    assert!(service.lock_app_install().is_err());
    assert_eq!(provider.starts.load(Ordering::SeqCst), 1);
    service.stop(&record.id).unwrap();
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_ok()
    );
}

#[test]
fn a_stale_stopped_observation_cannot_clear_a_new_session_generation() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let service = Arc::new(service);
    let captured = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    *provider.observation_pause.lock().unwrap() = Some((captured.clone(), resume.clone()));
    let reading = {
        let service = service.clone();
        let connection = connection.clone();
        std::thread::spawn(move || service.list(Some(&connection)).unwrap())
    };
    captured.wait();
    service.start_window(&window.id).unwrap();
    let generation = service
        .state
        .lock()
        .unwrap()
        .scheduler
        .status(&window.id)
        .unwrap()
        .snapshot
        .generation;
    resume.wait();
    let result = reading.join().unwrap();
    assert_eq!(result[0].state, WindowState::Running);
    let state = service.state.lock().unwrap();
    let active = state.scheduler.status(&window.id).unwrap();
    assert_eq!(active.snapshot.generation, generation);
    assert_eq!(active.state, WindowState::Running);
    drop(state);
    assert_eq!(
        service.observations.get(&window.id).unwrap().unwrap().state,
        WindowState::Running
    );
}

#[test]
fn connection_snapshots_are_reloaded_with_their_observation_tickets() {
    let (_root, mut service, native_provider, _native) = native_fixture();
    let provider = Arc::new(FakeProvider::default());
    service.registry.register(provider.clone());
    let connection = service
        .connections
        .list()
        .unwrap()
        .into_iter()
        .find(|connection| connection.provider_id == BrowserProviderId::AdsPower)
        .unwrap();
    let window = service.create(input(&connection.id)).unwrap();
    let service = Arc::new(service);
    let captured = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    *native_provider.observation_pause.lock().unwrap() = Some((captured.clone(), resume.clone()));
    let reading = {
        let service = service.clone();
        std::thread::spawn(move || service.list(None).unwrap())
    };
    captured.wait();
    let updated = {
        let _guard = service
            .hold_connections(BrowserProviderId::AdsPower, false)
            .unwrap();
        service
            .connections
            .save(ConnectionInput {
                id: Some(connection.id.clone()),
                provider_id: connection.provider_id,
                name: connection.name.clone(),
                endpoint: "http://127.0.0.1:50326".into(),
                api_key: Some("fixture-new-key".into()),
                default_group_id: None,
                scope_label: connection.scope_label.clone(),
            })
            .unwrap()
    };
    service
        .confirm_connection(&connection.id, &connection.scope_label)
        .unwrap();
    provider
        .minimum_revision
        .store(updated.revision, Ordering::SeqCst);
    service.start_window(&window.id).unwrap();
    resume.wait();
    let windows = reading.join().unwrap();
    assert_eq!(
        windows
            .iter()
            .find(|row| row.id == window.id)
            .unwrap()
            .state,
        WindowState::Running
    );
    assert_eq!(
        service
            .state
            .lock()
            .unwrap()
            .scheduler
            .status(&window.id)
            .unwrap()
            .state,
        WindowState::Running
    );
    assert_eq!(
        service.observations.get(&window.id).unwrap().unwrap().state,
        WindowState::Running
    );
}

#[test]
fn verified_remote_metadata_refresh_preserves_local_window_identity_and_relationships() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let groups = super::super::group_store::GroupStore::new(service.store.database_path()).unwrap();
    let group = groups.create("Business group", "").unwrap();
    let mut saved = service.store.get(&window.id).unwrap();
    saved.settings.note = "Local business note".into();
    saved.settings.platform = "Poshmark".into();
    saved.proxy_mode = ProxyMode::Plugin;
    saved.proxy_plugin = Some("studio.proxy-pool".into());
    saved.proxy_endpoint = Some(42);
    service.store.save(&saved, Some(&group.id)).unwrap();
    let mut remote = provider.remote(&window.provider_profile_id);
    remote.name = "Renamed in vendor app".into();
    remote.kernel_version = Some("observed-kernel-2".into());
    provider
        .metadata
        .lock()
        .unwrap()
        .insert(remote.id.clone(), remote);
    let refreshed = service.list(Some(&connection)).unwrap().remove(0);
    assert_eq!(refreshed.id, window.id);
    assert_eq!(refreshed.name, "Renamed in vendor app");
    assert_eq!(
        refreshed.kernel_version.as_deref(),
        Some("observed-kernel-2")
    );
    assert_eq!(refreshed.settings, saved.settings);
    assert_eq!(refreshed.proxy_mode, ProxyMode::Plugin);
    assert_eq!(refreshed.proxy_endpoint, Some(42));
    assert_eq!(refreshed.group_id.as_deref(), Some(group.id.as_str()));
    let repeated = service
        .attach(&connection, &[window.provider_profile_id])
        .unwrap()
        .remove(0);
    assert_eq!(repeated.id, window.id);
    assert_eq!(repeated.name, refreshed.name);
    assert_eq!(repeated.kernel_version, refreshed.kernel_version);
    let reopened = WindowStore::new(service.store.root().into());
    assert_eq!(reopened.get(&window.id).unwrap().name, refreshed.name);
    assert_eq!(
        reopened.get(&window.id).unwrap().sort_order,
        saved.sort_order
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn pending_edits_block_remote_metadata_replacement_and_repeated_attachment() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let previous = service.store.get(&window.id).unwrap();
    let mut updated = previous.clone();
    updated.name = "Pending desired name".into();
    let evidence = provider
        .prepare_update_evidence(&previous, &updated)
        .unwrap();
    let mut operation = service
        .operations
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            &window.id,
            &connection,
            "update",
            json!({"previous":previous,"record":updated,"groupId":null,"updateEvidence":evidence}),
        )
        .unwrap();
    service
        .operations
        .phase(&mut operation, "submitted", None)
        .unwrap();
    let mut remote = provider.remote(&window.provider_profile_id);
    remote.name = "Changed elsewhere".into();
    provider
        .metadata
        .lock()
        .unwrap()
        .insert(remote.id.clone(), remote);
    assert_eq!(
        service.list(Some(&connection)).unwrap()[0].name,
        window.name
    );
    assert_eq!(
        service
            .attach(&connection, &[window.provider_profile_id])
            .unwrap_err()
            .code,
        "operation_uncertain"
    );
    assert_eq!(
        service
            .operations
            .get(&operation.id)
            .unwrap()
            .unwrap()
            .payload,
        operation.payload
    );
}

#[test]
fn install_reserves_its_interlock_before_reading_provider_state() {
    let (_root, service, provider, record) = native_fixture();
    let service = Arc::new(service);
    let captured = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    *provider.observation_pause.lock().unwrap() = Some((captured.clone(), resume.clone()));
    let installing = {
        let service = service.clone();
        std::thread::spawn(move || {
            let guard = service.lock_app_install().unwrap();
            drop(guard);
        })
    };
    captured.wait();
    assert_eq!(
        service.start_window(&record.id).unwrap_err().code,
        "profile_busy"
    );
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
    resume.wait();
    installing.join().unwrap();
    assert!(!service.state.lock().unwrap().installing);
}

#[test]
fn transfer_checks_fresh_provider_state_and_excludes_new_starts_during_its_read() {
    let (_root, service, provider, record) = native_fixture();
    provider
        .profiles
        .lock()
        .unwrap()
        .insert(record.id.clone(), WindowState::Running);
    assert!(service.state.lock().unwrap().scheduler.is_idle());
    assert!(
        service
            .lock_transfer(std::slice::from_ref(&record.id))
            .is_err()
    );
    assert!(service.state.lock().unwrap().transfers.is_empty());
    provider
        .profiles
        .lock()
        .unwrap()
        .insert(record.id.clone(), WindowState::Stopped);
    let guard = service
        .lock_transfer(std::slice::from_ref(&record.id))
        .unwrap();
    assert_eq!(
        service.start_window(&record.id).unwrap_err().code,
        "profile_busy"
    );
    drop(guard);
    service.start_window(&record.id).unwrap();
}

#[test]
fn pending_create_binding_cannot_be_stolen_by_attach() {
    let (_root, service, provider, connection) = fixture();
    let db = super::super::database::open_database(&service.store.database_path()).unwrap();
    db.execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON profile_records BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let request = input(&connection);
    assert!(service.create(request.clone()).is_err());
    let operation = service
        .operations
        .get(&request.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(operation.phase, "confirmed");
    let remote = operation.payload["record"]["binding"]["profile_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        service
            .attach(&connection, std::slice::from_ref(&remote))
            .unwrap_err()
            .code,
        "operation_uncertain"
    );
    db.execute_batch("DROP TRIGGER fail_insert;").unwrap();
    let restored = service.reconcile(&operation.id).unwrap().unwrap();
    assert_eq!(restored.id, operation.window_id);
    assert_eq!(
        service.attach(&connection, &[remote]).unwrap()[0].id,
        restored.id
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
}

#[test]
fn committed_and_uncertain_create_retries_survive_deletion_of_the_original_group() {
    for timeout in [false, true] {
        let (_root, service, provider, connection) = fixture();
        let groups =
            super::super::group_store::GroupStore::new(service.store.database_path()).unwrap();
        let group = groups.create("Temporary", "").unwrap();
        let mut request = input(&connection);
        request.group_id = Some(group.id.clone());
        provider.create_timeout.store(timeout, Ordering::SeqCst);
        let _ = service.create(request.clone());
        let operation = service
            .operations
            .get(&request.operation_id)
            .unwrap()
            .unwrap();
        groups.delete(&group.id).unwrap();
        let window = service.create(request).unwrap();
        assert_eq!(window.id, operation.window_id);
        assert_eq!(window.group_id, None);
        assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn submitted_update_recovery_never_resolves_the_mutable_proxy_source_again() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let previous = service.store.get(&window.id).unwrap();
    let mut updated = previous.clone();
    updated.name = "Recovered".into();
    updated.proxy_mode = ProxyMode::Plugin;
    updated.proxy_plugin = Some("studio.proxy-pool".into());
    let evidence = UpdateEvidence::from_fields(
        BrowserProviderId::AdsPower,
        &json!({"proxy":"socks5://user:original@127.0.0.1:7890"}),
    )
    .unwrap();
    let mut operation = service
        .operations
        .prepare(
            &uuid::Uuid::new_v4().to_string(),
            &window.id,
            &connection,
            "update",
            json!({"previous":previous,"record":updated,"groupId":null,"updateEvidence":evidence}),
        )
        .unwrap();
    service
        .operations
        .phase(&mut operation, "submitted", None)
        .unwrap();
    provider.update_confirmed.store(true, Ordering::SeqCst);
    assert!(service.plugin_host.is_none());
    let recovered = service.reconcile(&operation.id).unwrap().unwrap();
    assert_eq!(recovered.proxy_mode, ProxyMode::Plugin);
    assert_eq!(recovered.proxy, None);
    assert!(
        !serde_json::to_string(&operation.payload)
            .unwrap()
            .contains("original@")
    );
    assert_eq!(provider.updates.load(Ordering::SeqCst), 0);
}

#[test]
fn renaming_a_window_does_not_require_resolving_its_unchanged_plugin_proxy() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    let mut record = service.store.get(&window.id).unwrap();
    record.proxy_mode = ProxyMode::Plugin;
    record.proxy_plugin = Some("studio.proxy-pool".into());
    record.proxy_endpoint = Some(42);
    service.store.save(&record, None).unwrap();
    assert!(service.plugin_host.is_none());
    service
        .update(UpdateWindowInput {
            id: record.id.clone(),
            name: "Rename without changing proxy".into(),
            proxy_mode: record.proxy_mode,
            proxy: record.proxy.clone(),
            proxy_plugin: record.proxy_plugin.clone(),
            proxy_endpoint: record.proxy_endpoint,
            settings: record.settings.clone(),
            group_id: None,
        })
        .unwrap();
    assert_eq!(
        service.store.get(&record.id).unwrap().name,
        "Rename without changing proxy"
    );
    assert_eq!(provider.updates.load(Ordering::SeqCst), 1);
}

#[test]
fn manual_association_resolves_an_ambiguous_create_using_its_reserved_uuid() {
    let (_root, service, provider, connection) = fixture();
    provider.create_timeout.store(true, Ordering::SeqCst);
    let request = input(&connection);
    assert!(service.create(request.clone()).is_err());
    let operation = service
        .operations
        .get(&request.operation_id)
        .unwrap()
        .unwrap();
    provider.marker_ambiguous.store(true, Ordering::SeqCst);
    assert!(service.reconcile(&operation.id).is_err());
    let recovered = service
        .resolve_operation(ResolveOperationInput::Associate {
            id: operation.id.clone(),
            provider_profile_id: "vendor-0".into(),
            confirmed: true,
        })
        .unwrap()
        .unwrap();
    assert_eq!(recovered.id, operation.window_id);
    assert_eq!(recovered.origin, WindowOrigin::Attached);
    assert_eq!(recovered.proxy_mode, ProxyMode::Provider);
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    let completed = service.operations.get(&operation.id).unwrap().unwrap();
    assert_eq!(completed.phase, "committed");
    assert_eq!(completed.resolution.unwrap().action, "associate");
}

#[test]
fn explicit_abandonment_is_durable_and_never_replays_a_create() {
    let (_root, service, provider, connection) = fixture();
    provider.create_timeout.store(true, Ordering::SeqCst);
    let request = input(&connection);
    assert!(service.create(request.clone()).is_err());
    provider.markers.lock().unwrap().clear();
    assert!(service.reconcile(&request.operation_id).is_err());
    assert!(
        service
            .resolve_operation(ResolveOperationInput::Abandon {
                id: request.operation_id.clone(),
                confirmed: false,
            })
            .is_err()
    );
    assert!(
        service
            .operations
            .window_pending(
                &service
                    .operations
                    .get(&request.operation_id)
                    .unwrap()
                    .unwrap()
                    .window_id
            )
            .unwrap()
    );
    assert!(
        service
            .resolve_operation(ResolveOperationInput::Abandon {
                id: request.operation_id.clone(),
                confirmed: true,
            })
            .unwrap()
            .is_none()
    );
    assert!(service.operations.list(None).unwrap().is_empty());
    assert_eq!(
        service
            .operations
            .get(&request.operation_id)
            .unwrap()
            .unwrap()
            .phase,
        "cancelled"
    );
    assert_eq!(
        service.create(request).unwrap_err().code,
        "operation_cancelled"
    );
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    assert_eq!(provider.profiles.lock().unwrap().len(), 1);
}

#[test]
fn offline_unconfirmed_create_can_be_ended_locally_before_connection_repair() {
    let (_root, service, provider, connection) = fixture();
    provider.create_timeout.store(true, Ordering::SeqCst);
    let request = input(&connection);
    assert!(service.create(request.clone()).is_err());
    let operation = service
        .operations
        .get(&request.operation_id)
        .unwrap()
        .unwrap();
    let observed = service.connections.get(&connection).unwrap();
    provider.offline.store(true, Ordering::SeqCst);
    service
        .connections
        .unconfirm(&connection, observed.revision)
        .unwrap();
    assert!(
        service
            .hold_connections(BrowserProviderId::AdsPower, false)
            .is_err()
    );
    assert!(
        service
            .resolve_operation(ResolveOperationInput::Abandon {
                id: operation.id.clone(),
                confirmed: true,
            })
            .unwrap()
            .is_none()
    );
    let completed = service.operations.get(&operation.id).unwrap().unwrap();
    assert_eq!(completed.phase, "cancelled");
    assert_eq!(completed.window_id, operation.window_id);
    assert_eq!(completed.request_hash, operation.request_hash);
    assert_eq!(completed.payload, operation.payload);
    let _guard = service
        .hold_connections(BrowserProviderId::AdsPower, false)
        .unwrap();
    let repaired = service
        .connections
        .save(ConnectionInput {
            id: Some(connection),
            provider_id: BrowserProviderId::AdsPower,
            name: observed.name,
            endpoint: "http://127.0.0.1:50326".into(),
            api_key: Some("fixture-repaired-key".into()),
            default_group_id: None,
            scope_label: observed.scope_label,
        })
        .unwrap();
    assert!(!repaired.scope_confirmed);
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    assert_eq!(provider.profiles.lock().unwrap().len(), 1);
}

#[test]
fn an_external_start_that_remains_stopped_can_be_explicitly_ended_without_replay() {
    let (_root, service, provider, connection) = fixture();
    let window = service.create(input(&connection)).unwrap();
    provider.start_timeout.store(true, Ordering::SeqCst);
    assert!(service.start_window(&window.id).is_err());
    let operation = service.operations.list(None).unwrap().remove(0);
    provider
        .profiles
        .lock()
        .unwrap()
        .insert(window.provider_profile_id.clone(), WindowState::Stopped);
    assert!(service.reconcile(&operation.id).is_err());
    let ended = service
        .resolve_operation(ResolveOperationInput::Abandon {
            id: operation.id.clone(),
            confirmed: true,
        })
        .unwrap()
        .unwrap();
    assert_eq!(ended.state, WindowState::Stopped);
    assert_eq!(provider.starts.load(Ordering::SeqCst), 1);
    assert!(service.state.lock().unwrap().scheduler.is_idle());
    assert!(service.operations.list(None).unwrap().is_empty());
    service.start_window(&window.id).unwrap();
    assert_eq!(provider.starts.load(Ordering::SeqCst), 2);
}
