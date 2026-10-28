/**
 * 迷你地图：对象分布与空间用单个 canvas 绘制（替代几百个 DOM span 的重排），
 * 视口框保留为 DOM 以便平移时只更新一个元素；点击/拖动把对应世界坐标移到视口中心。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { MINIMAP_MAX_DOTS } from './constants'
import { clamp } from './geometry'
import { cssVar } from './icons'
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
  /** 主题 id：切换主题后按新的语义色重绘分布图。 */
  themeId: string
  onMoveTo: (clientX: number, clientY: number, element: HTMLElement) => void
}

// memo：框选/拖动/选中等无关重渲染不再重绘分布图（视口框是普通 DOM，随 props 更新）。
function Minimap({ bounds, nodes, groups, viewport, size, themeId, onMoveTo }: MinimapProps) {
  const [dragging, setDragging] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const toPercent = (x: number, y: number) => ({
    left: `${((x - bounds.minX) / bounds.width) * 100}%`,
    top: `${((y - bounds.minY) / bounds.height) * 100}%`,
  })
  // 超大画布按步长抽样；抽样只随场景变化重算（O(对象数) 一次）。
  const step = Math.max(1, Math.ceil(nodes.length / MINIMAP_MAX_DOTS))
  const sampled = useMemo(() => nodes.filter((_node, index) => index % step === 0), [nodes, step])

  // 分布图只在场景/范围/主题变化时重绘；视口平移只更新视口框（DOM），不碰 canvas。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!width || !height) return
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      const toX = (x: number) => ((x - bounds.minX) / bounds.width) * width
      const toY = (y: number) => ((y - bounds.minY) / bounds.height) * height
      // 空间框：极浅底 + 描边，观感与原 DOM 版一致（颜色读主题语义令牌）。
      context.fillStyle = cssVar('--hover-bg', '#F2F3F5')
      context.strokeStyle = cssVar('--border', '#C9CDD4')
      context.lineWidth = 1
      groups.forEach((group) => {
        const x = toX(group.x)
        const y = toY(group.y)
        const w = (group.w / bounds.width) * width
        const h = (group.h / bounds.height) * height
        context.fillRect(x, y, w, h)
        context.strokeRect(x + 0.5, y + 0.5, w, h)
      })
      // 对象点：半透明次级文本色。
      context.globalAlpha = 0.45
      context.fillStyle = cssVar('--text-secondary', '#747A83')
      sampled.forEach((node) => {
        context.fillRect(
          toX(node.x),
          toY(node.y),
          Math.max(0.6, (node.w / bounds.width) * width),
          Math.max(0.6, (node.h / bounds.height) * height),
        )
      })
      context.globalAlpha = 1
    }
    draw()
    // DPI 或容器尺寸变化后重绘；主题切换由 themeId 依赖触发。
    const observer = new ResizeObserver(draw)
    if (canvas.parentElement) observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [bounds, groups, sampled, themeId])

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
      <canvas ref={canvasRef} className="minimap-canvas" />
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
