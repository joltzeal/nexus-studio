use super::engine::model::Project;
use super::store::{ActionIntent, AutomationStore, RunIntent};
use crate::core::database::open_database;
use rusqlite::params;
use serde_json::{Value, json};

struct Fixture {
    directory: tempfile::TempDir,
    store: AutomationStore,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v2").join("raccoon.sqlite");
        let database = open_database(&path).unwrap();
        for id in ["connection-a", "connection-b"] {
            database.execute(
                "INSERT INTO browser_connections(id,provider,enabled,record_json) VALUES(?1,?2,0,'{}')",
                params![id, "\"shardbrowser\""],
            ).unwrap();
        }
        let store = AutomationStore::open(path, directory.path().join("modules")).unwrap();
        Self { directory, store }
    }

    fn run(&self, project: &Project, operation: &str) -> super::store::RunRecord {
        match self
            .store
            .begin_run(
                "connection-a",
                &project.id,
                operation,
                json!({"project":project}),
            )
            .unwrap()
        {
            RunIntent::Created(record) => record,
            RunIntent::Existing(_) => panic!("expected a new intent"),
        }
    }
}

#[test]
fn projects_survive_reopening_and_remain_connection_scoped() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Persistent").unwrap();
    assert!(fixture.store.list("connection-b").unwrap().is_empty());
    assert_eq!(
        fixture
            .store
            .get("connection-b", &project.id)
            .unwrap_err()
            .code,
        "project_missing"
    );
    let reopened = AutomationStore::open(
        fixture.directory.path().join("v2/raccoon.sqlite"),
        fixture.directory.path().join("modules"),
    )
    .unwrap();
    assert_eq!(
        reopened.get("connection-a", &project.id).unwrap().name,
        "Persistent"
    );
}

#[test]
fn saving_checks_revisions_and_preserves_creation_time() {
    let fixture = Fixture::new();
    let original = fixture.store.create("connection-a", "Original").unwrap();
    let mut edit = original.clone();
    edit.name = "Edited".into();
    edit.created_at = 0;
    let saved = fixture.store.save("connection-a", edit).unwrap();
    assert_eq!(saved.created_at, original.created_at);
    assert_eq!(saved.revision, Some(2));
    assert_eq!(
        fixture
            .store
            .save("connection-a", original)
            .unwrap_err()
            .code,
        "conflict"
    );
}

#[test]
fn duplicate_has_a_new_identity_without_modifying_original() {
    let fixture = Fixture::new();
    let original = fixture.store.create("connection-a", "Original").unwrap();
    let copy = fixture
        .store
        .duplicate("connection-a", &original.id)
        .unwrap();
    assert_ne!(original.id, copy.id);
    assert_eq!(copy.name, "Original copy");
    assert_eq!(fixture.store.list("connection-a").unwrap().len(), 2);
    assert!(
        fixture
            .store
            .duplicate("connection-b", &original.id)
            .is_err()
    );
}

#[test]
fn bundles_redact_declared_and_nested_secrets_without_mutating_saved_project() {
    let fixture = Fixture::new();
    let mut project = fixture.store.create("connection-a", "Secrets").unwrap();
    project.blocks = serde_json::from_value(json!([{
        "id":"step-1","kind":"http.request","secrets":["body"],
        "params":{"body":"private form","headers":{"Authorization":"private bearer"},
            "proxy":"http://fixture-user:fixture-password@127.0.0.1:1080"}
    }]))
    .unwrap();
    let project = fixture.store.save("connection-a", project).unwrap();
    let bundle = fixture.store.export("connection-a", &project.id).unwrap();
    let encoded = bundle.to_string();
    assert!(!encoded.contains("private form"));
    assert!(!encoded.contains("private bearer"));
    assert!(!encoded.contains("fixture-password"));
    assert_eq!(bundle["needs"][0]["params"], json!(["body"]));
    assert_eq!(
        fixture
            .store
            .get("connection-a", &project.id)
            .unwrap()
            .blocks[0]
            .params["body"],
        "private form"
    );
}

