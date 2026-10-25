/**
 * 窗口不可见检测：最小化或页面隐藏时返回 true，供画布暂停缩略图与脉冲。
 * 只监听窗口/页面事件，不做轮询；偏好关闭时始终返回 false。
 */
import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isDesktopClient } from '@/lib/tauri-api'

export function useWindowSuspended(enabled: boolean) {
  const [suspended, setSuspended] = useState(false)

  useEffect(() => {
    if (!enabled) return

    // 浏览器调试没有窗口 API，只能依赖 Page Visibility。
    if (!isDesktopClient) {
      const sync = () => setSuspended(document.hidden)
      sync()
      document.addEventListener('visibilitychange', sync)
      return () => document.removeEventListener('visibilitychange', sync)
    }

    const windowApi = getCurrentWindow()
    let disposed = false
    const unlisteners: (() => void)[] = []
    const sync = async () => {
      try {
        const [minimized, visible] = await Promise.all([
          windowApi.isMinimized(),
          windowApi.isVisible(),
        ])
        if (!disposed) setSuspended(minimized || !visible || document.hidden)
      } catch {
        // 状态读取失败时保持上一次结果，不影响画布继续工作。
      }
    }
    const listen = (register: Promise<() => void>) => {
      void register.then((unlisten) => {
        if (disposed) unlisten()
        else unlisteners.push(unlisten)
      })
    }
    listen(windowApi.onFocusChanged(() => void sync()))
    listen(windowApi.onResized(() => void sync()))
    const onVisibility = () => void sync()
    document.addEventListener('visibilitychange', onVisibility)
    void sync()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [enabled])

  return enabled && suspended
}
