/**
 * 单个画布对象的图形：图标格 / 远景色点、名称、缺失徽标、标注条、四向连线锚点。
 * 只负责绘制与事件上报，不持有场景状态。
 */
import { Circle, Group, Image as KonvaImage, Label, Rect, Tag, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { HandleSide, CanvasTokens } from './constants'
import { HANDLE_SIDES } from './constants'
import { annotationTone, displayName, handlePoint, lodColor } from './geometry'
import type { SceneAnnotation, SceneNode } from '@/types/scene'

interface NodeShapeProps {
  node: SceneNode
  annotation?: SceneAnnotation
  icon?: HTMLImageElement
  thumb?: HTMLImageElement | null
  selected: boolean
  singleSelected: boolean
  lod: boolean
  compact: boolean
  tokens: CanvasTokens
  registerRef: (instance: Konva.Group | null) => void
  onPointerDown: (event: KonvaEventObject<MouseEvent>, node: SceneNode) => void
  onClick: (event: KonvaEventObject<MouseEvent>, node: SceneNode) => void
  onDblClick: (node: SceneNode) => void
  onContextMenu: (event: KonvaEventObject<MouseEvent>, node: SceneNode) => void
  onHoverStart: (node: SceneNode) => void
  onHoverEnd: () => void
  onAnnotation: (annotation: SceneAnnotation) => void
  onHandleDown: (event: KonvaEventObject<MouseEvent>, node: SceneNode, side: HandleSide) => void
}

export default function NodeShape({
  node,
  annotation,
  icon,
  thumb,
  selected,
  singleSelected,
  lod,
  compact,
  tokens,
  registerRef,
  onPointerDown,
  onClick,
  onDblClick,
  onContextMenu,
  onHoverStart,
  onHoverEnd,
  onAnnotation,
  onHandleDown,
}: NodeShapeProps) {
  if (lod) {
    return (
      <Group
        x={node.x}
        y={node.y}
        onClick={(event) => onClick(event, node)}
        onContextMenu={(event) => onContextMenu(event, node)}
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

  const iconSize = compact ? 24 : 32
  // 有标注时名称收成单行，把卡片底边让给标注条。
  const labelHeight = compact ? 14 : annotation ? 15 : 28
  const showIcon = Boolean(thumb || icon)
  // 图标尚未就绪时不能留 38px 空洞，否则名称会跑到选中框外，看起来像选框错位。
  const iconY = compact ? 2 : 3
  const labelY = showIcon ? iconY + iconSize + 1 : compact ? 4 : 6
  const showHandles = selected && singleSelected && !compact
  const tone = annotation ? annotationTone(annotation.color) : null

  return (
    <Group
      ref={registerRef}
      x={node.x}
      y={node.y}
      width={node.w}
      height={node.h}
      onMouseDown={(event) => onPointerDown(event, node)}
      onClick={(event) => onClick(event, node)}
      onDblClick={() => onDblClick(node)}
      onMouseEnter={() => onHoverStart(node)}
      onMouseLeave={onHoverEnd}
      onContextMenu={(event) => onContextMenu(event, node)}
    >
      {selected ? (
        <Rect
          width={node.w}
          height={node.h}
          fill={tokens.selectedBg}
          stroke={tokens.primary}
          strokeWidth={1}
          cornerRadius={6}
        />
      ) : null}
      {thumb || icon ? (
        <KonvaImage
          image={(thumb ?? icon) as HTMLImageElement}
          width={iconSize}
          height={iconSize}
          x={(node.w - iconSize) / 2}
          y={iconY}
        />
      ) : null}
      <Text
        width={node.w}
        height={labelHeight}
        y={labelY}
        text={displayName(node.name)}
        fontSize={compact ? 10.5 : 11}
        fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
        fill={tokens.text}
        align="center"
        wrap="word"
        ellipsis={!compact}
        lineHeight={1.2}
      />
      {!node.isExists ? (
        <Rect width={26} height={13} x={2} y={2} fill={tokens.error} cornerRadius={3} />
      ) : null}
      {!node.isExists ? (
        <Text
          width={26}
          height={13}
          x={2}
          y={2}
          text="缺失"
          fontSize={9}
          fill={tokens.surface}
          align="center"
          listening={false}
        />
      ) : null}
      {annotation && tone ? (
        // 标注条骑在卡片下边框上：文字压在框线之上可见，又不会脱离对象。
        <Label
          x={2}
          y={node.h - 10}
          onClick={(event) => {
            event.cancelBubble = true
            onAnnotation(annotation)
          }}
        >
          <Tag fill={tone.fill} cornerRadius={3} />
          <Text
            text={annotation.text}
            fontSize={9}
            padding={1}
            width={node.w - 4}
            ellipsis
            wrap="none"
            fill={tone.ink}
            fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
          />
        </Label>
      ) : null}
      {showHandles
        ? HANDLE_SIDES.map((side) => {
            const point = handlePoint(node, side)
            return (
              <Circle
                key={`handle-${side}`}
                x={point.x}
                y={point.y}
                radius={3.5}
                fill={tokens.surface}
                stroke={tokens.primary}
                strokeWidth={1.5}
                hitStrokeWidth={10}
                onMouseDown={(event) => onHandleDown(event, node, side)}
              />
            )
          })
        : null}
    </Group>
  )
}