#[test]
fn importing_requires_explicit_profile_and_subflow_rebinding() {
    let fixture = Fixture::new();
    let mut project = fixture.store.create("connection-a", "Import").unwrap();
    project.blocks = serde_json::from_value(json!([
        {"id":"use","kind":"profile.use","params":{"id":"external-id"}},
        {"id":"call","kind":"flow.call","params":{"project":project.id}},
        {"id":"module","kind":"module:missing:step","params":{}}
    ]))
    .unwrap();
    let imported = fixture
        .store
        .import("connection-b", json!({"format":1,"project":project}))
        .unwrap();
    assert_ne!(project.id, imported.id);
    assert_eq!(
        imported.blocks[0].params["id"],
        "__raccoon_unbound_reference__"
    );
    assert_eq!(
        imported.blocks[1].params["project"],
        "__raccoon_unbound_reference__"
    );
    let issues = fixture.store.references("connection-b", &imported).unwrap();
    assert!(
        issues
            .iter()
            .any(|issue| issue.kind == "profile" && issue.path == "blocks[0].params.id")
    );
    assert!(issues.iter().any(|issue| issue.kind == "flow"));
    assert!(issues.iter().any(|issue| issue.kind == "module"));
}

#[test]
fn unknown_bundle_versions_do_not_write_a_project() {
    let fixture = Fixture::new();
    assert!(
        fixture
            .store
            .import("connection-a", json!({"format":2}))
            .is_err()
    );
    assert!(fixture.store.list("connection-a").unwrap().is_empty());
}

#[test]
fn repeated_run_operations_reuse_the_original_snapshot() {
    let fixture = Fixture::new();
    let mut project = fixture.store.create("connection-a", "Run").unwrap();
    let run = fixture.run(&project, "stable-operation");
    project.name = "Edited later".into();
    let project = fixture.store.save("connection-a", project).unwrap();
    let repeated = fixture
        .store
        .begin_run(
            "connection-a",
            &project.id,
            "stable-operation",
            json!({"project":project}),
        )
        .unwrap();
    let RunIntent::Existing(repeated) = repeated else {
        panic!("request was redispatched")
    };
    assert_eq!(run.id, repeated.id);
    assert_eq!(repeated.snapshot["project"]["name"], "Run");
    assert_eq!(
        fixture
            .store
            .begin_run(
                "connection-a",
                &project.id,
                "different-operation",
                Value::Null
            )
            .unwrap_err()
            .code,
        "profile_busy"
    );
}

#[test]
fn restart_marks_unfinished_workers_interrupted_without_replaying() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Run").unwrap();
    let run = fixture.run(&project, "restart-operation");
    let mut state = run.state;
    state["workers"] = json!([{"status":"running","step":4,"note":"working"}]);
    fixture.store.update_run(&run.id, "running", state).unwrap();
    assert_eq!(fixture.store.interrupt_unfinished().unwrap(), 1);
    assert_eq!(fixture.store.interrupt_unfinished().unwrap(), 0);
    let recovered = fixture
        .store
        .latest_run("connection-a", &project.id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered.phase, "interrupted");
    assert_eq!(recovered.state["running"], false);
    assert_eq!(recovered.state["workers"][0]["step"], 4);
    assert_eq!(recovered.state["workers"][0]["status"], "interrupted");
    assert!(
        fixture
            .store
            .update_run(&run.id, "running", recovered.state)
            .is_err()
    );
}

#[test]
fn uncertain_actions_cannot_dispatch_twice_and_completed_actions_are_reusable() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Run").unwrap();
    let run = fixture.run(&project, "action-operation");
    assert!(matches!(
        fixture
            .store
            .begin_action(&run.id, "create", &json!({"name":"a"}))
            .unwrap(),
        ActionIntent::New
    ));
    assert!(
        fixture
            .store
            .begin_action(&run.id, "create", &json!({"name":"a"}))
            .is_err()
    );
    fixture
        .store
        .complete_action(&run.id, "create", &json!({"id":"confirmed"}))
        .unwrap();
    let repeated = fixture
        .store
        .begin_action(&run.id, "create", &json!({"name":"a"}))
        .unwrap();
    assert!(matches!(repeated, ActionIntent::Completed(value) if value["id"] == "confirmed"));
    assert!(
        fixture
            .store
            .begin_action(&run.id, "create", &json!({"name":"different"}))
            .is_err()
    );
}

