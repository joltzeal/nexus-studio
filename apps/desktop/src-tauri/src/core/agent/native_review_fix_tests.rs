use super::*;
use rusqlite::params;
use std::sync::atomic::Ordering;

const OLD_CHECKPOINT: &str = "00000000-0000-4000-8000-000000000001";
const LATEST_CHECKPOINT: &str = "00000000-0000-4000-8000-000000000002";

fn listing(store: &AgentStore, count: usize) -> Job {
    let mut snap = snapshot();
    snap.products = (0..count).map(|_| product()).collect();
    let (_, job, _) = create(store, snap, Preset::PostListing);
    claim(store, &job)
}

fn submit(store: &AgentStore, job: &Job, index: usize) -> String {
    let operation = listing_operation(job, index);
    let scope = job.scope.as_ref().unwrap();
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
    operation
}

fn confirm(store: &AgentStore, job: &Job, index: usize) -> Value {
    let operation = listing_operation(job, index);
    let result = listing_result(job, index);
    let publication = validate_confirmation(job, &operation, &result)
        .unwrap()
        .unwrap();
    store
        .action_confirm(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            &operation,
            &result,
            Some(&publication),
        )
        .unwrap();
    result
}

fn legacy_state(index: usize) -> Value {
    json!({
        "version":1,"planHash":"old-plan","phase":"submit","status":"continue",
        "index":index,"imageIndex":0,"steps":4,"rewrites":1,
        "title":"Final reviewed shirt","description":"Exact final reviewed description.",
        "reason":"","target":{"index":4},"inspection":null,"profileEvidence":null,
        "balanceObservation":null,"observedAt":"","classification":null,
        "listingBaseline":{"url":"https://www.vinted.com/member/42-fixture",
            "listingIds":["17","18"],"observedAt":"2026-11-13T01:00:00.000Z"},
        "messageBaseline":null,"intentStartedAt":"2026-11-13T01:00:01.000Z",
        "confirmation":null,"published":0,"skipped":0,"retry":null,
        "controlsRevision":0,"appliedControls":{},"amendments":{},"haltedPhase":""
    })
}

fn checkpoint(store: &AgentStore, job: &Job, checkpoint_id: &str, state: &Value) {
    store
        .checkpoint(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            "agent.checkpoint.put",
            &json!({
                "threadId":job.id,"checkpointNs":"",
                "checkpoint":{"id":checkpoint_id,"v":4,"channel_values":{"value":state},
                    "channel_versions":{},"versions_seen":{}},
                "metadata":{},"newVersions":{}
            }),
        )
        .unwrap();
}

fn make_legacy(store: &AgentStore) {
    store
        .open()
        .unwrap()
        .execute_batch("DELETE FROM agent_execution_migrations;")
        .unwrap();
}

