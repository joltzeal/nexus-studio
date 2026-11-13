use serde_json::{Value, json};
use std::sync::Arc;
use tempfile::TempDir;
use uuid::Uuid;

use super::artifacts::Artifacts;
use super::dto::*;
use super::gateway::{fields, validate_confirmation};
use super::service::{AgentService, job_budgets, validate_account, validate_settings};
use super::sql::read_u64;
use super::store::{AgentStore, Job};
use crate::core::database::open_database;
use crate::core::plugin_host::PluginHost;
use crate::core::plugin_host::process::{HostRequest, PluginCaller};

#[path = "model_history_tests.rs"]
mod model_history;

fn id() -> String {
    Uuid::new_v4().to_string()
}
fn fixture() -> (TempDir, AgentStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    (temp, store)
}
fn settings() -> Value {
    json!({
        "decision":{"baseUrl":"https://decision.invalid","apiKey":"fixture-private-decision",
            "model":"fixture-decision","protocol":"typesafe"},
        "generation":{"baseUrl":"https://generation.invalid","apiKey":"fixture-private-generation",
            "model":"fixture-generation"},
        "requestTimeoutMs":60000,"maxStepsPerItem":30,"maxCopyRewrites":2,"reviewThreshold":0.8
    })
}
fn snapshot() -> JobSnapshot {
    JobSnapshot {
        window_id: id(),
        window_name: "Fixture window".into(),
        provider_id: "cloakbrowser".into(),
        connection_id: "builtin".into(),
        profile_id: id(),
        platform_origin: "https://www.vinted.com".into(),
        account: json!({"accountId":id(),"account":"fixture-account","status":"active",
            "homepageUrl":"https://www.vinted.com/member/42-fixture","platformUserId":"42","observation":null}),
        products: vec![],
        messages: vec![],
    }
}
fn input(snapshot: &JobSnapshot, preset: Preset) -> BatchCreateInput {
    BatchCreateInput {
        operation_id: id(),
        preset,
        instruction: String::new(),
        concurrency: 3,
        assignments: vec![Assignment {
            window_id: snapshot.window_id.clone(),
            product_ids: snapshot
                .products
                .iter()
                .map(|value| value["id"].as_str().unwrap().to_owned())
                .collect(),
            overrides: vec![],
            messages: snapshot.messages.clone(),
        }],
    }
}
fn create(
    store: &AgentStore,
    snapshot: JobSnapshot,
    preset: Preset,
) -> (String, String, BatchCreateInput) {
    let batch = id();
    let job = id();
    let input = input(&snapshot, preset);
    store
        .create(&batch, &input, &[(job.clone(), snapshot)], &settings())
        .unwrap();
    (batch, job, input)
}
fn claim(store: &AgentStore, job: &str) -> Job {
    store.claim(job, "fixture-generation").unwrap().unwrap()
}
fn output(state: StepState) -> StepOutput {
    StepOutput {
        state,
        phase: "fixture_phase".into(),
        message: None,
        retry: None,
        progress: None,
        item_updates: vec![],
    }
}
fn product() -> Value {
    json!({"id":id(),"revision":2,"name":"Fixture product","title":"Used cotton shirt",
    "description":"A used cotton shirt.","price":12.5,"currency":"USD","condition":"Good",
    "category":"","brand":"","size":"","tags":[],"status":"ready","publicationCount":0,
    "latestPublication":null,"images":[{
        "id":id(),"artifactId":id(),"name":"fixture.png","mime":"image/png",
        "bytes":8,"sha256":"a".repeat(64)
    }]})
}
fn listing_operation(job: &Job, index: usize) -> String {
    super::items::operation_id(
        &job.id,
        &format!(
            "listing:{}",
            job.snapshot.products[index]["id"].as_str().unwrap()
        ),
    )
}
fn listing_result(job: &Job, product_index: usize) -> Value {
    let product = &job.snapshot.products[product_index];
    json!({"kind":"listing","productId":product["id"],"productRevision":product["revision"],
        "listingId":"91827","listingUrl":"https://www.vinted.com/items/91827-used-shirt",
        "publishedAt":"2026-11-13T01:02:03.004Z","windowId":job.snapshot.window_id,
        "windowName":job.snapshot.window_name,"platform":"vinted"})
}

#[test]
fn batch_intent_is_durable_idempotent_and_private() {
    let (temp, store) = fixture();
    let snap = snapshot();
    let (batch, job, input) = create(&store, snap.clone(), Preset::InspectAccounts);
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    let repeated = reopened
        .create(
            &id(),
            &input,
            &[(id(), snap.clone())],
            &json!({"changed":true}),
        )
        .unwrap();
    assert_eq!(repeated, batch);
    assert_eq!(reopened.job(&job).unwrap().settings, settings());
    let view = reopened
        .get(&BatchGetInput {
            batch_id: batch.clone(),
            page: 1,
            page_size: 20,
        })
        .unwrap();
    assert_eq!(view["batch"]["total"], 1);
    assert_eq!(view["jobs"][0]["state"], "queued");
    for key in [
        "fixture-private-decision",
        "fixture-private-generation",
        "apiKey",
        "snapshot",
        "settings",
    ] {
        assert!(!view.to_string().contains(key));
    }
    let mut changed = input.clone();
    changed.instruction = "different".into();
    assert_eq!(
        reopened
            .create(&id(), &changed, &[(id(), snap)], &settings())
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        reopened
            .list(&PageInput {
                page: 1,
                page_size: 20
            })
            .unwrap()["total"],
        1
    );
}

#[test]
fn validation_precedes_all_batch_writes() {
    let (_temp, store) = fixture();
    let snap = snapshot();
    let mut draft = input(&snap, Preset::InspectAccounts);
    draft.instruction = "x".repeat(4001);
    assert!(
        store
            .create(&id(), &draft, &[(id(), snap.clone())], &settings())
            .is_err()
    );
    draft.instruction.clear();
    draft.assignments.push(draft.assignments[0].clone());
    assert!(
        store
            .create(
                &id(),
                &draft,
                &[(id(), snap.clone()), (id(), snap)],
                &settings()
            )
            .is_err()
    );
    assert_eq!(
        store
            .list(&PageInput {
                page: 1,
                page_size: 20
            })
            .unwrap()["total"],
        0
    );
}

#[test]
fn one_hundred_product_jobs_have_budget_for_full_per_item_workflows() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = (0..100).map(|_| product()).collect();
    let (_, job, _) = create(&store, snap, Preset::PostListing);
    let (steps, duration) = job_budgets(&store.job(&job).unwrap());
    assert!(steps >= 100 * 40 && steps <= u64::from(MAX_STEPS));
    assert!(duration > std::time::Duration::from_secs(30 * 60));
    assert!(duration <= std::time::Duration::from_secs(24 * 60 * 60));
}

#[test]
fn atomic_resource_conflicts_cover_distinct_pool_records_for_one_platform_identity() {
    let (_temp, store) = fixture();
    let first = snapshot();
    let mut second = snapshot();
    // Pool UUIDs, windows and profiles differ; the actual platform user is shared.
    assert_ne!(first.account["accountId"], second.account["accountId"]);
    let (_, job1, _) = create(&store, first, Preset::InspectAccounts);
    let (_, job2, _) = create(&store, second.clone(), Preset::InspectAccounts);
    let claimed = claim(&store, &job1);
    assert!(store.claim(&job2, "other-process").unwrap().is_none());
    second.account["platformUserId"] = json!("43");
    second.account["homepageUrl"] = json!("https://www.vinted.com/member/43-fixture");
    let (_, job3, _) = create(&store, second, Preset::InspectAccounts);
    // A failed multi-key claim must not leave its otherwise free window/profile locked.
    let third = store.claim(&job3, "other-process").unwrap().unwrap();
    store
        .mark_step(
            third.scope.as_ref().unwrap(),
            "other-process",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job3, true).unwrap();
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job1, true).unwrap();
    assert!(store.claim(&job2, "other-process").unwrap().is_some());
}

#[test]
fn global_concurrency_uses_the_lowest_active_batch_cap_including_draining_actors() {
    let (_temp, store) = fixture();
    let first = snapshot();
    let batch1 = id();
    let job1 = id();
    let mut draft = input(&first, Preset::InspectAccounts);
    draft.concurrency = 1;
    store
        .create(&batch1, &draft, &[(job1.clone(), first)], &settings())
        .unwrap();
    let mut second = snapshot();
    second.account["platformUserId"] = json!("43");
    second.account["homepageUrl"] = json!("https://www.vinted.fr/member/43-fixture");
    second.platform_origin = "https://www.vinted.fr".into();
    let batch2 = id();
    let job2 = id();
    let mut draft = input(&second, Preset::InspectAccounts);
    draft.concurrency = 10;
    store
        .create(&batch2, &draft, &[(job2.clone(), second)], &settings())
        .unwrap();
    claim(&store, &job1);
    assert!(store.claim(&job2, "fixture-generation").unwrap().is_none());
    store
        .control(&ControlInput {
            batch_id: batch1,
            action: ControlAction::Pause,
        })
        .unwrap();
    store.settle_control(&job1, false).unwrap();
    // Pause alone does not end an actor or remove its global concurrency budget.
    assert!(store.claim(&job2, "fixture-generation").unwrap().is_none());
    store.actor_stopped(&job1, true).unwrap();
    assert!(store.claim(&job2, "fixture-generation").unwrap().is_some());
}

