/**
 * Konva 画布：平移/缩放、视口裁剪（rbush）、三档 LOD、框选、拖动、分组框、
 * 有向连线（含标签与选中）、标注点与迷你地图。组件接口与旧 DOM 版一致，
 * 场景数据与选中状态仍由 App 持有。
 *
 * 交互模型对齐 PS：
 * - 左键拖空白 = 框选；拖动卡片 = 移动；画布默认不随手拖走；
 * - 空格 + 左键拖拽 = 平移画布；Alt/Ctrl + 滚轮 = 以指针为锚缩放；
 * - 选中对象四向圆点拖出连线。
 *
 * 坐标约定：
 * - world：场景节点坐标（px）；
 * - screen = world * scale + (x, y)，由 Stage 的 position/scale 实现。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Konva from 'konva'
import RBush from 'rbush'
import {
  Arrow,
  Circle,
  Group,
  Image as KonvaImage,
  Label,
  Layer,
  Rect,
  Stage,
  Tag,
  Text,
} from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type {
  SceneAnnotation,
  SceneEdge,
  SceneGroup,
  SceneNode,
  SystemIconKind,
} from '@/types/scene'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
import SystemIcon from './SystemIcon'

// 迷你地图最小映射范围；内容超出时按实际包围盒扩展。
const MINIMAP_MIN_W = 1200
const MINIMAP_MIN_H = 900
// 迷你地图最多绘制的节点点数，超大画布按步长抽样，避免 DOM 爆炸。
const MINIMAP_MAX_DOTS = 400

/** LOD 阈值：<50% 色点，50%–70% 简化行，≥70% 完整图标格。 */
const LOD_DOT = 0.5
const LOD_COMPACT = 0.7

interface CanvasBoardProps {
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
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void
  onSelectEdge: (id: string) => void
  onEdgeLabelEdit: (id: string) => void
  onConnect: (from: string, to: string) => void
  onAnnotation: (annotation: SceneAnnotation) => void
  onActivate: (id: string) => void
  onTextCommit: (id: string, text: string, live?: boolean) => void
  onScaleChange: (scale: number) => void
}

export interface CanvasBoardHandle {
  locateNode: (id: string) => void
  fitView: () => void
  zoomBy: (factor: number) => void
  getCenterWorld: () => { x: number; y: number }
  editText: (id: string) => void
}

