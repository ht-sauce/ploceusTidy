//! 平台能力与路径工具：只读访问文件系统，不修改用户文件（HC-12）。
//! Windows 优先；剪贴板文件读取仅在 Windows 实现，其他平台明确返回不支持。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows::core::{BOOL, HRESULT, Ref as WinRef};
#[cfg(windows)]
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_NOTIMPL,
    E_OUTOFMEMORY, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, S_FALSE, S_OK, TRUE,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl,
    IEnumSTATDATA, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
#[cfg(windows)]
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
#[cfg(windows)]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
#[cfg(windows)]
use windows::Win32::System::Ole::{
    IDropSource, IDropSource_Impl, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
};
#[cfg(windows)]
use windows::Win32::System::SystemServices::{MK_LBUTTON, MK_RBUTTON, MODIFIERKEYS_FLAGS};
#[cfg(windows)]
use windows::Win32::UI::Shell::{CFSTR_PREFERREDDROPEFFECT, DROPFILES};

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

/// macOS 剪贴板文件路径：读取 `NSPasteboard` 的 `NSFilenamesPboardType`，
/// 返回 plist 数组里的文件绝对路径。空剪贴板或无文件时返回空列表。
#[cfg(target_os = "macos")]
pub fn read_clipboard_files() -> Result<Vec<String>, String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSString};

    let pasteboard = unsafe { NSPasteboard::generalPasteboard() };
    let types = unsafe { pasteboard.types() };
    let filenames_type = NSString::from_str("NSFilenamesPboardType");
    let has_files = types
        .map(|types| unsafe { types.containsObject(&filenames_type) })
        .unwrap_or(false);
    if !has_files {
        return Ok(Vec::new());
    }

    let property_list = unsafe { pasteboard.propertyListForType(&filenames_type) };
    let Some(array) = (unsafe { property_list.downcast_ref::<NSArray<NSString>>() }) else {
        return Ok(Vec::new());
    };
    let count = unsafe { array.count() };
    let mut files = Vec::with_capacity(count as usize);
    for index in 0..count {
        if let Some(path) = unsafe { array.objectAtIndex(index) } {
            files.push(unsafe { path.to_string() }.to_string());
        }
    }
    Ok(files)
}

/// Linux 剪贴板文件路径：读取 X11 剪贴板的 `text/uri-list`（每行一个 file:// URI），
/// 解码后转为本地绝对路径。Wayland 下走 `wl-paste`，均无结果时返回空列表。
#[cfg(all(unix, not(target_os = "macos")))]
pub fn read_clipboard_files() -> Result<Vec<String>, String> {
    use std::process::Command;

    let output = Command::new("wl-paste")
        .args(["--list", "--no-newline"])
        .output()
        .or_else(|_| {
            Command::new("xclip")
                .args(["-selection", "clipboard", "-t", "text/uri-list", "-o"])
                .output()
        })
        .map_err(|error| format!("读取剪贴板失败（需要 wl-clipboard 或 xclip）：{error}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("file://"))
        .filter_map(|encoded| percent_decode(encoded))
        .collect())
}

/// 解码 `file://` URI 里的百分号编码；非法 UTF-8 序列按原样保留。
#[cfg(all(unix, not(target_os = "macos")))]
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
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

/// macOS 缩略图：`NSWorkspace` 图标栅格化到 PNG 涉及较多 AppKit 绑定，
/// 尚未在目标平台验证；v1 先返回空，由前端回退系统类型图标。
#[cfg(target_os = "macos")]
pub fn shell_thumbnail(_path: &str, _size: u32) -> Result<Vec<u8>, String> {
    Err("macOS 暂不生成缩略图，回退类型图标".to_string())
}

/// Linux 缩略图：调用 `gio`/`xdg-mime`/`ffmpeg` 都不稳定，v1 统一返回空，
/// 由前端回退系统类型图标（与 `useVisibleThumbnails` 的既有降级一致）。
#[cfg(all(unix, not(target_os = "macos")))]
pub fn shell_thumbnail(_path: &str, _size: u32) -> Result<Vec<u8>, String> {
    Err("Linux 暂不生成缩略图，回退类型图标".to_string())
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
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMF_EXTENDEDVERBS,
        CMF_NORMAL, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
    };
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

        let query = menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, CMF_NORMAL | CMF_EXTENDEDVERBS);
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
        let _ = PostMessageW(
            Some(window),
            WM_NULL,
            Default::default(),
            Default::default(),
        );

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
pub fn show_system_context_menu(_hwnd: isize, _path: &str, _x: i32, _y: i32) -> Result<(), String> {
    Err("当前版本仅支持 Windows 系统右键菜单".to_string())
}