#[test]
fn same_platform_identity_across_country_sites_rejects_a_partial_batch() {
    let (_temp, store) = fixture();
    let first = snapshot();
    let mut second = snapshot();
    second.platform_origin = "https://www.vinted.fr".into();
    second.account["homepageUrl"] = json!("https://www.vinted.fr/member/42-fixture");
    let mut draft = input(&first, Preset::InspectAccounts);
    draft
        .assignments
        .extend(input(&second, Preset::InspectAccounts).assignments);
    assert!(
        store
            .create(&id(), &draft, &[(id(), first), (id(), second)], &settings())
            .is_err()
    );
    assert_eq!(
        store
            .list(&PageInput {
                page: 1,
                page_size: 20
            })
            .unwrap()["total"],
        0
    );
}

#[test]
fn safe_restart_reconciliation_can_resume_without_becoming_permanently_read_only() {
    let (_temp, store) = fixture();
    let (batch, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    claim(&store, &job);
    store.recover().unwrap();
    store.actor_stopped(&job, false).unwrap();
    store
        .control(&ControlInput {
            batch_id: batch,
            action: ControlAction::Reconcile,
        })
        .unwrap();
    let next = store
        .claim(&job, "replacement-generation")
        .unwrap()
        .unwrap();
    assert!(!next.reconcile_only);
}

#[test]
fn restart_restores_stable_owners_even_after_the_automation_actor_quiesces() {
    let (temp, store) = fixture();
    let snap = snapshot();
    let (batch, job, _) = create(&store, snap.clone(), Preset::InspectAccounts);
    assert!(store.retained_window_owners().unwrap().is_empty());
    claim(&store, &job);
    store.recover().unwrap();
    assert_eq!(
        store.retained_window_owners().unwrap(),
        vec![(snap.window_id.clone(), job.clone())]
    );
    // Automation quiescence alone does not revoke the manual window guard.
    store.actor_stopped(&job, false).unwrap();
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    reopened.recover().unwrap();
    assert_eq!(
        reopened.retained_window_owners().unwrap(),
        vec![(snap.window_id, job.clone())]
    );
    reopened
        .control(&ControlInput {
            batch_id: batch,
            action: ControlAction::Cancel,
        })
        .unwrap();
    reopened.settle_control(&job, true).unwrap();
    reopened.actor_stopped(&job, true).unwrap();
    assert!(reopened.retained_window_owners().unwrap().is_empty());
}

mod window_ownership {
    use super::*;
    use crate::core::browser::connection_store::{
        BrowserConnection, ConnectionInput, ConnectionStore,
    };
    use crate::core::browser::local_api::tests::{MockResponse, MockServer, record};
    use crate::core::browser::operation_store::OperationStore;
    use crate::core::browser::provider::BrowserProviderId;
    use crate::core::license_store::LicenseStore;
    use crate::core::runtime_paths::RuntimePaths;
    use crate::core::window_service::{MoveWindowsGroupInput, UpdateWindowInput, WindowService};
    use std::path::Path;

    fn windows(root: &Path) -> Arc<WindowService> {
        Arc::new(
            WindowService::with_runtime(
                root.join("profiles"),
                None,
                LicenseStore::new(root.join("nexus.sqlite")).unwrap(),
                RuntimePaths::development(),
            )
            .unwrap(),
        )
    }

    fn connection(root: &Path, endpoint: &str) -> BrowserConnection {
        ConnectionStore::new(root.join("nexus.sqlite"))
            .unwrap()
            .save(ConnectionInput {
                id: None,
                provider_id: BrowserProviderId::AdsPower,
                name: "Fixture connection".into(),
                endpoint: endpoint.into(),
                api_key: None,
                default_group_id: None,
                scope_label: "Fixture scope".into(),
            })
            .unwrap()
    }

    fn window_snapshot(
        windows: &WindowService,
        connection: &BrowserConnection,
        member: &str,
    ) -> JobSnapshot {
        let mut record = record(connection, &format!("vendor-{}", id()));
        record.id = id();
        record.provider_config = json!({"identity":{"profileId":record.binding.profile_id}});
        windows.store.insert(&record, None).unwrap();
        let mut snapshot = snapshot();
        snapshot.window_id = record.id;
        snapshot.window_name = record.name;
        snapshot.provider_id = "adspower".into();
        snapshot.connection_id = connection.id.clone();
        snapshot.profile_id = record.binding.profile_id;
        snapshot.account["platformUserId"] = json!(member);
        snapshot.account["homepageUrl"] =
            json!(format!("https://www.vinted.com/member/{member}-fixture"));
        snapshot
    }

    fn coordinator(
        root: &Path,
        windows: &Arc<WindowService>,
    ) -> (Arc<PluginHost>, Arc<AgentService>) {
        let host = Arc::new(PluginHost::open(root.join("host"), vec![]).unwrap());
        let service = AgentService::new(
            root.join("nexus.sqlite"),
            root.join("artifacts"),
            &host,
            windows,
        )
        .unwrap();
        (host, service)
    }

    fn assert_manual_mutations_blocked(windows: &WindowService, snapshot: &JobSnapshot) {
        let record = windows.store.get(&snapshot.window_id).unwrap();
        assert_eq!(
            windows.start_window(&record.id).unwrap_err().code,
            "profile_busy"
        );
        assert_eq!(windows.stop(&record.id).unwrap_err().code, "profile_busy");
        assert_eq!(
            windows
                .update(UpdateWindowInput {
                    id: record.id.clone(),
                    name: "Changed by manual operation".into(),
                    proxy_mode: record.proxy_mode,
                    proxy: record.proxy.clone(),
                    proxy_plugin: record.proxy_plugin.clone(),
                    proxy_endpoint: record.proxy_endpoint,
                    settings: record.settings.clone(),
                    group_id: None,
                })
                .unwrap_err()
                .code,
            "profile_busy"
        );
        assert_eq!(
            windows.update_note(&record.id, "edit").unwrap_err().code,
            "profile_busy"
        );
        assert_eq!(
            windows
                .move_group(MoveWindowsGroupInput {
                    connection_id: snapshot.connection_id.clone(),
                    ids: vec![record.id.clone()],
                    group_id: None,
                })
                .unwrap_err()
                .code,
            "profile_busy"
        );
        for delete_environment in [false, true] {
            assert_eq!(
                windows
                    .delete_window(&record.id, delete_environment)
                    .unwrap_err()
                    .code,
                "profile_busy"
            );
        }
        assert!(
            windows
                .lock_transfer(std::slice::from_ref(&record.id))
                .is_err()
        );
        assert_eq!(windows.store.get(&record.id).unwrap(), record);
    }

    #[test]
    fn coordinator_startup_guards_both_interrupted_and_quiesced_retained_owners() {
        let (temp, store) = fixture();
        let server = MockServer::new(vec![]);
        let previous = windows(temp.path());
        let connection = connection(temp.path(), &server.endpoint);
        let mut retained = Vec::new();
        for (member, quiesced) in [("42", false), ("43", true)] {
            let snapshot = window_snapshot(&previous, &connection, member);
            let (batch, job, _) = create(&store, snapshot.clone(), Preset::InspectAccounts);
            let scope = claim(&store, &job).scope.unwrap();
            if quiesced {
                store.interrupt(&job, "provider_isolated").unwrap();
                store.actor_stopped(&job, false).unwrap();
            }
            retained.push((batch, job, snapshot, scope));
        }
        let unclaimed = window_snapshot(&previous, &connection, "44");
        drop(previous);
        let windows = windows(temp.path());
        let (_host, service) = coordinator(temp.path(), &windows);
        assert_eq!(service.store.retained_window_owners().unwrap().len(), 2);
        for (_, job, snapshot, scope) in &retained {
            assert_eq!(service.store.job(job).unwrap().state, "review_required");
            assert!(
                service
                    .store
                    .validate_lease(scope, "fixture-generation")
                    .is_err()
            );
            assert_manual_mutations_blocked(&windows, snapshot);
            assert_eq!(
                windows
                    .acquire_agent_window(&snapshot.window_id, "another-job")
                    .unwrap_err()
                    .code,
                "profile_busy"
            );
        }
        windows
            .update_note(&unclaimed.window_id, "unreserved")
            .unwrap();
        for (batch, _, snapshot, _) in retained {
            service
                .control(ControlInput {
                    batch_id: batch,
                    action: ControlAction::Cancel,
                })
                .unwrap();
            windows
                .update_note(&snapshot.window_id, "released")
                .unwrap();
        }
        assert!(service.store.retained_window_owners().unwrap().is_empty());
        assert!(server.requests().is_empty());
    }

    #[test]
    fn pending_lifecycle_recovery_keeps_the_restored_owner_when_cancellation_fails() {
        let (temp, store) = fixture();
        let server = MockServer::new(vec![]);
        let previous = windows(temp.path());
        let connection = connection(temp.path(), &server.endpoint);
        let snapshot = window_snapshot(&previous, &connection, "42");
        let (batch, job, _) = create(&store, snapshot.clone(), Preset::InspectAccounts);
        claim(&store, &job);
        let operations = OperationStore::new(temp.path().join("nexus.sqlite"));
        let mut operation = operations
            .prepare(
                &id(),
                &snapshot.window_id,
                &connection.id,
                "start",
                json!({"record":previous.store.get(&snapshot.window_id).unwrap()}),
            )
            .unwrap();
        operations
            .phase(&mut operation, "uncertain", Some("Unknown result".into()))
            .unwrap();
        let saved_operation = serde_json::to_value(&operation).unwrap();
        drop(previous);
        let windows = windows(temp.path());
        let (_host, service) = coordinator(temp.path(), &windows);
        assert_manual_mutations_blocked(&windows, &snapshot);
        assert!(operations.window_pending(&snapshot.window_id).unwrap());
        let error = service
            .control(ControlInput {
                batch_id: batch.clone(),
                action: ControlAction::Cancel,
            })
            .expect_err("pending lifecycle operations must prevent cancellation");
        assert_eq!(error.code, "UNAVAILABLE");
        assert_manual_mutations_blocked(&windows, &snapshot);
        assert_eq!(
            service.store.retained_window_owners().unwrap(),
            vec![(snapshot.window_id.clone(), job.clone())]
        );
        let error = service
            .job_control(&job, ControlAction::Cancel)
            .expect_err("job cancellation must also report failed isolation");
        assert_eq!(error.code, "UNAVAILABLE");
        assert_eq!(service.store.batch_control(&batch).unwrap(), "cancel");
        assert_eq!(service.store.job(&job).unwrap().state, "review_required");
        assert_manual_mutations_blocked(&windows, &snapshot);
        assert_eq!(
            service.store.retained_window_owners().unwrap(),
            vec![(snapshot.window_id, job)]
        );
        assert_eq!(
            serde_json::to_value(operations.get(&operation.id).unwrap().unwrap()).unwrap(),
            saved_operation
        );
        assert!(server.requests().is_empty());
    }

    #[test]
    fn cancellation_persistence_failures_keep_ownership_across_restart_until_retry_succeeds() {
        for trigger in [
            "CREATE TRIGGER fixture_fail_control BEFORE UPDATE OF actor_owned ON agent_jobs
             WHEN NEW.actor_owned=0 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
            "CREATE TRIGGER fixture_fail_control BEFORE INSERT ON agent_events
             WHEN NEW.kind='job.stopped' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
            "CREATE TRIGGER fixture_fail_control BEFORE DELETE ON agent_resources
             BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
        ] {
            let (temp, store) = fixture();
            let server = MockServer::new(vec![]);
            let previous = windows(temp.path());
            let connection = connection(temp.path(), &server.endpoint);
            let snapshot = window_snapshot(&previous, &connection, "42");
            let (batch, job, _) = create(&store, snapshot.clone(), Preset::InspectAccounts);
            claim(&store, &job);
            drop(previous);
            let restored_windows = windows(temp.path());
            let (host, service) = coordinator(temp.path(), &restored_windows);
            let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
            db.execute_batch(trigger).unwrap();

            let requested_at = super::super::now_ms();
            let error = service
                .control(ControlInput {
                    batch_id: batch.clone(),
                    action: ControlAction::Cancel,
                })
                .expect_err("cancellation persistence failures must reach the caller");
            assert_eq!(error.code, "UNAVAILABLE");
            assert_eq!(service.store.batch_control(&batch).unwrap(), "cancel");
            assert_manual_mutations_blocked(&restored_windows, &snapshot);
            assert_eq!(
                service.store.retained_window_owners().unwrap(),
                vec![(snapshot.window_id.clone(), job.clone())]
            );
            let retry_at: i64 = db
                .query_row(
                    "SELECT control_retry_at FROM agent_dispatch WHERE job_id=?1",
                    [&job],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(retry_at > requested_at);
            db.execute_batch("DROP TRIGGER fixture_fail_control")
                .unwrap();
            drop(db);
            drop(service);
            drop(host);
            drop(restored_windows);

            let reopened_windows = windows(temp.path());
            let (_host, service) = coordinator(temp.path(), &reopened_windows);
            assert_manual_mutations_blocked(&reopened_windows, &snapshot);
            let result = service
                .control(ControlInput {
                    batch_id: batch,
                    action: ControlAction::Cancel,
                })
                .unwrap();
            assert_eq!(result["state"], "cancelled");
            assert_eq!(service.store.job(&job).unwrap().state, "cancelled");
            assert!(service.store.retained_window_owners().unwrap().is_empty());
            reopened_windows
                .update_note(&snapshot.window_id, "released after retry")
                .unwrap();
            assert!(server.requests().is_empty());
        }
    }

    #[test]
    fn control_requests_do_not_settle_unrelated_retained_jobs() {
        for single_job in [false, true] {
            let (temp, store) = fixture();
            let server = MockServer::new(vec![]);
            let previous = windows(temp.path());
            let connection = connection(temp.path(), &server.endpoint);
            let blocked = window_snapshot(&previous, &connection, "42");
            let target = window_snapshot(&previous, &connection, "43");
            let batch = id();
            let job = id();
            let target_job = id();
            let target_batch = if single_job { batch.clone() } else { id() };
            let mut request = input(&blocked, Preset::InspectAccounts);
            let mut snapshots = vec![(job.clone(), blocked.clone())];
            if single_job {
                request
                    .assignments
                    .extend(input(&target, Preset::InspectAccounts).assignments);
                snapshots.push((target_job.clone(), target.clone()));
            }
            store
                .create(&batch, &request, &snapshots, &settings())
                .unwrap();
            if !single_job {
                store
                    .create(
                        &target_batch,
                        &input(&target, Preset::InspectAccounts),
                        &[(target_job.clone(), target.clone())],
                        &settings(),
                    )
                    .unwrap();
            }
            claim(&store, &job);
            claim(&store, &target_job);
            store.control_job(&job, ControlAction::Cancel).unwrap();
            let operations = OperationStore::new(temp.path().join("nexus.sqlite"));
            operations
                .prepare(
                    &id(),
                    &blocked.window_id,
                    &connection.id,
                    "start",
                    json!({"record":previous.store.get(&blocked.window_id).unwrap()}),
                )
                .unwrap();
            drop(previous);
            let windows = windows(temp.path());
            let (_host, service) = coordinator(temp.path(), &windows);
            if single_job {
                service
                    .job_control(&target_job, ControlAction::Cancel)
                    .unwrap();
            } else {
                service
                    .control(ControlInput {
                        batch_id: target_batch,
                        action: ControlAction::Cancel,
                    })
                    .unwrap();
            }
            assert_eq!(service.store.job(&target_job).unwrap().state, "cancelled");
            windows.update_note(&target.window_id, "released").unwrap();
            assert_manual_mutations_blocked(&windows, &blocked);
            assert_eq!(
                service.store.retained_window_owners().unwrap(),
                vec![(blocked.window_id, job.clone())]
            );
            assert!(service.store.stopped_control_jobs().unwrap().contains(&job));
            assert!(server.requests().is_empty());
        }
    }

    #[test]
    fn scope_reconfirmation_after_restart_preserves_retained_window_guards() {
        let (temp, store) = fixture();
        let server = MockServer::new(
            (0..2)
                .flat_map(|_| {
                    [
                        MockResponse::json(json!({"code":0})),
                        MockResponse::json(json!({"code":0,"data":{"list":[]}})),
                    ]
                })
                .collect(),
        );
        let previous = windows(temp.path());
        let connection = connection(temp.path(), &server.endpoint);
        let snapshot = window_snapshot(&previous, &connection, "42");
        let (_, job, _) = create(&store, snapshot.clone(), Preset::InspectAccounts);
        claim(&store, &job);
        drop(previous);
        let windows = windows(temp.path());
        let (_host, _service) = coordinator(temp.path(), &windows);
        assert_eq!(
            windows
                .confirm_connection(&connection.id, "Another scope")
                .map(|_| ())
                .expect_err("reconfirming a different scope must be rejected")
                .code,
            "scope_mismatch"
        );
        let confirmed = windows
            .confirm_connection(&connection.id, "Fixture scope")
            .unwrap();
        assert!(confirmed.connection.scope_confirmed);
        assert_eq!(confirmed.connection.revision, connection.revision);
        assert_eq!(confirmed.connection.endpoint, connection.endpoint);
        assert_manual_mutations_blocked(&windows, &snapshot);
        assert_eq!(
            windows
                .activate_connection(&connection.id)
                .map(|_| ())
                .expect_err("activating a retained connection must be rejected")
                .code,
            "profile_busy"
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        for request in requests.chunks_exact(2) {
            assert_eq!(request[0].method, "GET");
            assert_eq!(request[0].target, "/status");
            assert_eq!(request[1].method, "POST");
            assert_eq!(request[1].target, "/api/v2/browser-profile/list");
        }
    }
}

#[test]
fn reconcile_suspends_dispatch_before_old_ownership_is_isolated() {
    let (_temp, store) = fixture();
    let (batch, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    store.begin_reconcile(&batch).unwrap();
    assert_eq!(store.batch_control(&batch).unwrap(), "pause");
    assert!(store.claim(&job, "fixture-generation").unwrap().is_none());
    assert!(store.queued().unwrap().is_empty());
}

#[test]
fn concurrent_batch_creation_cannot_assign_the_same_product_twice() {
    let (_temp, store) = fixture();
    let assigned = product();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut threads = Vec::new();
    for member in ["42", "43"] {
        let mut snap = snapshot();
        let mut frozen = assigned.clone();
        frozen["images"][0]["artifactId"] = json!(id());
        snap.products = vec![frozen];
        snap.account["platformUserId"] = json!(member);
        snap.account["homepageUrl"] =
            json!(format!("https://www.vinted.com/member/{member}-fixture"));
        let store = store.clone();
        let barrier = Arc::clone(&barrier);
        threads.push(std::thread::spawn(move || {
            let draft = input(&snap, Preset::PostListing);
            barrier.wait();
            store.create(&id(), &draft, &[(id(), snap)], &settings())
        }));
    }
    barrier.wait();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result.as_ref().is_err_and(|error| error.code == "CONFLICT"))
            .count(),
        1
    );
    assert_eq!(
        store
            .list(&PageInput {
                page: 1,
                page_size: 20
            })
            .unwrap()["total"],
        1
    );
}

#[test]
fn skipped_products_without_intent_can_be_reassigned_after_the_actor_stops() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap.clone(), Preset::PostListing);
    let claimed = claim(&store, &job);
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Skipped),
        )
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    snap.products[0]["images"][0]["artifactId"] = json!(id());
    let draft = input(&snap, Preset::PostListing);
    assert!(
        store
            .create(&id(), &draft, &[(id(), snap)], &settings())
            .is_ok()
    );
}

