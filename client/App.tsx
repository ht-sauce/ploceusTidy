/**
 * 应用根组件：持有场景状态，串联画布、标题栏、详情面板与 Tauri 能力。
 *
 * 职责边界：
 * - 场景数据与选中状态只在这里维护，子组件通过回调上报；
 * - 文件系统、剪贴板、SQLite 一律走 `desktopApi`，前端不直接访问；
 * - 浏览器模式下用模拟数据预览界面，桌面模式下从工作空间加载。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as AntApp, Button, Tooltip } from 'antd'
import {
  ApartmentOutlined,
  DeleteOutlined,
  FullscreenOutlined,
  MinusOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { sceneAnnotations, sceneEdges, sceneGroups, sceneNodes } from '@/data/mock-scene'
import type { SceneAnnotation, SceneEdge, SceneNode, SearchEntry } from '@/types/scene'
import CanvasBoard, { type CanvasBoardHandle } from '@/components/CanvasBoard'
import TitleBar, { type TitleBarHandle } from '@/components/TitleBar'
import DetailsPanel from '@/components/DetailsPanel'
import SettingsDialog from '@/components/SettingsDialog'
import TextEditorDialog from '@/components/TextEditorDialog'
import ImagePreviewDialog from '@/components/ImagePreviewDialog'
import { desktopApi, desktopWindow, isDesktopClient } from '@/lib/tauri-api'

/** 删除前快照，仅保留一步，用于 Ctrl+Z 撤销。 */
interface SceneSnapshot {
  nodes: SceneNode[]
  edges: SceneEdge[]
  annotations: SceneAnnotation[]
}

/** 合并导入结果：已有节点按 id 覆盖，重复导入不会产生第二张卡片。 */
function mergeNodes(current: SceneNode[], incoming: SceneNode[]) {
  const map = new Map(current.map((node) => [node.id, node]))
  incoming.forEach((node) => map.set(node.id, node))
  return Array.from(map.values())
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取截图失败'))
    reader.readAsDataURL(file)
  })
}

/** 快捷键必须避开输入框，否则会吞掉用户正在输入的内容。 */
function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return Boolean(element?.closest('input, textarea, [contenteditable="true"]'))
}

// ---------- 场景状态与派生数据 ----------

