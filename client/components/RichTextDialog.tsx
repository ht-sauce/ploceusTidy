/**
 * 富文本内容弹窗：文章书写与修改都在这里完成。
 *
 * 边界：
 * - 直接用 wangEditor 的 `createEditor` / `createToolbar`，不用 React 包装层，
 *   编辑器自行接管容器 DOM（交给 React 渲染子节点会与内部的 slate 视图冲突）；
 * - 该组件由上层按需 `import()` 加载，富文本依赖因此不进首屏分包；
 * - 保存时同时取出 HTML（正文）与纯文本（卡片名称、搜索用投影）；
 * - 图片/视频只走本地上传（Raw IPC 二进制直传到工作空间 assets），
 *   网络图/网络视频入口被移除，编辑器内不发任何网络请求（HC-13）。
 */
import { useEffect, useRef } from 'react'
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
  onSave: (html: string, plain: string) => void
}

export default function RichTextDialog({ initialHtml, onCancel, onSave }: RichTextDialogProps) {
  const editorHost = useRef<HTMLDivElement>(null)
  const toolbarHost = useRef<HTMLDivElement>(null)
  const editorRef = useRef<IDomEditor | null>(null)
  // 初始内容只在挂载时读取一次：编辑器自身持有文档状态，不必让 React 参与回流。
  const initialRef = useRef(initialHtml)
  const { message } = AntApp.useApp()

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
