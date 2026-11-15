use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::dto::*;
use super::gateway::{fields, validate_timestamp};
use super::store::{AgentStore, Job, read_job, validate_lease};
use super::{AgentResult, canonical, conflict, denied, invalid, now_ms, storage_error};

pub(super) const RULES_VERSION: &str = "vinted-listing-v2";

fn digest(value: &Value) -> String {
    fn array_index(key: &str) -> Option<u32> {
        let index: u32 = key.parse().ok()?;
        (index != u32::MAX && index.to_string() == key).then_some(index)
    }
    fn encode(value: &Value) -> String {
        match value {
            Value::Object(object) => {
                let mut entries: Vec<_> = object.iter().collect();
                // Object.fromEntries sorts UTF-16 keys, then JSON.stringify
                // enumerates numeric property names first in numeric order.
                entries.sort_by(|(a, _), (b, _)| match (array_index(a), array_index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
                });
                format!(
                    "{{{}}}",
                    entries
                        .into_iter()
                        .map(|(key, value)| format!("{}:{}", json!(key), encode(value)))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            Value::Array(array) => format!(
                "[{}]",
                array.iter().map(encode).collect::<Vec<_>>().join(",")
            ),
            _ => value.to_string(),
        }
    }
    format!("{:x}", Sha256::digest(encode(value).as_bytes()))
}

// Match String(number) in content/context.ts; these values are finite and
// bounded at the product/settings boundary.
fn number_string(value: &Value) -> AgentResult<String> {
    let n = value
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| invalid("Content context requires a finite number"))?;
    if n == 0.0 {
        return Ok("0".into());
    }
    if n.abs() < 0.000001 {
        return Ok(format!("{n:e}"));
    }
    Ok(n.to_string())
}

pub(super) fn project_product(value: &Value) -> AgentResult<Value> {
    let mut product = serde_json::Map::new();
    for key in [
        "id",
        "revision",
        "name",
        "title",
        "description",
        "price",
        "currency",
        "category",
        "condition",
        "brand",
        "size",
        "tags",
        "platformFacts",
        "images",
    ] {
        let field = value
            .get(key)
            .cloned()
            .ok_or_else(|| invalid("Incomplete product snapshot"))?;
        product.insert(key.into(), field);
    }
    validate_platform_facts(&product["platformFacts"])?;
    Ok(Value::Object(product))
}

pub(super) fn validate_platform_facts(value: &Value) -> AgentResult<()> {
    fields(value, &["vinted"])?;
    let entries = value["vinted"]
        .as_array()
        .filter(|entries| entries.len() <= 24)
        .ok_or_else(|| invalid("Product platform facts must be a bounded Vinted list"))?;
    let mut origins = std::collections::HashSet::new();
    for entry in entries {
        fields(
            entry,
            &[
                "platformOrigin",
                "catalogId",
                "catalogRevision",
                "attributes",
            ],
        )?;
        let origin = entry["platformOrigin"]
            .as_str()
            .ok_or_else(|| invalid("Product facts require an exact market origin"))?;
        super::service::validate_platform_origin(origin)?;
        if !origins.insert(origin) {
            return Err(invalid("Product facts cannot repeat a market origin"));
        }
        match entry.get("catalogId") {
            Some(Value::Null) => {}
            Some(id)
                if id
                    .as_u64()
                    .is_some_and(|id| (1..=9_007_199_254_740_991).contains(&id)) => {}
            _ => {
                return Err(invalid(
                    "Product facts require a positive catalog ID or null",
                ));
            }
        }
        match entry.get("catalogRevision") {
            Some(Value::Null) => {}
            Some(Value::String(revision))
                if !entry["catalogId"].is_null()
                    && revision.len() == 64
                    && revision
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {}
            _ => {
                return Err(invalid(
                    "Product catalog revisions require an ID and SHA256 digest",
                ));
            }
        }
        let attributes = entry["attributes"]
            .as_object()
            .filter(|attributes| attributes.len() <= 20)
            .ok_or_else(|| invalid("Product facts allow at most 20 confirmed attributes"))?;
        for (name, value) in attributes {
            let value = value
                .as_str()
                .ok_or_else(|| invalid("Invalid confirmed attribute"))?;
            text(name, 1, 120)?;
            text(value, 1, 200)?;
            if name.trim() != name || value.trim() != value {
                return Err(invalid(
                    "Confirmed attributes must be nonblank trimmed strings",
                ));
            }
        }
    }
    Ok(())
}

fn without_artifacts(product: &Value) -> AgentResult<Value> {
    let mut source = product.clone();
    source
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid content source"))?
        .remove("preparationInput");
    source["price"] = json!(number_string(&source["price"])?);
    let images = source["images"]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid frozen images"))?;
    for image in images {
        image
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid frozen image"))?
            .remove("artifactId");
    }
    Ok(source)
}

pub(super) fn context(
    product: &Value,
    settings: &Value,
    origin: &str,
    instruction: &str,
) -> AgentResult<Value> {
    let source_digest = digest(&without_artifacts(product)?);
    let model_digest = digest(&json!({
        "decision": {
            "baseUrl":settings["decision"]["baseUrl"],
            "model":settings["decision"]["model"],
            "protocol":settings["decision"]["protocol"].as_str().unwrap_or("typesafe")
        },
        "generation":{"baseUrl":settings["generation"]["baseUrl"],"model":settings["generation"]["model"]},
        "reviewThreshold":number_string(&settings["reviewThreshold"])?,
        "maxCopyRewrites":settings["maxCopyRewrites"],
        "instruction":instruction
    }));
    let mut input = json!({"sourceDigest":source_digest,"modelDigest":model_digest,
        "rulesVersion":RULES_VERSION,"platformOrigin":origin});
    input["contentKey"] = json!(digest(&input));
    Ok(input)
}

pub(super) fn effective_product(
    db: &Connection,
    job: &Job,
    id: &str,
) -> AgentResult<(Value, u64, Option<String>)> {
    let original = job
        .snapshot
        .products
        .iter()
        .find(|p| p["id"].as_str() == Some(id))
        .ok_or_else(|| denied("Product is outside this job's frozen assignment"))?;
    let (amendment, revision, action, _submitted): (Option<String>, u64, Option<String>, bool) = db.query_row(
        "SELECT override_json,control_revision,control_action,submitted FROM agent_items WHERE job_id=?1 AND product_id=?2",
        params![job.id,id], |r| Ok((r.get(0)?,super::sql::read_u64(r,1)?,r.get(2)?,r.get(3)?)),
    ).map_err(storage_error)?;
    let mut product = project_product(original)?;
    if let Some(amendment) = amendment {
        let amendment: Value = serde_json::from_str(&amendment).map_err(storage_error)?;
        super::items::validate_override(id, &amendment)?;
        for (key, value) in amendment
            .as_object()
            .ok_or_else(|| invalid("Invalid saved item amendment"))?
        {
            product[key] = value.clone();
        }
    }
    Ok((product, revision, action))
}

fn expected(
    db: &Connection,
    job: &Job,
    id: &str,
    key: &str,
) -> AgentResult<(Value, u64, Option<String>)> {
    uuid(id)?;
    let (source, revision, action) = effective_product(db, job, id)?;
    let input = context(
        &source,
        &job.settings,
        &job.snapshot.platform_origin,
        &job.instruction,
    )?;
    if input["contentKey"].as_str() != Some(key) {
        return Err(conflict(
            "Preparation content or review context has changed",
        ));
    }
    Ok((source, revision, action))
}

fn validate_package(
    db: &Connection,
    job: &Job,
    source: &Value,
    package: &Value,
) -> AgentResult<()> {
    fields(
        package,
        &[
            "version",
            "state",
            "reason",
            "productId",
            "productRevision",
            "sourceDigest",
            "modelDigest",
            "rulesVersion",
            "platformOrigin",
            "product",
            "fallback",
            "reviewedAt",
        ],
    )?;
    if canonical(package).len() > 64 * 1024
        || super::store::private_checkpoint_data(package, &job.settings)
    {
        return Err(invalid("Preparation exceeds its public content budget"));
    }
    let ctx = context(
        source,
        &job.settings,
        &job.snapshot.platform_origin,
        &job.instruction,
    )?;
    if package["version"] != 1
        || package["productId"] != source["id"]
        || package["productRevision"] != source["revision"]
        || [
            "sourceDigest",
            "modelDigest",
            "rulesVersion",
            "platformOrigin",
        ]
        .iter()
        .any(|key| package[*key] != ctx[*key])
    {
        return Err(denied(
            "Preparation is not bound to the frozen source and review rules",
        ));
    }
    text(
        package["reason"]
            .as_str()
            .ok_or_else(|| invalid("Preparation reason is required"))?,
        0,
        1000,
    )?;
    let reviewed = package["reviewedAt"]
        .as_str()
        .ok_or_else(|| invalid("Preparation review time is required"))?;
    validate_timestamp(reviewed)?;
    if super::schema::millis(db, reviewed)? > now_ms() + 5000 {
        return Err(invalid("Preparation review time is in the future"));
    }
    match package["state"].as_str() {
        Some("approved") => {
            let final_product = &package["product"];
            super::service::validate_listing_product(final_product)?;
            if final_product.get("preparationInput").is_some() {
                return Err(invalid("Approved products cannot contain step decorations"));
            }
            let mut final_facts = final_product.clone();
            final_facts["title"] = source["title"].clone();
            final_facts["description"] = source["description"].clone();
            final_facts["price"] = json!(number_string(&final_facts["price"])?);
            let mut source_facts = source.clone();
            source_facts["price"] = json!(number_string(&source_facts["price"])?);
            if canonical(&final_facts) != canonical(&source_facts) {
                return Err(denied(
                    "Preparation may change only the frozen title and description",
                ));
            }
        }
        Some("review_required" | "failed" | "skipped") if package["product"].is_null() => {}
        _ => return Err(invalid("Invalid preparation state or final product")),
    }
    if package.get("product").is_none() || package.get("fallback").is_none() {
        return Err(invalid(
            "Preparation requires explicit product and fallback fields",
        ));
    }
    validate_fallback(&package["fallback"], &job.snapshot.platform_origin)
}

fn validate_fallback(value: &Value, origin: &str) -> AgentResult<()> {
    if value.is_null() {
        return Ok(());
    }
    fields(
        value,
        &[
            "market",
            "catalogId",
            "pathIds",
            "pathTitles",
            "catalogRevision",
            "source",
            "modelVersion",
            "rulesVersion",
        ],
    )?;
    let ids = value["pathIds"]
        .as_array()
        .ok_or_else(|| invalid("Fallback path IDs are missing"))?;
    let titles = value["pathTitles"]
        .as_array()
        .ok_or_else(|| invalid("Fallback path titles are missing"))?;
    let revision = value["catalogRevision"].as_str().unwrap_or("");
    if value["market"] != "US"
        || origin != "https://www.vinted.com"
        || !matches!(value["source"].as_str(), Some("manual" | "jev"))
        || ids.is_empty()
        || ids.len() > 10
        || ids.len() != titles.len()
        || ids.iter().any(|id| {
            id.as_u64()
                .is_none_or(|id| id == 0 || id > 9_007_199_254_740_991)
        })
        || ids.last() != Some(&value["catalogId"])
        || ids
            .iter()
            .map(canonical)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != ids.len()
        || revision.len() != 64
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid(
            "Fallback is outside the frozen bounded catalog scope",
        ));
    }
    for title in titles {
        text(
            title
                .as_str()
                .ok_or_else(|| invalid("Invalid fallback path title"))?,
            1,
            200,
        )?;
    }
    text(
        value["rulesVersion"]
            .as_str()
            .ok_or_else(|| invalid("Fallback rules are missing"))?,
        1,
        100,
    )?;
    match value.get("modelVersion") {
        Some(Value::Null) => {}
        Some(Value::String(model)) => text(model, 1, 200)?,
        _ => return Err(invalid("Fallback model version is missing")),
    }
    Ok(())
}

