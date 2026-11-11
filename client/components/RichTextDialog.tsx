/**
 * 富文本内容弹窗：文章书写与修改都在这里完成。
 *
 * 边界：
 * - 直接用 wangEditor 的 `createEditor` / `createToolbar`，不用 React 包装层，
 *   编辑器自行接管容器 DOM（交给 React 渲染子节点会与内部的 slate 视图冲突）；
 * - 该组件由上层按需 `import()` 加载，富文本依赖因此不进首屏分包；
 * - 保存时同时取出 HTML（正文）与纯文本（卡片名称、搜索用投影）；
 * - 图片/视频只走本地上传（Raw IPC 二进制直传到工作空间 assets），
 *   网络图/网络视频入口被移除，编辑器内不发任何网络请求（HC-13）；
 * - 改动停顿后自动写回，关闭不弹二次确认；Ctrl+S 立即保存，「保存」按钮写回并关闭。
 */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import Modal from 'antd/es/modal'
import { App as AntApp } from 'antd'
import { createEditor, createToolbar } from '@wangeditor-next/editor'
import type { IDomEditor, IEditorConfig, IToolbarConfig } from '@wangeditor-next/editor'
import '@wangeditor-next/editor/dist/css/style.css'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
import { toEditorHtml, toStoredHtml } from '@/lib/richTextHtml'

/** 输入停顿多久算一次自动保存；太短会频繁写库，太长又会让「输入后立刻关窗」丢字。 */
const AUTOSAVE_DELAY = 600

function htmlForEditor(html: string) {
  if (!isDesktopClient) return html
  return toEditorHtml(html, desktopApi.richAssetUrl)
}

function htmlForSave(html: string) {
  return toStoredHtml(html)
}

interface RichTextDialogProps {
  initialHtml: string
  onCancel: () => void
  /** 保存并关闭。 */
  onSave: (html: string, plain: string) => void
  /** 就地保存：写回内容但不关闭弹窗，方便边看画布边继续写。 */
  onQuickSave: (html: string, plain: string) => void
  /** 自动保存：静默写回，不关闭弹窗、不提示。 */
  onAutoSave: (html: string, plain: string) => void
}

export default function RichTextDialog({
  initialHtml,
  onCancel,
  onSave,
  onQuickSave,
  onAutoSave,
}: RichTextDialogProps) {
  const editorHost = useRef<HTMLDivElement>(null)
  const toolbarHost = useRef<HTMLDivElement>(null)
  const editorRef = useRef<IDomEditor | null>(null)
  // 初始内容只在挂载时读取一次：编辑器自身持有文档状态，不必让 React 参与回流。
  const initialRef = useRef(initialHtml)
  /** 已写回的 HTML：用来跳过没有实际变化的自动保存。 */
  const savedHtmlRef = useRef(initialHtml)
  const timerRef = useRef(0)
  const { message } = AntApp.useApp()

  /** 取出当前编辑器内容并立即写回；没有变化则什么也不做。 */
  const flush = () => {
    window.clearTimeout(timerRef.current)
    timerRef.current = 0
    const editor = editorRef.current
    if (!editor) return
    const html = htmlForSave(editor.getHtml())
    if (html === savedHtmlRef.current) return
    savedHtmlRef.current = html
    onAutoSave(html, editor.getText())
  }

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
      // 上传走 Raw IPC 二进制直传到工作空间 assets；粘贴截图会自动进入
      // uploadImage 的 customUpload，即剪贴板/粘贴上传路径。
      const menuConf: IEditorConfig['MENU_CONF'] = {
        uploadImage: {
          maxFileSize: 20 * 1024 * 1024,
          async customUpload(
            file: File,
            insertFn: (url: string, alt: string, href: string) => void,
          ) {
            try {
              const { url } = await desktopApi.saveRichAsset(file)
              insertFn(url, file.name, url)
            } catch (error) {
              message.error(`图片上传失败：${String(error)}`)
            }
          },
        },
        uploadVideo: {
          maxFileSize: 100 * 1024 * 1024,
          async customUpload(file: File, insertFn: (url: string, poster: string) => void) {
            try {
              const { url } = await desktopApi.saveRichAsset(file)
              insertFn(url, '')
            } catch (error) {
              message.error(`视频上传失败：${String(error)}`)
            }
          },
        },
      }
      const editorConfig: Partial<IEditorConfig> = {
        placeholder: '写点什么：结论、方案、会议记录都可以',
        MENU_CONF: menuConf,
        // 内容变化即排一次自动保存；编辑器是唯一的文档状态源。
        onChange: () => {
          window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(flush, AUTOSAVE_DELAY)
        },
      }
      editor = createEditor({
        selector: host,
        html: htmlForEditor(initialRef.current),
        mode: 'default',
        config: editorConfig,
      })
      // 去掉「网络图片」「网络视频」入口：只保留本地上传按钮（HC-13）。
      const toolbarConfig: Partial<IToolbarConfig> = {
        excludeKeys: ['insertImage', 'insertVideo'],
      }
      createToolbar({ editor, selector: toolbar, mode: 'default', config: toolbarConfig })
      editorRef.current = editor
      // 初始化可能触发一次 change：把基线推进到规范化后的 HTML，避免刚打开就写回。
      savedHtmlRef.current = htmlForSave(editor.getHtml())
      window.clearTimeout(timerRef.current)
      timerRef.current = 0
    }
    attempt(10)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(timerRef.current)
      editor?.destroy()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 弹窗生命周期内 message 实例不变
  }, [])

  const handleSave = () => {
    const editor = editorRef.current
    if (!editor) return
    const html = htmlForSave(editor.getHtml())
    savedHtmlRef.current = html
    window.clearTimeout(timerRef.current)
    onSave(html, editor.getText())
  }

  /** Ctrl+S：立即写回并给出反馈，弹窗保持打开。 */
  const handleQuickSave = () => {
    const editor = editorRef.current
    if (!editor) return
    const html = htmlForSave(editor.getHtml())
    if (html === savedHtmlRef.current) return
    savedHtmlRef.current = html
    window.clearTimeout(timerRef.current)
    onQuickSave(html, editor.getText())
  }

  /** 自动保存已经把改动写回，关闭时不再二次确认，只把未落下的那次补上。 */
  const handleCancel = () => {
    flush()
    onCancel()
  }

  /** 编辑器是 contenteditable，keydown 会冒泡到外层容器，在这里接住 Ctrl+S。 */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    event.stopPropagation()
    handleQuickSave()
  }

  return (
    <Modal
      open
      title="富文本"
      width={880}
      okText="保存"
      cancelText="关闭"
      onOk={handleSave}
      onCancel={handleCancel}
      styles={{ body: { paddingTop: 8 } }}
    >
      <div className="rich-editor" onKeyDown={handleKeyDown}>
        <div ref={toolbarHost} className="rich-editor-toolbar" />
        <div ref={editorHost} className="rich-editor-body" />
      </div>
      <p className="rich-editor-hint">改动会自动保存；关闭不会丢失，Ctrl+S 可立即保存。</p>
    </Modal>
  )
}
