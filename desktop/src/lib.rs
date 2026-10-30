//! 络雀桌面端入口：注册 Tauri 命令、初始化工作空间与主窗口。
//!
//! 命令边界：前端只传 `nodeId` / 绝对路径 / 展示数据；文件系统、剪贴板与
//! SQLite 都留在这里的 Rust 侧处理（HC-12、HC-13）。

mod db;
mod logging;
mod models;
mod platform;
mod watcher;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use std::borrow::Cow;
use std::path::Path;
use tauri::ipc::InvokeBody;
use tauri::{http, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use db::AppState;
use models::{
    ExportRequest, ExportResult, ImportProgress, ImportRequest, ImportResult, RefStatus,
    RelinkResult, SceneData, SceneDelta, WorkspaceInfo,
};

/// 导入任务的取消标记：`job_id → 是否已取消`，由 `cancel_import` 置位。
/// 放静态表而不放 `AppState`，避免测试夹具与状态结构互相牵动。
static IMPORT_JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn import_jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    IMPORT_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 启动参数里带进来的待导入路径（双击/「发送到」/命令行 `ploceus.exe <文件…>`）。
static PENDING_IMPORTS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn pending_imports() -> &'static Mutex<Vec<String>> {
    PENDING_IMPORTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// 从命令行参数里挑出真实存在的路径：`--add` 只作语义标记，其余按「存在即可导入」处理。
fn extract_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    let mut paths = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        if Path::new(&arg).exists() && !paths.iter().any(|item| item == &arg) {
            paths.push(arg);
        }
    }
    paths
}

/// 把外部传入的路径排进待导入队列；由前端启动后主动取走。
fn queue_imports(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut slot) = pending_imports().lock() {
        for path in paths {
            if !slot.iter().any(|item| item == &path) {
                slot.push(path);
            }
        }
    }
}


/// 返回工作空间路径、数据库路径与节点数量，供设置面板展示。
/// 异步命令：占用统计要递归扫描整个工作空间目录，属磁盘 IO，不能占主线程。
#[tauri::command]
async fn workspace_get(app: AppHandle) -> Result<WorkspaceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::workspace_info(&state)
    })
    .await
    .map_err(|error| format!("读取工作空间信息任务失败：{error}"))?
}

/// 读取完整场景；首屏一次性加载，缩略图等重数据后续按需补充。
/// 异步命令：查询与结果序列化都在运行时线程执行，不阻塞主线程（10 万对象时明显）。
#[tauri::command]
async fn scene_load(app: AppHandle) -> Result<SceneData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::scene_load(&state)
    })
    .await
    .map_err(|error| format!("加载场景任务失败：{error}"))?
}

/// 增量保存完整场景：按 ID upsert，只清理本次快照之外的对象，失败整体回滚。
/// 前端已把场景序列化为 JSON 字符串（Web Worker 完成），这里解析与写库都在运行时线程。
#[tauri::command]
async fn scene_save(app: AppHandle, scene: String) -> Result<(), String> {
    let parsed: SceneData =
        serde_json::from_str(&scene).map_err(|error| format!("解析场景失败：{error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::scene_save(&state, &parsed)
    })
    .await
    .map_err(|error| format!("保存场景任务失败：{error}"))?
}

/// 增量保存：前端按对象引用对比上次成功保存的基线自动求差，只传变化与显式删除的行；
/// 传输量正比于变更量，10 万画布的常规保存不再序列化整场景。
/// 每 20 次与失败后的首存由前端强制走全量 `scene_save` 对账，防增量链路缺陷漂移。
#[tauri::command]
async fn scene_save_delta(app: AppHandle, delta: String) -> Result<(), String> {
    let parsed: SceneDelta =
        serde_json::from_str(&delta).map_err(|error| format!("解析增量失败：{error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::scene_save_delta(&state, &parsed)
    })
    .await
    .map_err(|error| format!("保存增量任务失败：{error}"))?
}

