/**
 * 连线图层：有向箭头、连线标签、端点拖拽手柄与右键。
 *
 * 整层压在空间与元素之下（世界 z 序最底层）：线条被卡片盖住是预期效果，
 * 因此不做避障寻路，只需两端锚点之间一条贝塞尔——省掉每条线的网格搜索。
 * 端点既可以是节点，也可以是空间，尺寸由调用方通过 `boxOf` 解析。
 * memo 包装：选中/平移等无关重渲染不再逐条 diff 箭头（万级连线时这是主要卡点）。
 */
import { memo } from 'react'
import { Arrow, Circle, Group, Label, Tag, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasTokens } from './constants'
import { asHandleSide, edgeColorOf, edgePoints } from './geometry'
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
        const points = edgePoints(
          from,
          to,
          asHandleSide(edge.fromHandle),
          asHandleSide(edge.toHandle),
        )
        const start = { x: points[0], y: points[1] }
        const end = { x: points[6], y: points[7] }
        // 标签停在两端锚点中点：路径是左右对称的贝塞尔，视觉中点与它基本重合。
        const midX = (start.x + end.x) / 2
        const midY = (start.y + end.y) / 2
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
                  x={start.x}
                  y={start.y}
                  radius={5}
                  fill={surfaceColor}
                  stroke={color}
                  strokeWidth={2}
                  hitStrokeWidth={16}
                  onMouseDown={(event) => onHandleDown(event, edge, 'from')}
                />
                <Circle
                  x={end.x}
                  y={end.y}
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
