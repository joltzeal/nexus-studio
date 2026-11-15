use super::*;
use rusqlite::params;

const CHECKPOINT: &str = "00000000-0000-4000-8000-000000000001";
const PENDING_CHECKPOINT: &str = "00000000-0000-4000-8000-000000000002";

fn message_job(store: &AgentStore, count: usize) -> Job {
    let mut snap = snapshot();
    snap.messages = (0..count)
        .map(|index| Message {
            conversation_id: (123 + index).to_string(),
            text: format!("  Message {index}\nexact frozen text  "),
        })
        .collect();
    let (_, job, _) = create(store, snap, Preset::Message);
    claim(store, &job)
}

fn operation(job: &Job, index: usize) -> String {
    super::super::items::operation_id(&job.id, &format!("message:{index}"))
}

fn prepare(store: &AgentStore, job: &Job, index: usize, submitted: bool) -> String {
    let operation = operation(job, index);
    let scope = job.scope.as_ref().unwrap();
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "message",
            &"d".repeat(64),
        )
        .unwrap();
    if submitted {
        store
            .action_submitting(scope, "fixture-generation", &operation)
            .unwrap();
    }
    operation
}

fn confirm(store: &AgentStore, job: &Job, index: usize) -> Value {
    let message = &job.snapshot.messages[index];
    let result = json!({
        "kind":"message","conversationId":message.conversation_id,"text":message.text,
        "confirmedAt":"2026-11-13T01:00:03.000Z",
        "evidence":{"messageId":"91827","sentAt":"2026-11-13T01:00:02.000Z"}
    });
    let operation = operation(job, index);
    assert!(
        validate_confirmation(job, &operation, &result)
            .unwrap()
            .is_none()
    );
    store
        .action_confirm(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            &operation,
            &result,
            None,
        )
        .unwrap();
    result
}

fn old_state(index: usize, conversation: &str) -> Value {
    json!({
        "version":1,"index":index,"phase":"confirm","planHash":"old-message-plan",
        "messageBaseline":{"conversationId":conversation,"messageIds":["17","18"],
            "observedAt":"2026-11-13T01:00:00.000Z"},
        "intentStartedAt":"2026-11-13T01:00:01.000Z"
    })
}

fn checkpoint(store: &AgentStore, job: &Job, state: &Value) {
    store
        .checkpoint(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            "agent.checkpoint.put",
            &json!({"threadId":job.id,"checkpointNs":"",
                "checkpoint":{"id":CHECKPOINT,"v":4,"channel_values":{"value":state},
                    "channel_versions":{},"versions_seen":{}},"metadata":{},"newVersions":{}}),
        )
        .unwrap();
}

fn pending(store: &AgentStore, job: &Job, state: &Value) {
    store
        .checkpoint(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            "agent.checkpoint.putWrites",
            &json!({"threadId":job.id,"checkpointNs":"","checkpointId":PENDING_CHECKPOINT,
                "taskId":"message-step","writes":[["value",state]]}),
        )
        .unwrap();
}

fn upgrade_on_next_open(store: &AgentStore) {
    store
        .open()
        .unwrap()
        .execute("DELETE FROM agent_execution_migrations WHERE version=5", [])
        .unwrap();
}

fn journal(store: &AgentStore, job: &str) -> Value {
    let encoded: String = store
        .open()
        .unwrap()
        .query_row(
            "SELECT json_group_array(json_object('id',operation_id,'kind',kind,'digest',digest,
            'state',state,'submitted',submitted,'result',result_json,
            'createdAt',created_at,'updatedAt',updated_at))
         FROM (SELECT * FROM agent_actions WHERE job_id=?1 ORDER BY operation_id)",
            [job],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&encoded).unwrap()
}

