/**
 * Konva 画布：平移/缩放、视口裁剪（rbush）、三档 LOD、框选、拖动、分组框、
 * 有向连线（含标签与选中）、标注点与迷你地图。组件接口与旧 DOM 版一致，
 * 场景数据与选中状态仍由 App 持有。
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

// 迷你地图映射的世界尺寸；节点坐标可超出，迷你地图自行裁剪。
const WORLD_W = 4000
const WORLD_H = 2900

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
  onAnnotation: (annotation: SceneAnnotation) => void
  onActivate: (id: string) => void
  onScaleChange: (scale: number) => void
}

export interface CanvasBoardHandle {
  locateNode: (id: string) => void
  fitView: () => void
  zoomBy: (factor: number) => void
  getCenterWorld: () => { x: number; y: number }
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

function startIconLoad() {
  if (iconLoadStarted) return
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
  kinds.forEach((kind) => {
    const svg = renderToStaticMarkup(<SystemIcon kind={kind} size={32} />)
    const image = new window.Image()
    image.onload = () => {
      ICON_IMAGES.set(kind, image)
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
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
    onAnnotation,
    onActivate,
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

  const viewportRef = useRef(viewport)
  const panStart = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)
  const panMoved = useRef(false)
  const boxSession = useRef<{ startX: number; startY: number; additive: boolean } | null>(null)
  const dragSession = useRef<{
    items: { id: string; x: number; y: number }[]
    pointerX: number
    pointerY: number
    moving: boolean
  } | null>(null)
  const groupDrag = useRef<{ id: string; lastX: number; lastY: number } | null>(null)
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
    startIconLoad()
  }, [])

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

  useImperativeHandle(ref, () => ({ locateNode, fitView, zoomBy, getCenterWorld }), [
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

  const handleWheel = (event: KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    const factor = event.evt.deltaY > 0 ? 0.9 : 1.1
    zoomAt(
      viewportRef.current.scale * factor,
      pointer?.x ?? size.width / 2,
      pointer?.y ?? size.height / 2,
    )
  }

  const handleStagePointerDown = (event: KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current
    if (!stage) return
    const targetIsStage = event.target === stage
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    if (event.evt.shiftKey && targetIsStage) {
      stage.draggable(false)
      boxSession.current = {
        startX: (pointer.x - viewportRef.current.x) / viewportRef.current.scale,
        startY: (pointer.y - viewportRef.current.y) / viewportRef.current.scale,
        additive: true,
      }
      setSelectionRect(null)
      return
    }

    if (targetIsStage) {
      panStart.current = {
        pointerX: pointer.x,
        pointerY: pointer.y,
        x: viewportRef.current.x,
        y: viewportRef.current.y,
      }
      panMoved.current = false
    }
  }

  const handleStagePointerMove = () => {
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    if (boxSession.current) {
      const currentX = (pointer.x - viewportRef.current.x) / viewportRef.current.scale
      const currentY = (pointer.y - viewportRef.current.y) / viewportRef.current.scale
      setSelectionRect({
        x: Math.min(boxSession.current.startX, currentX),
        y: Math.min(boxSession.current.startY, currentY),
        w: Math.abs(currentX - boxSession.current.startX),
        h: Math.abs(currentY - boxSession.current.startY),
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
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) session.moving = true
      session.items.forEach((item) => {
        const group = nodeGroupRefs.current.get(item.id)
        if (!group) return
        group.position({ x: item.x + dx, y: item.y + dy })
      })
      // 连线跟随拖动中的节点。
      const stage2 = stageRef.current
      if (stage2) {
        stage2.find('.edge-path').forEach((shape) => {
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

    if (boxSession.current && selectionRect) {
      const ids = nodes
        .filter(
          (node) =>
            node.x + node.w >= selectionRect.x &&
            node.x <= selectionRect.x + selectionRect.w &&
            node.y + node.h >= selectionRect.y &&
            node.y <= selectionRect.y + selectionRect.h,
        )
        .map((node) => node.id)
      onBoxSelect(ids, boxSession.current.additive)
      boxSession.current = null
      setSelectionRect(null)
    }

    if (dragSession.current) {
      const session = dragSession.current
      if (session.moving) {
        const scale = viewportRef.current.scale
        const pointer = stage?.getPointerPosition()
        const dx = pointer ? (pointer.x - session.pointerX) / scale : 0
        const dy = pointer ? (pointer.y - session.pointerY) / scale : 0
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
    stage?.draggable(true)
  }

  /** 空白单击清空选中；拖动画布后的 click 不触发。 */
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
    const labelHeight = compact ? 14 : 30

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
          onActivate(node.id)
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
            y={compact ? 2 : 4}
          />
        ) : icon ? (
          <KonvaImage
            image={icon}
            width={iconSize}
            height={iconSize}
            x={(node.w - iconSize) / 2}
            y={compact ? 2 : 4}
          />
        ) : null}
        <Text
          width={node.w}
          height={labelHeight}
          y={compact ? iconSize + 4 : 4 + iconSize + 2}
          text={node.name}
          fontSize={compact ? 10.5 : 11}
          fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
          fill={text}
          align="center"
          wrap="word"
          ellipsis={!compact}
          lineHeight={1.25}
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

  const minimapLeft = clamp((-viewport.x / viewport.scale / WORLD_W) * 100, 0, 100)
  const minimapTop = clamp((-viewport.y / viewport.scale / WORLD_H) * 100, 0, 100)
  const minimapWidth = clamp((size.width / viewport.scale / WORLD_W) * 100, 2, 100 - minimapLeft)
  const minimapHeight = clamp((size.height / viewport.scale / WORLD_H) * 100, 2, 100 - minimapTop)

  return (
    <div ref={containerRef} className="canvas-board">
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

        <Layer listening={false}>
          <defs />
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
              <Group key={edge.id} listening={false}>
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
        </Layer>
      </Stage>

      {tooltip ? (
        <div className="konva-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div>{tooltip.node.name}</div>
          <div className="tile-tooltip-detail">
            {tooltip.node.path ?? tooltip.node.url ?? tooltip.node.body ?? tooltip.node.subtitle}
          </div>
        </div>
      ) : null}

      <div className="minimap" aria-hidden="true">
        {groups.map((group) => (
          <span
            key={group.id}
            className="minimap-group"
            style={{
              left: `${(group.x / WORLD_W) * 100}%`,
              top: `${(group.y / WORLD_H) * 100}%`,
              width: `${(group.w / WORLD_W) * 100}%`,
              height: `${(group.h / WORLD_H) * 100}%`,
            }}
          />
        ))}
        <span
          className="minimap-viewport"
          style={{
            left: `${minimapLeft}%`,
            top: `${minimapTop}%`,
            width: `${minimapWidth}%`,
            height: `${minimapHeight}%`,
          }}
        />
      </div>
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