#[test]
fn failed_products_without_external_intent_can_be_reassigned_after_isolation() {
    let (temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap.clone(), Preset::PostListing);
    claim(&store, &job);
    let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
    db.execute(
        "UPDATE agent_jobs SET state='failed',phase='preflight_failed' WHERE id=?1",
        [&job],
    )
    .unwrap();
    let draft = input(&snap, Preset::PostListing);
    assert!(
        store
            .create(&id(), &draft, &[(id(), snap.clone())], &settings())
            .is_err()
    );
    store.actor_stopped(&job, true).unwrap();
    snap.products[0]["images"][0]["artifactId"] = json!(id());
    assert!(
        store
            .create(&id(), &draft, &[(id(), snap)], &settings())
            .is_ok()
    );
}

#[test]
fn retained_resource_locks_exclude_products_even_after_a_terminal_actor_quiesces() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap.clone(), Preset::PostListing);
    let claimed = claim(&store, &job);
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Skipped),
        )
        .unwrap();
    store.actor_stopped(&job, false).unwrap();
    snap.products[0]["images"][0]["artifactId"] = json!(id());
    let draft = input(&snap, Preset::PostListing);
    assert_eq!(
        store
            .create(&id(), &draft, &[(id(), snap.clone())], &settings())
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    store.actor_stopped(&job, true).unwrap();
    assert!(
        store
            .create(&id(), &draft, &[(id(), snap)], &settings())
            .is_ok()
    );
}

