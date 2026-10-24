//! 平台能力与路径工具：只读访问文件系统，不修改用户文件（HC-12）。
//! Windows 优先；剪贴板文件读取仅在 Windows 实现，其他平台明确返回不支持。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 当前时间（epoch 毫秒），用于 `created_at` / `updated_at`。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 去掉 Windows `\\?\` / `\\?\UNC\` 前缀，返回用户可读的常规路径。
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

/// 生成去重键：统一反斜杠、去尾部分隔符，Windows 下忽略大小写。
pub fn normalize_path_key(path: &Path) -> String {
    let normalized = clean_path(path).replace('/', "\\");
    let trimmed = normalized.trim_end_matches('\\');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// 按扩展名映射节点类型与展示图标；未知扩展名按普通文本文件处理。
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

/// 行副标题：所在目录，用于搜索与 Tooltip 展示。
pub fn subtitle_for_path(path: &Path) -> String {
    path.parent()
        .map(|parent| clean_path(parent))
        .unwrap_or_default()
}

/// 截图扩展名白名单：阻止把任意后缀写进 assets 目录。
pub fn sanitize_ext(ext: &str) -> String {
    let lower = ext.to_lowercase();
    match lower.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => lower,
        _ => "png".to_string(),
    }
}

/// 读取资源管理器复制到剪贴板的文件列表（CF_HDROP）。
/// 只在用户主动粘贴时调用；读取失败按 HC-14 带原因上报。
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
