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
  useEffect(() => {
    if (frameRequest.current) cancelAnimationFrame(frameRequest.current)
    frameRequest.current = requestAnimationFrame(() => {
      const margin = 180 / viewport.scale
      const left = -viewport.x / viewport.scale - margin
      const top = -viewport.y / viewport.scale - margin
      const right = left + size.width / viewport.scale + margin * 2
      const bottom = top + size.height / viewport.scale + margin * 2
      const hits = rbush.search({ minX: left, minY: top, maxX: right, maxY: bottom })
      const hitIds = new Set(hits.map((item) => item.id))
      setVisibleNodes(nodes.filter((node) => hitIds.has(node.id)))
    })
    return () => {
      if (frameRequest.current) cancelAnimationFrame(frameRequest.current)
    }
  }, [nodes, rbush, size.height, size.width, viewport])

  // 连线数量远小于对象，全部保留：缩小后仍能看到完整关系网。
  const visibleEdges = useMemo(() => {
    const exists = (id: string) => nodeById.has(id) || groupById.has(id)
    return edges.filter((edge) => exists(edge.from) && exists(edge.to))
  }, [edges, groupById, nodeById])

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