#[test]
fn confirmed_local_products_cannot_be_reassigned_even_before_outbox_sync() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap.clone(), Preset::PostListing);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.as_ref().unwrap();
    let operation = listing_operation(&claimed, 0);
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "listing",
            &"d".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(scope, "fixture-generation", &operation)
        .unwrap();
    let result = listing_result(&claimed, 0);
    let publication = validate_confirmation(&claimed, &operation, &result)
        .unwrap()
        .unwrap();
    store
        .action_confirm(
            scope,
            "fixture-generation",
            &operation,
            &result,
            Some(&publication),
        )
        .unwrap();
    store
        .mark_step(scope, "fixture-generation", &output(StepState::Completed))
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    assert_eq!(store.due_outbox().unwrap().len(), 1);
    snap.products[0]["images"][0]["artifactId"] = json!(id());
    let draft = input(&snap, Preset::PostListing);
    assert_eq!(
        store
            .create(&id(), &draft, &[(id(), snap.clone())], &settings())
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    store.outbox_result(&operation, None).unwrap();
    let resumed = claim(&store, &job);
    store
        .mark_step(
            resumed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    assert_eq!(store.job(&job).unwrap().state, "completed");
    assert_eq!(
        store
            .create(&id(), &draft, &[(id(), snap)], &settings())
            .unwrap_err()
            .code,
        "CONFLICT"
    );
}

#[test]
fn expiration_cannot_free_an_actor_or_reassign_its_resources() {
    let (temp, store) = fixture();
    let snap = snapshot();
    let (_, job1, _) = create(&store, snap.clone(), Preset::InspectAccounts);
    let (_, job2, _) = create(&store, snap, Preset::InspectAccounts);
    let claimed = claim(&store, &job1);
    let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
    db.execute("UPDATE agent_jobs SET lease_until=0 WHERE id=?1", [&job1])
        .unwrap();
    assert!(
        store
            .validate_lease(claimed.scope.as_ref().unwrap(), "fixture-generation")
            .is_err()
    );
    assert!(store.claim(&job2, "another-generation").unwrap().is_none());
    assert!(store.actor_stopped(&job1, true).is_err());
    store.interrupt(&job1, "fixture_timeout").unwrap();
    assert_eq!(store.job(&job1).unwrap().state, "review_required");
    assert!(store.claim(&job2, "another-generation").unwrap().is_none());
}

#[test]
fn prepared_actions_are_single_submission_and_restart_keeps_unknown_locked() {
    let (temp, store) = fixture();
    let mut snap = snapshot();
    snap.messages.push(Message {
        conversation_id: "123".into(),
        text: "Is this still available?".into(),
    });
    let (batch, job, _) = create(&store, snap, Preset::Message);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.unwrap();
    let operation = id();
    let digest = "b".repeat(64);
    assert_eq!(
        store
            .action_prepare(&scope, "fixture-generation", &operation, "message", &digest)
            .unwrap(),
        json!({"state":"prepared","fresh":true})
    );
    assert_eq!(
        store
            .action_prepare(&scope, "fixture-generation", &operation, "message", &digest)
            .unwrap()["fresh"],
        false
    );
    assert!(
        store
            .action_prepare(
                &scope,
                "fixture-generation",
                &operation,
                "message",
                &"c".repeat(64)
            )
            .is_err()
    );
    store
        .action_submitting(&scope, "fixture-generation", &operation)
        .unwrap();
    assert!(
        store
            .action_submitting(&scope, "fixture-generation", &operation)
            .is_err()
    );
    assert_eq!(
        store.action_get(&scope, &operation).unwrap()["state"],
        "unknown"
    );
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    reopened.recover().unwrap();
    assert_eq!(reopened.job(&job).unwrap().state, "result_unknown");
    reopened
        .control(&ControlInput {
            batch_id: batch.clone(),
            action: ControlAction::Resume,
        })
        .unwrap();
    assert_eq!(reopened.job(&job).unwrap().state, "result_unknown");
    assert!(
        reopened
            .validate_lease(&scope, "fixture-generation")
            .is_err()
    );
    assert!(reopened.actor_stopped(&job, true).is_err());
    // Simulate the provider's successful isolation receipt, then explicit reconciliation.
    reopened.actor_stopped(&job, false).unwrap();
    assert_eq!(
        reopened.retained_window_owners().unwrap(),
        vec![(scope.window_id.clone(), job.clone())]
    );
    reopened
        .control(&ControlInput {
            batch_id: batch,
            action: ControlAction::Reconcile,
        })
        .unwrap();
    let reconciled = reopened
        .claim(&job, "replacement-generation")
        .unwrap()
        .unwrap();
    let next = reconciled.scope.unwrap();
    assert!(next.fence > scope.fence);
    assert_ne!(next.lease_id, scope.lease_id);
    assert!(
        reopened
            .action_submitting(&next, "replacement-generation", &operation)
            .is_err()
    );
    assert_eq!(
        reopened
            .action_prepare(
                &next,
                "replacement-generation",
                &operation,
                "message",
                &digest
            )
            .unwrap()["state"],
        "unknown"
    );
}

#[test]
fn confirmed_listing_and_outbox_are_atomic_and_sync_never_finishes_remaining_products() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product(), product()];
    let (batch, job, _) = create(&store, snap, Preset::PostListing);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.as_ref().unwrap();
    let operation = listing_operation(&claimed, 0);
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "listing",
            &"d".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(scope, "fixture-generation", &operation)
        .unwrap();
    let result = listing_result(&claimed, 0);
    let publication = validate_confirmation(&claimed, &operation, &result)
        .unwrap()
        .unwrap();
    store
        .action_confirm(
            scope,
            "fixture-generation",
            &operation,
            &result,
            Some(&publication),
        )
        .unwrap();
    assert_eq!(
        store.action_get(scope, &operation).unwrap()["state"],
        "confirmed"
    );
    assert_eq!(store.due_outbox().unwrap().len(), 1);
    assert_eq!(
        store.require_publication(scope, &publication).unwrap(),
        operation
    );
    let mut forged = publication.clone();
    forged["productId"] = json!(id());
    assert!(store.require_publication(scope, &forged).is_err());
    let mut changed = result.clone();
    changed["listingId"] = json!("999");
    assert!(
        store
            .action_confirm(
                scope,
                "fixture-generation",
                &operation,
                &changed,
                Some(&publication)
            )
            .is_err()
    );
    store
        .mark_step(scope, "fixture-generation", &output(StepState::SyncPending))
        .unwrap();
    assert_eq!(store.job(&job).unwrap().state, "sync_pending");
    store.actor_stopped(&job, true).unwrap();
    store.outbox_result(&operation, None).unwrap();
    store
        .outbox_result(&operation, Some(("CONFLICT", false)))
        .unwrap();
    assert!(store.due_outbox().unwrap().is_empty());
    assert_eq!(store.job(&job).unwrap().state, "queued");
    assert_ne!(store.batch_view(&batch).unwrap()["state"], "completed");
}

