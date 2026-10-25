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
  useMemo,
  useRef,
  useState,
} from 'react'
import Konva from 'konva'
import { Arrow, Circle, Label, Layer, Line, Rect, Stage, Tag, Text } from 'react-konva'
import type { SceneAnnotation, SceneEdge, SceneGroup, SceneNode, ThemeId } from '@/types/scene'
import { themeById } from '@/lib/theme'
import CanvasTextEditor from './CanvasTextEditor'
import EdgeLayer from './EdgeLayer'
import GroupShape from './GroupShape'
import Minimap from './Minimap'
import NodeShape from './NodeShape'
import { MINIMAP_MIN_H, MINIMAP_MIN_W, STAGE_PIXEL_RATIO } from './constants'
import type { CanvasTokens, HandleSide } from './constants'
import { groupTone, handlePoint, nodeDisplayHeight } from './geometry'
import { ICON_IMAGES, THUMB_IMAGES, cssVar, startIconLoad } from './icons'
import type { CanvasContextTarget, CanvasViewport, StageSize } from './types'
import { useCanvasInteractions } from './useCanvasInteractions'
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
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void
  onSelectEdge: (id: string) => void
  onEdgeLabelEdit: (id: string) => void
  onConnect: (from: string, to: string) => void
  onAnnotation: (annotation: SceneAnnotation) => void
  onActivate: (id: string) => void
  onTextCommit: (id: string, text: string, live?: boolean) => void
  onScaleChange: (scale: number) => void
  /** 双击空间标题：进入重命名。 */
  onGroupTitleEdit: (id: string) => void
  /** 右键菜单由工作空间渲染，画布只上报目标与屏幕坐标。 */
  onContextMenu: (target: CanvasContextTarget, clientX: number, clientY: number) => void
  /** 窗口最小化/隐藏时暂停缩略图与脉冲等主动渲染。 */
  paused: boolean
}

export interface CanvasBoardHandle {
  locateNode: (id: string) => void
  /** 定位节点或空间，供连线邻居跳转使用。 */
  locateTarget: (id: string) => void
  /** 定位连线中点，供搜索结果使用。 */
  locateEdge: (id: string) => void
  fitView: () => void
  zoomBy: (factor: number) => void
  getCenterWorld: () => { x: number; y: number }
  editText: (id: string) => void
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
    onMoveNodes,
    onSelectEdge,
    onEdgeLabelEdit,
    onConnect,
    onAnnotation,
    onActivate,
    onTextCommit,
    onScaleChange,
    onGroupTitleEdit,
    onContextMenu,
    paused,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const nodeGroupRefs = useRef(new Map<string, Konva.Group>())
  const ringRefs = useRef(new Map<string, Konva.Rect>())
  const [size, setSize] = useState<StageSize>({ width: 1280, height: 720 })
  // ICON_IMAGES 是模块级缓存，图标解码完成后靠这个版本号触发一次重渲染。
  const [, setIconVersion] = useState(0)

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
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

