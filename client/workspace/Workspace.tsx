/**
 * 工作空间容器：组合场景 store、桌面动作、持久化、快捷键与各功能组件。
 * 这里是唯一把「领域能力」接到「界面」上的地方，App 只负责主题壳。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AntApp from 'antd/es/app'
import Button from 'antd/es/button'
import { listen } from '@tauri-apps/api/event'
import type { SceneNode, SearchEntry, ThemeId } from '@/types/scene'
import CanvasBoard, { type CanvasBoardHandle } from '@/canvas/CanvasBoard'
import { GROUP_PALETTE } from '@/canvas/constants'
import { edgeColorOf } from '@/canvas/geometry'
import { themeById } from '@/lib/theme'
import TitleBar, { type TitleBarHandle } from '@/components/TitleBar'
import DetailsPanel from '@/components/DetailsPanel'
import SettingsDialog from '@/components/SettingsDialog'
import TextPromptDialog from '@/components/TextPromptDialog'
import TextContentDialog from '@/components/TextContentDialog'
import ColorPickerDialog from '@/components/ColorPickerDialog'
import NeighborPickerDialog from '@/components/NeighborPickerDialog'
import type { NeighborOption } from '@/components/NeighborPickerDialog'
import ContextMenu from '@/components/ContextMenu'
import StatusBar from '@/components/StatusBar'
import OutlinePanel from '@/components/OutlinePanel'
import ContentManagerDialog from '@/components/ContentManagerDialog'
import EmptyOverlay from '@/components/EmptyOverlay'
import { desktopApi, desktopWindow, isDesktopClient } from '@/lib/tauri-api'
import { useSceneStore } from './useSceneStore'
import { useSearch, type SearchFilter } from './useSearch'
import { useNodeActions } from './useNodeActions'
import { useImportClipboard, isTypingTarget } from './useImportClipboard'
import { useScenePersistence } from './useScenePersistence'
import { useContextMenu } from './useContextMenu'
import { useShortcuts } from './useShortcuts'
import { useWindowSuspended } from './useWindowSuspended'

interface WorkspaceProps {
  themeId: ThemeId
  onThemeChange: (id: ThemeId) => void
}

/** 最近定位/打开记录的存储键：纯界面状态，换机不迁移。 */
const RECENT_KEY = 'ploceus.recent'

/** 富文本编辑器按需加载：wangEditor 及其依赖不进首屏分包，只在打开富文本时拉取。 */
const RichTextDialog = lazy(() => import('@/components/RichTextDialog'))