#[test]
fn artifact_chunks_match_the_strict_workflow_wire_shape_and_reject_tampering() {
    use sha2::{Digest, Sha256};
    let temp = tempfile::tempdir().unwrap();
    let artifacts = Artifacts::new(temp.path().join("artifacts")).unwrap();
    let batch = id();
    let artifact = id();
    artifacts.begin(&batch).unwrap();
    let bytes = b"\x89PNG\r\n\x1a\n";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = temp
        .path()
        .join("artifacts")
        .join(&batch)
        .join(format!("{artifact}.png"));
    std::fs::write(&path, bytes).unwrap();
    artifacts.seal(&batch).unwrap();
    let chunk = artifacts
        .read(
            &batch,
            &artifact,
            ("image/png", bytes.len() as u64, &digest),
            0,
            192 * 1024,
        )
        .unwrap();
    assert_eq!(chunk.as_object().unwrap().len(), 4);
    assert_eq!(chunk["data"], "iVBORw0KGgo=");
    assert_eq!(chunk["total"], 8);
    assert_eq!(chunk["next"], 8);
    assert_eq!(chunk["done"], true);
    std::fs::write(path, b"tampered").unwrap();
    assert!(
        artifacts
            .resolve(&batch, &artifact, "image/png", bytes.len() as u64, &digest)
            .is_err()
    );
}

#[test]
fn cancellation_preserves_unknown_writes_and_their_resource_locks() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.messages.push(Message {
        conversation_id: "123".into(),
        text: "Fixture message".into(),
    });
    let (batch, job, _) = create(&store, snap, Preset::Message);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.unwrap();
    let operation = id();
    store
        .action_prepare(
            &scope,
            "fixture-generation",
            &operation,
            "message",
            &"e".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(&scope, "fixture-generation", &operation)
        .unwrap();
    store
        .control(&ControlInput {
            batch_id: batch.clone(),
            action: ControlAction::Cancel,
        })
        .unwrap();
    store.settle_control(&job, true).unwrap();
    assert_eq!(store.job(&job).unwrap().state, "result_unknown");
    assert!(store.actor_stopped(&job, true).is_err());
    assert_eq!(
        store.batch_view(&batch).unwrap()["state"],
        "needs_attention"
    );
}

#[test]
fn cancellation_after_provider_isolation_releases_safe_review_resources() {
    let (_temp, store) = fixture();
    let snap = snapshot();
    let (batch, job, _) = create(&store, snap.clone(), Preset::InspectAccounts);
    claim(&store, &job);
    store
        .interrupt(&job, "fixture_interruption_before_intent")
        .unwrap();
    store
        .control(&ControlInput {
            batch_id: batch,
            action: ControlAction::Cancel,
        })
        .unwrap();
    // Only a successful provider isolation permits the service to settle and release.
    store.settle_control(&job, true).unwrap();
    store.actor_stopped(&job, true).unwrap();
    assert_eq!(store.job(&job).unwrap().state, "cancelled");
    let (_, replacement, _) = create(&store, snap, Preset::InspectAccounts);
    assert!(
        store
            .claim(&replacement, "new-generation")
            .unwrap()
            .is_some()
    );
}

#[test]
fn checkpoints_roundtrip_full_tuples_writes_order_versions_and_scope() {
    let (_temp, store) = fixture();
    let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.unwrap();
    let put = json!({"threadId":job,"checkpointNs":"","checkpoint":{"v":4,"id":"0001",
        "channel_values":{"state":{"phase":"inspect","nested":[1,{"ok":true}]}},
        "channel_versions":{"state":"v1"},"versions_seen":{"node":{"state":"v0"}},"pending_sends":[["task",{"value":1}]]},
        "metadata":{"source":"loop","step":1,"parents":{}},
        "parentConfig":{"configurable":{"thread_id":job,"checkpoint_ns":""}},
        "newVersions":{"state":"v1"}});
    for private in [
        settings(),
        json!({"reason":"prefix fixture-private-decision suffix"}),
        json!({"value":"data:image/png;base64,iVBORw0KGgo="}),
    ] {
        let mut invalid = put.clone();
        invalid["checkpoint"]["channel_values"]["private"] = private;
        assert!(
            store
                .checkpoint(
                    &scope,
                    "fixture-generation",
                    "agent.checkpoint.put",
                    &invalid
                )
                .is_err()
        );
    }
    let config = store
        .checkpoint(&scope, "fixture-generation", "agent.checkpoint.put", &put)
        .unwrap();
    assert_eq!(
        config,
        json!({"configurable":{"thread_id":job,"checkpoint_ns":"","checkpoint_id":"0001"}})
    );
    for (task, path, value) in [("a-task", "z-path", 1), ("z-task", "a-path", 2)] {
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.putWrites",
                &json!({"threadId":job,"checkpointNs":"","checkpointId":"0001",
                "taskId":task,"taskPath":path,"writes":[["state",{"value":value}]]}),
            )
            .unwrap();
    }
    let tuple = store
        .checkpoint(
            &scope,
            "fixture-generation",
            "agent.checkpoint.get",
            &json!({"threadId":job,"checkpointNs":""}),
        )
        .unwrap();
    assert_eq!(tuple["checkpoint"], put["checkpoint"]);
    assert_eq!(tuple["metadata"], put["metadata"]);
    assert!(tuple.get("parentConfig").is_none());
    assert_eq!(
        tuple["pendingWrites"][0],
        json!(["z-task","state",{"value":2}])
    );
    assert_eq!(
        tuple["pendingWrites"][1],
        json!(["a-task","state",{"value":1}])
    );
    let mut next = put.clone();
    next["checkpoint"]["id"] = json!("0002");
    next["parentConfig"] = config;
    store
        .checkpoint(&scope, "fixture-generation", "agent.checkpoint.put", &next)
        .unwrap();
    let page=store.checkpoint(&scope,"fixture-generation","agent.checkpoint.list",
        &json!({"threadId":job,"checkpointNs":"","limit":50,
            "before":{"configurable":{"thread_id":job,"checkpoint_ns":"","checkpoint_id":"0002"}},"filter":{"step":1}})).unwrap();
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["checkpoint"]["id"], "0001");
    let mut conflict = next.clone();
    conflict["checkpoint"]["channel_values"] = json!({"altered":true});
    assert!(
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.put",
                &conflict
            )
            .is_err()
    );
    assert!(
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.get",
                &json!({"threadId":id(),"checkpointNs":""})
            )
            .is_err()
    );
    assert!(
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.get",
                &json!({"threadId":job,"checkpointNs":"other"})
            )
            .is_err()
    );
    store
        .checkpoint(
            &scope,
            "fixture-generation",
            "agent.checkpoint.delete",
            &json!({"threadId":job}),
        )
        .unwrap();
    assert!(
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.get",
                &json!({"threadId":job,"checkpointNs":""})
            )
            .unwrap()
            .is_null()
    );
}

mod checkpoint_history {
    use super::*;
    use rusqlite::{Connection, params};

    fn checkpoint_id(step: usize) -> String {
        format!("{step:06}")
    }