/// 批量导入绝对路径：Rust 侧负责规范化、符号链接校验与去重，失败项带路径与原因返回。
/// 分批提交并推送 `import://progress`，用户可随时 `cancel_import` 取消（已处理的部分保留）。
#[tauri::command]
async fn import_paths(
    app: AppHandle,
    request: ImportRequest,
    job_id: String,
) -> Result<ImportResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut jobs) = import_jobs().lock() {
        jobs.insert(job_id.clone(), cancel.clone());
    }

    let progress_job = job_id.clone();
    let progress_app = app.clone();
    let task_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = task_app.state::<AppState>();
        db::import_paths_with_progress(
            &state,
            &request,
            |done, total, current| {
                let payload = ImportProgress {
                    job_id: progress_job.clone(),
                    done,
                    total,
                    current: current.to_string(),
                };
                let _ = progress_app.emit("import://progress", payload);
            },
            || cancel.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(|error| format!("导入任务失败：{error}"))?;

    if let Ok(mut jobs) = import_jobs().lock() {
        jobs.remove(&job_id);
    }

    match &outcome {
        Ok(result) => {
            logging::info(&format!(
                "导入结束：新建 {}，已存在 {}，失败 {}，取消 {}",
                result.created.len(),
                result.existing.len(),
                result.errors.len(),
                result.cancelled
            ));
            // 新导入的文件可能落在尚未监听的目录里。
            watcher::resync(&app);
        }
        Err(error) => logging::error(&format!("导入失败：{error}")),
    }
    outcome
}

/// 取消正在进行的导入：只置标记，具体停止由分批循环检查。
#[tauri::command]
fn cancel_import(job_id: String) {
    if let Ok(jobs) = import_jobs().lock() {
        if let Some(flag) = jobs.get(&job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// 取走启动参数里带来的待导入路径（双击文件 / 「发送到」/ 命令行）。
#[tauri::command]
fn take_pending_imports() -> Vec<String> {
    pending_imports()
        .lock()
        .map(|mut slot| std::mem::take(&mut *slot))
        .unwrap_or_default()
}

/// 读取单个节点的正文：首屏只加载紧凑索引，编辑与导出前按需拉取。
#[tauri::command]
fn node_body(state: State<'_, AppState>, node_id: String) -> Result<Option<String>, String> {
    db::node_body(&state, &node_id)
}

/// 导出文本/富文本：纯文本写 `.txt`，富文本写 `.html` 并复制正文引用的本地媒体。
#[tauri::command]
async fn export_contents(
    app: AppHandle,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::export_contents(&state, &request)
    })
    .await
    .map_err(|error| format!("导出任务失败：{error}"))?;
    match &outcome {
        Ok(result) => logging::info(&format!(
            "导出完成：{} 个文件，{} 个媒体",
            result.files.len(),
            result.media
        )),
        Err(error) => logging::error(&format!("导出失败：{error}")),
    }
    outcome
}

/// 前端日志上报：把渲染层的失败写进同一个滚动日志，便于用户反馈时取证。
#[tauri::command]
fn log_write(level: String, message: String) {
    match level.as_str() {
        "error" => logging::error(&message),
        "warn" => logging::warn(&message),
        _ => logging::info(&message),
    }
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

/// 富文本媒体上传：图片/视频以 Raw IPC 二进制体直传（不经 base64），
/// body = `[ext_len: u8][ext ascii][文件字节]`，JSON 体直接拒绝；
/// 文件名由 Rust 生成 UUID，返回 `assets/<文件名>` 相对引用。
/// 命令只收字节与扩展名，不接受路径（HC-12）。
#[tauri::command]
async fn save_rich_asset(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let body: Vec<u8> = match request.body() {
        InvokeBody::Raw(raw) => raw.to_vec(),
        _ => return Err("富文本媒体必须以二进制方式上传".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::save_rich_asset(&state, &body)
    })
    .await
    .map_err(|error| format!("保存富文本媒体任务失败：{error}"))?
}

/// `richasset` 协议的 MIME 映射；白名单外的扩展名不会落盘，这里兜底二进制流。
fn rich_asset_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogg" => "video/ogg",
        _ => "application/octet-stream",
    }
}

