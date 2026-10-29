/** 避障连线路径的纯函数测试：相交判定、绕行触发与端点精度。 */
import { describe, expect, it } from 'vitest'
import {
  routeEdgePath,
  segmentIntersectsRect,
  smoothBezierPoints,
  type RoutePoint,
} from './geometry'
import type { Box } from './geometry'

describe('segmentIntersectsRect', () => {
  const rect: Box = { x: 100, y: 100, w: 50, h: 50 }
  it('横穿矩形的线段判为相交', () => {
    expect(segmentIntersectsRect(0, 125, 300, 125, rect)).toBe(true)
  })
  it('不接触矩形的线段判为不相交', () => {
    expect(segmentIntersectsRect(0, 40, 300, 40, rect)).toBe(false)
    expect(segmentIntersectsRect(0, 200, 60, 200, rect)).toBe(false)
  })
  it('斜线擦边也判为相交', () => {
    expect(segmentIntersectsRect(90, 90, 160, 160, rect)).toBe(true)
  })
})

describe('routeEdgePath', () => {
  const from: Box = { x: 0, y: 0, w: 100, h: 60 }
  const to: Box = { x: 400, y: 0, w: 100, h: 60 }

  it('无障碍时保持直连贝塞尔（8 值单段格式）', () => {
    const route = routeEdgePath(from, to, 'right', 'left', [])
    expect(route.waypoints).toBeNull()
    expect(route.bezier).toBe(true)
    expect(route.points).toHaveLength(8)
    expect(route.start).toEqual({ x: 100, y: 30 })
    expect(route.end).toEqual({ x: 400, y: 30 })
  })

  it('直线不被障碍挡住时也不绕行', () => {
    const beside: Box = { x: 200, y: 200, w: 80, h: 80 }
    const route = routeEdgePath(from, to, 'right', 'left', [beside])
    expect(route.waypoints).toBeNull()
    expect(route.points).toHaveLength(8)
  })

  it('直线穿过障碍时绕行且路径不穿过障碍', () => {
    const blocker: Box = { x: 200, y: 10, w: 80, h: 60 }
    const route = routeEdgePath(from, to, 'right', 'left', [blocker])
    expect(route.waypoints).not.toBeNull()
    expect(route.points.length).toBeGreaterThan(8)
    // 路标链中除首尾外都不落进障碍外扩区。
    const padded = { x: blocker.x - 12, y: blocker.y - 12, w: blocker.w + 24, h: blocker.h + 24 }
    for (const waypoint of route.waypoints ?? []) {
      const inside =
        waypoint.x > padded.x &&
        waypoint.x < padded.x + padded.w &&
        waypoint.y > padded.y &&
        waypoint.y < padded.y + padded.h
      expect(inside).toBe(false)
    }
  })

  it('障碍范围过大时回退直连', () => {
    const far: Box[] = Array.from({ length: 4 }, (_, index) => ({
      x: 200 + index * 20000,
      y: 30,
      w: 12000,
      h: 12000,
    }))
    const route = routeEdgePath(from, to, 'right', 'left', far)
    expect(route.waypoints).toBeNull()
    expect(route.points).toHaveLength(8)
  })
})

describe('smoothBezierPoints', () => {
  it('两点退化为单段贝塞尔（首点 + 6 值）', () => {
    const points: RoutePoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]
    expect(smoothBezierPoints(points)).toHaveLength(8)
  })
  it('多点输出多段贝塞尔且首尾坐标正确', () => {
    const points: RoutePoint[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ]
    const out = smoothBezierPoints(points)
    expect(out.length).toBe(2 + (points.length - 1) * 6)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
    expect(out[out.length - 2]).toBe(100)
    expect(out[out.length - 1]).toBe(50)
  })
})