  useEffect(() => {
    startIconLoad(() => setIconVersion((value) => value + 1))
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
    pulseId,
  } = useCanvasViewport({
    nodes,
    groups,
    nodeById,
    groupById,
    size,
    detailsOpen,
    onScaleChange,
  })

  const { visibleNodes, visibleEdges } = useVisibleScene({
    nodes,
    edges,
    nodeById,
    groupById,
    viewport,
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
      return group ? { x: group.x, y: group.y, w: group.w, h: group.h } : null
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
    viewportRef,
    setViewport,
    zoomAt,
    boxOf,
    nodeRectOf,
    onSelect,
    onBoxSelect,
    onClearSelection,
    onSelectGroup,
    onMoveGroup,
    onMoveNodes,
    onConnect,
    onActivate,
    onContextMenu,
  })

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
      zoomBy,
      getCenterWorld,
      editText: interactions.editText,
    }),
    [fitView, getCenterWorld, interactions.editText, locateEdge, locateTarget, zoomBy],
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
  const theme = themeById(themeId)
  const tokens: CanvasTokens = {
    primary: theme.primary,
    border: theme.border,
    selectedBg: theme.selectedBg,
    surface: theme.surface,
    text: cssVar('--text', '#30343A'),
    textSecondary: cssVar('--text-secondary', '#747A83'),
    error: cssVar('--error', '#C44B52'),
  }

  /**
   * 迷你地图映射范围：只取内容包围盒（无内容时取当前视口）。
   * 若把视口并进来，平移会同时扩大范围，视口框就会始终粘在原地。
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
    return {
      minX: minX - padX,
      minY: minY - padY,
      width: Math.max(MINIMAP_MIN_W, maxX - minX + padX * 2),
      height: Math.max(MINIMAP_MIN_H, maxY - minY + padY * 2),
    }
  }, [groups, nodes, size.height, size.width, viewport])

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

  const editorNode = interactions.editor ? (nodeById.get(interactions.editor) ?? null) : null
  const activeGroup = selectedGroupId ? (groupById.get(selectedGroupId) ?? null) : null

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
      >
        {/* 空间（分组框）：点框内空白即可选中并整体拖动，也可作为连线端点。 */}
        <Layer>
          {groups.map((group) => (
            <GroupShape
              key={group.id}
              group={group}
              active={selectedGroupId === group.id}
              tokens={tokens}
              onPointerDown={interactions.handleGroupBoxDown}
              onClick={interactions.handleGroupClick}
              onContextMenu={interactions.handleGroupContextMenu}
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
            surfaceColor={tokens.surface}
            onSelect={onSelectEdge}
            onLabelEdit={onEdgeLabelEdit}
            onContextMenu={interactions.handleEdgeContextMenu}
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

          {visibleNodes.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              height={nodeDisplayHeight(node, annotationByNode.has(node.id))}
              annotation={annotationByNode.get(node.id)}
              icon={ICON_IMAGES.get(node.icon)}
              thumb={THUMB_IMAGES.get(node.id) ?? null}
              selected={selectedSet.has(node.id)}
              singleSelected={selectedSet.size === 1}
              tokens={tokens}
              registerRef={(instance) => {
                if (instance) nodeGroupRefs.current.set(node.id, instance)
                else nodeGroupRefs.current.delete(node.id)
              }}
              onPointerDown={interactions.handleNodePointerDown}
              onClick={interactions.handleNodeClick}
              onDblClick={interactions.handleNodeDblClick}
              onContextMenu={interactions.handleNodeContextMenu}
              onHoverStart={interactions.handleNodeMouseEnter}
              onHoverEnd={interactions.handleNodeMouseLeave}
              onAnnotation={onAnnotation}
              onHandleDown={interactions.handleHandleDown}
            />
          ))}

          {/* 选中空间时同样给出四向锚点：空间可以和文件一样连线。 */}
          {activeGroup
            ? Array.from({ length: 4 }).map((_, index) => {
                const side = (['top', 'right', 'bottom', 'left'] as HandleSide[])[index]
                const point = handlePoint(activeGroup, side)
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
        </Layer>
      </Stage>

      {editorNode ? (
        <CanvasTextEditor
          node={editorNode}
          viewport={viewport}
          onCommit={onTextCommit}
          onClose={() => interactions.setEditor(null)}
        />
      ) : null}

      {interactions.tooltip ? (
        <div
          className="konva-tooltip"
          style={{ left: interactions.tooltip.x, top: interactions.tooltip.y }}
        >
          <div>{interactions.tooltip.node.name}</div>
          <div className="tile-tooltip-detail">
            {interactions.tooltip.node.path ??
              interactions.tooltip.node.url ??
              interactions.tooltip.node.body ??
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
          onMoveTo={moveViewportTo}
        />
      ) : null}
    </div>
  )
})

CanvasBoard.displayName = 'CanvasBoard'

export default CanvasBoard
