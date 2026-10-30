/**
 * 可见图片的缩略图加载：停留 300ms 后才批量请求，快速平移不触发。
 * 缩略图缓存在 icons 模块，加载完成后触发一次重渲染。
 *
 * 每轮最多 60 张：`visibleNodes` 引用不变时 effect 不会重跑，
 * 所以加载完一轮要主动推进 `round`，否则第 61 张之后永远等不到下一批。
 */
import { useEffect, useState } from 'react'
import type { SceneNode } from '@/types/scene'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
import { THUMB_IMAGES, setThumb } from './icons'

/** 一轮最多加载多少张：Shell 缩略图是重 IO，分批避免一次性打爆。 */
const BATCH = 60

export function useVisibleThumbnails(visibleNodes: SceneNode[], active = true) {
  const [, setThumbVersion] = useState(0)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!isDesktopClient || !active) return
    const pending = visibleNodes.filter(
      (node) =>
        node.isExists &&
        !THUMB_IMAGES.has(node.id) &&
        // 图片取 Windows Shell 缩略图；exe / 快捷方式取 Shell 图标。
        // 视频不取封面帧（已列入非目标），统一显示系统视频图标。
        (node.kind === 'image' || node.icon === 'exe'),
    )
    if (pending.length === 0) return
    const timer = window.setTimeout(() => {
      void Promise.all(
        pending.slice(0, BATCH).map(async (node) => {
          try {
            const source = await desktopApi.thumbGet(node.id)
            if (!source) {
              setThumb(node.id, null)
              return
            }
            const image = new window.Image()
            await new Promise<void>((resolve) => {
              image.onload = () => resolve()
              image.onerror = () => resolve()
              image.src = source
            })
            setThumb(node.id, image)
          } catch {
            setThumb(node.id, null)
          }
        }),
      ).then(() => {
        setThumbVersion((value) => value + 1)
        // 还有剩余就再跑一轮；失败项已被 setThumb 标记过，不会无限循环。
        if (pending.length > BATCH) setRound((value) => value + 1)
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [active, round, visibleNodes])
}
