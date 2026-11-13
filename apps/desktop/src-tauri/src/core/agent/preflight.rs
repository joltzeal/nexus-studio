use serde_json::{Value, json};

use super::dto::*;
use super::service::{
    AgentService, browser_error, parse_window, validate_listing_product, validate_settings,
};
use super::sql::read_u64;
use super::{AgentResult, host_error, invalid, storage_error};
use crate::core::plugin_host::manifest::Capability;

impl AgentService {
    pub fn preflight(&self, input: BatchCreateInput) -> AgentResult<Value> {
        validate_create(&input)?;
        let mut checks = Vec::new();
        let settings = self
            .host()
            .and_then(|host| {
                host.call(
                    "studio.sales-agent",
                    Capability::SalesAgent,
                    "salesAgent.settings.get",
                    json!({}),
                    std::time::Duration::from_secs(20),
                )
                .map_err(host_error)
            })
            .and_then(|reply| validate_settings(&reply["settings"]));
        checks.push(check(
            None,
            None,
            "SETTINGS",
            settings.is_ok(),
            "settings",
            if settings.is_ok() {
                "已保存的模型与执行设置有效"
            } else {
                "请补全模型与执行设置"
            },
        ));
        let mut total_bytes = 0u64;
        let mut payload_budget = true;
        let mut identities = std::collections::HashSet::new();
        for assignment in &input.assignments {
            let window = self
                .windows()
                .and_then(|windows| {
                    windows
                        .agent_window_snapshot(&assignment.window_id)
                        .map_err(browser_error)
                })
                .and_then(parse_window);
            let account = self.account_snapshot(&assignment.window_id);
            let ready = window.as_ref().is_ok_and(|w| {
                !matches!(
                    w.state.as_str(),
                    "unknown" | "missing" | "starting" | "stopping"
                )
            });
            let mut account_ready = account
                .as_ref()
                .is_ok_and(|(a, _)| a["status"] != "blocked");
            let identity = account
                .as_ref()
                .ok()
                .and_then(|(a, _)| a["platformUserId"].as_str());
            if let Some(identity) = identity {
                if !identities.insert(identity.trim_start_matches('0').to_owned()) {
                    account_ready = false;
                }
            }
            checks.push(check(
                Some(&assignment.window_id),
                None,
                "WINDOW",
                ready,
                "window",
                if ready {
                    "已保存的窗口接入可用"
                } else {
                    "请先核对窗口状态与浏览器接入"
                },
            ));
            checks.push(check(
                Some(&assignment.window_id),
                None,
                "ACCOUNT_BINDING",
                account_ready,
                "account",
                if account_ready {
                    "已保存的账号身份有效；启动浏览器后再核对在线登录状态"
                } else {
                    "请绑定有效账号，并处理封禁或重复的账号身份"
                },
            ));
            let mut products = Vec::new();
            for id in &assignment.product_ids {
                let result = self.read_product(id).and_then(|mut product| {
                    if let Some(amendment) =
                        assignment.overrides.iter().find(|o| &o.product_id == id)
                    {
                        let value = serde_json::to_value(amendment).map_err(storage_error)?;
                        for (key, value) in value
                            .as_object()
                            .ok_or_else(|| invalid("Invalid product override"))?
                        {
                            if key != "productId" {
                                product[key] = value.clone();
                            }
                        }
                    }
                    validate_listing_product(&product)?;
                    let images = product["images"]
                        .as_array()
                        .ok_or_else(|| invalid("Product images are missing"))?;
                    let mut seen = std::collections::HashSet::new();
                    for image in images {
                        let image_id = image["id"]
                            .as_str()
                            .ok_or_else(|| invalid("Product image ID is missing"))?;
                        uuid(image_id)?;
                        if !seen.insert(image_id) {
                            return Err(invalid("Duplicate product image ID"));
                        }
                        text(image["name"].as_str().unwrap_or(""), 1, 200)?;
                        let size = image["bytes"]
                            .as_u64()
                            .ok_or_else(|| invalid("Invalid image size"))?;
                        if size == 0
                            || size > MAX_IMAGE_BYTES
                            || !matches!(
                                image["mime"].as_str(),
                                Some("image/png" | "image/jpeg" | "image/webp")
                            )
                            || image["sha256"].as_str().is_none_or(|s| {
                                s.len() != 64
                                    || !s
                                        .bytes()
                                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                            })
                        {
                            return Err(invalid("Stored image metadata is invalid"));
                        }
                        total_bytes = total_bytes.saturating_add(size);
                    }
                    if let Some(images) = product["images"].as_array_mut() {
                        for image in images {
                            image["artifactId"] = json!("00000000-0000-4000-8000-000000000000");
                        }
                    }
                    Ok(product)
                });
                checks.push(check(
                    Some(&assignment.window_id),
                    Some(id),
                    "PRODUCT",
                    result.is_ok(),
                    "product",
                    if result.is_ok() {
                        "商品资料与图片信息有效；创建任务时会再次校验图片内容"
                    } else {
                        "请补全商品资料、图片与价格；已有发布记录的商品不能再次分配"
                    },
                ));
                if let Ok(product) = result {
                    products.push(product);
                }
            }
            if let (Ok(window), Ok((account, origin))) = (window, account) {
                let snapshot = JobSnapshot {
                    window_id: window.id,
                    window_name: window.name,
                    provider_id: window.provider_id,
                    connection_id: window.connection_id,
                    profile_id: window.profile_id,
                    platform_origin: origin,
                    account,
                    products,
                    messages: assignment.messages.clone(),
                };
                if let Ok(settings) = &settings {
                    payload_budget &=
                        super::canonical(&json!({"snapshot":snapshot,"settings":settings})).len()
                            <= 800 * 1024;
                }
                let free = self.store.preflight_resources(&snapshot)?;
                checks.push(check(
                    Some(&assignment.window_id),
                    None,
                    "OWNERSHIP",
                    free,
                    "window",
                    if free {
                        "没有冲突的任务占用或已确认发布记录"
                    } else {
                        "现有任务占用窗口、账号或商品，请先查看并处理执行结果"
                    },
                ));
            }
        }
        checks.push(check(
            None,
            None,
            "ARTIFACT_BUDGET",
            total_bytes <= MAX_ARTIFACT_BYTES,
            "product",
            if total_bytes <= MAX_ARTIFACT_BYTES {
                "图片总大小符合批次存储限制"
            } else {
                "本批次图片超过存储限制，请拆分商品分配"
            },
        ));
        checks.push(check(
            None,
            None,
            "PAYLOAD_BUDGET",
            payload_budget,
            "product",
            if payload_budget {
                "任务资料符合单窗口快照大小限制"
            } else {
                "单窗口资料过大，请拆分商品分配后再运行"
            },
        ));
        checks.push(json!({"code":"ONLINE_LOGIN","severity":"warning","message":
            "运行前检查仅核对已保存资料。浏览器登录状态、平台身份与账号当前状态会在执行时核对。",
            "action":"none"}));
        let db = self.store.open()?;
        let checked = super::schema::timestamp(&db, super::now_ms())?;
        Ok(
            json!({"ready":!checks.iter().any(|c|c["severity"]=="error"),"checkedAt":checked,"checks":checks}),
        )
    }

