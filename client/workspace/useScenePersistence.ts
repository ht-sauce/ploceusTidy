/**
 * 场景持久化：从工作空间加载、防抖保存、启动/聚焦时的缺失校验、拖入监听。
 * 只做「场景 ↔ 工作空间」的同步，不含任何界面状态。
 *
 * 保存链路的边界：
 * - 350ms 防抖避免拖动时每帧写库；`flush` 绕过去抖立即落库（Ctrl+S 与关窗都用它）；
 * - 关窗必须先把待保存内容写进库再放行，否则「改完就关」会静默丢最后一笔。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { WorkspaceInfo } from '@/types/scene'
import { desktopApi, isDesktopClient, subscribeSaveState, type SaveState } from '@/lib/tauri-api'
import type { SceneStore } from './useSceneStore'

interface PersistenceOptions {
  store: SceneStore
  message: MessageInstance
  onHydrated: (empty: boolean) => void
  onImportPaths: (paths: string[]) => void
}

export function useScenePersistence({
  store,
  message,
  onHydrated,
  onImportPaths,
}: PersistenceOptions) {
  const { nodes, groups, edges, annotations, setNodes, setGroups, setEdges, setAnnotations } = store
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [hydrated, setHydrated] = useState(!isDesktopClient)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // 校验任务读取最新节点，但不希望 nodes 变化触发重新校验。
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  })

  // 保存状态从 IPC 层订阅：状态栏据此显示真实结果，不再恒亮「已保存」。
  useEffect(() => subscribeSaveState(setSaveState), [])

  /** 最新场景引用：flush 与关窗都要读「此刻」的数据，而不是某次渲染的闭包。 */
  const sceneRef = useRef({ nodes, groups, edges, annotations })
  useEffect(() => {
    sceneRef.current = { nodes, groups, edges, annotations }
  })

  // 首次加载：场景与工作空间信息一起取，失败时降级为空画布并提示。
  useEffect(() => {
    if (!isDesktopClient) return
    let cancelled = false
    Promise.all([desktopApi.loadScene(), desktopApi.workspaceGet()])
      .then(([scene, info]) => {
        if (cancelled) return
        setNodes(scene.nodes)
        setGroups(scene.groups)
        setEdges(scene.edges)
        setAnnotations(scene.annotations)
        setWorkspace(info)
        setHydrated(true)
        onHydrated(scene.nodes.length === 0)
      })
      .catch((error) => {
        if (cancelled) return
        message.error(`加载工作空间失败：${String(error)}`)
        setHydrated(true)
        onHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [message, onHydrated, setAnnotations, setEdges, setGroups, setNodes])

  const saveNow = useCallback(async () => {
    // 未完成加载前禁止写库：此时 sceneRef 还是空场景，写进去等于清库。
    if (!isDesktopClient || !hydrated) return
    try {
      await desktopApi.saveScene(sceneRef.current)
    } catch (error) {
      message.error(`保存失败：${String(error)}`)
      throw error
    }
  }, [hydrated, message])

  const timerRef = useRef<number | null>(null)

  // 350ms 防抖：拖动节点时避免每一帧都写库。
  useEffect(() => {
    if (!isDesktopClient || !hydrated) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void saveNow().catch(() => {
        // 错误已由 saveNow 上报；这里只做兜底，避免未处理的 Promise 拒绝。
      })
    }, 350)
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [annotations, edges, groups, hydrated, nodes, saveNow])

  /** 立即落库：跳过防抖窗口。失败向上抛，由调用方决定是否阻止关闭。 */
  const flush = useCallback(async () => {
    if (!isDesktopClient) return
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await saveNow()
  }, [saveNow])

  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })

  /**
   * 关窗守卫：拦下 close-requested，先 flush 再真正关闭。
   * 保存失败时不放行并提示原因——宁可让用户重试，也不静默丢数据。
   */
  useEffect(() => {
    if (!isDesktopClient) return
    let unlisten: (() => void) | undefined
    let disposed = false
    /** 已保存并放行关闭：再次进入处理器时不再拦截，交给默认关闭流程。 */
    let closing = false
    /** 正在落库：重复点击关闭只拦下，不重复发起保存。 */
    let flushing = false
    const window = getCurrentWindow()
    void window
      .onCloseRequested(async (event) => {
        if (closing) return
        event.preventDefault()
        if (flushing) return
        flushing = true
        try {
          await flushRef.current()
        } catch {
          flushing = false
          message.error('保存失败，已取消关闭；请处理后再试')
          return
        }
        closing = true
        await window.close()
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch((error) => message.error(`监听关闭事件失败：${String(error)}`))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [message])

  // 启动后空闲分批校验引用：每批 400 个，批间让出主线程并等待空闲帧——
  // 校验是写操作（每批一个事务），不能与拖动/平移等视图操作同时进行。
  useEffect(() => {
    if (!isDesktopClient || !hydrated) return
    let cancelled = false
    const pathIds = nodesRef.current
      .filter((node) => node.path && node.kind !== 'link')
      .map((node) => node.id)
    if (pathIds.length === 0) return

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
    const waitForIdle = () =>
      new Promise<void>((resolve) => {
        if (typeof idleWindow.requestIdleCallback === 'function') {
          idleWindow.requestIdleCallback(() => resolve(), { timeout: 800 })
        } else {
          window.setTimeout(resolve, 120)
        }
      })

    const run = async () => {
      for (let index = 0; index < pathIds.length; index += 400) {
        if (cancelled) return
        // 先等空闲再发起本批：用户正在操作画布时校验主动靠边。
        await waitForIdle()
        if (cancelled) return
        const batch = pathIds.slice(index, index + 400)
        try {
          const statuses = await desktopApi.refCheck(batch)
          if (cancelled) return
          const statusMap = new Map(statuses.map((item) => [item.nodeId, item.isExists]))
          setNodes((previous) =>
            previous.map((node) =>
              statusMap.has(node.id) ? { ...node, isExists: statusMap.get(node.id) ?? true } : node,
            ),
          )
        } catch {
          return
        }
      }
    }

    const timer = window.setTimeout(() => void run(), 900)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hydrated, setNodes])

  // 窗口重新聚焦时补查当前选中项，覆盖「离开期间文件被移动或删除」。
  const selectedKey = store.selectedIds.join(',')
  useEffect(() => {
    if (!isDesktopClient) return
    const onFocus = () => {
      const ids = selectedKey ? selectedKey.split(',') : []
      if (ids.length === 0) return
      void desktopApi
        .refCheck(ids)
        .then((statuses) => {
          const statusMap = new Map(statuses.map((item) => [item.nodeId, item.isExists]))
          setNodes((previous) =>
            previous.map((node) =>
              statusMap.has(node.id) ? { ...node, isExists: statusMap.get(node.id) ?? true } : node,
            ),
          )
        })
        .catch(() => {
          // 聚焦校验失败不影响交互，下次启动会再次检查。
        })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [selectedKey, setNodes])

  // Tauri 拖入事件直接给绝对路径，导入与去重统一交给 Rust 侧处理。
  useEffect(() => {
    if (!isDesktopClient) return
    let unlisten: (() => void) | undefined
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') onImportPaths(event.payload.paths)
      })
      .then((dispose) => {
        unlisten = dispose
      })
      .catch((error) => message.error(`监听拖入失败：${String(error)}`))
    return () => {
      unlisten?.()
    }
  }, [message, onImportPaths])

  return { workspace, setWorkspace, hydrated, saveState, flush }
}
