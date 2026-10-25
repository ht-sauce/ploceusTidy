/**
 * 画布右键菜单：只保存菜单目标与坐标，动作转交给场景 store 与对象动作。
 */
import { useCallback, useEffect, useState } from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
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
  message: MessageInstance
  openNode: (node: SceneNode) => void
  reveal: (node: SceneNode) => void
  editText: (id: string) => void
  editEdgeLabel: (id: string) => void
}

export function useContextMenu({
  store,
  message,
  openNode,
  reveal,
  editText,
  editEdgeLabel,
}: ContextMenuOptions) {
  const [menu, setMenu] = useState<{
    target: CanvasContextTarget
    x: number
    y: number
  } | null>(null)

  const {
    nodeById,
    groupById,
    nodes,
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
      // 菜单不能超出窗口。
      setMenu({
        target,
        x: Math.min(clientX, window.innerWidth - 190),
        y: Math.min(clientY, window.innerHeight - 240),
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
      else if (key === 'edge-label') editEdgeLabel(target.id)
      else if (key === 'group-info') message.info('空间暂不支持标注，可对其中的文件添加')
      else if (key === 'delete') deleteTarget(target)
    },
    [
      addAnnotation,
      deleteTarget,
      editEdgeLabel,
      menu,
      message,
      nodeById,
      openDetails,
      openNode,
      reveal,
      editText,
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
      items.push({ key: 'annotate', label: '添加标注' })
      items.push({ key: 'details', label: '属性' })
      items.push({ key: 'divider-1', label: '', divider: true })
      items.push({ key: 'delete', label: '从画布删除', danger: true })
      return items
    }
    if (target.kind === 'edge') {
      return [
        { key: 'edge-label', label: '编辑连线标签' },
        { key: 'divider-1', label: '', divider: true },
        { key: 'delete', label: '删除连线', danger: true },
      ]
    }
    const group = groupById.get(target.id)
    const count = group ? nodes.filter((item) => item.groupId === group.id).length : 0
    return [
      { key: 'group-info', label: `空间内 ${count} 个对象` },
      { key: 'divider-1', label: '', divider: true },
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