#[test]
fn migration_extracts_pending_recovery_once_and_keeps_journals_and_authority() {
    let (temp, store) = fixture();
    let job = listing(&store, 3);
    let known_operation = submit(&store, &job, 0);
    let known_result = confirm(&store, &job, 0);
    let unknown_operation = submit(&store, &job, 1);
    let mut old = legacy_state(1);
    old["listingBaseline"]["listingIds"] = json!(["3"]);
    checkpoint(&store, &job, OLD_CHECKPOINT, &old);
    let mut latest = legacy_state(1);
    latest["listingBaseline"] = Value::Null;
    latest["intentStartedAt"] = json!("");
    latest["phase"] = json!("capture_baseline");
    checkpoint(&store, &job, LATEST_CHECKPOINT, &latest);
    let pending = legacy_state(1);
    store
        .checkpoint(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            "agent.checkpoint.putWrites",
            &json!({"threadId":job.id,"checkpointNs":"","checkpointId":LATEST_CHECKPOINT,
                "taskId":"step-task","writes":[["value",pending],["__error__",{"message":"ignored"}]]}),
        )
        .unwrap();
    let journal: String = store
        .open()
        .unwrap()
        .query_row(
            "SELECT json_group_array(json_object('id',operation_id,'digest',digest,'state',state,
          'submitted',submitted,'result',result_json,'createdAt',created_at))
         FROM (SELECT * FROM agent_actions WHERE job_id=?1 ORDER BY operation_id)",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    make_legacy(&store);
    drop(store);

    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    reopened.recover().unwrap();
    let scope = job.scope.as_ref().unwrap();
    let unknown = reopened.action_get(scope, &unknown_operation).unwrap();
    assert_eq!(unknown["state"], "unknown");
    assert!(unknown.get("result").is_none());
    assert_eq!(
        unknown["recovery"],
        json!({"version":1,"mode":"reconcile_only",
            "productId":job.snapshot.products[1]["id"],
            "productRevision":2,
            "content":{"title":"Final reviewed shirt","description":"Exact final reviewed description."},
            "listingBaseline":{"url":"https://www.vinted.com/member/42-fixture",
                "listingIds":["17","18"],"observedAt":"2026-11-13T01:00:00.000Z"},
            "intentStartedAt":"2026-11-13T01:00:01.000Z"})
    );
    let known = reopened.action_get(scope, &known_operation).unwrap();
    assert_eq!(known["state"], "confirmed");
    assert_eq!(known["result"], known_result);
    assert!(known["recovery"]["content"].is_null());
    assert_eq!(reopened.due_outbox().unwrap().len(), 1);
    let after: String = reopened
        .open()
        .unwrap()
        .query_row(
            "SELECT json_group_array(json_object('id',operation_id,'digest',digest,'state',state,
          'submitted',submitted,'result',result_json,'createdAt',created_at))
         FROM (SELECT * FROM agent_actions WHERE job_id=?1 ORDER BY operation_id)",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, journal);
    for table in [
        "agent_checkpoints",
        "agent_pending_writes",
        "agent_checkpoint_retention",
    ] {
        let count: u32 = reopened
            .open()
            .unwrap()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE job_id=?1"),
                [&job.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    assert!(
        reopened
            .validate_lease(scope, "fixture-generation")
            .is_err()
    );
    reopened.actor_stopped(&job.id, false).unwrap();
    reopened
        .control_job(&job.id, ControlAction::Reconcile)
        .unwrap();
    let actor = reopened
        .claim(&job.id, "fixture-generation")
        .unwrap()
        .unwrap();
    assert!(actor.reconcile_only);
    let active_scope = actor.scope.as_ref().unwrap();
    assert!(
        reopened
            .action_prepare(
                active_scope,
                "fixture-generation",
                &listing_operation(&actor, 2),
                "listing",
                &"b".repeat(64),
            )
            .is_err()
    );
    assert!(
        reopened
            .action_submitting(active_scope, "fixture-generation", &unknown_operation,)
            .is_err()
    );
    assert!(
        reopened
            .item_control(&ItemControlInput {
                job_id: job.id.clone(),
                product_id: job.snapshot.products[2]["id"].as_str().unwrap().into(),
                action: "approve".into(),
                r#override: None,
            })
            .is_err()
    );

    // Deleting a new graph checkpoint must not delete the native recovery envelope.
    reopened
        .checkpoint(
            active_scope,
            "fixture-generation",
            "agent.checkpoint.delete",
            &json!({"threadId":job.id}),
        )
        .unwrap();
    drop(reopened);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert_eq!(
        reopened.action_get(scope, &unknown_operation).unwrap(),
        unknown
    );
}

#[test]
fn migration_uses_checkpoint_amendments_without_inventing_missing_baselines() {
    let (temp, store) = fixture();
    let job = listing(&store, 1);
    let operation = submit(&store, &job, 0);
    let mut state = legacy_state(0);
    state["title"] = json!("");
    state["description"] = json!("");
    state["amendments"][job.snapshot.products[0]["id"].as_str().unwrap()] =
        json!({"title":"Amended submitted title","description":"Amended submitted description."});
    state["listingBaseline"] = Value::Null;
    state["intentStartedAt"] = json!("");
    // An unconfirmed checkpoint claim is never promoted to a confirmed action receipt.
    state["confirmation"] = listing_result(&job, 0);
    checkpoint(&store, &job, LATEST_CHECKPOINT, &state);
    make_legacy(&store);
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    let reply = reopened
        .action_get(job.scope.as_ref().unwrap(), &operation)
        .unwrap();
    assert_eq!(reply["state"], "unknown");
    assert!(reply.get("result").is_none());
    assert_eq!(
        reply["recovery"]["content"],
        json!({"title":"Amended submitted title","description":"Amended submitted description."})
    );
    assert!(reply["recovery"]["listingBaseline"].is_null());
    assert!(reply["recovery"]["intentStartedAt"].is_null());
}

#[test]
fn migration_extracts_orphan_pending_writes_without_choosing_conflicting_values() {
    for conflicting in [false, true] {
        let (temp, store) = fixture();
        let job = listing(&store, 1);
        let operation = submit(&store, &job, 0);
        let mut old = legacy_state(0);
        old["listingBaseline"]["listingIds"] = json!(["3"]);
        checkpoint(&store, &job, OLD_CHECKPOINT, &old);
        for task in ["first", "second"] {
            if task == "second" && !conflicting {
                continue;
            }
            let mut state = legacy_state(0);
            if task == "second" {
                state["title"] = json!("Conflicting final title");
            }
            // Pending writes are durable even when their checkpoint.put has not arrived.
            store
                .checkpoint(
                    job.scope.as_ref().unwrap(),
                    "fixture-generation",
                    "agent.checkpoint.putWrites",
                    &json!({"threadId":job.id,"checkpointNs":"","checkpointId":LATEST_CHECKPOINT,
                    "taskId":task,"writes":[["value",state]]}),
                )
                .unwrap();
        }
        make_legacy(&store);
        drop(store);
        let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
        let reply = reopened
            .action_get(job.scope.as_ref().unwrap(), &operation)
            .unwrap();
        assert_eq!(reply["state"], "unknown");
        if conflicting {
            for field in ["content", "listingBaseline", "intentStartedAt"] {
                assert!(reply["recovery"][field].is_null());
            }
        } else {
            assert_eq!(
                reply["recovery"]["content"]["title"],
                "Final reviewed shirt"
            );
            assert_eq!(
                reply["recovery"]["listingBaseline"]["listingIds"],
                json!(["17", "18"])
            );
        }
    }
}

#[test]
fn already_migrated_missing_evidence_stays_unknown_and_new_actions_have_no_recovery() {
    let (temp, store) = fixture();
    let job = listing(&store, 1);
    let operation = submit(&store, &job, 0);
    assert!(
        store
            .action_get(job.scope.as_ref().unwrap(), &operation)
            .unwrap()
            .get("recovery")
            .is_none()
    );
    // Model an installation that already ran migration 2, which deleted the old checkpoint.
    store
        .open()
        .unwrap()
        .execute_batch(
            "DELETE FROM agent_execution_migrations WHERE version=4;
         UPDATE agent_execution SET reconcile_only=1;
         UPDATE agent_jobs SET reconcile_only=1;",
        )
        .unwrap();
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    let reply = reopened
        .action_get(job.scope.as_ref().unwrap(), &operation)
        .unwrap();
    assert_eq!(reply["state"], "unknown");
    assert_eq!(reply["recovery"]["mode"], "reconcile_only");
    for field in ["content", "listingBaseline", "intentStartedAt"] {
        assert!(reply["recovery"][field].is_null());
    }
    let mut foreign = job.scope.clone().unwrap();
    foreign.job_id = id();
    assert_eq!(
        reopened.action_get(&foreign, &operation).unwrap_err().code,
        "PERMISSION_DENIED"
    );
}

#[test]
fn recovery_extraction_failure_rolls_back_checkpoint_deletion_and_migration_marker() {
    let (temp, store) = fixture();
    let job = listing(&store, 1);
    submit(&store, &job, 0);
    checkpoint(&store, &job, LATEST_CHECKPOINT, &legacy_state(0));
    make_legacy(&store);
    store
        .open()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_recovery BEFORE INSERT ON agent_action_recovery
         BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END;",
        )
        .unwrap();
    drop(store);
    assert!(AgentStore::new(temp.path().join("nexus.sqlite")).is_err());
    let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
    let checkpoints: u32 = db
        .query_row("SELECT COUNT(*) FROM agent_checkpoints", [], |r| r.get(0))
        .unwrap();
    let markers: u32 = db
        .query_row("SELECT COUNT(*) FROM agent_execution_migrations", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(checkpoints, 1);
    assert_eq!(markers, 0);
}

#[test]
fn reprepare_waits_for_unknown_confirmation_and_publication_sync() {
    let (_temp, store) = fixture();
    let browser = listing(&store, 2);
    let operation = submit(&store, &browser, 0);
    store
        .item_control(&ItemControlInput {
            job_id: browser.id.clone(),
            product_id: browser.snapshot.products[1]["id"].as_str().unwrap().into(),
            action: "revise".into(),
            r#override: Some(json!({"title":"Changed second product"})),
        })
        .unwrap();
    assert!(store.needs_reprepare(&browser.id).unwrap());
    assert!(!store.should_reprepare(&browser.id).unwrap());
    assert!(
        store
            .action_prepare(
                browser.scope.as_ref().unwrap(),
                "fixture-generation",
                &listing_operation(&browser, 1),
                "listing",
                &"b".repeat(64),
            )
            .is_err()
    );
    store
        .mark_step(
            browser.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::ResultUnknown),
        )
        .unwrap();
    store.actor_stopped(&browser.id, false).unwrap();
    store
        .control_job(&browser.id, ControlAction::Reconcile)
        .unwrap();
    let recovery = store
        .claim(&browser.id, "fixture-generation")
        .unwrap()
        .unwrap();
    assert!(recovery.reconcile_only);
    assert!(!store.should_reprepare(&browser.id).unwrap());
    confirm(&store, &recovery, 0);
    assert!(!store.should_reprepare(&browser.id).unwrap());
    store
        .mark_step(
            recovery.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::SyncPending),
        )
        .unwrap();
    store.actor_stopped(&browser.id, true).unwrap();
    assert_eq!(store.job(&browser.id).unwrap().mode, AgentMode::Browser);
    assert!(store.needs_reprepare(&browser.id).unwrap());
    store.outbox_result(&operation, None).unwrap();
    assert_eq!(
        store.job(&browser.id).unwrap().mode,
        AgentMode::ContentPreparation
    );
    assert!(!store.needs_reprepare(&browser.id).unwrap());
    let preparation = store
        .claim(&browser.id, "fixture-generation")
        .unwrap()
        .unwrap();
    assert_eq!(preparation.mode, AgentMode::ContentPreparation);
    assert!(!store.has_browser_ownership(&browser.id).unwrap());
    assert_eq!(
        store
            .action_get(browser.scope.as_ref().unwrap(), &operation)
            .unwrap()["state"],
        "confirmed"
    );
}

