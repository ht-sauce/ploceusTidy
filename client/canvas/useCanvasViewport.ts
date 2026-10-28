/**
 * 画布视口：缩放、定位与适配。
 * 只维护视口状态与定位脉冲，不处理选择、拖动等交互会话。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { groupDisplayBox } from '@/domain/layout'
import type { SceneGroup, SceneNode } from '@/types/scene'
import type { CanvasViewport, StageSize } from './types'
import { clamp } from './geometry'

interface UseCanvasViewportOptions {
  nodes: SceneNode[]
  groups: SceneGroup[]
  nodeById: Map<string, SceneNode>
  groupById: Map<string, SceneGroup>
  size: StageSize
  detailsOpen: boolean
  onScaleChange: (scale: number) => void
}

export function useCanvasViewport({
  nodes,
  groups,
  nodeById,
  groupById,
  size,
  detailsOpen,
  onScaleChange,
}: UseCanvasViewportOptions) {
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, scale: 0.82 })
  const viewportRef = useRef(viewport)
  const [pulseId, setPulseId] = useState<string | null>(null)
  const pulseTimer = useRef<number | null>(null)

  // 事件处理器需要读取最新视口；在绘制前同步，避免读到上一帧的值。
  useLayoutEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  useEffect(() => {
    onScaleChange(viewport.scale)
  }, [onScaleChange, viewport.scale])

  useEffect(
    () => () => {
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current)
    },
    [],
  )

  /** 以屏幕锚点为中心缩放，锚点下的世界坐标保持不动。 */
  const zoomAt = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    setViewport((previous) => {
      const scale = clamp(nextScale, 0.22, 2)
      const ratio = scale / previous.scale
      return {
        x: anchorX - (anchorX - previous.x) * ratio,
        y: anchorY - (anchorY - previous.y) * ratio,
        scale,
      }
    })
  }, [])

  /** 把指定对象或空间居中；属性面板打开时按剩余可用宽度居中。 */
  const locateTarget = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      const group = node ? null : groupById.get(id)
      const box = node ?? group
      if (!box) return
      const scale = Math.max(viewportRef.current.scale, 0.92)
      const availableWidth = Math.max(240, size.width - (detailsOpen ? 300 : 0))
      const x = availableWidth / 2 - (box.x + box.w / 2) * scale
      const y = size.height / 2 - (box.y + box.h / 2) * scale
      setViewport({ x, y, scale })
      if (!node) return
      setPulseId(id)
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current)
      pulseTimer.current = window.setTimeout(() => setPulseId(null), 1600)
    },
    [detailsOpen, groupById, nodeById, size.height, size.width],
  )

  const fitView = useCallback(() => {
    // 空间与游离对象一起纳入包围盒：只按空间算会把空间外的对象漏在视口外。
    // 折叠空间按标题条计算，适配后不会为看不见的成员留白。
    const boxes = groups.length > 0 ? [...groups.map(groupDisplayBox), ...nodes] : nodes
    if (!boxes.length) return
    const bounds = boxes.reduce(
      (result, box) => ({
        minX: Math.min(result.minX, box.x),
        minY: Math.min(result.minY, box.y),
        maxX: Math.max(result.maxX, box.x + box.w),
        maxY: Math.max(result.maxY, box.y + box.h),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    )
    const width = Math.max(1, bounds.maxX - bounds.minX)
    const height = Math.max(1, bounds.maxY - bounds.minY)
    const scale = clamp(Math.min((size.width - 80) / width, (size.height - 80) / height), 0.22, 1.2)
    setViewport({
      x: (size.width - width * scale) / 2 - bounds.minX * scale,
      y: (size.height - height * scale) / 2 - bounds.minY * scale,
      scale,
    })
  }, [groups, nodes, size.height, size.width])

  const zoomBy = useCallback(
    (factor: number) => {
      zoomAt(viewportRef.current.scale * factor, size.width / 2, size.height / 2)
    },
    [size.height, size.width, zoomAt],
  )

  const getCenterWorld = useCallback(() => {
    const current = viewportRef.current
    return {
      x: (size.width / 2 - current.x) / current.scale,
      y: (size.height / 2 - current.y) / current.scale,
    }
  }, [size.height, size.width])

  return {
    viewport,
    viewportRef,
    setViewport,
    zoomAt,
    locateTarget,
    fitView,
    zoomBy,
    getCenterWorld,
    pulseId,
  }
}
