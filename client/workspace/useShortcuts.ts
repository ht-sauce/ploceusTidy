/**
 * 全局快捷键：只做按键到动作的映射，业务动作由调用方传入。
 * 输入框内的按键一律放行，避免吞掉用户正在输入的内容；
 * 单字母快捷键必须没有 Ctrl/Alt/Meta 修饰，否则 Ctrl+S 会同时命中「S 打开设置」。
 */
import { useEffect } from 'react'
import { isTypingTarget } from './useImportClipboard'

interface ShortcutOptions {
  onUndo: () => void
  onRedo: () => void
  onSelectAll: () => void
  onDelete: () => void
  /** Ctrl+C：复制选中对象的原文件（无原文件的对象由调用方过滤并提示）。 */
  onCopyFiles: () => void
  /** Ctrl+S：立即落库（绕过去抖），不改变任何选中或弹窗状态。 */
  onSave: () => void
  onLink: () => void
  onGroup: () => void
  onToggleEmpty: () => void
  onSettings: () => void
  onEscape: () => void
  onFocusSearch: () => void
  onOpenDevtools: () => void
  /** 方向键微调选中对象；`large` 为按住 Shift 的 10px 步长。 */
  onNudge: (dx: number, dy: number) => void
}

/** 方向键 → 世界坐标位移；Shift 时放大到 10px。 */
const NUDGE_VECTORS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
}

export function useShortcuts({
  onUndo,
  onRedo,
  onSelectAll,
  onDelete,
  onCopyFiles,
  onSave,
  onLink,
  onGroup,
  onToggleEmpty,
  onSettings,
  onEscape,
  onFocusSearch,
  onOpenDevtools,
  onNudge,
}: ShortcutOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F12') {
        event.preventDefault()
        onOpenDevtools()
        return
      }

      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (mod && key === 'k') {
        event.preventDefault()
        onFocusSearch()
        return
      }

      if (event.key === 'Escape') {
        onEscape()
        return
      }

      // 保存要在「输入控件放行」之前：搜索框里按 Ctrl+S 也应该落库。
      // 弹窗内的 Ctrl+S 由弹窗自己 stopPropagation 拦截，不会走到这里。
      if (mod && key === 's') {
        event.preventDefault()
        onSave()
        return
      }

      if (isTypingTarget(event.target)) return

      if (mod && key === 'c') {
        event.preventDefault()
        onCopyFiles()
        return
      }
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) onRedo()
        else onUndo()
        return
      }
      if (mod && key === 'y') {
        event.preventDefault()
        onRedo()
        return
      }
      if (mod && key === 'a') {
        event.preventDefault()
        onSelectAll()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        onDelete()
        return
      }

      const vector = NUDGE_VECTORS[event.key]
      if (vector && !mod && !event.altKey) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        onNudge(vector.dx * step, vector.dy * step)
        return
      }
      if (vector) return

      // 单字母快捷键只在无修饰键时生效，避免和浏览器/系统组合键撞车。
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (key === 'l') {
        event.preventDefault()
        onLink()
      } else if (key === 'g') {
        event.preventDefault()
        onGroup()
      } else if (key === 'e') {
        event.preventDefault()
        onToggleEmpty()
      } else if (key === 's') {
        event.preventDefault()
        onSettings()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    onCopyFiles,
    onDelete,
    onEscape,
    onFocusSearch,
    onGroup,
    onLink,
    onNudge,
    onOpenDevtools,
    onRedo,
    onSave,
    onSelectAll,
    onSettings,
    onToggleEmpty,
    onUndo,
  ])
}