    pub fn artifact_preview(&self, job_id: &str, artifact_id: &str) -> AgentResult<Value> {
        use base64::Engine;
        uuid(job_id)?;
        uuid(artifact_id)?;
        let db = self.store.open()?;
        let (batch, mime, size, digest): (String, String, u64, String) = db
            .query_row(
                "SELECT batch_id,mime,size,sha256 FROM agent_artifacts WHERE id=?1 AND job_id=?2",
                rusqlite::params![artifact_id, job_id],
                |r| Ok((r.get(0)?, r.get(1)?, read_u64(r, 2)?, r.get(3)?)),
            )
            .map_err(storage_error)?;
        let path = self
            .artifacts
            .resolve(&batch, artifact_id, &mime, size, &digest)?;
        let bytes = std::fs::read(path).map_err(storage_error)?;
        use sha2::Digest;
        if bytes.len() as u64 != size
            || size > MAX_IMAGE_BYTES
            || format!("{:x}", sha2::Sha256::digest(&bytes)) != digest
        {
            return Err(invalid("Artifact preview size changed"));
        }
        Ok(
            json!({"dataUrl":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}),
        )
    }
}

impl super::store::AgentStore {
    pub fn preflight_resources(&self, snapshot: &JobSnapshot) -> AgentResult<bool> {
        let db = self.open()?;
        for key in snapshot.resources()? {
            let occupied: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_resources WHERE resource_key=?1)",
                    [key],
                    |r| r.get(0),
                )
                .map_err(storage_error)?;
            if occupied {
                return Ok(false);
            }
        }
        for product in &snapshot.products {
            let found:bool=db.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_product_assignments p JOIN agent_jobs j ON j.id=p.job_id
                  WHERE p.product_id=?1 AND (j.state NOT IN ('completed','cancelled','skipped','failed') OR j.actor_owned=1))
                 OR EXISTS(SELECT 1 FROM agent_actions WHERE kind='listing' AND state='confirmed'
                  AND json_extract(result_json,'$.productId')=?1)
                 OR EXISTS(SELECT 1 FROM agent_archived_publications WHERE product_id=?1)",
                [product["id"].as_str()],|r|r.get(0),
            ).map_err(storage_error)?;
            if found {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn check(
    window: Option<&str>,
    product: Option<&str>,
    code: &str,
    ok: bool,
    action: &str,
    message: &str,
) -> Value {
    let mut value =
        json!({"code":code,"severity":if ok{"ok"}else{"error"},"message":message,"action":action});
    if let Some(id) = window {
        value["windowId"] = json!(id);
    }
    if let Some(id) = product {
        value["productId"] = json!(id);
    }
    value
}