#[test]
fn reconciliation_keeps_running_until_its_publication_outbox_settles() {
    let (_temp, store) = fixture();
    let job = listing(&store, 1);
    let operation = submit(&store, &job, 0);
    store
        .mark_step(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::ResultUnknown),
        )
        .unwrap();
    store.actor_stopped(&job.id, false).unwrap();
    store
        .control_job(&job.id, ControlAction::Reconcile)
        .unwrap();
    let recovery = store.claim(&job.id, "fixture-generation").unwrap().unwrap();
    confirm(&store, &recovery, 0);
    store
        .mark_step(
            recovery.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Continue),
        )
        .unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "running");
    assert!(store.job(&job.id).unwrap().reconcile_only);
    assert!(
        store
            .action_submitting(
                recovery.scope.as_ref().unwrap(),
                "fixture-generation",
                &operation,
            )
            .is_err()
    );
    store.outbox_result(&operation, None).unwrap();
    store
        .mark_step(
            recovery.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Continue),
        )
        .unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "paused");
    store.actor_stopped(&job.id, true).unwrap();
}

#[test]
fn migrated_reconcile_only_job_cannot_reenter_preparation_after_confirmation() {
    let (temp, store) = fixture();
    let job = listing(&store, 2);
    let operation = submit(&store, &job, 0);
    checkpoint(&store, &job, LATEST_CHECKPOINT, &legacy_state(0));
    store
        .open()
        .unwrap()
        .execute(
            "UPDATE agent_execution SET needs_reprepare=1 WHERE job_id=?1",
            [&job.id],
        )
        .unwrap();
    make_legacy(&store);
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    reopened.recover().unwrap();
    reopened.actor_stopped(&job.id, false).unwrap();
    reopened
        .control_job(&job.id, ControlAction::Reconcile)
        .unwrap();
    let recovery = reopened
        .claim(&job.id, "fixture-generation")
        .unwrap()
        .unwrap();
    assert!(!reopened.should_reprepare(&job.id).unwrap());
    confirm(&reopened, &recovery, 0);
    reopened.outbox_result(&operation, None).unwrap();
    reopened
        .mark_step(
            recovery.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Continue),
        )
        .unwrap();
    assert_eq!(reopened.job(&job.id).unwrap().state, "running");
    reopened.control_job(&job.id, ControlAction::Pause).unwrap();
    reopened.settle_control(&job.id, false).unwrap();
    reopened.actor_stopped(&job.id, true).unwrap();
    assert_eq!(reopened.job(&job.id).unwrap().mode, AgentMode::Browser);
    assert!(reopened.job(&job.id).unwrap().reconcile_only);
    assert!(!reopened.should_reprepare(&job.id).unwrap());
    reopened
        .control_job(&job.id, ControlAction::Resume)
        .unwrap();
    let resumed = reopened
        .claim(&job.id, "fixture-generation")
        .unwrap()
        .unwrap();
    assert!(resumed.reconcile_only);
    assert!(
        reopened
            .action_prepare(
                resumed.scope.as_ref().unwrap(),
                "fixture-generation",
                &listing_operation(&resumed, 1),
                "listing",
                &"b".repeat(64),
            )
            .is_err()
    );
}