#[test]
fn active_projects_cannot_be_deleted_and_failed_storage_never_reports_success() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Run").unwrap();
    fixture.run(&project, "delete-operation");
    assert_eq!(
        fixture
            .store
            .delete("connection-a", &project.id)
            .unwrap_err()
            .code,
        "profile_busy"
    );
    let database = open_database(&fixture.store.database_path().unwrap()).unwrap();
    database.execute_batch("CREATE TRIGGER reject_automation_save BEFORE UPDATE ON automation_projects BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    let mut edit = project.clone();
    edit.name = "Lost".into();
    assert_eq!(
        fixture.store.save("connection-a", edit).unwrap_err().code,
        "storage_failed"
    );
    assert_eq!(
        fixture.store.get("connection-a", &project.id).unwrap().name,
        project.name
    );
}

#[test]
fn module_grants_are_scoped_and_digest_bound() {
    let fixture = Fixture::new();
    fixture
        .store
        .set_grant(
            "connection-a",
            "module",
            "digest-a",
            &json!({"call_flows":["flow-a"]}),
        )
        .unwrap();
    assert!(
        fixture
            .store
            .grant("connection-b", "module", "digest-a")
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .store
            .grant("connection-a", "module", "digest-b")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture
            .store
            .grant("connection-a", "module", "digest-a")
            .unwrap()
            .unwrap()["call_flows"],
        json!(["flow-a"])
    );
}

#[test]
fn imported_folder_requires_rebinding_while_dynamic_folder_is_preserved() {
    let fixture = Fixture::new();
    let mut project = fixture.store.create("connection-a", "Folders").unwrap();
    project.blocks = serde_json::from_value(json!([
        {"id":"create","kind":"profile.create","params":{"folder":"Automation"}},
        {"id":"dynamic","kind":"profile.keep","params":{"folder":"{{folder}}"}}
    ]))
    .unwrap();
    let imported = fixture
        .store
        .import("connection-b", json!({"format":1,"project":project}))
        .unwrap();
    assert_eq!(imported.blocks[1].params["folder"], "{{folder}}");
    let issues = fixture.store.references("connection-b", &imported).unwrap();
    assert!(
        issues
            .iter()
            .any(|issue| issue.path == "blocks[0].params.folder")
    );
}

#[test]
fn cancellation_is_durable_and_running_updates_cannot_erase_stop_request() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Cancel").unwrap();
    let run = fixture.run(&project, "cancel-operation");
    fixture.store.request_cancel(&run.id).unwrap();
    fixture
        .store
        .update_run(&run.id, "stopping", run.state.clone())
        .unwrap();
    fixture
        .store
        .update_run(&run.id, "running", run.state)
        .unwrap();
    let restored = fixture.store.run_by_id("connection-a", &run.id).unwrap();
    assert_eq!(restored.phase, "stopping");
    assert!(fixture.store.cancelled(&run.id).unwrap());
    assert!(fixture.store.run_by_id("connection-b", &run.id).is_err());
}

#[test]
fn recovery_preserves_old_interrupted_runs_and_reviews_only_named_intents() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Recover").unwrap();
    let old = fixture.run(&project, "old-operation");
    let key =
        json!({"worker":0,"pass":1,"sequence":1,"block_id":"wait","kind":"wait","call_stack":[]});
    let intent = fixture
        .store
        .allocate_step(&old.id, &key, &json!({}))
        .unwrap();
    fixture
        .store
        .begin_action(&old.id, "action", &json!({}))
        .unwrap();
    fixture
        .store
        .link_action(&old.id, "action", &intent)
        .unwrap();
    fixture.store.interrupt_unfinished().unwrap();
    let newer = fixture.run(&project, "new-operation");
    assert_ne!(old.id, newer.id);
    assert_eq!(
        fixture
            .store
            .recovery_runs("connection-a", &project.id)
            .unwrap()[0]
            .id,
        old.id
    );
    assert!(fixture.store.interrupted_pending(&old.id).unwrap());
    fixture
        .store
        .review_step(&old.id, &intent, "stopped after explicit inspection")
        .unwrap();
    assert!(!fixture.store.interrupted_pending(&old.id).unwrap());
    assert!(
        fixture
            .store
            .review_step(&newer.id, &intent, "stopped")
            .is_err()
    );
    fixture.store.settle_interrupted(&old.id).unwrap();
    assert_eq!(
        fixture
            .store
            .run_by_id("connection-a", &old.id)
            .unwrap()
            .phase,
        "cancelled"
    );
}

