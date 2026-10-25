/**
 * 单个画布对象的图形：图标格、名称、缺失徽标、标注条、四向连线锚点。
 * 任何缩放级别都渲染完整对象，不做远景色点降级；只负责绘制与事件上报。
 */
import { Circle, Group, Image as KonvaImage, Label, Rect, Tag, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { HandleSide, CanvasTokens } from './constants'
import {
  HANDLE_SIDES,
  NAME_LINE_BUDGET,
  NODE_ANNOTATION_HEIGHT,
  NODE_ICON_SIZE,
  NODE_ICON_TOP,
  NODE_LINE_HEIGHT,
} from './constants'
import { annotationTone, handlePoint } from './geometry'
import { displayName } from '@/domain/layout'
import type { SceneAnnotation, SceneNode } from '@/types/scene'

interface NodeShapeProps {
  node: SceneNode
  /** 展示高度：按名称行数与标注自适应，来自 `nodeDisplayHeight`。 */
  height: number
  annotation?: SceneAnnotation
  icon?: HTMLImageElement
  thumb?: HTMLImageElement | null
  selected: boolean
  singleSelected: boolean
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
  height,
  annotation,
  icon,
  thumb,
  selected,
  singleSelected,
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
  const label = displayName(node.name)
  // 名称最多两行；卡片高度已按行数让出空间，不再为标注压缩名称。
  const lines = label.includes('\n')
    ? 2
    : Math.min(2, Math.ceil(Array.from(label).length / NAME_LINE_BUDGET))
  const labelHeight = lines * NODE_LINE_HEIGHT
  const showIcon = Boolean(thumb || icon)
  const iconY = NODE_ICON_TOP
  const labelY = showIcon ? iconY + NODE_ICON_SIZE + 1 : 6
  const showHandles = selected && singleSelected
  const tone = annotation ? annotationTone(tokens.primary) : null

  return (
    <Group
      ref={registerRef}
      x={node.x}
      y={node.y}
      width={node.w}
      height={height}
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
          height={height}
          fill={tokens.selectedBg}
          stroke={tokens.primary}
          strokeWidth={1.5}
          cornerRadius={6}
        />
      ) : null}
      {thumb || icon ? (
        <KonvaImage
          image={(thumb ?? icon) as HTMLImageElement}
          width={NODE_ICON_SIZE}
          height={NODE_ICON_SIZE}
          x={(node.w - NODE_ICON_SIZE) / 2}
          y={iconY}
        />
      ) : null}
      <Text
        width={node.w}
        height={labelHeight}
        y={labelY}
        text={label}
        fontSize={11}
        fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
        fill={tokens.text}
        align="center"
        wrap="word"
        ellipsis
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
        // 标注条骑在下边框上：文字压在框线之上，颜色跟随主题主色。
        <Label
          x={2}
          y={height - NODE_ANNOTATION_HEIGHT + 2}
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
            const point = handlePoint({ w: node.w, h: height }, side)
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
