use super::*;
use crate::core::browser::provider::ProviderCapacity;
use rusqlite::params;

#[test]
fn reconciliation_origin_initialization_only_allows_the_frozen_root() {
    let (_temp, store) = fixture();
    let (_, id, _) = create(&store, snapshot(), Preset::InspectAccounts);
    let mut job = claim(&store, &id);
    let root = json!({"url":format!("{}/",job.snapshot.platform_origin)});
    let allowed = crate::core::agent::gateway::origin_initialization;
    assert!(!allowed(&job, "navigate", &root, false).unwrap());
    assert!(allowed(&job, "navigate", &root, true).unwrap());
    job.reconcile_only = true;
    assert!(allowed(&job, "navigate", &root, false).unwrap());
    for input in [
        json!({"url":format!("{}/items/new",job.snapshot.platform_origin)}),
        json!({"url":format!("{}/?redirect=/items/new",job.snapshot.platform_origin)}),
        json!({"url":format!("{}/#submit",job.snapshot.platform_origin)}),
        json!({"url":"https://other.invalid/"}),
        json!({"url":"https://user:pass@www.vinted.com/"}),
        json!({"url":format!("{}/",job.snapshot.platform_origin),"script":"submit()"}),
        json!({"url":format!("{}/",job.snapshot.platform_origin),"initializeOrigin":true}),
    ] {
        assert!(allowed(&job, "navigate", &input, true).is_err());
    }
    assert!(!allowed(&job, "submit", &json!({"target":{"index":1}}), true).unwrap());
    job.reconcile_only = false;
    assert!(
        allowed(
            &job,
            "navigate",
            &json!({"url":root["url"],"initializeOrigin":true}),
            false
        )
        .is_err()
    );
}

fn halt_listing_for_review(store: &AgentStore) -> (String, Job) {
    let mut snap = snapshot();
    snap.products = vec![product(), product()];
    let (_, id, _) = create(store, snap, Preset::PostListing);
    let job = claim(store, &id);
    let mut step = output(StepState::ReviewRequired);
    step.item_updates = vec![ItemUpdate {
        product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
        state: "review_required".into(),
        reason: "Copy needs a decision".into(),
        title: None,
        description: None,
    }];
    store
        .mark_step(job.scope.as_ref().unwrap(), "fixture-generation", &step)
        .unwrap();
    (id, job)
}

#[test]
fn item_decisions_continue_halted_unsubmitted_work_through_dispatch_admission() {
    for action in ["approve", "revise", "skip"] {
        let (_temp, store) = fixture();
        let (id, job) = halt_listing_for_review(&store);
        store.actor_stopped(&id, false).unwrap();
        let controls = store
            .item_control(&ItemControlInput {
                job_id: id.clone(),
                product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
                action: action.into(),
                r#override: (action == "revise").then(|| json!({"title":"Reviewed title"})),
            })
            .unwrap();
        assert_eq!(controls["items"][0]["action"], action);
        assert_eq!(
            store.job(&id).unwrap().snapshot.products,
            job.snapshot.products
        );
        assert_eq!(store.job(&id).unwrap().state, "queued");
        assert!(store.queued().unwrap().contains(&id));
        let resumed = claim(&store, &id);
        assert!(!resumed.reconcile_only);
        assert_eq!(store.controls_get(&id).unwrap(), controls);
    }
}

#[test]
fn item_continuation_waits_for_quiescence_and_survives_restart() {
    let (temp, store) = fixture();
    let (id, job) = halt_listing_for_review(&store);
    store
        .item_control(&ItemControlInput {
            job_id: id.clone(),
            product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
            action: "revise".into(),
            r#override: Some(json!({"description":"Reviewed description"})),
        })
        .unwrap();
    assert_eq!(store.job(&id).unwrap().state, "review_required");
    assert!(store.claim(&id, "replacement").unwrap().is_none());
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    reopened.recover().unwrap();
    assert!(reopened.stopped_control_jobs().unwrap().contains(&id));
    assert!(reopened.claim(&id, "replacement").unwrap().is_none());
    // The service calls this only after host drain and confirmed provider quiescence.
    reopened.actor_stopped(&id, false).unwrap();
    assert_eq!(reopened.job(&id).unwrap().state, "queued");
    assert!(reopened.claim(&id, "replacement").unwrap().is_some());
}

fn running_listing(store: &AgentStore) -> Job {
    let mut snap = snapshot();
    snap.products = vec![product(), product()];
    let (_, id, _) = create(store, snap, Preset::PostListing);
    claim(store, &id)
}

fn decide_running_item(store: &AgentStore, job: &Job, action: &str) -> Value {
    store
        .item_control(&ItemControlInput {
            job_id: job.id.clone(),
            product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
            action: action.into(),
            r#override: (action == "revise").then(|| json!({"title":"Accepted revision"})),
        })
        .unwrap()
}

fn pending_item_continuations(store: &AgentStore, id: &str) -> u64 {
    store
        .open()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM agent_item_continuations WHERE job_id=?1",
            [id],
            |row| read_u64(row, 0),
        )
        .unwrap()
}

#[test]
fn running_item_decision_survives_an_older_model_review_and_waits_for_actor_drain() {
    for action in ["approve", "revise", "skip"] {
        let (_temp, store) = fixture();
        let job = running_listing(&store);
        assert_eq!(store.controls_get(&job.id).unwrap()["revision"], 0);
        let controls = decide_running_item(&store, &job, action);
        assert_eq!(controls["revision"], 1);
        assert_eq!(pending_item_continuations(&store, &job.id), 1);
        assert_eq!(store.job(&job.id).unwrap().state, "running");
        assert!(!store.stopped_control_jobs().unwrap().contains(&job.id));

        let mut stale = output(StepState::ReviewRequired);
        stale.item_updates = vec![ItemUpdate {
            product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
            state: "review_required".into(),
            reason: "Old model decision".into(),
            title: Some("Old model title".into()),
            description: None,
        }];
        store
            .mark_step(job.scope.as_ref().unwrap(), "fixture-generation", &stale)
            .unwrap();
        assert_eq!(store.job(&job.id).unwrap().state, "review_required");
        assert!(store.stopped_control_jobs().unwrap().contains(&job.id));
        assert!(store.claim(&job.id, "replacement").unwrap().is_none());
        store.actor_stopped(&job.id, false).unwrap();
        assert_eq!(store.job(&job.id).unwrap().state, "queued");
        let resumed = claim(&store, &job.id);
        assert_eq!(store.controls_get(&resumed.id).unwrap(), controls);
        assert_eq!(pending_item_continuations(&store, &job.id), 0);
        store
            .mark_step(
                resumed.scope.as_ref().unwrap(),
                "fixture-generation",
                &output(StepState::ReviewRequired),
            )
            .unwrap();
        store.actor_stopped(&job.id, false).unwrap();
        assert_eq!(store.job(&job.id).unwrap().state, "review_required");
        assert!(!store.queued().unwrap().contains(&job.id));
    }
}

