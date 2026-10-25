/**
 * 画布纯函数：坐标换算、名称截断、类型色、连线路径。
 * 无 React、无 Konva 实例依赖，便于单测与复用。
 */
import type { HandleSide } from './constants'
import type { SceneEdge } from '@/types/scene'

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

/** #RGB / #RRGGBB 解析；非法值回退到 fallback。 */
function parseHex(value: string, fallback: [number, number, number]) {
  const raw = value.trim().replace('#', '')
  if (raw.length === 3) {
    const r = Number.parseInt(raw[0] + raw[0], 16)
    const g = Number.parseInt(raw[1] + raw[1], 16)
    const b = Number.parseInt(raw[2] + raw[2], 16)
    return Number.isNaN(r + g + b) ? fallback : [r, g, b]
  }
  if (raw.length === 6) {
    const r = Number.parseInt(raw.slice(0, 2), 16)
    const g = Number.parseInt(raw.slice(2, 4), 16)
    const b = Number.parseInt(raw.slice(4, 6), 16)
    return Number.isNaN(r + g + b) ? fallback : [r, g, b]
  }
  return fallback
}

/** 两个颜色按比例混合，`ratio` 为第二个颜色的占比（0–1）。 */
export function mixHex(base: string, target: string, ratio: number) {
  const [r1, g1, b1] = parseHex(base, [0, 0, 0])
  const [r2, g2, b2] = parseHex(target, [255, 255, 255])
  const mix = (a: number, b: number) => Math.round(a + (b - a) * ratio)
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

/** 空间相关的浅色底与深色字，都从空间主色派生。 */
export function groupTone(color: string) {
  return { fill: mixHex(color, '#ffffff', 0.88), ink: mixHex(color, '#000000', 0.12) }
}

/** 标注文字牌跟随主题主色：浅底深字，换主题即换色。 */
export function annotationTone(primary: string) {
  return { fill: mixHex(primary, '#ffffff', 0.86), ink: mixHex(primary, '#000000', 0.18) }
}

/** 连线颜色存在 `styleJson` 里，缺省回退主题主色。 */
export function edgeColorOf(edge: SceneEdge, fallback: string) {
  if (!edge.styleJson) return fallback
  try {
    const parsed = JSON.parse(edge.styleJson) as { color?: unknown }
    return typeof parsed.color === 'string' && parsed.color ? parsed.color : fallback
  } catch {
    return fallback
  }
}

/** 保留已有样式字段，只更新颜色。 */
export function withEdgeColor(styleJson: string | undefined, color: string) {
  let base: Record<string, unknown> = {}
  if (styleJson) {
    try {
      const parsed = JSON.parse(styleJson) as unknown
      if (parsed && typeof parsed === 'object') base = parsed as Record<string, unknown>
    } catch {
      base = {}
    }
  }
  return JSON.stringify({ ...base, color })
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 把持久化的锚点字符串收敛成合法侧边；非法/空值返回 null（按方位自动路由）。 */
export function asHandleSide(value: string | undefined | null): HandleSide | null {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
    ? value
    : null
}

/**
 * 连线路径点：[x1, y1, cx1, cy1, cx2, cy2, x2, y2]。
 * 端点锚点显式给定时从对应侧边中点出发；否则按方位自动选边，避免线条穿过卡片内容。
 */
export function edgePoints(
  from: Box,
  to: Box,
  fromSide: HandleSide | null = null,
  toSide: HandleSide | null = null,
) {
  const fromX = from.x + from.w / 2
  const fromY = from.y + from.h / 2
  const toX = to.x + to.w / 2
  const toY = to.y + to.h / 2
  const dx = toX - fromX
  const dy = toY - fromY

  const start =
    fromSide ??
    (Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top')
  const end =
    toSide ??
    (Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'left' : 'right') : dy >= 0 ? 'top' : 'bottom')

  const startPoint = handlePoint(from, start)
  const endPoint = handlePoint(to, end)
  const x1 = from.x + startPoint.x
  const y1 = from.y + startPoint.y
  const x2 = to.x + endPoint.x
  const y2 = to.y + endPoint.y

  if (Math.abs(dx) >= Math.abs(dy)) {
    const bend = Math.max(30, Math.min(100, Math.abs(x2 - x1) * 0.34))
    return [x1, y1, x1 + (dx >= 0 ? bend : -bend), y1, x2 - (dx >= 0 ? bend : -bend), y2, x2, y2]
  }

  const bend = Math.max(28, Math.min(80, Math.abs(y2 - y1) * 0.32))
  return [x1, y1, x1, y1 + (dy >= 0 ? bend : -bend), x2, y2 - (dy >= 0 ? bend : -bend), x2, y2]
}
