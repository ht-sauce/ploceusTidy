/**
 * 底部状态栏：保存状态、对象数量、选中数量与画布操作按钮。
 * 保存状态来自 IPC 层的真实结果——保存失败时不能继续显示「已保存」。
 */
import Button from 'antd/es/button'
import Tooltip from 'antd/es/tooltip'
import {
  ApartmentOutlined,
  AppstoreAddOutlined,
  DeleteOutlined,
  FullscreenOutlined,
  MinusOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import type { SaveState } from '@/lib/tauri-api'

interface StatusBarProps {
  nodeCount: number
  selectedCount: number
  scale: number
  saveState: SaveState
  onLink: () => void
  onCreateSpace: () => void
  onDelete: () => void
  onZoomOut: () => void
  onZoomIn: () => void
  onFit: () => void
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '就绪',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
}

export default function StatusBar({
  nodeCount,
  selectedCount,
  scale,
  saveState,
  onLink,
  onCreateSpace,
  onDelete,
  onZoomOut,
  onZoomIn,
  onFit,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className={`save-dot is-${saveState}`} />
        <span className={saveState === 'error' ? 'status-save-error' : undefined}>
          {SAVE_LABEL[saveState]}
        </span>
        <span className="status-separator">·</span>
        <span>{nodeCount.toLocaleString()} 个引用</span>
        {selectedCount > 1 ? (
          <>
            <span className="status-separator">·</span>
            <span>已选 {selectedCount}</span>
          </>
        ) : null}
      </div>
      <div className="status-right">
        <Tooltip title="用选中对象建立有向连线（L）">
          <Button
            type="text"
            size="small"
            icon={<ApartmentOutlined />}
            aria-label="连线"
            onClick={onLink}
          />
        </Tooltip>
        <Tooltip title="把选中对象放进一个空间（G）">
          <Button
            type="text"
            size="small"
            icon={<AppstoreAddOutlined />}
            aria-label="新建空间"
            onClick={onCreateSpace}
          />
        </Tooltip>
        <Tooltip title="删除选中对象（Del）">
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            aria-label="删除"
            onClick={onDelete}
          />
        </Tooltip>
        <span className="status-separator">·</span>
        <span className="zoom-label">{Math.round(scale * 100)}%</span>
        <Button
          type="text"
          size="small"
          icon={<MinusOutlined />}
          aria-label="缩小"
          onClick={onZoomOut}
        />
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label="放大"
          onClick={onZoomIn}
        />
        <Button
          type="text"
          size="small"
          icon={<FullscreenOutlined />}
          aria-label="适配画布"
          onClick={onFit}
        />
      </div>
    </footer>
  )
}
