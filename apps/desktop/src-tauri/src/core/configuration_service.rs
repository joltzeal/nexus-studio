use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: u64 = 8 * 1024 * 1024;

fn validate_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_BYTES {
        return Err("配置文件超过 8 MB".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| "配置文件不是有效 JSON")?;
    if value.get("format").and_then(serde_json::Value::as_str) != Some("nexus-configuration")
        || value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
    {
        return Err("配置文件格式或版本不受支持".into());
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| "无法读取配置文件")?;
    if !file.metadata().map_err(|_| "无法读取配置文件")?.is_file() {
        return Err("请选择普通的 JSON 配置文件".into());
    }
    let mut content = String::new();
    file.take(MAX_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|_| "无法读取配置文件，请确认文件编码为 UTF-8")?;
    validate_content(&content)?;
    Ok(content)
}

fn write_file(path: &Path, content: &str) -> Result<(), String> {
    validate_content(content)?;
    let parent = path.parent().ok_or("配置文件路径无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建配置文件")?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| "配置写入失败，文件没有导出")?;
    temporary
        .persist(path)
        .map_err(|_| "无法保存配置文件，请检查目录权限")?;
    Ok(())
}

#[derive(Serialize)]
pub struct ConfigurationFile {
    name: String,
    content: String,
}

#[tauri::command]
pub async fn configuration_file_export(
    app: tauri::AppHandle,
    content: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_content(&content)?;
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Nexus 配置", &["json"])
            .set_file_name("nexus-configuration.json")
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| "配置文件路径无效")?;
        write_file(&path, &content)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "配置导出任务中断".to_string())?
}

#[tauri::command]
pub async fn configuration_file_import(
    app: tauri::AppHandle,
) -> Result<Option<ConfigurationFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Nexus 配置", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| "配置文件路径无效")?;
        let content = read_file(&path)?;
        Ok(Some(ConfigurationFile {
            name: path
                .file_name()
                .ok_or("配置文件名称无效")?
                .to_string_lossy()
                .into_owned(),
            content,
        }))
    })
    .await
    .map_err(|_| "配置导入任务中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{"format":"nexus-configuration","schemaVersion":1}"#;

    #[test]
    fn roundtrip_and_failed_validation_keep_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        write_file(&path, VALID).unwrap();
        assert_eq!(read_file(&path).unwrap(), VALID);
        for invalid in [
            "invalid",
            r#"{"format":"nexus-configuration","schemaVersion":2}"#,
        ] {
            assert!(write_file(&path, invalid).is_err());
            assert_eq!(read_file(&path).unwrap(), VALID);
        }
    }

    #[test]
    fn rejects_oversized_and_non_file_inputs() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("oversized.json");
        std::fs::write(&path, " ".repeat((MAX_BYTES + 1) as usize)).unwrap();
        assert!(read_file(&path).is_err());
        assert!(read_file(root.path()).is_err());
    }
}
