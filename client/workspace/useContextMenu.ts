/**
 * 画布右键菜单：只保存菜单目标与坐标，动作转交给场景 store 与对象动作。
 */
import { useCallback, useEffect, useState } from 'react'
import type { CanvasContextTarget } from '@/canvas/types'
import type { SceneNode } from '@/types/scene'
import type { SceneStore } from './useSceneStore'

export interface ContextMenuEntry {
  key: string
  label: string
  danger?: boolean
  divider?: boolean
}

interface ContextMenuOptions {
  store: SceneStore
  openNode: (node: SceneNode) => void
  reveal: (node: SceneNode) => void
  editText: (id: string) => void
  editEdgeLabel: (id: string) => void
  renameGroup: (id: string) => void
  /** 按当前顺序整理空间内对象。 */
  arrangeGroup: (id: string) => void
  /** 一键整理画布：空间收框 + 空间与散置对象装箱排列。 */
  tidyCanvas: () => void
  pickGroupColor: (id: string) => void
  pickEdgeColor: (id: string) => void
  /** 跳转到当前对象/空间的关联对象；一对多时由调用方弹出选择。 */
  locateNeighbor: (targetId: string) => void
  /** 把对象对应的原文件复制到剪贴板（Windows CF_HDROP）。 */
  copyFiles: (ids: string[]) => void
  /** 调起 Windows 原生文件右键菜单（含系统与第三方 Shell 扩展）。 */
  openSystemMenu: (nodeId: string, x: number, y: number) => void
}

