/**
 * 可见性：rbush 视口裁剪 + 连线有效性过滤。
 * 不做远景色点降级——任何缩放都渲染完整对象，只是更小。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import RBush from 'rbush'
import type { SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
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
}

export function useVisibleScene({
  nodes,
  edges,
  nodeById,
  groupById,
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

  // 连线数量远小于对象，全部保留：缩小后仍能看到完整关系网。
  const visibleEdges = useMemo(() => {
    const exists = (id: string) => nodeById.has(id) || groupById.has(id)
    return edges.filter((edge) => exists(edge.from) && exists(edge.to))
  }, [edges, groupById, nodeById])

  return { visibleNodes, visibleEdges }
}
