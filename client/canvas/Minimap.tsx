/**
 * 迷你地图：按内容包围盒绘制空间与对象分布，并叠加视口框。
 * 点击或拖动把对应世界坐标移到视口中心。
 */
import { memo, useMemo, useState } from 'react'
import { MINIMAP_MAX_DOTS } from './constants'
import { clamp } from './geometry'
import type { SceneGroup, SceneNode } from '@/types/scene'

interface MiniBounds {
  minX: number
  minY: number
  width: number
  height: number
}

interface MinimapProps {
  bounds: MiniBounds
  nodes: SceneNode[]
  groups: SceneGroup[]
  /** 视口在屏幕上的位置与缩放，用于换算视口框。 */
  viewport: { x: number; y: number; scale: number }
  size: { width: number; height: number }
  onMoveTo: (clientX: number, clientY: number, element: HTMLElement) => void
}

// memo：框选/拖动/选中等无关重渲染不再重排 400 个抽样点的 DOM。
function Minimap({ bounds, nodes, groups, viewport, size, onMoveTo }: MinimapProps) {
  const [dragging, setDragging] = useState(false)
  const toPercent = (x: number, y: number) => ({
    left: `${((x - bounds.minX) / bounds.width) * 100}%`,
    top: `${((y - bounds.minY) / bounds.height) * 100}%`,
  })
  // 超大画布按步长抽样，避免 DOM 节点爆炸。
  // 抽样只随场景变化重算（O(对象数) 一次）；视口平移/缩放每帧只重排抽样点的位置。
  const step = Math.max(1, Math.ceil(nodes.length / MINIMAP_MAX_DOTS))
  const sampled = useMemo(() => nodes.filter((_node, index) => index % step === 0), [nodes, step])

  return (
    <div
      className="minimap"
      title="点击或拖动定位视口"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        onMoveTo(event.clientX, event.clientY, event.currentTarget)
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        onMoveTo(event.clientX, event.clientY, event.currentTarget)
      }}
      onPointerUp={(event) => {
        setDragging(false)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
    >
      {groups.map((group) => (
        <span
          key={group.id}
          className="minimap-group"
          style={{
            ...toPercent(group.x, group.y),
            width: `${(group.w / bounds.width) * 100}%`,
            height: `${(group.h / bounds.height) * 100}%`,
          }}
        />
      ))}
      {sampled.map((node) => (
        <span
          key={`dot-${node.id}`}
          className="minimap-dot"
          style={{
            ...toPercent(node.x, node.y),
            width: `${Math.max(0.6, (node.w / bounds.width) * 100)}%`,
            height: `${Math.max(0.6, (node.h / bounds.height) * 100)}%`,
          }}
        />
      ))}
      <span
        className="minimap-viewport"
        style={{
          ...toPercent(-viewport.x / viewport.scale, -viewport.y / viewport.scale),
          width: `${clamp((size.width / viewport.scale / bounds.width) * 100, 2, 100)}%`,
          height: `${clamp((size.height / viewport.scale / bounds.height) * 100, 2, 100)}%`,
        }}
      />
    </div>
  )
}

export default memo(Minimap)