#[test]
fn observed_running_decision_cannot_wake_a_later_review_for_another_item() {
    let (_temp, store) = fixture();
    let job = running_listing(&store);
    store.controls_get(&job.id).unwrap();
    decide_running_item(&store, &job, "revise");
    assert_eq!(pending_item_continuations(&store, &job.id), 1);
    assert!(!store.stopped_control_jobs().unwrap().contains(&job.id));
    store.controls_get(&job.id).unwrap();
    assert_eq!(pending_item_continuations(&store, &job.id), 0);
    store
        .mark_step(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Continue),
        )
        .unwrap();
    let mut later = output(StepState::ReviewRequired);
    later.item_updates = vec![ItemUpdate {
        product_id: job.snapshot.products[1]["id"].as_str().unwrap().into(),
        state: "review_required".into(),
        reason: "Different item needs review".into(),
        title: None,
        description: None,
    }];
    store
        .mark_step(job.scope.as_ref().unwrap(), "fixture-generation", &later)
        .unwrap();
    store.actor_stopped(&job.id, false).unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "review_required");
    assert!(!store.queued().unwrap().contains(&job.id));
}

#[test]
fn a_new_running_revision_after_an_acknowledged_decision_still_requests_continuation() {
    let (temp, store) = fixture();
    let job = running_listing(&store);
    decide_running_item(&store, &job, "approve");
    assert_eq!(store.controls_get(&job.id).unwrap()["revision"], 1);
    assert_eq!(pending_item_continuations(&store, &job.id), 0);
    let latest = decide_running_item(&store, &job, "revise");
    assert_eq!(latest["revision"], 2);
    store
        .mark_step(
            job.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::ReviewRequired),
        )
        .unwrap();
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    store.recover().unwrap();
    assert!(store.stopped_control_jobs().unwrap().contains(&job.id));
    store.actor_stopped(&job.id, false).unwrap();
    assert_eq!(store.job(&job.id).unwrap().state, "queued");
    let _resumed = claim(&store, &job.id);
    assert_eq!(store.controls_get(&job.id).unwrap(), latest);
}

#[test]
fn running_decision_does_not_override_explicit_controls_or_unsafe_stop_results() {
    for action in [
        ControlAction::Pause,
        ControlAction::Cancel,
        ControlAction::Takeover,
    ] {
        let (_temp, store) = fixture();
        let job = running_listing(&store);
        decide_running_item(&store, &job, "approve");
        store.control_job(&job.id, action).unwrap();
        store
            .mark_step(
                job.scope.as_ref().unwrap(),
                "fixture-generation",
                &output(StepState::ReviewRequired),
            )
            .unwrap();
        store
            .settle_control(&job.id, action == ControlAction::Cancel)
            .unwrap();
        store.actor_stopped(&job.id, true).unwrap();
        assert_eq!(pending_item_continuations(&store, &job.id), 0);
        assert!(!store.queued().unwrap().contains(&job.id));
    }
    for state in [StepState::Blocked, StepState::ResultUnknown] {
        let (_temp, store) = fixture();
        let job = running_listing(&store);
        decide_running_item(&store, &job, "revise");
        store
            .mark_step(
                job.scope.as_ref().unwrap(),
                "fixture-generation",
                &output(state),
            )
            .unwrap();
        store.actor_stopped(&job.id, false).unwrap();
        assert_eq!(store.job(&job.id).unwrap().state, state.as_str());
        assert!(!store.queued().unwrap().contains(&job.id));
    }
    for confirmed in [false, true] {
        let (_temp, store) = fixture();
        let job = running_listing(&store);
        decide_running_item(&store, &job, "revise");
        let operation = listing_operation(&job, 1);
        store
            .action_prepare(
                job.scope.as_ref().unwrap(),
                "fixture-generation",
                &operation,
                "listing",
                &"a".repeat(64),
            )
            .unwrap();
        store
            .action_submitting(
                job.scope.as_ref().unwrap(),
                "fixture-generation",
                &operation,
            )
            .unwrap();
        if confirmed {
            let result = listing_result(&job, 1);
            let publication = validate_confirmation(&job, &operation, &result)
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
        }
        store
            .mark_step(
                job.scope.as_ref().unwrap(),
                "fixture-generation",
                &output(StepState::ReviewRequired),
            )
            .unwrap();
        store.actor_stopped(&job.id, false).unwrap();
        assert!(!store.queued().unwrap().contains(&job.id));
        assert_eq!(
            store.job(&job.id).unwrap().state,
            if confirmed {
                "review_required"
            } else {
                "result_unknown"
            }
        );
    }
}

#[test]
fn item_decisions_preserve_explicit_stops_and_unknown_outcomes() {
    for action in [
        ControlAction::Pause,
        ControlAction::Cancel,
        ControlAction::Takeover,
    ] {
        let (_temp, store) = fixture();
        let (id, job) = halt_listing_for_review(&store);
        store
            .item_control(&ItemControlInput {
                job_id: id.clone(),
                product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
                action: "approve".into(),
                r#override: None,
            })
            .unwrap();
        store.control_job(&id, action).unwrap();
        store
            .settle_control(&id, action == ControlAction::Cancel)
            .unwrap();
        store.actor_stopped(&id, true).unwrap();
        assert!(!store.queued().unwrap().contains(&id));
        assert!(store.claim(&id, "replacement").unwrap().is_none());
    }
    let (_temp, store) = fixture();
    let (id, job) = halt_listing_for_review(&store);
    let db = store.open().unwrap();
    db.execute(
        "UPDATE agent_jobs SET state='result_unknown' WHERE id=?1",
        [&id],
    )
    .unwrap();
    store.actor_stopped(&id, false).unwrap();
    store
        .item_control(&ItemControlInput {
            job_id: id.clone(),
            product_id: job.snapshot.products[1]["id"].as_str().unwrap().into(),
            action: "skip".into(),
            r#override: None,
        })
        .unwrap();
    assert_eq!(store.job(&id).unwrap().state, "result_unknown");
    assert!(store.claim(&id, "replacement").unwrap().is_none());
    db.execute("UPDATE agent_jobs SET state='blocked' WHERE id=?1", [&id])
        .unwrap();
    assert!(
        store
            .item_control(&ItemControlInput {
                job_id: id,
                product_id: job.snapshot.products[0]["id"].as_str().unwrap().into(),
                action: "approve".into(),
                r#override: None,
            })
            .is_err()
    );
}

