/**
 * 可见性：rbush 视口裁剪 + LOD 档位 + 连线筛选。
 * 只输出“当前该画什么”，不持有交互状态。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import RBush from 'rbush'
import type { SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import type { CanvasViewport, StageSize } from './types'
import { LOD_COMPACT, LOD_DOT } from './constants'

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
  selectedSet: Set<string>
  selectedGroupId: string | null
  selectedEdgeId: string | null
  viewport: CanvasViewport
  size: StageSize
}

export function useVisibleScene({
  nodes,
  edges,
  nodeById,
  groupById,
  selectedSet,
  selectedGroupId,
  selectedEdgeId,
  viewport,
  size,
}: UseVisibleSceneOptions) {
  /** 空间索引：节点集合变化时重建；查询用带预取边距的视口矩形。 */
  const rbush = useMemo(() => {
    const tree = new RBush<BoundsItem>()
    tree.load(
      nodes.map((node) => ({
        minX: node.x,
        minY: node.y,
        maxX: node.x + node.w,
        maxY: node.y + node.h,
        id: node.id,
      })),
    )
    return tree
  }, [nodes])

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

  const lod = viewport.scale < LOD_DOT
  const compact = !lod && viewport.scale < LOD_COMPACT

  const visibleEdges = useMemo(() => {
    const exists = (id: string) => nodeById.has(id) || groupById.has(id)
    const valid = edges.filter((edge) => exists(edge.from) && exists(edge.to))
    // 低缩放时线条会淹没色点：有选中就只画相关连线，没选中全部隐藏。
    if (viewport.scale < 0.62) {
      if (selectedSet.size === 0 && !selectedEdgeId && !selectedGroupId) return []
      return valid.filter(
        (edge) =>
          selectedSet.has(edge.from) ||
          selectedSet.has(edge.to) ||
          edge.from === selectedGroupId ||
          edge.to === selectedGroupId ||
          edge.id === selectedEdgeId,
      )
    }
    // 正常缩放下始终画全部连线，避免「选中一个对象后其他连线凭空消失」。
    const visibleIds = new Set(visibleNodes.map((node) => node.id))
    return valid.filter(
      (edge) =>
        visibleIds.has(edge.from) ||
        visibleIds.has(edge.to) ||
        selectedSet.has(edge.from) ||
        selectedSet.has(edge.to) ||
        edge.from === selectedGroupId ||
        edge.to === selectedGroupId,
    )
  }, [
    edges,
    groupById,
    nodeById,
    selectedEdgeId,
    selectedGroupId,
    selectedSet,
    viewport.scale,
    visibleNodes,
  ])

  return { visibleNodes, visibleEdges, lod, compact }
}