fn assert_graph_cleared(store: &AgentStore, job: &str) {
    for table in [
        "agent_checkpoints",
        "agent_pending_writes",
        "agent_checkpoint_retention",
    ] {
        let count: u32 = store
            .open()
            .unwrap()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE job_id=?1"),
                [job],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
}

#[test]
fn message_upgrade_extracts_exact_pending_evidence_and_preserves_journals_once() {
    let (temp, store) = fixture();
    let job = message_job(&store, 4);
    let known = prepare(&store, &job, 0, true);
    let result = confirm(&store, &job, 0);
    let unknown = prepare(&store, &job, 1, true);
    let mut old = old_state(1, "124");
    old["messageBaseline"]["messageIds"] = json!(["3"]);
    checkpoint(&store, &job, &old);
    pending(&store, &job, &old_state(1, "124"));
    let expected_journal = journal(&store, &job.id);
    let original_resources: u32 = store
        .open()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM agent_resources WHERE job_id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    upgrade_on_next_open(&store);
    drop(store);

    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    let scope = job.scope.as_ref().unwrap();
    let receipt = store.action_get(scope, &unknown).unwrap();
    assert_eq!(receipt["state"], "unknown");
    assert_eq!(
        receipt["messageRecovery"],
        json!({
            "version":1,"mode":"reconcile_only","messageIndex":1,"conversationId":"124",
            "text":"  Message 1\nexact frozen text  ",
            "messageBaseline":{"conversationId":"124","messageIds":["17","18"],
                "observedAt":"2026-11-13T01:00:00.000Z"},
            "intentStartedAt":"2026-11-13T01:00:01.000Z"
        })
    );
    assert!(receipt.get("recovery").is_none());
    let confirmed = store.action_get(scope, &known).unwrap();
    assert_eq!(confirmed["result"], result);
    assert!(confirmed["messageRecovery"]["messageBaseline"].is_null());
    assert_eq!(journal(&store, &job.id), expected_journal);
    assert_eq!(
        store.action_get(scope, &operation(&job, 3)).unwrap(),
        json!({"state":"missing"})
    );
    assert_graph_cleared(&store, &job.id);
    assert!(store.job(&job.id).unwrap().reconcile_only);
    assert_eq!(store.job(&job.id).unwrap().state, "result_unknown");
    assert!(store.validate_lease(scope, "fixture-generation").is_err());
    let retained_resources: u32 = store
        .open()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM agent_resources WHERE job_id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(retained_resources, original_resources);
    assert!(store.has_browser_ownership(&job.id).unwrap());
    let mut foreign = scope.clone();
    foreign.job_id = id();
    assert!(store.action_get(&foreign, &unknown).is_err());

    store.recover().unwrap();
    store.actor_stopped(&job.id, false).unwrap();
    store
        .control_job(&job.id, ControlAction::Reconcile)
        .unwrap();
    let resumed = store.claim(&job.id, "fixture-generation").unwrap().unwrap();
    let mut new_state = old_state(1, "124");
    new_state["version"] = json!(2);
    new_state["messageBaseline"]["messageIds"] = json!(["99"]);
    checkpoint(&store, &resumed, &new_state);
    let saved_checkpoint: String = store
        .open()
        .unwrap()
        .query_row(
            "SELECT tuple_json FROM agent_checkpoints WHERE job_id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert_eq!(store.action_get(scope, &unknown).unwrap(), receipt);
    let after: String = store
        .open()
        .unwrap()
        .query_row(
            "SELECT tuple_json FROM agent_checkpoints WHERE job_id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, saved_checkpoint);
}

#[test]
fn message_upgrade_never_invents_missing_or_mismatched_recovery_evidence() {
    for variant in ["missing", "conversation", "ids", "timestamp", "intent"] {
        let (temp, store) = fixture();
        let job = message_job(&store, 1);
        let operation = prepare(&store, &job, 0, true);
        let mut state = old_state(0, "123");
        match variant {
            "missing" => {}
            "conversation" => state["messageBaseline"]["conversationId"] = json!("124"),
            "ids" => state["messageBaseline"]["messageIds"] = json!(["017"]),
            "timestamp" => {
                state["messageBaseline"]["observedAt"] = json!("2026-02-30T01:00:00.000Z")
            }
            "intent" => state["intentStartedAt"] = json!(""),
            _ => unreachable!(),
        }
        if variant != "missing" {
            state["confirmation"] = json!({"kind":"message","conversationId":"123"});
            checkpoint(&store, &job, &state);
        }
        upgrade_on_next_open(&store);
        drop(store);
        let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
        let receipt = store
            .action_get(job.scope.as_ref().unwrap(), &operation)
            .unwrap();
        assert_eq!(receipt["state"], "unknown", "{variant}");
        assert!(receipt.get("result").is_none(), "{variant}");
        assert_eq!(
            receipt["messageRecovery"]["text"],
            "  Message 0\nexact frozen text  "
        );
        if variant == "intent" {
            assert_eq!(
                receipt["messageRecovery"]["messageBaseline"],
                state["messageBaseline"]
            );
        } else {
            assert!(
                receipt["messageRecovery"]["messageBaseline"].is_null(),
                "{variant}"
            );
        }
        if matches!(variant, "missing" | "intent") {
            assert!(
                receipt["messageRecovery"]["intentStartedAt"].is_null(),
                "{variant}"
            );
        } else {
            assert_eq!(
                receipt["messageRecovery"]["intentStartedAt"],
                "2026-11-13T01:00:01.000Z"
            );
        }
    }
}

#[test]
fn upgrade_resets_unjournaled_message_and_inspection_graphs_under_existing_controls() {
    for preset in [Preset::Message, Preset::InspectAccounts] {
        for control in ["run", "cancel", "takeover"] {
            let (temp, store) = fixture();
            let job = if preset == Preset::Message {
                message_job(&store, 1)
            } else {
                let (_, job, _) = create(&store, snapshot(), preset);
                claim(&store, &job)
            };
            let mut state = old_state(0, "123");
            state["phase"] = json!("record_balance");
            checkpoint(&store, &job, &state);
            pending(&store, &job, &state);
            store
                .open()
                .unwrap()
                .execute(
                    "UPDATE agent_dispatch SET action=?2,retry_code='OLD_RETRY',next_attempt=123,
                    progress_json='{}',retry_json='{}' WHERE job_id=?1",
                    params![job.id, control],
                )
                .unwrap();
            store
                .open()
                .unwrap()
                .execute("UPDATE agent_jobs SET steps=123 WHERE id=?1", [&job.id])
                .unwrap();
            upgrade_on_next_open(&store);
            drop(store);
            let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
            let migrated = store.job(&job.id).unwrap();
            assert_eq!(migrated.state, "paused");
            assert_eq!(migrated.steps, 0);
            assert!(!migrated.reconcile_only);
            assert_eq!(
                store.job_action(&job.id).unwrap(),
                if control == "run" { "pause" } else { control }
            );
            assert_graph_cleared(&store, &job.id);
            assert!(store.has_browser_ownership(&job.id).unwrap());
            assert!(
                store
                    .validate_lease(job.scope.as_ref().unwrap(), "fixture-generation")
                    .is_err()
            );
            assert!(
                store
                    .claim(&job.id, "fixture-generation")
                    .unwrap()
                    .is_none()
            );
            let retry: (String, i64, Option<String>, Option<String>) = store.open().unwrap().query_row(
                "SELECT retry_code,next_attempt,progress_json,retry_json FROM agent_dispatch WHERE job_id=?1",
                [&job.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            ).unwrap();
            assert_eq!(retry, (String::new(), 0, None, None));
        }
    }
}

#[test]
fn message_migration_failure_rolls_back_evidence_graph_deletion_pins_and_marker() {
    let (temp, store) = fixture();
    let job = message_job(&store, 1);
    let operation = prepare(&store, &job, 0, false);
    let state = old_state(0, "123");
    checkpoint(&store, &job, &state);
    pending(&store, &job, &state);
    let journal_before = journal(&store, &job.id);
    upgrade_on_next_open(&store);
    store
        .open()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_message_migration BEFORE INSERT ON agent_execution_migrations
         WHEN NEW.version=5 BEGIN SELECT RAISE(FAIL,'fixture migration failure'); END;",
        )
        .unwrap();
    drop(store);
    assert!(AgentStore::new(temp.path().join("nexus.sqlite")).is_err());
    let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
    let counts: (u32, u32, u32, bool, bool) = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM agent_checkpoints WHERE job_id=?1),
            (SELECT COUNT(*) FROM agent_pending_writes WHERE job_id=?1),
            (SELECT COUNT(*) FROM agent_message_recovery WHERE job_id=?1),
            (SELECT reconcile_only FROM agent_jobs WHERE id=?1),
            (SELECT reconcile_only FROM agent_execution WHERE job_id=?1)",
            [&job.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(counts, (1, 1, 0, false, false));
    let marker: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_execution_migrations WHERE version=5)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!marker);
    let action_state: String = db
        .query_row(
            "SELECT state FROM agent_actions WHERE operation_id=?1",
            [&operation],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(action_state, "prepared");
    db.execute_batch("DROP TRIGGER reject_message_migration;")
        .unwrap();
    drop(db);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    let mut expected = journal_before;
    expected[0]["state"] = json!("unknown");
    assert_eq!(journal(&store, &job.id), expected);
    assert_graph_cleared(&store, &job.id);
}

#[test]
fn permanent_message_reconciliation_can_scan_after_last_confirmation_until_terminal() {
    let (temp, store) = fixture();
    let job = message_job(&store, 3);
    let submitted = prepare(&store, &job, 1, true);
    checkpoint(&store, &job, &old_state(1, "124"));
    upgrade_on_next_open(&store);
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    store.recover().unwrap();
    store.actor_stopped(&job.id, false).unwrap();
    store
        .control_job(&job.id, ControlAction::Reconcile)
        .unwrap();
    let resumed = store.claim(&job.id, "fixture-generation").unwrap().unwrap();
    let scope = resumed.scope.as_ref().unwrap();
    assert_eq!(
        store.action_get(scope, &operation(&job, 0)).unwrap()["state"],
        "missing"
    );
    confirm(&store, &resumed, 1);
    for _ in 0..3 {
        store
            .mark_step(scope, "fixture-generation", &output(StepState::Continue))
            .unwrap();
        assert_eq!(store.job(&job.id).unwrap().state, "running");
        assert!(store.job(&job.id).unwrap().reconcile_only);
        assert!(store.validate_lease(scope, "fixture-generation").is_ok());
    }
    assert!(
        store
            .action_prepare(
                scope,
                "fixture-generation",
                &operation(&job, 2),
                "message",
                &"a".repeat(64)
            )
            .is_err()
    );
    assert!(
        store
            .action_submitting(scope, "fixture-generation", &submitted)
            .is_err()
    );
    store
        .mark_step(scope, "fixture-generation", &output(StepState::Completed))
        .unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "completed");
    assert!(store.job(&job.id).unwrap().reconcile_only);
    store.actor_stopped(&job.id, true).unwrap();
}

#[test]
fn temporary_message_reconciliation_still_pauses_after_last_confirmation() {
    let (_temp, store) = fixture();
    let job = message_job(&store, 2);
    prepare(&store, &job, 0, true);
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
    let resumed = store.claim(&job.id, "fixture-generation").unwrap().unwrap();
    assert!(resumed.reconcile_only);
    confirm(&store, &resumed, 0);
    store
        .mark_step(
            resumed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Continue),
        )
        .unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "paused");
    assert!(!store.job(&job.id).unwrap().reconcile_only);
    store.actor_stopped(&job.id, true).unwrap();
}

