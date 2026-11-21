use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 50 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfExportInput {
    filename: String,
    data: String,
    sha256: String,
}

fn decode(input: &PdfExportInput) -> Result<Vec<u8>, String> {
    if input.filename.len() > 1024
        || input.filename.chars().count() > 240
        || !input.filename.to_ascii_lowercase().ends_with(".pdf")
        || input
            .filename
            .chars()
            .any(|ch| ch.is_control() || "\\/:*?\"<>|".contains(ch))
        || input.data.len() > MAX_BYTES.div_ceil(3) * 4
        || input.sha256.len() != 64
    {
        return Err("PDF 保存参数无效".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|_| "PDF 编码无效")?;
    if bytes.len() > MAX_BYTES
        || !bytes.starts_with(b"%PDF-")
        || format!("{:x}", Sha256::digest(&bytes)) != input.sha256
    {
        return Err("PDF 完整性校验失败，文件没有保存".into());
    }
    Ok(bytes)
}

fn write_pdf(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("请使用 .pdf 扩展名保存面单".into());
    }
    let parent = path.parent().ok_or("PDF 保存路径无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建 PDF 文件")?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| "PDF 写入失败，文件没有保存")?;
    temporary
        .persist(path)
        .map_err(|_| "PDF 保存失败，请检查目录权限")?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_pdf_export(
    app: tauri::AppHandle,
    input: PdfExportInput,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode(&input)?;
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("PDF 面单", &["pdf"])
            .set_file_name(&input.filename)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|_| "PDF 保存路径无效")?;
        write_pdf(&path, &bytes)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "PDF 保存任务中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_corrupt_bytes_and_unsafe_names_before_saving() {
        let bytes = b"%PDF-synthetic";
        let mut input = PdfExportInput {
            filename: "label-A6.pdf".into(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        };
        assert_eq!(decode(&input).unwrap(), bytes);
        input.filename = "../label.pdf".into();
        assert!(decode(&input).is_err());
        input.filename = "label.pdf".into();
        input.sha256 = "0".repeat(64);
        assert!(decode(&input).is_err());
    }

    #[test]
    fn writes_pdf_and_rejects_wrong_extension_without_replacing_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        let pdf = directory.path().join("label.pdf");
        write_pdf(&pdf, b"%PDF-synthetic").unwrap();
        assert_eq!(std::fs::read(&pdf).unwrap(), b"%PDF-synthetic");
        let other = directory.path().join("keep.txt");
        std::fs::write(&other, b"keep").unwrap();
        assert!(write_pdf(&other, b"%PDF-synthetic").is_err());
        assert_eq!(std::fs::read(&other).unwrap(), b"keep");
    }
}