fn rebind(package: &mut Value, source: &Value) -> AgentResult<()> {
    if package["state"] != "approved" {
        return Ok(());
    }
    // Cache identities bind image content/order; locations belong to this job.
    let images = package["product"]["images"]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid cached images"))?;
    for (index, image) in images.iter_mut().enumerate() {
        image["artifactId"] = source["images"][index]["artifactId"].clone();
    }
    Ok(())
}

fn save_receipt(
    db: &Connection,
    job: &Job,
    id: &str,
    key: &str,
    revision: u64,
    package: &Value,
) -> AgentResult<()> {
    db.execute(
        "INSERT INTO agent_content_receipts(job_id,product_id,content_key,control_revision,state,
            package_json,receipt_id,completed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            job.id,
            id,
            key,
            super::sql::to_sql_i64(revision)?,
            package["state"].as_str(),
            canonical(package),
            Uuid::new_v4().to_string(),
            super::schema::timestamp(db, now_ms())?
        ],
    )
    .map_err(storage_error)?;
    db.execute("UPDATE agent_items SET state=?3,reason=?4,title=COALESCE(?5,title),description=COALESCE(?6,description)
        WHERE job_id=?1 AND product_id=?2 AND submitted=0",
        params![job.id,id,if package["state"]=="approved" {"preparing"} else {package["state"].as_str().unwrap_or("failed")},
            package["reason"].as_str(),package["product"]["title"].as_str(),package["product"]["description"].as_str()],
    ).map_err(storage_error)?;
    Ok(())
}

