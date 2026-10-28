/**
 * 场景共享类型：前端状态、Tauri IPC 与 Rust 侧 `models.rs` 一一对应。
 * 字段名保持 camelCase，与 Rust 的 `#[serde(rename_all = "camelCase")]` 对齐。
 */

/**
 * 节点类型；`file` 涵盖所有普通文件，具体图标由 `icon` 区分。
 * `richtext` 是应用内的富文本卡片：`body` 存 HTML，`subtitle` 存同名纯文本投影，
 * 名称与搜索都用投影，避免把标签当成内容索引。
 */
export type SceneNodeKind = 'file' | 'folder' | 'image' | 'video' | 'text' | 'link' | 'richtext'

/** 系统图标种类，仅用于展示，不参与业务判断。 */
export type SystemIconKind =
  | 'folder'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'dwg'
  | 'exe'
  | 'image'
  | 'video'
  | 'txt'
  | 'link'
  | 'text'
  | 'rich'

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
  /** 所属分组框 ID；空字符串表示未分组。 */
  groupId: string
  /** 叠放层级，数值大的在上层。 */
  z: number
  /** 扩展样式（JSON 字符串）；`accent` 用作卡片描边色。 */
  dataJson?: string
  x: number
  y: number
  w: number
  h: number
  /** 文件是否存在；文字与链接恒为 true，由校验结果维护。 */
  isExists: boolean
  /** 缩略图缓存键；为空表示尚未生成。 */
  thumbKey?: string
}

/** 分组框：独立存储，节点通过 `groupId` 归属，坐标始终为世界坐标。 */
export interface SceneGroup {
  id: string
  /** 空间标题即空间标注，可由用户重命名。 */
  title: string
  /** 空间主色（#RRGGBB）；为空时回退主题主色。 */
  color?: string
  x: number
  y: number
  w: number
  h: number
}

/** 有向连线，`from` → `to` 为节点 ID；锚点为空时按节点中心自动路由。 */
export interface SceneEdge {
  id: string
  from: string
  to: string
  fromHandle?: string
  toHandle?: string
  label?: string
  styleJson?: string
}

/** 结构化标注：一条标注可覆盖多个节点。 */
export interface SceneAnnotation {
  id: string
  nodeIds: string[]
  color: 'amber' | 'red' | 'blue' | 'teal'
  text: string
}

/**
 * 搜索条目：节点、标注、空间与连线共用同一套搜索结果结构。
 * `nodeId` 始终是定位目标（空间填空间 ID，连线填起点 ID）；
 * 标注通过 `annotationId`、空间通过 `groupId`、连线通过 `edgeId` 回指原对象。
 */
export interface SearchEntry {
  nodeId: string
  type: SceneNodeKind | 'annotation' | 'group' | 'edge'
  title: string
  subtitle: string
  icon: SystemIconKind
  searchText: string
  /** 名称的拼音首字母（小写、无空格），用于「xiangmu」这类输入。 */
  pinyin: string
  annotationId?: string
  groupId?: string
  edgeId?: string
}

/** `scene_load` / `scene_save` 的完整场景快照。 */
export interface SceneData {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

/**
 * 场景增量：按对象引用对比上次成功保存的基线自动求差（不可变更新保证
 * 未变对象引用不变），只传新增/变化的行与显式删除的 ID。
 */
export interface SceneDelta {
  nodes: SceneNode[]
  removedNodeIds: string[]
  groups: SceneGroup[]
  removedGroupIds: string[]
  edges: SceneEdge[]
  removedEdgeIds: string[]
  annotations: SceneAnnotation[]
  removedAnnotationIds: string[]
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
  sizeBytes: number
  dbBytes: number
  assetsBytes: number
  thumbnailBytes: number
}

/** 单个引用的磁盘校验结果；缺失与恢复都通过 `isExists` 回传。 */
export interface RefStatus {
  nodeId: string
  path?: string
  isExists: boolean
  size?: number
  mtime?: number
}

/** 重新关联结果：返回更新后的节点，前端直接替换卡片。 */
export interface RelinkResult {
  node: SceneNode
  status: RefStatus
}

/** 四套浅色主题 ID；缺省或非法值回退 `mist-purple`。 */
export type ThemeId = 'mist-purple' | 'slate-blue' | 'reed-green' | 'graphite'