    fn put_payload(job: &str, step: usize, state: &Value) -> Value {
        let mut payload = json!({"threadId":job,"checkpointNs":"",
            "checkpoint":{"v":4,"id":checkpoint_id(step),"channel_values":{"value":state},
                "channel_versions":{"value":step},"versions_seen":{"step":{"value":step-1}}},
            "metadata":{"source":"loop","step":step,"parents":{}},"newVersions":{"value":step}});
        if step > 1 {
            payload["parentConfig"] = json!({"configurable":{"thread_id":job,
                "checkpoint_ns":"","checkpoint_id":checkpoint_id(step-1)}});
        }
        payload
    }

    fn put(store: &AgentStore, scope: &AgentScope, step: usize, state: &Value) {
        store
            .checkpoint(
                scope,
                "fixture-generation",
                "agent.checkpoint.put",
                &put_payload(&scope.job_id, step, state),
            )
            .unwrap();
    }

    fn writes_payload(job: &str, step: usize, task: &str, state: &Value) -> Value {
        json!({"threadId":job,"checkpointNs":"","checkpointId":checkpoint_id(step),
            "taskId":task,"taskPath":"step/0","writes":[["value",state]]})
    }

    fn writes(store: &AgentStore, scope: &AgentScope, step: usize, state: &Value) {
        store
            .checkpoint(
                scope,
                "fixture-generation",
                "agent.checkpoint.putWrites",
                &writes_payload(&scope.job_id, step, "step-task", state),
            )
            .unwrap();
    }

    fn get(store: &AgentStore, scope: &AgentScope, step: Option<usize>) -> Value {
        let mut payload = json!({"threadId":scope.job_id,"checkpointNs":""});
        if let Some(step) = step {
            payload["checkpointId"] = json!(checkpoint_id(step));
        }
        store
            .checkpoint(
                scope,
                "fixture-generation",
                "agent.checkpoint.get",
                &payload,
            )
            .unwrap()
    }

    fn usage(db: &Connection, job: &str) -> (u64, u64, u64, u64) {
        db.query_row(
            "SELECT
             (SELECT COUNT(*) FROM agent_checkpoints WHERE job_id=?1),
             (SELECT COALESCE(SUM(length(CAST(tuple_json AS BLOB))+length(CAST(new_versions_json AS BLOB))),0)
                FROM agent_checkpoints WHERE job_id=?1),
             (SELECT COUNT(*) FROM agent_pending_writes WHERE job_id=?1),
             (SELECT COALESCE(SUM(length(CAST(value_json AS BLOB))),0) FROM agent_pending_writes WHERE job_id=?1)",
            [job],
            |r| Ok((read_u64(r, 0)?, read_u64(r, 1)?, read_u64(r, 2)?, read_u64(r, 3)?)),
        ).unwrap()
    }

    // Fixture for databases written before consumed-history compaction existed.
    fn legacy_history(db: &mut Connection, job: &str, count: usize, state: &Value) {
        let tx = db.transaction().unwrap();
        for step in 1..=count {
            let payload = put_payload(job, step, state);
            let mut tuple = json!({"config":{"configurable":{"thread_id":job,"checkpoint_ns":"",
                "checkpoint_id":checkpoint_id(step)}},"checkpoint":payload["checkpoint"],
                "metadata":payload["metadata"],"pendingWrites":[]});
            if step > 1 {
                tuple["parentConfig"] = payload["parentConfig"].clone();
            }
            tx.execute(
                "INSERT INTO agent_checkpoints(job_id,namespace,checkpoint_id,tuple_json,new_versions_json)
                 VALUES(?1,'',?2,?3,?4)",
                params![job, checkpoint_id(step), tuple.to_string(), payload["newVersions"].to_string()],
            ).unwrap();
            tx.execute(
                "INSERT INTO agent_pending_writes(job_id,namespace,checkpoint_id,task_id,write_index,channel,value_json,task_path)
                 VALUES(?1,'',?2,'step-task',0,'value',?3,'step/0')",
                params![job, checkpoint_id(step), state.to_string()],
            ).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn full_state_history_stays_bounded_for_100_products_and_resumes_after_restart() {
        let (temp, store) = fixture();
        let mut snap = snapshot();
        snap.products = (0..100).map(|_| product()).collect();
        let (batch, job) = (id(), id());
        let input = input(&snap, Preset::PostListing);
        let mut configuration = settings();
        configuration["maxStepsPerItem"] = json!(60);
        store
            .create(&batch, &input, &[(job.clone(), snap)], &configuration)
            .unwrap();
        let claimed = claim(&store, &job);
        let scope = claimed.scope.as_ref().unwrap();
        let operation = listing_operation(&claimed, 0);
        store
            .action_prepare(
                scope,
                "fixture-generation",
                &operation,
                "listing",
                &"a".repeat(64),
            )
            .unwrap();
        store
            .action_submitting(scope, "fixture-generation", &operation)
            .unwrap();
        let result = listing_result(&claimed, 0);
        let publication = validate_confirmation(&claimed, &operation, &result)
            .unwrap()
            .unwrap();
        store
            .action_confirm(
                scope,
                "fixture-generation",
                &operation,
                &result,
                Some(&publication),
            )
            .unwrap();
        let mut state = json!({"phase":"prepare","index":0,"steps":0,
            "description":"d".repeat(6000),"profileEvidence":{"text":"e".repeat(4096)},
            "listingBaseline":{"url":"https://www.vinted.com/member/42",
                "listingIds":["91826"],"observedAt":"2026-11-13T01:02:03.004Z"},
            "messageBaseline":{"conversationId":"123","messageIds":["456"],
                "observedAt":"2026-11-13T01:02:03.004Z"},
            "intentStartedAt":"2026-11-13T01:02:04.004Z","operationId":operation});
        let nodes = 100 * 59;
        let mut written_bytes = 0usize;
        for step in 1..=nodes {
            if step % 10 == 0 {
                store.heartbeat(scope, "fixture-generation").unwrap();
            }
            state["index"] = json!((step - 1) / 59);
            state["steps"] = json!((step - 1) % 59);
            put(&store, scope, step, &state);
            writes(&store, scope, step, &state);
            written_bytes += state.to_string().len();
        }
        assert!(written_bytes > 32 * 1024 * 1024);
        let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
        let (checkpoints, checkpoint_bytes, pending, pending_bytes) = usage(&db, &job);
        assert_eq!((checkpoints, pending), (8, 8));
        assert!(checkpoint_bytes + pending_bytes < 2 * 1024 * 1024);
        assert!(get(&store, scope, Some(1)).is_null());
        for step in nodes - 7..=nodes {
            let tuple = get(&store, scope, Some(step));
            assert_eq!(tuple["checkpoint"]["id"], checkpoint_id(step));
            assert_eq!(tuple["checkpoint"]["channel_versions"]["value"], step);
            assert_eq!(tuple["metadata"]["step"], step);
            assert_eq!(tuple["pendingWrites"].as_array().unwrap().len(), 1);
            assert_eq!(tuple["pendingWrites"][0][2]["steps"], (step - 1) % 59);
        }
        let expected = get(&store, scope, None);
        assert_eq!(expected["checkpoint"]["channel_values"]["value"], state);
        assert_eq!(
            expected["pendingWrites"],
            json!([["step-task", "value", state]])
        );

        let uncertain = listing_operation(&claimed, 1);
        store
            .action_prepare(
                scope,
                "fixture-generation",
                &uncertain,
                "listing",
                &"b".repeat(64),
            )
            .unwrap();
        store
            .action_submitting(scope, "fixture-generation", &uncertain)
            .unwrap();
        drop(db);
        drop(store);
        let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
        store.recover().unwrap();
        store.actor_stopped(&job, false).unwrap();
        store
            .control(&ControlInput {
                batch_id: batch,
                action: ControlAction::Reconcile,
            })
            .unwrap();
        let resumed = claim(&store, &job);
        assert!(resumed.reconcile_only);
        let resumed_scope = resumed.scope.as_ref().unwrap();
        assert!(resumed_scope.fence > scope.fence);
        assert_eq!(get(&store, resumed_scope, None), expected);
        assert_eq!(
            store.action_get(resumed_scope, &operation).unwrap()["result"],
            result
        );
        assert_eq!(
            store.action_get(resumed_scope, &uncertain).unwrap()["state"],
            "unknown"
        );
        let outbox = store.due_outbox().unwrap();
        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0].payload, publication);
        assert!(
            store
                .action_submitting(resumed_scope, "fixture-generation", &uncertain)
                .is_err()
        );
        put(&store, resumed_scope, nodes + 1, &state);
        writes(&store, resumed_scope, nodes + 1, &state);
        let latest = get(&store, resumed_scope, None);
        assert_eq!(latest["checkpoint"]["id"], checkpoint_id(nodes + 1));
        assert_eq!(
            latest["parentConfig"]["configurable"]["checkpoint_id"],
            checkpoint_id(nodes)
        );
        assert_eq!(
            latest["checkpoint"]["channel_values"]["value"]["listingBaseline"],
            state["listingBaseline"]
        );
        assert_eq!(
            latest["pendingWrites"][0][2]["messageBaseline"],
            state["messageBaseline"]
        );
    }

