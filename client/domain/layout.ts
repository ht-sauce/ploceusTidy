/**
 * 画布布局领域纯函数：矩形碰撞、拖动吸附、空位查找、空间自动整理与展示尺寸。
 * 坐标均为世界坐标；所有函数只读入参，不修改节点对象。
 * 尺寸常量来自画布规格（`canvas/constants`），布局与渲染共用同一套数值。
 */
import {
  NAME_LINE_BUDGET,
  NODE_ANNOTATION_HEIGHT,
  NODE_ICON_SIZE,
  NODE_ICON_TOP,
  NODE_LINE_HEIGHT,
  NODE_PADDING_BOTTOM,
} from '@/canvas/constants'
import type { SceneGroup, SceneNode } from '@/types/scene'

/** 世界坐标矩形：布局碰撞、吸附与自动整理共用。 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 对象之间保留的最小间距；与导入网格的 8px 间距保持一致。 */
export const LAYOUT_GAP = 8
/** 拖动吸附阈值（屏幕 px，除以缩放折算为世界坐标）。 */
export const SNAP_THRESHOLD = 6
/** 新建对象避让时的搜索步长，与 72×64 图标格 + 8px 间距一致。 */
const PLACE_STEP_X = 80
const PLACE_STEP_Y = 72
/** 空间标题区高度与内边距，自动整理时按同一套尺度排版。 */
const GROUP_HEADER = 32
const GROUP_PADDING = 16

/**
 * 展示名：图标格只有两行，后缀必须出现——同名不同后缀的文件功能完全不同。
 * 两行放得下就交给 Konva 自动换行；放不下时主体截断放第一行，后缀单独第二行。
 */
export function displayName(name: string) {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && dot < name.length - 1
  if (name.length <= NAME_LINE_BUDGET * 2) return name
  if (!hasExt) return `${name.slice(0, NAME_LINE_BUDGET * 2 - 1)}…`
  const base = name.slice(0, dot)
  const ext = name.slice(dot)
  const extLine =
    ext.length > NAME_LINE_BUDGET * 2 ? `${ext.slice(0, NAME_LINE_BUDGET * 2 - 1)}…` : ext
  return `${base.slice(0, NAME_LINE_BUDGET - 1)}…\n${extLine}`
}

/**
 * 卡片展示高度：按名称行数自适应（最多两行），有标注时再让出一条标注高度。
 * 不改变持久化尺寸，只影响渲染与命中框。
 */
export function nodeDisplayHeight(node: SceneNode, hasAnnotation = false) {
  const name = displayName(node.name)
  const lines = name.includes('\n')
    ? 2
    : Math.min(2, Math.ceil(Array.from(name).length / NAME_LINE_BUDGET))
  return (
    NODE_ICON_TOP +
    NODE_ICON_SIZE +
    1 +
    lines * NODE_LINE_HEIGHT +
    NODE_PADDING_BOTTOM +
    (hasAnnotation ? NODE_ANNOTATION_HEIGHT : 0)
  )
}

/** 两个矩形是否相交；`gap` 为额外要求的间距，0 表示只要求不重叠。 */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
  )
}

