/**
 * 可见图片的缩略图加载：停留 300ms 后才批量请求，快速平移不触发。
 * 缩略图缓存在 icons 模块，加载完成后触发一次重渲染。
 */
import { useEffect, useState } from 'react'
import type { SceneNode } from '@/types/scene'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
import { THUMB_IMAGES } from './icons'

export function useVisibleThumbnails(visibleNodes: SceneNode[], active = true) {
  const [, setThumbVersion] = useState(0)

  useEffect(() => {
    if (!isDesktopClient || !active) return
    const pending = visibleNodes.filter(
      (node) =>
        node.isExists &&
        !THUMB_IMAGES.has(node.id) &&
        // 图片与视频取 Windows Shell 缩略图（视频为系统生成的封面帧）；
        // exe / 快捷方式取 Shell 图标，避免显示成通用文本图标。
        (node.kind === 'image' || node.kind === 'video' || node.icon === 'exe'),
    )
    if (pending.length === 0) return
    const timer = window.setTimeout(() => {
      void Promise.all(
        pending.slice(0, 60).map(async (node) => {
          try {
            const source = await desktopApi.thumbGet(node.id)
            if (!source) {
              THUMB_IMAGES.set(node.id, null)
              return
            }
            const image = new window.Image()
            await new Promise<void>((resolve) => {
              image.onload = () => resolve()
              image.onerror = () => resolve()
              image.src = source
            })
            THUMB_IMAGES.set(node.id, image)
          } catch {
            THUMB_IMAGES.set(node.id, null)
          }
        }),
      ).then(() => setThumbVersion((value) => value + 1))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [active, visibleNodes])
}
