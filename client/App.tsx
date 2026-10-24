/**
 * 应用根组件：持有场景状态，串联画布、标题栏、详情面板与 Tauri 能力。
 *
 * 职责边界：
 * - 场景数据与选中状态只在这里维护，子组件通过回调上报；
 * - 文件系统、剪贴板、SQLite 一律走 `desktopApi`，前端不直接访问；
 * - 浏览器模式下用模拟数据预览界面，桌面模式下从工作空间加载。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntApp,
  Button,
  ConfigProvider,
  Input,
  Modal,
  Tooltip,
  theme as antdTheme,
} from 'antd'
import {
  ApartmentOutlined,
  AppstoreAddOutlined,
  DeleteOutlined,
  FullscreenOutlined,
  MinusOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { sceneAnnotations, sceneEdges, sceneGroups, sceneNodes } from '@/data/mock-scene'
import type {
  SceneAnnotation,
  SceneEdge,
  SceneGroup,
  SceneNode,
  SearchEntry,
  ThemeId,
  WorkspaceInfo,
} from '@/types/scene'
import CanvasBoard, { type CanvasBoardHandle } from '@/components/CanvasBoard'
import TitleBar, { type TitleBarHandle } from '@/components/TitleBar'
import DetailsPanel from '@/components/DetailsPanel'
import SettingsDialog from '@/components/SettingsDialog'
import TextEditorDialog from '@/components/TextEditorDialog'
import ImagePreviewDialog from '@/components/ImagePreviewDialog'
import { desktopApi, desktopWindow, isDesktopClient } from '@/lib/tauri-api'
import { DEFAULT_THEME, applyTheme, normalizeTheme, themeById } from '@/lib/theme'
import { normalizeSearch, searchRank } from '@/lib/search'

/** 删除前快照，仅保留一步，用于 Ctrl+Z 撤销。 */
interface SceneSnapshot {
  nodes: SceneNode[]
  groups: SceneGroup[]
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

function Workspace({
  themeId,
  onThemeChange,
}: {
  themeId: ThemeId
  onThemeChange: (id: ThemeId) => void
}) {
  const { message } = AntApp.useApp()
  const [nodes, setNodes] = useState<SceneNode[]>(isDesktopClient ? [] : sceneNodes)
  const [groups, setGroups] = useState<SceneGroup[]>(isDesktopClient ? [] : sceneGroups)
  const [edges, setEdges] = useState<SceneEdge[]>(isDesktopClient ? [] : sceneEdges)
  const [annotations, setAnnotations] = useState<SceneAnnotation[]>(
    isDesktopClient ? [] : sceneAnnotations,
  )
  const [hydrated, setHydrated] = useState(!isDesktopClient)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgeLabelTarget, setEdgeLabelTarget] = useState<string | null>(null)
  const [edgeLabelText, setEdgeLabelText] = useState('')
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
  // 校验任务在 effect 内读取最新节点，但不希望 nodes 变化触发重新校验。
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  })

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
    const normalized = normalizeSearch(query)
    if (!normalized) return searchEntries.slice(0, 6)
    return searchEntries
      .map((entry) => ({ entry, rank: searchRank(entry, normalized) }))
      .filter((item) => item.rank >= 0)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 9)
      .map((item) => item.entry)
  }, [query, searchEntries])

  const handleSelectNode = useCallback((id: string, additive: boolean) => {
    setSelectedIds((previous) => {
      if (!additive) return [id]
      return previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    })
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleBoxSelect = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((previous) => (additive ? Array.from(new Set([...previous, ...ids])) : ids))
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleSelectGroup = useCallback((id: string) => {
    setSelectedGroupId(id)
    setSelectedIds([])
    setSelectedEdgeId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  /** 选中连线：与节点/分组互斥；双击进入标签编辑。 */
  const handleSelectEdge = useCallback((id: string) => {
    setSelectedEdgeId(id)
    setSelectedIds([])
    setSelectedGroupId(null)
    setActiveAnnotationId(null)
    setDetailsMode('details')
  }, [])

  const handleEdgeLabelEdit = useCallback(
    (id: string) => {
      setSelectedEdgeId(id)
      const edge = edges.find((item) => item.id === id)
      setEdgeLabelText(edge?.label ?? '')
      setEdgeLabelTarget(id)
    },
    [edges],
  )

  const handleSaveEdgeLabel = useCallback(() => {
    if (!edgeLabelTarget) return
    const label = edgeLabelText.trim()
    setEdges((previous) =>
      previous.map((edge) =>
        edge.id === edgeLabelTarget ? { ...edge, label: label || undefined } : edge,
      ),
    )
    setEdgeLabelTarget(null)
    message.success(label ? '连线标签已保存' : '连线标签已清除')
  }, [edgeLabelText, edgeLabelTarget, message])

  const handleMoveNodes = useCallback((moves: { id: string; x: number; y: number }[]) => {
    const byId = new Map(moves.map((move) => [move.id, move]))
    setNodes((previous) =>
      previous.map((node) => {
        const move = byId.get(node.id)
        return move ? { ...node, x: move.x, y: move.y } : node
      }),
    )
  }, [])

  /** 移动分组框时带动同组节点，保持相对位置不变。 */
  const handleMoveGroup = useCallback((id: string, dx: number, dy: number) => {
    setGroups((previous) =>
      previous.map((group) =>
        group.id === id
          ? { ...group, x: Math.round(group.x + dx), y: Math.round(group.y + dy) }
          : group,
      ),
    )
    setNodes((previous) =>
      previous.map((node) =>
        node.groupId === id
          ? { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) }
          : node,
      ),
    )
  }, [])

  /** 用当前选中对象的包围盒创建分组框，并把对象归入该组。 */
  const handleCreateGroup = useCallback(() => {
    const targets = selectedIds
      .map((id) => nodeById.get(id))
      .filter((node): node is SceneNode => Boolean(node))
    if (targets.length === 0) {
      message.info('先选中要分组的对象')
      return
    }

    const minX = Math.min(...targets.map((node) => node.x)) - 16
    const minY = Math.min(...targets.map((node) => node.y)) - 32
    const maxX = Math.max(...targets.map((node) => node.x + node.w)) + 16
    const maxY = Math.max(...targets.map((node) => node.y + node.h)) + 16
    const group: SceneGroup = {
      id: `group-${crypto.randomUUID()}`,
      title: '新分组',
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    }

    setGroups((previous) => [...previous, group])
    setNodes((previous) =>
      previous.map((node) =>
        selectedIds.includes(node.id) ? { ...node, groupId: group.id } : node,
      ),
    )
    setSelectedGroupId(group.id)
    setSelectedIds([])
    message.success('已创建分组框')
  }, [message, nodeById, selectedIds])

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

  /** 缺失文件重新关联：只改引用路径，卡片位置与标注保持不变。 */
  const handleRelink = async (node: SceneNode) => {
    if (!isDesktopClient) {
      message.info('演示：桌面客户端内选择新路径')
      return
    }
    try {
      const picked = await desktopApi.pickFile()
      if (!picked) return
      const result = await desktopApi.refRelink(node.id, picked)
      setNodes((previous) =>
        previous.map((item) => (item.id === result.node.id ? result.node : item)),
      )
      message.success('已重新关联')
    } catch (error) {
      message.error(`重新关联失败：${String(error)}`)
    }
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
    if (selectedEdgeId) {
      undoRef.current = { nodes, groups, edges, annotations }
      setEdges((previous) => previous.filter((edge) => edge.id !== selectedEdgeId))
      setSelectedEdgeId(null)
      message.info('已删除连线；Ctrl+Z 可撤销')
      return
    }
    if (selectedGroupId) {
      undoRef.current = { nodes, groups, edges, annotations }
      setGroups((previous) => previous.filter((group) => group.id !== selectedGroupId))
      setNodes((previous) =>
        previous.map((node) =>
          node.groupId === selectedGroupId ? { ...node, groupId: '' } : node,
        ),
      )
      setSelectedGroupId(null)
      message.info('已删除分组框，内部对象保留；Ctrl+Z 可撤销')
      return
    }
    if (selectedIds.length === 0) return
    undoRef.current = { nodes, groups, edges, annotations }
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
  }, [annotations, edges, groups, message, nodes, selectedEdgeId, selectedGroupId, selectedIds])

  const handleUndo = useCallback(() => {
    const snapshot = undoRef.current
    if (!snapshot) {
      message.info('没有可撤销的删除操作')
      return
    }
    undoRef.current = null
    setNodes(snapshot.nodes)
    setGroups(snapshot.groups)
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
        setGroups(scene.groups)
        setEdges(scene.edges)
        setAnnotations(scene.annotations)
        setWorkspace(info)
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
        .saveScene({ nodes, groups, edges, annotations })
        .catch((error) => message.error(`保存失败：${String(error)}`))
    }, 350)

    return () => window.clearTimeout(timer)
  }, [annotations, edges, groups, hydrated, message, nodes])

  // 启动后空闲分批校验引用：每批 400 个，批间让出主线程，避免一次性 stat 卡住界面。
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
  }, [hydrated])

  // 窗口重新聚焦时补查选中项，覆盖「离开期间文件被移动或删除」的情况。
  useEffect(() => {
    if (!isDesktopClient) return
    const onFocus = () => {
      if (selectedIds.length === 0) return
      void desktopApi
        .refCheck(selectedIds)
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
  }, [selectedIds])

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
        } else if (selectedIds.length > 0 || selectedGroupId || selectedEdgeId) {
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
      } else if (key === 'g') {
        event.preventDefault()
        handleCreateGroup()
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
    handleCreateGroup,
    handleDeleteSelected,
    handleDuplicate,
    handleLinkSelected,
    handleToggleEmpty,
    handleUndo,
    nodes,
    selectedEdgeId,
    selectedGroupId,
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
          selectedGroupId={selectedGroupId}
          selectedEdgeId={selectedEdgeId}
          detailsOpen={Boolean(selectedNode)}
          onSelect={handleSelectNode}
          onBoxSelect={handleBoxSelect}
          onClearSelection={handleClearSelection}
          onSelectGroup={handleSelectGroup}
          onMoveGroup={handleMoveGroup}
          onMoveNodes={handleMoveNodes}
          onSelectEdge={handleSelectEdge}
          onEdgeLabelEdit={handleEdgeLabelEdit}
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
            onRelink={(node) => void handleRelink(node)}
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
          <span className="proto-hint">Shift 框选 · L 连线 · G 分组 · Del 删除 · Ctrl+Z 撤销</span>
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
          <Tooltip title="用选中对象创建分组框（G）">
            <Button
              type="text"
              size="small"
              icon={<AppstoreAddOutlined />}
              aria-label="新建分组"
              onClick={handleCreateGroup}
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
        themeId={themeId}
        onThemeChange={onThemeChange}
        workspace={workspace}
        onWorkspaceChanged={setWorkspace}
        onSceneCleared={() => {
          setNodes([])
          setGroups([])
          setEdges([])
          setAnnotations([])
          setSelectedIds([])
          setEmpty(true)
        }}
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
      <Modal
        open={edgeLabelTarget !== null}
        title="连线标签"
        okText="保存"
        cancelText="取消"
        onOk={handleSaveEdgeLabel}
        onCancel={() => setEdgeLabelTarget(null)}
        keyboard
      >
        <Input
          value={edgeLabelText}
          onChange={(event) => setEdgeLabelText(event.target.value)}
          placeholder="留空则清除标签"
          maxLength={24}
          onPressEnter={handleSaveEdgeLabel}
        />
      </Modal>
    </div>
  )
}

