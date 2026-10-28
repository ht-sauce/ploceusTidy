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
 * - Ctrl+S 就地保存不关闭，「保存」按钮保存并关闭，取消时若有改动先确认。
 */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import Modal from 'antd/es/modal'
import { App as AntApp } from 'antd'
import { createEditor, createToolbar } from '@wangeditor-next/editor'
import type { IDomEditor, IEditorConfig, IToolbarConfig } from '@wangeditor-next/editor'
import '@wangeditor-next/editor/dist/css/style.css'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'

/** HTML 里存储的媒体引用形如 `assets/<uuid>.<ext>`；展示时换成 richasset 协议 URL。 */
const ASSET_REF_PATTERN = /assets\/([\w-]+\.[a-z0-9]+)/g
/** 编辑器内的协议 URL（Windows 为 `http://richasset.localhost/<name>`），保存时还原。 */
const PROTOCOL_URL_PATTERN = /https?:\/\/richasset\.localhost\/([\w-]+\.[a-z0-9]+)/g

function htmlForEditor(html: string) {
  if (!isDesktopClient) return html
  return html.replace(ASSET_REF_PATTERN, (_match, name: string) => desktopApi.richAssetUrl(name))
}

function htmlForSave(html: string) {
  return html.replace(PROTOCOL_URL_PATTERN, (_match, name: string) => `assets/${name}`)
}

interface RichTextDialogProps {
  initialHtml: string
  onCancel: () => void
  /** 保存并关闭。 */
  onSave: (html: string, plain: string) => void
  /** 就地保存：写回内容但不关闭弹窗，方便边看画布边继续写。 */
  onQuickSave: (html: string, plain: string) => void
}

export default function RichTextDialog({
  initialHtml,
  onCancel,
  onSave,
  onQuickSave,
}: RichTextDialogProps) {
  const editorHost = useRef<HTMLDivElement>(null)
  const toolbarHost = useRef<HTMLDivElement>(null)
  const editorRef = useRef<IDomEditor | null>(null)
  // 初始内容只在挂载时读取一次：编辑器自身持有文档状态，不必让 React 参与回流。
  const initialRef = useRef(initialHtml)
  /**
   * 是否有未保存改动：由编辑器的 change 事件标记，而不是比对 HTML 字符串——
   * wangEditor 会把初始 HTML 规范化（补 <p> 等），字符串比对会一打开就判定为「已修改」。
   */
  const dirtyRef = useRef(false)
  const { message, modal } = AntApp.useApp()

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
        // 内容变化只打一个标记：用于 Ctrl+S 幂等与取消时确认，不参与渲染。
        onChange: () => {
          dirtyRef.current = true
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
      // 初始化过程可能触发一次 change，这里归零，避免空改动也弹确认。
      dirtyRef.current = false
    }
    attempt(10)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      editor?.destroy()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 弹窗生命周期内 message 实例不变
  }, [])

  const handleSave = () => {
    const editor = editorRef.current
    if (!editor) return
    onSave(htmlForSave(editor.getHtml()), editor.getText())
  }

  /** 当前编辑器内容是否与打开时不同；用于 Ctrl+S 的幂等判断与取消时确认。 */
  const isDirty = () => dirtyRef.current

  const handleQuickSave = () => {
    const editor = editorRef.current
    if (!editor || !dirtyRef.current) return
    const html = htmlForSave(editor.getHtml())
    onQuickSave(html, editor.getText())
    // 就地保存后把基线推进到当前内容：再点取消不该提示「有未保存修改」。
    initialRef.current = html
    dirtyRef.current = false
  }

  const requestCancel = () => {
    if (!isDirty()) {
      onCancel()
      return
    }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '这篇富文本还有改动没有保存，关闭后会丢失。',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: onCancel,
    })
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
      cancelText="取消"
      onOk={handleSave}
      onCancel={requestCancel}
      styles={{ body: { paddingTop: 8 } }}
    >
      <div className="rich-editor" onKeyDown={handleKeyDown}>
        <div ref={toolbarHost} className="rich-editor-toolbar" />
        <div ref={editorHost} className="rich-editor-body" />
      </div>
      <p className="rich-editor-hint">Ctrl+S 保存但不关闭；点「保存」写回画布并关闭。</p>
    </Modal>
  )
}
