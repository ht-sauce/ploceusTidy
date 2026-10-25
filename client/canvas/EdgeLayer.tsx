/**
 * 连线图层：有向箭头、连线标签、连线选中与右键。
 * 端点既可以是节点，也可以是空间，尺寸由调用方通过 `boxOf` 解析。
 */
import { Arrow, Group, Label, Tag, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasTokens } from './constants'
import { edgePoints } from './geometry'
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
        const points = edgePoints(from, to)
        const midX = (points[0] + points[6]) / 2
        const midY = (points[1] + points[7]) / 2
        const active = edge.id === selectedEdgeId
        return (
          <Group key={edge.id}>
            <Arrow
              name="edge-path"
              edgeId={edge.id}
              points={points}
              bezier
              stroke={active ? tokens.primary : tokens.textSecondary}
              fill={active ? tokens.primary : tokens.textSecondary}
              strokeWidth={active ? 2.6 : 1.8}
              hitStrokeWidth={14}
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
