/**
 * 画布交互会话：平移、框选、拖动、连线、空间拖动、悬停提示。
 *
 * 会话指针位置记录在 ref 里，pointerup 时按会话值提交，
 * 不依赖 state 更新顺序，也不依赖指针是否还在画布内。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import type { CanvasContextTarget, CanvasViewport, StageSize } from './types'
import type { Rect } from '@/domain/layout'
import { GHOST_DRAG_LIMIT, type HandleSide } from './constants'
import { asHandleSide, edgePoints } from './geometry'
import {
  LAYOUT_GAP,
  SNAP_THRESHOLD,
  rectsOverlap,
  snapOffset,
  type SnapGuides,
} from '@/domain/layout'

type Box = { x: number; y: number; w: number; h: number }

interface UseCanvasInteractionsOptions {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  selectedIds: string[]
  selectedSet: Set<string>
  nodeById: Map<string, SceneNode>
  size: StageSize
  stageRef: RefObject<Konva.Stage | null>
  nodeGroupRefs: RefObject<Map<string, Konva.Group>>
  /** 空间框/空间标题/箭头的图形引用：拖动期直接驱动图形，松手才提交状态。 */
  groupBoxRefs: RefObject<Map<string, Konva.Rect>>
  groupTitleRefs: RefObject<Map<string, Konva.Label>>
  edgeRefs: RefObject<Map<string, Konva.Arrow>>
  /** 超大选择集拖动时的包围盒 ghost 图形（默认隐藏）。 */
  ghostRef: RefObject<Konva.Rect | null>
  viewportRef: RefObject<CanvasViewport>
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  zoomAt: (scale: number, anchorX: number, anchorY: number) => void
  boxOf: (id: string) => Box | null
  /** 节点静态矩形（含标注高度），用于拖动碰撞与吸附；读取库值而非 Konva 实时位置。 */
  nodeRectOf: (id: string) => Rect | null
  /** 松手落点判定：rbush 查询落点附近是否有非自身对象（O(log N)），拖动结束时一次性校验。 */
  landingBlocked: (rect: Rect, movingIds: Set<string>) => boolean
  /** 对齐吸附邻居查询：rbush 取矩形 pad 范围内的非移动对象矩形，替代逐帧全量扫描。 */
  nearbyRects: (rect: Rect, pad: number, excludeIds: Set<string>) => Rect[]
  onSelect: (id: string, additive: boolean) => void
  onBoxSelect: (ids: string[], additive: boolean) => void
  onClearSelection: () => void
  onSelectGroup: (id: string) => void
  onMoveGroup: (id: string, dx: number, dy: number) => void
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void
  onConnect: (from: string, to: string, fromHandle: string, toHandle: string) => void
  onActivate: (id: string) => void
  onContextMenu: (target: CanvasContextTarget, clientX: number, clientY: number) => void
}

/** 快捷键事件必须避开输入控件，否则会吞掉正在编辑的文字。 */
function isTypingTarget(target: EventTarget | null) {
  const element = target as Element | null
  return typeof element?.closest === 'function'
    ? Boolean(element.closest('input, textarea, [contenteditable="true"]'))
    : false
}

