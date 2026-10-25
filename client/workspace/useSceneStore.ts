/**
 * 场景领域状态：节点、空间、连线、标注与选择，以及所有会改动它们的命令。
 *
 * 职责边界：
 * - 只维护场景数据与选中态，不碰文件系统、剪贴板、窗口与快捷键；
 * - 删除类操作保留一步快照，供 Ctrl+Z 撤销；
 * - 空间（分组框）与节点同属场景，空间可被连线引用。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { SceneAnnotation, SceneEdge, SceneGroup, SceneNode } from '@/types/scene'

/** 删除前快照，仅保留一步，用于 Ctrl+Z 撤销。 */
interface SceneSnapshot {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

/** 合并导入结果：已有节点按 id 覆盖，重复导入不会产生第二张卡片。 */
export function mergeNodes(current: SceneNode[], incoming: SceneNode[]) {
  const map = new Map(current.map((node) => [node.id, node]))
  incoming.forEach((node) => map.set(node.id, node))
  return Array.from(map.values())
}

export interface SceneStore {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
  setNodes: React.Dispatch<React.SetStateAction<SceneNode[]>>
  setGroups: React.Dispatch<React.SetStateAction<SceneGroup[]>>
  setEdges: React.Dispatch<React.SetStateAction<SceneEdge[]>>
  setAnnotations: React.Dispatch<React.SetStateAction<SceneAnnotation[]>>
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>

  selectedIds: string[]
  selectedGroupId: string | null
  selectedEdgeId: string | null
  activeAnnotationId: string | null
  detailsNodeId: string | null
  detailsMode: 'details' | 'annotation'

  nodeById: Map<string, SceneNode>
  groupById: Map<string, SceneGroup>
  activeAnnotation: SceneAnnotation | null
  annotationTargets: SceneNode[]
  detailsNode: SceneNode | null

  selectNode: (id: string, additive: boolean) => void
  boxSelect: (ids: string[], additive: boolean) => void
  clearSelection: () => void
  selectGroup: (id: string) => void
  selectEdge: (id: string) => void
  openDetails: (id: string) => void
  closeDetails: () => void

  addNode: (node: SceneNode) => void
  moveNodes: (moves: { id: string; x: number; y: number }[]) => void
  moveGroup: (id: string, dx: number, dy: number) => void
  connect: (from: string, to: string) => void
  createGroup: (label: string) => SceneGroup | null
  deleteSelection: () => boolean
  deleteTarget: (target: { kind: 'node' | 'group' | 'edge'; id: string }) => void
  undo: () => boolean

