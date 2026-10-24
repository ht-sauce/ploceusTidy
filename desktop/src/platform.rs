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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_path_strips_extended_prefix() {
        assert_eq!(clean_path(Path::new(r"\\?\C:\a\b.txt")), r"C:\a\b.txt");
        assert_eq!(
            clean_path(Path::new(r"\\?\UNC\srv\share\x")),
            r"\\srv\share\x"
        );
        assert_eq!(clean_path(Path::new(r"C:\a\b.txt")), r"C:\a\b.txt");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_path_key_unifies_separators_and_case() {
        assert_eq!(
            normalize_path_key(Path::new(r"C:\Foo\Bar\")),
            normalize_path_key(Path::new("c:/foo/bar"))
        );
    }

    #[test]
    fn sanitize_ext_rejects_unknown() {
        assert_eq!(sanitize_ext("PNG"), "png");
        assert_eq!(sanitize_ext("exe"), "png");
        assert_eq!(sanitize_ext("../../etc"), "png");
    }

    #[test]
    fn file_icon_and_kind_recognizes_common_types() {
        assert_eq!(
            file_icon_and_kind(Path::new(r"C:\a\b.pdf")),
            ("file", "pdf")
        );
        assert_eq!(
            file_icon_and_kind(Path::new(r"C:\a\b.png")),
            ("image", "image")
        );
        assert_eq!(
            file_icon_and_kind(Path::new(r"C:\a\b.mp4")),
            ("video", "video")
        );
        assert_eq!(
            file_icon_and_kind(Path::new(r"C:\a\b.xyz")),
            ("file", "txt")
        );
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

/// 用 Windows Shell 的 `IShellItemImageFactory` 生成缩略图并编码为 PNG。
/// 失败时由调用方回退系统类型图标；调用可能发生在任意线程，因此自行初始化 COM。
#[cfg(windows)]
pub fn shell_thumbnail(path: &str, size: u32) -> Result<Vec<u8>, String> {
    use std::mem::size_of;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, SelectObject, BITMAP,
        BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
    };

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
    let result = (|| -> Result<Vec<u8>, String> {
        let factory: IShellItemImageFactory =
            unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }
                .map_err(|error| format!("获取 Shell 缩略图失败：{error}"))?;
        let bitmap = unsafe {
            factory
                .GetImage(
                    SIZE {
                        cx: size as i32,
                        cy: size as i32,
                    },
                    SIIGBF_RESIZETOFIT,
                )
                .map_err(|error| format!("生成 Shell 缩略图失败：{error}"))?
        };

        let mut source = BITMAP::default();
        let read = unsafe {
            GetObjectW(
                HGDIOBJ(bitmap.0),
                size_of::<BITMAP>() as i32,
                Some(&mut source as *mut _ as *mut _),
            )
        };
        if read == 0 || source.bmWidth <= 0 || source.bmHeight == 0 {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
            }
            return Err("Shell 缩略图尺寸无效".to_string());
        }

        let width = source.bmWidth;
        let height = source.bmHeight.abs();
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // 负高度表示自上而下存储，省去逐行翻转。
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = 0; // BI_RGB

        let mut buffer = vec![0u8; (width * height * 4) as usize];
        let device = unsafe { CreateCompatibleDC(None) };
        let previous = unsafe { SelectObject(device, HGDIOBJ(bitmap.0)) };
        let lines = unsafe {
            GetDIBits(
                device,
                bitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        unsafe {
            SelectObject(device, previous);
            let _ = DeleteDC(device);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
        }
        if lines == 0 {
            return Err("读取 Shell 缩略图像素失败".to_string());
        }

        // Shell 返回 BGRA；PNG 需要 RGBA，且 alpha 统一置为不透明。
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }

        use image::ImageEncoder;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &buffer,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| format!("编码缩略图失败：{error}"))?;
        Ok(png)
    })();

    if initialized {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(not(windows))]
pub fn shell_thumbnail(_path: &str, _size: u32) -> Result<Vec<u8>, String> {
    Err("当前版本仅支持 Windows Shell 缩略图".to_string())
}

/// 桌面常驻：把窗口压到普通窗口之下，取消时恢复普通层级。
/// 传原始 HWND 而不是窗口对象，避免与 Tauri 内部 windows crate 版本耦合。
#[cfg(windows)]
pub fn set_window_bottom(hwnd: isize, pinned: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, HWND_NOTOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let window = HWND(hwnd as *mut core::ffi::c_void);
    let insert_after = if pinned { HWND_BOTTOM } else { HWND_NOTOPMOST };
    unsafe {
        SetWindowPos(
            window,
            Some(insert_after),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    }
    .map_err(|error| format!("调整窗口层级失败：{error}"))
}

#[cfg(not(windows))]
pub fn set_window_bottom(_hwnd: isize, _pinned: bool) -> Result<(), String> {
    Err("当前版本仅支持 Windows 桌面常驻".to_string())
}
