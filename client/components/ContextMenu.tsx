/**
 * 画布右键菜单的渲染层：只负责坐标定位与菜单项外观。
 */
import type { ContextMenuEntry } from '@/workspace/useContextMenu'

interface ContextMenuProps {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onAction: (key: string) => void
}

export default function ContextMenu({ x, y, entries, onAction }: ContextMenuProps) {
  // 菜单最多占 70% 视口；同时不超过窗口底部，超出部分在容器内滚动。
  const maxHeight = Math.max(
    160,
    Math.min(window.innerHeight * 0.7, 520, window.innerHeight - y - 8),
  )
  return (
    <div className="context-menu" style={{ left: x, top: y, maxHeight }} role="menu">
      {entries.map((entry) =>
        entry.divider ? (
          <div key={entry.key} className="context-divider" />
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            className={`context-item${entry.danger ? ' is-danger' : ''}`}
            onClick={() => onAction(entry.key)}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  )
}