fn observation(store: &AgentStore, scope: &AgentScope, generation: &str, sequence: u64) -> Value {
    let job = store.job(&scope.job_id).unwrap();
    let reserve = json!({"operationId":id(),"accountId":scope.account_id,"windowId":scope.window_id,
        "bindingRevision":job.snapshot.account["bindingRevision"],"domains":["identity","session"]});
    store
        .reserve_observation(scope, generation, &reserve, None)
        .unwrap();
    let mut reply = reserve.clone();
    reply.as_object_mut().unwrap().remove("domains");
    reply["sequence"] = json!(sequence);
    reply["storageDurable"] = json!(true);
    store
        .reserve_observation(scope, generation, &reserve, Some(&reply))
        .unwrap();
    reply.as_object_mut().unwrap().remove("storageDurable");
    reply["observedAt"] = json!("2026-11-13T01:00:00.000Z");
    reply["source"] = json!("official");
    reply["current"] = json!({"status":"logged_out","reason":"current_access_denied",
        "httpStatus":403,"code":106,"messageCode":"access_denied"});
    reply
}

fn halt_count(store: &AgentStore) -> u32 {
    store
        .open()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM agent_dispatch_halts", [], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn rejected_observations_never_reach_the_strong_stop_fallback() {
    let (_temp, _host, service, caller, scope) = gateway_fixture();
    let record = observation(&service.store, &scope, &caller.generation, 1);
    for variant in [
        "unreserved",
        "sequence",
        "scope",
        "domains",
        "digest",
        "unacknowledged",
    ] {
        let mut invalid = record.clone();
        let db = service.store.open().unwrap();
        match variant {
            "unreserved" => invalid["operationId"] = json!(id()),
            "sequence" => invalid["sequence"] = json!(9_007_199_254_740_991_u64),
            "scope" => {
                db.execute(
                    "UPDATE agent_account_reservations SET scope_json='{}' WHERE operation_id=?1",
                    [record["operationId"].as_str().unwrap()],
                )
                .unwrap();
            }
            "domains" => {
                db.execute("UPDATE agent_account_reservations SET domains_json='[\"analysis\"]' WHERE operation_id=?1",
                    [record["operationId"].as_str().unwrap()]).unwrap();
            }
            "digest" => {
                db.execute(
                    "UPDATE agent_account_reservations SET record_digest=?2 WHERE operation_id=?1",
                    params![record["operationId"].as_str(), "b".repeat(64)],
                )
                .unwrap();
            }
            "unacknowledged" => {
                db.execute(
                    "UPDATE agent_account_reservations SET sequence=NULL WHERE operation_id=?1",
                    [record["operationId"].as_str().unwrap()],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let error = service
            .record_account_observation(&scope, &caller.generation, &invalid, || {
                panic!("Rejected evidence must not call the account plugin")
            })
            .unwrap_err();
        assert_eq!(error.code, "PERMISSION_DENIED", "{variant}");
        assert_eq!(halt_count(&service.store), 0, "{variant}");
        assert!(!service.storage_halted.load(Ordering::Acquire), "{variant}");
        db.execute("UPDATE agent_account_reservations SET scope_json=?2,domains_json='[\"identity\",\"session\"]',
            sequence=1,record_digest=NULL WHERE operation_id=?1",
            params![record["operationId"].as_str(), crate::core::agent::canonical(&json!(scope))]).unwrap();
    }
    assert!(service.store.require_dispatch_writes(&scope.job_id).is_ok());
}

#[test]
fn accepted_strong_observation_halts_durably_even_when_account_storage_fails() {
    for banned in [false, true] {
        let (temp, _host, service, caller, scope) = gateway_fixture();
        let mut record = observation(&service.store, &scope, &caller.generation, 1);
        if banned {
            record["current"] = json!({"status":"authenticated","reason":"current_user",
                "platformUserId":"42","isAccountBanned":true});
        }
        let error = service
            .record_account_observation(&scope, &caller.generation, &record, || {
                Err(crate::core::agent::storage_error(
                    "fixture account-plugin write failure",
                ))
            })
            .unwrap_err();
        assert_eq!(error.code, "UNAVAILABLE");
        assert_eq!(halt_count(&service.store), if banned { 2 } else { 1 });
        assert!(
            service
                .store
                .require_dispatch_writes(&scope.job_id)
                .is_err()
        );
        assert!(!service.store.job_needs_login(&scope.job_id).unwrap());
        assert!(!service.storage_halted.load(Ordering::Acquire));
        let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
        assert!(reopened.require_dispatch_writes(&scope.job_id).is_err());
    }
}

#[test]
fn authorized_stop_with_native_persistence_failure_latches_dispatch_halt() {
    let (_temp, _host, service, caller, scope) = gateway_fixture();
    let record = observation(&service.store, &scope, &caller.generation, 1);
    service
        .store
        .open()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_halt BEFORE INSERT ON agent_dispatch_halts
         BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END;",
        )
        .unwrap();
    let error = service
        .record_account_observation(&scope, &caller.generation, &record, || {
            panic!("Native intent must be durable before calling the account plugin")
        })
        .unwrap_err();
    assert_eq!(error.code, "UNAVAILABLE");
    assert!(service.storage_halted.load(Ordering::Acquire));
    assert_eq!(halt_count(&service.store), 0);
    let digest: Option<String> = service
        .store
        .open()
        .unwrap()
        .query_row(
            "SELECT record_digest FROM agent_account_reservations WHERE operation_id=?1",
            [record["operationId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(digest.is_none());
    let error = service
        .handle_host(
            caller.clone(),
            host_request(
                &scope,
                "agent.action.prepare",
                json!({"operationId":id(),"kind":"listing","digest":"a".repeat(64)}),
            ),
        )
        .unwrap_err();
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert!(error.message.contains("dispatch is halted"));
}
