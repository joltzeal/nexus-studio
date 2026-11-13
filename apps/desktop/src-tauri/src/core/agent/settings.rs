use serde_json::{Value, json};

use super::dto::text;
use super::{AgentResult, invalid};

pub(crate) fn validate_settings(value: &Value) -> AgentResult<Value> {
    let fields = [
        "decision",
        "generation",
        "requestTimeoutMs",
        "maxStepsPerItem",
        "maxCopyRewrites",
        "reviewThreshold",
        "execution",
        "pricing",
        "notifications",
        "retention",
    ];
    let object = value
        .as_object()
        .ok_or_else(|| invalid("ecom agent model settings are not configured"))?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(invalid("Unknown Agent settings field"));
    }
    let mut settings = value.clone();
    for key in ["decision", "generation"] {
        let endpoint = settings[key]
            .as_object()
            .ok_or_else(|| invalid("Both decision and generation models must be configured"))?;
        if endpoint.keys().any(|field| {
            !["baseUrl", "apiKey", "model"].contains(&field.as_str())
                && !(key == "decision" && field == "protocol")
        }) {
            return Err(invalid("Unknown model endpoint field"));
        }
        for (field, min, max) in [("baseUrl", 1, 2048), ("apiKey", 1, 4096), ("model", 1, 200)] {
            text(
                endpoint
                    .get(field)
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("Incomplete model settings"))?,
                min,
                max,
            )?;
        }
        let endpoint = url::Url::parse(settings[key]["baseUrl"].as_str().unwrap_or(""))
            .map_err(|_| invalid("Invalid model endpoint URL"))?;
        if !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !(endpoint.scheme() == "https"
                || (endpoint.scheme() == "http"
                    && matches!(
                        endpoint.host_str(),
                        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                    )))
        {
            return Err(invalid("Model endpoints require HTTPS or loopback HTTP"));
        }
    }
    if settings["decision"].get("protocol").is_none() {
        settings["decision"]["protocol"] = json!("typesafe");
    }
    if !matches!(
        settings["decision"]["protocol"].as_str(),
        Some("typesafe" | "openai")
    ) {
        return Err(invalid("Unknown decision model protocol"));
    }
    for (key, default, min, max) in [
        ("requestTimeoutMs", 60000, 5000, 90000),
        ("maxStepsPerItem", 30, 5, 60),
        ("maxCopyRewrites", 2, 0, 2),
    ] {
        if settings.get(key).is_none() {
            settings[key] = json!(default);
        }
        if settings[key]
            .as_u64()
            .is_none_or(|value| value < min || value > max)
        {
            return Err(invalid("Agent settings are outside their limits"));
        }
    }
    if settings.get("reviewThreshold").is_none() {
        settings["reviewThreshold"] = json!(0.8);
    }
    if settings["reviewThreshold"]
        .as_f64()
        .is_none_or(|value| !value.is_finite() || !(0.5..=1.0).contains(&value))
    {
        return Err(invalid("Invalid review confidence threshold"));
    }
    complete(&mut settings)?;
    Ok(settings)
}

fn object(value: &Value, fields: &[&str]) -> AgentResult<()> {
    if value
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !fields.contains(&key.as_str())))
    {
        return Err(invalid("Unknown or invalid Agent settings object"));
    }
    Ok(())
}

fn integer(value: &mut Value, key: &str, default: u64, min: u64, max: u64) -> AgentResult<()> {
    if value.get(key).is_none() {
        value[key] = json!(default);
    }
    if value[key].as_u64().is_none_or(|n| n < min || n > max) {
        return Err(invalid("Agent execution setting is outside its limits"));
    }
    Ok(())
}

fn boolean(value: &mut Value, key: &str, default: bool) -> AgentResult<()> {
    if value.get(key).is_none() {
        value[key] = json!(default);
    }
    if !value[key].is_boolean() {
        return Err(invalid("Agent setting must be a boolean"));
    }
    Ok(())
}