#[test]
fn dispatch_scan_reaches_healthy_jobs_after_more_than_one_hundred_resource_conflicts() {
    let (_temp, store) = fixture();
    let snap = snapshot();
    let (_, holder, _) = create(&store, snap.clone(), Preset::InspectAccounts);
    let holder = claim(&store, &holder);
    let db = store.open().unwrap();
    for _ in 0..120 {
        let (_, id, _) = create(&store, snap.clone(), Preset::InspectAccounts);
        db.execute(
            "UPDATE agent_jobs SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
            [&id],
        )
        .unwrap();
    }
    let mut healthy = snapshot();
    healthy.account["platformUserId"] = json!("84");
    healthy.account["homepageUrl"] = json!("https://www.vinted.com/member/84-fixture");
    let (_, healthy, _) = create(&store, healthy, Preset::InspectAccounts);
    let mut cursor = None;
    let first = store.queued_page(&mut cursor).unwrap();
    assert_eq!(first.len(), 100);
    assert!(!first.contains(&healthy));
    for id in first {
        assert!(store.claim(&id, "replacement").unwrap().is_none());
    }
    let second = store.queued_page(&mut cursor).unwrap();
    assert!(second.contains(&healthy));
    assert!(store.claim(&healthy, "replacement").unwrap().is_some());
    store
        .mark_step(
            holder.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&holder.id, true).unwrap();
    let wrapped = store.queued_page(&mut cursor).unwrap();
    assert_eq!(wrapped.len(), 100);
    assert!(store.claim(&wrapped[0], "replacement").unwrap().is_some());
}

#[test]
fn cumulative_controls_utf8_budget_rejects_an_edit_without_committing_any_mutation() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = (0..100).map(|_| product()).collect();
    let products: Vec<String> = snap
        .products
        .iter()
        .map(|p| p["id"].as_str().unwrap().into())
        .collect();
    let (_, job, _) = create(&store, snap, Preset::PostListing);
    for product in &products {
        store
            .item_control(&ItemControlInput {
                job_id: job.clone(),
                product_id: product.clone(),
                action: "revise".into(),
                r#override: Some(json!({"description":"d".repeat(6000)})),
            })
            .unwrap();
    }
    let mut before = store.controls_get(&job).unwrap();
    assert!(crate::core::agent::canonical(&before).len() < 800 * 1024);
    let mut rejected = false;
    for product in &products {
        let old_items = store.items(&job, 1, 50, false).unwrap();
        let result = store.item_control(&ItemControlInput {
            job_id: job.clone(),
            product_id: product.clone(),
            action: "revise".into(),
            r#override: Some(json!({"description":"\u{754c}".repeat(6000)})),
        });
        match result {
            Ok(value) => {
                assert!(crate::core::agent::canonical(&value).len() <= 800 * 1024);
                before = value;
            }
            Err(error) => {
                assert_eq!(error.code, "INVALID_REQUEST");
                assert_eq!(store.controls_get(&job).unwrap(), before);
                assert_eq!(store.items(&job, 1, 50, false).unwrap(), old_items);
                rejected = true;
                break;
            }
        }
    }
    assert!(
        rejected,
        "100 legal per-item Unicode edits exceed the aggregate host budget"
    );
    let approved = store
        .item_control(&ItemControlInput {
            job_id: job,
            product_id: products[99].clone(),
            action: "approve".into(),
            r#override: None,
        })
        .unwrap();
    assert_eq!(
        approved["items"][99]["override"]["description"],
        "d".repeat(6000)
    );
}

fn configured_create(
    store: &AgentStore,
    mut snap: JobSnapshot,
    configuration: Value,
) -> (String, String) {
    let batch = id();
    let job = id();
    // Distinct accounts allow pool competition without bypassing identity locks.
    let identity = (u128::from_le_bytes(*Uuid::new_v4().as_bytes()) % 1_000_000 + 1).to_string();
    snap.account["platformUserId"] = json!(identity);
    snap.account["homepageUrl"] =
        json!(format!("https://www.vinted.com/member/{identity}-fixture"));
    let preset = if snap.products.is_empty() {
        Preset::InspectAccounts
    } else {
        Preset::PostListing
    };
    let draft = input(&snap, preset);
    store
        .create(&batch, &draft, &[(job.clone(), snap)], &configuration)
        .unwrap();
    (batch, job)
}

#[test]
fn retry_deadline_survives_actor_release_and_cannot_bypass_admission() {
    let (temp, store) = fixture();
    let configuration = validate_settings(&settings()).unwrap();
    let (_, job) = configured_create(&store, snapshot(), configuration);
    let claimed = claim(&store, &job);
    let mut step = output(StepState::Continue);
    let db = store.open().unwrap();
    step.retry = Some(StepRetry {
        attempt: 1,
        max_attempts: 2,
        code: "HTTP_429".into(),
        next_attempt_at: crate::core::agent::schema::timestamp(
            &db,
            crate::core::agent::now_ms() + 500,
        )
        .unwrap(),
    });
    store
        .mark_step(claimed.scope.as_ref().unwrap(), "fixture-generation", &step)
        .unwrap();
    assert_eq!(store.job(&job).unwrap().state, "queued");
    assert!(
        store.claim(&job, "replacement").unwrap().is_none(),
        "undrained actor still counts"
    );
    store.actor_stopped(&job, true).unwrap();
    let db = store.open().unwrap();
    let next: i64 = db
        .query_row(
            "SELECT next_attempt FROM agent_dispatch WHERE job_id=?1",
            [&job],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        next >= crate::core::agent::now_ms() + 29_000,
        "native platform cooldown wins over an early plugin deadline"
    );
    drop(db);
    drop(store);
    let reopened = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert!(reopened.claim(&job, "replacement").unwrap().is_none());
    assert_eq!(reopened.job_view(&job).unwrap()["retry"]["attempt"], 1);
}

