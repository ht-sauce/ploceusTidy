use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn clean_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    raw.to_string()
}

pub fn normalize_path_key(path: &Path) -> String {
    let normalized = clean_path(path).replace('/', "\\");
    let trimmed = normalized.trim_end_matches('\\');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

pub fn file_icon_and_kind(path: &Path) -> (&'static str, &'static str) {
    if path.is_dir() {
        return ("folder", "folder");
    }

    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    match ext.as_str() {
        "pdf" => ("file", "pdf"),
        "doc" | "docx" => ("file", "docx"),
        "xls" | "xlsx" | "csv" => ("file", "xlsx"),
        "dwg" | "dxf" => ("file", "dwg"),
        "exe" | "msi" => ("file", "exe"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => ("image", "image"),
        "mp4" | "mkv" | "avi" | "mov" | "webm" => ("video", "video"),
        "txt" | "md" | "log" | "json" | "yaml" | "yml" => ("file", "txt"),
        _ => ("file", "txt"),
    }
}

pub fn subtitle_for_path(path: &Path) -> String {
    path.parent()
        .map(|parent| clean_path(parent))
        .unwrap_or_default()
}

pub fn sanitize_ext(ext: &str) -> String {
    let lower = ext.to_lowercase();
    match lower.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => lower,
        _ => "png".to_string(),
    }
}

#[cfg(windows)]
pub fn read_clipboard_files() -> Result<Vec<String>, String> {
    clipboard_win::raw::open().map_err(|error| format!("打开剪贴板失败：{error}"))?;
    let mut files = Vec::new();
    let result = clipboard_win::raw::get_file_list(&mut files);
    let _ = clipboard_win::raw::close();
    result.map_err(|error| format!("读取剪贴板文件失败：{error}"))?;
    Ok(files)
}

#[cfg(not(windows))]
pub fn read_clipboard_files() -> Result<Vec<String>, String> {
    Err("当前版本仅支持 Windows 剪贴板文件读取".to_string())
}
