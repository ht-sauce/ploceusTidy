/**
 * 场景持久化：从工作空间加载、防抖保存、启动/聚焦时的缺失校验、拖入监听。
 * 只做「场景 ↔ 工作空间」的同步，不含任何界面状态。
 */
import { useEffect, useRef, useState } from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { WorkspaceInfo } from '@/types/scene'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
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
  // 校验任务读取最新节点，但不希望 nodes 变化触发重新校验。
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
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

  // 350ms 防抖：拖动节点时避免每一帧都写库。
  useEffect(() => {
    if (!isDesktopClient || !hydrated) return
    const timer = window.setTimeout(() => {
      desktopApi
        .saveScene({ nodes, groups, edges, annotations })
        .catch((error) => message.error(`保存失败：${String(error)}`))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [annotations, edges, groups, hydrated, message, nodes])

  // 启动后空闲分批校验引用：每批 400 个，批间让出主线程。
  useEffect(() => {
    if (!isDesktopClient || !hydrated) return
    let cancelled = false
    const pathIds = nodesRef.current
      .filter((node) => node.path && node.kind !== 'link')
      .map((node) => node.id)
    if (pathIds.length === 0) return

    const run = async () => {
      for (let index = 0; index < pathIds.length; index += 400) {
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
        await new Promise((resolve) => window.setTimeout(resolve, 120))
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

  return { workspace, setWorkspace, hydrated }
}
