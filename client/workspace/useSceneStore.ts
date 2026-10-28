/**
 * 场景领域状态：节点、空间、连线、标注与选择，以及所有会改动它们的命令。
 *
 * 职责边界：
 * - 只维护场景数据与选中态，不碰文件系统、剪贴板、窗口与快捷键；
 * - 每个会改场景的命令都先写一份快照到撤销栈（上限 30 步），Ctrl+Z / Ctrl+Shift+Z 往返；
 *   连续的方向键微调按 800ms 合并成一步，避免一次挪动产生几十条历史；
 * - 空间（分组框）与节点同属场景，空间可被连线引用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SceneAnnotation, SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import { withEdgeColor } from '@/canvas/geometry'
import {
  arrangeGroupMembers,
  findFreeOffset,
  fitGroupToMembers,
  GROUP_PADDING,
  groupDisplayBox,
  LAYOUT_GAP,
  nodeDisplayHeight,
  nodeRect,
  rectsOverlap,
} from '@/domain/layout'

/** 撤销栈里的一步快照：四张表整体引用，不可变更新保证快照零拷贝。 */
interface SceneSnapshot {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

/** 撤销栈深度；快照只存数组引用，深度大不占内存。 */
const UNDO_LIMIT = 30
/** 同一合并键在窗口内的连续命令只记一步（方向键微调专用）。 */
const COALESCE_MS = 800

/** 点是否落在空间内；多个空间重叠时取最上层（数组靠后）的那个。 */
function groupIdAt(groups: SceneGroup[], x: number, y: number) {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    // 折叠的空间只剩标题条：按显示框判定，避免把对象悄悄放进看不见的空间。
    const box = groupDisplayBox(groups[index])
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
      return groups[index].id
    }
  }
  return ''
}

/** 对象归属空间按中心点判定：拖入即加入，拖出即脱离。 */
function membershipOf(node: SceneNode, groups: SceneGroup[]) {
  const height = nodeDisplayHeight(node)
  return groupIdAt(groups, node.x + node.w / 2, node.y + height / 2)
}

/**
 * 按给定坐标平移一批对象，并按中心点重算空间归属。
 * 返回新数组、需要重新贴合的空间，以及因本次移动新增成员的空间（这些空间要整理）。
 */
