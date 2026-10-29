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

export interface Box {
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

export interface RoutePoint {
  x: number
  y: number
}

/** 线段与矩形是否相交（Liang-Barsky 裁剪）。 */
export function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: Box,
): boolean {
  const dx = x2 - x1
  const dy = y2 - y1
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return (
    clip(-dx, x1 - rect.x) &&
    clip(dx, rect.x + rect.w - x1) &&
    clip(-dy, y1 - rect.y) &&
    clip(dy, rect.y + rect.h - y1) &&
    t0 <= t1
  )
}

/** 避障搜索参数：网格步长、障碍外扩、网格规模上限。 */
const ROUTE_CELL = 24
const ROUTE_PAD = 12
const ROUTE_MAX_CELLS = 60000

/**
 * 粗网格 A*：端点与障碍的包络盒上铺 24px 网格，障碍外扩 ROUTE_PAD 后按格标记，
 * 8 方向搜索（禁止斜穿对角缝隙），回溯出世界坐标路标链；失败或规模超限返回 null。
 */
function astarWaypoints(start: RoutePoint, end: RoutePoint, obstacles: Box[]): RoutePoint[] | null {
  const rects = obstacles.map((o) => ({
    x: o.x - ROUTE_PAD,
    y: o.y - ROUTE_PAD,
    w: o.w + ROUTE_PAD * 2,
    h: o.h + ROUTE_PAD * 2,
  }))
  let minX = Math.min(start.x, end.x)
  let minY = Math.min(start.y, end.y)
  let maxX = Math.max(start.x, end.x)
  let maxY = Math.max(start.y, end.y)
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  minX -= ROUTE_CELL
  minY -= ROUTE_CELL
  maxX += ROUTE_CELL
  maxY += ROUTE_CELL
  const cols = Math.max(1, Math.ceil((maxX - minX) / ROUTE_CELL))
  const rows = Math.max(1, Math.ceil((maxY - minY) / ROUTE_CELL))
  if (cols * rows > ROUTE_MAX_CELLS) return null

  const blocked = new Uint8Array(cols * rows)
  for (const r of rects) {
    const c0 = Math.max(0, Math.floor((r.x - minX) / ROUTE_CELL))
    const r0 = Math.max(0, Math.floor((r.y - minY) / ROUTE_CELL))
    const c1 = Math.min(cols - 1, Math.floor((r.x + r.w - minX) / ROUTE_CELL))
    const r1 = Math.min(rows - 1, Math.floor((r.y + r.h - minY) / ROUTE_CELL))
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) blocked[row * cols + col] = 1
    }
  }
  const cellIdx = (x: number, y: number) => {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / ROUTE_CELL)))
    const row = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / ROUTE_CELL)))
    return row * cols + col
  }
  const startIdx = cellIdx(start.x, start.y)
  const endIdx = cellIdx(end.x, end.y)
  blocked[startIdx] = 0
  blocked[endIdx] = 0
  if (startIdx === endIdx) return [start, end]

  const total = cols * rows
  const g = new Float64Array(total).fill(Infinity)
  const f = new Float64Array(total)
  const came = new Int32Array(total).fill(-1)
  const closed = new Uint8Array(total)
  const heap: number[] = []
  const push = (idx: number) => {
    heap.push(idx)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (f[heap[parent]] <= f[heap[i]]) break
      ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
      i = parent
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop() as number
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l
        if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  const octile = (idx: number) => {
    const col = idx % cols
    const row = (idx / cols) | 0
    const dx = Math.abs(col - (endIdx % cols))
    const dy = Math.abs(row - ((endIdx / cols) | 0))
    return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * ROUTE_CELL
  }

  g[startIdx] = 0
  f[startIdx] = octile(startIdx)
  push(startIdx)
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const
  let found = false
  while (heap.length > 0) {
    const cur = pop()
    if (cur === endIdx) {
      found = true
      break
    }
    if (closed[cur]) continue
    closed[cur] = 1
    const cc = cur % cols
    const cr = (cur / cols) | 0
    for (const [dc, dr] of dirs) {
      const nc = cc + dc
      const nr = cr + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const nIdx = nr * cols + nc
      if (blocked[nIdx] || closed[nIdx]) continue
      if (dc !== 0 && dr !== 0 && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue
      const ng = g[cur] + (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1) * ROUTE_CELL
      if (ng < g[nIdx]) {
        g[nIdx] = ng
        came[nIdx] = cur
        f[nIdx] = ng + octile(nIdx)
        push(nIdx)
      }
    }
  }
  if (!found) return null

  const path: RoutePoint[] = []
  let cur = endIdx
  while (cur !== -1) {
    const col = cur % cols
    const row = (cur / cols) | 0
    path.push({ x: minX + (col + 0.5) * ROUTE_CELL, y: minY + (row + 0.5) * ROUTE_CELL })
    cur = came[cur]
  }
  path.reverse()
  path[0] = { ...start }
  path[path.length - 1] = { ...end }
  return path
}

/** 视线简化：只要跨点线段不撞障碍就跳过中间路标，去掉 A* 网格的锯齿感。 */
function simplifyWaypoints(points: RoutePoint[], obstacles: Box[]): RoutePoint[] {
  const out: RoutePoint[] = [points[0]]
  let i = 0
  while (i < points.length - 1) {
    let j = points.length - 1
    for (; j > i + 1; j--) {
      const a = points[i]
      const b = points[j]
      let clear = true
      for (const o of obstacles) {
        const padded = {
          x: o.x - ROUTE_PAD,
          y: o.y - ROUTE_PAD,
          w: o.w + ROUTE_PAD * 2,
          h: o.h + ROUTE_PAD * 2,
        }
        if (segmentIntersectsRect(a.x, a.y, b.x, b.y, padded)) {
          clear = false
          break
        }
      }
      if (clear) break
    }
    out.push(points[j])
    i = j
  }
  return out
}

/** Catmull-Rom 样条转 Konva 多段三次贝塞尔 points。 */
export function smoothBezierPoints(points: RoutePoint[]): number[] {
  if (points.length === 2) {
    return [
      points[0].x,
      points[0].y,
      points[0].x,
      points[0].y,
      points[1].x,
      points[1].y,
      points[1].x,
      points[1].y,
    ]
  }
  const out: number[] = [points[0].x, points[0].y]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    out.push(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    )
  }
  return out
}

