/**
 * 单个对象的桌面动作：打开、资源管理器定位、缺失重连、双击激活。
 * 图片与视频一律走系统打开（不做内置预览），只依赖 IPC 封装，不持有场景数据；
 * 场景更新通过回调交回上层。
 */
import { useCallback } from 'react'
import type { MessageInstance } from 'antd/es/message/interface'
import type { SceneNode } from '@/types/scene'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'

interface NodeActionsOptions {
  message: MessageInstance
  onNodePatched: (node: SceneNode) => void
  locate: (id: string) => void
  editText: (id: string) => void
  select: (id: string) => void
}

export function useNodeActions({
  message,
  onNodePatched,
  locate,
  editText,
  select,
}: NodeActionsOptions) {
  const openNode = useCallback(
    async (node: SceneNode) => {
      if (node.kind === 'text') {
        editText(node.id)
        return
      }

      if (isDesktopClient) {
        try {
          // 图片/视频/文件/文件夹/链接统一交给系统默认程序打开，无内置预览。
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
    },
    [editText, message],
  )

  const reveal = useCallback(
    async (node: SceneNode) => {
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
    },
    [message],
  )

  /** 缺失文件重新关联：只改引用路径，卡片位置与标注保持不变。 */
  const relink = useCallback(
    async (node: SceneNode) => {
      if (!isDesktopClient) {
        message.info('演示：桌面客户端内选择新路径')
        return
      }
      try {
        const picked = await desktopApi.pickFile()
        if (!picked) return
        const result = await desktopApi.refRelink(node.id, picked)
        onNodePatched(result.node)
        message.success('已重新关联')
      } catch (error) {
        message.error(`重新关联失败：${String(error)}`)
      }
    },
    [message, onNodePatched],
  )

  /** 双击对象：文字进编辑，其余打开；同时把选中收敛到该对象。 */
  const activate = useCallback(
    (node: SceneNode) => {
      select(node.id)
      void openNode(node)
    },
    [openNode, select],
  )

  const locateAndSelect = useCallback(
    (id: string) => {
      locate(id)
      select(id)
    },
    [locate, select],
  )

  return {
    openNode,
    reveal,
    relink,
    activate,
    locateAndSelect,
  }
}
