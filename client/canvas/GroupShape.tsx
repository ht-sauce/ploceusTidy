/**
 * 空间（分组框）图形：虚线框 + 命中区域。
 * 点击框内空白即选中并整体拖动；选中态用主题底色提示。
 */
import { Rect } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasTokens } from './constants'
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
  return (
    <Rect
      x={group.x}
      y={group.y}
      width={group.w}
      height={group.h}
      // 透明填充仍然参与命中，保证框内空白可点。
      fill={active ? tokens.selectedBg : 'rgba(0,0,0,0.001)'}
      opacity={active ? 0.55 : 1}
      stroke={active ? tokens.primary : tokens.border}
      strokeWidth={active ? 1.5 : 1}
      dash={[4, 4]}
      cornerRadius={8}
      onMouseDown={(event) => onPointerDown(event, group.id)}
      onClick={(event) => onClick(event, group.id)}
      onContextMenu={(event) => onContextMenu(event, group.id)}
    />
  )
}
