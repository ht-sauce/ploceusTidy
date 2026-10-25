/**
 * Tauri IPC 封装：前端唯一允许接触桌面能力的地方。
 * 所有命令只传引用 ID 与展示数据，不传任意文件路径（HC-12）。
 */
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  ImportResult,
  RefStatus,
  RelinkResult,
  SceneAnnotation,
  SceneData,
  SceneDelta,
  SceneEdge,
  SceneGroup,
  SceneNode,
  WorkspaceInfo,
} from '@/types/scene'

/** 浏览器调试模式下为 false，用于跳过桌面专属逻辑。 */
export const isDesktopClient = isTauri()

/**
 * 场景序列化走 Web Worker：10 万对象的 JSON.stringify 在主线程是 100–300ms
 * 的一次性卡顿（松手保存后），放 Worker 后主线程只做一次结构化克隆。
 * Worker 不可用或出错时回退主线程序列化，保证保存不失败。
 */
let sceneWorker: Worker | null = null
function stringifyScene(scene: SceneData): Promise<string> {
  if (typeof Worker === 'undefined') return Promise.resolve(JSON.stringify(scene))
  try {
    if (!sceneWorker) {
      sceneWorker = new Worker(new URL('./sceneSerialize.worker.ts', import.meta.url), {
        type: 'module',
      })
    }
    const worker = sceneWorker
    return new Promise<string>((resolve, reject) => {
      const onMessage = (event: MessageEvent<string>) => {
        cleanup()
        resolve(event.data)
      }
      const onError = (event: ErrorEvent) => {
        cleanup()
        reject(new Error(event.message || '场景序列化失败'))
      }
      const cleanup = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({ scene })
    })
  } catch {
    return Promise.resolve(JSON.stringify(scene))
  }
}

/**
 * 保存增量协议：基线按对象引用对比——不可变更新保证未变对象引用不变，
 * diff 不可能遗漏；常规保存只序列化/传输变化与删除的行（量级通常是个位数对象），
 * 10 万画布的常规保存不再序列化整场景，也就不需要为克隆付主线程成本。
 * 每 `FULL_SAVE_INTERVAL` 次与失败后的首存强制全量对账，防增量链路缺陷累积漂移。
 */
interface SaveBaseline {
  nodes: Map<string, SceneNode>
  groups: Map<string, SceneGroup>
  edges: Map<string, SceneEdge>
  annotations: Map<string, SceneAnnotation>
}

const FULL_SAVE_INTERVAL = 20
let saveBaseline: SaveBaseline | null = null
let saveSequence = 0
/** 保存串行链：防抖窗口重叠时也不并发写库，基线更新严格有序。 */
let saveChain: Promise<void> = Promise.resolve()

function toBaseline(scene: SceneData): SaveBaseline {
  return {
    nodes: new Map(scene.nodes.map((item) => [item.id, item])),
    groups: new Map(scene.groups.map((item) => [item.id, item])),
    edges: new Map(scene.edges.map((item) => [item.id, item])),
    annotations: new Map(scene.annotations.map((item) => [item.id, item])),
  }
}

/** 按引用求差：引用相同即未变；上次有、本次无即删除。 */
function diffScene(scene: SceneData, baseline: SaveBaseline): SceneDelta {
  const delta: SceneDelta = {
    nodes: [],
    removedNodeIds: [],
    groups: [],
    removedGroupIds: [],
    edges: [],
    removedEdgeIds: [],
    annotations: [],
    removedAnnotationIds: [],
  }
  const collect = <T extends { id: string }>(
    current: T[],
    previous: Map<string, T>,
    changed: T[],
    removed: string[],
  ) => {
    const seen = new Set<string>()
    current.forEach((item) => {
      seen.add(item.id)
      if (previous.get(item.id) !== item) changed.push(item)
    })
    previous.forEach((_value, id) => {
      if (!seen.has(id)) removed.push(id)
    })
  }
  collect(scene.nodes, baseline.nodes, delta.nodes, delta.removedNodeIds)
  collect(scene.groups, baseline.groups, delta.groups, delta.removedGroupIds)
  collect(scene.edges, baseline.edges, delta.edges, delta.removedEdgeIds)
  collect(scene.annotations, baseline.annotations, delta.annotations, delta.removedAnnotationIds)
  return delta
}

function deltaIsEmpty(delta: SceneDelta): boolean {
  return (
    delta.nodes.length === 0 &&
    delta.removedNodeIds.length === 0 &&
    delta.groups.length === 0 &&
    delta.removedGroupIds.length === 0 &&
    delta.edges.length === 0 &&
    delta.removedEdgeIds.length === 0 &&
    delta.annotations.length === 0 &&
    delta.removedAnnotationIds.length === 0
  )
}

async function doSave(scene: SceneData): Promise<void> {
  // 先快照基线引用：模块级变量在 await 间可能被清空，diff 只认本次读到的基线。
  const baseline = saveBaseline
  const full = !baseline || saveSequence % FULL_SAVE_INTERVAL === 0
  try {
    if (full) {
      // 全量：整场景序列化走 Worker；Rust 侧按指纹只写变化行。
      const json = await stringifyScene(scene).catch(() => JSON.stringify(scene))
      await invoke<void>('scene_save', { scene: json })
    } else {
      const delta = diffScene(scene, baseline)
      if (deltaIsEmpty(delta)) return
      // 增量通常是个位数对象：直接主线程 stringify，不值得付 Worker 往返。
      await invoke<void>('scene_save_delta', { delta: JSON.stringify(delta) })
    }
  } catch (error) {
    // 失败清基线：下一次强制全量对账，防基线与库内状态错位。
    saveBaseline = null
    throw error
  }
  saveBaseline = toBaseline(scene)
  saveSequence += 1
}

function saveScene(scene: SceneData): Promise<void> {
  saveChain = saveChain.then(
    () => doSave(scene),
    () => doSave(scene),
  )
  return saveChain
}

export const desktopApi = {
  loadScene: () => invoke<SceneData>('scene_load'),
  // 常规为增量保存（只传变化行）；全量与失败恢复见上方增量协议说明。
  saveScene,
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
  /** 在指定屏幕坐标弹出 Windows 原生文件右键菜单（含 Shell 扩展）。 */
  showSystemMenu: (nodeId: string, x: number, y: number) =>
    invoke<void>('show_system_menu', { nodeId, x: Math.round(x), y: Math.round(y) }),
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