/// 解析 `Range: bytes=start-` / `bytes=start-end`；只在语义有效时返回分片范围，
/// 无效或缺省返回 `None`（按全量 200 响应，浏览器可接受）。
fn parse_byte_range(header: Option<&http::HeaderValue>, total: u64) -> Option<(u64, u64)> {
    let header = header?.to_str().ok()?;
    let (start_raw, end_raw) = header.strip_prefix("bytes=")?.split_once('-')?;
    let start = start_raw.trim().parse::<u64>().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_raw.trim().is_empty() {
        total - 1
    } else {
        end_raw.trim().parse::<u64>().ok()?.min(total - 1)
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
mod media_tests {
    use super::*;

    #[test]
    fn video_ranges_cover_seeking_and_invalid_headers() {
        for (header, expected) in [
            ("bytes=0-", Some((0, 99))),
            ("bytes=40-59", Some((40, 59))),
            ("bytes=99-999", Some((99, 99))),
            ("bytes=100-", None),
            ("bytes=50-20", None),
            ("bytes=x-20", None),
            ("bytes=0-1,5-6", None),
        ] {
            let value = http::HeaderValue::from_str(header).expect("构造测试 Range 失败");
            assert_eq!(parse_byte_range(Some(&value), 100), expected, "{header}");
            assert_eq!(parse_byte_range(Some(&value), 0), None);
        }
        assert_eq!(parse_byte_range(None, 100), None);
    }
}

/// 处理 `richasset` 协议请求：把 `http://richasset.localhost/<文件名>` 映射到
/// 工作空间 assets 目录，图片与视频都以本地文件回读（HC-13：不发起网络请求）；
/// `Range` 分片支撑视频拖动进度条。
fn rich_asset_response(
    app: &AppHandle,
    request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    let not_found = |message: &'static str| {
        http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(Cow::Borrowed(message.as_bytes()))
            .expect("构造 404 响应失败")
    };
    // 保留完整相对路径交给边界校验，不能丢弃目录段后误读同名资产。
    let name = request.uri().path().trim_start_matches('/');
    let path = {
        let state = app.state::<AppState>();
        match db::rich_asset_file(&state, name) {
            Ok(path) => path,
            Err(_) => return not_found("媒体文件不存在或已被拒绝"),
        }
    };
    let total = match std::fs::metadata(&path) {
        Ok(meta) => meta.len(),
        Err(_) => return not_found("媒体文件不存在"),
    };
    // 本地媒体通常几 MB，整读后按 Range 切片即可；正确性优先于增量读盘。
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return not_found("媒体文件读取失败"),
    };
    let mime = rich_asset_mime(name.rsplit('.').next().unwrap_or(""));

    match parse_byte_range(request.headers().get("range"), total) {
        Some((start, end)) => {
            let slice = bytes[start as usize..=(end as usize)].to_vec();
            http::Response::builder()
                .status(206)
                .header("Content-Type", mime)
                .header("Content-Length", slice.len().to_string())
                .header("Content-Range", format!("bytes {start}-{end}/{total}"))
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "no-cache")
                .body(Cow::Owned(slice))
                .expect("构造 206 响应失败")
        }
        None => http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Content-Length", total.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(bytes))
            .expect("构造媒体响应失败"),
    }
}

/// 按需生成缩略图并返回 data URL；无路径、缺失或非 Windows 平台返回 `None`。
/// 异步命令：可见卡片会并发请求，文件读取与 base64 都在阻塞线程池执行。
#[tauri::command]
async fn thumb_get(
    app: AppHandle,
    node_id: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::thumb_get(&state, &node_id, size.unwrap_or(96))
    })
    .await
    .map_err(|error| format!("缩略图任务失败：{error}"))?
}

/// 桌面常驻：把窗口压到普通窗口之下；只影响层级，不改变窗口尺寸与焦点。
#[tauri::command]
fn window_set_pin(window: tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("获取窗口句柄失败：{error}"))?;
    platform::set_window_bottom(hwnd.0 as isize, pinned)
}

