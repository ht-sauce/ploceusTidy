/**
 * 工作空间容器：组合场景 store、桌面动作、持久化、快捷键与各功能组件。
 * 这里是唯一把「领域能力」接到「界面」上的地方，App 只负责主题壳。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp } from 'antd'
import type { SceneNode, SearchEntry, ThemeId } from '@/types/scene'
import CanvasBoard, { type CanvasBoardHandle } from '@/canvas/CanvasBoard'
import TitleBar, { type TitleBarHandle } from '@/components/TitleBar'
import DetailsPanel from '@/components/DetailsPanel'
import SettingsDialog from '@/components/SettingsDialog'
import ImagePreviewDialog from '@/components/ImagePreviewDialog'
import EdgeLabelDialog from '@/components/EdgeLabelDialog'
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
  const [edgeLabel, setEdgeLabel] = useState<{ id: string; text: string } | null>(null)

  const canvasRef = useRef<CanvasBoardHandle>(null)
  const titleBarRef = useRef<TitleBarHandle>(null)

  const { results } = useSearch(query, store.nodes, store.annotations, store.nodeById)

  /** 只有场景为空且用户未主动收起时才显示引导。 */
  const showEmpty = store.nodes.length === 0 && !emptyDismissed

  // ---------- 桌面动作 ----------

  const actions = useNodeActions({
    message,
    onNodePatched: (node: SceneNode) =>
      store.setNodes((previous) => previous.map((item) => (item.id === node.id ? node : item))),
    locate: (id) => canvasRef.current?.locateNode(id),
    editText: (id) => canvasRef.current?.editText(id),
    select: (id) => store.selectNode(id, false),
  })

  const importers = useImportClipboard({
    store,
    message,
    getCenterWorld: () => canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 },
    locate: (id) => canvasRef.current?.locateNode(id),
  })

  const onHydrated = useCallback((isEmpty: boolean) => setEmptyDismissed(!isEmpty), [])
  const onImportPaths = useCallback(
    (paths: string[]) => {
      void importers.importPaths(paths)
    },
    [importers],
  )

  const { workspace, setWorkspace } = useScenePersistence({
    store,
    message,
    onHydrated,
    onImportPaths,
  })

  // ---------- 右键菜单 ----------

  const contextMenu = useContextMenu({
    store,
    message,
    openNode: (node) => void actions.openNode(node),
    reveal: (node) => void actions.reveal(node),
    editText: (id) => canvasRef.current?.editText(id),
    editEdgeLabel: (id) => {
      const edge = store.edges.find((item) => item.id === id)
      store.selectEdge(id)
      setEdgeLabel({ id, text: edge?.label ?? '' })
    },
  })

  // ---------- 场景命令（带提示） ----------

  const createSpace = useCallback(() => {
    const group = store.createGroup('新空间')
    if (!group) message.info('先框选或选中要放进空间的对象')
    else message.success('已创建空间：拖动空间可整体移动，四向圆点可连线')
  }, [message, store])

  const deleteSelected = useCallback(() => {
    if (!store.deleteSelection()) return
    message.info('已删除；Ctrl+Z 可撤销')
  }, [message, store])

  const undo = useCallback(() => {
    if (store.undo()) message.success('已撤销')
    else message.info('没有可撤销的删除操作')
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

  const handleEdgeLabelSave = useCallback(
    (text: string) => {
      if (!edgeLabel) return
      store.toggleEdgeLabel(edgeLabel.id, text)
      setEdgeLabel(null)
      message.success(text.trim() ? '连线标签已保存' : '连线标签已清除')
    },
    [edgeLabel, message, store],
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
    canvasRef.current?.locateNode(entry.nodeId)
    store.selectNode(entry.nodeId, false)
    if (entry.annotationId) {
      const annotation = store.annotations.find((item) => item.id === entry.annotationId)
      if (annotation) store.openAnnotation(annotation)
    }
  }

  const openResult = (entry: SearchEntry) => {
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
          onSelect={store.selectNode}
          onBoxSelect={store.boxSelect}
          onClearSelection={store.clearSelection}
          onSelectGroup={store.selectGroup}
          onMoveGroup={store.moveGroup}
          onMoveNodes={store.moveNodes}
          onSelectEdge={store.selectEdge}
          onEdgeLabelEdit={(id) => {
            const edge = store.edges.find((item) => item.id === id)
            store.selectEdge(id)
            setEdgeLabel({ id, text: edge?.label ?? '' })
          }}
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
        onSceneCleared={() => {
          store.setNodes([])
          store.setGroups([])
          store.setEdges([])
          store.setAnnotations([])
          store.clearSelection()
          setEmptyDismissed(false)
        }}
      />
      <ImagePreviewDialog
        open={actions.previewState.open}
        src={actions.previewState.src}
        title={actions.previewState.title}
        onClose={actions.closePreview}
      />
      <EdgeLabelDialog
        key={edgeLabel?.id ?? 'no-edge'}
        edgeId={edgeLabel?.id ?? null}
        initialText={edgeLabel?.text ?? ''}
        onCancel={() => setEdgeLabel(null)}
        onSave={handleEdgeLabelSave}
      />
    </div>
  )
}
