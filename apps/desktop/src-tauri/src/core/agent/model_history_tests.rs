use super::*;
use rusqlite::params;

#[test]
fn model_request_history_is_scoped_stable_and_excludes_frozen_secrets() {
    let (_temp, store) = fixture();
    let (batch, job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    let (other, other_job, _) = create(&store, snapshot(), Preset::InspectAccounts);
    let db = store.open().unwrap();
    let now = crate::core::agent::now_ms();
    for index in 0..63 {
        let request = format!("11111111-1111-4111-8111-{index:012}");
        let expired = index == 0;
        db.execute(
            "INSERT INTO agent_model_requests(request_id,job_id,batch_id,scope_json,generation,kind,
               endpoint_digest,state,acquired_at,deadline,elapsed_ms,input_tokens,output_tokens,cost_usd,receipt_json)
             VALUES(?1,?2,?3,?4,'fixture-private-generation','generation','fixture-private-endpoint',
               ?5,?6,?7,20,?8,?9,?10,?11)",
            params![
                request,
                job,
                batch,
                "{\"apiKey\":\"fixture-private-key\"}",
                if expired { "active" } else { "failed" },
                now - 10_000,
                if expired { now - 1 } else { now + 120_000 },
                if expired { None } else { Some(2i64) },
                if expired { None } else { Some(1i64) },
                if expired { None } else { Some(0.003) },
                if expired { None } else { Some("{\"status\":429,\"private\":\"fixture-private-body\"}") }
            ],
        ).unwrap();
    }
    db.execute(
        "INSERT INTO agent_model_requests(request_id,job_id,batch_id,scope_json,generation,kind,
           endpoint_digest,state,acquired_at,deadline)
         VALUES(?1,?2,?3,'{}','other','decision','other','active',?4,?5)",
        params![id(), other_job, other, now, now + 120_000],
    )
    .unwrap();
    drop(db);

    let first = store.model_requests(&batch, 1, 50).unwrap();
    let second = store.model_requests(&batch, 2, 50).unwrap();
    assert_eq!(first["batchId"], batch);
    assert_eq!(first["total"], 63);
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    assert_eq!(second["items"].as_array().unwrap().len(), 13);
    assert_eq!(
        first["items"][0]["requestId"],
        "11111111-1111-4111-8111-000000000062"
    );
    let unknown = second["items"].as_array().unwrap().last().unwrap();
    assert_eq!(unknown["state"], "unknown");
    assert!(unknown["inputTokens"].is_null());
    assert!(unknown["estimatedCostUsd"].is_null());
    assert!(unknown["status"].is_null());
    assert_eq!(first["items"][0]["status"], 429);
    for forbidden in ["fixture-private", "apiKey", "scope", "receipt", "endpoint"] {
        assert!(!first.to_string().contains(forbidden));
        assert!(!second.to_string().contains(forbidden));
    }
    let mut ids = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["items"].as_array().unwrap())
        .map(|item| item["requestId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 63);
}

#[test]
fn model_request_history_rejects_unbounded_paging_and_unknown_batches() {
    let (_temp, store) = fixture();
    let (batch, _, _) = create(&store, snapshot(), Preset::InspectAccounts);
    assert!(store.model_requests(&batch, 0, 20).is_err());
    assert!(store.model_requests(&batch, 1, 51).is_err());
    assert!(store.model_requests(&id(), 1, 20).is_err());
    assert!(store.model_requests("not-a-uuid", 1, 20).is_err());
    let empty = store.model_requests(&batch, 1, 20).unwrap();
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["items"], json!([]));
}
