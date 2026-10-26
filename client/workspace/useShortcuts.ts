/**
 * 全局快捷键：只做按键到动作的映射，业务动作由调用方传入。
 * 输入框内的按键一律放行，避免吞掉用户正在输入的内容。
 */
import { useEffect } from 'react'
import { isTypingTarget } from './useImportClipboard'

interface ShortcutOptions {
  onUndo: () => void
  onSelectAll: () => void
  onDelete: () => void
  /** Ctrl+C：复制选中对象的原文件（无原文件的对象由调用方过滤并提示）。 */
  onCopyFiles: () => void
  onLink: () => void
  onGroup: () => void
  onToggleEmpty: () => void
  onSettings: () => void
  onEscape: () => void
  onFocusSearch: () => void
  onOpenDevtools: () => void
}

export function useShortcuts({
  onUndo,
  onSelectAll,
  onDelete,
  onCopyFiles,
  onLink,
  onGroup,
  onToggleEmpty,
  onSettings,
  onEscape,
  onFocusSearch,
  onOpenDevtools,
}: ShortcutOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F12') {
        event.preventDefault()
        onOpenDevtools()
        return
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onFocusSearch()
        return
      }

      if (event.key === 'Escape') {
        onEscape()
        return
      }

      if (isTypingTarget(event.target)) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        onCopyFiles()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        onUndo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        onSelectAll()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        onDelete()
        return
      }

      const key = event.key.toLowerCase()
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
    onOpenDevtools,
    onSelectAll,
    onSettings,
    onToggleEmpty,
    onUndo,
  ])
}
