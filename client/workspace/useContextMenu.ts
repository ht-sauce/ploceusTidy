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
  pickGroupColor: (id: string) => void
  pickEdgeColor: (id: string) => void
  /** 跳转到当前对象/空间的关联对象；一对多时由调用方弹出选择。 */
  locateNeighbor: (targetId: string) => void
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
  pickGroupColor,
  pickEdgeColor,
  locateNeighbor,
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
    nodes,
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
      if (target.kind === 'node') selectNode(target.id, false)
      else if (target.kind === 'group') selectGroup(target.id)
      else selectEdge(target.id)
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
      const node = target.kind === 'node' ? nodeById.get(target.id) : null

      if (key === 'open' && node) openNode(node)
      else if (key === 'reveal' && node) reveal(node)
      else if (key === 'edit-text' && node) editText(node.id)
      else if (key === 'annotate' && node) addAnnotation([node.id])
      else if (key === 'details' && node) openDetails(node.id)
      else if (key === 'locate-neighbor' && node) locateNeighbor(node.id)
      else if (key === 'locate-neighbor') locateNeighbor(target.id)
      else if (key === 'edge-label') editEdgeLabel(target.id)
      else if (key === 'edge-color') pickEdgeColor(target.id)
      else if (key === 'group-rename') renameGroup(target.id)
      else if (key === 'group-color') pickGroupColor(target.id)
      else if (key === 'system-menu' && node) {
        openSystemMenu(node.id, current.anchorX, current.anchorY)
      } else if (key === 'delete') deleteTarget(target)
    },
    [
      addAnnotation,
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
    ],
  )

  /** 菜单项按目标类型生成；文件操作全部收在这里。 */
  const entries: ContextMenuEntry[] = (() => {
    if (!menu) return []
    const { target } = menu
    if (target.kind === 'node') {
      const node = nodeById.get(target.id)
      if (!node) return []
      const items: ContextMenuEntry[] = []
      const hasNeighbor = edges.some((edge) => edge.from === node.id || edge.to === node.id)
      if (node.kind === 'text') items.push({ key: 'edit-text', label: '编辑文字' })
      else if (node.kind === 'image') items.push({ key: 'open', label: '预览图片' })
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
      if (node.kind !== 'text' && node.kind !== 'link') {
        items.push({ key: 'reveal', label: '在资源管理器中定位' })
      }
      if (hasNeighbor) items.push({ key: 'locate-neighbor', label: '跳转到关联对象' })
      items.push({ key: 'annotate', label: '添加标注' })
      items.push({ key: 'details', label: '属性' })
      items.push({ key: 'divider-1', label: '', divider: true })
      if (node.kind !== 'text' && node.kind !== 'link') {
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
    const group = groupById.get(target.id)
    const count = group ? nodes.filter((item) => item.groupId === group.id).length : 0
    const hasNeighbor = edges.some((edge) => edge.from === target.id || edge.to === target.id)
    return [
      { key: 'group-rename', label: '重命名空间' },
      { key: 'group-color', label: '空间颜色' },
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