/// 把文件绝对路径写入剪贴板（CF_HDROP）。粘贴到资源管理器或 IDE 即得到原文件地址。
/// 只在用户主动触发时调用；失败按 HC-14 带原因返回。
#[cfg(windows)]
pub fn set_clipboard_files(paths: &[String]) -> Result<(), String> {
    use clipboard_win::{formats::FileList, Clipboard, Setter};

    if paths.is_empty() {
        return Err("没有可复制到剪贴板的文件".to_string());
    }
    // 剪贴板是全局独占资源：对象必须存活到写完，Drop 时才释放锁。
    let clipboard =
        Clipboard::new_attempts(10).map_err(|error| format!("打开剪贴板失败：{error}"))?;
    FileList
        .write_clipboard(paths)
        .map_err(|error| format!("写入剪贴板文件列表失败：{error}"))?;
    drop(clipboard);
    Ok(())
}

#[cfg(not(windows))]
pub fn set_clipboard_files(_paths: &[String]) -> Result<(), String> {
    Err("当前版本仅支持 Windows 剪贴板文件写入".to_string())
}

/// 以 OLE DoDragDrop 把文件拖出窗口：必须运行在窗口所属主线程（内部会跑模态拖放循环）。
/// 只声明 COPY 效果，绝不产生「移动」语义。
#[cfg(windows)]
pub fn start_file_drag(hwnd: isize, paths: Vec<String>) -> Result<(), String> {
    use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, S_OK};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Ole::{DoDragDrop, DROPEFFECT, DROPEFFECT_COPY};

    // 拖放不需要窗口句柄：OLE 靠鼠标捕获跟踪轨迹；保留参数以便与命令签名一致。
    let _ = hwnd;
    if paths.is_empty() {
        return Err("没有可拖出的文件".to_string());
    }

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
    let result = (|| -> Result<(), String> {
        let data_object: IDataObject = HdropDataObject { paths }.into();
        let drop_source: IDropSource = FileDropSource.into();
        let mut effect = DROPEFFECT::default();
        let outcome = unsafe { DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect) };
        // 用户松手（DROP）或按 Esc 取消（CANCEL）都算正常结束，只有真失败才上报。
        if outcome == DRAGDROP_S_DROP || outcome == DRAGDROP_S_CANCEL || outcome == S_OK {
            return Ok(());
        }
        Err(format!("拖出文件失败：{outcome:?}"))
    })();

    if initialized {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(not(windows))]
pub fn start_file_drag(_hwnd: isize, _paths: Vec<String>) -> Result<(), String> {
    Err("当前版本仅支持 Windows 拖出文件".to_string())
}

/// 拖放数据对象：只提供 `CF_HDROP`（文件列表）与 `CFSTR_PREFERREDDROPEFFECT`（声明 COPY），
/// 其余格式一律拒绝，避免外部程序索取到非预期数据。
#[cfg(windows)]
#[windows::core::implement(IDataObject)]
struct HdropDataObject {
    paths: Vec<String>,
}

#[cfg(windows)]
impl IDataObject_Impl for HdropDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        if pformatetcin.is_null() {
            return Err(DV_E_FORMATETC.into());
        }
        let format = unsafe { *pformatetcin };
        let hglobal = if format.cfFormat == CF_HDROP.0 {
            build_hdrop(&self.paths)?
        } else if format.cfFormat == preferred_drop_effect_format() {
            alloc_hglobal(&DROPEFFECT_COPY.0.to_ne_bytes())?
        } else {
            return Err(DV_E_FORMATETC.into());
        };
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: hglobal },
            // 所有权交给调用方，不随 STGMEDIUM 释放。
            pUnkForRelease: Default::default(),
        })
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        if pformatetc.is_null() {
            return DV_E_FORMATETC;
        }
        let format = unsafe { *pformatetc };
        if format.cfFormat == CF_HDROP.0 || format.cfFormat == preferred_drop_effect_format() {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        _pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        E_NOTIMPL
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        let enumerator = FormatEtcEnumerator {
            formats: supported_formats(),
            index: std::sync::Mutex::new(0),
        };
        Ok(enumerator.into())
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: WinRef<'_, IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(E_NOTIMPL.into())
    }

    fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

