/**
 * 画布交互会话：平移、框选、拖动、连线、空间拖动、悬停提示。
 *
 * 会话指针位置记录在 ref 里，pointerup 时按会话值提交，
 * 不依赖 state 更新顺序，也不依赖指针是否还在画布内。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import type { CanvasContextTarget, CanvasViewport, StageSize } from './types'
import type { Rect } from '@/domain/layout'
import type { HandleSide } from './constants'
import { asHandleSide, edgePoints } from './geometry'
import {
  constrainDrag,
  LAYOUT_GAP,
  SNAP_THRESHOLD,
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
    box: Rect
    mode: 'title' | 'box'
    /** 空间成员在按下时确定，拖动中作为障碍查询的排除集合（成员随空间一起动）。 */
    memberIds: Set<string>
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
   * 空间拖动：以按下时的矩形为基准做累积位移，先吸附再挡在其他空间之外，
   * 最后把增量交给上层带动内部节点。标题拖动与框体拖动共用同一套约束。
   * 节点障碍用 rbush 只查落点附近（对数级），不再逐帧扫描全量节点——
   * 10 万对象时全量构建障碍数组会让空间拖动同样卡顿。
   */
  const moveGroupSession = (pointerX: number, pointerY: number) => {
    const session = groupDrag.current
    if (!session) return
    const scale = viewportRef.current.scale
    const desiredX = (pointerX - session.startX) / scale
    const desiredY = (pointerY - session.startY) / scale
    const threshold = SNAP_THRESHOLD / scale
    // 候选位与落点最多相差一个吸附阈值，查询框按「吸附阈值 + 间距」外扩即可覆盖全部潜在障碍。
    const pad = threshold + LAYOUT_GAP
    const localNodes = nearbyRects(
      {
        x: session.box.x + desiredX - pad,
        y: session.box.y + desiredY - pad,
        w: session.box.w + pad * 2,
        h: session.box.h + pad * 2,
      },
      pad,
      session.memberIds,
    )
    const obstacles = [
      // 空间数量少，其他空间全量参与；空间不能压在非成员对象上。
      ...groups
        .filter((item) => item.id !== session.id)
        .map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h })),
      ...localNodes,
    ]
    const result = constrainDrag(
      [session.box],
      obstacles,
      desiredX,
      desiredY,
      LAYOUT_GAP,
      threshold,
      obstacles,
    )
    const nextX = Math.round(result.dx)
    const nextY = Math.round(result.dy)
    const stepX = nextX - session.appliedX
    const stepY = nextY - session.appliedY
    applyGuides(result.guides)
    if (Math.abs(stepX) < 0.4 && Math.abs(stepY) < 0.4) return
    session.appliedX = nextX
    session.appliedY = nextY
    // 空间移动时内部节点由上层一起位移，连线跟着盒子走。
    onMoveGroup(session.id, stepX, stepY)
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
      // 连线跟随拖动中的节点：Konva 的 className 不参与 find 选择器，按形状类型取。
      stageRef.current?.find('Arrow').forEach((shape) => {
        const edgeId = shape.getAttr('edgeId')
        const edge = edges.find((item) => item.id === edgeId)
        if (!edge) return
        const from = boxOf(edge.from)
        const to = boxOf(edge.to)
        if (!from || !to) return
        shape.setAttr(
          'points',
          edgePoints(from, to, asHandleSide(edge.fromHandle), asHandleSide(edge.toHandle)),
        )
      })
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
      if (session.moving) {
        // 松手时统一做一次落点判定（rbush 对数级）：吸附落点被压住时先退回裸偏移，
        // 裸偏移也不行才整体回到拖动前的位置，避免压在别的对象上。
        const movingIds = new Set(session.items.map((item) => item.id))
        const isBlocked = (offsetX: number, offsetY: number) =>
          session.items.some((item) =>
            landingBlocked({ ...item.rect, x: item.x + offsetX, y: item.y + offsetY }, movingIds),
          )
        const accepted = isBlocked(session.offsetX, session.offsetY)
          ? isBlocked(session.rawOffsetX, session.rawOffsetY)
            ? { x: 0, y: 0 }
            : { x: session.rawOffsetX, y: session.rawOffsetY }
          : { x: session.offsetX, y: session.offsetY }
        // 拖动中是直接改 Konva 位置；回退或退回裸偏移时库内坐标不变、不会触发重渲染，
        // 这里把图形同步到最终接受的落点，避免残留在被拒绝的位置上。
        session.items.forEach((item) => {
          const group = nodeGroupRefs.current.get(item.id)
          if (!group) return
          group.position({ x: Math.round(item.x + accepted.x), y: Math.round(item.y + accepted.y) })
        })
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
    groupDrag.current = null
    setGuides(null)
  }

  // 指针在画布外释放时 Stage 收不到 pointerup，会话会残留；这里做一次兜底收尾。
  const pointerUpRef = useRef(handleStagePointerUp)
  useEffect(() => {
    pointerUpRef.current = handleStagePointerUp
  })
  useEffect(() => {
    const finish = () => {
      if (boxSession.current || dragSession.current || connectSession.current || panStart.current) {
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
    dragSession.current = {
      items: dragIds.flatMap((id) => {
        const rect = nodeRectOf(id)
        const item = nodeById.get(id)
        return rect && item ? [{ id, x: item.x, y: item.y, rect }] : []
      }),
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
      box: { x: group.x, y: group.y, w: group.w, h: group.h },
      mode: 'box',
      memberIds: new Set(nodes.filter((item) => item.groupId === groupId).map((item) => item.id)),
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
      box: { x: group.x, y: group.y, w: group.w, h: group.h },
      mode: 'title',
      memberIds: new Set(nodes.filter((item) => item.groupId === groupId).map((item) => item.id)),
    }
  }

  const handleGroupTitleMove = (event: KonvaEventObject<DragEvent>) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    event.cancelBubble = true
    moveGroupSession(pointer.x, pointer.y)
  }

  const handleGroupTitleUp = () => {
    groupDrag.current = null
    setGuides(null)
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