/**
 * 应用外壳：主题状态放在最外层，Ant Design 与画布共用同一套语义令牌。
 * 主题 ID 从 `app_meta` 读取，切换时立即生效并回写，不触碰场景与交互状态。
 */
export default function App() {
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME)

  useEffect(() => {
    applyTheme(themeId)
  }, [themeId])

  useEffect(() => {
    if (!isDesktopClient) return
    desktopApi
      .metaGet('ui_theme')
      .then((value) => setThemeId(normalizeTheme(value)))
      .catch(() => {
        // 读取失败时保持默认主题，不影响启动。
      })
  }, [])

  const handleThemeChange = useCallback((id: ThemeId) => {
    const next = normalizeTheme(id)
    setThemeId(next)
    applyTheme(next)
    if (isDesktopClient) {
      void desktopApi.metaSet('ui_theme', next).catch(() => {
        // 持久化失败只在下次启动回退默认主题，不打断当前切换。
      })
    }
  }, [])

  const tokens = themeById(themeId)

  return (
    <ConfigProvider
      componentSize="small"
      theme={{
        algorithm: antdTheme.compactAlgorithm,
        token: {
          colorPrimary: tokens.primary,
          borderRadius: 6,
          fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        },
      }}
    >
      <AntApp>
        <Workspace themeId={themeId} onThemeChange={handleThemeChange} />
      </AntApp>
    </ConfigProvider>
  )
}
