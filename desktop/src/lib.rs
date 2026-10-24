//! 络雀桌面端入口：注册 Tauri 命令、初始化工作空间与主窗口。
//!
//! 命令边界：前端只传 `nodeId` / 绝对路径 / 展示数据；文件系统、剪贴板与
//! SQLite 都留在这里的 Rust 侧处理（HC-12、HC-13）。

mod db;
mod models;
mod platform;

use base64::Engine;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use db::AppState;
use models::{ImportRequest, ImportResult, SceneData, SceneNode, WorkspaceInfo};

/// 返回工作空间路径、数据库路径与节点数量，供设置面板展示。
#[tauri::command]
fn workspace_get(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    db::workspace_info(&state)
}

/// 读取完整场景；首屏一次性加载，缩略图等重数据后续按需补充。
#[tauri::command]
fn scene_load(state: State<'_, AppState>) -> Result<SceneData, String> {
    db::scene_load(&state)
}

/// 覆盖保存完整场景；单事务内清空并重建，失败整体回滚。
#[tauri::command]
fn scene_save(state: State<'_, AppState>, scene: SceneData) -> Result<(), String> {
    db::scene_save(&state, &scene)
}

/// 批量导入绝对路径：Rust 侧负责规范化、符号链接校验与去重，失败项带路径与原因返回。
#[tauri::command]
fn import_paths(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportResult, String> {
    db::import_paths(&state, &request)
}

/// 读取剪贴板中的文件路径列表；仅 Windows 实现，只在用户主动粘贴时调用。
#[tauri::command]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    platform::read_clipboard_files()
}

/// 打开 WebView 开发者工具，供 F12 调用；release 构建同样可用。
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// 打开节点对应的 URL 或原文件。
/// 只接受 `nodeId`，路径从数据库读取，不信任前端传入的任意路径；URL 仅允许 http/https。
#[tauri::command]
fn open_ref(app: AppHandle, state: State<'_, AppState>, node_id: String) -> Result<(), String> {
    let (path, url) = db::node_target(&state, &node_id)?;

    if let Some(url) = url {
        if url.starts_with("http://") || url.starts_with("https://") {
            return app
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|error| format!("打开链接失败：{error}"));
        }
    }

    if let Some(path) = path {
        return app
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|error| format!("打开文件失败：{error}"));
    }

    Err("该对象没有可打开的文件或链接".to_string())
}

/// 在资源管理器中定位节点对应的文件；同样只按 `nodeId` 查库，不移动、不修改原文件。
#[tauri::command]
fn reveal_ref(app: AppHandle, state: State<'_, AppState>, node_id: String) -> Result<(), String> {
    let (path, _) = db::node_target(&state, &node_id)?;
    let path = path.ok_or_else(|| "该对象没有文件路径".to_string())?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| format!("定位文件失败：{error}"))
}

/// 把粘贴的截图解码后写入 `dataWorkSpace/assets`，扩展名走白名单，返回落盘路径。
#[tauri::command]
fn save_clipboard_image(
    state: State<'_, AppState>,
    data: String,
    ext: String,
) -> Result<String, String> {
    let clean_ext = platform::sanitize_ext(&ext);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("截图解码失败：{error}"))?;
    db::save_asset(&state, &bytes, &clean_ext)
}

/// 返回图片的 data URL；超过 24MB 直接拒绝，避免前端内存与 IPC 压力。
#[tauri::command]
fn preview_ref(state: State<'_, AppState>, node_id: String) -> Result<String, String> {
    let (path, url) = db::node_target(&state, &node_id)?;
    if let Some(url) = url {
        return Ok(url);
    }

    let path = path.ok_or_else(|| "该对象没有可预览的文件".to_string())?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if metadata.len() > 24 * 1024 * 1024 {
        return Err("图片超过 24MB，请用系统查看器打开".to_string());
    }

    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    let bytes = std::fs::read(&path).map_err(|error| format!("读取图片失败：{error}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// 按 ID 读取单个节点，用于重复导入后的定位刷新。
#[tauri::command]
fn node_get(state: State<'_, AppState>, node_id: String) -> Result<Option<SceneNode>, String> {
    db::node_by_id(&state, &node_id)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = db::initialize(app.handle()).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error,
                ))
            })?;
            app.manage(state);

            // 初始窗口按当前显示器收敛到 92% × 90%，避免小屏下超出可视区域。
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size().to_logical::<f64>(scale);
                    let width = (size.width * 0.92).clamp(780.0, 1360.0);
                    let height = (size.height * 0.90).clamp(520.0, 880.0);
                    let _ = window.set_size(tauri::LogicalSize::new(width, height));
                    let _ = window.center();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_get,
            scene_load,
            scene_save,
            import_paths,
            read_clipboard_files,
            open_devtools,
            open_ref,
            reveal_ref,
            save_clipboard_image,
            preview_ref,
            node_get,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