export default function App() {
  const { message } = AntApp.useApp()
  const [nodes, setNodes] = useState<SceneNode[]>(isDesktopClient ? [] : sceneNodes)
  const [edges, setEdges] = useState<SceneEdge[]>(isDesktopClient ? [] : sceneEdges)
  const [annotations, setAnnotations] = useState<SceneAnnotation[]>(
    isDesktopClient ? [] : sceneAnnotations,
  )
  const [hydrated, setHydrated] = useState(!isDesktopClient)
  const [workspacePath, setWorkspacePath] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null)
  const [detailsMode, setDetailsMode] = useState<'details' | 'annotation'>('details')
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [empty, setEmpty] = useState(false)
  const [scale, setScale] = useState(0.82)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewSrc, setPreviewSrc] = useState('')
  const [previewTitle, setPreviewTitle] = useState('')

  const canvasRef = useRef<CanvasBoardHandle>(null)
  const titleBarRef = useRef<TitleBarHandle>(null)
  const undoRef = useRef<SceneSnapshot | null>(null)
  // 同一次粘贴可能同时触发 keydown 与 paste 事件，500ms 内只处理一次。
  const clipboardGuard = useRef(0)

  const groups = isDesktopClient ? [] : sceneGroups
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const selectedNode = selectedIds.length
    ? (nodeById.get(selectedIds[selectedIds.length - 1]) ?? null)
    : null
  const activeAnnotation = activeAnnotationId
    ? (annotations.find((annotation) => annotation.id === activeAnnotationId) ?? null)
    : null
  const annotationTargets = useMemo(
    () =>
      activeAnnotation
        ? activeAnnotation.nodeIds
            .map((id) => nodeById.get(id))
            .filter((node): node is SceneNode => Boolean(node))
        : [],
    [activeAnnotation, nodeById],
  )
  const editingText = editingTextId ? (nodeById.get(editingTextId) ?? null) : null

  const searchEntries = useMemo(() => {
    const entries: SearchEntry[] = []

    nodes.forEach((node) => {
      entries.push({
        nodeId: node.id,
        type: node.kind,
        title: node.name,
        subtitle: node.path ?? node.url ?? node.subtitle,
        icon: node.icon,
        searchText: `${node.name} ${node.path ?? ''} ${node.subtitle} ${node.body ?? ''} ${node.url ?? ''}`,
      })
    })

    annotations.forEach((annotation) => {
      const [firstNodeId] = annotation.nodeIds
      if (!firstNodeId) return
      const target = nodeById.get(firstNodeId)
      entries.push({
        nodeId: firstNodeId,
        type: 'annotation',
        title: annotation.text,
        subtitle: `标注 · ${target?.name ?? '对象'}`,
        icon: 'text',
        searchText: `${annotation.text} ${target?.name ?? ''}`,
        annotationId: annotation.id,
      })
    })

    return entries
  }, [annotations, nodeById, nodes])

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return searchEntries.slice(0, 6)
    return searchEntries
      .filter((entry) => entry.searchText.toLowerCase().includes(normalized))
      .slice(0, 9)
  }, [query, searchEntries])

  const handleSelectNode = useCallback((id: string, additive: boolean) => {
    setSelectedIds((previous) => {
      if (!additive) return [id]
      return previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    })
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleBoxSelect = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((previous) => (additive ? Array.from(new Set([...previous, ...ids])) : ids))
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedIds([])
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleMoveNodes = useCallback((moves: { id: string; x: number; y: number }[]) => {
    const byId = new Map(moves.map((move) => [move.id, move]))
    setNodes((previous) =>
      previous.map((node) => {
        const move = byId.get(node.id)
        return move ? { ...node, x: move.x, y: move.y } : node
      }),
    )
  }, [])

  const addNodeAtCenter = useCallback((node: SceneNode) => {
    setNodes((previous) => [...previous, node])
    setSelectedIds([node.id])
    setActiveAnnotationId(null)
    setDetailsMode('details')
    window.setTimeout(() => canvasRef.current?.locateNode(node.id), 0)
  }, [])

  // ---------- 节点创建 ----------

  const createTextNode = useCallback(
    (text: string) => {
      const center = canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 }
      const firstLine = text.split('\n').find((line) => line.trim()) ?? '新文字'
      const node: SceneNode = {
        id: `text-${Date.now()}`,
        kind: 'text',
        icon: 'text',
        name: firstLine.slice(0, 28),
        subtitle: text,
        body: text,
        groupId: 'other',
        x: Math.round(center.x - 88),
        y: Math.round(center.y - 14),
        w: 176,
        h: 28,
      }
      addNodeAtCenter(node)
    },
    [addNodeAtCenter],
  )

  const createLinkNode = useCallback(
    (url: string) => {
      const center = canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 }
      let host = '链接'
      try {
        host = new URL(url).hostname
      } catch {
        // 保留默认域名
      }
      const node: SceneNode = {
        id: `link-${Date.now()}`,
        kind: 'link',
        icon: 'link',
        name: url.replace(/^https?:\/\//, '').slice(0, 48),
        subtitle: host,
        url,
        groupId: 'other',
        x: Math.round(center.x - 88),
        y: Math.round(center.y - 14),
        w: 176,
        h: 28,
      }
      addNodeAtCenter(node)
    },
    [addNodeAtCenter],
  )

  // ---------- 导入、打开与预览 ----------

  const handleImportPaths = useCallback(
    async (paths: string[]) => {
      if (!isDesktopClient || paths.length === 0) return
      const center = canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 }

      try {
        const result = await desktopApi.importPaths(paths, center.x, center.y)
        if (result.created.length || result.existing.length) {
          setNodes((previous) => mergeNodes(previous, [...result.created, ...result.existing]))
          const target = result.created[0] ?? result.existing[0]
          if (target) {
            setSelectedIds([target.id])
            setActiveAnnotationId(null)
            setDetailsMode('details')
            window.setTimeout(() => canvasRef.current?.locateNode(target.id), 0)
          }
        }

        if (result.created.length) {
          setEmpty(false)
          message.success(`已导入 ${result.created.length} 个引用`)
        }
        if (result.existing.length) {
          message.info(`已存在，已定位：${result.existing[0].name}`)
        }
        if (result.errors.length) {
          const [first] = result.errors
          message.error(`导入失败 ${result.errors.length} 项：${first.path}（${first.reason}）`)
        }
      } catch (error) {
        message.error(`导入失败：${String(error)}`)
      }
    },
    [message],
  )

  const handlePreview = useCallback(
    async (node: SceneNode) => {
      if (!isDesktopClient) {
        message.info('演示：桌面客户端内用 Ant Design 图片预览')
        return
      }
      try {
        const src = await desktopApi.previewRef(node.id)
        setPreviewSrc(src)
        setPreviewTitle(node.name)
        setPreviewOpen(true)
      } catch (error) {
        message.error(`预览失败：${String(error)}`)
      }
    },
    [message],
  )

  const openNode = async (node: SceneNode) => {
    if (node.kind === 'text') {
      setEditingTextId(node.id)
      return
    }
    if (node.kind === 'image') {
      await handlePreview(node)
      return
    }

    if (isDesktopClient) {
      try {
        await desktopApi.openRef(node.id)
        return
      } catch (error) {
        message.error(`打开失败：${String(error)}`)
        return
      }
    }

    if (node.kind === 'link') {
      message.info(`演示：用系统浏览器打开 ${node.url ?? node.name}`)
    } else if (node.kind === 'folder') {
      message.info(`演示：在资源管理器中打开 ${node.name}`)
    } else if (node.kind === 'video') {
      message.info(`演示：用系统播放器打开 ${node.name}`)
    } else {
      message.info(`演示：打开原文件 ${node.name}`)
    }
  }

  const handleReveal = async (node: SceneNode) => {
    if (node.kind === 'text' || node.kind === 'link') return

    if (isDesktopClient) {
      try {
        await desktopApi.revealRef(node.id)
        return
      } catch (error) {
        message.error(`定位失败：${String(error)}`)
        return
      }
    }

    message.info(`演示：在资源管理器中定位 ${node.name}`)
  }

  // ---------- 标注与文字编辑 ----------

  const handleAnnotation = (annotation: SceneAnnotation) => {
    setSelectedIds(annotation.nodeIds)
    setActiveAnnotationId(annotation.id)
    setDetailsMode('annotation')
  }

  const handleAddAnnotation = () => {
    if (selectedIds.length === 0) return
    const existing = annotations.find(
      (annotation) =>
        annotation.nodeIds.length === selectedIds.length &&
        selectedIds.every((id) => annotation.nodeIds.includes(id)),
    )
    if (existing) {
      handleAnnotation(existing)
      return
    }

    const annotation: SceneAnnotation = {
      id: `annotation-${Date.now()}`,
      nodeIds: [...selectedIds],
      color: 'teal',
      text: '补充说明：把关键结论或下一步动作写在这里。',
    }
    setAnnotations((previous) => [...previous, annotation])
    setActiveAnnotationId(annotation.id)
    setDetailsMode('annotation')
  }

  const handleSaveAnnotation = (text: string) => {
    if (!activeAnnotation) return
    setAnnotations((previous) =>
      previous.map((annotation) =>
        annotation.id === activeAnnotation.id
          ? { ...annotation, text: text.trim() || '空标注' }
          : annotation,
      ),
    )
    message.success('标注已保存')
  }

  const handleDeleteAnnotation = () => {
    if (!activeAnnotation) return
    setAnnotations((previous) =>
      previous.filter((annotation) => annotation.id !== activeAnnotation.id),
    )
    setActiveAnnotationId(null)
    setDetailsMode('details')
    message.success('标注已删除')
  }

  const handleSaveText = (nodeId: string, text: string) => {
    const firstLine = text.split('\n').find((line) => line.trim()) ?? '新文字'
    setNodes((previous) =>
      previous.map((node) =>
        node.id === nodeId
          ? { ...node, name: firstLine.slice(0, 28), subtitle: text, body: text }
          : node,
      ),
    )
    setEditingTextId(null)
    message.success('文字已保存')
  }

  const handleSelectResult = (entry: SearchEntry) => {
    canvasRef.current?.locateNode(entry.nodeId)
    setSelectedIds([entry.nodeId])

    if (entry.annotationId) {
      setActiveAnnotationId(entry.annotationId)
      setDetailsMode('annotation')
    } else {
      setActiveAnnotationId(null)
      setDetailsMode('details')
    }
  }

  const handleOpenResult = (entry: SearchEntry) => {
    const node = nodeById.get(entry.nodeId)
    if (node) void openNode(node)
  }

  const handleActivate = (id: string) => {
    const node = nodeById.get(id)
    if (!node) return
    setSelectedIds([id])
    void openNode(node)
  }

  // ---------- 连线、删除与撤销 ----------

  const handleLinkSelected = useCallback(() => {
    if (selectedIds.length < 2) {
      message.info('先选中至少两个对象：Shift 点击或 Shift 框选，再按 L')
      return
    }
    const [source, ...targets] = selectedIds
    const existing = new Set(edges.map((edge) => `${edge.from}->${edge.to}`))
    const additions = targets
      .filter((target) => target !== source && !existing.has(`${source}->${target}`))
      .map((target) => ({
        id: `edge-${crypto.randomUUID()}`,
        from: source,
        to: target,
      }))

    if (additions.length === 0) {
      message.info('这些对象之间已经存在同向连线')
      return
    }

    setEdges((previous) => [...previous, ...additions])
    message.success(`已建立 ${additions.length} 条有向连线`)
  }, [edges, message, selectedIds])

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return
    undoRef.current = { nodes, edges, annotations }
    const ids = new Set(selectedIds)
    setNodes((previous) => previous.filter((node) => !ids.has(node.id)))
    setEdges((previous) => previous.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)))
    setAnnotations((previous) =>
      previous
        .map((annotation) => ({
          ...annotation,
          nodeIds: annotation.nodeIds.filter((id) => !ids.has(id)),
        }))
        .filter((annotation) => annotation.nodeIds.length > 0),
    )
    setSelectedIds([])
    setActiveAnnotationId(null)
    setDetailsMode('details')
    message.info('已从画布删除；Ctrl+Z 可撤销')
  }, [annotations, edges, message, nodes, selectedIds])

  const handleUndo = useCallback(() => {
    const snapshot = undoRef.current
    if (!snapshot) {
      message.info('没有可撤销的删除操作')
      return
    }
    undoRef.current = null
    setNodes(snapshot.nodes)
    setEdges(snapshot.edges)
    setAnnotations(snapshot.annotations)
    setSelectedIds([])
    setActiveAnnotationId(null)
    setDetailsMode('details')
    message.success('已撤销')
  }, [message])

  // ---------- 剪贴板与截图 ----------

  const handlePasteText = useCallback(
    (text: string) => {
      if (/^https?:\/\//i.test(text)) createLinkNode(text)
      else createTextNode(text)
    },
    [createLinkNode, createTextNode],
  )

  const importClipboardFiles = useCallback(async () => {
    const now = Date.now()
    if (now - clipboardGuard.current < 500) return true
    try {
      const paths = await desktopApi.readClipboardFiles()
      if (paths.length === 0) return false
      clipboardGuard.current = now
      await handleImportPaths(paths)
      return true
    } catch {
      return false
    }
  }, [handleImportPaths])

  const handlePasteImage = useCallback(
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
        const center = canvasRef.current?.getCenterWorld() ?? { x: 260, y: 260 }
        const node: SceneNode = {
          id: `image-${Date.now()}`,
          kind: 'image',
          icon: 'image',
          name: `截图-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}.${ext}`,
          path,
          subtitle: '剪贴板截图',
          groupId: 'other',
          x: Math.round(center.x - 88),
          y: Math.round(center.y - 14),
          w: 176,
          h: 28,
        }
        addNodeAtCenter(node)
        message.success('截图已放入画布')
      } catch (error) {
        message.error(`截图粘贴失败：${String(error)}`)
      }
    },
    [addNodeAtCenter, message],
  )

  const handleDuplicate = useCallback(() => {
    const node = nodeById.get('bid-0')
    if (!node) {
      message.info('重复文件会在拖入或粘贴时自动定位')
      return
    }
    canvasRef.current?.locateNode('bid-0')
    setSelectedIds(['bid-0'])
    setActiveAnnotationId(null)
    setDetailsMode('details')
    message.info('已存在，已定位：滨江项目招标文件.pdf')
  }, [message, nodeById])

  const handleMinimize = () => {
    void desktopWindow.minimize()
  }

  const handleMaximize = () => {
    void desktopWindow.toggleMaximize()
  }

  const handleClose = () => {
    void desktopWindow.close()
  }

  const handleToggleEmpty = useCallback(() => {
    const next = !empty
    setEmpty(next)
    if (next) {
      setSelectedIds([])
      setActiveAnnotationId(null)
      setDetailsMode('details')
    }
  }, [empty])

  // ---------- 持久化与桌面事件 ----------

  useEffect(() => {
    if (!isDesktopClient) return
    let cancelled = false

    Promise.all([desktopApi.loadScene(), desktopApi.workspaceGet()])
      .then(([scene, info]) => {
        if (cancelled) return
        setNodes(scene.nodes)
        setEdges(scene.edges)
        setAnnotations(scene.annotations)
        setWorkspacePath(info.path)
        setEmpty(scene.nodes.length === 0)
        setHydrated(true)
      })
      .catch((error) => {
        if (cancelled) return
        message.error(`加载工作空间失败：${String(error)}`)
        setEmpty(true)
        setHydrated(true)
      })

    return () => {
      cancelled = true
    }
  }, [message])

  useEffect(() => {
    if (!isDesktopClient || !hydrated) return
    // 350ms 防抖：拖动节点时避免每一帧都写库。
    const timer = window.setTimeout(() => {
      desktopApi
        .saveScene({ nodes, edges, annotations })
        .catch((error) => message.error(`保存失败：${String(error)}`))
    }, 350)

    return () => window.clearTimeout(timer)
  }, [annotations, edges, hydrated, message, nodes])

  // Tauri 拖入事件直接给绝对路径，导入与去重统一交给 Rust 侧处理。
  useEffect(() => {
    if (!isDesktopClient) return
    let unlisten: (() => void) | undefined

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          void handleImportPaths(event.payload.paths)
        }
      })
      .then((dispose) => {
        unlisten = dispose
      })
      .catch((error) => message.error(`监听拖入失败：${String(error)}`))

    return () => {
      unlisten?.()
    }
  }, [handleImportPaths, message])

  // ---------- 快捷键 ----------

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
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
          if (imageFile) {
            void handlePasteImage(imageFile)
          } else {
            message.info('剪贴板里没有可导入的文件路径')
          }
        })
        return
      }

      const text = clipboard.getData('text/plain').trim()
      if (text) {
        event.preventDefault()
        handlePasteText(text)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [handlePasteImage, handlePasteText, importClipboardFiles, message])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = isTypingTarget(event.target)

      if (event.key === 'F12') {
        event.preventDefault()
        if (isDesktopClient) void desktopApi.openDevtools()
        return
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        titleBarRef.current?.focusSearch()
        return
      }

      if (event.key === 'Escape') {
        if (settingsOpen) {
          setSettingsOpen(false)
        } else if (selectedIds.length > 0) {
          handleClearSelection()
        } else if (empty) {
          setEmpty(false)
        }
        return
      }

      if (typing) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        handleUndo()
        return
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelectedIds(nodes.map((node) => node.id))
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        handleDeleteSelected()
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'l') {
        event.preventDefault()
        handleLinkSelected()
      } else if (key === 'd') {
        event.preventDefault()
        handleDuplicate()
      } else if (key === 'e') {
        event.preventDefault()
        handleToggleEmpty()
      } else if (key === 's') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    empty,
    handleClearSelection,
    handleDeleteSelected,
    handleDuplicate,
    handleLinkSelected,
    handleToggleEmpty,
    handleUndo,
    nodes,
    selectedIds,
    settingsOpen,
  ])

  // ---------- 渲染 ----------

  return (
    <div className="app-shell">
      <TitleBar
        ref={titleBarRef}
        query={query}
        results={results}
        onQueryChange={setQuery}
        onSelectResult={handleSelectResult}
        onOpenResult={handleOpenResult}
        onNewText={() => createTextNode('双击编辑文字；适合记录结论、待办或项目说明。')}
        onSettings={() => setSettingsOpen(true)}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
      />

      <div className="workspace">
        <CanvasBoard
          ref={canvasRef}
          nodes={nodes}
          groups={groups}
          edges={edges}
          annotations={annotations}
          selectedIds={selectedIds}
          detailsOpen={Boolean(selectedNode)}
          onSelect={handleSelectNode}
          onBoxSelect={handleBoxSelect}
          onClearSelection={handleClearSelection}
          onMoveNodes={handleMoveNodes}
          onAnnotation={handleAnnotation}
          onActivate={handleActivate}
          onScaleChange={setScale}
        />

        {selectedNode ? (
          <DetailsPanel
            key={
              detailsMode === 'annotation' && activeAnnotation
                ? activeAnnotation.id
                : `details-${selectedNode.id}`
            }
            node={selectedNode}
            annotation={activeAnnotation}
            annotationTargets={annotationTargets}
            mode={detailsMode}
            onClose={handleClearSelection}
            onOpen={(node) => void openNode(node)}
            onReveal={(node) => void handleReveal(node)}
            onPreview={(node) => void handlePreview(node)}
            onEditText={(node) => setEditingTextId(node.id)}
            onAddAnnotation={handleAddAnnotation}
            onSaveAnnotation={handleSaveAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
          />
        ) : null}

        {empty ? (
          <div className="empty-overlay">
            <div className="empty-card">
              <strong>把项目材料放到一张画布上</strong>
              <p>
                拖入文件，或直接粘贴文字、截图、URL。络雀只记录地址，不移动原文件；重复文件会自动定位。
              </p>
              <div className="empty-hints">
                <span>拖入文件</span>
                <span>粘贴文字</span>
                <span>粘贴截图</span>
                <span>粘贴 URL</span>
              </div>
              <Button type="primary" onClick={() => setEmpty(false)}>
                返回画布
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <footer className="status-bar">
        <div className="status-left">
          <span className="save-dot" />
          <span>已保存</span>
          <span className="status-separator">·</span>
          <span>{nodes.length.toLocaleString()} 个引用</span>
          {selectedIds.length > 1 ? (
            <>
              <span className="status-separator">·</span>
              <span>已选 {selectedIds.length}</span>
            </>
          ) : null}
          <span className="proto-hint">Shift 框选 · L 连线 · Del 删除 · Ctrl+Z 撤销</span>
        </div>
        <div className="status-right">
          <Tooltip title="用选中对象建立有向连线（L）">
            <Button
              type="text"
              size="small"
              icon={<ApartmentOutlined />}
              aria-label="连线"
              onClick={handleLinkSelected}
            />
          </Tooltip>
          <Tooltip title="删除选中对象（Del）">
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              aria-label="删除"
              onClick={handleDeleteSelected}
            />
          </Tooltip>
          <span className="status-separator">·</span>
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <Button
            type="text"
            size="small"
            icon={<MinusOutlined />}
            aria-label="缩小"
            onClick={() => canvasRef.current?.zoomBy(0.85)}
          />
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            aria-label="放大"
            onClick={() => canvasRef.current?.zoomBy(1.15)}
          />
          <Button
            type="text"
            size="small"
            icon={<FullscreenOutlined />}
            aria-label="适配画布"
            onClick={() => canvasRef.current?.fitView()}
          />
        </div>
      </footer>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        workspacePath={workspacePath}
      />
      <TextEditorDialog
        key={editingText?.id ?? 'no-text'}
        node={editingText}
        onClose={() => setEditingTextId(null)}
        onSave={handleSaveText}
      />
      <ImagePreviewDialog
        open={previewOpen}
        src={previewSrc}
        title={previewTitle}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  )
}
