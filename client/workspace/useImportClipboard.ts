/**
 * 导入与剪贴板：文件路径导入、文字/链接节点创建、截图落盘、粘贴事件分发。
 * 依赖场景 store 的写入能力，不直接触碰视口细节。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
import { listen } from '@tauri-apps/api/event'
import type { ImportError, ImportProgress, SceneNode } from '@/types/scene'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
import { findFreeOffset, LAYOUT_GAP, nodeRect } from '@/domain/layout'
import { mergeNodes, type SceneStore } from './useSceneStore'

interface ImportOptions {
  store: SceneStore
  message: MessageInstance
  /** 失败项汇总上报（由界面层渲染弹窗）：只报第一条会让用户误以为只失败了一项。 */
  onImportErrors: (errors: ImportError[]) => void
  /** 新建对象的落点：优先取鼠标在画布上的最后位置，鼠标从未进入画布时回退视口中心。 */
  getLandingPoint: () => { x: number; y: number }
  /** 系统拖入/剪贴板导入的落点：用视口中心，与鼠标当时的位置无关。 */
  getImportCenter: () => { x: number; y: number }
  locate: (id: string) => void
}

/** 快捷键必须避开输入框，否则会吞掉用户正在输入的内容。 */
export function isTypingTarget(target: EventTarget | null) {
  const element = target as Element | null
  return typeof element?.closest === 'function'
    ? Boolean(element.closest('input, textarea, [contenteditable="true"]'))
    : false
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取截图失败'))
    reader.readAsDataURL(file)
  })
}