#[test]
fn invalid_retry_rolls_back_item_and_progress_mutations() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job) = configured_create(&store, snap, validate_settings(&settings()).unwrap());
    let claimed = claim(&store, &job);
    let mut step = output(StepState::Continue);
    step.item_updates = vec![ItemUpdate {
        product_id: claimed.snapshot.products[0]["id"].as_str().unwrap().into(),
        state: "reviewing".into(),
        reason: "candidate".into(),
        title: Some("Changed candidate".into()),
        description: None,
    }];
    step.progress = Some(Progress {
        current_index: 0,
        published: 0,
        skipped: 0,
        current_product_id: Some(step.item_updates[0].product_id.clone()),
    });
    step.retry = Some(StepRetry {
        attempt: 3,
        max_attempts: 3,
        code: "HTTP_429".into(),
        next_attempt_at: "2026-11-13T00:00:00Z".into(),
    });
    assert!(
        store
            .mark_step(claimed.scope.as_ref().unwrap(), "fixture-generation", &step)
            .is_err()
    );
    let items = store.items(&job, 1, 20, false).unwrap();
    assert_eq!(
        items["items"][0]["title"],
        claimed.snapshot.products[0]["title"]
    );
    assert!(store.job_view(&job).unwrap().get("progress").is_none());
}

#[test]
fn configured_provider_limit_and_observed_profile_union_both_gate_claims() {
    let (_temp, store) = fixture();
    let mut configuration = validate_settings(&settings()).unwrap();
    configuration["execution"]["providerConcurrency"]["cloakbrowser"] = json!(1);
    let (_, first) = configured_create(&store, snapshot(), configuration.clone());
    let (_, second) = configured_create(&store, snapshot(), configuration);
    claim(&store, &first);
    assert!(
        store
            .claim(&second, "fixture-generation")
            .unwrap()
            .is_none()
    );
    store.control_job(&first, ControlAction::Pause).unwrap();
    store.settle_control(&first, false).unwrap();
    store.actor_stopped(&first, true).unwrap();
    let candidate = store.job(&second).unwrap();
    let capacity = ProviderCapacity {
        max_running: 1,
        running_profiles: vec!["manual-profile".into()],
    };
    assert!(
        store
            .claim_with_capacity(&second, "fixture-generation", Some(&capacity))
            .unwrap()
            .is_none()
    );
    let capacity = ProviderCapacity {
        max_running: 1,
        running_profiles: vec![candidate.snapshot.profile_id],
    };
    assert!(
        store
            .claim_with_capacity(&second, "fixture-generation", Some(&capacity))
            .unwrap()
            .is_some(),
        "an already-running candidate consumes its existing seat exactly once"
    );
}

#[test]
fn item_revision_closes_the_controls_read_to_intent_race_without_mutating_snapshot() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap, Preset::PostListing);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.as_ref().unwrap();
    let product = claimed.snapshot.products[0]["id"].as_str().unwrap();
    let operation = listing_operation(&claimed, 0);
    assert_eq!(store.controls_get(&job).unwrap()["revision"], 0);
    let response = store
        .item_control(&ItemControlInput {
            job_id: job.clone(),
            product_id: product.into(),
            action: "revise".into(),
            r#override: Some(json!({"title":"Approved amended title"})),
        })
        .unwrap();
    assert_eq!(response["revision"], 1);
    assert!(
        store
            .action_prepare(
                scope,
                "fixture-generation",
                &operation,
                "listing",
                &"a".repeat(64)
            )
            .is_err()
    );
    assert_eq!(
        store.job(&job).unwrap().snapshot.products,
        claimed.snapshot.products
    );
    assert_eq!(
        store.controls_get(&job).unwrap()["items"][0]["override"]["title"],
        "Approved amended title"
    );
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "listing",
            &"a".repeat(64),
        )
        .unwrap();
    assert!(
        store
            .item_control(&ItemControlInput {
                job_id: job.clone(),
                product_id: product.into(),
                action: "skip".into(),
                r#override: None
            })
            .is_err(),
        "saved action intent is immutable"
    );
    store.control_job(&job, ControlAction::Pause).unwrap();
    assert!(
        store
            .action_submitting(scope, "fixture-generation", &operation)
            .is_err(),
        "an action prepared before pause cannot consume submission afterward"
    );
}

#[test]
fn item_controls_merge_edit_fields_and_never_project_fabricated_publication() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let (_, job, _) = create(&store, snap, Preset::PostListing);
    let product = store.job(&job).unwrap().snapshot.products[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for amendment in [json!({"title":"Approved title"}), json!({"price":19.5})] {
        store
            .item_control(&ItemControlInput {
                job_id: job.clone(),
                product_id: product.clone(),
                action: "revise".into(),
                r#override: Some(amendment),
            })
            .unwrap();
    }
    let controls = store.controls_get(&job).unwrap();
    assert_eq!(
        controls["items"][0]["override"],
        json!({"title":"Approved title","price":19.5})
    );
    let claimed = claim(&store, &job);
    store.controls_get(&job).unwrap();
    let mut step = output(StepState::Continue);
    step.item_updates = vec![ItemUpdate {
        product_id: product,
        state: "published".into(),
        reason: "unproven".into(),
        title: None,
        description: None,
    }];
    store
        .mark_step(claimed.scope.as_ref().unwrap(), "fixture-generation", &step)
        .unwrap();
    assert_eq!(
        store.items(&job, 1, 20, true).unwrap()["items"][0]["state"],
        "review_required"
    );
}

