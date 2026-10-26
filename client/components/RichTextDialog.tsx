/**
 * 富文本内容弹窗：文章书写与修改都在这里完成。
 *
 * 边界：
 * - 直接用 wangEditor 的 `createEditor` / `createToolbar`，不用 React 包装层，
 *   编辑器自行接管容器 DOM（交给 React 渲染子节点会与内部的 slate 视图冲突）；
 * - 该组件由上层按需 `import()` 加载，富文本依赖因此不进首屏分包；
 * - 保存时同时取出 HTML（正文）与纯文本（卡片名称、搜索用投影）。
 */
import { useEffect, useRef } from 'react'
import Modal from 'antd/es/modal'
import { createEditor, createToolbar } from '@wangeditor-next/editor'
import type { IDomEditor } from '@wangeditor-next/editor'
import '@wangeditor-next/editor/dist/css/style.css'

interface RichTextDialogProps {
  initialHtml: string
  onCancel: () => void
  onSave: (html: string, plain: string) => void
}

export default function RichTextDialog({ initialHtml, onCancel, onSave }: RichTextDialogProps) {
  const editorHost = useRef<HTMLDivElement>(null)
  const toolbarHost = useRef<HTMLDivElement>(null)
  const editorRef = useRef<IDomEditor | null>(null)
  // 初始内容只在挂载时读取一次：编辑器自身持有文档状态，不必让 React 参与回流。
  const initialRef = useRef(initialHtml)

  useEffect(() => {
    let editor: IDomEditor | null = null
    let timer = 0
    let cancelled = false
    /**
     * antd Modal 的内容经 portal 挂载，晚于本组件首个 effect，首次执行时
     * 容器 ref 还是 null；因此轮询等容器就绪再创建，而不是假定挂载时机。
     */
    const attempt = (retries: number) => {
      if (cancelled) return
      const host = editorHost.current
      const toolbar = toolbarHost.current
      if (!host || !toolbar) {
        if (retries > 0) timer = window.setTimeout(() => attempt(retries - 1), 50)
        return
      }
      // 清空残留：StrictMode 双挂载或 destroy 后的容器不允许直接二次创建。
      host.innerHTML = ''
      toolbar.innerHTML = ''
      editor = createEditor({
        selector: host,
        html: initialRef.current,
        mode: 'default',
        config: { placeholder: '写点什么：结论、方案、会议记录都可以' },
      })
      createToolbar({ editor, selector: toolbar, mode: 'default' })
      editorRef.current = editor
    }
    attempt(10)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      editor?.destroy()
      editorRef.current = null
    }
  }, [])

  const handleSave = () => {
    const editor = editorRef.current
    if (!editor) return
    onSave(editor.getHtml(), editor.getText())
  }

  return (
    <Modal
      open
      title="富文本"
      width={880}
      okText="保存"
      cancelText="取消"
      onOk={handleSave}
      onCancel={onCancel}
      styles={{ body: { paddingTop: 8 } }}
    >
      <div className="rich-editor">
        <div ref={toolbarHost} className="rich-editor-toolbar" />
        <div ref={editorHost} className="rich-editor-body" />
      </div>
    </Modal>
  )
}