/// 拖放数据源的格式枚举器：只枚举固定两种格式，游标仅可前移与复位。
#[cfg(windows)]
#[windows::core::implement(IEnumFORMATETC)]
struct FormatEtcEnumerator {
    formats: Vec<FORMATETC>,
    index: std::sync::Mutex<usize>,
}

#[cfg(windows)]
impl IEnumFORMATETC_Impl for FormatEtcEnumerator_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
        // 互斥量中毒只说明别的线程 panic 过，游标本身仍可用，取回内部值继续。
        let mut index = self
            .index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let start = *index;
        let remaining = self.formats.len().saturating_sub(start);
        let count = (celt as usize).min(remaining);
        for offset in 0..count {
            unsafe { rgelt.add(offset).write(self.formats[start + offset]) };
        }
        *index += count;
        if !pceltfetched.is_null() {
            unsafe { pceltfetched.write(count as u32) };
        }
        // 请求多于剩余即为部分成功，按 COM 约定返回 S_FALSE。
        if count == celt as usize {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Skip(&self, celt: u32) -> windows::core::Result<()> {
        let mut index = self
            .index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let remaining = self.formats.len().saturating_sub(*index);
        if (celt as usize) > remaining {
            *index += remaining;
            return Err(S_FALSE.into());
        }
        *index += celt as usize;
        Ok(())
    }

    fn Reset(&self) -> windows::core::Result<()> {
        *self
            .index
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = 0;
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IEnumFORMATETC> {
        let index = *self
            .index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let clone = FormatEtcEnumerator {
            formats: self.formats.clone(),
            index: std::sync::Mutex::new(index),
        };
        Ok(clone.into())
    }
}

/// 拖放源：Esc / 右键取消，左键松开落点，全程使用系统默认拖放光标。
#[cfg(windows)]
#[windows::core::implement(IDropSource)]
struct FileDropSource;

#[cfg(windows)]
impl IDropSource_Impl for FileDropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if grfkeystate.0 & MK_RBUTTON.0 != 0 {
            return DRAGDROP_S_CANCEL;
        }
        if grfkeystate.0 & MK_LBUTTON.0 == 0 {
            return DRAGDROP_S_DROP;
        }
        S_OK
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// 本数据对象支持的格式：CF_HDROP 与 Preferred DropEffect，均为全局内存块。
#[cfg(windows)]
fn supported_formats() -> Vec<FORMATETC> {
    let entry = |cf_format: u16| FORMATETC {
        cfFormat: cf_format,
        // 不针对特定输出设备，lindex 用 -1 表示整体。
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    vec![entry(CF_HDROP.0), entry(preferred_drop_effect_format())]
}

/// 取回 "Preferred DropEffect" 的运行时注册格式 ID（同一进程内恒定）。
#[cfg(windows)]
fn preferred_drop_effect_format() -> u16 {
    unsafe { RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) as u16 }
}

/// 按 CF_HDROP 格式打包路径：DROPFILES 头 + 宽字符路径列表 + 结尾双 NUL。
#[cfg(windows)]
fn build_hdrop(paths: &[String]) -> windows::core::Result<HGLOBAL> {
    use std::mem::size_of;

    let header = DROPFILES {
        pFiles: size_of::<DROPFILES>() as u32,
        fWide: TRUE,
        ..Default::default()
    };
    let mut bytes = Vec::new();
    // DROPFILES 是 packed 结构，按字节复制可避开字段对齐问题。
    unsafe {
        bytes.extend_from_slice(std::slice::from_raw_parts(
            &header as *const DROPFILES as *const u8,
            size_of::<DROPFILES>(),
        ));
    }
    for path in paths {
        for unit in path.encode_utf16() {
            bytes.extend_from_slice(&unit.to_ne_bytes());
        }
        bytes.extend_from_slice(&0u16.to_ne_bytes());
    }
    // 列表末尾需要再补一个终止 NUL。
    bytes.extend_from_slice(&0u16.to_ne_bytes());
    alloc_hglobal(&bytes)
}

/// 把字节写入可移动全局内存块；所有权交给调用方（通常是 STGMEDIUM）。
#[cfg(windows)]
fn alloc_hglobal(bytes: &[u8]) -> windows::core::Result<HGLOBAL> {
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let target = GlobalLock(handle);
        if target.is_null() {
            return Err(E_OUTOFMEMORY.into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(handle)
    }
}