function relocatedNodes(
  nodes: SceneNode[],
  groups: SceneGroup[],
  moves: Map<string, { x: number; y: number }>,
) {
  const refit = new Set<string>()
  const entered = new Set<string>()
  const next = nodes.map((node) => {
    const move = moves.get(node.id)
    if (!move) return node
    if (node.groupId) refit.add(node.groupId)
    const moved = { ...node, x: move.x, y: move.y }
    const groupId = membershipOf(moved, groups)
    if (groupId) refit.add(groupId)
    if (groupId && groupId !== node.groupId) entered.add(groupId)
    return { ...moved, groupId }
  })
  return { next, refit, entered }
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
  /** 每个空间的成员数（随 nodes 变化重算一次）。 */
  groupCounts: Map<string, number>
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
  /** 方向键微调：整体平移选中对象，不触发空间整理，连续按键合并为一步撤销。 */
  nudgeSelected: (dx: number, dy: number) => void
  moveGroup: (id: string, dx: number, dy: number) => void
  /** 手动调整空间框（四角拖拽提交）：只改框本身；下次成员变化时仍按内容自动贴合。 */
  resizeGroup: (id: string, box: { x: number; y: number; w: number; h: number }) => void
  connect: (from: string, to: string, fromHandle?: string, toHandle?: string) => void
  /** 叠放层级：置顶取当前最大 z + 1；置底取最小 z - 1。 */
  raiseNode: (id: string, to: 'top' | 'bottom') => void
  /** 扩展样式：写入 `dataJson`；空串清空。非法 JSON 由调用方在保存前校验。 */
  updateNodeDataJson: (id: string, dataJson: string) => void
  createGroup: (label: string, color?: string) => SceneGroup | null
  /** 按当前阅读顺序整理空间内对象；返回整理的对象数量。 */
  arrangeGroup: (id: string) => number
  renameGroup: (id: string, title: string) => void
  /** 折叠只影响渲染与命中，不改存储尺寸；属于视图状态，不进撤销栈。 */
  setGroupCollapsed: (id: string, collapsed: boolean) => void
  /** 把对象移入空间（空串表示移出），落点排在空间内容末尾。 */
  moveNodeToGroup: (nodeId: string, groupId: string) => void
  setGroupColor: (id: string, color: string) => void
  setEdgeColor: (id: string, color: string) => void
  deleteSelection: () => boolean
  deleteTarget: (target: { kind: 'node' | 'group' | 'edge'; id: string }) => void
  /** 外部直接改场景（批量导入）前记一步历史，保证导入也能撤销。 */
  markHistory: () => void
  undo: () => boolean
  redo: () => boolean

  openAnnotation: (annotation: SceneAnnotation) => void
  addAnnotation: (targetIds?: string[]) => void
  saveAnnotation: (text: string) => void
  removeAnnotation: () => void
  /**
   * 提交文字/富文本内容：`plain` 决定卡片名称与副标题（取首个非空行），`body` 是持久化内容
   * （纯文本即原文，富文本为 HTML）。空内容视为放弃修改，保留原文，避免误删。
   */
  commitContent: (id: string, body: string, plain: string, live?: boolean) => void
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

  /** 撤销 / 重做双栈，加一个合并键窗口（连续微调只记一步）。 */
  const historyRef = useRef<{ undo: SceneSnapshot[]; redo: SceneSnapshot[] }>({
    undo: [],
    redo: [],
  })
  const coalesceRef = useRef<{ key: string; at: number } | null>(null)
  /** 当前场景的最新引用：命令里需要「改动前」的快照，用它读不产生额外依赖。 */
  const latestRef = useRef<SceneSnapshot>({ nodes, groups, edges, annotations })
  useEffect(() => {
    latestRef.current = { nodes, groups, edges, annotations }
  })

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  /** 每个空间的成员数：右键菜单等处按 id 读取，避免每次全量 filter。 */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    nodes.forEach((node) => {
      if (node.groupId) counts.set(node.groupId, (counts.get(node.groupId) ?? 0) + 1)
    })
    return counts
  }, [nodes])
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

  // ---------- 撤销 / 重做 ----------

  /** 记一步历史：`coalesceKey` 相同的连续命令在 800ms 内只保留最初那一步快照。 */
  const markHistory = useCallback((coalesceKey = '') => {
    const history = historyRef.current
    const now = Date.now()
    const previous = coalesceRef.current
    if (coalesceKey && previous?.key === coalesceKey && now - previous.at < COALESCE_MS) {
      coalesceRef.current = { key: coalesceKey, at: now }
      return
    }
    coalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null
    history.undo.push({ ...latestRef.current })
    if (history.undo.length > UNDO_LIMIT) history.undo.shift()
    // 新操作会切断重做链，与常见编辑器一致。
    history.redo.length = 0
  }, [])

  const restore = useCallback((snapshot: SceneSnapshot) => {
    setNodes(snapshot.nodes)
    setGroups(snapshot.groups)
    setEdges(snapshot.edges)
    setAnnotations(snapshot.annotations)
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
    setDetailsNodeId(null)
  }, [])

  const undo = useCallback(() => {
    const history = historyRef.current
    const snapshot = history.undo.pop()
    if (!snapshot) return false
    history.redo.push({ ...latestRef.current })
    coalesceRef.current = null
    restore(snapshot)
    return true
  }, [restore])

  const redo = useCallback(() => {
    const history = historyRef.current
    const snapshot = history.redo.pop()
    if (!snapshot) return false
    history.undo.push({ ...latestRef.current })
    coalesceRef.current = null
    restore(snapshot)
    return true
  }, [restore])

  // ---------- 场景改动 ----------

  const addNode = useCallback(
    (node: SceneNode) => {
      markHistory()
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
    [annotatedIds, groups, markHistory, nodes, refitGroupsOf],
  )

  /**
   * 拖动落点提交。整理策略：**只在对象进出空间时**按网格整理该空间；
   * 空间内部拖动压到成员时只把被拖对象推到最近空位，不重排整组——
   * 「整理」是明确动作（右键「自动整理空间」），不该由一次拖动顺带触发。
   */
  const moveNodes = useCallback(
    (moves: { id: string; x: number; y: number }[]) => {
      // 只收真正改变坐标的对象：落点被拒绝时会带着原坐标回调，
      // 没有位移就不写历史，避免 Ctrl+Z 空转一次。
      const previousById = new Map(nodes.map((node) => [node.id, node]))
      const requested = new Map<string, { x: number; y: number }>()
      moves.forEach((move) => {
        const node = previousById.get(move.id)
        if (!node) return
        const x = Math.round(move.x)
        const y = Math.round(move.y)
        if (node.x === x && node.y === y) return
        requested.set(move.id, { x, y })
      })
      if (requested.size === 0) return
      markHistory()
      const { next, refit, entered } = relocatedNodes(nodes, groups, requested)
      const hasAnnotation = (node: SceneNode) => annotatedIds.has(node.id)

      // 进出空间：按网格整理，和右键「自动整理空间」同一套尺度。
      const positions = new Map<string, { x: number; y: number }>()
      entered.forEach((groupId) => {
        const group = groupById.get(groupId)
        if (!group) return
        arrangeGroupMembers(
          next.filter((node) => node.groupId === groupId),
          group,
          LAYOUT_GAP,
          hasAnnotation,
        ).positions.forEach((item) => positions.set(item.id, item))
      })

      // 组内重叠：只把本次移动的对象推到最近空位，其他成员保持用户摆好的位置。
      const membersByGroup = new Map<string, SceneNode[]>()
      next.forEach((node) => {
        if (!node.groupId || entered.has(node.groupId) || !requested.has(node.id)) return
        const list = membersByGroup.get(node.groupId)
        if (list) list.push(node)
        else membersByGroup.set(node.groupId, [node])
      })
      membersByGroup.forEach((moved, groupId) => {
        const members = next.filter((node) => node.groupId === groupId)
        moved.forEach((node) => {
          const rect = nodeRect(node, hasAnnotation(node))
          const blocked = members.some(
            (other) =>
              other.id !== node.id &&
              rectsOverlap(rect, nodeRect(other, hasAnnotation(other)), LAYOUT_GAP),
          )
          if (!blocked) return
          const offset = findFreeOffset(
            [rect],
            members
              .filter((other) => other.id !== node.id)
              .map((other) => nodeRect(other, hasAnnotation(other))),
            LAYOUT_GAP,
            24,
            8,
            8,
          )
          positions.set(node.id, { x: rect.x + offset.dx, y: rect.y + offset.dy })
        })
      })

      const placed =
        positions.size > 0
          ? next.map((node) => {
              const position = positions.get(node.id)
              return position ? { ...node, x: position.x, y: position.y } : node
            })
          : next
      setNodes(placed)
      refitGroupsOf(placed, refit)
    },
    [annotatedIds, groupById, groups, markHistory, nodes, refitGroupsOf],
  )

  /**
   * 方向键微调：只平移坐标并重算归属，不做整理、不做落点校验——
   * 精确摆放本来就是用户意图，连续按键按合并键写成一步撤销。
   */
  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0 || (dx === 0 && dy === 0)) return
      markHistory('nudge')
      const ids = new Set(selectedIds)
      const moves = new Map<string, { x: number; y: number }>()
      nodes.forEach((node) => {
        if (ids.has(node.id)) moves.set(node.id, { x: node.x + dx, y: node.y + dy })
      })
      if (moves.size === 0) return
      const { next, refit } = relocatedNodes(nodes, groups, moves)
      setNodes(next)
      refitGroupsOf(next, refit)
    },
    [groups, markHistory, nodes, refitGroupsOf, selectedIds],
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
      markHistory()
      setNodes((previous) => previous.map((node) => (node.id === id ? { ...node, z } : node)))
    },
    [markHistory, nodes],
  )

  const updateNodeDataJson = useCallback(
    (id: string, dataJson: string) => {
      const value = dataJson.trim()
      markHistory()
      setNodes((previous) =>
        previous.map((node) =>
          node.id === id ? { ...node, dataJson: value ? value : undefined } : node,
        ),
      )
    },
    [markHistory],
  )

  /** 移动空间时带动内部节点，保持相对位置不变。 */
  const moveGroup = useCallback(
    (id: string, dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return
      markHistory()
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
    },
    [markHistory],
  )

  /** 手动调框：成员不移动，框可大于成员包围盒（便于预留放入空间）；成员下次变化时自动重算贴合。 */
  const resizeGroup = useCallback(
    (id: string, box: { x: number; y: number; w: number; h: number }) => {
      markHistory()
      setGroups((previous) =>
        previous.map((group) =>
          group.id === id
            ? {
                ...group,
                x: Math.round(box.x),
                y: Math.round(box.y),
                w: Math.round(box.w),
                h: Math.round(box.h),
              }
            : group,
        ),
      )
    },
    [markHistory],
  )

  /** 建立有向连线；同向重复静默忽略，自连直接拒绝。 */
  const connect = useCallback(
    (from: string, to: string, fromHandle?: string, toHandle?: string) => {
      if (from === to) return
      if (edges.some((edge) => edge.from === from && edge.to === to)) return
      markHistory()
      setEdges((previous) => [
        ...previous,
        {
          id: `edge-${crypto.randomUUID()}`,
          from,
          to,
          fromHandle: fromHandle || undefined,
          toHandle: toHandle || undefined,
        },
      ])
    },
    [edges, markHistory],
  )

  /** 用当前选中对象的包围盒创建持久空间，并把对象归入该空间。 */
  const createGroup = useCallback(
    (label: string, color?: string) => {
      const targets = selectedIds
        .map((id) => nodeById.get(id))
        .filter((node): node is SceneNode => Boolean(node))
      if (targets.length === 0) return null
      markHistory()

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
        collapsed: false,
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
    [annotatedIds, groups, markHistory, nodeById, nodes, selectedIds],
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
      markHistory()
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
    [annotatedIds, groupById, groups, markHistory, nodes],
  )

  const setGroupCollapsed = useCallback((id: string, collapsed: boolean) => {
    setGroups((previous) =>
      previous.map((group) => (group.id === id ? { ...group, collapsed } : group)),
    )
  }, [])

  /**
   * 把对象移入空间：落点排在空间内容末尾（最下方、按空间内边距左对齐），
   * 原始位置不再保留——「移动到空间」就是明确的空间归属动作。
   */
  const moveNodeToGroup = useCallback(
    (nodeId: string, groupId: string) => {
      const node = nodeById.get(nodeId)
      if (!node || node.groupId === groupId) return
      markHistory()
      const target = groupId ? groupById.get(groupId) : null
      const siblings = target
        ? nodes.filter((item) => item.groupId === groupId && item.id !== nodeId)
        : []
      const bottom = siblings.reduce(
        (max, item) => Math.max(max, item.y + nodeDisplayHeight(item, annotatedIds.has(item.id))),
        target ? target.y + GROUP_PADDING * 2 : 0,
      )
      const placed: SceneNode = target
        ? {
            ...node,
            groupId: target.id,
            x: Math.round(target.x + GROUP_PADDING),
            y: Math.round(bottom + LAYOUT_GAP),
          }
        : { ...node, groupId: '' }
      const next = nodes.map((item) => (item.id === nodeId ? placed : item))
      setNodes(next)
      // 旧归属缩小、新归属放大，两边都要重新贴合。
      const affected = new Set<string>()
      if (node.groupId) affected.add(node.groupId)
      if (target) affected.add(target.id)
      refitGroupsOf(next, affected)
      setSelectedIds([nodeId])
    },
    [annotatedIds, groupById, markHistory, nodeById, nodes, refitGroupsOf],
  )

  /** 空间标题即空间标注，重命名后立即显示在空间框上。 */
  const renameGroup = useCallback(
    (id: string, title: string) => {
      const next = title.trim()
      if (!next) return
      markHistory()
      setGroups((previous) =>
        previous.map((group) => (group.id === id ? { ...group, title: next } : group)),
      )
    },
    [markHistory],
  )

  const setGroupColor = useCallback(
    (id: string, color: string) => {
      markHistory()
      setGroups((previous) =>
        previous.map((group) => (group.id === id ? { ...group, color } : group)),
      )
    },
    [markHistory],
  )

  /** 连线颜色写进 `styleJson`，与已有样式字段合并。 */
  const setEdgeColor = useCallback(
    (id: string, color: string) => {
      markHistory()
      setEdges((previous) =>
        previous.map((edge) =>
          edge.id === id ? { ...edge, styleJson: withEdgeColor(edge.styleJson, color) } : edge,
        ),
      )
    },
    [markHistory],
  )

  /** 删除按目标执行：节点连带边与标注，空间只删框，连线只删边。返回是否执行。 */
  const deleteTarget = useCallback(
    (target: { kind: 'node' | 'group' | 'edge'; id: string }) => {
      markHistory()
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
    [markHistory, nodes, refitGroupsOf],
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
    markHistory()
    const ids = new Set(selectedIds)
    // 被删成员涉及的空间都要重新贴合。
    const affectedGroups = new Set<string>()
    selectedIds.forEach((id) => {
      const groupId = nodeById.get(id)?.groupId
      if (groupId) affectedGroups.add(groupId)
    })
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
    deleteTarget,
    markHistory,
    nodeById,
    nodes,
    refitGroupsOf,
    selectedEdgeId,
    selectedGroupId,
    selectedIds,
  ])

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
      markHistory()
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
    [
      annotations,
      annotatedIds,
      markHistory,
      nodeById,
      nodes,
      openAnnotation,
      refitGroupsOf,
      selectedIds,
    ],
  )

  const saveAnnotation = useCallback(
    (text: string) => {
      if (!activeAnnotation) return
      markHistory()
      setAnnotations((previous) =>
        previous.map((annotation) =>
          annotation.id === activeAnnotation.id
            ? { ...annotation, text: text.trim() || '空标注' }
            : annotation,
        ),
      )
    },
    [activeAnnotation, markHistory],
  )

  const removeAnnotation = useCallback(() => {
    if (!activeAnnotation) return
    markHistory()
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
  }, [activeAnnotation, annotatedIds, markHistory, nodeById, nodes, refitGroupsOf])

  /**
   * 内容写回节点：`live` 为真时只同步显示，收尾时才判定是否保存。
   * 空内容视为放弃修改，保留原文，避免误删。
   */
  const commitContent = useCallback(
    (id: string, body: string, plain: string, live = false) => {
      const node = nodes.find((item) => item.id === id)
      if (!node) return
      // 富文本的纯文本投影不含媒体；只有图片/视频的正文仍是有效内容。
      const hasMedia =
        node.kind === 'richtext' && /<(?:img|video)\b[^>]*\bsrc=["']assets\//i.test(body)
      if (!live && plain.trim() === '' && !hasMedia) return
      if (node.body === body && node.subtitle === plain) return
      const firstLine =
        plain.split('\n').find((line) => line.trim()) ?? (hasMedia ? '富文本媒体' : '新文字')
      const changed: SceneNode = {
        ...node,
        name: firstLine.trim().slice(0, 28),
        subtitle: plain,
        body,
      }
      if (!live) markHistory()
      setNodes((previous) => previous.map((item) => (item.id === id ? changed : item)))
      // 收尾保存时名称可能改变行数 → 成员高度变化，所属空间重新贴合。
      if (!live && node.groupId) {
        refitGroupsOf(
          nodes.map((item) => (item.id === id ? changed : item)),
          new Set([node.groupId]),
        )
      }
    },
    [markHistory, nodes, refitGroupsOf],
  )

  const toggleEdgeLabel = useCallback(
    (id: string, label: string) => {
      markHistory()
      setEdges((previous) =>
        previous.map((edge) =>
          edge.id === id ? { ...edge, label: label.trim() || undefined } : edge,
        ),
      )
    },
    [markHistory],
  )

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
    groupCounts,
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
    nudgeSelected,
    moveGroup,
    resizeGroup,
    connect,
    raiseNode,
    updateNodeDataJson,
    createGroup,
    arrangeGroup,
    renameGroup,
    setGroupCollapsed,
    moveNodeToGroup,
    setGroupColor,
    setEdgeColor,
    deleteSelection,
    deleteTarget,
    markHistory,
    undo,
    redo,
    openAnnotation,
    addAnnotation,
    saveAnnotation,
    removeAnnotation,
    commitContent,
    toggleEdgeLabel,
  }
}
