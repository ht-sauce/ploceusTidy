/**
 * 布局领域纯函数用例：碰撞、吸附、避让、展示尺寸、空间贴合与整理、折叠显示框。
 * 这些函数决定「对象摆在哪」，改动风险最高，回归主要靠这里。
 */
import { describe, expect, it } from 'vitest'
import {
  GROUP_COLLAPSED_HEIGHT,
  GROUP_MIN_H,
  LAYOUT_GAP,
  arrangeGroupMembers,
  displayName,
  findFreeOffset,
  fitGroupToMembers,
  groupDisplayBox,
  nodeDisplayHeight,
  nodeRect,
  rectsOverlap,
  snapOffset,
} from '@/domain/layout'
import type { SceneGroup, SceneNode } from '@/types/scene'

function node(patch: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'n1',
    kind: 'file',
    icon: 'txt',
    name: 'a.txt',
    subtitle: '',
    groupId: '',
    z: 0,
    x: 0,
    y: 0,
    w: 72,
    h: 64,
    isExists: true,
    ...patch,
  }
}

function group(patch: Partial<SceneGroup> = {}): SceneGroup {
  return {
    id: 'g1',
    title: '空间 1',
    collapsed: false,
    x: 0,
    y: 0,
    w: 200,
    h: 160,
    ...patch,
  }
}

describe('rectsOverlap', () => {
  it('相交与间隔距离分别判定', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    const b = { x: 8, y: 0, w: 10, h: 10 }
    expect(rectsOverlap(a, b)).toBe(true)
    // 间距要求 8px 时，8px 重叠已算冲突
    expect(rectsOverlap(a, b, 8)).toBe(true)
    // 完全分开
    expect(rectsOverlap(a, { x: 30, y: 0, w: 10, h: 10 }, 8)).toBe(false)
  })

  it('刚好贴边不算重叠', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    const b = { x: 10, y: 0, w: 10, h: 10 }
    expect(rectsOverlap(a, b)).toBe(false)
  })
})

describe('displayName 与展示高度', () => {
  it('短名原样返回，长名保留后缀并换行', () => {
    expect(displayName('a.txt')).toBe('a.txt')
    const long = '这是一个非常非常长的中文文件名用于测试截断.txt'
    const shown = displayName(long)
    expect(shown).toContain('\n')
    expect(shown.endsWith('.txt')).toBe(true)
  })

  it('标注让卡片多出一块高度', () => {
    const plain = nodeDisplayHeight(node({ name: 'a.txt' }))
    const annotated = nodeDisplayHeight(node({ name: 'a.txt' }), true)
    expect(annotated - plain).toBe(18)
  })

  it('两行名称比一行高', () => {
    const single = nodeDisplayHeight(node({ name: 'a.txt' }))
    const double = nodeDisplayHeight(node({ name: '一个很长的中文名字.txt' }))
    expect(double).toBeGreaterThan(single)
  })

  it('nodeRect 用展示高度而不是持久化高度', () => {
    const rect = nodeRect(node({ name: 'a.txt', h: 999 }), false)
    expect(rect.h).toBe(nodeDisplayHeight(node({ name: 'a.txt' })))
  })
})

describe('snapOffset（对齐吸附）', () => {
  it('阈值内吸到目标左边并给出参考线', () => {
    const moving = [{ x: 103, y: 0, w: 72, h: 64 }]
    const targets = [{ x: 100, y: 200, w: 72, h: 64 }]
    const result = snapOffset(moving, targets, 0, 0, 6)
    expect(result.dx).toBe(-3)
    expect(result.guides.vertical).toContain(100)
  })

  it('超出阈值不吸附', () => {
    const moving = [{ x: 120, y: 0, w: 72, h: 64 }]
    const targets = [{ x: 100, y: 200, w: 72, h: 64 }]
    const result = snapOffset(moving, targets, 0, 0, 6)
    expect(result.dx).toBe(0)
    expect(result.guides.vertical).toHaveLength(0)
  })

  it('没有目标时原样返回偏移', () => {
    const result = snapOffset([{ x: 0, y: 0, w: 10, h: 10 }], [], 12, 9, 6)
    expect(result).toMatchObject({ dx: 12, dy: 9 })
  })
})

describe('findFreeOffset（新建避让）', () => {
  it('压住障碍物时整体让到空位', () => {
    const moving = [{ x: 0, y: 0, w: 72, h: 64 }]
    const obstacles = [{ x: 0, y: 0, w: 72, h: 64 }]
    const offset = findFreeOffset(moving, obstacles, LAYOUT_GAP, 4, 80, 72)
    expect(offset.dx !== 0 || offset.dy !== 0).toBe(true)
    const moved = { ...moving[0], x: moving[0].x + offset.dx, y: moving[0].y + offset.dy }
    expect(rectsOverlap(moved, obstacles[0], LAYOUT_GAP)).toBe(false)
  })

  it('没有障碍物时不动', () => {
    expect(findFreeOffset([{ x: 0, y: 0, w: 10, h: 10 }], [], LAYOUT_GAP)).toEqual({
      dx: 0,
      dy: 0,
    })
  })
})

describe('空间贴合与显示框', () => {
  it('按成员包围盒加内边距反推空间框', () => {
    const members = [node({ x: 100, y: 100 }), node({ id: 'n2', x: 200, y: 100 })]
    const fit = fitGroupToMembers(members)
    expect(fit).not.toBeNull()
    // 左内边距 16、顶部标题区 32
    expect(fit!.x).toBe(84)
    expect(fit!.y).toBe(68)
    expect(fit!.w).toBeGreaterThan(200 - 84)
  })

  it('空空间返回 null，保持现状作为容器', () => {
    expect(fitGroupToMembers([])).toBeNull()
  })

  it('折叠只改显示高度，不动存储尺寸', () => {
    const collapsed = group({ collapsed: true, h: 160 })
    expect(groupDisplayBox(collapsed).h).toBe(GROUP_COLLAPSED_HEIGHT)
    expect(collapsed.h).toBe(160)
    expect(groupDisplayBox(group({ h: 160 })).h).toBe(160)
  })
})

describe('arrangeGroupMembers（空间内整理）', () => {
  it('按阅读顺序排成网格并收高空间', () => {
    const target = group({ x: 0, y: 0, w: 200, h: 400 })
    const members = [
      node({ id: 'b', x: 200, y: 200, name: 'b.txt' }),
      node({ id: 'a', x: 20, y: 20, name: 'a.txt' }),
    ]
    const arranged = arrangeGroupMembers(members, target, LAYOUT_GAP)
    // 先上后下：a 先排，b 落到下一行或右侧
    expect(arranged.positions[0].id).toBe('a')
    expect(arranged.positions).toHaveLength(2)
    expect(arranged.height).toBeGreaterThan(0)
    // 收高后不低于最小高度
    expect(arranged.height).toBeGreaterThanOrEqual(GROUP_MIN_H / 4)
  })

  it('空成员返回原尺寸', () => {
    const target = group({ w: 300, h: 220 })
    const arranged = arrangeGroupMembers([], target)
    expect(arranged).toMatchObject({ width: 300, height: 220 })
  })
})