export function useCanvasInteractions({
  nodes,
  groups,
  edges,
  selectedIds,
  selectedSet,
  nodeById,
  size,
  stageRef,
  nodeGroupRefs,
  groupBoxRefs,
  groupTitleRefs,
  edgeRefs,
  ghostRef,
  viewportRef,
  setViewport,
  zoomAt,
  boxOf,
  nodeRectOf,
  landingBlocked,
  nearbyRects,
  onSelect,
  onBoxSelect,
  onClearSelection,
  onSelectGroup,
  onMoveGroup,
  onMoveNodes,
  onConnect,
  onActivate,
  onContextMenu,
}: UseCanvasInteractionsOptions) {
  const [selectionRect, setSelectionRect] = useState<Box | null>(null)
  const [guides, setGuides] = useState<SnapGuides | null>(null)
  const [connectPreview, setConnectPreview] = useState<{
    from: string
    side: HandleSide
    x: number
    y: number
  } | null>(null)
  // 文字节点在画布上直接编辑，不使用弹窗。
  const [editor, setEditor] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SceneNode } | null>(null)
  // 空格键按住时才允许拖动画布，避免左键拖空白被误当成平移。
  const [spaceHeld, setSpaceHeld] = useState(false)

  const spaceRef = useRef(false)
  const panStart = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)
  const panMoved = useRef(false)
  const boxSession = useRef<{
    startX: number
    startY: number
    currentX: number
    currentY: number
    additive: boolean
  } | null>(null)
  const dragSession = useRef<{
    items: { id: string; x: number; y: number; rect: Rect }[]
    /** 拖动集合 id：用于落点判定与受影响连线的快速筛选。 */
    idSet: Set<string>
    /** 超大选择集降级：只拖包围盒 ghost，不逐个驱动图形。 */
    ghost: boolean
    pointerX: number
    pointerY: number
    offsetX: number
    offsetY: number
    /** 吸附前的裸偏移：吸附落点被拒时先退回裸偏移，再考虑整体回退。 */
    rawOffsetX: number
    rawOffsetY: number
    moving: boolean
  } | null>(null)
  const connectSession = useRef<{
    from: string
    side: HandleSide
    x: number
    y: number
  } | null>(null)
  const groupDrag = useRef<{
    id: string
    startX: number
    startY: number
    appliedX: number
    appliedY: number
    /** 吸附前的裸偏移：落点被拒时先退回裸偏移，再考虑整体回退（与对象拖动一致）。 */
    rawOffsetX: number
    rawOffsetY: number
    box: Rect
    mode: 'title' | 'box'
    /** 按下时的成员快照：拖动期直接驱动成员图形，松手一次性提交（成员随空间一起动，不参与碰撞）。 */
    members: { id: string; x: number; y: number }[]
  } | null>(null)
  const hoverTimer = useRef<number | null>(null)

  // 空格是平移修饰键：按下时锁定光标为抓取态，并阻止页面滚动。
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return
      event.preventDefault()
      spaceRef.current = true
      setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    const reset = () => {
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', reset)
    }
  }, [])

  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    },
    [],
  )

  const screenToWorld = (x: number, y: number) => {
    const current = viewportRef.current
    return { x: (x - current.x) / current.scale, y: (y - current.y) / current.scale }
  }

  /**
   * 参考线只在内容变化时写入 state，避免拖动时每一帧都触发整块画布重渲染。
   */
  const applyGuides = useCallback((next: SnapGuides) => {
    const empty = next.vertical.length === 0 && next.horizontal.length === 0
    setGuides((previous) => {
      if (empty) return previous === null ? previous : null
      if (
        previous &&
        previous.vertical.join('|') === next.vertical.join('|') &&
        previous.horizontal.join('|') === next.horizontal.join('|')
      ) {
        return previous
      }
      return next
    })
  }, [])

  /**
   * 连线索引：节点 id → 关联的连线 id。拖动时只更新受影响的箭头几何——
   * 之前每帧 `stage.find('Arrow')` 遍历全部图形再对每条箭头做 `edges.find`，
   * 在 2000 条连线级别是每帧百万次比较，是拖动卡顿的主因之一。
   */
  const edgeIndex = useMemo(() => {
    const byId = new Map(edges.map((edge) => [edge.id, edge]))
    const byNode = new Map<string, string[]>()
    edges.forEach((edge) => {
      ;[edge.from, edge.to].forEach((id) => {
        const list = byNode.get(id)
        if (list) list.push(edge.id)
        else byNode.set(id, [edge.id])
      })
    })
    return { byId, byNode }
  }, [edges])

  /**
   * 更新受影响连线的箭头几何：只遍历与 `activeIds` 相连的边，
   * 端点为拖动中的空间时用调用方给出的实时盒子，避免读到未提交的旧坐标。
   */
  const updateEdgeShapes = useCallback(
    (activeIds: Set<string>, groupBox?: { id: string; box: Box }) => {
      const touched = new Set<string>()
      activeIds.forEach((id) => {
        const list = edgeIndex.byNode.get(id)
        if (list) list.forEach((edgeId) => touched.add(edgeId))
      })
      if (touched.size === 0) return
      touched.forEach((edgeId) => {
        const edge = edgeIndex.byId.get(edgeId)
        const shape = edgeRefs.current.get(edgeId)
        if (!edge || !shape) return
        const from = edge.from === groupBox?.id ? groupBox.box : boxOf(edge.from)
        const to = edge.to === groupBox?.id ? groupBox.box : boxOf(edge.to)
        if (!from || !to) return
        shape.setAttr(
          'points',
          edgePoints(from, to, asHandleSide(edge.fromHandle), asHandleSide(edge.toHandle)),
        )
      })
    },
    [boxOf, edgeIndex, edgeRefs],
  )

  /**
   * 空间拖动：与对象拖动完全一致的行为模式——拖动期不校验碰撞、纯跟随指针，
   * 只做 rbush 局部对齐吸附；落点约束（不压非成员对象/其他空间）推迟到松手统一判定。
   * 拖动期不提交状态：直接驱动空间框、标题与成员节点的 Konva 图形，松手一次性提交。
   */
  const moveGroupSession = (pointerX: number, pointerY: number) => {
    const session = groupDrag.current
    if (!session) return
    const scale = viewportRef.current.scale
    let desiredX = (pointerX - session.startX) / scale
    let desiredY = (pointerY - session.startY) / scale
    session.rawOffsetX = desiredX
    session.rawOffsetY = desiredY
    // 对齐吸附：rbush 局部邻居 + 其他空间（数量少），不做任何碰撞约束。
    const threshold = SNAP_THRESHOLD / scale
    const memberIds = new Set(session.members.map((member) => member.id))
    const neighbors = nearbyRects(
      {
        x: session.box.x + desiredX - threshold,
        y: session.box.y + desiredY - threshold,
        w: session.box.w + threshold * 2,
        h: session.box.h + threshold * 2,
      },
      threshold,
      memberIds,
    )
    const groupTargets = groups
      .filter((item) => item.id !== session.id)
      .map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h }))
    const snapped = snapOffset(
      [session.box],
      [...groupTargets, ...neighbors],
      desiredX,
      desiredY,
      threshold,
    )
    desiredX = snapped.dx
    desiredY = snapped.dy
    applyGuides(snapped.guides)
    const nextX = Math.round(desiredX)
    const nextY = Math.round(desiredY)
    const stepX = nextX - session.appliedX
    const stepY = nextY - session.appliedY
    if (Math.abs(stepX) < 0.4 && Math.abs(stepY) < 0.4) return
    session.appliedX = nextX
    session.appliedY = nextY
    // 视觉直驱：框、标题（框拖动模式下 Konva 不会自己动标题）、成员节点一起位移。
    groupBoxRefs.current
      .get(session.id)
      ?.position({ x: session.box.x + nextX, y: session.box.y + nextY })
    if (session.mode === 'box') {
      groupTitleRefs.current
        .get(session.id)
        ?.position({ x: session.box.x + 8 + nextX, y: session.box.y - 15 + nextY })
    }
    session.members.forEach((member) => {
      nodeGroupRefs.current.get(member.id)?.position({ x: member.x + nextX, y: member.y + nextY })
    })
    updateEdgeShapes(new Set([...memberIds, session.id]), {
      id: session.id,
      box: {
        x: session.box.x + nextX,
        y: session.box.y + nextY,
        w: session.box.w,
        h: session.box.h,
      },
    })
  }

  /**
   * 空间拖动收尾：与对象拖动一致——松手统一判定落点，被压住先退回裸偏移，
   * 裸偏移仍被压住才整体回到拖动前的位置；图形归位到最终接受的落点后再提交。
   */
  const commitGroupDrag = () => {
    const session = groupDrag.current
    groupDrag.current = null
    setGuides(null)
    if (!session) return
    const memberIds = new Set(session.members.map((member) => member.id))
    // 空间是容器：压到非成员对象或其他空间都算落点不合适；成员随空间移动不参与判定。
    const landingBlockedAt = (offsetX: number, offsetY: number) => {
      const rect = {
        x: session.box.x + offsetX,
        y: session.box.y + offsetY,
        w: session.box.w,
        h: session.box.h,
      }
      const hitGroup = groups.some(
        (item) => item.id !== session.id && rectsOverlap(item, rect, LAYOUT_GAP),
      )
      return hitGroup || landingBlocked(rect, memberIds)
    }
    const snapped = { x: session.appliedX, y: session.appliedY }
    const raw = { x: Math.round(session.rawOffsetX), y: Math.round(session.rawOffsetY) }
    const accepted = landingBlockedAt(snapped.x, snapped.y)
      ? landingBlockedAt(raw.x, raw.y)
        ? { x: 0, y: 0 }
        : raw
      : snapped
    const finalX = session.box.x + accepted.x
    const finalY = session.box.y + accepted.y
    // 零位移时不会有重渲染来纠正图形，必须手动归位（标题拖动模式下标题被 Konva 拖走过）。
    groupBoxRefs.current.get(session.id)?.position({ x: finalX, y: finalY })
    groupTitleRefs.current.get(session.id)?.position({ x: finalX + 8, y: finalY - 15 })
    session.members.forEach((member) => {
      nodeGroupRefs.current
        .get(member.id)
        ?.position({ x: member.x + accepted.x, y: member.y + accepted.y })
    })
    if (accepted.x !== 0 || accepted.y !== 0) {
      onMoveGroup(session.id, accepted.x, accepted.y)
    }
  }

  /** Alt / Ctrl + 滚轮缩放；普通滚轮按 PS 习惯做纵向平移，避免误缩放。 */
  const handleWheel = (event: KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    const raw = event.evt.deltaY !== 0 ? event.evt.deltaY : event.evt.deltaX
    if (event.evt.altKey || event.evt.ctrlKey || event.evt.metaKey) {
      const factor = raw > 0 ? 0.9 : 1.1
      zoomAt(
        viewportRef.current.scale * factor,
        pointer?.x ?? size.width / 2,
        pointer?.y ?? size.height / 2,
      )
      return
    }
    setViewport((previous) => ({ ...previous, y: previous.y - raw }))
  }

  const handleStagePointerDown = (event: KonvaEventObject<MouseEvent>) => {
    // 只处理左键：右键/中键既不平移也不框选，避免右键菜单后残留会话导致跳位。
    if (event.evt.button !== 0) return
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    panMoved.current = false

    if (spaceRef.current) {
      panStart.current = {
        pointerX: pointer.x,
        pointerY: pointer.y,
        x: viewportRef.current.x,
        y: viewportRef.current.y,
      }
      return
    }

    if (event.target !== stage) return

    // 左键拖空白即框选；按住 Shift 追加到当前选择。
    const start = screenToWorld(pointer.x, pointer.y)
    boxSession.current = {
      startX: start.x,
      startY: start.y,
      currentX: start.x,
      currentY: start.y,
      additive: event.evt.shiftKey,
    }
    setSelectionRect(null)
  }

  const handleStagePointerMove = () => {
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    if (connectSession.current) {
      const world = screenToWorld(pointer.x, pointer.y)
      connectSession.current.x = world.x
      connectSession.current.y = world.y
      setConnectPreview({
        from: connectSession.current.from,
        side: connectSession.current.side,
        x: world.x,
        y: world.y,
      })
      return
    }

    if (boxSession.current) {
      const session = boxSession.current
      const currentX = (pointer.x - viewportRef.current.x) / viewportRef.current.scale
      const currentY = (pointer.y - viewportRef.current.y) / viewportRef.current.scale
      session.currentX = currentX
      session.currentY = currentY
      setSelectionRect({
        x: Math.min(session.startX, currentX),
        y: Math.min(session.startY, currentY),
        w: Math.abs(currentX - session.startX),
        h: Math.abs(currentY - session.startY),
      })
      return
    }

    if (panStart.current) {
      const dx = pointer.x - panStart.current.pointerX
      const dy = pointer.y - panStart.current.pointerY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved.current = true
      setViewport({
        x: panStart.current.x + dx,
        y: panStart.current.y + dy,
        scale: viewportRef.current.scale,
      })
      return
    }

    if (groupDrag.current && groupDrag.current.mode === 'box') {
      moveGroupSession(pointer.x, pointer.y)
      return
    }

    if (dragSession.current) {
      const session = dragSession.current
      const scale = viewportRef.current.scale
      let desiredX = (pointer.x - session.pointerX) / scale
      let desiredY = (pointer.y - session.pointerY) / scale
      session.rawOffsetX = desiredX
      session.rawOffsetY = desiredY
      if (Math.abs(desiredX) > 1 || Math.abs(desiredY) > 1) session.moving = true
      // 拖动过程不校验碰撞（碰撞推迟到松手统一判定），但保留对齐吸附：
      // 用 rbush 只查移动集合附近的邻居（对数级），替代逐帧全量扫描——
      // 10 万对象时全量碰撞/吸附计算会让主线程饱和，表现为卡顿与「拖不动」。
      if (session.items.length > 0) {
        const threshold = SNAP_THRESHOLD / scale
        const bounds = session.items.reduce(
          (acc, item) => ({
            minX: Math.min(acc.minX, item.rect.x),
            minY: Math.min(acc.minY, item.rect.y),
            maxX: Math.max(acc.maxX, item.rect.x + item.rect.w),
            maxY: Math.max(acc.maxY, item.rect.y + item.rect.h),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        )
        if (session.ghost) {
          // 超大选择集降级：不吸附、不逐个驱动图形与连线，只移动包围盒 ghost，
          // 偏移就是裸偏移；落点判定与提交统一在松手时处理。
          session.offsetX = desiredX
          session.offsetY = desiredY
          ghostRef.current?.setAttrs({
            visible: true,
            x: bounds.minX + desiredX,
            y: bounds.minY + desiredY,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY,
          })
          return
        }
        const movingIds = new Set(session.items.map((item) => item.id))
        const neighbors = nearbyRects(
          {
            x: bounds.minX + desiredX - threshold,
            y: bounds.minY + desiredY - threshold,
            w: bounds.maxX - bounds.minX + threshold * 2,
            h: bounds.maxY - bounds.minY + threshold * 2,
          },
          threshold,
          movingIds,
        )
        const snapped = snapOffset(
          session.items.map((item) => item.rect),
          neighbors,
          desiredX,
          desiredY,
          threshold,
        )
        desiredX = snapped.dx
        desiredY = snapped.dy
        applyGuides(snapped.guides)
      }
      session.offsetX = desiredX
      session.offsetY = desiredY
      session.items.forEach((item) => {
        const group = nodeGroupRefs.current.get(item.id)
        if (!group) return
        group.position({ x: item.x + desiredX, y: item.y + desiredY })
      })
      // 连线跟随拖动中的节点：只更新受影响的箭头，不遍历画布全部图形。
      updateEdgeShapes(session.idSet)
    }
  }

  const handleStagePointerUp = () => {
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()

    if (connectSession.current) {
      const session = connectSession.current
      connectSession.current = null
      setConnectPreview(null)
      // 拖出连线后紧跟的 click 不能再清空选择。
      panMoved.current = true
      const world = pointer ? screenToWorld(pointer.x, pointer.y) : { x: session.x, y: session.y }
      // 命中指针下方的节点优先，其次落在某个空间框内；都没有则视为取消。
      const hitNode = [...nodes]
        .reverse()
        .find(
          (node) =>
            node.id !== session.from &&
            world.x >= node.x &&
            world.x <= node.x + node.w &&
            world.y >= node.y &&
            world.y <= node.y + node.h,
        )
      const hitGroup = hitNode
        ? null
        : [...groups]
            .reverse()
            .find(
              (group) =>
                group.id !== session.from &&
                world.x >= group.x &&
                world.x <= group.x + group.w &&
                world.y >= group.y &&
                world.y <= group.y + group.h,
            )
      const targetId = hitNode?.id ?? hitGroup?.id
      if (targetId) {
        // 落点侧边：按指针在目标框内的相对位置取最近边中点，反向即目标连线锚点。
        const targetBox = boxOf(targetId)
        let toHandle: string = 'left'
        if (targetBox) {
          const relX = (world.x - targetBox.x) / targetBox.w
          const relY = (world.y - targetBox.y) / targetBox.h
          const dist = {
            left: relX,
            right: 1 - relX,
            top: relY,
            bottom: 1 - relY,
          } as Record<string, number>
          toHandle = Object.keys(dist).reduce((best, key) => (dist[key] < dist[best] ? key : best))
        }
        onConnect(session.from, targetId, session.side, toHandle)
      }
      return
    }

    if (boxSession.current) {
      const session = boxSession.current
      boxSession.current = null
      const rect = {
        x: Math.min(session.startX, session.currentX),
        y: Math.min(session.startY, session.currentY),
        w: Math.abs(session.currentX - session.startX),
        h: Math.abs(session.currentY - session.startY),
      }
      const dragged = rect.w > 2 || rect.h > 2
      // 只有真正拖出框选时才吞掉 click；空白单击仍要能清空选择。
      if (dragged) panMoved.current = true
      if (dragged) {
        const ids = nodes
          .filter(
            (node) =>
              node.x + node.w >= rect.x &&
              node.x <= rect.x + rect.w &&
              node.y + node.h >= rect.y &&
              node.y <= rect.y + rect.h,
          )
          .map((node) => node.id)
        onBoxSelect(ids, session.additive)
      }
      setSelectionRect(null)
    }

    if (dragSession.current) {
      const session = dragSession.current
      // ghost 图形只在超大选择集拖动期可见，收尾一律隐藏。
      ghostRef.current?.setAttrs({ visible: false })
      if (session.moving) {
        // 松手时统一做一次落点判定（rbush 对数级）：吸附落点被压住时先退回裸偏移，
        // 裸偏移也不行才整体回到拖动前的位置，避免压在别的对象上。
        const movingIds = new Set(session.items.map((item) => item.id))
        // ghost 模式按整体包围盒判定一次；逐项判定在上万对象时是上万次查询。
        const union = session.items.reduce(
          (acc, item) => ({
            minX: Math.min(acc.minX, item.rect.x),
            minY: Math.min(acc.minY, item.rect.y),
            maxX: Math.max(acc.maxX, item.rect.x + item.rect.w),
            maxY: Math.max(acc.maxY, item.rect.y + item.rect.h),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        )
        const isBlocked = (offsetX: number, offsetY: number) => {
          if (session.ghost) {
            return landingBlocked(
              {
                x: union.minX + offsetX,
                y: union.minY + offsetY,
                w: union.maxX - union.minX,
                h: union.maxY - union.minY,
              },
              movingIds,
            )
          }
          return session.items.some((item) =>
            landingBlocked({ ...item.rect, x: item.x + offsetX, y: item.y + offsetY }, movingIds),
          )
        }
        const accepted = isBlocked(session.offsetX, session.offsetY)
          ? isBlocked(session.rawOffsetX, session.rawOffsetY)
            ? { x: 0, y: 0 }
            : { x: session.rawOffsetX, y: session.rawOffsetY }
          : { x: session.offsetX, y: session.offsetY }
        // 普通模式拖动中是直接改 Konva 位置；回退或退回裸偏移时库内坐标不变、
        // 不会触发重渲染，这里把图形同步到最终接受的落点。ghost 模式拖动期
        // 没动过节点图形，直接交给提交后的重渲染。
        if (!session.ghost) {
          session.items.forEach((item) => {
            const group = nodeGroupRefs.current.get(item.id)
            if (!group) return
            group.position({
              x: Math.round(item.x + accepted.x),
              y: Math.round(item.y + accepted.y),
            })
          })
        }
        onMoveNodes(
          session.items.map((item) => ({
            id: item.id,
            x: Math.round(item.x + accepted.x),
            y: Math.round(item.y + accepted.y),
          })),
        )
      } else {
        const first = session.items[0]
        if (first) onSelect(first.id, false)
      }
      dragSession.current = null
    }

    panStart.current = null
    commitGroupDrag()
  }

  // 指针在画布外释放时 Stage 收不到 pointerup，会话会残留；这里做一次兜底收尾。
  const pointerUpRef = useRef(handleStagePointerUp)
  useEffect(() => {
    pointerUpRef.current = handleStagePointerUp
  })
  useEffect(() => {
    const finish = () => {
      if (
        boxSession.current ||
        dragSession.current ||
        connectSession.current ||
        groupDrag.current ||
        panStart.current
      ) {
        pointerUpRef.current()
      }
    }
    window.addEventListener('pointerup', finish)
    return () => window.removeEventListener('pointerup', finish)
  }, [])

  /** 空白单击清空选中；拖动画布或框选后的 click 不触发。 */
  const handleStageClick = (event: KonvaEventObject<MouseEvent>) => {
    if (panMoved.current) {
      panMoved.current = false
      return
    }
    if (event.target === stageRef.current) onClearSelection()
  }

  const handleNodePointerDown = (event: KonvaEventObject<MouseEvent>, node: SceneNode) => {
    // 空格按住时让事件冒泡给 Stage，画布平移优先于拖动卡片。
    if (spaceRef.current || event.evt.button !== 0) return
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    event.cancelBubble = true

    const additive = event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey
    if (additive) {
      onSelect(node.id, true)
      return
    }

    const dragIds = selectedSet.has(node.id) ? selectedIds : [node.id]
    const items = dragIds.flatMap((id) => {
      const rect = nodeRectOf(id)
      const item = nodeById.get(id)
      return rect && item ? [{ id, x: item.x, y: item.y, rect }] : []
    })
    dragSession.current = {
      items,
      idSet: new Set(dragIds),
      // 超大选择集降级：逐个驱动图形每帧要上万次 position 调用，改为拖包围盒 ghost。
      ghost: items.length > GHOST_DRAG_LIMIT,
      pointerX: pointer.x,
      pointerY: pointer.y,
      offsetX: 0,
      offsetY: 0,
      rawOffsetX: 0,
      rawOffsetY: 0,
      moving: false,
    }
  }

  const handleNodeClick = (event: KonvaEventObject<MouseEvent>, node: SceneNode) => {
    event.cancelBubble = true
    if (dragSession.current) return
    // 追加选择的切换已在 mousedown 完成；click 只在非追加时收敛为单选。
    if (!event.evt.shiftKey && !event.evt.ctrlKey && !event.evt.metaKey) {
      onSelect(node.id, false)
    }
  }

  const handleNodeDblClick = (node: SceneNode) => {
    if (node.kind === 'text') setEditor(node.id)
    else onActivate(node.id)
  }

  const handleNodeContextMenu = (event: KonvaEventObject<MouseEvent>, node: SceneNode) => {
    event.evt.preventDefault()
    event.cancelBubble = true
    onContextMenu({ kind: 'node', id: node.id }, event.evt.clientX, event.evt.clientY)
  }

  const handleHandleDown = (
    event: KonvaEventObject<MouseEvent>,
    box: { id: string },
    side: HandleSide,
  ) => {
    event.cancelBubble = true
    const pointer = stageRef.current?.getPointerPosition()
    const world = pointer ? screenToWorld(pointer.x, pointer.y) : { x: 0, y: 0 }
    connectSession.current = { from: box.id, side, x: world.x, y: world.y }
    setConnectPreview({ from: box.id, side, x: world.x, y: world.y })
  }

  const handleGroupBoxDown = (event: KonvaEventObject<MouseEvent>, groupId: string) => {
    if (spaceRef.current || event.evt.button !== 0) return
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    const group = groups.find((item) => item.id === groupId)
    if (!group) return
    event.cancelBubble = true
    onSelectGroup(groupId)
    groupDrag.current = {
      id: groupId,
      startX: pointer.x,
      startY: pointer.y,
      appliedX: 0,
      appliedY: 0,
      rawOffsetX: 0,
      rawOffsetY: 0,
      box: { x: group.x, y: group.y, w: group.w, h: group.h },
      mode: 'box',
      members: nodes
        .filter((item) => item.groupId === groupId)
        .map((item) => ({ id: item.id, x: item.x, y: item.y })),
    }
  }

  const handleGroupClick = (event: KonvaEventObject<MouseEvent>, groupId: string) => {
    event.cancelBubble = true
    onSelectGroup(groupId)
  }

  const handleGroupContextMenu = (event: KonvaEventObject<MouseEvent>, groupId: string) => {
    event.evt.preventDefault()
    event.cancelBubble = true
    onContextMenu({ kind: 'group', id: groupId }, event.evt.clientX, event.evt.clientY)
  }

  const handleEdgeContextMenu = (event: KonvaEventObject<MouseEvent>, edgeId: string) => {
    event.evt.preventDefault()
    event.cancelBubble = true
    onContextMenu({ kind: 'edge', id: edgeId }, event.evt.clientX, event.evt.clientY)
  }

  const handleGroupTitleDown = (event: KonvaEventObject<DragEvent>, groupId: string) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    const group = groups.find((item) => item.id === groupId)
    if (!group) return
    event.cancelBubble = true
    onSelectGroup(groupId)
    groupDrag.current = {
      id: groupId,
      startX: pointer.x,
      startY: pointer.y,
      appliedX: 0,
      appliedY: 0,
      rawOffsetX: 0,
      rawOffsetY: 0,
      box: { x: group.x, y: group.y, w: group.w, h: group.h },
      mode: 'title',
      members: nodes
        .filter((item) => item.groupId === groupId)
        .map((item) => ({ id: item.id, x: item.x, y: item.y })),
    }
  }

  const handleGroupTitleMove = (event: KonvaEventObject<DragEvent>) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    event.cancelBubble = true
    moveGroupSession(pointer.x, pointer.y)
  }

  const handleGroupTitleUp = () => {
    commitGroupDrag()
  }

  const handleNodeMouseEnter = (node: SceneNode) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      const pointer = stageRef.current?.getPointerPosition()
      if (!pointer) return
      setTooltip({ x: pointer.x + 12, y: pointer.y + 16, node })
    }, 350)
  }

  const handleNodeMouseLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    setTooltip(null)
  }

  /** 进入文字节点的画布内联编辑；非文字节点忽略。 */
  const editText = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      if (!node || node.kind !== 'text') return
      setEditor(id)
    },
    [nodeById],
  )

  return {
    spaceHeld,
    selectionRect,
    guides,
    connectPreview,
    editor,
    setEditor,
    tooltip,
    editText,
    handleWheel,
    handleStagePointerDown,
    handleStagePointerMove,
    handleStagePointerUp,
    handleStageClick,
    handleNodePointerDown,
    handleNodeClick,
    handleNodeDblClick,
    handleNodeContextMenu,
    handleHandleDown,
    handleGroupBoxDown,
    handleGroupClick,
    handleGroupContextMenu,
    handleEdgeContextMenu,
    handleGroupTitleDown,
    handleGroupTitleMove,
    handleGroupTitleUp,
    handleNodeMouseEnter,
    handleNodeMouseLeave,
  }
}
