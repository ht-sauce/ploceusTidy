/**
 * 空间（分组框）图形：彩色实线框 + 命中区域。
 * 颜色来自空间自身的 `color`（缺省回退主题主色），便于区分多个空间。
 * memo 包装：无关重渲染不再重建空间框。
 */
import { memo, useCallback } from 'react'
import { Rect } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasTokens } from './constants'
import { groupTone, mixHex } from './geometry'
import type { SceneGroup } from '@/types/scene'

interface GroupShapeProps {
  group: SceneGroup
  active: boolean
  tokens: CanvasTokens
  /** 稳定的引用注册器：按 id 存取 Konva.Rect，供拖动期直接驱动位置。 */
  registerRef: (id: string, instance: Konva.Rect | null) => void
  onPointerDown: (event: KonvaEventObject<MouseEvent>, groupId: string) => void
  onClick: (event: KonvaEventObject<MouseEvent>, groupId: string) => void
  onContextMenu: (event: KonvaEventObject<MouseEvent>, groupId: string) => void
}

function GroupShape({
  group,
  active,
  tokens,
  registerRef,
  onPointerDown,
  onClick,
  onContextMenu,
}: GroupShapeProps) {
  const color = group.color || tokens.primary
  const tone = groupTone(color)
  const setRef = useCallback(
    (instance: Konva.Rect | null) => registerRef(group.id, instance),
    [group.id, registerRef],
  )

  return (
    <Rect
      ref={setRef}
      x={group.x}
      y={group.y}
      width={group.w}
      height={group.h}
      // 始终铺一层极浅的空间色，多个空间靠颜色即可区分；选中时加深。
      fill={active ? tone.fill : mixHex(color, '#ffffff', 0.94)}
      opacity={active ? 0.9 : 1}
      stroke={color}
      strokeWidth={active ? 2 : 1.6}
      // 选中空间时用空间自身颜色发光，和未选中状态拉开层次。
      shadowColor={color}
      shadowBlur={active ? 16 : 0}
      shadowOpacity={active ? 0.55 : 0}
      cornerRadius={8}
      onMouseDown={(event) => onPointerDown(event, group.id)}
      onClick={(event) => onClick(event, group.id)}
      onContextMenu={(event) => onContextMenu(event, group.id)}
    />
  )
}

export default memo(GroupShape)
