/**
 * 单个画布对象的图形：图标格、名称、缺失徽标、标注条、四向连线锚点。
 * 任何缩放级别都渲染完整对象，不做远景色点降级；只负责绘制与事件上报。
 * memo 包装：选中/平移等无关重渲染只影响真正变化的卡片。
 */
import { memo, useCallback } from 'react'
import { Circle, Group, Image as KonvaImage, Label, Rect, Tag, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { HandleSide, CanvasTokens } from './constants'
import {
  HANDLE_SIDES,
  NAME_LINE_BUDGET,
  NODE_ANNOTATION_INSET,
  NODE_ICON_SIZE,
  NODE_ICON_TOP,
  NODE_LINE_HEIGHT,
  NODE_NAME_FONT_SIZE,
} from './constants'
import { annotationTone, handlePoint } from './geometry'
import { displayName } from '@/domain/layout'
import type { SceneAnnotation, SceneNode } from '@/types/scene'

interface NodeShapeProps {
  node: SceneNode
  /** 展示高度：按名称行数与标注自适应，来自 `nodeDisplayHeight`。 */
  height: number
  annotation?: SceneAnnotation
  /** 同一对象被多少条额外标注覆盖：名称后加「+N」，提示还有别的标注。 */
  extraAnnotations?: number
  /** 扩展样式里的描边色（`dataJson.accent`）；缺失时用主题描边。 */
  accent?: string
  icon?: HTMLImageElement
  thumb?: HTMLImageElement | null
  selected: boolean
  singleSelected: boolean
  tokens: CanvasTokens
  /** 稳定的引用注册器：按 id 存取 Konva.Group，供拖动期直接驱动位置。 */
  registerRef: (id: string, instance: Konva.Group | null) => void
  onPointerDown: (event: KonvaEventObject<MouseEvent>, node: SceneNode) => void
  onClick: (event: KonvaEventObject<MouseEvent>, node: SceneNode) => void
  onDblClick: (node: SceneNode) => void
  onContextMenu: (event: KonvaEventObject<MouseEvent>, node: SceneNode) => void
  onHoverStart: (node: SceneNode) => void
  onHoverEnd: () => void
  onAnnotation: (annotation: SceneAnnotation) => void
  onHandleDown: (event: KonvaEventObject<MouseEvent>, node: SceneNode, side: HandleSide) => void
}

function NodeShape({
  node,
  height,
  annotation,
  extraAnnotations = 0,
  accent,
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
  // 引用注册回调按节点 id 稳定，memo 不会因 ref 变化而失效。
  const setRef = useCallback(
    (instance: Konva.Group | null) => registerRef(node.id, instance),
    [node.id, registerRef],
  )

  return (
    <Group
      ref={setRef}
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
      {/*
        卡片底：不透明，且作为整块命中区。
        - 没有它时只有图标与文字可点，卡片的空白处会穿透到背后的连线，
          结果是「点元素却选中了连线」，随后 G 键因为选中集里没有元素而不生效；
        - 连线层在元素之下，靠这层底色才真正被挡住，否则虚线会从卡片里透出来。
      */}
      <Rect width={node.w} height={height} fill={tokens.surface} cornerRadius={6} />
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
      {accent ? (
        // 扩展样式 `{"accent":"#..."}`：给卡片加一圈用户自定义的描边，不参与命中。
        <Rect
          width={node.w}
          height={height}
          stroke={accent}
          strokeWidth={2}
          cornerRadius={6}
          listening={false}
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
        fontSize={NODE_NAME_FONT_SIZE}
        fontFamily='"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
        fill={tokens.text}
        align="center"
        wrap="word"
        ellipsis
        lineHeight={1.15}
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
        // 标注条独占卡片底部让出的区域：不再压在下边框线上，底部留出呼吸间距。
        <Label
          x={3}
          y={height - NODE_ANNOTATION_INSET}
          onClick={(event) => {
            event.cancelBubble = true
            onAnnotation(annotation)
          }}
        >
          <Tag fill={tone.fill} cornerRadius={3} />
          <Text
            text={
              extraAnnotations > 0 ? `${annotation.text} +${extraAnnotations}` : annotation.text
            }
            fontSize={10}
            padding={1}
            width={node.w - 8}
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

export default memo(NodeShape)
