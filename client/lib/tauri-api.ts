/**
 * Tauri IPC 封装：前端唯一允许接触桌面能力的地方。
 * 所有命令只传引用 ID 与展示数据，不传任意文件路径（HC-12）。
 */
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ImportResult, RefStatus, RelinkResult, SceneData, WorkspaceInfo } from '@/types/scene'

/** 浏览器调试模式下为 false，用于跳过桌面专属逻辑。 */
export const isDesktopClient = isTauri()

export const desktopApi = {
  loadScene: () => invoke<SceneData>('scene_load'),
  saveScene: (scene: SceneData) => invoke<void>('scene_save', { scene }),
  /** 批量导入绝对路径；去重与失败明细由 Rust 侧统一处理。 */
  importPaths: (paths: string[], x: number, y: number) =>
    invoke<ImportResult>('import_paths', { request: { paths, x, y } }),
  /** 读取资源管理器复制到剪贴板的文件路径（Windows CF_HDROP）。 */
  readClipboardFiles: () => invoke<string[]>('read_clipboard_files'),
  /** 打开节点对应的原文件或 URL。 */
  openRef: (nodeId: string) => invoke<void>('open_ref', { nodeId }),
  /** 在资源管理器中定位节点对应的文件。 */
  revealRef: (nodeId: string) => invoke<void>('reveal_ref', { nodeId }),
  /** 把粘贴的截图写入 dataWorkSpace/assets，返回落盘路径。 */
  saveClipboardImage: (data: string, ext: string) =>
    invoke<string>('save_clipboard_image', { data, ext }),
  /** 返回图片 data URL；超过 24MB 由 Rust 侧拒绝。 */
  previewRef: (nodeId: string) => invoke<string>('preview_ref', { nodeId }),
  workspaceGet: () => invoke<WorkspaceInfo>('workspace_get'),
  /** 用 Windows Shell 生成缩略图；不可用时返回 null。 */
  thumbGet: (nodeId: string, size = 96) => invoke<string | null>('thumb_get', { nodeId, size }),
  /** 校验引用是否仍存在；传空数组表示全量。 */
  refCheck: (nodeIds: string[] = []) => invoke<RefStatus[]>('ref_check', { nodeIds }),
  /** 重新关联缺失引用到新路径。 */
  refRelink: (nodeId: string, path: string) => invoke<RelinkResult>('ref_relink', { nodeId, path }),
  /** 读取应用配置（主题、桌面常驻等）。 */
  metaGet: (key: string) => invoke<string | null>('meta_get', { key }),
  metaSet: (key: string, value: string) => invoke<void>('meta_set', { key, value }),
  workspaceOpen: () => invoke<void>('workspace_open'),
  workspaceRebuild: () => invoke<void>('workspace_rebuild'),
  workspaceMigrate: (target: string) => invoke<WorkspaceInfo>('workspace_migrate', { target }),
  /** 桌面常驻：把窗口压到普通窗口之下。 */
  windowSetPin: (pinned: boolean) => invoke<void>('window_set_pin', { pinned }),
  /** 选择一个文件用于重新关联；取消返回 null。 */
  pickFile: () => invoke<string | null>('pick_file'),
  /** 选择迁移目标目录；取消返回 null。 */
  pickFolder: () => invoke<string | null>('pick_folder'),
  /** F12 调试；release 构建同样可用。 */
  openDevtools: () => invoke<void>('open_devtools'),
}

/**
 * 窗口控制：无边框窗口下由标题栏按钮调用。
 * 对应权限在 `desktop/capabilities/default.json` 显式声明，缺失会静默失败。
 */
export const desktopWindow = {
  minimize: () => (isDesktopClient ? getCurrentWindow().minimize() : Promise.resolve()),
  toggleMaximize: () => (isDesktopClient ? getCurrentWindow().toggleMaximize() : Promise.resolve()),
  close: () => (isDesktopClient ? getCurrentWindow().close() : Promise.resolve()),
}