function boundsOf(rects: Rect[]) {
  return rects.reduce(
    (result, rect) => ({
      minX: Math.min(result.minX, rect.x),
      minY: Math.min(result.minY, rect.y),
      maxX: Math.max(result.maxX, rect.x + rect.w),
      maxY: Math.max(result.maxY, rect.y + rect.h),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  )
}

/** 一组矩形整体平移后是否与障碍物相交。 */
function collides(moving: Rect[], obstacles: Rect[], dx: number, dy: number, gap: number) {
  return obstacles.some((obstacle) =>
    moving.some((rect) =>
      rectsOverlap({ x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h }, obstacle, gap),
    ),
  )
}

export interface SnapGuides {
  vertical: number[]
  horizontal: number[]
}

const EMPTY_GUIDES: SnapGuides = { vertical: [], horizontal: [] }

/**
 * 对齐吸附：把移动集合的左边/中心/右边与目标集合的同名边线对齐。
 * 返回吸附后的偏移与需要绘制的参考线；参考线取目标对象上真正对齐的坐标。
 */
export function snapOffset(
  moving: Rect[],
  targets: Rect[],
  dx: number,
  dy: number,
  threshold = SNAP_THRESHOLD,
) {
  if (moving.length === 0 || targets.length === 0) {
    return { dx, dy, guides: EMPTY_GUIDES }
  }
  const movingBounds = boundsOf(moving)
  const left = movingBounds.minX + dx
  const centerX = (movingBounds.minX + movingBounds.maxX) / 2 + dx
  const right = movingBounds.maxX + dx
  const top = movingBounds.minY + dy
  const centerY = (movingBounds.minY + movingBounds.maxY) / 2 + dy
  const bottom = movingBounds.maxY + dy

  let bestX = threshold + 1
  let snappedX = dx
  const vertical: number[] = []
  let bestY = threshold + 1
  let snappedY = dy
  const horizontal: number[] = []

  targets.forEach((target) => {
    const linesX = [target.x, target.x + target.w / 2, target.x + target.w]
    const linesY = [target.y, target.y + target.h / 2, target.y + target.h]
    ;[left, centerX, right].forEach((edge) => {
      linesX.forEach((line) => {
        const distance = line - edge
        if (Math.abs(distance) <= threshold && Math.abs(distance) < Math.abs(bestX)) {
          bestX = distance
          snappedX = dx + distance
        }
      })
    })
    ;[top, centerY, bottom].forEach((edge) => {
      linesY.forEach((line) => {
        const distance = line - edge
        if (Math.abs(distance) <= threshold && Math.abs(distance) < Math.abs(bestY)) {
          bestY = distance
          snappedY = dy + distance
        }
      })
    })
  })

  // 吸附后再收集所有真正重合的边线，供画布画参考线。
  const snappedLeft = left + (snappedX - dx)
  const snappedCenterX = centerX + (snappedX - dx)
  const snappedRight = right + (snappedX - dx)
  const snappedTop = top + (snappedY - dy)
  const snappedCenterY = centerY + (snappedY - dy)
  const snappedBottom = bottom + (snappedY - dy)
  targets.forEach((target) => {
    const linesX = [target.x, target.x + target.w / 2, target.x + target.w]
    const linesY = [target.y, target.y + target.h / 2, target.y + target.h]
    ;[snappedLeft, snappedCenterX, snappedRight].forEach((edge) => {
      linesX.forEach((line) => {
        if (Math.abs(line - edge) < 0.5) vertical.push(line)
      })
    })
    ;[snappedTop, snappedCenterY, snappedBottom].forEach((edge) => {
      linesY.forEach((line) => {
        if (Math.abs(line - edge) < 0.5) horizontal.push(line)
      })
    })
  })

  return {
    dx: Math.abs(bestX) <= threshold ? snappedX : dx,
    dy: Math.abs(bestY) <= threshold ? snappedY : dy,
    guides: {
      vertical: Array.from(new Set(vertical.map((value) => Math.round(value * 10) / 10))),
      horizontal: Array.from(new Set(horizontal.map((value) => Math.round(value * 10) / 10))),
    },
  }
}

/**
 * 在目标附近螺旋搜索一个不冲突的整体偏移，用于新建对象避让。
 * 只平移整簇对象，保持导入时生成的相对网格不变。
 */
export function findFreeOffset(
  moving: Rect[],
  obstacles: Rect[],
  gap = LAYOUT_GAP,
  rings = 12,
  stepX = PLACE_STEP_X,
  stepY = PLACE_STEP_Y,
) {
  if (moving.length === 0 || obstacles.length === 0) return { dx: 0, dy: 0 }
  if (!collides(moving, obstacles, 0, 0, gap)) return { dx: 0, dy: 0 }
  const candidates: { dx: number; dy: number; distance: number }[] = []
  for (let row = -rings; row <= rings; row += 1) {
    for (let col = -rings; col <= rings; col += 1) {
      if (row === 0 && col === 0) continue
      candidates.push({
        dx: col * stepX,
        dy: row * stepY,
        distance: (col * stepX) ** 2 + (row * stepY) ** 2,
      })
    }
  }
  candidates.sort((left, right) => left.distance - right.distance)
  const hit = candidates.find((item) => !collides(moving, obstacles, item.dx, item.dy, gap))
  return hit ? { dx: hit.dx, dy: hit.dy } : { dx: 0, dy: 0 }
}

/** 节点矩形：高度按名称行数与标注自适应，和画布命中框一致。 */
export function nodeRect(node: SceneNode, hasAnnotation: boolean): Rect {
  return { x: node.x, y: node.y, w: node.w, h: nodeDisplayHeight(node, hasAnnotation) }
}

/**
 * 空间随成员自动扩缩：按成员展示矩形的包围盒 + 既定留白反推空间框，
 * 与 `arrangeGroupMembers` 使用同一套尺度（顶部标题区 + 四周内边距）。
 * 成员变化（拖入/拖出/删除/标注改变高度）后调用；空空间返回 null，保持现状作为可拖入的容器。
 */
export function fitGroupToMembers(
  members: SceneNode[],
  hasAnnotation: (node: SceneNode) => boolean = () => false,
): Rect | null {
  if (members.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  members.forEach((node) => {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.w)
    maxY = Math.max(maxY, node.y + nodeDisplayHeight(node, hasAnnotation(node)))
  })
  const x = minX - GROUP_PADDING
  const y = minY - GROUP_HEADER
  return { x, y, w: maxX + GROUP_PADDING - x, h: maxY + GROUP_PADDING - y }
}

export interface ArrangeResult {
  positions: { id: string; x: number; y: number }[]
  width: number
  height: number
}

/**
 * 空间内自动整理：保持当前阅读顺序（先上后下、先左后右），按空间宽度排成等间距网格。
 * 返回新坐标与内容所需尺寸；空间框的最终位置由调用方按碰撞结果决定。
 */
export function arrangeGroupMembers(
  members: SceneNode[],
  group: SceneGroup,
  gap = LAYOUT_GAP,
  hasAnnotation: (node: SceneNode) => boolean = () => false,
): ArrangeResult {
  const ordered = [...members].sort((left, right) => left.y - right.y || left.x - right.x)
  if (ordered.length === 0) {
    return { positions: [], width: group.w, height: group.h }
  }
  const cellWidth = Math.max(...ordered.map((node) => node.w))
  const usable = Math.max(cellWidth, group.w - GROUP_PADDING * 2)
  const columns = Math.max(
    1,
    Math.min(ordered.length, Math.floor((usable + gap) / (cellWidth + gap))),
  )
  const positions: { id: string; x: number; y: number }[] = []
  let rowTop = group.y + GROUP_HEADER
  let rowHeight = 0
  let maxRight = group.x + GROUP_PADDING
  ordered.forEach((node, index) => {
    const column = index % columns
    if (index > 0 && column === 0) {
      rowTop += rowHeight + gap
      rowHeight = 0
    }
    const x = group.x + GROUP_PADDING + column * (cellWidth + gap)
    const height = nodeDisplayHeight(node, hasAnnotation(node))
    positions.push({ id: node.id, x, y: rowTop })
    rowHeight = Math.max(rowHeight, height)
    maxRight = Math.max(maxRight, x + node.w)
  })
  // 空间按内容收高、收窄，不保留多余空白。
  const width = Math.max(cellWidth + GROUP_PADDING * 2, maxRight - group.x + GROUP_PADDING)
  const height = rowTop + rowHeight + GROUP_PADDING - group.y
  return { positions, width, height }
}