pub(super) fn approved(db: &Connection, job: &Job, id: &str) -> AgentResult<Value> {
    let (source, revision, action) = effective_product(db, job, id)?;
    if action.as_deref() == Some("skip") {
        return Err(denied("Skipped products cannot be published"));
    }
    let ctx = context(
        &source,
        &job.settings,
        &job.snapshot.platform_origin,
        &job.instruction,
    )?;
    let package: Option<String> = db.query_row(
        "SELECT package_json FROM agent_content_receipts WHERE job_id=?1 AND product_id=?2 AND content_key=?3
         AND control_revision=?4 AND state='approved' AND invalidation_reason IS NULL",
        params![job.id,id,ctx["contentKey"].as_str(),super::sql::to_sql_i64(revision)?],|r|r.get(0),
    ).optional().map_err(storage_error)?;
    let package: Value = serde_json::from_str(
        &package.ok_or_else(|| denied("Product needs durable content preparation"))?,
    )
    .map_err(storage_error)?;
    validate_package(db, job, &source, &package)?;
    Ok(package)
}

pub(super) fn ready(db: &Connection, job: &Job) -> AgentResult<u32> {
    let mut count = 0;
    for original in &job.snapshot.products {
        let id = original["id"]
            .as_str()
            .ok_or_else(|| invalid("Invalid frozen product"))?;
        let (source, revision, _) = effective_product(db, job, id)?;
        let ctx = context(
            &source,
            &job.settings,
            &job.snapshot.platform_origin,
            &job.instruction,
        )?;
        let package: Option<String> = db
            .query_row(
                "SELECT package_json FROM agent_content_receipts WHERE job_id=?1 AND product_id=?2
             AND content_key=?3 AND control_revision=?4 AND invalidation_reason IS NULL",
                params![
                    job.id,
                    id,
                    ctx["contentKey"].as_str(),
                    super::sql::to_sql_i64(revision)?
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let package: Value = serde_json::from_str(
            &package
                .ok_or_else(|| conflict("Every product needs a durable preparation outcome"))?,
        )
        .map_err(storage_error)?;
        validate_package(db, job, &source, &package)?;
        if package["state"] == "approved" {
            approved(db, job, id)?;
            count += 1;
        }
    }
    Ok(count)
}

impl AgentStore {
    pub(super) fn step_snapshot(&self, job: &Job) -> AgentResult<JobSnapshot> {
        let db = self.open()?;
        let mut snapshot = job.snapshot.clone();
        for product in &mut snapshot.products {
            let id = product["id"]
                .as_str()
                .ok_or_else(|| invalid("Invalid frozen product"))?;
            let (source, _, _) = effective_product(&db, job, id)?;
            let input = context(
                &source,
                &job.settings,
                &job.snapshot.platform_origin,
                &job.instruction,
            )?;
            *product = source;
            product["preparationInput"] = input;
        }
        Ok(snapshot)
    }

    pub(super) fn content_put(
        &self,
        scope: &AgentScope,
        generation: &str,
        id: &str,
        key: &str,
        package: &Value,
    ) -> AgentResult<Value> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        if scope.mode != AgentMode::ContentPreparation {
            return Err(denied("Only content preparation may save packages"));
        }
        super::controls::require_writes(&tx, &scope.job_id)?;
        let job = read_job(&tx, &scope.job_id)?;
        let (source, revision, action) = expected(&tx, &job, id, key)?;
        validate_package(&tx, &job, &source, package)?;
        if action.as_deref() == Some("skip") && package["state"] != "skipped" {
            return Err(denied(
                "An explicitly skipped item requires a skipped receipt",
            ));
        }
        let stored:Option<String>=tx.query_row(
            "SELECT package_json FROM agent_content_receipts WHERE job_id=?1 AND product_id=?2 AND content_key=?3
             AND control_revision=?4 AND invalidation_reason IS NULL",
            params![job.id,id,key,super::sql::to_sql_i64(revision)?],|r|r.get(0),
        ).optional().map_err(storage_error)?;
        if let Some(stored) = stored {
            if stored != canonical(package) {
                return Err(conflict("Preparation receipts are immutable"));
            }
        } else {
            save_receipt(&tx, &job, id, key, revision, package)?;
            // An explicit per-item decision never becomes a cross-job permission.
            if package["state"] == "approved" && action.is_none() {
                tx.execute(
                    "INSERT OR IGNORE INTO agent_content_packages(content_key,package_json,receipt_id,completed_at)
                     VALUES(?1,?2,?3,?4)",
                    params![key,canonical(package),Uuid::new_v4().to_string(),super::schema::timestamp(&tx,now_ms())?],
                ).map_err(storage_error)?;
            }
        }
        tx.commit().map_err(storage_error)?;
        Ok(json!({"stored":true,"storageDurable":true}))
    }

    pub(super) fn content_get(
        &self,
        scope: &AgentScope,
        generation: &str,
        id: &str,
        key: &str,
    ) -> AgentResult<Value> {
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_lease(&tx, scope, generation)?;
        let job = read_job(&tx, &scope.job_id)?;
        let (source, revision, action) = expected(&tx, &job, id, key)?;
        let stored:Option<String>=tx.query_row(
            "SELECT package_json FROM agent_content_receipts WHERE job_id=?1 AND product_id=?2 AND content_key=?3
             AND control_revision=?4 AND invalidation_reason IS NULL",
            params![job.id,id,key,super::sql::to_sql_i64(revision)?],|r|r.get(0),
        ).optional().map_err(storage_error)?;
        let mut package: Option<Value> = stored
            .map(|s| serde_json::from_str(&s).map_err(storage_error))
            .transpose()?;
        if package.is_none() && scope.mode == AgentMode::ContentPreparation && action.is_none() {
            super::controls::require_writes(&tx, &scope.job_id)?;
            let cached: Option<String> = tx
                .query_row(
                    "SELECT package_json FROM agent_content_packages WHERE content_key=?1",
                    [key],
                    |r| r.get(0),
                )
                .optional()
                .map_err(storage_error)?;
            if let Some(cached) = cached {
                let mut cached: Value = serde_json::from_str(&cached).map_err(storage_error)?;
                rebind(&mut cached, &source)?;
                validate_package(&tx, &job, &source, &cached)?;
                save_receipt(&tx, &job, id, key, revision, &cached)?;
                package = Some(cached);
            }
        }
        if let Some(package) = &package {
            validate_package(&tx, &job, &source, package)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(json!({"preparation":package}))
    }
}