#[test]
fn takeover_is_not_ready_until_quiescence_and_unknown_actions_keep_ownership() {
    let (_temp, store) = fixture();
    let (_, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    claim(&store, &job);
    store.control_job(&job, ControlAction::Takeover).unwrap();
    assert_eq!(store.job_view(&job).unwrap()["takeover"], "stopping");
    assert!(store.takeover_settled(&job, true).is_err());
    store.settle_control(&job, false).unwrap();
    assert!(store.takeover_settled(&job, true).is_err());
    store.actor_stopped(&job, true).unwrap();
    store.takeover_settled(&job, true).unwrap();
    assert_eq!(store.job_view(&job).unwrap()["takeover"], "ready");

    let mut snap = snapshot();
    snap.messages = vec![Message {
        conversation_id: "123".into(),
        text: "Fixture".into(),
    }];
    let (_, unknown, _) = create(&store, snap, Preset::Message);
    let claimed = claim(&store, &unknown);
    let scope = claimed.scope.as_ref().unwrap();
    let operation = id();
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "message",
            &"a".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(scope, "fixture-generation", &operation)
        .unwrap();
    store
        .control_job(&unknown, ControlAction::Takeover)
        .unwrap();
    store.settle_control(&unknown, false).unwrap();
    assert!(store.actor_stopped(&unknown, true).is_err());
    store.actor_stopped(&unknown, false).unwrap();
    store.takeover_settled(&unknown, false).unwrap();
    assert_eq!(store.job_view(&unknown).unwrap()["takeover"], "blocked");
}

#[test]
fn independent_model_pool_is_transactional_and_receipts_charge_once() {
    let (_temp, store) = fixture();
    let mut configuration = validate_settings(&settings()).unwrap();
    configuration["execution"]["modelConcurrency"] = json!(1);
    configuration["pricing"] = json!({"decision":{"inputPerMillionUsd":1,"outputPerMillionUsd":2},
        "generation":{"inputPerMillionUsd":3,"outputPerMillionUsd":4}});
    let (batch, first) = configured_create(&store, snapshot(), configuration.clone());
    let (_, second) = configured_create(&store, snapshot(), configuration);
    let first = claim(&store, &first);
    let second = claim(&store, &second);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for job in [first.clone(), second.clone()] {
        let store = store.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let request = ModelAcquire {
                request_id: id(),
                kind: "decision".into(),
            };
            barrier.wait();
            let response = store
                .model_acquire(job.scope.as_ref().unwrap(), "fixture-generation", &request)
                .unwrap();
            (job, request, response)
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(
        results
            .iter()
            .filter(|(_, _, r)| r["acquired"] == true)
            .count(),
        1
    );
    let (winner, request, _) = results
        .iter()
        .find(|(_, _, r)| r["acquired"] == true)
        .unwrap();
    let receipt = ModelComplete {
        request_id: request.request_id.clone(),
        outcome: "succeeded".into(),
        elapsed_ms: 150,
        input_tokens: Some(1000),
        output_tokens: Some(500),
        status: Some(200),
    };
    store
        .model_complete(
            winner.scope.as_ref().unwrap(),
            "fixture-generation",
            &receipt,
        )
        .unwrap();
    store
        .model_complete(
            winner.scope.as_ref().unwrap(),
            "fixture-generation",
            &receipt,
        )
        .unwrap();
    let usage = store.usage(&winner.batch_id).unwrap();
    assert_eq!(usage["requests"], 1);
    assert_eq!(usage["elapsedMs"], 150);
    assert_eq!(usage["estimatedCostUsd"], 0.002);
    let mut forged = receipt;
    forged.output_tokens = Some(501);
    assert!(
        store
            .model_complete(
                winner.scope.as_ref().unwrap(),
                "fixture-generation",
                &forged
            )
            .is_err()
    );
    assert!(store.usage(&batch).is_ok());
}

#[test]
fn expired_model_id_cannot_reacquire_and_cost_unknown_blocks_budgeted_work() {
    let (_temp, store) = fixture();
    let mut configuration = validate_settings(&settings()).unwrap();
    configuration["execution"]["maxBatchCostUsd"] = json!(1);
    configuration["pricing"] = json!({"decision":{"inputPerMillionUsd":1,"outputPerMillionUsd":1},
        "generation":{"inputPerMillionUsd":1,"outputPerMillionUsd":1}});
    let (_, job) = configured_create(&store, snapshot(), configuration);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.as_ref().unwrap();
    let request = ModelAcquire {
        request_id: id(),
        kind: "generation".into(),
    };
    store
        .model_acquire(scope, "fixture-generation", &request)
        .unwrap();
    let pending = store
        .model_acquire(
            scope,
            "fixture-generation",
            &ModelAcquire {
                request_id: id(),
                kind: "decision".into(),
            },
        )
        .unwrap();
    assert_eq!(pending["acquired"], false);
    assert_eq!(
        pending["reason"], "capacity",
        "cost-budgeted batches serialize their pending model work"
    );
    store
        .open()
        .unwrap()
        .execute(
            "UPDATE agent_model_requests SET deadline=0 WHERE request_id=?1",
            [&request.request_id],
        )
        .unwrap();
    assert!(
        store
            .model_acquire(scope, "fixture-generation", &request)
            .is_err()
    );
    let next = ModelAcquire {
        request_id: id(),
        kind: "generation".into(),
    };
    let blocked = store
        .model_acquire(scope, "fixture-generation", &next)
        .unwrap();
    assert_eq!(blocked["acquired"], false);
    assert_eq!(blocked["reason"], "budget");
    assert!(store.usage(&claimed.batch_id).unwrap()["estimatedCostUsd"].is_null());
}

#[test]
fn workspace_conflict_preserves_the_winning_revision_after_restart() {
    let (temp, store) = fixture();
    let mut input = WorkspaceSave {
        id: id(),
        kind: "draft".into(),
        name: "Fixture draft".into(),
        expected_revision: 0,
        data: SavedPlan {
            preset: Preset::PostListing,
            instruction: String::new(),
            concurrency: 3,
            product_ids: vec![],
            window_ids: vec![],
            assignments: vec![],
            unassigned_overrides: vec![],
        },
    };
    assert_eq!(store.workspace_save(&input).unwrap()["revision"], 1);
    assert!(store.workspace_save(&input).is_err());
    input.expected_revision = 1;
    input.name = "Saved revision".into();
    assert_eq!(store.workspace_save(&input).unwrap()["revision"], 2);
    assert!(store.workspace_delete(&input.id, 1).is_err());
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert_eq!(
        store.workspace_get(&input.id).unwrap()["name"],
        "Saved revision"
    );
    assert_eq!(
        store.workspace_list(Some("draft"), 1, 20).unwrap()["total"],
        1
    );
    assert_eq!(
        store.workspace_delete(&input.id, 2).unwrap()["deleted"],
        true
    );
}

#[test]
fn workspace_rejects_aggregate_message_overflow_but_preserves_incomplete_mixed_drafts() {
    let (_temp, store) = fixture();
    let windows = vec![id(), id()];
    let assignments = windows
        .iter()
        .map(|window| Assignment {
            window_id: window.clone(),
            product_ids: vec![],
            overrides: vec![],
            messages: (0..51)
                .map(|i| Message {
                    conversation_id: (i + 1).to_string(),
                    text: "Fixture message".into(),
                })
                .collect(),
        })
        .collect();
    let mut draft = WorkspaceSave {
        id: id(),
        kind: "draft".into(),
        name: "Unfinished fixture".into(),
        expected_revision: 0,
        data: SavedPlan {
            preset: Preset::PostListing,
            instruction: String::new(),
            concurrency: 3,
            product_ids: vec![id()],
            window_ids: windows,
            assignments,
            unassigned_overrides: vec![],
        },
    };
    assert!(store.workspace_save(&draft).is_err());
    draft.data.assignments[1].messages.truncate(49);
    assert_eq!(
        store.workspace_save(&draft).unwrap()["revision"],
        1,
        "incomplete listing drafts retain message input and unassigned selections"
    );
}

#[test]
fn workspace_budget_measures_serialized_utf8_and_accepts_100_ascii_product_descriptions() {
    let (_temp, store) = fixture();
    let window = id();
    let products: Vec<String> = (0..100).map(|_| id()).collect();
    let overrides: Vec<ProductOverride> = products
        .iter()
        .map(|product| {
            serde_json::from_value(json!({"productId":product,"description":"界".repeat(6000)}))
                .unwrap()
        })
        .collect();
    let mut saved = WorkspaceSave {
        id: id(),
        kind: "template".into(),
        name: "Full fixture".into(),
        expected_revision: 0,
        data: SavedPlan {
            preset: Preset::PostListing,
            instruction: String::new(),
            concurrency: 3,
            product_ids: products.clone(),
            window_ids: vec![window.clone()],
            assignments: vec![Assignment {
                window_id: window,
                product_ids: products,
                overrides,
                messages: vec![],
            }],
            unassigned_overrides: vec![],
        },
    };
    assert!(
        store.workspace_save(&saved).is_err(),
        "character limits do not replace the UTF8 storage budget"
    );
    saved.data.unassigned_overrides = saved.data.assignments[0].overrides.split_off(50);
    saved.data.assignments[0].product_ids.truncate(50);
    for item in saved.data.assignments[0]
        .overrides
        .iter_mut()
        .chain(&mut saved.data.unassigned_overrides)
    {
        item.description = Some("\u{754c}".repeat(4000));
    }
    assert!(
        store.workspace_save(&saved).is_err(),
        "assigned and unassigned edits share one serialized UTF8 budget"
    );
    for item in saved.data.assignments[0]
        .overrides
        .iter_mut()
        .chain(&mut saved.data.unassigned_overrides)
    {
        item.description = Some("d".repeat(6000));
    }
    assert_eq!(store.workspace_save(&saved).unwrap()["revision"], 1);
}

#[test]
fn incomplete_draft_retains_unassigned_edits_with_strict_ownership_and_revision_validation() {
    let (temp, store) = fixture();
    let product = id();
    let window = id();
    let mut draft: WorkspaceSave = serde_json::from_value(json!({
        "id":id(),"kind":"draft","name":"Unassigned fixture","expectedRevision":0,
        "data":{"preset":"post_listing","productIds":[product],"windowIds":[window],
            "unassignedOverrides":[{"productId":product,"title":"Unassigned title","price":12.5}]}
    }))
    .unwrap();
    let saved = store.workspace_save(&draft).unwrap();
    assert_eq!(
        saved["data"]["unassignedOverrides"][0]["title"],
        "Unassigned title"
    );
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert_eq!(
        store.workspace_get(&draft.id).unwrap()["data"],
        saved["data"]
    );
    draft.expected_revision = 1;
    let mut invalid = draft.clone();
    invalid
        .data
        .unassigned_overrides
        .push(invalid.data.unassigned_overrides[0].clone());
    assert!(store.workspace_save(&invalid).is_err());
    invalid.data.unassigned_overrides.truncate(1);
    invalid.data.unassigned_overrides[0].product_id = id();
    assert!(store.workspace_save(&invalid).is_err());
    invalid = draft.clone();
    invalid.data.unassigned_overrides[0].price = Some(-1.0);
    assert!(store.workspace_save(&invalid).is_err());
    invalid = draft.clone();
    invalid.data.assignments.push(Assignment {
        window_id: window.clone(),
        product_ids: vec![product.clone()],
        overrides: vec![],
        messages: vec![],
    });
    assert!(
        store.workspace_save(&invalid).is_err(),
        "assigned edits cannot remain at the root"
    );
    assert_eq!(store.workspace_get(&draft.id).unwrap()["revision"], 1);
    assert_eq!(
        store.workspace_get(&draft.id).unwrap()["data"],
        saved["data"]
    );
    draft.data.assignments.push(Assignment {
        window_id: window,
        product_ids: vec![product],
        overrides: std::mem::take(&mut draft.data.unassigned_overrides),
        messages: vec![],
    });
    let assigned = store.workspace_save(&draft).unwrap();
    assert_eq!(assigned["revision"], 2);
    assert_eq!(assigned["data"]["unassignedOverrides"], json!([]));
    assert_eq!(
        assigned["data"]["assignments"][0]["overrides"][0]["title"],
        "Unassigned title"
    );
    let empty: SavedPlan = serde_json::from_value(json!({"preset":"post_listing"})).unwrap();
    assert!(empty.unassigned_overrides.is_empty());
}

#[test]
fn listing_receipt_cannot_switch_the_product_bound_to_a_durable_intent() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product(), product()];
    let (_, job, _) = create(&store, snap, Preset::PostListing);
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
    let wrong = listing_result(&claimed, 1);
    let publication = validate_confirmation(&claimed, &operation, &wrong)
        .unwrap()
        .unwrap();
    assert!(
        store
            .action_confirm(
                scope,
                "fixture-generation",
                &operation,
                &wrong,
                Some(&publication)
            )
            .is_err()
    );
    assert_eq!(
        store.action_get(scope, &operation).unwrap()["state"],
        "unknown"
    );
    assert!(store.due_outbox().unwrap().is_empty());
}

