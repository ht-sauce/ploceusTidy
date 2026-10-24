export type SceneNodeKind = 'file' | 'folder' | 'image' | 'video' | 'text' | 'link'

export type SystemIconKind =
  'folder' | 'pdf' | 'docx' | 'xlsx' | 'dwg' | 'exe' | 'image' | 'video' | 'txt' | 'link' | 'text'

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

export interface SceneGroup {
  id: string
  title: string
  x: number
  y: number
  w: number
  h: number
}

export interface SceneEdge {
  id: string
  from: string
  to: string
}

export interface SceneAnnotation {
  id: string
  nodeIds: string[]
  color: 'amber' | 'red' | 'blue' | 'teal'
  text: string
}

export interface SearchEntry {
  nodeId: string
  type: SceneNodeKind | 'annotation'
  title: string
  subtitle: string
  icon: SystemIconKind
  searchText: string
  annotationId?: string
}

export interface SceneData {
  nodes: SceneNode[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

export interface ImportError {
  path: string
  reason: string
}

export interface ImportResult {
  created: SceneNode[]
  existing: SceneNode[]
  errors: ImportError[]
}

export interface WorkspaceInfo {
  path: string
  dbPath: string
  nodeCount: number
}
