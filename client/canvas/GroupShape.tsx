/**
 * 空间（分组框）图形：明亮虚线框 + 命中区域。
 * 颜色来自空间自身的 `color`（缺省回退主题主色），便于区分多个空间。
 */
import { Rect } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasTokens } from './constants'
import { groupTone, mixHex } from './geometry'
import type { SceneGroup } from '@/types/scene'

interface GroupShapeProps {
  group: SceneGroup
  active: boolean
  tokens: CanvasTokens
  onPointerDown: (event: KonvaEventObject<MouseEvent>, groupId: string) => void
  onClick: (event: KonvaEventObject<MouseEvent>, groupId: string) => void
  onContextMenu: (event: KonvaEventObject<MouseEvent>, groupId: string) => void
}

export default function GroupShape({
  group,
  active,
  tokens,
  onPointerDown,
  onClick,
  onContextMenu,
}: GroupShapeProps) {
  const color = group.color || tokens.primary
  const tone = groupTone(color)

  return (
    <Rect
      x={group.x}
      y={group.y}
      width={group.w}
      height={group.h}
      // 始终铺一层极浅的空间色，多个空间靠颜色即可区分；选中时加深。
      fill={active ? tone.fill : mixHex(color, '#ffffff', 0.94)}
      opacity={active ? 0.9 : 1}
      stroke={color}
      strokeWidth={active ? 2 : 1.6}
      dash={[6, 4]}
      cornerRadius={8}
      onMouseDown={(event) => onPointerDown(event, group.id)}
      onClick={(event) => onClick(event, group.id)}
      onContextMenu={(event) => onContextMenu(event, group.id)}
    />
  )
}
