/**
 * 工作空间容器：组合场景 store、桌面动作、持久化、快捷键与各功能组件。
 * 这里是唯一把「领域能力」接到「界面」上的地方，App 只负责主题壳。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import AntApp from 'antd/es/app'
import type { SceneNode, SearchEntry, ThemeId } from '@/types/scene'
import CanvasBoard, { type CanvasBoardHandle } from '@/canvas/CanvasBoard'
import { GROUP_PALETTE } from '@/canvas/constants'
import { edgeColorOf } from '@/canvas/geometry'
import { themeById } from '@/lib/theme'
import TitleBar, { type TitleBarHandle } from '@/components/TitleBar'
import DetailsPanel from '@/components/DetailsPanel'
import SettingsDialog from '@/components/SettingsDialog'
import TextPromptDialog from '@/components/TextPromptDialog'
import ColorPickerDialog from '@/components/ColorPickerDialog'
import NeighborPickerDialog from '@/components/NeighborPickerDialog'
import type { NeighborOption } from '@/components/NeighborPickerDialog'
import ContextMenu from '@/components/ContextMenu'
import StatusBar from '@/components/StatusBar'
import EmptyOverlay from '@/components/EmptyOverlay'
import { desktopApi, desktopWindow, isDesktopClient } from '@/lib/tauri-api'
import { useSceneStore } from './useSceneStore'
import { useSearch } from './useSearch'
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

export default function Workspace({ themeId, onThemeChange }: WorkspaceProps) {
  const { message } = AntApp.useApp()
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
  )

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
  const editTextById = useCallback((id: string) => canvasRef.current?.editText(id), [])
  const selectNode = store.selectNode
  const selectById = useCallback((id: string) => selectNode(id, false), [selectNode])
  const getCenterWorld = useCallback(
    () => canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 },
    [],
  )

  const actions = useNodeActions({
    message,
    onNodePatched: (node: SceneNode) =>
      store.setNodes((previous) => previous.map((item) => (item.id === node.id ? node : item))),
    locate: locateById,
    editText: editTextById,
    select: selectById,
  })

  const importers = useImportClipboard({
    store,
    message,
    getCenterWorld,
    locate: locateById,
  })
  const { importPaths } = importers

  const onHydrated = useCallback((isEmpty: boolean) => setEmptyDismissed(!isEmpty), [])
  const onImportPaths = useCallback(
    (paths: string[]) => {
      void importPaths(paths)
    },
    [importPaths],
  )

  const { workspace, setWorkspace } = useScenePersistence({
    store,
    message,
    onHydrated,
    onImportPaths,
  })

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

  const contextMenu = useContextMenu({
    store,
    openNode: (node) => void actions.openNode(node),
    reveal: (node) => void actions.reveal(node),
    editText: (id) => canvasRef.current?.editText(id),
    editEdgeLabel: openEdgeLabel,
    renameGroup: openGroupTitle,
    arrangeGroup: arrangeSpace,
    pickGroupColor: openGroupColor,
    pickEdgeColor: openEdgeColor,
    locateNeighbor,
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
    onSelectAll: () => store.setSelectedIds(store.nodes.map((node) => node.id)),
    onDelete: deleteSelected,
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

  // ---------- 粘贴 ----------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isDesktopClient || isTypingTarget(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        void importers.importClipboardFiles()
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
        void importers.importClipboardFiles().then((handled) => {
          if (handled) return
          if (imageFile) void importers.pasteImage(imageFile)
          else message.info('剪贴板里没有可导入的文件路径')
        })
        return
      }

      const text = clipboard.getData('text/plain').trim()
      if (text) {
        event.preventDefault()
        importers.pasteText(text)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [importers, message])

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
    if (node) void actions.openNode(node)
  }

  return (
    <div className="app-shell">
      <TitleBar
        ref={titleBarRef}
        query={query}
        results={results}
        onQueryChange={setQuery}
        onSelectResult={selectResult}
        onOpenResult={openResult}
        onNewText={() => importers.createTextNode('双击编辑文字；适合记录结论、待办或项目说明。')}
        onSettings={() => setSettingsOpen(true)}
        onMinimize={() => void desktopWindow.minimize()}
        onMaximize={() => void desktopWindow.toggleMaximize()}
        onClose={() => void desktopWindow.close()}
      />

      <div className="workspace">
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
          onAnnotation={store.openAnnotation}
          onActivate={(id) => {
            const node = store.nodeById.get(id)
            if (node) actions.activate(node)
          }}
          onTextCommit={(id, text, live) => {
            store.commitText(id, text, live)
            if (!live) message.success('文字已保存')
          }}
          onScaleChange={setScale}
          onContextMenu={contextMenu.open}
        />

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
    </div>
  )
}