  openAnnotation: (annotation: SceneAnnotation) => void
  addAnnotation: (targetIds?: string[]) => void
  saveAnnotation: (text: string) => void
  removeAnnotation: () => void
  commitText: (id: string, text: string, live?: boolean) => void
  toggleEdgeLabel: (id: string, label: string) => void
}

export function useSceneStore(): SceneStore {
  const [nodes, setNodes] = useState<SceneNode[]>([])
  const [groups, setGroups] = useState<SceneGroup[]>([])
  const [edges, setEdges] = useState<SceneEdge[]>([])
  const [annotations, setAnnotations] = useState<SceneAnnotation[]>([])

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null)
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null)
  const [detailsMode, setDetailsMode] = useState<'details' | 'annotation'>('details')

  const undoRef = useRef<SceneSnapshot | null>(null)

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  const detailsNode = detailsNodeId ? (nodeById.get(detailsNodeId) ?? null) : null
  const activeAnnotation = activeAnnotationId
    ? (annotations.find((annotation) => annotation.id === activeAnnotationId) ?? null)
    : null
  const annotationTargets = useMemo(
    () =>
      activeAnnotation
        ? activeAnnotation.nodeIds
            .map((id) => nodeById.get(id))
            .filter((node): node is SceneNode => Boolean(node))
        : [],
    [activeAnnotation, nodeById],
  )

  // ---------- 选择 ----------

  const selectNode = useCallback((id: string, additive: boolean) => {
    setSelectedIds((previous) => {
      if (!additive) return [id]
      return previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    })
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const boxSelect = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((previous) => (additive ? Array.from(new Set([...previous, ...ids])) : ids))
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const selectGroup = useCallback((id: string) => {
    setSelectedGroupId(id)
    setSelectedIds([])
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const selectEdge = useCallback((id: string) => {
    setSelectedEdgeId(id)
    setSelectedIds([])
    setSelectedGroupId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const openDetails = useCallback((id: string) => {
    setDetailsNodeId(id)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const closeDetails = useCallback(() => {
    setDetailsNodeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  // ---------- 场景改动 ----------

  const addNode = useCallback((node: SceneNode) => {
    setNodes((previous) => [...previous, node])
    setSelectedIds([node.id])
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const moveNodes = useCallback((moves: { id: string; x: number; y: number }[]) => {
    const byId = new Map(moves.map((move) => [move.id, move]))
    setNodes((previous) =>
      previous.map((node) => {
        const move = byId.get(node.id)
        return move ? { ...node, x: move.x, y: move.y } : node
      }),
    )
  }, [])

  /** 移动空间时带动内部节点，保持相对位置不变。 */
  const moveGroup = useCallback((id: string, dx: number, dy: number) => {
    setGroups((previous) =>
      previous.map((group) =>
        group.id === id
          ? { ...group, x: Math.round(group.x + dx), y: Math.round(group.y + dy) }
          : group,
      ),
    )
    setNodes((previous) =>
      previous.map((node) =>
        node.groupId === id
          ? { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) }
          : node,
      ),
    )
  }, [])

  /** 建立有向连线；同向重复静默忽略，自连直接拒绝。 */
  const connect = useCallback((from: string, to: string) => {
    if (from === to) return
    setEdges((previous) =>
      previous.some((edge) => edge.from === from && edge.to === to)
        ? previous
        : [...previous, { id: `edge-${crypto.randomUUID()}`, from, to }],
    )
  }, [])

  /** 用当前选中对象的包围盒创建持久空间，并把对象归入该空间。 */
  const createGroup = useCallback(
    (label: string) => {
      const targets = selectedIds
        .map((id) => nodeById.get(id))
        .filter((node): node is SceneNode => Boolean(node))
      if (targets.length === 0) return null

      const minX = Math.min(...targets.map((node) => node.x)) - 16
      const minY = Math.min(...targets.map((node) => node.y)) - 32
      const maxX = Math.max(...targets.map((node) => node.x + node.w)) + 16
      const maxY = Math.max(...targets.map((node) => node.y + node.h)) + 16
      const group: SceneGroup = {
        id: `group-${crypto.randomUUID()}`,
        title: label,
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
      }

      setGroups((previous) => [...previous, group])
      setNodes((previous) =>
        previous.map((node) =>
          selectedIds.includes(node.id) ? { ...node, groupId: group.id } : node,
        ),
      )
      setSelectedGroupId(group.id)
      setSelectedIds([])
      return group
    },
    [nodeById, selectedIds],
  )

  /** 删除按目标执行：节点连带边与标注，空间只删框，连线只删边。返回是否执行。 */
  const deleteTarget = useCallback(
    (target: { kind: 'node' | 'group' | 'edge'; id: string }) => {
      undoRef.current = { nodes, groups, edges, annotations }
      if (target.kind === 'edge') {
        setEdges((previous) => previous.filter((edge) => edge.id !== target.id))
        setSelectedEdgeId(null)
        return
      }
      if (target.kind === 'group') {
        setGroups((previous) => previous.filter((group) => group.id !== target.id))
        setNodes((previous) =>
          previous.map((node) => (node.groupId === target.id ? { ...node, groupId: '' } : node)),
        )
        // 空间作为连线端点时会留下悬空边，一并清掉。
        setEdges((previous) =>
          previous.filter((edge) => edge.from !== target.id && edge.to !== target.id),
        )
        setSelectedGroupId(null)
        return
      }
      const ids = new Set([target.id])
      setNodes((previous) => previous.filter((node) => !ids.has(node.id)))
      setEdges((previous) => previous.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)))
      setAnnotations((previous) =>
        previous
          .map((annotation) => ({
            ...annotation,
            nodeIds: annotation.nodeIds.filter((id) => !ids.has(id)),
          }))
          .filter((annotation) => annotation.nodeIds.length > 0),
      )
      setSelectedIds([])
      setDetailsNodeId((current) => (current === target.id ? null : current))
    },
    [annotations, edges, groups, nodes],
  )

  /** 按当前选择删除；返回是否真的删了东西（空选择时返回 false）。 */
  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      deleteTarget({ kind: 'edge', id: selectedEdgeId })
      return true
    }
    if (selectedGroupId) {
      deleteTarget({ kind: 'group', id: selectedGroupId })
      return true
    }
    if (selectedIds.length === 0) return false
    undoRef.current = { nodes, groups, edges, annotations }
    const ids = new Set(selectedIds)
    setNodes((previous) => previous.filter((node) => !ids.has(node.id)))
    setEdges((previous) => previous.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)))
    setAnnotations((previous) =>
      previous
        .map((annotation) => ({
          ...annotation,
          nodeIds: annotation.nodeIds.filter((id) => !ids.has(id)),
        }))
        .filter((annotation) => annotation.nodeIds.length > 0),
    )
    setSelectedIds([])
    setActiveAnnotationId(null)
    setDetailsMode('details')
    setDetailsNodeId(null)
    return true
  }, [
    annotations,
    deleteTarget,
    edges,
    groups,
    nodes,
    selectedEdgeId,
    selectedGroupId,
    selectedIds,
  ])

  const undo = useCallback(() => {
    const snapshot = undoRef.current
    if (!snapshot) return false
    undoRef.current = null
    setNodes(snapshot.nodes)
    setGroups(snapshot.groups)
    setEdges(snapshot.edges)
    setAnnotations(snapshot.annotations)
    setSelectedIds([])
    setActiveAnnotationId(null)
    setDetailsMode('details')
    return true
  }, [])

  // ---------- 标注与文字 ----------

  const openAnnotation = useCallback((annotation: SceneAnnotation) => {
    setSelectedIds(annotation.nodeIds)
    setActiveAnnotationId(annotation.id)
    setDetailsMode('annotation')
  }, [])

  const addAnnotation = useCallback(
    (targetIds: string[] = selectedIds) => {
      if (targetIds.length === 0) return
      const existing = annotations.find(
        (annotation) =>
          annotation.nodeIds.length === targetIds.length &&
          targetIds.every((id) => annotation.nodeIds.includes(id)),
      )
      if (existing) {
        openAnnotation(existing)
        return
      }
      const annotation: SceneAnnotation = {
        id: `annotation-${crypto.randomUUID()}`,
        nodeIds: [...targetIds],
        color: 'teal',
        text: '补充说明：把关键结论或下一步动作写在这里。',
      }
      setAnnotations((previous) => [...previous, annotation])
      setSelectedIds([...targetIds])
      setActiveAnnotationId(annotation.id)
      setDetailsMode('annotation')
    },
    [annotations, openAnnotation, selectedIds],
  )

  const saveAnnotation = useCallback(
    (text: string) => {
      if (!activeAnnotation) return
      setAnnotations((previous) =>
        previous.map((annotation) =>
          annotation.id === activeAnnotation.id
            ? { ...annotation, text: text.trim() || '空标注' }
            : annotation,
        ),
      )
    },
    [activeAnnotation],
  )

  const removeAnnotation = useCallback(() => {
    if (!activeAnnotation) return
    setAnnotations((previous) =>
      previous.filter((annotation) => annotation.id !== activeAnnotation.id),
    )
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [activeAnnotation])

  /**
   * 文字卡片在画布上直接编辑：`live` 为真时只同步显示，收尾时才判定是否保存。
   * 空内容视为放弃修改，保留原文，避免误删。
   */
  const commitText = useCallback((id: string, text: string, live = false) => {
    setNodes((previous) =>
      previous.map((node) => {
        if (node.id !== id) return node
        if (!live && (text.trim() === '' || text.trim() === (node.body ?? ''))) return node
        const firstLine = text.split('\n').find((line) => line.trim()) ?? '新文字'
        return { ...node, name: firstLine.slice(0, 28), subtitle: text, body: text }
      }),
    )
  }, [])

  const toggleEdgeLabel = useCallback((id: string, label: string) => {
    setEdges((previous) =>
      previous.map((edge) =>
        edge.id === id ? { ...edge, label: label.trim() || undefined } : edge,
      ),
    )
  }, [])

  return {
    nodes,
    groups,
    edges,
    annotations,
    setNodes,
    setGroups,
    setEdges,
    setAnnotations,
    setSelectedIds,
    selectedIds,
    selectedGroupId,
    selectedEdgeId,
    activeAnnotationId,
    detailsNodeId,
    detailsMode,
    nodeById,
    groupById,
    activeAnnotation,
    annotationTargets,
    detailsNode,
    selectNode,
    boxSelect,
    clearSelection,
    selectGroup,
    selectEdge,
    openDetails,
    closeDetails,
    addNode,
    moveNodes,
    moveGroup,
    connect,
    createGroup,
    deleteSelection,
    deleteTarget,
    undo,
    openAnnotation,
    addAnnotation,
    saveAnnotation,
    removeAnnotation,
    commitText,
    toggleEdgeLabel,
  }
}