#[test]
fn startup_graph_reset_preserves_terminal_states_and_listing_outbox() {
    let (temp, store) = fixture();
    let job = message_job(&store, 1);
    let message_operation = prepare(&store, &job, 0, true);
    let message_result = confirm(&store, &job, 0);
    checkpoint(&store, &job, &old_state(0, "123"));
    store
        .mark_step(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job.id, true).unwrap();
    let mut snap = snapshot();
    snap.products.push(product());
    let (_, listing_id, _) = create(&store, snap, Preset::PostListing);
    let listing = claim(&store, &listing_id);
    let operation = listing_operation(&listing, 0);
    let scope = listing.scope.as_ref().unwrap();
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
    let result = listing_result(&listing, 0);
    let publication = validate_confirmation(&listing, &operation, &result)
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
    let listing_journal = journal(&store, &listing.id);
    upgrade_on_next_open(&store);
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "completed");
    assert!(store.job(&job.id).unwrap().reconcile_only);
    assert_eq!(
        store
            .action_get(job.scope.as_ref().unwrap(), &message_operation)
            .unwrap()["result"],
        message_result
    );
    assert_graph_cleared(&store, &job.id);
    assert_eq!(journal(&store, &listing.id), listing_journal);
    let outbox = store.due_outbox().unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].payload, publication);
    assert!(
        store
            .action_get(scope, &operation)
            .unwrap()
            .get("messageRecovery")
            .is_none()
    );
}

