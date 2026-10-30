/**
 * 连线路径的纯函数测试。
 * 避障已随「连线层下沉到底层」移除（见 ADR-039），这里只锁两件事：
 * 自动选边不能穿过卡片内容、显式锚点必须精确落在侧边中点。
 */
import { describe, expect, it } from 'vitest'
import { asHandleSide, edgePoints } from './geometry'
import type { Box } from './geometry'

describe('edgePoints', () => {
  const from: Box = { x: 0, y: 0, w: 100, h: 60 }
  const to: Box = { x: 400, y: 0, w: 100, h: 60 }

  it('水平方向的连线从右中出发、落到左中（8 值单段贝塞尔）', () => {
    const points = edgePoints(from, to)
    expect(points).toHaveLength(8)
    expect(points.slice(0, 2)).toEqual([100, 30])
    expect(points.slice(6, 8)).toEqual([400, 30])
  })

  it('垂直方向的连线从下中出发、落到上中', () => {
    const below: Box = { x: 0, y: 300, w: 100, h: 60 }
    const points = edgePoints(from, below)
    expect(points.slice(0, 2)).toEqual([50, 60])
    expect(points.slice(6, 8)).toEqual([50, 300])
  })

  it('显式锚点优先于方位推断', () => {
    const points = edgePoints(from, to, 'top', 'bottom')
    expect(points.slice(0, 2)).toEqual([50, 0])
    expect(points.slice(6, 8)).toEqual([450, 60])
  })

  it('控制点沿主方向外扩，保证曲线不扎进卡片', () => {
    const points = edgePoints(from, to)
    // 水平为主方向时，控制点只在 x 上偏移，y 与端点一致。
    expect(points[3]).toBe(points[1])
    expect(points[5]).toBe(points[7])
    expect(points[2]).toBeGreaterThan(points[0])
    expect(points[4]).toBeLessThan(points[6])
  })
})

describe('asHandleSide', () => {
  it('合法侧边原样返回，其余收敛为 null', () => {
    expect(asHandleSide('top')).toBe('top')
    expect(asHandleSide('right')).toBe('right')
    expect(asHandleSide('')).toBeNull()
    expect(asHandleSide(undefined)).toBeNull()
    expect(asHandleSide('diagonal')).toBeNull()
  })
})