    #[test]
    fn compaction_preserves_unpersisted_and_current_writes_and_rejects_discarded_ids() {
        let (temp, store) = fixture();
        let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
        let scope = claim(&store, &job).scope.unwrap();
        let mut other = snapshot();
        other.account["platformUserId"] = json!("43");
        other.account["homepageUrl"] = json!("https://www.vinted.com/member/43");
        let (_, other_job, _) = create(&store, other, Preset::InspectAccounts);
        let other_scope = claim(&store, &other_job).scope.unwrap();
        put(&store, &other_scope, 1, &json!({"other":true}));
        writes(&store, &other_scope, 1, &json!({"otherPending":true}));
        let other_tuple = get(&store, &other_scope, None);
        let early = json!({"arrived":"before-checkpoint","baseline":["10","11"]});
        writes(&store, &scope, 5, &early);
        writes(&store, &scope, 99, &json!({"future":true}));
        for step in (1..=20).filter(|step| *step != 5) {
            put(&store, &scope, step, &json!({"step":step}));
            writes(&store, &scope, step, &json!({"step":step}));
        }
        let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
        assert_eq!(usage(&db, &job).0, 8);
        let saved: String = db
            .query_row(
                "SELECT value_json FROM agent_pending_writes WHERE job_id=?1 AND checkpoint_id=?2",
                params![job, checkpoint_id(5)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), early);
        assert!(get(&store, &scope, Some(5)).is_null());
        put(&store, &scope, 5, &json!({"late":true}));
        assert_eq!(get(&store, &scope, Some(5))["pendingWrites"][0][2], early);
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.putWrites",
                &writes_payload(&job, 5, "late-task", &json!({"lateWrite":true})),
            )
            .unwrap();
        let current = get(&store, &scope, Some(5));
        assert_eq!(
            current["checkpoint"]["channel_values"]["value"],
            json!({"late":true})
        );
        assert_eq!(
            current["pendingWrites"],
            json!([
                ["late-task","value",{"lateWrite":true}], ["step-task","value",early]
            ])
        );
        assert_eq!(
            get(&store, &scope, None)["checkpoint"]["id"],
            checkpoint_id(20)
        );
        put(&store, &scope, 21, &json!({"step":21}));
        assert!(get(&store, &scope, Some(5)).is_null());
        assert_eq!(usage(&db, &job).2, 8); // Seven retained task writes plus checkpoint 99's early write.
        assert_eq!(get(&store, &other_scope, None), other_tuple);
        drop(db);
        drop(store);
        let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
        for (method, payload) in [
            (
                "agent.checkpoint.put",
                put_payload(&job, 5, &json!({"late":true})),
            ),
            (
                "agent.checkpoint.putWrites",
                writes_payload(&job, 5, "late-task", &early),
            ),
        ] {
            assert_eq!(
                store
                    .checkpoint(&scope, "fixture-generation", method, &payload)
                    .unwrap_err()
                    .code,
                "CONFLICT"
            );
        }
        put(&store, &scope, 99, &json!({"futureCheckpoint":true}));
        assert_eq!(
            get(&store, &scope, None)["pendingWrites"][0][2],
            json!({"future":true})
        );
        store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.delete",
                &json!({"threadId":job}),
            )
            .unwrap();
        put(&store, &scope, 1, &json!({"newThread":true}));
        assert_eq!(
            get(&store, &scope, None)["checkpoint"]["id"],
            checkpoint_id(1)
        );
        assert_eq!(get(&store, &other_scope, None), other_tuple);
    }

    #[test]
    fn both_save_methods_reclaim_legacy_history_before_enforcing_storage_budgets() {
        for method in ["agent.checkpoint.put", "agent.checkpoint.putWrites"] {
            let (temp, store) = fixture();
            let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
            let scope = claim(&store, &job).scope.unwrap();
            let mut db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
            let large =
                json!({"description":"d".repeat(6000),"profileEvidence":"e".repeat(90_000)});
            legacy_history(&mut db, &job, 350, &large);
            assert!(usage(&db, &job).3 > 32 * 1024 * 1024);
            let payload = if method == "agent.checkpoint.put" {
                put_payload(&job, 351, &large)
            } else {
                writes_payload(&job, 350, "new-task", &large)
            };
            store
                .checkpoint(&scope, "fixture-generation", method, &payload)
                .unwrap();
            let (count, _, _, bytes) = usage(&db, &job);
            assert_eq!(count, 8);
            assert!(bytes < 1024 * 1024);
            let latest = get(&store, &scope, None);
            assert_eq!(latest["checkpoint"]["channel_values"]["value"], large);
            if method == "agent.checkpoint.putWrites" {
                assert!(
                    latest["pendingWrites"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|write| write == &json!(["new-task", "value", large]))
                );
            }
        }
    }

    #[test]
    fn unconsumed_utf8_write_budget_failure_rolls_back_save_and_compaction() {
        let (temp, store) = fixture();
        let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
        let scope = claim(&store, &job).scope.unwrap();
        let mut db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
        legacy_history(&mut db, &job, 10, &json!({"baseline":["retained"]}));
        let value = json!("\u{754c}".repeat(32_760));
        let tx = db.transaction().unwrap();
        for step in 1000..1341 {
            tx.execute(
                "INSERT INTO agent_pending_writes(job_id,namespace,checkpoint_id,task_id,write_index,channel,value_json,task_path)
                 VALUES(?1,'',?2,'step-task',0,'value',?3,'step/0')",
                params![job, checkpoint_id(step), value.to_string()],
            ).unwrap();
        }
        tx.commit().unwrap();
        let before_usage = usage(&db, &job);
        assert!(before_usage.3 <= 32 * 1024 * 1024);
        assert!(before_usage.3 + value.to_string().len() as u64 > 32 * 1024 * 1024);
        let before_first = get(&store, &scope, Some(1));
        let before_latest = get(&store, &scope, None);
        let error = store
            .checkpoint(
                &scope,
                "fixture-generation",
                "agent.checkpoint.putWrites",
                &writes_payload(&job, 10, "new-task", &value),
            )
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
        assert_eq!(usage(&db, &job), before_usage);
        assert_eq!(get(&store, &scope, Some(1)), before_first);
        assert_eq!(get(&store, &scope, None), before_latest);
        let boundaries: u64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_checkpoint_retention WHERE job_id=?1",
                [&job],
                |r| read_u64(r, 0),
            )
            .unwrap();
        assert_eq!(boundaries, 0);
    }

    #[test]
    fn failed_compaction_rolls_back_checkpoint_and_write_saves_with_the_pruned_history() {
        for method in ["agent.checkpoint.put", "agent.checkpoint.putWrites"] {
            let (temp, store) = fixture();
            let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
            let scope = claim(&store, &job).scope.unwrap();
            let mut db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
            legacy_history(&mut db, &job, 10, &json!({"baseline":["retained"]}));
            let before: Vec<Value> = (1..=10)
                .map(|step| get(&store, &scope, Some(step)))
                .collect();
            let before_usage = usage(&db, &job);
            db.execute_batch(
                "CREATE TRIGGER fail_compaction BEFORE INSERT ON agent_checkpoint_retention
                 BEGIN SELECT RAISE(ABORT,'fixture compaction failure'); END;",
            )
            .unwrap();
            let payload = if method == "agent.checkpoint.put" {
                put_payload(&job, 11, &json!({"new":true}))
            } else {
                writes_payload(&job, 10, "new-task", &json!({"new":true}))
            };
            assert!(
                store
                    .checkpoint(&scope, "fixture-generation", method, &payload)
                    .is_err()
            );
            assert_eq!(usage(&db, &job), before_usage);
            for (step, expected) in (1..=10).zip(before) {
                assert_eq!(get(&store, &scope, Some(step)), expected);
            }
            assert!(get(&store, &scope, Some(11)).is_null());
            db.execute_batch("DROP TRIGGER fail_compaction").unwrap();
            store
                .checkpoint(&scope, "fixture-generation", method, &payload)
                .unwrap();
            assert_eq!(usage(&db, &job).0, 8);
        }
    }
}

