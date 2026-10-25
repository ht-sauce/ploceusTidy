/**
 * 连线图层：有向箭头、连线标签、连线选中与右键。
 * 端点既可以是节点，也可以是空间，尺寸由调用方通过 `boxOf` 解析。
 */
import { Arrow, Group, Label, Tag, Text } from 'react-konva'
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
  onSelect: (id: string) => void
  onLabelEdit: (id: string) => void
  onContextMenu: (event: KonvaEventObject<MouseEvent>, id: string) => void
}

export default function EdgeLayer({
  edges,
  selectedEdgeId,
  tokens,
  boxOf,
  surfaceColor,
  onSelect,
  onLabelEdit,
  onContextMenu,
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
        const midX = (points[0] + points[6]) / 2
        const midY = (points[1] + points[7]) / 2
        const active = edge.id === selectedEdgeId
        // 连线颜色可由用户取色；未设置时跟随主题主色，保证在浅色背景上足够明显。
        const color = edgeColorOf(edge, tokens.primary)
        return (
          <Group key={edge.id}>
            <Arrow
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
