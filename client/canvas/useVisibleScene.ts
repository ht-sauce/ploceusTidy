/**
 * 可见性：rbush 视口裁剪 + 连线有效性过滤。
 * 不做远景色点降级——任何缩放都渲染完整对象，只是更小。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import RBush from 'rbush'
import type { SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import { LAYOUT_GAP, type Rect } from '@/domain/layout'
import type { CanvasViewport, StageSize } from './types'

interface BoundsItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

interface UseVisibleSceneOptions {
  nodes: SceneNode[]
  edges: SceneEdge[]
  nodeById: Map<string, SceneNode>
  groupById: Map<string, SceneGroup>
  viewport: CanvasViewport
  size: StageSize
  /** 节点展示高度（名称行数 + 标注），索引与落点判定统一用它，避免漏判标注区域。 */
  nodeHeightOf: (node: SceneNode) => number
}

export function useVisibleScene({
  nodes,
  edges,
  nodeById,
  groupById,
  viewport,
  size,
  nodeHeightOf,
}: UseVisibleSceneOptions) {
  /** 空间索引：节点集合变化时重建；查询用带预取边距的视口矩形。 */
  const rbush = useMemo(() => {
    const tree = new RBush<BoundsItem>()
    tree.load(
      nodes.map((node) => ({
        minX: node.x,
        minY: node.y,
        maxX: node.x + node.w,
        maxY: node.y + nodeHeightOf(node),
        id: node.id,
      })),
    )
    return tree
  }, [nodes, nodeHeightOf])

  const [visibleNodes, setVisibleNodes] = useState<SceneNode[]>(nodes)
  const frameRequest = useRef<number | null>(null)

  // 视口变化后按帧裁剪可见节点，平移缩放期间不额外触发渲染风暴。
  // 直接映射命中项（O(命中数)），不对全量节点做 filter（10 万对象下每个平移帧都扫一遍）。
  useEffect(() => {
    if (frameRequest.current) cancelAnimationFrame(frameRequest.current)
    frameRequest.current = requestAnimationFrame(() => {
      const margin = 180 / viewport.scale
      const left = -viewport.x / viewport.scale - margin
      const top = -viewport.y / viewport.scale - margin
      const right = left + size.width / viewport.scale + margin * 2
      const bottom = top + size.height / viewport.scale + margin * 2
      const hits = rbush.search({ minX: left, minY: top, maxX: right, maxY: bottom })
      setVisibleNodes(
        hits
          .map((item) => nodeById.get(item.id))
          .filter((node): node is SceneNode => Boolean(node)),
      )
    })
    return () => {
      if (frameRequest.current) cancelAnimationFrame(frameRequest.current)
    }
  }, [nodeById, nodes, rbush, size.height, size.width, viewport])

  // 连线按视口裁剪：端点包络盒（贝塞尔曲线落在端点凸包内，两端盒子的并集即覆盖曲线）
  // 与视口无交才跳过；缩小画布时视口覆盖全部，完整关系网仍然可见。
  const visibleEdges = useMemo(() => {
    const boxOf = (id: string): Rect | null => {
      const node = nodeById.get(id)
      if (node) return { x: node.x, y: node.y, w: node.w, h: nodeHeightOf(node) }
      const group = groupById.get(id)
      return group ? { x: group.x, y: group.y, w: group.w, h: group.h } : null
    }
    const margin = 120 / viewport.scale
    const left = -viewport.x / viewport.scale - margin
    const top = -viewport.y / viewport.scale - margin
    const right = left + size.width / viewport.scale + margin * 2
    const bottom = top + size.height / viewport.scale + margin * 2
    return edges.filter((edge) => {
      const from = boxOf(edge.from)
      const to = boxOf(edge.to)
      if (!from || !to) return false
      const minX = Math.min(from.x, to.x)
      const minY = Math.min(from.y, to.y)
      const maxX = Math.max(from.x + from.w, to.x + to.w)
      const maxY = Math.max(from.y + from.h, to.y + to.h)
      return maxX >= left && minX <= right && maxY >= top && minY <= bottom
    })
  }, [edges, groupById, nodeById, nodeHeightOf, size.height, size.width, viewport])

  /**
   * 松手时的落点判定：用 rbush 空间索引查落点附近是否存在非自身的对象，
   * O(log N)。返回是否被压住，供调用方决定接受落点还是退回拖动前的位置。
   * 不做全量障碍物数组构建，10 万对象下也不会拖慢松手判定。
   */
  const landingBlocked = useCallback(
    (rect: Rect, movingIds: Set<string>) => {
      const pad = LAYOUT_GAP
      // 查询框已按 pad 外扩，命中即等价于 rectsOverlap(item, rect, pad)。
      const hits = rbush.search({
        minX: rect.x - pad,
        minY: rect.y - pad,
        maxX: rect.x + rect.w + pad,
        maxY: rect.y + rect.h + pad,
      })
      return hits.some((item) => !movingIds.has(item.id))
    },
    [rbush],
  )

  /**
   * 拖动对齐吸附的邻居查询：取矩形 pad 范围内的非移动对象矩形（O(log N + k)），
   * 替代逐帧从全量节点构建吸附目标；排除移动集合自身，避免被自己的旧位置吸回去。
   */
  const nearbyRects = useCallback(
    (rect: Rect, pad: number, excludeIds: Set<string>) => {
      const hits = rbush.search({
        minX: rect.x - pad,
        minY: rect.y - pad,
        maxX: rect.x + rect.w + pad,
        maxY: rect.y + rect.h + pad,
      })
      return hits
        .filter((item) => !excludeIds.has(item.id))
        .map((item) => ({
          x: item.minX,
          y: item.minY,
          w: item.maxX - item.minX,
          h: item.maxY - item.minY,
        }))
    },
    [rbush],
  )

  return { visibleNodes, visibleEdges, landingBlocked, nearbyRects }
}