#[test]
fn model_rate_and_request_budget_are_independent_of_released_model_slots() {
    let (_temp, store) = fixture();
    let mut configuration = validate_settings(&settings()).unwrap();
    configuration["execution"]["modelRequestsPerMinute"] = json!(1);
    configuration["execution"]["maxBatchModelRequests"] = json!(2);
    let (_, job) = configured_create(&store, snapshot(), configuration);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.as_ref().unwrap();
    let first = ModelAcquire {
        request_id: id(),
        kind: "decision".into(),
    };
    store
        .model_acquire(scope, "fixture-generation", &first)
        .unwrap();
    store
        .model_complete(
            scope,
            "fixture-generation",
            &ModelComplete {
                request_id: first.request_id,
                outcome: "succeeded".into(),
                elapsed_ms: 1,
                input_tokens: None,
                output_tokens: None,
                status: Some(200),
            },
        )
        .unwrap();
    let second = ModelAcquire {
        request_id: id(),
        kind: "generation".into(),
    };
    assert_eq!(
        store
            .model_acquire(scope, "fixture-generation", &second)
            .unwrap()["reason"],
        "rate"
    );
    let db = store.open().unwrap();
    db.execute("UPDATE agent_model_requests SET acquired_at=0", [])
        .unwrap();
    assert_eq!(
        store
            .model_acquire(scope, "fixture-generation", &second)
            .unwrap()["acquired"],
        true
    );
    db.execute("UPDATE agent_model_requests SET acquired_at=0", [])
        .unwrap();
    assert_eq!(
        store
            .model_acquire(
                scope,
                "fixture-generation",
                &ModelAcquire {
                    request_id: id(),
                    kind: "decision".into()
                }
            )
            .unwrap()["reason"],
        "budget"
    );
}

