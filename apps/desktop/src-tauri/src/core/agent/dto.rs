use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{AgentResult, invalid};
pub use crate::core::plugin_host::process::AgentScope;

pub const MAX_PRODUCTS: usize = 100;
pub const MAX_WINDOWS: usize = 100;
pub const IMAGE_CHUNK: usize = 192 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_CHECKPOINT_BYTES: usize = 384 * 1024;
pub const MAX_STEPS: u32 = 10_000;
pub const STEP_DEADLINE_MS: u64 = 120_000;
pub const LEASE_MS: i64 = 120_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BatchCreateInput {
    pub operation_id: String,
    pub preset: Preset,
    #[serde(default)]
    pub instruction: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    pub assignments: Vec<Assignment>,
}

fn default_concurrency() -> u32 {
    3
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    InspectAccounts,
    PostListing,
    Message,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Assignment {
    pub window_id: String,
    #[serde(default)]
    pub product_ids: Vec<String>,
    #[serde(default)]
    pub overrides: Vec<ProductOverride>,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProductOverride {
    pub product_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Message {
    pub conversation_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WindowSnapshot {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub connection_id: String,
    pub profile_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JobSnapshot {
    pub window_id: String,
    pub window_name: String,
    pub provider_id: String,
    pub connection_id: String,
    pub profile_id: String,
    pub platform_origin: String,
    pub account: Value,
    pub products: Vec<Value>,
    pub messages: Vec<Message>,
}

impl JobSnapshot {
    pub fn account_id(&self) -> AgentResult<&str> {
        self.account
            .get("accountId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Account snapshot is missing its identity"))
    }

    pub fn resources(&self) -> AgentResult<Vec<String>> {
        let mut resources = vec![
            format!("window:{}", self.window_id),
            format!("account:{}", self.account_id()?),
            format!(
                "vinted-identity:{}",
                self.account["platformUserId"]
                    .as_str()
                    .ok_or_else(|| invalid("Account platform identity is missing"))?
                    .trim_start_matches('0')
            ),
            format!(
                "profile:{}",
                serde_json::json!([self.connection_id, self.profile_id])
            ),
        ];
        for product in &self.products {
            let id = product["id"]
                .as_str()
                .ok_or_else(|| invalid("Product snapshot identity is missing"))?;
            uuid(id)?;
            resources.push(format!("product:{id}"));
        }
        Ok(resources)
    }

    pub fn binding_matches(&self, window: &WindowSnapshot) -> bool {
        self.window_id == window.id
            && self.provider_id == window.provider_id
            && self.connection_id == window.connection_id
            && self.profile_id == window.profile_id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PageInput {
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

pub fn default_page() -> u32 {
    1
}
pub fn default_page_size() -> u32 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BatchGetInput {
    pub batch_id: String,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EventsInput {
    pub batch_id: String,
    #[serde(default)]
    pub cursor: u64,
    #[serde(default = "default_event_limit")]
    pub limit: u32,
}

fn default_event_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ControlInput {
    pub batch_id: String,
    pub action: ControlAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    Pause,
    Resume,
    Cancel,
    Reconcile,
    Takeover,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepOutput {
    pub state: StepState,
    pub phase: String,
    pub message: Option<String>,
    pub retry: Option<StepRetry>,
    pub progress: Option<Progress>,
    #[serde(default)]
    pub item_updates: Vec<ItemUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StepRetry {
    pub attempt: u32,
    pub max_attempts: u32,
    pub next_attempt_at: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Progress {
    pub current_index: u32,
    pub published: u32,
    pub skipped: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_product_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ItemUpdate {
    pub product_id: String,
    pub state: String,
    #[serde(default)]
    pub reason: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ItemControlInput {
    pub job_id: String,
    pub product_id: String,
    pub action: String,
    pub r#override: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SavedPlan {
    pub preset: Preset,
    #[serde(default)]
    pub instruction: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    #[serde(default)]
    pub product_ids: Vec<String>,
    #[serde(default)]
    pub window_ids: Vec<String>,
    #[serde(default)]
    pub assignments: Vec<Assignment>,
    #[serde(default)]
    pub unassigned_overrides: Vec<ProductOverride>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceSave {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub expected_revision: u64,
    pub data: SavedPlan,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelAcquire {
    pub request_id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelComplete {
    pub request_id: String,
    pub outcome: String,
    pub elapsed_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Continue,
    Completed,
    Blocked,
    ReviewRequired,
    ResultUnknown,
    SyncPending,
    Skipped,
}

impl StepState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continue => "running",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
            Self::ReviewRequired => "review_required",
            Self::ResultUnknown => "result_unknown",
            Self::SyncPending => "sync_pending",
            Self::Skipped => "skipped",
        }
    }
}

pub fn uuid(value: &str) -> AgentResult<()> {
    if Uuid::parse_str(value).is_err() {
        return Err(invalid("Expected a UUID"));
    }
    Ok(())
}

pub fn text(value: &str, min: usize, max: usize) -> AgentResult<()> {
    let length = value.chars().count();
    if length < min || length > max || value.contains('\0') {
        return Err(invalid("Text is outside the allowed bounds"));
    }
    Ok(())
}

pub fn validate_create(input: &BatchCreateInput) -> AgentResult<()> {
    uuid(&input.operation_id)?;
    text(&input.instruction, 0, 4000)?;
    if !(1..=10).contains(&input.concurrency)
        || input.assignments.is_empty()
        || input.assignments.len() > MAX_WINDOWS
    {
        return Err(invalid("Batch concurrency or assignment count is invalid"));
    }
    let mut windows = HashSet::new();
    let mut products = HashSet::new();
    let mut message_count = 0usize;
    for assignment in &input.assignments {
        uuid(&assignment.window_id)?;
        if !windows.insert(&assignment.window_id) {
            return Err(invalid("A window can appear only once in a batch"));
        }
        if (input.preset == Preset::PostListing && assignment.product_ids.is_empty())
            || (input.preset != Preset::PostListing && !assignment.product_ids.is_empty())
            || (input.preset == Preset::Message && assignment.messages.is_empty())
            || (input.preset != Preset::Message && !assignment.messages.is_empty())
        {
            return Err(invalid("Assignments do not match the selected preset"));
        }
        for id in &assignment.product_ids {
            uuid(id)?;
            if !products.insert(id) || products.len() > MAX_PRODUCTS {
                return Err(invalid(
                    "Products must be unique across the batch (maximum 100)",
                ));
            }
        }
        let mut overrides = HashSet::new();
        for item in &assignment.overrides {
            uuid(&item.product_id)?;
            if !assignment.product_ids.contains(&item.product_id)
                || !overrides.insert(&item.product_id)
            {
                return Err(invalid("Overrides must refer to one assigned product"));
            }
            for (value, max) in [
                (&item.title, 500),
                (&item.description, 6000),
                (&item.condition, 120),
                (&item.brand, 120),
                (&item.size, 120),
                (&item.category, 200),
            ] {
                if let Some(value) = value {
                    text(value, 0, max)?;
                }
            }
            if item.title.as_ref().is_some_and(|text| text.is_empty())
                || item
                    .description
                    .as_ref()
                    .is_some_and(|text| text.is_empty())
            {
                return Err(invalid(
                    "Explicit listing title and description cannot be empty",
                ));
            }
            if item
                .price
                .is_some_and(|price| !price.is_finite() || price <= 0.0 || price > 100_000_000.0)
                || item
                    .currency
                    .as_ref()
                    .is_some_and(|value| !matches!(value.as_str(), "USD" | "GBP" | "EUR"))
            {
                return Err(invalid("Invalid product price or currency"));
            }
        }
        let mut conversations = HashSet::new();
        if assignment.messages.len() > 100
            || assignment.overrides.len() > 100
            || assignment.product_ids.len() > 100
        {
            return Err(invalid("Assignment item count exceeds its budget"));
        }
        for message in &assignment.messages {
            text(&message.conversation_id, 1, 32)?;
            if !message
                .conversation_id
                .bytes()
                .all(|byte| byte.is_ascii_digit())
            {
                return Err(invalid("Conversation IDs must be numeric"));
            }
            text(&message.text, 1, 4000)?;
            if !conversations.insert(&message.conversation_id) {
                return Err(invalid("A conversation may appear only once per window"));
            }
            message_count += 1;
        }
    }
    if message_count > 100 {
        return Err(invalid("A batch supports at most 100 messages"));
    }
    Ok(())
}

pub fn validate_scope(scope: &AgentScope) -> AgentResult<()> {
    for value in [
        &scope.batch_id,
        &scope.job_id,
        &scope.window_id,
        &scope.account_id,
        &scope.lease_id,
    ] {
        uuid(value)?;
    }
    if scope.fence == 0 || scope.fence > 9_007_199_254_740_991 {
        return Err(invalid("Invalid fencing token"));
    }
    Ok(())
}

pub fn validate_page(page: u32, page_size: u32) -> AgentResult<()> {
    if page == 0 || page > 100_000 || page_size == 0 || page_size > 50 {
        return Err(invalid("Invalid pagination"));
    }
    Ok(())
}