fn complete(settings: &mut Value) -> AgentResult<()> {
    for key in ["execution", "pricing", "notifications", "retention"] {
        if settings.get(key).is_none() {
            settings[key] = json!({});
        }
    }
    let execution = &mut settings["execution"];
    object(
        execution,
        &[
            "modelConcurrency",
            "modelRequestsPerMinute",
            "providerConcurrency",
            "maxReadRetries",
            "retryBaseMs",
            "platformCooldownMs",
            "maxBatchModelRequests",
            "maxBatchCostUsd",
        ],
    )?;
    for (key, default, min, max) in [
        ("modelConcurrency", 3, 1, 10),
        ("modelRequestsPerMinute", 60, 1, 600),
        ("maxReadRetries", 2, 0, 5),
        ("retryBaseMs", 2000, 500, 30_000),
        ("platformCooldownMs", 30_000, 1000, 300_000),
        ("maxBatchModelRequests", 10_000, 1, 100_000),
    ] {
        integer(execution, key, default, min, max)?;
    }
    if execution.get("providerConcurrency").is_none() {
        execution["providerConcurrency"] = json!({});
    }
    object(
        &execution["providerConcurrency"],
        &["cloakbrowser", "adspower", "bitbrowser"],
    )?;
    for provider in ["cloakbrowser", "adspower", "bitbrowser"] {
        integer(&mut execution["providerConcurrency"], provider, 3, 1, 10)?;
    }
    if execution.get("maxBatchCostUsd").is_none() {
        execution["maxBatchCostUsd"] = Value::Null;
    }
    if !execution["maxBatchCostUsd"].is_null()
        && execution["maxBatchCostUsd"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n <= 0.0 || n > 1_000_000.0)
    {
        return Err(invalid("Invalid model cost budget"));
    }
    object(&settings["pricing"], &["decision", "generation"])?;
    for kind in ["decision", "generation"] {
        if settings["pricing"].get(kind).is_none() {
            settings["pricing"][kind] = json!({});
        }
        object(
            &settings["pricing"][kind],
            &["inputPerMillionUsd", "outputPerMillionUsd"],
        )?;
        for field in ["inputPerMillionUsd", "outputPerMillionUsd"] {
            if settings["pricing"][kind].get(field).is_none() {
                settings["pricing"][kind][field] = Value::Null;
            }
            let price = &settings["pricing"][kind][field];
            if (!price.is_null()
                && price
                    .as_f64()
                    .is_none_or(|n| !n.is_finite() || !(0.0..=100_000.0).contains(&n)))
                || (price.is_null() && !settings["execution"]["maxBatchCostUsd"].is_null())
            {
                return Err(invalid(
                    "Cost budgets require complete, finite prices for both models",
                ));
            }
        }
    }
    let notifications = &mut settings["notifications"];
    object(
        notifications,
        &[
            "enabled",
            "baseUrl",
            "deviceKey",
            "onCompleted",
            "onAttention",
        ],
    )?;
    boolean(notifications, "enabled", false)?;
    boolean(notifications, "onCompleted", true)?;
    boolean(notifications, "onAttention", true)?;
    if notifications.get("baseUrl").is_none() {
        notifications["baseUrl"] = json!("https://api.day.app");
    }
    if notifications.get("deviceKey").is_none() {
        notifications["deviceKey"] = json!("");
    }
    let base = notifications["baseUrl"]
        .as_str()
        .ok_or_else(|| invalid("Invalid notification URL"))?;
    text(base, 1, 2048)?;
    let url = url::Url::parse(base).map_err(|_| invalid("Invalid notification URL"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                )))
    {
        return Err(invalid("Notification URL requires HTTPS or loopback HTTP"));
    }
    let device = notifications["deviceKey"]
        .as_str()
        .ok_or_else(|| invalid("Invalid notification device key"))?;
    text(
        device,
        if notifications["enabled"] == true {
            1
        } else {
            0
        },
        4096,
    )?;
    if notifications["enabled"] == true && device.trim().is_empty() {
        return Err(invalid("Enabled notifications require a device key"));
    }
    let retention = &mut settings["retention"];
    object(retention, &["enabled", "days"])?;
    boolean(retention, "enabled", false)?;
    integer(retention, "days", 30, 1, 3650)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> Value {
        json!({"decision":{"baseUrl":"https://model.invalid","apiKey":"fixture","model":"fixture"},
            "generation":{"baseUrl":"https://model.invalid","apiKey":"fixture","model":"fixture"}})
    }

    #[test]
    fn defaults_keep_notifications_and_history_cleanup_disabled() {
        let settings = validate_settings(&configured()).unwrap();
        assert_eq!(settings["execution"]["modelConcurrency"], 3);
        assert_eq!(settings["execution"]["maxReadRetries"], 2);
        assert_eq!(settings["notifications"]["enabled"], false);
        assert_eq!(settings["retention"]["enabled"], false);
        assert!(settings["pricing"]["decision"]["inputPerMillionUsd"].is_null());
    }

    #[test]
    fn rejects_partial_prices_unknown_fields_and_invalid_limits() {
        for patch in [
            json!({"execution":{"modelConcurrency":0}}),
            json!({"execution":{"maxBatchCostUsd":1}}),
            json!({"execution":{"providerConcurrency":{"other":1}}}),
            json!({"notifications":{"enabled":true,"deviceKey":""}}),
            json!({"retention":{"enabled":"true"}}),
        ] {
            let mut value = configured();
            for (key, field) in patch.as_object().unwrap() {
                value[key] = field.clone();
            }
            assert!(validate_settings(&value).is_err());
        }
        let mut value = configured();
        value["execution"] = json!({"maxBatchCostUsd":1});
        value["pricing"] = json!({"decision":{"inputPerMillionUsd":0,"outputPerMillionUsd":1},
            "generation":{"inputPerMillionUsd":1,"outputPerMillionUsd":1}});
        assert!(validate_settings(&value).is_ok());
    }
}