#[test]
fn step_completion_retries_are_idempotent_and_conflicting_results_are_rejected() {
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Steps").unwrap();
    let run = fixture.run(&project, "step-operation");
    let intent = fixture
        .store
        .allocate_step(&run.id, &json!({"sequence":1}), &json!({}))
        .unwrap();
    fixture
        .store
        .finish_step(
            &run.id,
            &intent,
            "completed",
            Some(&json!({"flow":"next"})),
            None,
        )
        .unwrap();
    fixture
        .store
        .finish_step(
            &run.id,
            &intent,
            "completed",
            Some(&json!({"flow":"next"})),
            None,
        )
        .unwrap();
    assert!(
        fixture
            .store
            .finish_step(
                &run.id,
                &intent,
                "completed",
                Some(&json!({"flow":"else"})),
                None
            )
            .is_err()
    );
}

#[test]
fn retention_compacts_old_terminal_artifacts_and_keeps_operation_receipts() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    let project = fixture.store.create("connection-a", "Retention").unwrap();
    let first = fixture.run(&project, "retained-operation");
    let scope = super::engine::host::EngineScope {
        connection_id: "connection-a".into(),
        run_id: first.id.clone(),
        project_id: project.id.clone(),
    };
    let directory = fixture.store.modules_dir.join("snapshots").join(format!(
        "{:x}",
        Sha256::digest(scope.resource_key("modules").as_bytes())
    ));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("fixture.wasm"), b"fixture").unwrap();
    fixture
        .store
        .update_run(&first.id, "completed", first.state)
        .unwrap();
    for index in 0..50 {
        let run = fixture.run(&project, &format!("operation-{index}"));
        fixture
            .store
            .update_run(&run.id, "completed", run.state)
            .unwrap();
    }
    assert_eq!(fixture.store.prune_artifacts().unwrap(), 1);
    assert!(!directory.exists());
    let receipt = fixture
        .store
        .operation_run("connection-a", "retained-operation")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.id, first.id);
    assert_eq!(receipt.snapshot["retired"], true);
    assert_eq!(fixture.store.list("connection-a").unwrap().len(), 1);
}

#[test]
fn projects_with_interrupted_runs_cannot_disappear_before_recovery() {
    let fixture = Fixture::new();
    let project = fixture
        .store
        .create("connection-a", "Recover before delete")
        .unwrap();
    let run = fixture.run(&project, "recover-delete");
    fixture.store.interrupt_unfinished().unwrap();
    assert_eq!(
        fixture
            .store
            .delete("connection-a", &project.id)
            .unwrap_err()
            .code,
        "profile_busy"
    );
    fixture.store.settle_interrupted(&run.id).unwrap();
    fixture.store.delete("connection-a", &project.id).unwrap();
}

#[test]
fn recovery_settlement_stops_unfinished_workers_and_preserves_completed_workers() {
    let fixture = Fixture::new();
    let project = fixture
        .store
        .create("connection-a", "Worker recovery")
        .unwrap();
    let run = fixture.run(&project, "recover-workers");
    let mut state = run.state;
    state["workers"] = json!([{"status":"reconciling","step":4},{"status":"done","step":8}]);
    fixture
        .store
        .update_run(&run.id, "interrupted", state)
        .unwrap();
    fixture.store.settle_interrupted(&run.id).unwrap();
    let recovered = fixture.store.run_by_id("connection-a", &run.id).unwrap();
    assert_eq!(recovered.state["workers"][0]["status"], "stopped");
    assert_eq!(recovered.state["workers"][0]["step"], 4);
    assert_eq!(recovered.state["workers"][1]["status"], "done");
}

#[test]
fn lifecycle_operation_baselines_survive_retries_and_keep_associations_scoped() {
    let fixture = Fixture::new();
    let project = fixture
        .store
        .create("connection-a", "Lifecycle association")
        .unwrap();
    let run = fixture.run(&project, "lifecycle-association");
    let baseline = fixture
        .store
        .operation_baseline(&run.id, "stable-action", &["prior-operation".into()])
        .unwrap();
    assert_eq!(baseline, vec!["prior-operation"]);
    let recovered = fixture
        .store
        .operation_baseline(&run.id, "stable-action", &["replacement-operation".into()])
        .unwrap();
    assert_eq!(recovered, baseline);
    fixture
        .store
        .link_operation(&run.id, "stable-action", "provider-operation")
        .unwrap();
    fixture
        .store
        .link_operation(&run.id, "stable-action", "provider-operation")
        .unwrap();
    assert!(
        fixture
            .store
            .action_operations("different-run", "stable-action")
            .unwrap()
            .is_empty()
    );
}