/// 在指定屏幕坐标弹出 Windows 原生文件右键菜单；只接受 nodeId，路径由数据库解析。
#[tauri::command]
fn show_system_menu(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    node_id: String,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let (path, _url) = db::node_target(&state, &node_id)?;
    let path = path.ok_or_else(|| "该对象没有对应的系统文件".to_string())?;
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("获取窗口句柄失败：{error}"))?;
    let raw_hwnd = hwnd.0 as isize;
    // Shell 菜单需要在自己的模态消息循环中运行，放主线程执行，命令本身立即返回。
    window
        .run_on_main_thread(move || {
            if let Err(error) = platform::show_system_context_menu(raw_hwnd, &path, x, y) {
                eprintln!("系统右键菜单失败：{error}");
            }
        })
        .map_err(|error| format!("调度系统菜单失败：{error}"))
}

/// 把多个 `nodeId` 解析为存在且不重复的原文件路径；逐个查库，不长期持锁。
/// 缺失引用与不存在的文件直接跳过；一律不修改用户文件（HC-12）。
fn resolve_existing_paths(
    state: &State<'_, AppState>,
    node_ids: &[String],
) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for node_id in node_ids {
        let (path, _url) = db::node_target(state, node_id)?;
        let Some(path) = path else { continue };
        if !Path::new(&path).exists() {
            continue;
        }
        if seen.insert(platform::normalize_path_key(Path::new(&path))) {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// 复制节点对应的原文件到剪贴板；只按 nodeId 查库解析路径，不接受前端传入的路径。
#[tauri::command]
fn copy_ref_files(state: State<'_, AppState>, node_ids: Vec<String>) -> Result<usize, String> {
    let paths = resolve_existing_paths(&state, &node_ids)?;
    if paths.is_empty() {
        return Ok(0);
    }
    platform::set_clipboard_files(&paths)?;
    Ok(paths.len())
}

/// 把节点对应的原文件拖出窗口：路径解析在命令线程完成，真正的拖放在主线程执行。
/// 拖放会阻塞到用户松手，因此命令立即返回，不等待拖放结果。
#[tauri::command]
fn drag_out_refs(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    node_ids: Vec<String>,
) -> Result<(), String> {
    let paths = resolve_existing_paths(&state, &node_ids)?;
    if paths.is_empty() {
        return Err("选中的对象没有可拖出的原文件".to_string());
    }
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("获取窗口句柄失败：{error}"))?;
    let raw_hwnd = hwnd.0 as isize;
    // DoDragDrop 会跑自己的模态拖放循环，必须放主线程；命令本身立即返回。
    window
        .run_on_main_thread(move || {
            if let Err(error) = platform::start_file_drag(raw_hwnd, paths) {
                eprintln!("拖出文件失败：{error}");
            }
        })
        .map_err(|error| format!("调度拖出文件失败：{error}"))
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
/// 异步命令：全量校验是长时间批处理，不能占用主线程。
#[tauri::command]
async fn ref_check(app: AppHandle, node_ids: Vec<String>) -> Result<Vec<RefStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::ref_check(&state, &node_ids)
    })
    .await
    .map_err(|error| format!("校验任务失败：{error}"))?
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
/// 异步命令：批量删除 + VACUUM 是磁盘重活，放阻塞线程池执行。
#[tauri::command]
async fn workspace_rebuild(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::workspace_rebuild(&state)
    })
    .await
    .map_err(|error| format!("重建工作空间任务失败：{error}"))?
}

/// 迁移工作空间到新目录；复制校验成功后切换，失败保留原目录。
/// 异步命令：整目录复制可能是长时间磁盘 IO，不能占用主线程。
#[tauri::command]
async fn workspace_migrate(app: AppHandle, target: String) -> Result<WorkspaceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        db::workspace_migrate(&state, Path::new(&target))
    })
    .await
    .map_err(|error| format!("迁移工作空间任务失败：{error}"))?
}

/// 选择一个文件用于重新关联；取消时返回 `None`，不产生任何写入。
#[tauri::command]
async fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_file();
    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

