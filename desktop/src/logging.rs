//! 本地日志：工作空间内滚动写入，供用户反馈问题时取证。
//!
//! 边界：
//! - 只写 `dataWorkSpace/logs/app.log`，本机、不外传（HC-13）；
//! - 单文件到 2MB 轮转一份 `app.1.log`，只留一份备份，避免无限增长；
//! - 日志不做结构化上报，也不记录文件内容，只记操作名、错误与必要时被截断的路径。
//!
//! 未初始化时所有写入静默丢弃：日志永远不能影响主流程。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static LOG_PATH: OnceLock<Mutex<PathBuf>> = OnceLock::new();
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 单条日志的字符上限：堆栈与长路径需要保留，但不允许把文件刷爆。
const MAX_LINE_CHARS: usize = 2000;

pub fn init(workspace: &Path) -> Result<(), String> {
    let dir = workspace.join("logs");
    fs::create_dir_all(&dir).map_err(|error| format!("创建日志目录失败：{error}"))?;
    let path = dir.join("app.log");
    let _ = LOG_PATH.set(Mutex::new(path));
    info("应用启动");
    Ok(())
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error(&format!("panic: {info}"));
        previous(info);
    }));
}

fn rotate_if_needed(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < MAX_BYTES {
        return;
    }
    let backup = path.with_file_name("app.1.log");
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, backup);
}

pub fn write(level: &str, message: &str) {
    let Some(lock) = LOG_PATH.get() else {
        return;
    };
    let Ok(path) = lock.lock().map(|value| value.clone()) else {
        return;
    };
    rotate_if_needed(&path);
    let trimmed: String = message.chars().take(MAX_LINE_CHARS).collect();
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{stamp}] {level} {trimmed}\n");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
    if level == "ERROR" {
        // 关键错误同时打到 stderr，开发时不必翻文件。
        eprintln!("{line}");
    }
}

pub fn info(message: &str) {
    write("INFO", message);
}

pub fn warn(message: &str) {
    write("WARN", message);
}

pub fn error(message: &str) {
    write("ERROR", message);
}