export interface EdgeRoute {
  /** Konva points；bezier=true 时为多段贝塞尔格式（首点 + 每段 6 个值）。 */
  points: number[]
  bezier: boolean
  start: RoutePoint
  end: RoutePoint
  /** 避障成功时的路标链；无遮挡时为 null。 */
  waypoints: RoutePoint[] | null
}

/**
 * 连线避障路由：直线段不穿过任何障碍时保持原贝塞尔；被挡住时用粗网格 A*
 * 求绕行路标链，简化后经 Catmull-Rom 平滑输出。两端框自身不计入障碍
 * （锚点在其边上，计入会把锚点格封死）；搜索失败回退直连。
 */
export function routeEdgePath(
  from: Box,
  to: Box,
  fromSide: HandleSide | null,
  toSide: HandleSide | null,
  obstacles: Box[],
): EdgeRoute {
  const base = edgePoints(from, to, fromSide, toSide)
  const start = { x: base[0], y: base[1] }
  const end = { x: base[6], y: base[7] }
  const direct: EdgeRoute = { points: base, bezier: true, start, end, waypoints: null }
  if (obstacles.length === 0) return direct
  const blocked = obstacles.some((o) => segmentIntersectsRect(start.x, start.y, end.x, end.y, o))
  if (!blocked) return direct
  const raw = astarWaypoints(start, end, obstacles)
  if (!raw) return direct
  const simplified = simplifyWaypoints(raw, obstacles)
  if (simplified.length <= 2) return direct
  return {
    points: smoothBezierPoints(simplified),
    bezier: true,
    start,
    end,
    waypoints: simplified,
  }
}