#[test]
fn message_recovery_bounds_preserve_last_index_and_reject_unrepresentable_frozen_text() {
    for valid in [true, false] {
        let (temp, store) = fixture();
        let mut snap = snapshot();
        snap.messages = (0..100)
            .map(|index| Message {
                conversation_id: (123 + index).to_string(),
                text: if index == 99 {
                    "x".repeat(4000)
                } else {
                    "Fixture".into()
                },
            })
            .collect();
        let (_, id, _) = create(&store, snap, Preset::Message);
        let job = claim(&store, &id);
        let operation = prepare(&store, &job, 99, true);
        checkpoint(&store, &job, &old_state(99, "222"));
        if !valid {
            store.open().unwrap().execute(
                "UPDATE agent_jobs SET snapshot_json=json_set(snapshot_json,'$.messages[99].text',?2) WHERE id=?1",
                params![job.id, "x".repeat(4001)]
            ).unwrap();
        }
        upgrade_on_next_open(&store);
        drop(store);
        let reopened = AgentStore::new(temp.path().join("nexus.sqlite"));
        if valid {
            let store = reopened.unwrap();
            let receipt = store
                .action_get(job.scope.as_ref().unwrap(), &operation)
                .unwrap();
            assert_eq!(receipt["messageRecovery"]["messageIndex"], 99);
            assert_eq!(receipt["messageRecovery"]["conversationId"], "222");
            assert_eq!(receipt["messageRecovery"]["text"], "x".repeat(4000));
        } else {
            assert!(reopened.is_err());
            let db = open_database(&temp.path().join("nexus.sqlite")).unwrap();
            let count: u32 = db
                .query_row(
                    "SELECT COUNT(*) FROM agent_checkpoints WHERE job_id=?1",
                    [&job.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }
    }
}