#[test]
fn notification_failures_exhaust_four_attempts_without_an_unbounded_resend_loop() {
    let (_temp, store) = fixture();
    let mut configuration = validate_settings(&settings()).unwrap();
    configuration["notifications"]["enabled"] = json!(true);
    configuration["notifications"]["deviceKey"] = json!("fixture-only");
    let (_, job) = configured_create(&store, snapshot(), configuration);
    let claimed = claim(&store, &job);
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    let mut stable = None;
    for _ in 0..4 {
        let due = store.due_notifications().unwrap();
        assert_eq!(due.len(), 1);
        let id = due[0]["notificationId"].as_str().unwrap().to_owned();
        if let Some(previous) = &stable {
            assert_eq!(previous, &id);
        } else {
            stable = Some(id.clone());
        }
        store.notification_result(&id, Some("UNAVAILABLE")).unwrap();
        store
            .open()
            .unwrap()
            .execute("UPDATE agent_notification_outbox SET next_attempt=0", [])
            .unwrap();
    }
    assert!(store.due_notifications().unwrap().is_empty());
    assert_eq!(
        store.usage(&claimed.batch_id).unwrap()["notification"],
        "failed"
    );
}

#[test]
fn retention_protects_uncertain_journal_even_after_actor_and_all_resources_are_absent() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.messages = vec![Message {
        conversation_id: "123".into(),
        text: "Fixture".into(),
    }];
    let (batch, job, _) = create(&store, snap, Preset::Message);
    let claimed = claim(&store, &job);
    let scope = claimed.scope.as_ref().unwrap();
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &id(),
            "message",
            &"a".repeat(64),
        )
        .unwrap();
    let db = store.open().unwrap();
    db.execute("UPDATE agent_jobs SET state='failed',actor_owned=0,updated_at='2020-01-01T00:00:00.000Z' WHERE id=?1",[&job]).unwrap();
    db.execute("DELETE FROM agent_resources WHERE job_id=?1", [&job])
        .unwrap();
    db.execute(
        "UPDATE agent_batches SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
        [&batch],
    )
    .unwrap();
    let preview = store.retention_preview(30).unwrap();
    assert_eq!(preview["batches"], 0);
    assert_eq!(preview["protected"], 1);
    assert_eq!(
        store
            .retention_delete(preview["token"].as_str().unwrap())
            .unwrap(),
        0
    );
    assert!(store.batch_view(&batch).is_ok());
}

#[test]
fn artifact_cleanup_rejects_unrecognized_entries_and_counts_only_removed_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let artifacts = Artifacts::new(temp.path().join("artifacts")).unwrap();
    let batch = id();
    artifacts.begin(&batch).unwrap();
    let directory = temp.path().join("artifacts").join(&batch);
    std::fs::write(directory.join("user-notes.txt"), b"preserve").unwrap();
    assert!(artifacts.remove_retained_batch(&batch).is_err());
    assert_eq!(
        std::fs::read(directory.join("user-notes.txt")).unwrap(),
        b"preserve"
    );
    std::fs::remove_file(directory.join("user-notes.txt")).unwrap();
    std::fs::write(directory.join(format!("{}.png", id())), b"fixture").unwrap();
    assert_eq!(artifacts.remove_retained_batch(&batch).unwrap(), 7);
    assert_eq!(artifacts.remove_retained_batch(&batch).unwrap(), 0);
}