export function useContextMenu({
  store,
  openNode,
  reveal,
  editText,
  editEdgeLabel,
  renameGroup,
  arrangeGroup,
  tidyCanvas,
  pickGroupColor,
  pickEdgeColor,
  locateNeighbor,
  copyFiles,
  openSystemMenu,
}: ContextMenuOptions) {
  const [menu, setMenu] = useState<{
    target: CanvasContextTarget
    x: number
    y: number
    anchorX: number
    anchorY: number
  } | null>(null)

  const {
    nodeById,
    groupById,
    groupCounts,
    edges,
    selectNode,
    selectGroup,
    selectEdge,
    addAnnotation,
    deleteTarget,
    openDetails,
  } = store

  /** 右键入口：先同步选中目标，再弹菜单；选中不再自动展开属性面板。 */
  const open = useCallback(
    (target: CanvasContextTarget, clientX: number, clientY: number) => {
      if (target.kind === 'node' && target.id) selectNode(target.id, false)
      else if (target.kind === 'group' && target.id) selectGroup(target.id)
      else if (target.kind === 'edge' && target.id) selectEdge(target.id)
      // 菜单不能超出窗口；高度上限由 ContextMenu 按剩余空间计算，超出时内部滚动。
      setMenu({
        target,
        x: Math.min(clientX, window.innerWidth - 190),
        y: Math.min(clientY, window.innerHeight - 240),
        anchorX: clientX,
        anchorY: clientY,
      })
    },
    [selectEdge, selectGroup, selectNode],
  )

  const close = useCallback(() => setMenu(null), [])

  const act = useCallback(
    (key: string) => {
      const current = menu
      if (!current) return
      setMenu(null)
      const { target } = current
      // 画布空白目标没有 id：只承接整理动作，其余菜单键直接忽略。
      if (target.kind === 'canvas') {
        if (key === 'canvas-tidy') tidyCanvas()
        return
      }
      const id = target.id
      if (!id) return
      const node = target.kind === 'node' ? nodeById.get(id) : null

      if (key === 'open' && node) openNode(node)
      else if (key === 'reveal' && node) reveal(node)
      else if (key === 'copy-files' && node) copyFiles([node.id])
      else if (key === 'edit-text' && node) editText(node.id)
      else if (key === 'annotate' && node) addAnnotation([node.id])
      else if (key === 'details' && node) openDetails(node.id)
      else if (key === 'layer-top' && node) store.raiseNode(node.id, 'top')
      else if (key === 'layer-bottom' && node) store.raiseNode(node.id, 'bottom')
      else if (key === 'locate-neighbor' && node) locateNeighbor(node.id)
      else if (key === 'locate-neighbor') locateNeighbor(id)
      else if (key === 'edge-label') editEdgeLabel(id)
      else if (key === 'edge-color') pickEdgeColor(id)
      else if (key === 'group-rename') renameGroup(id)
      else if (key === 'group-arrange') arrangeGroup(id)
      else if (key === 'group-color') pickGroupColor(id)
      else if (key === 'system-menu' && node) {
        openSystemMenu(node.id, current.anchorX, current.anchorY)
      } else if (key === 'delete') deleteTarget({ kind: target.kind, id })
    },
    [
      addAnnotation,
      arrangeGroup,
      copyFiles,
      deleteTarget,
      editEdgeLabel,
      editText,
      locateNeighbor,
      menu,
      nodeById,
      openDetails,
      openNode,
      openSystemMenu,
      pickEdgeColor,
      pickGroupColor,
      renameGroup,
      reveal,
      store,
      tidyCanvas,
    ],
  )

  /** 菜单项按目标类型生成；文件操作全部收在这里。 */
  const entries: ContextMenuEntry[] = (() => {
    if (!menu) return []
    const { target } = menu
    if (target.kind === 'canvas') {
      return [{ key: 'canvas-tidy', label: '一键整理画布' }]
    }
    const id = target.id ?? ''
    if (target.kind === 'node') {
      const node = nodeById.get(id)
      if (!node) return []
      const items: ContextMenuEntry[] = []
      const hasNeighbor = edges.some((edge) => edge.from === node.id || edge.to === node.id)
      if (node.kind === 'text') items.push({ key: 'edit-text', label: '编辑文字' })
      else if (node.kind === 'richtext') items.push({ key: 'edit-text', label: '编辑富文本' })
      else if (node.kind === 'image') items.push({ key: 'open', label: '打开图片' })
      else {
        items.push({
          key: 'open',
          label:
            node.kind === 'link'
              ? '打开链接'
              : node.kind === 'folder'
                ? '打开文件夹'
                : '打开原文件',
        })
      }
      if (node.kind !== 'text' && node.kind !== 'link' && node.kind !== 'richtext') {
        items.push({ key: 'reveal', label: '在资源管理器中定位' })
      }
      // 复制与拖出都只对「有真实文件」的对象有意义：文字、富文本、链接没有原文件。
      if (node.path) items.push({ key: 'copy-files', label: '复制文件' })
      if (hasNeighbor) items.push({ key: 'locate-neighbor', label: '跳转到关联对象' })
      items.push({ key: 'annotate', label: '添加标注' })
      items.push({ key: 'details', label: '属性' })
      items.push({ key: 'layer-top', label: '置于顶层' })
      items.push({ key: 'layer-bottom', label: '置于底层' })
      items.push({ key: 'divider-1', label: '', divider: true })
      if (node.kind !== 'text' && node.kind !== 'link' && node.kind !== 'richtext') {
        items.push({ key: 'system-menu', label: '系统右键菜单…' })
        items.push({ key: 'divider-2', label: '', divider: true })
      }
      items.push({ key: 'delete', label: '从画布删除', danger: true })
      return items
    }
    if (target.kind === 'edge') {
      return [
        { key: 'edge-label', label: '编辑连线标签' },
        { key: 'edge-color', label: '连线颜色' },
        { key: 'divider-1', label: '', divider: true },
        { key: 'delete', label: '删除连线', danger: true },
      ]
    }
    const group = groupById.get(id)
    // 成员数来自 store 的计数 Map：菜单打开时不再对全量节点做 filter。
    const count = group ? (groupCounts.get(group.id) ?? 0) : 0
    const hasNeighbor = edges.some((edge) => edge.from === id || edge.to === id)
    return [
      { key: 'group-rename', label: '重命名空间' },
      { key: 'group-color', label: '空间颜色' },
      ...(count > 0 ? [{ key: 'group-arrange', label: '自动整理空间' }] : []),
      ...(hasNeighbor ? [{ key: 'locate-neighbor', label: '跳转到关联对象' }] : []),
      { key: 'divider-1', label: '', divider: true },
      { key: 'group-info', label: `空间内 ${count} 个对象` },
      { key: 'divider-2', label: '', divider: true },
      { key: 'delete', label: '删除空间（保留对象）', danger: true },
    ]
  })()

  // 菜单打开期间：点击别处、Esc、滚动都关闭；点菜单内部不关闭。
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null
      if (element?.closest('.context-menu')) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onPointerDown, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onPointerDown)
    }
  }, [close, menu])

  return { menu, entries, open, close, act }
}
