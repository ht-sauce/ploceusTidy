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
import { withEdgeColor } from '@/canvas/geometry'
import {
  arrangeGroupMembers,
  findFreeOffset,
  fitGroupToMembers,
  LAYOUT_GAP,
  nodeDisplayHeight,
  nodeRect,
} from '@/domain/layout'

/** 删除前快照，仅保留一步，用于 Ctrl+Z 撤销。 */
interface SceneSnapshot {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

/** 点是否落在空间内；多个空间重叠时取最上层（数组靠后）的那个。 */
function groupIdAt(groups: SceneGroup[], x: number, y: number) {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (x >= group.x && x <= group.x + group.w && y >= group.y && y <= group.y + group.h) {
      return group.id
    }
  }
  return ''
}

/** 对象归属空间按中心点判定：拖入即加入，拖出即脱离。 */
function membershipOf(node: SceneNode, groups: SceneGroup[]) {
  const height = nodeDisplayHeight(node)
  return groupIdAt(groups, node.x + node.w / 2, node.y + height / 2)
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
  connect: (from: string, to: string, fromHandle?: string, toHandle?: string) => void
  /** 叠放层级：置顶取当前最大 z + 1；置底取最小 z - 1。 */
  raiseNode: (id: string, to: 'top' | 'bottom') => void
  /** 挂载到父节点；父移动时子按世界坐标跟随，父删除时子卸载为独立对象。 */
  mountNode: (id: string, parentId: string) => void
  unmountNode: (id: string) => void
  /** 扩展样式：写入 `dataJson`；空串清空。非法 JSON 由调用方在保存前校验。 */
  updateNodeDataJson: (id: string, dataJson: string) => void
  createGroup: (label: string, color?: string) => SceneGroup | null
  /** 按当前阅读顺序整理空间内对象；返回整理的对象数量。 */
  arrangeGroup: (id: string) => number
  renameGroup: (id: string, title: string) => void
  setGroupColor: (id: string, color: string) => void
  setEdgeColor: (id: string, color: string) => void
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
  /** 标注会让图标格多出 12px，布局碰撞按展示高度计算。 */
  const annotatedIds = useMemo(
    () => new Set(annotations.flatMap((annotation) => annotation.nodeIds)),
    [annotations],
  )
  const detailsNode = detailsNodeId ? (nodeById.get(detailsNodeId) ?? null) : null
  const activeAnnotation = activeAnnotationId
    ? (annotations.find((annotation) => annotation.id === activeAnnotationId) ?? null)
    : null

  /**
   * 成员变化后让空间框贴合内容：拖入/新增即扩大，拖出/删除即缩小。
   * 只重算受影响的空间；尺寸与位置都没变时保持原引用，避免无谓的重渲染与保存。
   * `hasAnnotationOverride` 供标注增删场景覆盖高度判定（此时 annotatedIds 尚未更新）。
   */
  const refitGroupsOf = useCallback(
    (
      nextNodes: SceneNode[],
      groupIds: Set<string>,
      hasAnnotationOverride?: (node: SceneNode) => boolean,
    ) => {
      if (groupIds.size === 0) return
      const has = hasAnnotationOverride ?? ((node: SceneNode) => annotatedIds.has(node.id))
      setGroups((previous) => {
        let changed = false
        const next = previous.map((group) => {
          if (!groupIds.has(group.id)) return group
          const members = nextNodes.filter((node) => node.groupId === group.id)
          const fit = fitGroupToMembers(members, has)
          if (!fit) return group
          if (
            Math.abs(fit.x - group.x) < 0.5 &&
            Math.abs(fit.y - group.y) < 0.5 &&
            Math.abs(fit.w - group.w) < 0.5 &&
            Math.abs(fit.h - group.h) < 0.5
          ) {
            return group
          }
          changed = true
          return { ...group, ...fit }
        })
        return changed ? next : previous
      })
    },
    [annotatedIds],
  )
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

  const addNode = useCallback(
    (node: SceneNode) => {
      // 新对象先避开已有对象，再按落点归属空间；避免导入/新建时压在别人身上。
      const offset = findFreeOffset(
        [nodeRect(node, false)],
        nodes.map((item) => nodeRect(item, annotatedIds.has(item.id))),
        LAYOUT_GAP,
      )
      const base = { ...node, x: Math.round(node.x + offset.dx), y: Math.round(node.y + offset.dy) }
      const placed = base.groupId ? base : { ...base, groupId: membershipOf(base, groups) }
      setNodes((previous) => [...previous, placed])
      // 新对象落进空间时框随之扩大。
      if (placed.groupId) refitGroupsOf([...nodes, placed], new Set([placed.groupId]))
      setSelectedIds([placed.id])
      setActiveAnnotationId(null)
      setDetailsMode('details')
    },
    [annotatedIds, groups, nodes, refitGroupsOf],
  )

  const moveNodes = useCallback(
    (moves: { id: string; x: number; y: number }[]) => {
      const byId = new Map(moves.map((move) => [move.id, move]))
      // 已挂载的子节点不直接拖动，但要跟随父节点的世界位移，保持相对位置。
      // 按 id 建一次索引：在全量数组上逐个 find 在多选拖动时是 O(M×N)。
      const prevById = new Map(nodes.map((node) => [node.id, node]))
      const delta = new Map<string, { dx: number; dy: number }>()
      moves.forEach((move) => {
        const node = prevById.get(move.id)
        if (!node) return
        delta.set(node.id, { dx: move.x - node.x, dy: move.y - node.y })
      })
      // 多级挂载：父再有父时，子按最上层拖动者的总位移跟随（按层级逐轮归并）。
      for (let round = 0; round < nodes.length; round += 1) {
        let changed = false
        nodes.forEach((node) => {
          if (!node.parentNodeId || delta.has(node.id)) return
          const parentDelta = delta.get(node.parentNodeId)
          if (!parentDelta) return
          delta.set(node.id, parentDelta)
          changed = true
        })
        if (!changed) break
      }
      // 移动过的节点涉及的空间（旧归属 + 新归属）都要重新贴合内容。
      const affected = new Set<string>()
      const next = nodes.map((node) => {
        const move = byId.get(node.id)
        const follow = delta.get(node.id)
        if (!move && !follow) return node
        if (node.groupId) affected.add(node.groupId)
        const moved = {
          ...node,
          x: move ? move.x : node.x + (follow?.dx ?? 0),
          y: move ? move.y : node.y + (follow?.dy ?? 0),
        }
        // 拖动结束按中心点重算归属：进入空间即加入，离开即脱离。
        const groupId = membershipOf(moved, groups)
        if (groupId) affected.add(groupId)
        return { ...moved, groupId }
      })
      setNodes(next)
      refitGroupsOf(next, affected)
    },
    [groups, nodes, refitGroupsOf],
  )

  /** 叠放层级：置顶取当前最大 z + 1，置底取最小 z - 1，保持相对次序。 */
  const raiseNode = useCallback(
    (id: string, to: 'top' | 'bottom') => {
      if (nodes.length === 0) return
      // 循环代替 Math.min(...map)：10 万参数的展开会超出调用栈。
      let min = Infinity
      let max = -Infinity
      nodes.forEach((node) => {
        if (node.z < min) min = node.z
        if (node.z > max) max = node.z
      })
      const z = to === 'top' ? max + 1 : min - 1
      setNodes((previous) => previous.map((node) => (node.id === id ? { ...node, z } : node)))
    },
    [nodes],
  )

  /** 挂载/卸载只维护引用关系；坐标始终是世界坐标，不引入第二套坐标系。 */
  const mountNode = useCallback((id: string, parentId: string) => {
    if (id === parentId) return
    setNodes((previous) =>
      previous.map((node) => (node.id === id ? { ...node, parentNodeId: parentId } : node)),
    )
  }, [])

  const unmountNode = useCallback((id: string) => {
    setNodes((previous) =>
      previous.map((node) => (node.id === id ? { ...node, parentNodeId: undefined } : node)),
    )
  }, [])

  const updateNodeDataJson = useCallback((id: string, dataJson: string) => {
    const value = dataJson.trim()
    setNodes((previous) =>
      previous.map((node) =>
        node.id === id ? { ...node, dataJson: value ? value : undefined } : node,
      ),
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
  const connect = useCallback(
    (from: string, to: string, fromHandle?: string, toHandle?: string) => {
      if (from === to) return
      setEdges((previous) =>
        previous.some((edge) => edge.from === from && edge.to === to)
          ? previous
          : [
              ...previous,
              {
                id: `edge-${crypto.randomUUID()}`,
                from,
                to,
                fromHandle: fromHandle || undefined,
                toHandle: toHandle || undefined,
              },
            ],
      )
    },
    [],
  )

  /** 用当前选中对象的包围盒创建持久空间，并把对象归入该空间。 */
  const createGroup = useCallback(
    (label: string, color?: string) => {
      const targets = selectedIds
        .map((id) => nodeById.get(id))
        .filter((node): node is SceneNode => Boolean(node))
      if (targets.length === 0) return null

      // 单次扫描代替 Math.min(...map)：全选后建空间时展开 10 万个参数会超出调用栈。
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      targets.forEach((node) => {
        minX = Math.min(minX, node.x)
        minY = Math.min(minY, node.y)
        maxX = Math.max(maxX, node.x + node.w)
        maxY = Math.max(maxY, node.y + nodeDisplayHeight(node, annotatedIds.has(node.id)))
      })
      const box = { x: minX - 16, y: minY - 32, w: maxX - minX + 32, h: maxY - minY + 48 }
      const selected = new Set(targets.map((node) => node.id))
      // 空间与其成员整体让位：不能压在其他空间或未选中的对象上。
      const offset = findFreeOffset(
        [box, ...targets.map((node) => nodeRect(node, annotatedIds.has(node.id)))],
        [
          ...groups.map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h })),
          ...nodes
            .filter((node) => !selected.has(node.id))
            .map((node) => nodeRect(node, annotatedIds.has(node.id))),
        ],
        LAYOUT_GAP,
        16,
        16,
        16,
      )
      const group: SceneGroup = {
        id: `group-${crypto.randomUUID()}`,
        title: label,
        color,
        x: box.x + offset.dx,
        y: box.y + offset.dy,
        w: box.w,
        h: box.h,
      }

      setGroups((previous) => [...previous, group])
      setNodes((previous) =>
        previous.map((node) =>
          selected.has(node.id)
            ? {
                ...node,
                x: node.x + offset.dx,
                y: node.y + offset.dy,
                groupId: group.id,
              }
            : node,
        ),
      )
      setSelectedGroupId(group.id)
      setSelectedIds([])
      return group
    },
    [annotatedIds, groups, nodeById, nodes, selectedIds],
  )

  /**
   * 空间内自动整理：保持当前阅读顺序排成网格，空间随之收高；
   * 若变高后压到其他空间，则按 16px 步长整体让位，内部对象跟随平移。
   */
  const arrangeGroup = useCallback(
    (id: string) => {
      const group = groupById.get(id)
      if (!group) return 0
      const members = nodes.filter((node) => node.groupId === id)
      if (members.length === 0) return 0
      const arranged = arrangeGroupMembers(members, group, LAYOUT_GAP, (node) =>
        annotatedIds.has(node.id),
      )
      const nextBox = { x: group.x, y: group.y, w: arranged.width, h: arranged.height }
      const obstacles = [
        ...groups
          .filter((item) => item.id !== id)
          .map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h })),
        ...nodes
          .filter((node) => node.groupId !== id)
          .map((node) => nodeRect(node, annotatedIds.has(node.id))),
      ]
      const offset = findFreeOffset([nextBox], obstacles, LAYOUT_GAP, 16, 16, 16)
      undoRef.current = { nodes, groups, edges, annotations }
      setGroups((previous) =>
        previous.map((item) =>
          item.id === id
            ? {
                ...item,
                x: Math.round(item.x + offset.dx),
                y: Math.round(item.y + offset.dy),
                w: arranged.width,
                h: arranged.height,
              }
            : item,
        ),
      )
      const positions = new Map(arranged.positions.map((item) => [item.id, item]))
      setNodes((previous) =>
        previous.map((node) => {
          const position = positions.get(node.id)
          return position ? { ...node, x: position.x + offset.dx, y: position.y + offset.dy } : node
        }),
      )
      return members.length
    },
    [annotatedIds, annotations, edges, groupById, groups, nodes],
  )

  /** 空间标题即空间标注，重命名后立即显示在空间框上。 */
  const renameGroup = useCallback((id: string, title: string) => {
    const next = title.trim()
    if (!next) return
    setGroups((previous) =>
      previous.map((group) => (group.id === id ? { ...group, title: next } : group)),
    )
  }, [])

  const setGroupColor = useCallback((id: string, color: string) => {
    setGroups((previous) =>
      previous.map((group) => (group.id === id ? { ...group, color } : group)),
    )
  }, [])

  /** 连线颜色写进 `styleJson`，与已有样式字段合并。 */
  const setEdgeColor = useCallback((id: string, color: string) => {
    setEdges((previous) =>
      previous.map((edge) =>
        edge.id === id ? { ...edge, styleJson: withEdgeColor(edge.styleJson, color) } : edge,
      ),
    )
  }, [])

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
      setNodes((previous) =>
        previous
          .filter((node) => !ids.has(node.id))
          // 被删父节点的子节点卸载为独立对象，坐标不变。
          .map((node) =>
            ids.has(node.parentNodeId ?? '') ? { ...node, parentNodeId: undefined } : node,
          ),
      )
      setEdges((previous) => previous.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)))
      setAnnotations((previous) =>
        previous
          .map((annotation) => ({
            ...annotation,
            nodeIds: annotation.nodeIds.filter((id) => !ids.has(id)),
          }))
          .filter((annotation) => annotation.nodeIds.length > 0),
      )
      // 成员被删后空间框随之缩小。
      const removedGroupId = nodes.find((node) => node.id === target.id)?.groupId
      if (removedGroupId) {
        refitGroupsOf(
          nodes.filter((node) => !ids.has(node.id)),
          new Set([removedGroupId]),
        )
      }
      setSelectedIds([])
      setDetailsNodeId((current) => (current === target.id ? null : current))
    },
    [annotations, edges, groups, nodes, refitGroupsOf],
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
    // 被删成员涉及的空间都要重新贴合。
    const affectedGroups = new Set<string>()
    selectedIds.forEach((id) => {
      const groupId = nodeById.get(id)?.groupId
      if (groupId) affectedGroups.add(groupId)
    })
    setNodes((previous) =>
      previous
        .filter((node) => !ids.has(node.id))
        // 被删父节点的子节点卸载为独立对象，坐标不变。
        .map((node) =>
          ids.has(node.parentNodeId ?? '') ? { ...node, parentNodeId: undefined } : node,
        ),
    )
    setEdges((previous) => previous.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)))
    setAnnotations((previous) =>
      previous
        .map((annotation) => ({
          ...annotation,
          nodeIds: annotation.nodeIds.filter((id) => !ids.has(id)),
        }))
        .filter((annotation) => annotation.nodeIds.length > 0),
    )
    refitGroupsOf(
      nodes.filter((node) => !ids.has(node.id)),
      affectedGroups,
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
    nodeById,
    nodes,
    refitGroupsOf,
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
      // 标注让成员变高，涉及空间重新贴合；annotatedIds 尚未包含新标注，用覆盖判定。
      const annotated = new Set(targetIds)
      refitGroupsOf(
        nodes,
        new Set(
          targetIds.map((id) => nodeById.get(id)?.groupId ?? '').filter((groupId) => groupId),
        ),
        (node) => annotatedIds.has(node.id) || annotated.has(node.id),
      )
      setSelectedIds([...targetIds])
      setActiveAnnotationId(annotation.id)
      setDetailsMode('annotation')
    },
    [annotations, annotatedIds, nodeById, nodes, openAnnotation, refitGroupsOf, selectedIds],
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
    // 标注移除后成员变矮，涉及空间重新贴合；被移除的成员按无标注算高度。
    const removed = new Set(activeAnnotation.nodeIds)
    refitGroupsOf(
      nodes,
      new Set(
        activeAnnotation.nodeIds
          .map((id) => nodeById.get(id)?.groupId ?? '')
          .filter((groupId) => groupId),
      ),
      (node) => !removed.has(node.id) && annotatedIds.has(node.id),
    )
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [activeAnnotation, annotatedIds, nodeById, nodes, refitGroupsOf])

  /**
   * 文字卡片在画布上直接编辑：`live` 为真时只同步显示，收尾时才判定是否保存。
   * 空内容视为放弃修改，保留原文，避免误删。
   */
  const commitText = useCallback(
    (id: string, text: string, live = false) => {
      setNodes((previous) =>
        previous.map((node) => {
          if (node.id !== id) return node
          if (!live && (text.trim() === '' || text.trim() === (node.body ?? ''))) return node
          const firstLine = text.split('\n').find((line) => line.trim()) ?? '新文字'
          return { ...node, name: firstLine.slice(0, 28), subtitle: text, body: text }
        }),
      )
      // 收尾保存时名称可能改变行数 → 成员高度变化，所属空间重新贴合。
      const node = nodes.find((item) => item.id === id)
      if (!live && node?.groupId && text.trim() !== '' && text.trim() !== (node.body ?? '')) {
        const firstLine = text.split('\n').find((line) => line.trim()) ?? '新文字'
        const changed = { ...node, name: firstLine.slice(0, 28), subtitle: text, body: text }
        refitGroupsOf(
          nodes.map((item) => (item.id === id ? changed : item)),
          new Set([node.groupId]),
        )
      }
    },
    [nodes, refitGroupsOf],
  )

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
    raiseNode,
    mountNode,
    unmountNode,
    updateNodeDataJson,
    createGroup,
    arrangeGroup,
    renameGroup,
    setGroupColor,
    setEdgeColor,
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