#[test]
fn archived_message_batch_operation_cannot_replay_after_reopen_or_change_its_body() {
    let (temp, store) = fixture();
    let mut snap = snapshot();
    snap.messages = vec![Message {
        conversation_id: "123".into(),
        text: "Fixture message".into(),
    }];
    let (batch, job, draft) = create(&store, snap.clone(), Preset::Message);
    let claimed = claim(&store, &job);
    let operation = id();
    let scope = claimed.scope.as_ref().unwrap();
    store
        .action_prepare(
            scope,
            "fixture-generation",
            &operation,
            "message",
            &"f".repeat(64),
        )
        .unwrap();
    store
        .action_submitting(scope, "fixture-generation", &operation)
        .unwrap();
    let result = json!({"kind":"message","conversationId":"123","text":"Fixture message",
        "confirmedAt":"2026-11-13T01:02:04.000Z",
        "evidence":{"messageId":"91827","sentAt":"2026-11-13T01:02:03.000Z"}});
    assert!(
        validate_confirmation(&claimed, &operation, &result)
            .unwrap()
            .is_none()
    );
    store
        .action_confirm(scope, "fixture-generation", &operation, &result, None)
        .unwrap();
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    let db = store.open().unwrap();
    db.execute(
        "UPDATE agent_batches SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
        [&batch],
    )
    .unwrap();
    db.execute(
        "UPDATE agent_jobs SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
        [&job],
    )
    .unwrap();
    let preview = store.retention_preview(30).unwrap();
    assert_eq!(
        store
            .retention_delete(preview["token"].as_str().unwrap())
            .unwrap(),
        1
    );
    drop(db);
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    let body = crate::core::agent::canonical(&serde_json::to_value(&draft).unwrap());
    assert_eq!(
        store
            .find_operation(&draft.operation_id, &body)
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        store
            .create(&id(), &draft, &[(id(), snap.clone())], &settings())
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    let mut changed = draft.clone();
    changed.assignments[0].messages[0].text = "Different message".into();
    assert_eq!(
        store
            .create(&id(), &changed, &[(id(), snap.clone())], &settings())
            .unwrap_err()
            .code,
        "CONFLICT"
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
    let mut fresh = draft;
    fresh.operation_id = id();
    assert!(
        store
            .create(&id(), &fresh, &[(id(), snap)], &settings())
            .is_ok(),
        "a deliberate new operation is a separate instruction"
    );
}

#[test]
fn related_lookup_includes_completed_jobs_by_stable_snapshot_ids_with_pagination() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let window = snap.window_id.clone();
    let account = snap.account_id().unwrap().to_owned();
    let product = snap.products[0]["id"].as_str().unwrap().to_owned();
    let (batch, job, _) = create(&store, snap, Preset::PostListing);
    let claimed = claim(&store, &job);
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    for (kind, id) in [
        ("window", &window),
        ("account", &account),
        ("product", &product),
    ] {
        let related = store.related(kind, id, 1, 1).unwrap();
        assert_eq!(related["total"], 1);
        assert_eq!(related["items"][0]["batchId"], batch);
        assert_eq!(related["items"][0]["state"], "completed");
        assert_eq!(store.related(kind, id, 2, 1).unwrap()["items"], json!([]));
    }
    assert_eq!(store.related("attention", "", 1, 20).unwrap()["total"], 0);
    assert!(store.related("account", &id(), 1, 51).is_err());
}

#[test]
fn notification_id_survives_crash_and_retry_never_recreates_a_sent_delivery() {
    let (temp, store) = fixture();
    let mut configuration = validate_settings(&settings()).unwrap();
    configuration["notifications"]["enabled"] = json!(true);
    configuration["notifications"]["deviceKey"] = json!("fixture-device");
    let (_, job) = configured_create(&store, snapshot(), configuration);
    let claimed = claim(&store, &job);
    store
        .mark_step(
            claimed.scope.as_ref().unwrap(),
            "fixture-generation",
            &output(StepState::Completed),
        )
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    let first = store.due_notifications().unwrap();
    assert_eq!(first.len(), 1);
    let notification = first[0]["notificationId"].as_str().unwrap().to_owned();
    drop(store);
    let store = AgentStore::new(temp.path().join("nexus.sqlite")).unwrap();
    assert!(
        store.due_notifications().unwrap().is_empty(),
        "reserved delivery waits its retry deadline"
    );
    store
        .open()
        .unwrap()
        .execute("UPDATE agent_notification_outbox SET next_attempt=0", [])
        .unwrap();
    let retry = store.due_notifications().unwrap();
    assert_eq!(retry[0]["notificationId"], notification);
    store.notification_result(&notification, None).unwrap();
    store
        .notification_result(&notification, Some("LATE_FAILURE"))
        .unwrap();
    assert!(store.due_notifications().unwrap().is_empty());
    assert_eq!(
        store.usage(&claimed.batch_id).unwrap()["notification"],
        "sent"
    );
}

#[test]
fn retention_rechecks_protection_and_archives_publication_facts() {
    let (_temp, store) = fixture();
    let mut snap = snapshot();
    snap.products = vec![product()];
    let original = snap.clone();
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
            &"f".repeat(64),
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
    store.outbox_result(&operation, None).unwrap();
    store
        .mark_step(scope, "fixture-generation", &output(StepState::Completed))
        .unwrap();
    store.actor_stopped(&job, true).unwrap();
    let db = store.open().unwrap();
    db.execute(
        "UPDATE agent_batches SET updated_at='2020-01-01T00:00:00.000Z'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE agent_jobs SET updated_at='2020-01-01T00:00:00.000Z'",
        [],
    )
    .unwrap();
    let preview = store.retention_preview(30).unwrap();
    assert_eq!(preview["batches"], 1);
    db.execute("INSERT INTO agent_resources(resource_key,job_id,lease_id,fence) VALUES('fixture-protection',?1,?2,1)",
        params![job,id()]).unwrap();
    assert!(
        store
            .retention_delete(preview["token"].as_str().unwrap())
            .is_err()
    );
    assert!(
        store.batch_view(&batch).is_ok(),
        "failed revalidation deletes nothing"
    );
    db.execute(
        "DELETE FROM agent_resources WHERE resource_key='fixture-protection'",
        [],
    )
    .unwrap();
    assert_eq!(
        store
            .retention_delete(preview["token"].as_str().unwrap())
            .unwrap(),
        1
    );
    assert!(
        store
            .retention_delete(preview["token"].as_str().unwrap())
            .is_err(),
        "preview tokens are single use"
    );
    let count: u64 = db
        .query_row(
            "SELECT COUNT(*) FROM agent_archived_publications WHERE operation_id=?1",
            [&operation],
            |r| read_u64(r, 0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let draft = input(&original, Preset::PostListing);
    assert!(
        store
            .create(&id(), &draft, &[(id(), original)], &settings())
            .is_err(),
        "cleaning execution history must never permit duplicate local publication"
    );
}
