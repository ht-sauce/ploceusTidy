mod db;
mod models;
mod platform;

use base64::Engine;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use db::AppState;
use models::{ImportRequest, ImportResult, SceneData, SceneNode, WorkspaceInfo};

#[tauri::command]
fn workspace_get(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    db::workspace_info(&state)
}

#[tauri::command]
fn scene_load(state: State<'_, AppState>) -> Result<SceneData, String> {
    db::scene_load(&state)
}

#[tauri::command]
fn scene_save(state: State<'_, AppState>, scene: SceneData) -> Result<(), String> {
    db::scene_save(&state, &scene)
}

#[tauri::command]
fn import_paths(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportResult, String> {
    db::import_paths(&state, &request)
}

#[tauri::command]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    platform::read_clipboard_files()
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

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

#[tauri::command]
fn reveal_ref(app: AppHandle, state: State<'_, AppState>, node_id: String) -> Result<(), String> {
    let (path, _) = db::node_target(&state, &node_id)?;
    let path = path.ok_or_else(|| "该对象没有文件路径".to_string())?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| format!("定位文件失败：{error}"))
}

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
