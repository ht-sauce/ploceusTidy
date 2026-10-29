/**
 * Konva 画布编排：只负责组合视口、可见性、交互会话与图层。
 *
 * 职责边界：
 * - 视口状态与缩放/定位 → `useCanvasViewport`；
 * - 视口裁剪、连线筛选 → `useVisibleScene`；
 * - 平移/框选/拖动/连线/悬停会话 → `useCanvasInteractions`；
 * - 缩略图加载 → `useVisibleThumbnails`；
 * - 图元绘制 → `NodeShape` / `GroupShape` / `EdgeLayer` / `Minimap`。
 *
 * 交互模型对齐 PS：
 * - 左键拖空白 = 框选；拖动卡片 = 移动；画布默认不随手拖走；
 * - 空格 + 左键拖拽 = 平移画布；Alt/Ctrl + 滚轮 = 以指针为锚缩放；
 * - 选中对象或空间后，拖四向圆点拉出连线。
 *
 * 坐标约定：world 为场景坐标，screen = world * scale + (x, y)。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Arrow, Circle, Group, Label, Layer, Line, Rect, Stage, Tag, Text } from 'react-konva'
import type { SceneAnnotation, SceneEdge, SceneGroup, SceneNode, ThemeId } from '@/types/scene'
import { themeById } from '@/lib/theme'
import EdgeLayer from './EdgeLayer'
import GroupShape from './GroupShape'
import Minimap from './Minimap'
import NodeShape from './NodeShape'
import { MINIMAP_MIN_H, MINIMAP_MIN_W, STAGE_PIXEL_RATIO } from './constants'
import type { CanvasTokens, HandleSide } from './constants'
import { groupTone, handlePoint } from './geometry'
import { GROUP_COLLAPSED_HEIGHT, groupDisplayBox, nodeDisplayHeight } from '@/domain/layout'
import { ICON_IMAGES, THUMB_IMAGES, cssVar, startIconLoad } from './icons'
import type { CanvasContextTarget, CanvasViewport, StageSize } from './types'
import { useCanvasInteractions } from './useCanvasInteractions'
import type { GroupResizeCorner } from './useCanvasInteractions'
import { useCanvasViewport } from './useCanvasViewport'
import { useVisibleScene } from './useVisibleScene'
import { useVisibleThumbnails } from './useVisibleThumbnails'

// Konva 的 Layer 画布只读全局倍率；统一提高分辨率，低 DPI 屏上文字也保持锐利。
Konva.pixelRatio = STAGE_PIXEL_RATIO

interface CanvasBoardProps {
  themeId: ThemeId
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
  selectedIds: string[]
  selectedGroupId: string | null
  selectedEdgeId: string | null
  detailsOpen: boolean
  onSelect: (id: string, additive: boolean) => void
  onBoxSelect: (ids: string[], additive: boolean) => void
  onClearSelection: () => void
  onSelectGroup: (id: string) => void
  onMoveGroup: (id: string, dx: number, dy: number) => void
  /** 空间四角手动调框提交；不影响成员进出时的自动贴合。 */
  onResizeGroup: (id: string, box: { x: number; y: number; w: number; h: number }) => void
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void
  onSelectEdge: (id: string) => void
  onEdgeLabelEdit: (id: string) => void
  onConnect: (from: string, to: string, fromHandle: string, toHandle: string) => void
  /** 拖动选中连线的端点到新目标后提交改接。 */
  onReconnectEdge: (edgeId: string, end: 'from' | 'to', targetId: string, handle: string) => void
  onAnnotation: (annotation: SceneAnnotation) => void
  onActivate: (id: string) => void
  /** 双击文字/富文本：打开内容编辑弹窗。 */
  onEditContent: (id: string) => void
  /** Ctrl + 拖拽文件卡：把原文件拖到外部程序。 */
  onDragOut: (ids: string[]) => void
  onScaleChange: (scale: number) => void
  /** 双击空间标题：进入重命名。 */
  onGroupTitleEdit: (id: string) => void
  /** 折叠 / 展开空间：只影响显示，不改存储尺寸。 */
  onToggleGroupCollapse: (id: string) => void
  /** 右键菜单由工作空间渲染，画布只上报目标与屏幕坐标。 */
  onContextMenu: (target: CanvasContextTarget, clientX: number, clientY: number) => void
  /** 窗口最小化/隐藏时暂停缩略图与脉冲等主动渲染。 */
  paused: boolean
  /** 场景加载完成后才允许视口持久化，避免启动期把默认视口写进配置。 */
  viewportPersistReady: boolean
}