#[test]
fn event_cursors_are_monotonic_and_views_remain_paginated() {
    let (_temp, store) = fixture();
    let (batch, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    let claimed = claim(&store, &job);
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    let first = store
        .events(&EventsInput {
            batch_id: batch.clone(),
            cursor: 0,
            limit: 1,
        })
        .unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["hasMore"], true);
    let cursor = first["cursor"].as_u64().unwrap();
    let rest = store
        .events(&EventsInput {
            batch_id: batch.clone(),
            cursor,
            limit: 100,
        })
        .unwrap();
    assert!(
        rest["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["sequence"].as_u64().unwrap() > cursor)
    );
    let serialized = rest.to_string();
    assert!(!serialized.contains("apiKey") && !serialized.contains("fixture-private"));
    assert_eq!(
        store
            .get(&BatchGetInput {
                batch_id: batch,
                page: 2,
                page_size: 1
            })
            .unwrap()["jobs"],
        json!([])
    );
}

#[test]
fn account_and_confirmation_validation_denies_aliases_credentials_and_unassigned_data() {
    let mut snap = snapshot();
    assert!(validate_account(&snap.account).is_ok());
    for homepage in [
        "http://www.vinted.com/member/42",
        "https://evil.invalid/member/42",
        "https://www.vinted.com.evil.invalid/member/42",
        "https://user:secret@www.vinted.com/member/42",
        "https://www.vinted.com/member/43",
        "https://www.vinted.com/member/not-a-number",
    ] {
        let mut account = snap.account.clone();
        account["homepageUrl"] = json!(homepage);
        assert!(validate_account(&account).is_err());
    }
    snap.products = vec![product()];
    let (_temp, store) = fixture();
    let (_, job, _) = create(&store, snap, Preset::PostListing);
    let job = claim(&store, &job);
    let mut result = listing_result(&job, 0);
    result["windowId"] = json!(id());
    assert!(validate_confirmation(&job, &id(), &result).is_err());
    assert!(
        fields(
            &json!({"files":["/private/secret"]}),
            &["artifactIds", "target"]
        )
        .is_err()
    );
    assert!(validate_settings(&json!({"generation":{"apiKey":"incomplete"}})).is_err());
}

#[test]
fn message_confirmation_requires_platform_message_identity_and_timestamp() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.messages.push(Message {
        conversation_id: "123".into(),
        text: "Fixture message".into(),
    });
    let (_, job, _) = create(&store, snap, Preset::Message);
    let job = claim(&store, &job);
    let scope = job.scope.as_ref().unwrap();
    let operation = id();
    let result = json!({
        "kind":"message","conversationId":"123","text":"Fixture message",
        "confirmedAt":"2026-11-13T01:02:04.000Z",
        "evidence":{"messageId":"91827","sentAt":"2026-11-13T01:02:03.000Z"}
    });
    assert!(
        validate_confirmation(&job, &operation, &result)
            .unwrap()
            .is_none()
    );
    for evidence in [
        Value::Null,
        json!({"messageId":"0","sentAt":"2026-11-13T01:02:03.000Z"}),
        json!({"messageId":"019","sentAt":"2026-11-13T01:02:03.000Z"}),
        json!({"messageId":"-19","sentAt":"2026-11-13T01:02:03.000Z"}),
        json!({"messageId":"9".repeat(33),"sentAt":"2026-11-13T01:02:03.000Z"}),
        json!({"messageId":"19","sentAt":"2026-02-30T01:02:03.000Z"}),
        json!({"messageId":"19","sentAt":"2026-11-13T01:02:03"}),
        json!({"messageId":"19","sentAt":"2026-11-13T01:02:03.000Z","local":true}),
    ] {
        let mut invalid = result.clone();
        invalid["evidence"] = evidence;
        assert!(validate_confirmation(&job, &operation, &invalid).is_err());
    }
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "message",
            &"e".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(scope, "fixture-generation", &operation)
        .unwrap();
    store
        .action_confirm(scope, "fixture-generation", &operation, &result, None)
        .unwrap();
    assert_eq!(
        store.action_get(scope, &operation).unwrap()["result"]["evidence"],
        result["evidence"]
    );
}

// This fixture is a controlled protocol process. It never opens a browser or
// makes network requests; no real plugin installation is modified.
fn gateway_fixture() -> (
    TempDir,
    Arc<PluginHost>,
    Arc<AgentService>,
    PluginCaller,
    AgentScope,
) {
    let (temp, store) = fixture();
    let source = temp.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("package.json"),
        r#"{"name":"agent-fixture","main":"index.cjs"}"#,
    )
    .unwrap();
    std::fs::write(source.join("nexus.plugin.json"),json!({
        "apiVersion":1,"id":"studio.sales-agent","version":"1.0.0","name":"Agent fixture",
        "minCoreVersion":env!("CARGO_PKG_VERSION"),"capabilities":["sales.agent"],
        "permissions":{"networkDomains":[],"wantsBrowserAccess":true,"storage":"private","secrets":[]}
    }).to_string()).unwrap();
    std::fs::write(
        source.join("index.cjs"),
        r#"
const readline=require('node:readline')
const send=value=>process.stdout.write(JSON.stringify(value)+'\n')
send({type:'hello',pluginId:'studio.sales-agent',version:'1.0.0',apiVersion:1})
readline.createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line)
  if(message.type==='handshake')send({type:'ready',pluginId:'studio.sales-agent',
    version:'1.0.0',capabilities:['sales.agent'],methods:['salesAgent.jobs.step']})
}).on('close',()=>process.exit(0))
"#,
    )
    .unwrap();
    let host = Arc::new(PluginHost::open(temp.path().join("host"), vec![]).unwrap());
    host.install(&source).unwrap();
    let caller = host.agent_caller().unwrap();
    let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    let job = store.claim(&job, &caller.generation).unwrap().unwrap();
    let scope = job.scope.unwrap();
    let service = AgentService::gateway_fixture(
        store,
        Artifacts::new(temp.path().join("artifacts")).unwrap(),
        &host,
        &caller,
        &scope,
    );
    service.register_gateway().unwrap();
    (temp, host, service, caller, scope)
}
fn host_request(scope: &AgentScope, method: &str, payload: Value) -> HostRequest {
    HostRequest {
        message_type: "host.request".into(),
        host_version: 1,
        request_id: id(),
        scope: scope.clone(),
        method: method.into(),
        payload,
        deadline_ms: 30_000,
    }
}

#[test]
fn gateway_denies_raw_paths_foreign_scopes_unconfirmed_publications_and_arbitrary_routes() {
    let (_temp, host, service, caller, scope) = gateway_fixture();
    for (method, payload) in [
        (
            "agent.browser.execute",
            json!({"operation":"upload","origin":"https://www.vinted.com","input":{"target":{"index":0},"files":["/etc/passwd"]}}),
        ),
        (
            "agent.plugin.call",
            json!({"pluginId":"studio.products","capability":"product.catalog","method":"products.publications.record","payload":{"operationId":id()}}),
        ),
        (
            "agent.plugin.call",
            json!({"pluginId":"studio.email","capability":"email.provider","method":"email.list","payload":{}}),
        ),
        (
            "agent.artifact.read",
            json!({"artifactId":id(),"offset":0,"length":192*1024}),
        ),
        (
            "agent.checkpoint.get",
            json!({"threadId":id(),"checkpointNs":""}),
        ),
    ] {
        assert!(
            service
                .handle_host(caller.clone(), host_request(&scope, method, payload))
                .is_err()
        );
    }
    let mut foreign = scope.clone();
    foreign.window_id = id();
    assert!(
        service
            .handle_host(
                caller.clone(),
                host_request(&foreign, "agent.action.get", json!({"operationId":id()}))
            )
            .is_err()
    );
    let mut foreign = scope.clone();
    foreign.fence += 1;
    assert!(
        service
            .handle_host(
                caller.clone(),
                host_request(&foreign, "agent.action.get", json!({"operationId":id()}))
            )
            .is_err()
    );
    let mut forged = caller.clone();
    forged.generation = id();
    assert!(
        service
            .handle_host(
                forged,
                host_request(&scope, "agent.action.get", json!({"operationId":id()}))
            )
            .is_err()
    );
    host.shutdown();
}

#[test]
fn late_plugin_generation_cannot_write_a_checkpoint_after_reinstallation() {
    let (temp, host, service, caller, scope) = gateway_fixture();
    host.install(&temp.path().join("source")).unwrap();
    let new_caller = host.agent_caller().unwrap();
    assert_ne!(new_caller.generation, caller.generation);
    let error=service.handle_host(caller,host_request(&scope,"agent.checkpoint.put",
        json!({"threadId":scope.job_id,"checkpointNs":"","checkpoint":{"v":1,"id":"late","channel_values":{}},
            "metadata":{},"newVersions":{}}))).unwrap_err();
    assert_eq!(error.code, "PERMISSION_DENIED");
    host.shutdown();
}

#[test]
fn failed_sql_commit_does_not_create_a_confirmed_action_without_its_outbox() {
    let (temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap, Preset::PostListing);
    let job = claim(&store, &job);
    let scope = job.scope.as_ref().unwrap();
    let operation = listing_operation(&job, 0);
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "listing",
            &"f".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(scope, "fixture-generation", &operation)
        .unwrap();
    let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON agent_publication_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    let result = listing_result(&job, 0);
    let publication = validate_confirmation(&job, &operation, &result)
        .unwrap()
        .unwrap();
    assert!(
        store
            .action_confirm(
                scope,
                "fixture-generation",
                &operation,
                &result,
                Some(&publication)
            )
            .is_err()
    );
    assert_eq!(
        store.action_get(scope, &operation).unwrap()["state"],
        "unknown"
    );
    assert!(store.due_outbox().unwrap().is_empty());
    db.execute_batch("DROP TRIGGER fixture_fail_outbox")
        .unwrap();
}

#[path = "completion_tests.rs"]
mod completion;
