import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ImportResult, SceneData, WorkspaceInfo } from '@/types/scene'

export const isDesktopClient = isTauri()

export const desktopApi = {
  loadScene: () => invoke<SceneData>('scene_load'),
  saveScene: (scene: SceneData) => invoke<void>('scene_save', { scene }),
  importPaths: (paths: string[], x: number, y: number) =>
    invoke<ImportResult>('import_paths', { request: { paths, x, y } }),
  readClipboardFiles: () => invoke<string[]>('read_clipboard_files'),
  openRef: (nodeId: string) => invoke<void>('open_ref', { nodeId }),
  revealRef: (nodeId: string) => invoke<void>('reveal_ref', { nodeId }),
  saveClipboardImage: (data: string, ext: string) =>
    invoke<string>('save_clipboard_image', { data, ext }),
  previewRef: (nodeId: string) => invoke<string>('preview_ref', { nodeId }),
  workspaceGet: () => invoke<WorkspaceInfo>('workspace_get'),
}

export const desktopWindow = {
  minimize: () => (isDesktopClient ? getCurrentWindow().minimize() : Promise.resolve()),
  toggleMaximize: () => (isDesktopClient ? getCurrentWindow().toggleMaximize() : Promise.resolve()),
  close: () => (isDesktopClient ? getCurrentWindow().close() : Promise.resolve()),
}
