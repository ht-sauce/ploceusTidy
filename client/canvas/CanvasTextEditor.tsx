/**
 * 文字对象的画布内联编辑器：跟随视口定位，失焦或 Esc 时提交。
 * 用非受控 textarea + defaultValue，避免每次输入重渲染打断输入法。
 */
import { useEffect, useRef } from 'react'
import type { SceneNode } from '@/types/scene'

interface CanvasTextEditorProps {
  node: SceneNode
  viewport: { x: number; y: number; scale: number }
  onCommit: (id: string, text: string, live?: boolean) => void
  onClose: () => void
}

export default function CanvasTextEditor({
  node,
  viewport,
  onCommit,
  onClose,
}: CanvasTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [node.id])

  return (
    <textarea
      ref={ref}
      className="canvas-text-editor"
      defaultValue={node.body ?? node.subtitle ?? node.name}
      style={{
        left: node.x * viewport.scale + viewport.x,
        top: node.y * viewport.scale + viewport.y,
        width: Math.max(200, node.w * viewport.scale),
        minHeight: Math.max(72, node.h * viewport.scale),
      }}
      onChange={(event) => {
        // 边输入边同步名称，编辑区外能看到实时结果。
        onCommit(node.id, event.target.value, true)
      }}
      onBlur={() => {
        onCommit(node.id, ref.current?.value ?? '')
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.blur()
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          event.currentTarget.blur()
        }
        event.stopPropagation()
      }}
      placeholder="直接输入文字，Esc 或点击空白处结束"
      aria-label="编辑文字"
    />
  )
}