/// 选择导出文件的保存位置（单条导出）；取消返回 `None`。
#[tauri::command]
async fn pick_export_file(app: AppHandle, default_name: String) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .blocking_save_file();
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
    // panic 也必须留痕：用户只会说「闪退了」，日志里得有栈。
    logging::install_panic_hook();

    tauri::Builder::default()
        // 单实例必须最先注册：第二个进程启动时直接把已有窗口拉到前台并退出，
        // 避免同一 dataWorkSpace 被两个窗口同时写库。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // 「发送到」与命令行再次启动时，把路径转交给已在运行的实例。
            let paths = extract_paths(args.into_iter().skip(1));
            if !paths.is_empty() {
                queue_imports(paths.clone());
                let _ = app.emit("import://external", paths);
            }
        }))
        // 全局热键：最小化或不在前台时也能一键唤起搜索。
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("shortcut://focus-search", ());
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：检查/下载/安装都走插件；前端只负责展示进度与安装前落库。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 富文本媒体回读：`richasset` 协议直接映射到工作空间 assets 目录，
        // 图片/视频在编辑器里以本地文件显示，全程不发起网络请求。
        .register_uri_scheme_protocol("richasset", |ctx, request| {
            rich_asset_response(ctx.app_handle(), request)
        })
        .setup(|app| {
            let state = db::initialize(app.handle()).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error,
                ))
            })?;
            match state.workspace_path() {
                Ok(workspace) => {
                    if let Err(error) = logging::init(&workspace) {
                        eprintln!("日志初始化失败：{error}");
                    }
                }
                Err(error) => eprintln!("读取工作空间路径失败：{error}"),
            }
            // 首次启动就带参数（双击文件 / 「发送到」）时，先排队等前端取走。
            queue_imports(extract_paths(std::env::args().skip(1)));
            // 桌面常驻是持久配置：启动时先读，再交给 state 托管。
            let pinned = db::meta_get(&state, "desktop_pin")
                .ok()
                .flatten()
                .as_deref()
                == Some("1");
            app.manage(state);

            // 画布性能实测：设 `PLOCEUS_BENCH_SEED=<数量>` 启动即清空并灌入测试数据。
            // 仅用于 1 万/10 万基准；不设该变量时完全不触发，不影响正常使用。
            if let Ok(raw) = std::env::var("PLOCEUS_BENCH_SEED") {
                let count: i64 = raw.trim().parse().unwrap_or(0);
                if count > 0 {
                    let state = app.state::<db::AppState>();
                    if let Err(error) = db::workspace_rebuild(&state) {
                        eprintln!("基准数据清空失败：{error}");
                    } else {
                        match db::seed_bench_nodes(&state, count) {
                            Ok(done) => println!("基准数据已生成：{done} 个引用"),
                            Err(error) => eprintln!("基准数据生成失败：{error}"),
                        }
                    }
                }
            }

            // 初始窗口按当前显示器收敛到 62% × 66%，并限制上限，避免大屏一启动就铺满。
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size().to_logical::<f64>(scale);
                    let width = (size.width * 0.62).clamp(720.0, 1040.0);
                    let height = (size.height * 0.66).clamp(480.0, 720.0);
                    let _ = window.set_size(tauri::LogicalSize::new(width, height));
                    let _ = window.center();
                }
                if pinned {
                    if let Ok(hwnd) = window.hwnd() {
                        let _ = platform::set_window_bottom(hwnd.0 as isize, true);
                    }
                }
            }

            // 全局热键失败只记日志：被其他程序占用时不应阻止应用启动。
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                logging::warn(&format!("注册全局快捷键 Ctrl+Alt+Space 失败：{error}"));
            }
            // 文件变更监听：已导入引用所在目录的增删改会即时刷新卡片状态。
            watcher::start(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_get,
            scene_load,
            scene_save,
            scene_save_delta,
            import_paths,
            cancel_import,
            take_pending_imports,
            node_body,
            export_contents,
            log_write,
            read_clipboard_files,
            open_devtools,
            open_ref,
            reveal_ref,
            save_clipboard_image,
            save_rich_asset,
            meta_get,
            meta_set,
            ref_check,
            ref_relink,
            workspace_open,
            workspace_rebuild,
            workspace_migrate,
            thumb_get,
            window_set_pin,
            show_system_menu,
            copy_ref_files,
            drag_out_refs,
            pick_file,
            pick_folder,
            pick_export_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
