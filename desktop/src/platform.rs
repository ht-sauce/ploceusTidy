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
        // 快捷方式按可执行程序展示，前端再叠加 Shell 图标，避免显示成普通文本文件。
        "lnk" => ("file", "exe"),
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
            file_icon_and_kind(Path::new(r"C:\a\b.lnk")),
            ("file", "exe")
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

/// 在指定屏幕坐标同步弹出 Windows 原生文件右键菜单（含第三方 Shell 扩展）。
/// 调用方应放到主线程执行：`TrackPopupMenuEx` 会运行自己的模态消息循环。
#[cfg(windows)]
pub fn show_system_context_menu(hwnd: isize, path: &str, x: i32, y: i32) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err("文件不存在，无法打开系统菜单".to_string());
    }
    unsafe { show_system_context_menu_blocking(hwnd, path, x, y) }
}

#[cfg(windows)]
unsafe fn show_system_context_menu_blocking(
    hwnd: isize,
    path: &str,
    x: i32,
    y: i32,
) -> Result<(), String> {
    use std::mem::size_of;
    use windows::core::{HSTRING, PCSTR};
    use windows::Win32::Foundation::{HANDLE, HWND, POINT};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMINVOKECOMMANDINFO,
        CMINVOKECOMMANDINFOEX, CMF_EXTENDEDVERBS, CMF_NORMAL,
    };
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, PostMessageW, SetForegroundWindow, TrackPopupMenuEx,
        TPM_LEFTALIGN, TPM_RETURNCMD, TPM_TOPALIGN, WM_NULL,
    };

    let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
    let result = (|| -> Result<(), String> {
        let window = HWND(hwnd as *mut core::ffi::c_void);
        let mut pidl: *mut windows::Win32::UI::Shell::Common::ITEMIDLIST = std::ptr::null_mut();
        SHParseDisplayName(&HSTRING::from(path), None, &mut pidl, 0, None)
            .map_err(|error| format!("解析路径失败：{error}"))?;
        if pidl.is_null() {
            return Err("解析路径失败：空 PIDL".to_string());
        }

        let cleanup = |pidl: *mut windows::Win32::UI::Shell::Common::ITEMIDLIST| {
            CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        };
        let mut child: *mut windows::Win32::UI::Shell::Common::ITEMIDLIST = std::ptr::null_mut();
        let folder: IShellFolder = match SHBindToParent(pidl as *const _, Some(&mut child)) {
            Ok(folder) => folder,
            Err(error) => {
                cleanup(pidl);
                return Err(format!("绑定父目录失败：{error}"));
            }
        };
        let menu: IContextMenu = match folder.GetUIObjectOf(window, &[child as *const _], None) {
            Ok(menu) => menu,
            Err(error) => {
                cleanup(pidl);
                return Err(format!("获取系统菜单失败：{error}"));
            }
        };
        let hmenu = CreatePopupMenu().map_err(|error| format!("创建菜单失败：{error}"))?;

        let query = menu.QueryContextMenu(
            hmenu,
            0,
            1,
            0x7FFF,
            CMF_NORMAL | CMF_EXTENDEDVERBS,
        );
        if query.is_err() {
            let _ = DestroyMenu(hmenu);
            cleanup(pidl);
            return Err(format!("构建系统菜单失败：{query:?}"));
        }

        let _ = SetForegroundWindow(window);
        // 前端给的是窗口内坐标，Shell 菜单需要屏幕坐标。
        let mut anchor = POINT { x, y };
        let _ = ClientToScreen(window, &mut anchor);
        // 等当前鼠标事件序列结束后再弹菜单，否则会被同一次 mouseup 立刻取消。
        std::thread::sleep(std::time::Duration::from_millis(120));
        let command = TrackPopupMenuEx(
            hmenu,
            (TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN).0,
            anchor.x,
            anchor.y,
            window,
            None,
        )
        .0;
        // 菜单关闭后补一条空消息，避免窗口停留在菜单模式。
        let _ = PostMessageW(Some(window), WM_NULL, Default::default(), Default::default());

        if command != 0 {
            // 菜单命令 ID 从 1 开始，转换回 Shell 约定的 0 起偏移。
            let info = CMINVOKECOMMANDINFOEX {
                cbSize: size_of::<CMINVOKECOMMANDINFOEX>() as u32,
                fMask: 0,
                hwnd: window,
                lpVerb: PCSTR((command - 1) as usize as *const u8),
                lpParameters: PCSTR::null(),
                lpDirectory: PCSTR::null(),
                nShow: 1,
                dwHotKey: 0,
                hIcon: HANDLE::default(),
                lpTitle: PCSTR::null(),
                lpVerbW: windows::core::PCWSTR::null(),
                lpParametersW: windows::core::PCWSTR::null(),
                lpDirectoryW: windows::core::PCWSTR::null(),
                lpTitleW: windows::core::PCWSTR::null(),
                ptInvoke: anchor,
            };
            menu.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO)
                .map_err(|error| format!("执行系统菜单命令失败：{error}"))?;
        }

        let _ = DestroyMenu(hmenu);
        cleanup(pidl);
        Ok(())
    })();

    if initialized {
        CoUninitialize();
    }
    result
}

#[cfg(not(windows))]
pub fn show_system_context_menu(
    _hwnd: isize,
    _path: &str,
    _x: i32,
    _y: i32,
) -> Result<(), String> {
    Err("当前版本仅支持 Windows 系统右键菜单".to_string())
}