export function useImportClipboard({
  store,
  message,
  onImportErrors,
  getLandingPoint,
  getImportCenter,
  locate,
}: ImportOptions) {
  const { addNode, setNodes, setSelectedIds, markHistory } = store
  /** 正在进行的导入：进度条与取消按钮都读它，导入结束置空。 */
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(
    null,
  )
  const jobRef = useRef<string | null>(null)
  // 导入是异步命令，用 ref 读取最新场景做避让，避免闭包拿到旧数组。
  const nodesRef = useRef(store.nodes)
  const annotationsRef = useRef(store.annotations)
  useEffect(() => {
    nodesRef.current = store.nodes
    annotationsRef.current = store.annotations
  }, [store.annotations, store.nodes])
  // 同一次粘贴可能同时触发 keydown 与 paste 事件，500ms 内只处理一次。
  const clipboardGuard = useRef(0)
  // 同一次拖入可能被重复派发 drop；相同路径在短窗口内只导入一次，避免「已存在」刷屏。
  const importGuard = useRef<{ key: string; at: number }>({ key: '', at: 0 })

  const focusNewNode = useCallback(
    (node: SceneNode) => {
      addNode(node)
      window.setTimeout(() => locate(node.id), 0)
    },
    [addNode, locate],
  )

  const createTextNode = useCallback(
    (text: string) => {
      const center = getLandingPoint()
      const firstLine = text.split('\n').find((line) => line.trim()) ?? '新文字'
      focusNewNode({
        id: `text-${crypto.randomUUID()}`,
        kind: 'text',
        icon: 'text',
        name: firstLine.slice(0, 28),
        subtitle: text,
        body: text,
        groupId: '',
        z: 0,
        isExists: true,
        x: Math.round(center.x - 36),
        y: Math.round(center.y - 32),
        w: 72,
        h: 64,
      })
    },
    [focusNewNode, getLandingPoint],
  )

  /**
   * 富文本卡片：`body` 存 HTML、`subtitle` 存纯文本投影，落点与纯文本一致，
   * 因此同样按所在位置自动归属空间。
   */
  const createRichTextNode = useCallback(() => {
    const center = getLandingPoint()
    focusNewNode({
      id: `richtext-${crypto.randomUUID()}`,
      kind: 'richtext',
      icon: 'rich',
      name: '新富文本',
      subtitle: '',
      body: '',
      groupId: '',
      z: 0,
      isExists: true,
      x: Math.round(center.x - 36),
      y: Math.round(center.y - 32),
      w: 72,
      h: 64,
    })
  }, [focusNewNode, getLandingPoint])

  const createLinkNode = useCallback(
    (url: string) => {
      const center = getLandingPoint()
      let host = '链接'
      try {
        host = new URL(url).hostname
      } catch {
        // 保留默认域名
      }
      focusNewNode({
        id: `link-${crypto.randomUUID()}`,
        kind: 'link',
        icon: 'link',
        name: url.replace(/^https?:\/\//, '').slice(0, 48),
        subtitle: host,
        url,
        groupId: '',
        z: 0,
        isExists: true,
        x: Math.round(center.x - 36),
        y: Math.round(center.y - 32),
        w: 72,
        h: 64,
      })
    },
    [focusNewNode, getLandingPoint],
  )

  const pasteText = useCallback(
    (text: string) => {
      if (/^https?:\/\//i.test(text)) createLinkNode(text)
      else createTextNode(text)
    },
    [createLinkNode, createTextNode],
  )

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!isDesktopClient || paths.length === 0) return
      // 进度条与「取消」都绑在单个 job 上：并发导入会互相覆盖，
      // 先结束的那个还会把仍在跑的 job 的进度条清掉。这里直接拒绝第二次。
      if (jobRef.current) {
        message.info('上一批导入还在进行，完成后再试')
        return
      }
      const unique = Array.from(new Set(paths))
      const signature = unique.join('|')
      const now = Date.now()
      if (importGuard.current.key === signature && now - importGuard.current.at < 1200) return
      importGuard.current = { key: signature, at: now }
      const center = getImportCenter()
      const jobId = `import-${crypto.randomUUID()}`
      jobRef.current = jobId
      setProgress({ done: 0, total: unique.length, current: '' })
      // 进度是可选增强：监听失败也要能继续导入。
      let unlisten: (() => void) | undefined
      try {
        unlisten = await listen<ImportProgress>('import://progress', (event) => {
          if (event.payload.jobId !== jobId || jobRef.current !== jobId) return
          setProgress({
            done: event.payload.done,
            total: event.payload.total,
            current: event.payload.current,
          })
        })
      } catch {
        unlisten = undefined
      }

      try {
        const result = await desktopApi.importPaths(unique, center.x, center.y, jobId)
        if (result.created.length || result.existing.length) {
          // Rust 按固定网格放置新对象；若落点压在已有对象上，整簇平移到最近空位。
          const annotated = new Set(
            annotationsRef.current.flatMap((annotation) => annotation.nodeIds),
          )
          const offset = findFreeOffset(
            result.created.map((node) => nodeRect(node, false)),
            nodesRef.current.map((node) => nodeRect(node, annotated.has(node.id))),
            LAYOUT_GAP,
          )
          const created = result.created.map((node) => ({
            ...node,
            x: Math.round(node.x + offset.dx),
            y: Math.round(node.y + offset.dy),
          }))
          markHistory()
          setNodes((previous) => mergeNodes(previous, [...created, ...result.existing]))
          const target = created[0] ?? result.existing[0]
          if (target) {
            setSelectedIds([target.id])
            window.setTimeout(() => locate(target.id), 0)
          }
        }
        if (result.cancelled) {
          message.info(
            `已取消导入：已处理 ${result.created.length + result.existing.length} 项，其余未导入`,
          )
        } else if (result.created.length) {
          message.success(`已导入 ${result.created.length} 个引用`)
        }
        if (result.existing.length) {
          message.info(`已存在，已定位：${result.existing[0].name}`)
        }
        if (result.errors.length) onImportErrors(result.errors)
      } catch (error) {
        message.error(`导入失败：${String(error)}`)
      } finally {
        unlisten?.()
        // 只清理自己的 job：别把别人的进度条与取消句柄一起清掉。
        if (jobRef.current === jobId) {
          jobRef.current = null
          setProgress(null)
        }
      }
    },
    [getImportCenter, locate, markHistory, message, onImportErrors, setNodes, setSelectedIds],
  )

  /** 取消当前导入：Rust 在批次边界停下，已处理的部分照常入库。 */
  const cancelImport = useCallback(() => {
    const jobId = jobRef.current
    if (!jobId) return
    void desktopApi.cancelImport(jobId).catch(() => {
      // 取消失败不影响导入继续跑完；错误已在 IPC 层记日志。
    })
  }, [])

  const pasteImage = useCallback(
    async (file: File) => {
      if (!isDesktopClient) {
        message.info('截图粘贴仅在桌面客户端中可用')
        return
      }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const base64 = dataUrl.split(',')[1] ?? ''
        const ext = file.type.split('/')[1] || 'png'
        const path = await desktopApi.saveClipboardImage(base64, ext)
        const center = getLandingPoint()
        focusNewNode({
          id: `image-${crypto.randomUUID()}`,
          kind: 'image',
          icon: 'image',
          name: `截图-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}.${ext}`,
          path,
          subtitle: '剪贴板截图',
          groupId: '',
          z: 0,
          isExists: true,
          x: Math.round(center.x - 36),
          y: Math.round(center.y - 32),
          w: 72,
          h: 64,
        })
        message.success('截图已放入画布')
      } catch (error) {
        message.error(`截图粘贴失败：${String(error)}`)
      }
    },
    [focusNewNode, getLandingPoint, message],
  )

  /** 读取资源管理器复制到剪贴板的文件；返回是否处理了文件。 */
  const importClipboardFiles = useCallback(async () => {
    const now = Date.now()
    if (now - clipboardGuard.current < 500) return true
    try {
      const paths = await desktopApi.readClipboardFiles()
      if (paths.length === 0) return false
      clipboardGuard.current = now
      await importPaths(paths)
      return true
    } catch {
      return false
    }
  }, [importPaths])

  return {
    importProgress: progress,
    cancelImport,
    createTextNode,
    createRichTextNode,
    createLinkNode,
    pasteText,
    pasteImage,
    importPaths,
    importClipboardFiles,
  }
}
