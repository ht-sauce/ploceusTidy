/**
 * 场景共享类型：前端状态、Tauri IPC 与 Rust 侧 `models.rs` 一一对应。
 * 字段名保持 camelCase，与 Rust 的 `#[serde(rename_all = "camelCase")]` 对齐。
 */

/** 节点类型；`file` 涵盖所有普通文件，具体图标由 `icon` 区分。 */
export type SceneNodeKind = 'file' | 'folder' | 'image' | 'video' | 'text' | 'link'

/** 系统图标种类，仅用于展示，不参与业务判断。 */
export type SystemIconKind =
  'folder' | 'pdf' | 'docx' | 'xlsx' | 'dwg' | 'exe' | 'image' | 'video' | 'txt' | 'link' | 'text'

/**
 * 画布节点。
 * 坐标是画布世界坐标（px）；`path` / `url` 只保存引用，不保存文件内容。
 */
export interface SceneNode {
  id: string
  kind: SceneNodeKind
  icon: SystemIconKind
  name: string
  path?: string
  subtitle: string
  body?: string
  url?: string
  groupId: string
  x: number
  y: number
  w: number
  h: number
}

/** 分组框；v1 仅作为画布上的视觉容器，子节点坐标暂不相对化。 */
export interface SceneGroup {
  id: string
  title: string
  x: number
  y: number
  w: number
  h: number
}

/** 有向连线，`from` → `to` 为节点 ID。 */
export interface SceneEdge {
  id: string
  from: string
  to: string
}

/** 结构化标注：一条标注可覆盖多个节点。 */
export interface SceneAnnotation {
  id: string
  nodeIds: string[]
  color: 'amber' | 'red' | 'blue' | 'teal'
  text: string
}

/**
 * 搜索条目：节点与标注共用同一套搜索结果结构。
 * 标注条目通过 `annotationId` 回指原标注。
 */
export interface SearchEntry {
  nodeId: string
  type: SceneNodeKind | 'annotation'
  title: string
  subtitle: string
  icon: SystemIconKind
  searchText: string
  annotationId?: string
}

/** `scene_load` / `scene_save` 的完整场景快照。 */
export interface SceneData {
  nodes: SceneNode[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

/** 单个导入失败项；`reason` 必须能让用户定位原因（HC-14）。 */
export interface ImportError {
  path: string
  reason: string
}

/**
 * 批量导入结果：
 * - `created` 新建节点
 * - `existing` 命中去重后定位的已有节点
 * - `errors` 失败项，不允许静默丢弃
 */
export interface ImportResult {
  created: SceneNode[]
  existing: SceneNode[]
  errors: ImportError[]
}

/** 工作空间信息，供设置面板展示。 */
export interface WorkspaceInfo {
  path: string
  dbPath: string
  nodeCount: number
}
