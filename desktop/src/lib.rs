//! 络雀桌面端入口：注册 Tauri 命令、初始化工作空间与主窗口。
//!
//! 命令边界：前端只传 `nodeId` / 绝对路径 / 展示数据；文件系统、剪贴板与
//! SQLite 都留在这里的 Rust 侧处理（HC-12、HC-13）。

mod db;
mod models;
mod platform;

use base64::Engine;
use std::path::Path;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use db::AppState;
use models::{
    ImportRequest, ImportResult, RefStatus, RelinkResult, SceneData, SceneNode, WorkspaceInfo,
};

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

/// 增量保存完整场景：按 ID upsert，只清理本次快照之外的对象，失败整体回滚。
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

/// 按需生成缩略图并返回 data URL；无路径、缺失或非 Windows 平台返回 `None`。
#[tauri::command]
fn thumb_get(
    state: State<'_, AppState>,
    node_id: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    db::thumb_get(&state, &node_id, size.unwrap_or(96))
}

/// 桌面常驻：把窗口压到普通窗口之下；只影响层级，不改变窗口尺寸与焦点。
#[tauri::command]
fn window_set_pin(window: tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("获取窗口句柄失败：{error}"))?;
    platform::set_window_bottom(hwnd.0 as isize, pinned)
}

/// 读取应用配置；主题、桌面常驻等开关都存 `app_meta`，不散落在前端存储。
#[tauri::command]
fn meta_get(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    db::meta_get(&state, &key)
}

/// 写入应用配置；值只能是字符串，复杂结构由调用方序列化。
#[tauri::command]
fn meta_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    db::meta_set(&state, &key, &value)
}

/// 批量校验引用是否存在；`node_ids` 为空表示全量校验，结果同时写回数据库。
#[tauri::command]
fn ref_check(state: State<'_, AppState>, node_ids: Vec<String>) -> Result<Vec<RefStatus>, String> {
    db::ref_check(&state, &node_ids)
}

/// 重新关联缺失引用到新路径；只接受绝对路径，符号链接拒绝。
#[tauri::command]
fn ref_relink(
    state: State<'_, AppState>,
    node_id: String,
    path: String,
) -> Result<RelinkResult, String> {
    db::ref_relink(&state, &node_id, &path)
}

/// 在资源管理器中打开当前工作空间目录。
#[tauri::command]
fn workspace_open(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.workspace_path()?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("打开工作空间失败：{error}"))
}

/// 重建工作空间：清空索引，保留截图副本；原文件永远不动。
#[tauri::command]
fn workspace_rebuild(state: State<'_, AppState>) -> Result<(), String> {
    db::workspace_rebuild(&state)
}

/// 迁移工作空间到新目录；复制校验成功后切换，失败保留原目录。
#[tauri::command]
fn workspace_migrate(state: State<'_, AppState>, target: String) -> Result<WorkspaceInfo, String> {
    db::workspace_migrate(&state, Path::new(&target))
}

/// 选择一个文件用于重新关联；取消时返回 `None`，不产生任何写入。
#[tauri::command]
async fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_file();
    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

/// 选择一个空目录用于迁移工作空间；取消时返回 `None`。
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
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
            // 桌面常驻是持久配置：启动时先读，再交给 state 托管。
            let pinned = db::meta_get(&state, "desktop_pin")
                .ok()
                .flatten()
                .as_deref()
                == Some("1");
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
                if pinned {
                    if let Ok(hwnd) = window.hwnd() {
                        let _ = platform::set_window_bottom(hwnd.0 as isize, true);
                    }
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
            meta_get,
            meta_set,
            ref_check,
            ref_relink,
            workspace_open,
            workspace_rebuild,
            workspace_migrate,
            thumb_get,
            window_set_pin,
            pick_file,
            pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
