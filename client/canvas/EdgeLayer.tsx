/**
 * 连线图层：有向箭头、避障路径、连线标签、端点拖拽手柄与右键。
 * 端点既可以是节点，也可以是空间，尺寸由调用方通过 `boxOf` 解析；
 * 障碍框由调用方通过 `obstaclesNear` 提供（rbush 查询），直线段被挡住时绕行。
 * memo 包装：选中/平移等无关重渲染不再逐条 diff 箭头（万级连线时这是主要卡点）。
 */
import { memo } from 'react'
import { Arrow, Circle, Group, Label, Tag, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasTokens } from './constants'
import { asHandleSide, edgeColorOf, routeEdgePath } from './geometry'
import type { SceneEdge } from '@/types/scene'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface EdgeLayerProps {
  edges: SceneEdge[]
  selectedEdgeId: string | null
  tokens: CanvasTokens
  boxOf: (id: string) => Box | null
  /** 避障障碍查询：返回与查询矩形相交的对象/空间展示框（不含两端自身）。 */
  obstaclesNear: (rect: Box, excludeIds: Set<string>) => Box[]
  surfaceColor: string
  /** 注册箭头图形引用：拖动期由交互层直接更新受影响连线的几何。 */
  registerRef: (id: string, instance: Konva.Arrow | null) => void
  onSelect: (id: string) => void
  onLabelEdit: (id: string) => void
  onContextMenu: (event: KonvaEventObject<MouseEvent>, id: string) => void
  /** 端点手柄按下：开启改接会话。 */
  onHandleDown: (event: KonvaEventObject<MouseEvent>, edge: SceneEdge, end: 'from' | 'to') => void
}

function EdgeLayer({
  edges,
  selectedEdgeId,
  tokens,
  boxOf,
  obstaclesNear,
  surfaceColor,
  registerRef,
  onSelect,
  onLabelEdit,
  onContextMenu,
  onHandleDown,
}: EdgeLayerProps) {
  return (
    <>
      {edges.map((edge) => {
        const from = boxOf(edge.from)
        const to = boxOf(edge.to)
        if (!from || !to) return null
        // 避障路由：直线段不穿障碍时保持原贝塞尔，被挡住时绕行并平滑。
        const excludeIds = new Set([edge.from, edge.to])
        const minX = Math.min(from.x, to.x)
        const minY = Math.min(from.y, to.y)
        const route = routeEdgePath(
          from,
          to,
          asHandleSide(edge.fromHandle),
          asHandleSide(edge.toHandle),
          obstaclesNear(
            {
              x: minX,
              y: minY,
              w: Math.max(from.x + from.w, to.x + to.w) - minX,
              h: Math.max(from.y + from.h, to.y + to.h) - minY,
            },
            excludeIds,
          ),
        )
        const points = route.points
        // 标签跟随路径中段：避障时取路标链中点，直连时取两端锚点中点。
        const midWaypoint = route.waypoints
          ? route.waypoints[Math.floor(route.waypoints.length / 2)]
          : null
        const midX = midWaypoint ? midWaypoint.x : (route.start.x + route.end.x) / 2
        const midY = midWaypoint ? midWaypoint.y : (route.start.y + route.end.y) / 2
        const active = edge.id === selectedEdgeId
        // 连线颜色可由用户取色；未设置时跟随主题主色，保证在浅色背景上足够明显。
        const color = edgeColorOf(edge, tokens.primary)
        return (
          <Group key={edge.id}>
            <Arrow
              ref={(instance) => registerRef(edge.id, instance)}
              name="edge-path"
              edgeId={edge.id}
              points={points}
              bezier
              stroke={color}
              fill={color}
              strokeWidth={active ? 3 : 2.2}
              dash={[8, 5]}
              // 选中时用主题色/自定义色的边缘发光提示，比单纯加粗更醒目。
              shadowColor={color}
              shadowBlur={active ? 14 : 0}
              shadowOpacity={active ? 0.65 : 0}
              hitStrokeWidth={16}
              onClick={(event) => {
                event.cancelBubble = true
                onSelect(edge.id)
              }}
              onDblClick={(event) => {
                event.cancelBubble = true
                onLabelEdit(edge.id)
              }}
              onContextMenu={(event) => onContextMenu(event, edge.id)}
            />
            {active ? (
              <>
                <Circle
                  x={route.start.x}
                  y={route.start.y}
                  radius={5}
                  fill={surfaceColor}
                  stroke={color}
                  strokeWidth={2}
                  hitStrokeWidth={16}
                  onMouseDown={(event) => onHandleDown(event, edge, 'from')}
                />
                <Circle
                  x={route.end.x}
                  y={route.end.y}
                  radius={5}
                  fill={surfaceColor}
                  stroke={color}
                  strokeWidth={2}
                  hitStrokeWidth={16}
                  onMouseDown={(event) => onHandleDown(event, edge, 'to')}
                />
              </>
            ) : null}
            {edge.label ? (
              <Label x={midX} y={midY} listening={false}>
                <Tag fill={surfaceColor} stroke={tokens.border} cornerRadius={3} />
                <Text
                  text={edge.label}
                  fontSize={11}
                  padding={3}
                  fill={tokens.text}
                  fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
                />
              </Label>
            ) : null}
          </Group>
        )
      })}
    </>
  )
}

export default memo(EdgeLayer)