export interface CanvasBoardHandle {
  locateNode: (id: string) => void
  /** 定位节点或空间，供连线邻居跳转使用。 */
  locateTarget: (id: string) => void
  /** 定位连线中点，供搜索结果使用。 */
  locateEdge: (id: string) => void
  fitView: () => void
  /** 恢复上次视口；无记录返回 false，由调用方兜底适配内容。 */
  restoreViewport: () => Promise<boolean>
  zoomBy: (factor: number) => void
  getCenterWorld: () => { x: number; y: number }
  /** 鼠标在画布上的最后位置（世界坐标）；指针从未进入画布时为 null。 */
  getPointerWorld: () => { x: number; y: number } | null
}

const CanvasBoard = forwardRef<CanvasBoardHandle, CanvasBoardProps>(function CanvasBoard(
  {
    themeId,
    nodes,
    groups,
    edges,
    annotations,
    selectedIds,
    selectedGroupId,
    selectedEdgeId,
    detailsOpen,
    onSelect,
    onBoxSelect,
    onClearSelection,
    onSelectGroup,
    onMoveGroup,
    onResizeGroup,
    onMoveNodes,
    onSelectEdge,
    onEdgeLabelEdit,
    onConnect,
    onReconnectEdge,
    onAnnotation,
    onActivate,
    onEditContent,
    onDragOut,
    onScaleChange,
    onGroupTitleEdit,
    onToggleGroupCollapse,
    onContextMenu,
    paused,
    viewportPersistReady,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const nodeGroupRefs = useRef(new Map<string, Konva.Group>())
  const ringRefs = useRef(new Map<string, Konva.Rect>())
  // 空间框/标题与箭头的图形引用：拖动期由交互层直接驱动，松手才提交状态。
  const groupBoxRefs = useRef(new Map<string, Konva.Rect>())
  const groupTitleRefs = useRef(new Map<string, Konva.Label>())
  const edgeRefs = useRef(new Map<string, Konva.Arrow>())
  // 超大选择集拖动的包围盒 ghost：拖动期直接驱动，不触发重渲染。
  const ghostRef = useRef<Konva.Rect>(null)
  const [size, setSize] = useState<StageSize>({ width: 1280, height: 720 })
  // ICON_IMAGES 是模块级缓存，图标解码完成后靠这个版本号触发一次重渲染。
  const [, setIconVersion] = useState(0)

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  /** 折叠的空间：成员整体隐藏，但数据与选中态不变。 */
  const collapsedGroups = useMemo(
    () => new Set(groups.filter((group) => group.collapsed).map((group) => group.id)),
    [groups],
  )
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const annotationByNode = useMemo(() => {
    // 同一对象可被多条标注覆盖：只画第一条，其余用「+N」提示，避免卡片高度失控。
    const map = new Map<string, { annotation: SceneAnnotation; extra: number }>()
    annotations.forEach((annotation) => {
      annotation.nodeIds.forEach((nodeId) => {
        const current = map.get(nodeId)
        if (current) current.extra += 1
        else map.set(nodeId, { annotation, extra: 0 })
      })
    })
    return map
  }, [annotations])

  /**
   * 扩展样式里的描边色（`{"accent":"#..."}`）：按「id + 原始 JSON」缓存解析结果，
   * 场景刷新时只为真正改过的对象重新解析，10 万对象也不会每帧 JSON.parse。
   */
  const accentCache = useRef(new Map<string, { raw: string; accent?: string }>())
  const accentOf = useCallback((node: SceneNode) => {
    const raw = node.dataJson ?? ''
    if (!raw) return undefined
    const cached = accentCache.current.get(node.id)
    if (cached?.raw === raw) return cached.accent
    let accent: string | undefined
    try {
      const parsed = JSON.parse(raw) as { accent?: unknown }
      if (typeof parsed.accent === 'string' && parsed.accent.trim()) {
        accent = parsed.accent.trim()
      }
    } catch {
      // 非法 JSON 由属性面板保存时拦截；这里静默按无描边处理。
    }
    accentCache.current.set(node.id, { raw, accent })
    return accent
  }, [])

  useEffect(() => {
    startIconLoad(() => setIconVersion((value) => value + 1))
  }, [])

  /** 稳定的图形引用注册器：props 引用不变是 memo 组件跳过重渲染的前提。 */
  const registerNodeRef = useCallback((id: string, instance: Konva.Group | null) => {
    if (instance) nodeGroupRefs.current.set(id, instance)
    else nodeGroupRefs.current.delete(id)
  }, [])
  const registerGroupBoxRef = useCallback((id: string, instance: Konva.Rect | null) => {
    if (instance) groupBoxRefs.current.set(id, instance)
    else groupBoxRefs.current.delete(id)
  }, [])
  const registerGroupTitleRef = useCallback((id: string, instance: Konva.Label | null) => {
    if (instance) groupTitleRefs.current.set(id, instance)
    else groupTitleRefs.current.delete(id)
  }, [])
  const registerEdgeRef = useCallback((id: string, instance: Konva.Arrow | null) => {
    if (instance) edgeRefs.current.set(id, instance)
    else edgeRefs.current.delete(id)
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const updateSize = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const {
    viewport,
    viewportRef,
    setViewport,
    zoomAt,
    locateTarget,
    fitView,
    zoomBy,
    getCenterWorld,
    restoreViewport,
    pulseId,
  } = useCanvasViewport({
    nodes,
    groups,
    nodeById,
    groupById,
    size,
    detailsOpen,
    onScaleChange,
    persistEnabled: viewportPersistReady,
  })

  /** 展示高度解析：索引、碰撞与渲染统一用它，标注节点才不会漏判底部区域。 */
  const nodeHeightOf = useCallback(
    (node: SceneNode) => nodeDisplayHeight(node, annotationByNode.has(node.id)),
    [annotationByNode],
  )

  const { visibleNodes, visibleEdges, landingBlocked, nearbyRects, hitTarget, obstaclesNear } =
    useVisibleScene({
      nodes,
      edges,
      nodeById,
      groupById,
      viewport,
      nodeHeightOf,
      size,
    })

  useVisibleThumbnails(visibleNodes, !paused)

  /** 节点静态矩形：拖动碰撞与吸附以库内坐标为准，避免被 Konva 实时位置干扰。 */
  const nodeRectOf = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      return node
        ? {
            x: node.x,
            y: node.y,
            w: node.w,
            h: nodeDisplayHeight(node, annotationByNode.has(id)),
          }
        : null
    },
    [annotationByNode, nodeById],
  )

  /**
   * 统一解析「节点或空间」的矩形。拖动中的节点以 Konva Group 的实时位置为准；
   * 节点高度按名称行数与标注自适应。
   */
  const boxOf = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      if (node) {
        const live = nodeGroupRefs.current.get(id)
        return {
          x: live ? live.x() : node.x,
          y: live ? live.y() : node.y,
          w: node.w,
          h: nodeDisplayHeight(node, annotationByNode.has(id)),
        }
      }
      const group = groupById.get(id)
      return group ? groupDisplayBox(group) : null
    },
    [annotationByNode, groupById, nodeById],
  )

  const interactions = useCanvasInteractions({
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
    hitTarget,
    obstaclesNear,
    onSelect,
    onBoxSelect,
    onClearSelection,
    onSelectGroup,
    onMoveGroup,
    onResizeGroup,
    onMoveNodes,
    onConnect,
    onReconnectEdge,
    onActivate,
    onEditContent,
    onDragOut,
    onContextMenu,
  })

  // 事件转发：NodeShape / GroupShape / EdgeLayer 用 memo 跳过无关重渲染，
  // 处理器经 ref 转发保持引用稳定，不随每次渲染更换。
  const interactionsRef = useRef(interactions)
  useLayoutEffect(() => {
    interactionsRef.current = interactions
  })
  const nodeHandlers = useMemo(
    () => ({
      onPointerDown: (event: KonvaEventObject<MouseEvent>, node: SceneNode) =>
        interactionsRef.current.handleNodePointerDown(event, node),
      onClick: (event: KonvaEventObject<MouseEvent>, node: SceneNode) =>
        interactionsRef.current.handleNodeClick(event, node),
      onDblClick: (node: SceneNode) => interactionsRef.current.handleNodeDblClick(node),
      onContextMenu: (event: KonvaEventObject<MouseEvent>, node: SceneNode) =>
        interactionsRef.current.handleNodeContextMenu(event, node),
      onHoverStart: (node: SceneNode) => interactionsRef.current.handleNodeMouseEnter(node),
      onHoverEnd: () => interactionsRef.current.handleNodeMouseLeave(),
      onHandleDown: (event: KonvaEventObject<MouseEvent>, node: SceneNode, side: HandleSide) =>
        interactionsRef.current.handleHandleDown(event, node, side),
    }),
    [],
  )
  const groupHandlers = useMemo(
    () => ({
      onPointerDown: (event: KonvaEventObject<MouseEvent>, groupId: string) =>
        interactionsRef.current.handleGroupBoxDown(event, groupId),
      onClick: (event: KonvaEventObject<MouseEvent>, groupId: string) =>
        interactionsRef.current.handleGroupClick(event, groupId),
      onContextMenu: (event: KonvaEventObject<MouseEvent>, groupId: string) =>
        interactionsRef.current.handleGroupContextMenu(event, groupId),
    }),
    [],
  )
  // 选中空间的四角调框手柄：拖动只改框，成员位置与自动贴合逻辑不受影响。
  const groupResizeHandlers = useMemo(
    () => ({
      onResizeDown: (
        event: KonvaEventObject<MouseEvent>,
        groupId: string,
        corner: GroupResizeCorner,
      ) => interactionsRef.current.handleGroupResizeDown(event, groupId, corner),
    }),
    [],
  )
  const edgeHandlers = useMemo(
    () => ({
      onContextMenu: (event: KonvaEventObject<MouseEvent>, id: string) =>
        interactionsRef.current.handleEdgeContextMenu(event, id),
      onHandleDown: (event: KonvaEventObject<MouseEvent>, edge: SceneEdge, end: 'from' | 'to') =>
        interactionsRef.current.handleEdgeHandleDown(event, edge, end),
    }),
    [],
  )

  /**
   * 连线定位：以两端盒子的中点为中心；缩放沿用当前比例并保证至少 0.92，
   * 与节点定位的体感一致，不额外引入脉冲高亮。
   */
  const locateEdge = useCallback(
    (id: string) => {
      const edge = edges.find((item) => item.id === id)
      if (!edge) return
      const from = boxOf(edge.from)
      const to = boxOf(edge.to)
      if (!from || !to) return
      const scale = Math.max(viewportRef.current.scale, 0.92)
      const centerX = (from.x + from.w / 2 + to.x + to.w / 2) / 2
      const centerY = (from.y + from.h / 2 + to.y + to.h / 2) / 2
      setViewport({
        x: size.width / 2 - centerX * scale,
        y: size.height / 2 - centerY * scale,
        scale,
      })
    },
    [boxOf, edges, setViewport, size.height, size.width, viewportRef],
  )

  useImperativeHandle(
    ref,
    () => ({
      locateNode: locateTarget,
      locateTarget,
      locateEdge,
      fitView,
      restoreViewport,
      zoomBy,
      getCenterWorld,
      getPointerWorld: interactions.getPointerWorld,
    }),
    [
      fitView,
      getCenterWorld,
      interactions.getPointerWorld,
      locateEdge,
      locateTarget,
      restoreViewport,
      zoomBy,
    ],
  )

  // 定位后的脉冲高亮：只对当前定位对象做一次淡出，不持续渲染；窗口不可见时跳过。
  useEffect(() => {
    if (!pulseId || paused) return
    const ring = ringRefs.current.get(pulseId)
    if (!ring || !nodeById.get(pulseId)) return
    ring.opacity(1)
    const tween = new Konva.Tween({
      node: ring,
      duration: 1.4,
      easing: Konva.Easings.EaseOut,
      opacity: 0,
    })
    tween.play()
    return () => tween.destroy()
  }, [nodeById, paused, pulseId])

  // 主题相关的色值直接取主题定义，切换主题时随 props 重算；
  // 不依赖 CSS 变量的写入时机，避免画布停留在上一套配色。
  // memo：tokens 引用稳定是 NodeShape / EdgeLayer memo 生效的前提。
  const tokens: CanvasTokens = useMemo(() => {
    const theme = themeById(themeId)
    return {
      primary: theme.primary,
      border: theme.border,
      selectedBg: theme.selectedBg,
      surface: theme.surface,
      text: cssVar('--text', '#000000'),
      textSecondary: cssVar('--text-secondary', '#747A83'),
      error: cssVar('--error', '#C44B52'),
    }
  }, [themeId])

  /**
   * 迷你地图映射范围：只取内容包围盒（无内容时取当前视口）。
   * 若把视口并进来，平移会同时扩大范围，视口框就会始终粘在原地。
   * 内容包围盒只随场景变化记忆化；平移/缩放不再对 10 万对象做全量扫描。
   */
  const contentBounds = useMemo(() => {
    if (nodes.length === 0 && groups.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const consider = (x: number, y: number, w: number, h: number) => {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + w)
      maxY = Math.max(maxY, y + h)
    }
    nodes.forEach((node) => consider(node.x, node.y, node.w, node.h))
    groups.forEach((group) => {
      const box = groupDisplayBox(group)
      consider(box.x, box.y, box.w, box.h)
    })
    const padX = Math.max(120, (maxX - minX) * 0.15)
    const padY = Math.max(120, (maxY - minY) * 0.15)
    return {
      minX: minX - padX,
      minY: minY - padY,
      width: Math.max(MINIMAP_MIN_W, maxX - minX + padX * 2),
      height: Math.max(MINIMAP_MIN_H, maxY - minY + padY * 2),
    }
  }, [groups, nodes])

  const minimapBounds = useMemo(() => {
    if (contentBounds) return contentBounds
    const left = -viewport.x / viewport.scale
    const top = -viewport.y / viewport.scale
    const width = size.width / viewport.scale
    const height = size.height / viewport.scale
    const padX = Math.max(120, width * 0.15)
    const padY = Math.max(120, height * 0.15)
    return {
      minX: left - padX,
      minY: top - padY,
      width: Math.max(MINIMAP_MIN_W, width + padX * 2),
      height: Math.max(MINIMAP_MIN_H, height + padY * 2),
    }
  }, [contentBounds, size.height, size.width, viewport])

  /** 迷你地图点击/拖拽：把点击处对应的世界坐标移到视口中心。 */
  const moveViewportTo = useCallback(
    (clientX: number, clientY: number, element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const worldX = minimapBounds.minX + ((clientX - rect.left) / rect.width) * minimapBounds.width
      const worldY =
        minimapBounds.minY + ((clientY - rect.top) / rect.height) * minimapBounds.height
      setViewport((previous: CanvasViewport) => ({
        ...previous,
        x: size.width / 2 - worldX * previous.scale,
        y: size.height / 2 - worldY * previous.scale,
      }))
    },
    [minimapBounds, size.height, size.width, setViewport],
  )

  const activeGroup = selectedGroupId ? (groupById.get(selectedGroupId) ?? null) : null
  /** 选中空间的显示框：折叠后锚点要贴着标题条走，不能落在看不见的旧框上。 */
  const activeGroupBox = activeGroup ? groupDisplayBox(activeGroup) : null

  return (
    <div
      ref={containerRef}
      className={`canvas-board${interactions.spaceHeld ? ' is-panning' : ''}`}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        pixelRatio={STAGE_PIXEL_RATIO}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        x={viewport.x}
        y={viewport.y}
        onWheel={interactions.handleWheel}
        onPointerDown={interactions.handleStagePointerDown}
        onPointerMove={interactions.handleStagePointerMove}
        onPointerUp={interactions.handleStagePointerUp}
        onClick={interactions.handleStageClick}
        onContextMenu={interactions.handleStageContextMenu}
      >
        {/* 空间（分组框）：点框内空白即可选中并整体拖动，也可作为连线端点。 */}
        <Layer>
          {groups.map((group) => (
            <GroupShape
              key={group.id}
              group={group}
              height={group.collapsed ? GROUP_COLLAPSED_HEIGHT : group.h}
              active={selectedGroupId === group.id}
              tokens={tokens}
              registerRef={registerGroupBoxRef}
              onPointerDown={groupHandlers.onPointerDown}
              onClick={groupHandlers.onClick}
              onContextMenu={groupHandlers.onContextMenu}
            />
          ))}
        </Layer>

        {/* 连线层必须接收事件，否则边无法选中、也无法双击编辑标签。 */}
        <Layer>
          <EdgeLayer
            edges={visibleEdges}
            selectedEdgeId={selectedEdgeId}
            tokens={tokens}
            boxOf={boxOf}
            obstaclesNear={obstaclesNear}
            surfaceColor={tokens.surface}
            registerRef={registerEdgeRef}
            onSelect={onSelectEdge}
            onLabelEdit={onEdgeLabelEdit}
            onContextMenu={edgeHandlers.onContextMenu}
            onHandleDown={edgeHandlers.onHandleDown}
          />
        </Layer>

        <Layer>
          {/* 空间标题就是空间的标注：带底色文字牌，可重命名、改色、拖动。 */}
          {groups.map((group) => {
            const color = group.color || tokens.primary
            const tone = groupTone(color)
            return (
              <Label
                key={`title-${group.id}`}
                ref={(instance) => registerGroupTitleRef(group.id, instance)}
                x={group.x + 8}
                y={group.y - 15}
                draggable
                onDragStart={(event) => interactions.handleGroupTitleDown(event, group.id)}
                onDragMove={interactions.handleGroupTitleMove}
                onDragEnd={interactions.handleGroupTitleUp}
                onDblClick={(event) => {
                  event.cancelBubble = true
                  onGroupTitleEdit(group.id)
                }}
                onContextMenu={(event) => interactions.handleGroupContextMenu(event, group.id)}
              >
                <Tag fill={tone.fill} stroke={color} strokeWidth={1} cornerRadius={3} />
                <Text
                  text={group.title}
                  fontSize={10}
                  fontStyle="bold"
                  padding={3}
                  fill={tone.ink}
                  fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
                />
              </Label>
            )
          })}

          {/* 展开 / 收起按钮：贴在标题行右端，点它只切换显示，不影响选中与拖拽。 */}
          {groups.map((group) => {
            const color = group.color || tokens.primary
            return (
              <Group
                key={`collapse-${group.id}`}
                x={group.x + group.w - 11}
                y={group.y - 8}
                onMouseDown={(event) => {
                  event.cancelBubble = true
                }}
                onClick={(event) => {
                  event.cancelBubble = true
                  onToggleGroupCollapse(group.id)
                }}
              >
                <Circle radius={7} fill={tokens.surface} stroke={color} strokeWidth={1} />
                <Text
                  text={group.collapsed ? '+' : '−'}
                  width={14}
                  height={14}
                  x={-7}
                  y={-7}
                  align="center"
                  verticalAlign="middle"
                  fontSize={11}
                  fill={color}
                  listening={false}
                  fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
                />
              </Group>
            )
          })}

          {/* 按 z 升序渲染：z 大的后画、盖在上层；稳定排序保证同 z 保持插入次序。
              折叠空间的成员整体不渲染（数据仍在，展开即恢复）。 */}
          {visibleNodes
            .filter((node) => !node.groupId || !collapsedGroups.has(node.groupId))
            .sort((left, right) => left.z - right.z)
            .map((node) => {
              const entry = annotationByNode.get(node.id)
              return (
                <NodeShape
                  key={node.id}
                  node={node}
                  height={nodeDisplayHeight(node, Boolean(entry))}
                  annotation={entry?.annotation}
                  extraAnnotations={entry?.extra}
                  accent={accentOf(node)}
                  icon={ICON_IMAGES.get(node.icon)}
                  thumb={THUMB_IMAGES.get(node.id) ?? null}
                  selected={selectedSet.has(node.id)}
                  singleSelected={selectedSet.size === 1}
                  tokens={tokens}
                  registerRef={registerNodeRef}
                  onPointerDown={nodeHandlers.onPointerDown}
                  onClick={nodeHandlers.onClick}
                  onDblClick={nodeHandlers.onDblClick}
                  onContextMenu={nodeHandlers.onContextMenu}
                  onHoverStart={nodeHandlers.onHoverStart}
                  onHoverEnd={nodeHandlers.onHoverEnd}
                  onAnnotation={onAnnotation}
                  onHandleDown={nodeHandlers.onHandleDown}
                />
              )
            })}

          {/* 选中空间时同样给出四向锚点：空间可以和文件一样连线。 */}
          {activeGroup
            ? Array.from({ length: 4 }).map((_, index) => {
                const side = (['top', 'right', 'bottom', 'left'] as HandleSide[])[index]
                const point = handlePoint(activeGroupBox ?? activeGroup, side)
                return (
                  <Circle
                    key={`group-handle-${side}`}
                    x={activeGroup.x + point.x}
                    y={activeGroup.y + point.y}
                    radius={4}
                    fill={tokens.surface}
                    stroke={tokens.primary}
                    strokeWidth={1.5}
                    hitStrokeWidth={12}
                    onMouseDown={(event) => interactions.handleHandleDown(event, activeGroup, side)}
                  />
                )
              })
            : null}

          {/* 选中空间的四角调框手柄：方角标记，拖动即缩放框本身。折叠时不提供调框。 */}
          {activeGroup && !activeGroup.collapsed
            ? (['nw', 'ne', 'sw', 'se'] as GroupResizeCorner[]).map((corner) => (
                <Rect
                  key={`group-resize-${corner}`}
                  x={(corner.includes('w') ? activeGroup.x : activeGroup.x + activeGroup.w) - 4}
                  y={(corner.includes('n') ? activeGroup.y : activeGroup.y + activeGroup.h) - 4}
                  width={8}
                  height={8}
                  fill={tokens.surface}
                  stroke={tokens.primary}
                  strokeWidth={1.5}
                  cornerRadius={2}
                  // 命中区外扩，小方块也好抓。
                  hitStrokeWidth={10}
                  onMouseDown={(event) =>
                    groupResizeHandlers.onResizeDown(event, activeGroup.id, corner)
                  }
                />
              ))
            : null}

          {pulseId
            ? (() => {
                const node = nodeById.get(pulseId)
                if (!node) return null
                return (
                  <Rect
                    key={`pulse-${pulseId}`}
                    ref={(instance) => {
                      if (instance) ringRefs.current.set(pulseId, instance)
                      else ringRefs.current.delete(pulseId)
                    }}
                    x={node.x - 4}
                    y={node.y - 4}
                    width={node.w + 8}
                    height={nodeDisplayHeight(node, annotationByNode.has(node.id)) + 8}
                    stroke={tokens.primary}
                    strokeWidth={2}
                    cornerRadius={8}
                    listening={false}
                  />
                )
              })()
            : null}

          {interactions.selectionRect ? (
            <Rect
              x={interactions.selectionRect.x}
              y={interactions.selectionRect.y}
              width={interactions.selectionRect.w}
              height={interactions.selectionRect.h}
              fill={tokens.selectedBg}
              opacity={0.6}
              stroke={tokens.primary}
              strokeWidth={1}
              listening={false}
            />
          ) : null}

          {/* 超大选择集拖动的包围盒 ghost：默认隐藏，拖动期由交互层直接驱动。 */}
          <Rect
            ref={ghostRef}
            visible={false}
            listening={false}
            fill={tokens.selectedBg}
            opacity={0.5}
            stroke={tokens.primary}
            strokeWidth={1.5}
            dash={[8, 6]}
            cornerRadius={8}
          />

          {/* 拖动吸附参考线：贯穿当前视口，只做视觉提示，不参与命中。 */}
          {interactions.guides
            ? (() => {
                const left = -viewport.x / viewport.scale
                const top = -viewport.y / viewport.scale
                const right = left + size.width / viewport.scale
                const bottom = top + size.height / viewport.scale
                return (
                  <>
                    {interactions.guides.vertical.map((x) => (
                      <Line
                        key={`guide-v-${x}`}
                        points={[x, top, x, bottom]}
                        stroke={tokens.primary}
                        strokeWidth={1}
                        dash={[4, 4]}
                        listening={false}
                      />
                    ))}
                    {interactions.guides.horizontal.map((y) => (
                      <Line
                        key={`guide-h-${y}`}
                        points={[left, y, right, y]}
                        stroke={tokens.primary}
                        strokeWidth={1}
                        dash={[4, 4]}
                        listening={false}
                      />
                    ))}
                  </>
                )
              })()
            : null}

          {interactions.connectPreview
            ? (() => {
                const preview = interactions.connectPreview
                const box = boxOf(preview.from)
                if (!box) return null
                const offset = handlePoint(box, preview.side)
                return (
                  <Arrow
                    points={[box.x + offset.x, box.y + offset.y, preview.x, preview.y]}
                    stroke={tokens.primary}
                    fill={tokens.primary}
                    strokeWidth={1.5}
                    dash={[5, 4]}
                    listening={false}
                  />
                )
              })()
            : null}

          {/* 连线会话的目标高亮：拉线/改端点悬停到的对象或空间给一圈描边提示。 */}
          {interactions.connectTargetId
            ? (() => {
                const box = boxOf(interactions.connectTargetId)
                if (!box) return null
                return (
                  <Rect
                    x={box.x - 5}
                    y={box.y - 5}
                    width={box.w + 10}
                    height={box.h + 10}
                    stroke={tokens.primary}
                    strokeWidth={2}
                    dash={[6, 4]}
                    cornerRadius={8}
                    listening={false}
                  />
                )
              })()
            : null}

          {/* 改端点预览线：固定端锚点 → 当前指针，落点提交或取消。 */}
          {interactions.reconnectPreview
            ? (() => {
                const preview = interactions.reconnectPreview
                return (
                  <Arrow
                    points={[preview.x1, preview.y1, preview.x2, preview.y2]}
                    stroke={tokens.primary}
                    fill={tokens.primary}
                    strokeWidth={1.5}
                    dash={[5, 4]}
                    listening={false}
                  />
                )
              })()
            : null}
        </Layer>
      </Stage>

      {interactions.tooltip ? (
        <div
          className="konva-tooltip"
          style={{ left: interactions.tooltip.x, top: interactions.tooltip.y }}
        >
          <div>{interactions.tooltip.node.name}</div>
          <div className="tile-tooltip-detail">
            {/* 富文本的 body 是 HTML，悬停只展示纯文本投影，避免露出标签。 */}
            {interactions.tooltip.node.path ??
              interactions.tooltip.node.url ??
              (interactions.tooltip.node.kind === 'richtext'
                ? interactions.tooltip.node.subtitle
                : interactions.tooltip.node.body) ??
              interactions.tooltip.node.subtitle}
          </div>
        </div>
      ) : null}

      {nodes.length > 0 || groups.length > 0 ? (
        <Minimap
          bounds={minimapBounds}
          nodes={nodes}
          groups={groups}
          viewport={viewport}
          size={size}
          themeId={themeId}
          onMoveTo={moveViewportTo}
        />
      ) : null}
    </div>
  )
})

CanvasBoard.displayName = 'CanvasBoard'

export default CanvasBoard