export default function Workspace({ themeId, onThemeChange }: WorkspaceProps) {
  const { message, modal } = AntApp.useApp()
  const store = useSceneStore()
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 空态由「场景是否为空」派生，避免在 effect 里同步 state。
  const [emptyDismissed, setEmptyDismissed] = useState(false)
  const [scale, setScale] = useState(0.82)
  /** 单行文本弹窗：连线标签与空间标题共用。 */
  const [prompt, setPrompt] = useState<{
    kind: 'edge' | 'group'
    id: string
    text: string
  } | null>(null)
  const [colorPicker, setColorPicker] = useState<{
    kind: 'group' | 'edge'
    id: string
    value?: string
    fallback: string
  } | null>(null)
  const [neighbors, setNeighbors] = useState<{ options: NeighborOption[] } | null>(null)
  /** 内容编辑：文字与富文本统一走弹窗；正文按需加载，弹窗持有已取到的那份。 */
  const [contentEditor, setContentEditor] = useState<{ id: string; body: string } | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [contentManagerOpen, setContentManagerOpen] = useState(false)
  const [searchFilter, setSearchFilter] = useState<SearchFilter>('all')
  /** 最近定位/打开的对象：只存在本机 localStorage，纯界面记忆，不进数据库。 */
  const [recentIds, setRecentIds] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : []
    } catch {
      return []
    }
  })
  /** 「最小化时暂停渲染」偏好；真正的暂停状态由窗口事件驱动。 */
  const [pauseWhenMinimized, setPauseWhenMinimized] = useState(true)

  const canvasRef = useRef<CanvasBoardHandle>(null)
  const titleBarRef = useRef<TitleBarHandle>(null)

  const { results } = useSearch(
    query,
    store.nodes,
    store.groups,
    store.edges,
    store.annotations,
    store.nodeById,
    searchFilter,
    recentIds,
  )

  /** 记一条「最近」：定位或打开时调用，最多保留 12 条。 */
  const rememberRecent = useCallback((id: string) => {
    setRecentIds((previous) => {
      const next = [id, ...previous.filter((item) => item !== id)].slice(0, 12)
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // 存储不可用时只保留内存态，不影响定位。
      }
      return next
    })
  }, [])

  const suspended = useWindowSuspended(pauseWhenMinimized)

  useEffect(() => {
    if (!isDesktopClient) return
    desktopApi
      .metaGet('pause_when_minimized')
      .then((value) => setPauseWhenMinimized(value !== '0'))
      .catch(() => {
        // 配置读取失败时保持默认开启。
      })
  }, [])

  /** 只有场景为空且用户未主动收起时才显示引导。 */
  const showEmpty = store.nodes.length === 0 && !emptyDismissed

  // ---------- 桌面动作 ----------

  // 这些回调会进入拖入/导入 hook 的依赖链，保持稳定，避免重复订阅拖放事件。
  const locateById = useCallback((id: string) => canvasRef.current?.locateTarget(id), [])
  /** 打开内容弹窗：首屏不加载正文，这里按需取一次并交给弹窗。 */
  const openContentEditor = useCallback(
    (id: string) => {
      const node = store.nodeById.get(id)
      if (!node) return
      if (node.body !== undefined) {
        setContentEditor({ id, body: node.body })
        return
      }
      void desktopApi
        .nodeBody(id)
        .then((body) => setContentEditor({ id, body: body ?? '' }))
        .catch((error) => message.error(`读取内容失败：${String(error)}`))
    },
    [message, store.nodeById],
  )
  const selectNode = store.selectNode
  const selectById = useCallback((id: string) => selectNode(id, false), [selectNode])
  const getCenterWorld = useCallback(
    () => canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 },
    [],
  )
  /** 新建对象的落点：鼠标在画布上的最后位置；指针没进过画布时回退视口中心。 */
  const getLandingPoint = useCallback(
    () => canvasRef.current?.getPointerWorld() ?? getCenterWorld(),
    [getCenterWorld],
  )

  const actions = useNodeActions({
    message,
    onNodePatched: (node: SceneNode) =>
      store.setNodes((previous) => previous.map((item) => (item.id === node.id ? node : item))),
    locate: locateById,
    editText: openContentEditor,
    select: selectById,
  })

  const importers = useImportClipboard({
    store,
    message,
    // 失败项交给界面层逐条列出：只报第一条会掩盖真实失败面（HC-14）。
    onImportErrors: (errors) => {
      const limit = 8
      const shown = errors.slice(0, limit)
      modal.error({
        title: `${errors.length} 项导入失败`,
        width: 620,
        content: (
          <div className="import-error-list">
            {shown.map((item) => (
              <p key={`${item.path}-${item.reason}`}>
                {item.path} — {item.reason}
              </p>
            ))}
            {errors.length > limit ? <p>…另有 {errors.length - limit} 项失败</p> : null}
          </div>
        ),
      })
    },
    getLandingPoint,
    getImportCenter: getCenterWorld,
    locate: locateById,
  })
  const { importPaths, importClipboardFiles, pasteImage, pasteText, importProgress, cancelImport } =
    importers

  const onHydrated = useCallback((isEmpty: boolean) => setEmptyDismissed(!isEmpty), [])
  const onImportPaths = useCallback(
    (paths: string[]) => {
      void importPaths(paths)
    },
    [importPaths],
  )

  const { workspace, setWorkspace, hydrated, saveState, flush } = useScenePersistence({
    store,
    message,
    onHydrated,
    onImportPaths,
  })

  // 场景加载完成后恢复上次视口；无记录时适配全部内容，避免启动后停在空白处。
  const viewportRestored = useRef(false)
  useEffect(() => {
    if (!hydrated || viewportRestored.current) return
    viewportRestored.current = true
    void (async () => {
      const restored = await canvasRef.current?.restoreViewport()
      if (!restored) canvasRef.current?.fitView()
    })()
  }, [hydrated])

  // ---------- 右键菜单动作 ----------

  const themeTokens = themeById(themeId)

  const openEdgeLabel = useCallback(
    (id: string) => {
      const edge = store.edges.find((item) => item.id === id)
      store.selectEdge(id)
      setPrompt({ kind: 'edge', id, text: edge?.label ?? '' })
    },
    // 只依赖边数组与选中动作：store 每次渲染都是新对象，用它会瓦解下游 memo。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.edges, store.selectEdge],
  )

  const openGroupTitle = useCallback(
    (id: string) => {
      const group = store.groupById.get(id)
      if (!group) return
      store.selectGroup(id)
      setPrompt({ kind: 'group', id, text: group.title })
    },
    // 同 openEdgeLabel：按需收窄依赖，保持回调引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.groupById, store.selectGroup],
  )

  const openGroupColor = useCallback(
    (id: string) => {
      const group = store.groupById.get(id)
      if (!group) return
      setColorPicker({
        kind: 'group',
        id,
        value: group.color,
        fallback: themeTokens.primary,
      })
    },
    [store.groupById, themeTokens.primary],
  )

  const openEdgeColor = useCallback(
    (id: string) => {
      const edge = store.edges.find((item) => item.id === id)
      if (!edge) return
      setColorPicker({
        kind: 'edge',
        id,
        value: edgeColorOf(edge, themeTokens.primary),
        fallback: themeTokens.primary,
      })
    },
    [store.edges, themeTokens.primary],
  )

  /** 跳跃式导航：一个对象连了多个目标时先让用户选，只有一个时直接跳。 */
  const locateNeighbor = useCallback(
    (nodeId: string) => {
      const options = new Map<string, NeighborOption>()
      store.edges.forEach((edge) => {
        if (edge.from !== nodeId && edge.to !== nodeId) return
        const otherId = edge.from === nodeId ? edge.to : edge.from
        if (options.has(otherId)) return
        const node = store.nodeById.get(otherId)
        const group = store.groupById.get(otherId)
        if (node) options.set(otherId, { id: otherId, label: node.name, kind: 'node' })
        else if (group) options.set(otherId, { id: otherId, label: group.title, kind: 'group' })
      })
      const list = Array.from(options.values())
      if (list.length === 0) {
        message.info('该对象还没有关联连线')
        return
      }
      if (list.length === 1) {
        const only = list[0]
        canvasRef.current?.locateTarget(only.id)
        if (only.kind === 'group') store.selectGroup(only.id)
        else store.selectNode(only.id, false)
        return
      }
      setNeighbors({ options: list })
    },
    [message, store],
  )

  const arrangeSpace = useCallback(
    (id: string) => {
      const count = store.arrangeGroup(id)
      if (count > 0) message.success(`已整理 ${count} 个对象`)
      else message.info('空间内还没有对象')
    },
    [message, store],
  )

  /** 一键整理画布：空间收框 + 空间与散置对象装箱排列。 */
  const tidyWholeCanvas = useCallback(() => {
    const count = store.tidyCanvas()
    if (count > 0) message.success(`已整理 ${count} 个单元`)
    else message.info('画布上还没有内容')
  }, [message, store])

  // ---------- 原文件复制与拖出 ----------

  /** 拖出到外部程序：只传有真实路径的对象 ID，路径由 Rust 侧查库解析（不信任前端路径）。 */
  const dragOut = useCallback(
    (ids: string[]) => {
      if (!isDesktopClient) {
        message.info('拖出到外部程序仅在桌面客户端可用')
        return
      }
      void desktopApi
        .startDragOut(ids)
        .catch((error) => message.error(`拖出失败：${String(error)}`))
    },
    [message],
  )

  /** 复制原文件到剪贴板（CF_HDROP）：粘贴到资源管理器或 IDE 即可拿到原始地址。 */
  const copyFiles = useCallback(
    (ids: string[]) => {
      if (!isDesktopClient) {
        message.info('复制文件仅在桌面客户端可用')
        return
      }
      void desktopApi
        .copyRefFiles(ids)
        .then((count) => {
          if (count > 0) message.success(`已复制 ${count} 个文件，可粘贴到资源管理器或 IDE`)
        })
        .catch((error) => message.error(`复制失败：${String(error)}`))
    },
    [message],
  )

  const contextMenu = useContextMenu({
    store,
    openNode: (node) => void actions.openNode(node),
    reveal: (node) => void actions.reveal(node),
    editText: openContentEditor,
    editEdgeLabel: openEdgeLabel,
    renameGroup: openGroupTitle,
    arrangeGroup: arrangeSpace,
    tidyCanvas: tidyWholeCanvas,
    pickGroupColor: openGroupColor,
    pickEdgeColor: openEdgeColor,
    locateNeighbor,
    copyFiles,
    openSystemMenu: (nodeId, x, y) => {
      if (!isDesktopClient) {
        message.info('系统右键菜单仅在桌面客户端可用')
        return
      }
      void desktopApi
        .showSystemMenu(nodeId, x, y)
        .catch((error) => message.error(`打开系统菜单失败：${String(error)}`))
    },
  })

  // ---------- 场景命令（带提示） ----------

  /** Ctrl+C：复制选中对象里有真实路径的那些。 */
  const copySelectedFiles = useCallback(() => {
    const ids = store.selectedIds.filter((id) => store.nodeById.get(id)?.path)
    if (ids.length === 0) {
      message.info('先选中文件或文件夹，再复制原文件')
      return
    }
    copyFiles(ids)
  }, [copyFiles, message, store.nodeById, store.selectedIds])

  const createSpace = useCallback(() => {
    // 自动编号 + 调色板轮换，多个空间无需手动改名也能区分。
    const group = store.createGroup(
      `空间 ${store.groups.length + 1}`,
      GROUP_PALETTE[store.groups.length % GROUP_PALETTE.length],
    )
    if (!group) message.info('先框选或选中要放进空间的对象')
    else message.success('已创建空间：拖动空间可整体移动，四向圆点可连线')
  }, [message, store])

  const deleteSelected = useCallback(() => {
    if (!store.deleteSelection()) return
    message.info('已删除；Ctrl+Z 可撤销')
  }, [message, store])

  const undo = useCallback(() => {
    if (store.undo()) message.success('已撤销')
    else message.info('没有可撤销的操作')
  }, [message, store])

  const redo = useCallback(() => {
    if (store.redo()) message.success('已重做')
    else message.info('没有可重做的操作')
  }, [message, store])

  /** Ctrl+S：绕过去抖立即落库，不改变选中与弹窗状态。 */
  const saveNow = useCallback(() => {
    void flush()
      .then(() => message.success('已保存'))
      .catch(() => {
        // 失败提示已在持久化层弹出，这里不再重复。
      })
  }, [flush, message])

  /** 方向键微调：只在有选中对象时生效，避免空按也弹提示。 */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (store.selectedIds.length === 0) return
      store.nudgeSelected(dx, dy)
    },
    [store],
  )

  /**
   * 重新校验引用：全量比对磁盘状态（空数组即全量），把 `isExists` 写回场景。
   * 供设置面板手动触发——文件在资源管理器里被搬走后不必重启应用。
   */
  const revalidateRefs = useCallback(() => {
    if (!isDesktopClient) {
      message.info('引用校验仅在桌面客户端可用')
      return
    }
    void desktopApi
      .refCheck([])
      .then((statuses) => {
        const statusMap = new Map(statuses.map((item) => [item.nodeId, item.isExists]))
        store.setNodes((previous) =>
          previous.map((node) =>
            statusMap.has(node.id) ? { ...node, isExists: statusMap.get(node.id) ?? true } : node,
          ),
        )
        const missing = statuses.filter((item) => !item.isExists).length
        message.success(
          missing
            ? `校验完成：${statuses.length} 个引用，${missing} 个缺失`
            : `校验完成：${statuses.length} 个引用均可用`,
        )
      })
      .catch((error) => message.error(`校验失败：${String(error)}`))
  }, [message, store])

  const linkSelected = useCallback(() => {
    const ids = store.selectedIds
    if (ids.length < 2) {
      message.info('先选中至少两个对象：Shift 点击或左键拖拽空白框选，再按 L')
      return
    }
    const [source, ...targets] = ids
    const existing = new Set(store.edges.map((edge) => `${edge.from}->${edge.to}`))
    const additions = targets.filter(
      (target) => target !== source && !existing.has(`${source}->${target}`),
    )
    if (additions.length === 0) {
      message.info('这些对象之间已经存在同向连线')
      return
    }
    additions.forEach((target) => store.connect(source, target))
    message.success(`已建立 ${additions.length} 条有向连线`)
  }, [message, store])

  /** E 键：收起或重新打开空态引导（场景有内容时引导不会出现）。 */
  const toggleEmpty = useCallback(() => {
    if (!showEmpty) {
      store.clearSelection()
      setEmptyDismissed(false)
      return
    }
    setEmptyDismissed(true)
  }, [showEmpty, store])

  const handlePromptSave = useCallback(
    (text: string) => {
      if (!prompt) return
      if (prompt.kind === 'edge') {
        store.toggleEdgeLabel(prompt.id, text)
        message.success(text.trim() ? '连线标签已保存' : '连线标签已清除')
      } else {
        store.renameGroup(prompt.id, text)
        message.success('空间标题已更新')
      }
      setPrompt(null)
    },
    [message, prompt, store],
  )

  const handleColorSave = useCallback(
    (color: string) => {
      if (!colorPicker) return
      if (colorPicker.kind === 'group') {
        store.setGroupColor(colorPicker.id, color)
        message.success('空间颜色已更新')
      } else {
        store.setEdgeColor(colorPicker.id, color)
        message.success('连线颜色已更新')
      }
      setColorPicker(null)
    },
    [colorPicker, message, store],
  )

  const pickNeighbor = useCallback(
    (id: string) => {
      canvasRef.current?.locateTarget(id)
      if (store.groupById.has(id)) store.selectGroup(id)
      else store.selectNode(id, false)
      setNeighbors(null)
    },
    [store],
  )

  // ---------- 快捷键 ----------

  useShortcuts({
    onUndo: undo,
    onRedo: redo,
    onSave: saveNow,
    onNudge: nudge,
    onSelectAll: () => store.setSelectedIds(store.nodes.map((node) => node.id)),
    onDelete: deleteSelected,
    onCopyFiles: copySelectedFiles,
    onLink: linkSelected,
    onGroup: createSpace,
    onToggleEmpty: toggleEmpty,
    onSettings: () => setSettingsOpen(true),
    onEscape: () => {
      if (settingsOpen) setSettingsOpen(false)
      else if (contextMenu.menu) contextMenu.close()
      else if (store.selectedIds.length > 0 || store.selectedGroupId || store.selectedEdgeId) {
        store.clearSelection()
      } else if (showEmpty) setEmptyDismissed(true)
    },
    onFocusSearch: () => titleBarRef.current?.focusSearch(),
    onOpenDevtools: () => {
      if (isDesktopClient) void desktopApi.openDevtools()
    },
  })

  // ---------- 外部入口 ----------

  // 全局热键 Ctrl+Alt+Space：窗口被唤起后直接聚焦搜索。
  useEffect(() => {
    if (!isDesktopClient) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void listen('shortcut://focus-search', () => titleBarRef.current?.focusSearch())
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {
        // 热键事件订阅失败只影响「唤起即搜索」，窗口仍会正常激活。
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 双击文件 /「发送到」/ 命令行带进来的路径：启动时取一次，运行中由单实例转发。
  useEffect(() => {
    if (!isDesktopClient) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void desktopApi
      .takePendingImports()
      .then((paths) => {
        if (!disposed && paths.length > 0) void importPaths(paths)
      })
      .catch(() => {
        // 没有待导入项或读取失败都不影响启动。
      })
    void listen<string[]>('import://external', (event) => {
      void importPaths(event.payload)
    })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {
        // 订阅失败时仍可通过拖入/粘贴导入。
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [importPaths])

  // ---------- 粘贴 ----------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isDesktopClient || isTypingTarget(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        void importClipboardFiles()
      }
    }

    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return
      const clipboard = event.clipboardData
      if (!clipboard) return

      const imageItem = Array.from(clipboard.items).find((item) => item.type.startsWith('image/'))
      if (isDesktopClient && clipboard.files.length > 0) {
        event.preventDefault()
        const imageFile =
          imageItem?.getAsFile() ??
          Array.from(clipboard.files).find((file) => file.type.startsWith('image/')) ??
          null
        void importClipboardFiles().then((handled) => {
          if (handled) return
          if (imageFile) void pasteImage(imageFile)
          else message.info('剪贴板里没有可导入的文件路径')
        })
        return
      }

      const text = clipboard.getData('text/plain').trim()
      if (text) {
        event.preventDefault()
        pasteText(text)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [importClipboardFiles, message, pasteImage, pasteText])

  // ---------- 搜索与详情 ----------

  const selectResult = (entry: SearchEntry) => {
    if (entry.groupId) {
      canvasRef.current?.locateTarget(entry.groupId)
      store.selectGroup(entry.groupId)
      return
    }
    if (entry.edgeId) {
      canvasRef.current?.locateEdge(entry.edgeId)
      store.selectEdge(entry.edgeId)
      return
    }
    canvasRef.current?.locateNode(entry.nodeId)
    store.selectNode(entry.nodeId, false)
    rememberRecent(entry.nodeId)
    if (entry.annotationId) {
      const annotation = store.annotations.find((item) => item.id === entry.annotationId)
      if (annotation) store.openAnnotation(annotation)
    }
  }

  const openResult = (entry: SearchEntry) => {
    // 空间与连线没有可打开的原文件，Ctrl+Enter 退化为定位。
    if (entry.groupId || entry.edgeId) {
      selectResult(entry)
      return
    }
    const node = store.nodeById.get(entry.nodeId)
    if (!node) return
    rememberRecent(node.id)
    void actions.openNode(node)
  }

  const contentNode = contentEditor ? (store.nodeById.get(contentEditor.id) ?? null) : null
  /** 只把文字与富文本两类交给内容管理，文件引用不在其中。 */
  const managedNodes = useMemo(
    () => store.nodes.filter((node) => node.kind === 'text' || node.kind === 'richtext'),
    [store.nodes],
  )

  return (
    <div className="app-shell">
      <TitleBar
        ref={titleBarRef}
        query={query}
        results={results}
        onQueryChange={setQuery}
        onSelectResult={selectResult}
        onOpenResult={openResult}
        onNewText={() =>
          importers.createTextNode('双击或右键编辑内容；适合记录结论、待办或项目说明。')
        }
        onNewRichText={() => {
          importers.createRichTextNode()
          message.info('双击新富文本卡片开始写作')
        }}
        onSettings={() => setSettingsOpen(true)}
        onOpenContentManager={() => setContentManagerOpen(true)}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((previous) => !previous)}
        filter={searchFilter}
        onFilterChange={setSearchFilter}
        onMinimize={() => void desktopWindow.minimize()}
        onMaximize={() => void desktopWindow.toggleMaximize()}
        onClose={() => void desktopWindow.close()}
      />

      <div className="workspace">
        {outlineOpen ? (
          <OutlinePanel
            nodes={store.nodes}
            groups={store.groups}
            selectedIds={store.selectedIds}
            selectedGroupId={store.selectedGroupId}
            onLocateNode={(id) => {
              canvasRef.current?.locateNode(id)
              store.selectNode(id, false)
              rememberRecent(id)
            }}
            onLocateGroup={(id) => {
              canvasRef.current?.locateTarget(id)
              store.selectGroup(id)
            }}
            onClose={() => setOutlineOpen(false)}
          />
        ) : null}

        <CanvasBoard
          ref={canvasRef}
          themeId={themeId}
          nodes={store.nodes}
          groups={store.groups}
          edges={store.edges}
          annotations={store.annotations}
          selectedIds={store.selectedIds}
          selectedGroupId={store.selectedGroupId}
          selectedEdgeId={store.selectedEdgeId}
          detailsOpen={Boolean(store.detailsNode)}
          paused={suspended}
          viewportPersistReady={hydrated && isDesktopClient}
          onSelect={store.selectNode}
          onBoxSelect={store.boxSelect}
          onClearSelection={store.clearSelection}
          onSelectGroup={store.selectGroup}
          onMoveGroup={store.moveGroup}
          onResizeGroup={store.resizeGroup}
          onMoveNodes={store.moveNodes}
          onSelectEdge={store.selectEdge}
          onEdgeLabelEdit={openEdgeLabel}
          onGroupTitleEdit={openGroupTitle}
          onConnect={store.connect}
          onReconnectEdge={store.reconnectEdge}
          onAnnotation={store.openAnnotation}
          onActivate={(id) => {
            const node = store.nodeById.get(id)
            if (node) actions.activate(node)
          }}
          onEditContent={openContentEditor}
          onDragOut={dragOut}
          onScaleChange={setScale}
          onToggleGroupCollapse={(id) => {
            const group = store.groupById.get(id)
            if (group) store.setGroupCollapsed(id, !group.collapsed)
          }}
          onContextMenu={contextMenu.open}
        />

        {importProgress ? (
          <div className="import-progress" role="status" aria-live="polite">
            <div className="import-progress-head">
              <span>
                正在导入 {importProgress.done} / {importProgress.total}
              </span>
              <Button size="small" type="text" onClick={cancelImport}>
                取消
              </Button>
            </div>
            <div className="import-progress-bar">
              <span
                style={{
                  width: `${importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="import-progress-current">{importProgress.current}</span>
          </div>
        ) : null}

        {store.detailsNode || (store.detailsMode === 'annotation' && store.activeAnnotation) ? (
          <DetailsPanel
            key={
              store.detailsMode === 'annotation' && store.activeAnnotation
                ? store.activeAnnotation.id
                : `details-${store.detailsNode?.id ?? 'none'}`
            }
            node={store.detailsNode}
            annotation={store.activeAnnotation}
            annotationTargets={store.annotationTargets}
            mode={store.detailsMode}
            onClose={store.closeDetails}
            onRelink={(node) => void actions.relink(node)}
            onSaveAnnotation={(text) => {
              store.saveAnnotation(text)
              message.success('标注已保存')
            }}
            onDeleteAnnotation={() => {
              store.removeAnnotation()
              message.success('标注已删除')
            }}
            onSaveDataJson={(id, dataJson) => {
              store.updateNodeDataJson(id, dataJson)
              return true
            }}
          />
        ) : null}

        {showEmpty ? <EmptyOverlay onDismiss={() => setEmptyDismissed(true)} /> : null}

        {contextMenu.menu ? (
          <ContextMenu
            x={contextMenu.menu.x}
            y={contextMenu.menu.y}
            entries={contextMenu.entries}
            onAction={contextMenu.act}
          />
        ) : null}
      </div>

      <StatusBar
        nodeCount={store.nodes.length}
        selectedCount={store.selectedIds.length}
        scale={scale}
        saveState={saveState}
        onLink={linkSelected}
        onCreateSpace={createSpace}
        onDelete={deleteSelected}
        onZoomOut={() => canvasRef.current?.zoomBy(0.85)}
        onZoomIn={() => canvasRef.current?.zoomBy(1.15)}
        onFit={() => canvasRef.current?.fitView()}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeId={themeId}
        onThemeChange={onThemeChange}
        workspace={workspace}
        onWorkspaceChanged={setWorkspace}
        onPauseWhenMinimizedChange={setPauseWhenMinimized}
        onRevalidateRefs={revalidateRefs}
        onSceneCleared={() => {
          store.setNodes([])
          store.setGroups([])
          store.setEdges([])
          store.setAnnotations([])
          store.clearSelection()
          setEmptyDismissed(false)
        }}
      />
      <TextPromptDialog
        key={prompt ? `${prompt.kind}-${prompt.id}` : 'no-prompt'}
        open={Boolean(prompt)}
        title={prompt?.kind === 'group' ? '重命名空间' : '连线标签'}
        placeholder={prompt?.kind === 'group' ? '给空间一个能区分的名字' : '留空则清除标签'}
        initialText={prompt?.text ?? ''}
        maxLength={prompt?.kind === 'group' ? 20 : 24}
        onCancel={() => setPrompt(null)}
        onSave={handlePromptSave}
      />
      <ColorPickerDialog
        key={colorPicker ? `${colorPicker.kind}-${colorPicker.id}` : 'no-color'}
        open={Boolean(colorPicker)}
        title={colorPicker?.kind === 'group' ? '空间颜色' : '连线颜色'}
        value={colorPicker?.value}
        fallback={colorPicker?.fallback ?? themeTokens.primary}
        onCancel={() => setColorPicker(null)}
        onSave={handleColorSave}
      />
      <NeighborPickerDialog
        open={Boolean(neighbors)}
        options={neighbors?.options ?? []}
        onCancel={() => setNeighbors(null)}
        onPick={pickNeighbor}
      />

      {contentNode ? (
        contentNode.kind === 'richtext' ? (
          <Suspense fallback={null}>
            <RichTextDialog
              key={contentNode.id}
              initialHtml={contentEditor?.body ?? ''}
              onCancel={() => setContentEditor(null)}
              onQuickSave={(html, plain) => {
                store.commitContent(contentNode.id, html, plain)
                setContentEditor({ id: contentNode.id, body: html })
                message.success('已保存，可继续编辑')
              }}
              onSave={(html, plain) => {
                store.commitContent(contentNode.id, html, plain)
                setContentEditor(null)
                message.success('富文本已保存')
              }}
            />
          </Suspense>
        ) : (
          <TextContentDialog
            key={contentNode.id}
            initialText={contentEditor?.body ?? contentNode.subtitle ?? ''}
            onCancel={() => setContentEditor(null)}
            onQuickSave={(text) => {
              store.commitContent(contentNode.id, text, text)
              setContentEditor({ id: contentNode.id, body: text })
              message.success('已保存，可继续编辑')
            }}
            onSave={(text) => {
              store.commitContent(contentNode.id, text, text)
              setContentEditor(null)
              message.success('文字已保存')
            }}
          />
        )
      ) : null}

      <ContentManagerDialog
        open={contentManagerOpen}
        nodes={managedNodes}
        groups={store.groups}
        onClose={() => setContentManagerOpen(false)}
        onLocate={(id) => {
          canvasRef.current?.locateNode(id)
          store.selectNode(id, false)
          rememberRecent(id)
        }}
        onEdit={openContentEditor}
        onMoveToGroup={(id, groupId) => {
          store.moveNodeToGroup(id, groupId)
          message.success(groupId ? '已移动到空间末尾' : '已移出空间')
        }}
        onDelete={(id) => {
          store.deleteTarget({ kind: 'node', id })
          message.info('已删除；Ctrl+Z 可撤销')
        }}
      />
    </div>
  )
}
