import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { SceneAnnotation, SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import FileTile from './FileTile'

const WORLD_W = 4000
const WORLD_H = 2900

interface CanvasBoardProps {
  nodes: SceneNode[]
  groups: SceneGroup[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
  selectedIds: string[]
  detailsOpen: boolean
  onSelect: (id: string, additive: boolean) => void
  onBoxSelect: (ids: string[], additive: boolean) => void
  onClearSelection: () => void
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void
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

interface PanSession {
  startX: number
  startY: number
  x: number
  y: number
}

interface DragSession {
  items: { id: string; x: number; y: number }[]
  startX: number
  startY: number
}

interface BoxSession {
  startX: number
  startY: number
  additive: boolean
}

interface SelectionRect {
  x: number
  y: number
  w: number
  h: number
}

interface Viewport {
  x: number
  y: number
  scale: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function edgePath(from: SceneNode, to: SceneNode) {
  const fromX = from.x + from.w / 2
  const fromY = from.y + from.h / 2
  const toX = to.x + to.w / 2
  const toY = to.y + to.h / 2
  const dx = toX - fromX
  const dy = toY - fromY

  if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = dx >= 0 ? from.x + from.w : from.x
    const x2 = dx >= 0 ? to.x : to.x + to.w
    const y1 = fromY
    const y2 = toY
    const bend = Math.max(30, Math.min(100, Math.abs(x2 - x1) * 0.34))
    const c1 = x1 + (dx >= 0 ? bend : -bend)
    const c2 = x2 - (dx >= 0 ? bend : -bend)
    return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`
  }

  const x1 = fromX
  const x2 = toX
  const y1 = dy >= 0 ? from.y + from.h : from.y
  const y2 = dy >= 0 ? to.y : to.y + to.h
  const bend = Math.max(28, Math.min(80, Math.abs(y2 - y1) * 0.32))
  const c1 = y1 + (dy >= 0 ? bend : -bend)
  const c2 = y2 - (dy >= 0 ? bend : -bend)
  return `M ${x1} ${y1} C ${x1} ${c1}, ${x2} ${c2}, ${x2} ${y2}`
}

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

function intersect(node: SceneNode, rect: SelectionRect) {
  return (
    node.x + node.w >= rect.x &&
    node.x <= rect.x + rect.w &&
    node.y + node.h >= rect.y &&
    node.y <= rect.y + rect.h
  )
}

const CanvasBoard = forwardRef<CanvasBoardHandle, CanvasBoardProps>(function CanvasBoard(
  {
    nodes,
    groups,
    edges,
    annotations,
    selectedIds,
    detailsOpen,
    onSelect,
    onBoxSelect,
    onClearSelection,
    onMoveNodes,
    onAnnotation,
    onActivate,
    onScaleChange,
  },
  ref,
) {
  const shellRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1280, height: 720 })
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 0.82 })
  const [panning, setPanning] = useState(false)
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const viewportRef = useRef(viewport)
  const panSession = useRef<PanSession | null>(null)
  const dragSession = useRef<DragSession | null>(null)
  const boxSession = useRef<BoxSession | null>(null)
  const panMoved = useRef(false)
  const pulseTimer = useRef<number | null>(null)

  viewportRef.current = viewport

  useEffect(() => {
    const element = shellRef.current
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

  useEffect(() => {
    return () => {
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current)
    }
  }, [])

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const annotationByNode = useMemo(() => {
    const map = new Map<string, string>()
    annotations.forEach((annotation) => {
      annotation.nodeIds.forEach((nodeId) => {
        if (!map.has(nodeId)) map.set(nodeId, annotation.color)
      })
    })
    return map
  }, [annotations])

  const visibleNodes = useMemo(() => {
    const margin = 180
    const left = -viewport.x / viewport.scale - margin
    const top = -viewport.y / viewport.scale - margin
    const right = left + size.width / viewport.scale + margin * 2
    const bottom = top + size.height / viewport.scale + margin * 2

    return nodes.filter(
      (node) =>
        node.x + node.w >= left && node.x <= right && node.y + node.h >= top && node.y <= bottom,
    )
  }, [nodes, size.height, size.width, viewport])

  const lod = viewport.scale < 0.5

  const visibleEdges = useMemo(() => {
    if (viewport.scale < 0.62 && selectedSet.size === 0) return []
    const visibleIds = new Set(visibleNodes.map((node) => node.id))

    return edges.filter((edge) => {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) return false
      if (selectedSet.size > 0) return selectedSet.has(edge.from) || selectedSet.has(edge.to)
      return visibleIds.has(edge.from) || visibleIds.has(edge.to)
    })
  }, [edges, nodeById, selectedSet, viewport.scale, visibleNodes])

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

  useEffect(() => {
    const element = shellRef.current
    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const factor = event.deltaY > 0 ? 0.9 : 1.1
      zoomAt(
        viewportRef.current.scale * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [zoomAt])

  const toWorld = (clientX: number, clientY: number) => {
    const rect = shellRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const current = viewportRef.current
    return {
      x: (clientX - rect.left - current.x) / current.scale,
      y: (clientY - rect.top - current.y) / current.scale,
    }
  }

  const handleShellPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.file-tile, .lod-dot, .minimap')) return

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    panMoved.current = false

    if (event.shiftKey) {
      const start = toWorld(event.clientX, event.clientY)
      boxSession.current = { startX: start.x, startY: start.y, additive: true }
      setSelectionRect({ x: start.x, y: start.y, w: 0, h: 0 })
    } else {
      panSession.current = {
        startX: event.clientX,
        startY: event.clientY,
        x: viewportRef.current.x,
        y: viewportRef.current.y,
      }
    }

    setPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleShellPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panSession.current) {
      const dx = event.clientX - panSession.current.startX
      const dy = event.clientY - panSession.current.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved.current = true
      setViewport({
        x: panSession.current.x + dx,
        y: panSession.current.y + dy,
        scale: viewportRef.current.scale,
      })
      return
    }

    if (boxSession.current) {
      const current = toWorld(event.clientX, event.clientY)
      const x = Math.min(boxSession.current.startX, current.x)
      const y = Math.min(boxSession.current.startY, current.y)
      const w = Math.abs(current.x - boxSession.current.startX)
      const h = Math.abs(current.y - boxSession.current.startY)
      if (w > 3 || h > 3) panMoved.current = true
      setSelectionRect({ x, y, w, h })
      return
    }

    if (dragSession.current) {
      const dx = (event.clientX - dragSession.current.startX) / viewportRef.current.scale
      const dy = (event.clientY - dragSession.current.startY) / viewportRef.current.scale
      onMoveNodes(
        dragSession.current.items.map((item) => ({
          id: item.id,
          x: Math.round(item.x + dx),
          y: Math.round(item.y + dy),
        })),
      )
    }
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (boxSession.current) {
      const current = toWorld(event.clientX, event.clientY)
      const rect = {
        x: Math.min(boxSession.current.startX, current.x),
        y: Math.min(boxSession.current.startY, current.y),
        w: Math.abs(current.x - boxSession.current.startX),
        h: Math.abs(current.y - boxSession.current.startY),
      }
      const ids = nodes.filter((node) => intersect(node, rect)).map((node) => node.id)
      onBoxSelect(ids, boxSession.current.additive)
      boxSession.current = null
      setSelectionRect(null)
    }

    panSession.current = null
    dragSession.current = null
    setPanning(false)
  }

  const handleShellClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (panMoved.current) {
      panMoved.current = false
      return
    }
    const target = event.target as HTMLElement
    if (target.closest('.file-tile, .lod-dot, .minimap')) return
    onClearSelection()
  }

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.tile-annotation')) return

    const tile = target.closest('.file-tile, .lod-dot') as HTMLElement | null
    if (!tile) return
    const id = tile.dataset.nodeId
    if (!id) return
    const node = nodeById.get(id)
    if (!node) return

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()

    const additive = event.shiftKey || event.ctrlKey || event.metaKey

    if (additive) {
      onSelect(id, true)
      event.stopPropagation()
      return
    }

    if (!selectedSet.has(id)) onSelect(id, false)

    if (!lod) {
      const dragIds = selectedSet.has(id) ? selectedIds : [id]
      dragSession.current = {
        items: dragIds
          .map((nodeId) => nodeById.get(nodeId))
          .filter((item): item is SceneNode => Boolean(item))
          .map((item) => ({ id: item.id, x: item.x, y: item.y })),
        startX: event.clientX,
        startY: event.clientY,
      }
      shellRef.current?.setPointerCapture(event.pointerId)
    }
    event.stopPropagation()
  }

  const handleNodeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.closest('.tile-annotation')) return
    const tile = target.closest('.file-tile') as HTMLElement | null
    const id = tile?.dataset.nodeId
    if (!id) return

    const annotation = annotations.find((item) => item.nodeIds.includes(id))
    if (annotation) onAnnotation(annotation)
    event.stopPropagation()
  }

  const handleNodeDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const tile = target.closest('.file-tile, .lod-dot') as HTMLElement | null
    const id = tile?.dataset.nodeId
    if (!id) return
    onActivate(id)
    event.stopPropagation()
  }

  const minimapLeft = clamp((-viewport.x / viewport.scale / WORLD_W) * 100, 0, 100)
  const minimapTop = clamp((-viewport.y / viewport.scale / WORLD_H) * 100, 0, 100)
  const minimapWidth = clamp((size.width / viewport.scale / WORLD_W) * 100, 2, 100 - minimapLeft)
  const minimapHeight = clamp((size.height / viewport.scale / WORLD_H) * 100, 2, 100 - minimapTop)

  return (
    <div
      ref={shellRef}
      className={`canvas-board${panning ? ' is-panning' : ''}`}
      onPointerDown={handleShellPointerDown}
      onPointerMove={handleShellPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onClick={handleShellClick}
    >
      <div
        className="canvas-world"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        <div className="groups-layer">
          {groups.map((group) => (
            <div
              key={group.id}
              className="group-frame"
              style={{
                left: group.x,
                top: group.y,
                width: group.w,
                height: group.h,
              }}
            >
              <span>{group.title}</span>
            </div>
          ))}
        </div>

        <svg
          className="edge-layer"
          width={WORLD_W}
          height={WORLD_H}
          viewBox={`0 0 ${WORLD_W} ${WORLD_H}`}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="6"
              markerHeight="6"
              refX="5.2"
              refY="3"
              orient="auto"
            >
              <path d="M0 0 L6 3 L0 6 L1.4 3 Z" fill="#a9ada6" />
            </marker>
          </defs>
          {visibleEdges.map((edge) => {
            const from = nodeById.get(edge.from)
            const to = nodeById.get(edge.to)
            if (!from || !to) return null
            return (
              <path
                key={edge.id}
                className="edge-main"
                d={edgePath(from, to)}
                markerEnd="url(#arrowhead)"
              />
            )
          })}
        </svg>

        <div
          className="nodes-layer"
          onPointerDown={handleNodePointerDown}
          onClick={handleNodeClick}
          onDoubleClick={handleNodeDoubleClick}
        >
          {lod
            ? visibleNodes.map((node) => (
                <div
                  key={node.id}
                  className="lod-dot"
                  data-node-id={node.id}
                  style={{
                    left: node.x + 8,
                    top: node.y + 12,
                    background: lodColor(node),
                  }}
                  title={node.name}
                />
              ))
            : visibleNodes.map((node) => (
                <FileTile
                  key={node.id}
                  node={node}
                  selected={selectedSet.has(node.id)}
                  pulse={pulseId === node.id}
                  annotationColor={annotationByNode.get(node.id)}
                  onAnnotation={() => {
                    const annotation = annotations.find((item) => item.nodeIds.includes(node.id))
                    if (annotation) onAnnotation(annotation)
                  }}
                />
              ))}
        </div>

        {selectionRect ? (
          <div
            className="selection-box"
            style={{
              left: selectionRect.x,
              top: selectionRect.y,
              width: selectionRect.w,
              height: selectionRect.h,
            }}
          />
        ) : null}
      </div>

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

CanvasBoard.displayName = 'CanvasBoard'

export default CanvasBoard
