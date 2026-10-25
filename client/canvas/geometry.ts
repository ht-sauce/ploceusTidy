/**
 * 画布纯函数：坐标换算、名称截断、类型色、连线路径。
 * 无 React、无 Konva 实例依赖，便于单测与复用。
 */
import { NAME_LINE_BUDGET, type HandleSide } from './constants'
import type { SceneNode } from '@/types/scene'

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** 锚点相对左上角的偏移；调用方自行叠加基准坐标。 */
export function handlePoint(box: { w: number; h: number }, side: HandleSide) {
  switch (side) {
    case 'top':
      return { x: box.w / 2, y: 0 }
    case 'right':
      return { x: box.w, y: box.h / 2 }
    case 'bottom':
      return { x: box.w / 2, y: box.h }
    default:
      return { x: 0, y: box.h / 2 }
  }
}

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

/** 远景色点颜色：按文件类型区分，与资源管理器语义一致，不随主题变化。 */
export function lodColor(node: SceneNode) {
  switch (node.icon) {
    case 'folder':
      return '#d8b04a'
    case 'pdf':
      return '#b65a53'
    case 'docx':
    case 'dwg':
    case 'link':
      return '#587c9d'
    case 'xlsx':
      return '#5a8065'
    case 'exe':
      return '#6b757d'
    case 'image':
      return '#799683'
    case 'video':
      return '#707982'
    default:
      return '#9a9d97'
  }
}

/** 标注配色：浅底 + 深字，四套浅色主题下都不刺眼，也不与卡片底色冲突。 */
export function annotationTone(color: string) {
  switch (color) {
    case 'amber':
      return { fill: '#F4E7CC', ink: '#8A6420' }
    case 'red':
      return { fill: '#F7E3E2', ink: '#A0443C' }
    case 'blue':
      return { fill: '#E2EAF2', ink: '#3F6285' }
    default:
      return { fill: '#E0EBE7', ink: '#356B5B' }
  }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 连线路径点：[x1, y1, cx1, cy1, cx2, cy2, x2, y2]。
 * 水平距离更大时从左右侧边出发，否则从上下侧边出发，避免线条穿过卡片内容。
 */
export function edgePoints(from: Box, to: Box) {
  const fromX = from.x + from.w / 2
  const fromY = from.y + from.h / 2
  const toX = to.x + to.w / 2
  const toY = to.y + to.h / 2
  const dx = toX - fromX
  const dy = toY - fromY

  if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = dx >= 0 ? from.x + from.w : from.x
    const x2 = dx >= 0 ? to.x : to.x + to.w
    const bend = Math.max(30, Math.min(100, Math.abs(x2 - x1) * 0.34))
    return [
      x1,
      fromY,
      x1 + (dx >= 0 ? bend : -bend),
      fromY,
      x2 - (dx >= 0 ? bend : -bend),
      toY,
      x2,
      toY,
    ]
  }

  const y1 = dy >= 0 ? from.y + from.h : from.y
  const y2 = dy >= 0 ? to.y : to.y + to.h
  const bend = Math.max(28, Math.min(80, Math.abs(y2 - y1) * 0.32))
  return [
    fromX,
    y1,
    fromX,
    y1 + (dy >= 0 ? bend : -bend),
    toX,
    y2 - (dy >= 0 ? bend : -bend),
    toX,
    y2,
  ]
}
