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
  return (
    <div className="context-menu" style={{ left: x, top: y }} role="menu">
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