/** 视口：屏幕坐标 = 世界坐标 * scale + (x, y)。 */
interface Viewport {
  x: number
  y: number
  scale: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** 远景色点颜色：按文件类型区分，与资源管理器语义一致，不随主题变化。 */
function lodColor(node: SceneNode) {
  switch (node.icon) {
    case 'folder':
      return '#d8b04a'
    case 'pdf':
      return '#b65a53'
    case 'docx':
    case 'dwg':
    case 'link':
      return '#587c9d'
    case 'xlsx':
      return '#5a8065'
    case 'exe':
      return '#6b757d'
    case 'image':
      return '#799683'
    case 'video':
      return '#707982'
    default:
      return '#9a9d97'
  }
}

/** 读取语义令牌；主题切换由 App 重渲染触发，此处每次渲染取最新值。 */
function cssVar(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** 进程内缩略图缓存：请求过的 data URL 转成 HTMLImageElement 复用。 */
const THUMB_IMAGES = new Map<string, HTMLImageElement | null>()
/** 系统图标 data URL 缓存：SVG 渲染一次后转图片，Konva 直接绘制。 */
const ICON_IMAGES = new Map<SystemIconKind, HTMLImageElement>()
let iconLoadStarted = false

/** 图标解码完成前画布会画空白，解码结束后必须重渲染一次，否则首屏永远没有图标。 */
function startIconLoad(onSettled: () => void) {
  if (iconLoadStarted) {
    onSettled()
    return
  }
  iconLoadStarted = true
  const kinds: SystemIconKind[] = [
    'folder',
    'pdf',
    'docx',
    'xlsx',
    'dwg',
    'exe',
    'image',
    'video',
    'txt',
    'link',
    'text',
  ]
  let pending = kinds.length
  const settle = () => {
    pending -= 1
    if (pending === 0) onSettled()
  }
  kinds.forEach((kind) => {
    const svg = renderToStaticMarkup(<SystemIcon kind={kind} size={32} />)
    // React 序列化可能省略 xmlns，浏览器会直接判为无效 SVG；缺了就补上。
    const withNamespace = svg.includes('xmlns=')
      ? svg
      : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
    const image = new window.Image()
    image.onload = () => {
      ICON_IMAGES.set(kind, image)
      settle()
    }
    image.onerror = () => {
      // 图标缺失会退化成纯文字，属于可见缺陷，必须留下可诊断的痕迹。
      console.error(`[络雀] 系统图标加载失败：${kind}`)
      settle()
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`
  })
}

/** 快捷键事件必须避开输入控件，否则会吞掉正在编辑的文字。 */
function isTypingTarget(target: EventTarget | null) {
  const element = target as Element | null
  return typeof element?.closest === 'function'
    ? Boolean(element.closest('input, textarea, [contenteditable="true"]'))
    : false
}

/** 四向锚点：选中对象后用于拖出连线。 */
type HandleSide = 'top' | 'right' | 'bottom' | 'left'
const HANDLE_SIDES: HandleSide[] = ['top', 'right', 'bottom', 'left']

function handlePoint(node: SceneNode, side: HandleSide) {
  switch (side) {
    case 'top':
      return { x: node.x + node.w / 2, y: node.y }
    case 'right':
      return { x: node.x + node.w, y: node.y + node.h / 2 }
    case 'bottom':
      return { x: node.x + node.w / 2, y: node.y + node.h }
    default:
      return { x: node.x, y: node.y + node.h / 2 }
  }
}

/**
 * 展示名：图标格只有两行，后缀必须出现——同名不同后缀的文件功能完全不同。
 * 带后缀且整体放不下时，主体截断放第一行，后缀单独占第二行。
 * 72px 宽、11px 字号每行约 6 个中文字符。
 */
const NAME_LINE_BUDGET = 6

function displayName(name: string) {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && dot < name.length - 1
  // 两行放得下就原样交给 Konva 换行，后缀自然落在第二行。
  if (name.length <= NAME_LINE_BUDGET * 2) return name
  if (!hasExt) return `${name.slice(0, NAME_LINE_BUDGET * 2 - 1)}…`
  const base = name.slice(0, dot)
  const ext = name.slice(dot)
  // 后缀单独占第二行，保证一定可见；后缀过长时保留前几位以看出类型。
  const extLine =
    ext.length > NAME_LINE_BUDGET * 2 ? `${ext.slice(0, NAME_LINE_BUDGET * 2 - 1)}…` : ext
  return `${base.slice(0, NAME_LINE_BUDGET - 1)}…\n${extLine}`
}

/** rbush 条目：节点包围盒，用于视口裁剪查询。 */
interface BoundsItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

const CanvasBoard = forwardRef<CanvasBoardHandle, CanvasBoardProps>(function CanvasBoard(
  {
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
    onMoveNodes,
    onSelectEdge,
    onEdgeLabelEdit,
    onConnect,
    onAnnotation,
    onActivate,
    onTextCommit,
    onScaleChange,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const nodeGroupRefs = useRef(new Map<string, Konva.Group>())
  const titleRefs = useRef(new Map<string, Konva.Text>())
  const ringRefs = useRef(new Map<string, Konva.Rect>())
  const [size, setSize] = useState({ width: 1280, height: 720 })
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 0.82 })
  const [visibleNodes, setVisibleNodes] = useState<SceneNode[]>(nodes)
  const [selectionRect, setSelectionRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SceneNode } | null>(null)
  // 空格键按住时才允许拖动画布，避免左键拖空白被误当成平移。
  const [spaceHeld, setSpaceHeld] = useState(false)
  // 连线拖拽预览：起点锚点 + 当前指针世界坐标。
  const [connectPreview, setConnectPreview] = useState<{
    from: string
    side: HandleSide
    x: number
    y: number
  } | null>(null)
  // 文字节点在画布上直接编辑，不使用弹窗。
  const [editor, setEditor] = useState<string | null>(null)
  // ICON_IMAGES 是模块级缓存，图标解码完成后靠这个版本号触发一次重渲染。
  const [, setIconVersion] = useState(0)

  const viewportRef = useRef(viewport)
  const spaceRef = useRef(false)
  const panStart = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)
  const panMoved = useRef(false)
  // 会话内记录指针位置：pointerup 时按会话值提交，不依赖 state 或指针是否还在画布内。
  const boxSession = useRef<{
    startX: number
    startY: number
    currentX: number
    currentY: number
    additive: boolean
  } | null>(null)
  const dragSession = useRef<{
    items: { id: string; x: number; y: number }[]
    pointerX: number
    pointerY: number
    lastX: number
    lastY: number
    moving: boolean
  } | null>(null)
  const connectSession = useRef<{
    from: string
    side: HandleSide
    x: number
    y: number
  } | null>(null)
  const groupDrag = useRef<{ id: string; lastX: number; lastY: number } | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const hoverTimer = useRef<number | null>(null)
  const pulseTimer = useRef<number | null>(null)
  const frameRequest = useRef<number | null>(null)

  viewportRef.current = viewport

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const annotationByNode = useMemo(() => {
    const map = new Map<string, SceneAnnotation>()
    annotations.forEach((annotation) => {
      annotation.nodeIds.forEach((nodeId) => {
        if (!map.has(nodeId)) map.set(nodeId, annotation)
      })
    })
    return map
  }, [annotations])

  /** 空间索引：节点集合变化时重建；查询用带预取边距的视口矩形。 */
  const rbush = useMemo(() => {
    const tree = new RBush<BoundsItem>()
    tree.load(
      nodes.map((node) => ({
        minX: node.x,
        minY: node.y,
        maxX: node.x + node.w,
        maxY: node.y + node.h,
        id: node.id,
      })),
    )
    return tree
  }, [nodes])

  useEffect(() => {
    startIconLoad(() => setIconVersion((value) => value + 1))
  }, [])

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

  // 进入内联编辑后聚焦并全选，双击后可直接覆盖输入。
  useEffect(() => {
    if (!editor) return
    const element = editorRef.current
    if (!element) return
    element.focus()
    element.select()
  }, [editor])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const updateSize = () => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    onScaleChange(viewport.scale)
  }, [onScaleChange, viewport.scale])

  // 视口变化后按帧裁剪可见节点，平移缩放期间不额外触发渲染风暴。
  useEffect(() => {
    if (frameRequest.current) cancelAnimationFrame(frameRequest.current)
    frameRequest.current = requestAnimationFrame(() => {
      const margin = 180 / viewport.scale
      const left = -viewport.x / viewport.scale - margin
      const top = -viewport.y / viewport.scale - margin
      const right = left + size.width / viewport.scale + margin * 2
      const bottom = top + size.height / viewport.scale + margin * 2
      const hits = rbush.search({
        minX: left,
        minY: top,
        maxX: right,
        maxY: bottom,
      })
      const hitIds = new Set(hits.map((item) => item.id))
      setVisibleNodes(nodes.filter((node) => hitIds.has(node.id)))
    })
    return () => {
      if (frameRequest.current) cancelAnimationFrame(frameRequest.current)
    }
  }, [nodes, rbush, size.height, size.width, viewport])

  const lod = viewport.scale < LOD_DOT
  const compact = !lod && viewport.scale < LOD_COMPACT

  const visibleEdges = useMemo(() => {
    // 低缩放且无选中时不画边，避免线条淹没色点。
    if (viewport.scale < 0.62 && selectedSet.size === 0 && !selectedEdgeId) return []
    const visibleIds = new Set(visibleNodes.map((node) => node.id))
    return edges.filter((edge) => {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) return false
      if (selectedEdgeId) return edge.id === selectedEdgeId
      if (selectedSet.size > 0) return selectedSet.has(edge.from) || selectedSet.has(edge.to)
      return visibleIds.has(edge.from) || visibleIds.has(edge.to)
    })
  }, [edges, nodeById, selectedEdgeId, selectedSet, viewport.scale, visibleNodes])

  // ---------- 视口操作 ----------

  const zoomAt = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    setViewport((previous) => {
      const scale = clamp(nextScale, 0.22, 2)
      const ratio = scale / previous.scale
      return {
        x: anchorX - (anchorX - previous.x) * ratio,
        y: anchorY - (anchorY - previous.y) * ratio,
        scale,
      }
    })
  }, [])

  const locateNode = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      if (!node) return
      const scale = Math.max(viewportRef.current.scale, 0.92)
      const availableWidth = Math.max(240, size.width - (detailsOpen ? 300 : 0))
      const x = availableWidth / 2 - (node.x + node.w / 2) * scale
      const y = size.height / 2 - (node.y + node.h / 2) * scale
      setViewport({ x, y, scale })
      setPulseId(id)
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current)
      pulseTimer.current = window.setTimeout(() => setPulseId(null), 1600)
    },
    [detailsOpen, nodeById, size.height, size.width],
  )

  const fitView = useCallback(() => {
    const boxes = groups.length > 0 ? groups : nodes
    if (!boxes.length) return
    const bounds = boxes.reduce(
      (result, box) => ({
        minX: Math.min(result.minX, box.x),
        minY: Math.min(result.minY, box.y),
        maxX: Math.max(result.maxX, box.x + box.w),
        maxY: Math.max(result.maxY, box.y + box.h),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    )
    const width = Math.max(1, bounds.maxX - bounds.minX)
    const height = Math.max(1, bounds.maxY - bounds.minY)
    const scale = clamp(Math.min((size.width - 80) / width, (size.height - 80) / height), 0.22, 1.2)
    setViewport({
      x: (size.width - width * scale) / 2 - bounds.minX * scale,
      y: (size.height - height * scale) / 2 - bounds.minY * scale,
      scale,
    })
  }, [groups, nodes, size.height, size.width])

  const zoomBy = useCallback(
    (factor: number) => {
      zoomAt(viewportRef.current.scale * factor, size.width / 2, size.height / 2)
    },
    [size.height, size.width, zoomAt],
  )

  const getCenterWorld = useCallback(() => {
    const current = viewportRef.current
    return {
      x: (size.width / 2 - current.x) / current.scale,
      y: (size.height / 2 - current.y) / current.scale,
    }
  }, [size.height, size.width])

  /** 进入文字节点的画布内联编辑；非文字节点忽略。 */
  const editText = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      if (!node || node.kind !== 'text') return
      setEditor(id)
    },
    [nodeById],
  )

  useImperativeHandle(ref, () => ({ locateNode, fitView, zoomBy, getCenterWorld, editText }), [
    editText,
    fitView,
    getCenterWorld,
    locateNode,
    zoomBy,
  ])

  // ---------- 缩略图（图片节点，停留后加载） ----------

  const [thumbVersion, setThumbVersion] = useState(0)
  useEffect(() => {
    if (!isDesktopClient) return
    const pending = visibleNodes.filter(
      (node) => node.kind === 'image' && node.isExists && !THUMB_IMAGES.has(node.id),
    )
    if (pending.length === 0) return

    // 停留 300ms 后批量请求，快速平移不触发缩略图生成。
    const timer = window.setTimeout(() => {
      void Promise.all(
        pending.slice(0, 60).map(async (node) => {
          try {
            const source = await desktopApi.thumbGet(node.id)
            if (!source) {
              THUMB_IMAGES.set(node.id, null)
              return
            }
            const image = new window.Image()
            await new Promise<void>((resolve) => {
              image.onload = () => resolve()
              image.onerror = () => resolve()
              image.src = source
            })
            THUMB_IMAGES.set(node.id, image)
          } catch {
            THUMB_IMAGES.set(node.id, null)
          }
        }),
      ).then(() => setThumbVersion((value) => value + 1))
    }, 300)

    return () => window.clearTimeout(timer)
  }, [thumbVersion, visibleNodes])

  // ---------- 交互 ----------

  const screenToWorld = (x: number, y: number) => {
    const current = viewportRef.current
    return { x: (x - current.x) / current.scale, y: (y - current.y) / current.scale }
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

    if (dragSession.current) {
      const session = dragSession.current
      const scale = viewportRef.current.scale
      const dx = (pointer.x - session.pointerX) / scale
      const dy = (pointer.y - session.pointerY) / scale
      session.lastX = pointer.x
      session.lastY = pointer.y
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) session.moving = true
      session.items.forEach((item) => {
        const group = nodeGroupRefs.current.get(item.id)
        if (!group) return
        group.position({ x: item.x + dx, y: item.y + dy })
      })
      // 连线跟随拖动中的节点：Konva 的 className 不参与 find 选择器，按形状类型取。
      const stage2 = stageRef.current
      if (stage2) {
        stage2.find('Arrow').forEach((shape) => {
          const edgeId = shape.getAttr('edgeId')
          const edge = edges.find((item) => item.id === edgeId)
          if (!edge) return
          const fromNode = nodeById.get(edge.from)
          const toNode = nodeById.get(edge.to)
          const fromGroup = nodeGroupRefs.current.get(edge.from)
          const toGroup = nodeGroupRefs.current.get(edge.to)
          if (!fromNode || !toNode || !fromGroup || !toGroup) return
          const from = { x: fromGroup.x(), y: fromGroup.y(), w: fromNode.w, h: fromNode.h }
          const to = { x: toGroup.x(), y: toGroup.y(), w: toNode.w, h: toNode.h }
          shape.setAttr('points', edgePoints(from, to))
        })
      }
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
      // 命中指针下方的卡片即建立连线；命中自身或空白处视为取消。
      const target = [...nodes]
        .reverse()
        .find(
          (node) =>
            node.id !== session.from &&
            world.x >= node.x &&
            world.x <= node.x + node.w &&
            world.y >= node.y &&
            world.y <= node.y + node.h,
        )
      if (target) onConnect(session.from, target.id)
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
        const scale = viewportRef.current.scale
        const dx = (session.lastX - session.pointerX) / scale
        const dy = (session.lastY - session.pointerY) / scale
        onMoveNodes(
          session.items.map((item) => ({
            id: item.id,
            x: Math.round(item.x + dx),
            y: Math.round(item.y + dy),
          })),
        )
      } else {
        // 未移动视为点选。
        const first = session.items[0]
        if (first) onSelect(first.id, false)
      }
      dragSession.current = null
    }

    panStart.current = null
  }

  // 指针在画布外释放时 Stage 收不到 pointerup，会话会残留；这里做一次兜底收尾。
  const pointerUpRef = useRef(handleStagePointerUp)
  pointerUpRef.current = handleStagePointerUp
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
    const stage = stageRef.current
    if (!stage) return
    if (panMoved.current) {
      panMoved.current = false
      return
    }
    if (event.target === stage) onClearSelection()
  }

  const handleNodePointerDown = (event: KonvaEventObject<MouseEvent>, node: SceneNode) => {
    // 空格按住时让事件冒泡给 Stage，画布平移优先于拖动卡片。
    if (spaceRef.current || event.evt.button !== 0) return
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    event.cancelBubble = true

    const additive = event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey
    if (additive) {
      onSelect(node.id, true)
      return
    }

    if (lod) {
      onSelect(node.id, false)
      return
    }

    const dragIds = selectedSet.has(node.id) ? selectedIds : [node.id]
    dragSession.current = {
      items: dragIds
        .map((id) => nodeById.get(id))
        .filter((item): item is SceneNode => Boolean(item))
        .map((item) => ({ id: item.id, x: item.x, y: item.y })),
      pointerX: pointer.x,
      pointerY: pointer.y,
      lastX: pointer.x,
      lastY: pointer.y,
      moving: false,
    }
  }

  const handleGroupTitleDown = (event: KonvaEventObject<DragEvent>, groupId: string) => {
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    event.cancelBubble = true
    onSelectGroup(groupId)
    groupDrag.current = { id: groupId, lastX: pointer.x, lastY: pointer.y }
  }

  const handleGroupTitleMove = (event: KonvaEventObject<DragEvent>) => {
    const session = groupDrag.current
    const pointer = stageRef.current?.getPointerPosition()
    if (!session || !pointer) return
    event.cancelBubble = true
    const scale = viewportRef.current.scale
    const dx = (pointer.x - session.lastX) / scale
    const dy = (pointer.y - session.lastY) / scale
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) return
    session.lastX = pointer.x
    session.lastY = pointer.y
    onMoveGroup(session.id, dx, dy)
  }

  const handleGroupTitleUp = () => {
    groupDrag.current = null
  }

  const handleNodeMouseEnter = (_event: KonvaEventObject<MouseEvent>, node: SceneNode) => {
    if (lod) return
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      const stage = stageRef.current
      const pointer = stage?.getPointerPosition()
      if (!pointer) return
      setTooltip({
        x: pointer.x + 12,
        y: pointer.y + 16,
        node,
      })
    }, 350)
  }

  const handleNodeMouseLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    setTooltip(null)
  }

  // ---------- 渲染 ----------

  const primary = cssVar('--primary', '#756E87')
  const border = cssVar('--border', '#E4E0E8')
  const selectedBg = cssVar('--selected-bg', '#EEEAF3')
  const text = cssVar('--text', '#30343A')
  const textSecondary = cssVar('--text-secondary', '#747A83')

  /** 节点图形：LOD 决定形态；`index` 未使用但保留给未来排序。 */
  const renderNode = (node: SceneNode) => {
    const selected = selectedSet.has(node.id)
    const annotation = annotationByNode.get(node.id)

    if (lod) {
      return (
        <Group
          key={node.id}
          x={node.x}
          y={node.y}
          onClick={(event) => {
            event.cancelBubble = true
            onSelect(node.id, false)
          }}
          onDblClick={(event) => {
            event.cancelBubble = true
            onActivate(node.id)
          }}
        >
          <Rect
            width={node.w}
            height={node.h}
            fill={lodColor(node)}
            cornerRadius={2}
            opacity={0.85}
          />
        </Group>
      )
    }

    const image = node.thumbKey || node.kind === 'image' ? THUMB_IMAGES.get(node.id) : null
    const icon = ICON_IMAGES.get(node.icon)
    const iconSize = compact ? 24 : 32
    // 72×64 的图标格里，两行名称必须收在框内，否则会压住选中框下沿。
    const labelHeight = compact ? 14 : 28
    const showIcon = Boolean(image || icon)
    // 图标尚未就绪时不能留 38px 空洞，否则名称会跑到选中框外，看起来像选框错位。
    const iconY = compact ? 2 : 3
    const labelY = showIcon ? iconY + iconSize + 1 : compact ? 4 : 6
    // 单点选中时显示四向锚点，拖拽即可拉出连线。
    const showHandles = selected && selectedSet.size === 1 && !compact

    return (
      <Group
        key={node.id}
        ref={(instance) => {
          if (instance) nodeGroupRefs.current.set(node.id, instance)
          else nodeGroupRefs.current.delete(node.id)
        }}
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        onMouseDown={(event) => handleNodePointerDown(event, node)}
        onClick={(event) => {
          event.cancelBubble = true
          if (!dragSession.current) onSelect(node.id, false)
        }}
        onDblClick={(event) => {
          event.cancelBubble = true
          if (node.kind === 'text') setEditor(node.id)
          else onActivate(node.id)
        }}
        onMouseEnter={(event) => handleNodeMouseEnter(event, node)}
        onMouseLeave={handleNodeMouseLeave}
      >
        {selected ? (
          <Rect
            width={node.w}
            height={node.h}
            fill={selectedBg}
            stroke={primary}
            strokeWidth={1}
            cornerRadius={6}
          />
        ) : null}
        {image ? (
          <KonvaImage
            image={image}
            width={iconSize}
            height={iconSize}
            x={(node.w - iconSize) / 2}
            y={iconY}
          />
        ) : icon ? (
          <KonvaImage
            image={icon}
            width={iconSize}
            height={iconSize}
            x={(node.w - iconSize) / 2}
            y={iconY}
          />
        ) : null}
        <Text
          width={node.w}
          height={labelHeight}
          y={labelY}
          text={displayName(node.name)}
          fontSize={compact ? 10.5 : 11}
          fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
          fill={text}
          align="center"
          wrap="word"
          ellipsis={!compact}
          lineHeight={1.2}
        />
        {!node.isExists ? (
          <Rect width={26} height={13} x={2} y={2} fill="#C44B52" cornerRadius={3} />
        ) : null}
        {!node.isExists ? (
          <Text
            width={26}
            height={13}
            x={2}
            y={2}
            text="缺失"
            fontSize={9}
            fill="#fff"
            align="center"
            listening={false}
          />
        ) : null}
        {annotation ? (
          <Circle
            radius={3}
            x={node.w - 5}
            y={5}
            fill={annotationDotColor(annotation.color)}
            onClick={(event) => {
              event.cancelBubble = true
              onAnnotation(annotation)
            }}
          />
        ) : null}
        {showHandles
          ? HANDLE_SIDES.map((side) => {
              const point = handlePoint({ ...node, x: 0, y: 0 }, side)
              return (
                <Circle
                  key={`handle-${side}`}
                  x={point.x}
                  y={point.y}
                  radius={3.5}
                  fill="#fff"
                  stroke={primary}
                  strokeWidth={1.5}
                  hitStrokeWidth={10}
                  onMouseDown={(event) => {
                    event.cancelBubble = true
                    const pointer = stageRef.current?.getPointerPosition()
                    const world = pointer ? screenToWorld(pointer.x, pointer.y) : { x: 0, y: 0 }
                    connectSession.current = { from: node.id, side, x: world.x, y: world.y }
                    setConnectPreview({ from: node.id, side, x: world.x, y: world.y })
                  }}
                />
              )
            })
          : null}
      </Group>
    )
  }

  /** 脉冲高亮：定位后 1.6s 内闪烁选中环。 */
  useEffect(() => {
    if (!pulseId) return
    const ring = ringRefs.current.get(pulseId)
    const node = nodeById.get(pulseId)
    if (!ring || !node) return
    ring.opacity(1)
    const tween = new Konva.Tween({
      node: ring,
      duration: 1.4,
      easing: Konva.Easings.EaseOut,
      opacity: 0,
    })
    tween.play()
    return () => tween.destroy()
  }, [nodeById, pulseId])

  /**
   * 迷你地图映射范围：只取内容包围盒（无内容时取当前视口）。
   * 若把视口并进来，平移会同时放大范围，视口框就会始终粘在原地。
   */
  const minimapBounds = useMemo(() => {
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
    groups.forEach((group) => consider(group.x, group.y, group.w, group.h))
    if (!Number.isFinite(minX)) {
      const left = -viewport.x / viewport.scale
      const top = -viewport.y / viewport.scale
      consider(left, top, size.width / viewport.scale, size.height / viewport.scale)
    }
    const padX = Math.max(120, (maxX - minX) * 0.15)
    const padY = Math.max(120, (maxY - minY) * 0.15)
    minX -= padX
    minY -= padY
    maxX += padX
    maxY += padY
    return {
      minX,
      minY,
      width: Math.max(MINIMAP_MIN_W, maxX - minX),
      height: Math.max(MINIMAP_MIN_H, maxY - minY),
    }
  }, [groups, nodes, size.height, size.width, viewport])

  const toMinimap = (x: number, y: number) => ({
    left: `${((x - minimapBounds.minX) / minimapBounds.width) * 100}%`,
    top: `${((y - minimapBounds.minY) / minimapBounds.height) * 100}%`,
  })

  /** 迷你地图点击/拖拽：把点击处对应的世界坐标移到视口中心。 */
  const moveViewportTo = useCallback(
    (clientX: number, clientY: number, element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const worldX = minimapBounds.minX + ((clientX - rect.left) / rect.width) * minimapBounds.width
      const worldY =
        minimapBounds.minY + ((clientY - rect.top) / rect.height) * minimapBounds.height
      setViewport((previous) => ({
        ...previous,
        x: size.width / 2 - worldX * previous.scale,
        y: size.height / 2 - worldY * previous.scale,
      }))
    },
    [minimapBounds, size.height, size.width],
  )

  const minimapDrag = useRef(false)

  return (
    <div ref={containerRef} className={`canvas-board${spaceHeld ? ' is-panning' : ''}`}>
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        x={viewport.x}
        y={viewport.y}
        onWheel={handleWheel}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onClick={handleStageClick}
      >
        <Layer listening={false}>
          {groups.map((group) => (
            <Rect
              key={group.id}
              x={group.x}
              y={group.y}
              width={group.w}
              height={group.h}
              stroke={selectedGroupId === group.id ? primary : border}
              dash={[4, 4]}
              cornerRadius={8}
              listening={false}
            />
          ))}
        </Layer>

        {/* 连线层必须接收事件，否则边无法选中、也无法双击编辑标签。 */}
        <Layer>
          {visibleEdges.map((edge) => {
            const fromNode = nodeById.get(edge.from)
            const toNode = nodeById.get(edge.to)
            const fromGroup = nodeGroupRefs.current.get(edge.from)
            const toGroup = nodeGroupRefs.current.get(edge.to)
            if (!fromNode || !toNode) return null
            const from = {
              x: fromGroup ? fromGroup.x() : fromNode.x,
              y: fromGroup ? fromGroup.y() : fromNode.y,
              w: fromNode.w,
              h: fromNode.h,
            }
            const to = {
              x: toGroup ? toGroup.x() : toNode.x,
              y: toGroup ? toGroup.y() : toNode.y,
              w: toNode.w,
              h: toNode.h,
            }
            const points = edgePoints(from, to)
            const midX = (points[0] + points[6]) / 2
            const midY = (points[1] + points[7]) / 2
            return (
              <Group key={edge.id}>
                <Arrow
                  className="edge-path"
                  edgeId={edge.id}
                  points={points}
                  bezier
                  stroke={edge.id === selectedEdgeId ? primary : border}
                  fill={edge.id === selectedEdgeId ? primary : border}
                  strokeWidth={edge.id === selectedEdgeId ? 2 : 1}
                  hitStrokeWidth={12}
                  listening
                  onClick={(event) => {
                    event.cancelBubble = true
                    onSelectEdge(edge.id)
                  }}
                  onDblClick={(event) => {
                    event.cancelBubble = true
                    onEdgeLabelEdit(edge.id)
                  }}
                />
                {edge.label ? (
                  <Label x={midX} y={midY} listening={false}>
                    <Tag fill={cssVar('--canvas', '#F8F7FA')} stroke={border} cornerRadius={3} />
                    <Text
                      text={edge.label}
                      fontSize={10}
                      padding={3}
                      fill={textSecondary}
                      fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
                    />
                  </Label>
                ) : null}
              </Group>
            )
          })}
        </Layer>

        <Layer>
          {groups.map((group) => (
            <Text
              key={`title-${group.id}`}
              ref={(instance) => {
                if (instance) titleRefs.current.set(group.id, instance)
                else titleRefs.current.delete(group.id)
              }}
              x={group.x + 10}
              y={group.y - 8}
              text={group.title}
              fontSize={9}
              fill={selectedGroupId === group.id ? primary : textSecondary}
              fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
              padding={1}
              draggable
              onDragStart={(event) => handleGroupTitleDown(event, group.id)}
              onDragMove={handleGroupTitleMove}
              onDragEnd={handleGroupTitleUp}
            />
          ))}
          {visibleNodes.map(renderNode)}
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
                    height={node.h + 8}
                    stroke={primary}
                    strokeWidth={2}
                    cornerRadius={8}
                    listening={false}
                  />
                )
              })()
            : null}
          {selectionRect ? (
            <Rect
              x={selectionRect.x}
              y={selectionRect.y}
              width={selectionRect.w}
              height={selectionRect.h}
              fill={selectedBg}
              opacity={0.6}
              stroke={primary}
              strokeWidth={1}
              listening={false}
            />
          ) : null}
          {connectPreview
            ? (() => {
                const source = nodeById.get(connectPreview.from)
                if (!source) return null
                const start = handlePoint(source, connectPreview.side)
                return (
                  <Arrow
                    points={[start.x, start.y, connectPreview.x, connectPreview.y]}
                    stroke={primary}
                    fill={primary}
                    strokeWidth={1.5}
                    dash={[5, 4]}
                    listening={false}
                  />
                )
              })()
            : null}
        </Layer>
      </Stage>

      {(() => {
        const node = editor ? nodeById.get(editor) : null
        if (!node) return null
        return (
          <textarea
            ref={editorRef}
            className="canvas-text-editor"
            defaultValue={node.body ?? node.subtitle ?? node.name}
            style={{
              left: node.x * viewport.scale + viewport.x,
              top: node.y * viewport.scale + viewport.y,
              width: Math.max(200, node.w * viewport.scale),
              minHeight: Math.max(72, node.h * viewport.scale),
            }}
            onChange={(event) => {
              // 边输入边更新画布名称，编辑区外也能看到实时结果。
              onTextCommit(node.id, event.target.value, true)
            }}
            onBlur={() => {
              onTextCommit(node.id, editorRef.current?.value ?? '')
              setEditor(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.currentTarget.blur()
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                event.currentTarget.blur()
              }
              event.stopPropagation()
            }}
            placeholder="直接输入文字，Esc 或点击空白处结束"
            aria-label="编辑文字"
          />
        )
      })()}

      {tooltip ? (
        <div className="konva-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div>{tooltip.node.name}</div>
          <div className="tile-tooltip-detail">
            {tooltip.node.path ?? tooltip.node.url ?? tooltip.node.body ?? tooltip.node.subtitle}
          </div>
        </div>
      ) : null}

      {nodes.length > 0 || groups.length > 0 ? (
        <div
          className="minimap"
          title="点击或拖动定位视口"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            minimapDrag.current = true
            moveViewportTo(event.clientX, event.clientY, event.currentTarget)
          }}
          onPointerMove={(event) => {
            if (!minimapDrag.current) return
            moveViewportTo(event.clientX, event.clientY, event.currentTarget)
          }}
          onPointerUp={(event) => {
            minimapDrag.current = false
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
        >
          {groups.map((group) => (
            <span
              key={group.id}
              className="minimap-group"
              style={{
                ...toMinimap(group.x, group.y),
                width: `${(group.w / minimapBounds.width) * 100}%`,
                height: `${(group.h / minimapBounds.height) * 100}%`,
              }}
            />
          ))}
          {nodes
            .filter((_node, index) => index % Math.ceil(nodes.length / MINIMAP_MAX_DOTS) === 0)
            .map((node) => (
              <span
                key={`dot-${node.id}`}
                className="minimap-dot"
                style={{
                  ...toMinimap(node.x, node.y),
                  width: `${Math.max(0.6, (node.w / minimapBounds.width) * 100)}%`,
                  height: `${Math.max(0.6, (node.h / minimapBounds.height) * 100)}%`,
                }}
              />
            ))}
          <span
            className="minimap-viewport"
            style={{
              ...toMinimap(-viewport.x / viewport.scale, -viewport.y / viewport.scale),
              width: `${clamp((size.width / viewport.scale / minimapBounds.width) * 100, 2, 100)}%`,
              height: `${clamp((size.height / viewport.scale / minimapBounds.height) * 100, 2, 100)}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  )
})

/** 标注色点：固定四色，不随主题变化。 */
function annotationDotColor(color: string) {
  switch (color) {
    case 'amber':
      return '#b88734'
    case 'red':
      return '#b35a51'
    case 'blue':
      return '#4f7392'
    default:
      return '#2f6b5b'
  }
}

/**
 * 连线路径点：[x1, y1, cx1, cy1, cx2, cy2, x2, y2]。
 * 水平距离更大时从左右侧边出发，否则从上下侧边出发，避免线条穿过卡片内容。
 */
function edgePoints(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
) {
  const fromX = from.x + from.w / 2
  const fromY = from.y + from.h / 2
  const toX = to.x + to.w / 2
  const toY = to.y + to.h / 2
  const dx = toX - fromX
  const dy = toY - fromY

  if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = dx >= 0 ? from.x + from.w : from.x
    const x2 = dx >= 0 ? to.x : to.x + to.w
    const bend = Math.max(30, Math.min(100, Math.abs(x2 - x1) * 0.34))
    return [
      x1,
      fromY,
      x1 + (dx >= 0 ? bend : -bend),
      fromY,
      x2 - (dx >= 0 ? bend : -bend),
      toY,
      x2,
      toY,
    ]
  }

  const y1 = dy >= 0 ? from.y + from.h : from.y
  const y2 = dy >= 0 ? to.y : to.y + to.h
  const bend = Math.max(28, Math.min(80, Math.abs(y2 - y1) * 0.32))
  return [
    fromX,
    y1,
    fromX,
    y1 + (dy >= 0 ? bend : -bend),
    toX,
    y2 - (dy >= 0 ? bend : -bend),
    toX,
    y2,
  ]
}

CanvasBoard.displayName = 'CanvasBoard'

export default CanvasBoard
