//! 文件变更监听：已导入引用所在目录发生变化时，即时刷新卡片的存在状态。
//!
//! 边界：
//! - 只监听**父目录**（非递归之外的逐文件监听成本过高），事件防抖 800ms 后统一校验；
//! - 只做「存在 / 缺失」的增量更新，不做重命名猜测——改名后旧引用就是缺失，
//!   由用户「重新关联」处理，避免把两张卡片悄悄指到同一个文件；
//! - 监听失败只记日志，绝不影响主功能。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, AppState};
use crate::logging;

/// 事件静默这么久之后才统一校验：解压或批量复制会连发成百上千个事件。
const QUIET: Duration = Duration::from_millis(800);
/// 目录集合的对账间隔：导入 / 重连后由 `resync` 立即推送，这里兜底轮询。
const TICK: Duration = Duration::from_millis(600);
/// 逐个确认监听目录是否还在：目录被删除 / 改名后底层句柄会失效，必须摘掉才能重挂。
const EXIST_CHECK: Duration = Duration::from_secs(5);
/// 全量重建监听句柄的间隔：兜住「目录删掉又在同一路径建回来」这种句柄已失效、
/// 但 `exists()` 依然为真的情况——否则该目录之后的所有变化都静默丢失。
const REWATCH: Duration = Duration::from_secs(60);

static DESIRED: OnceLock<Arc<Mutex<HashSet<PathBuf>>>> = OnceLock::new();

fn desired() -> &'static Arc<Mutex<HashSet<PathBuf>>> {
    DESIRED.get_or_init(|| Arc::new(Mutex::new(HashSet::new())))
}

/// 重算需要监听的目录集合；启动、导入、重连后调用。
pub fn resync(app: &AppHandle) {
    let state = app.state::<AppState>();
    match db::ref_dirs(&state) {
        Ok(dirs) => {
            let next: HashSet<PathBuf> = dirs.into_iter().collect();
            if let Ok(mut slot) = desired().lock() {
                *slot = next;
            }
        }
        Err(error) => logging::warn(&format!("读取监听目录失败：{error}")),
    }
}

/// 启动监听线程：失败只记日志，主功能照常。
pub fn start(app: AppHandle) {
    resync(&app);
    let (sender, receiver) = channel::<notify::Result<Event>>();
    let mut watcher = match RecommendedWatcher::new(
        move |result| {
            let _ = sender.send(result);
        },
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            logging::error(&format!("启动文件监听失败：{error}"));
            return;
        }
    };

    let shared = desired().clone();
    thread::spawn(move || {
        let mut watched: HashSet<PathBuf> = HashSet::new();
        let mut pending: Vec<PathBuf> = Vec::new();
        let mut last_event = Instant::now();
        let mut last_exist_check = Instant::now();
        let mut last_rewatch = Instant::now();

        loop {
            // 目录消失：句柄随之失效，先从 watched 摘掉，等它出现时重新走 added 分支。
            if last_exist_check.elapsed() >= EXIST_CHECK {
                last_exist_check = Instant::now();
                let gone: Vec<PathBuf> = watched
                    .iter()
                    .filter(|dir| !dir.exists())
                    .cloned()
                    .collect();
                for dir in gone {
                    let _ = watcher.unwatch(&dir);
                    watched.remove(&dir);
                }
            }
            // 定期原地重建句柄：删掉又建回同一路径时 exists() 仍是 true，
            // 只靠上面的检查摘不掉失效句柄。
            if last_rewatch.elapsed() >= REWATCH {
                last_rewatch = Instant::now();
                for dir in watched.clone() {
                    let _ = watcher.unwatch(&dir);
                    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
                        watched.remove(&dir);
                    }
                }
            }

            let want: HashSet<PathBuf> = shared
                .lock()
                .map(|slot| slot.clone())
                .unwrap_or_default();
            let added: Vec<PathBuf> = want.difference(&watched).cloned().collect();
            for dir in added {
                if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                    watched.insert(dir);
                }
            }
            let removed: Vec<PathBuf> = watched.difference(&want).cloned().collect();
            for dir in removed {
                let _ = watcher.unwatch(&dir);
                watched.remove(&dir);
            }

            match receiver.recv_timeout(TICK) {
                Ok(Ok(event)) => {
                    for path in event.paths {
                        if let Some(parent) = path.parent() {
                            let parent = parent.to_path_buf();
                            if !pending.iter().any(|item| item == &parent) {
                                pending.push(parent);
                            }
                        }
                    }
                    last_event = Instant::now();
                }
                Ok(Err(error)) => logging::warn(&format!("文件监听事件错误：{error}")),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }

            if pending.is_empty() || last_event.elapsed() < QUIET {
                continue;
            }
            let dirs: Vec<String> = pending
                .drain(..)
                .map(|path| path.to_string_lossy().to_string())
                .collect();
            let state = app.state::<AppState>();
            match db::ref_check_under_dirs(&state, &dirs) {
                Ok(statuses) if !statuses.is_empty() => {
                    logging::info(&format!("文件变更：{} 个引用状态更新", statuses.len()));
                    if let Err(error) = app.emit("refs://changed", &statuses) {
                        logging::warn(&format!("推送引用状态失败：{error}"));
                    }
                }
                Ok(_) => {}
                Err(error) => logging::error(&format!("目录级校验失败：{error}")),
            }
        }
    });
}
