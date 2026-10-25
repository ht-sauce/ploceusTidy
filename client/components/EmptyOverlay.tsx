/**
 * 空画布引导：首次使用或清空场景后，提示可用的导入方式。
 */
import { Button } from 'antd'

interface EmptyOverlayProps {
  onDismiss: () => void
}

export default function EmptyOverlay({ onDismiss }: EmptyOverlayProps) {
  return (
    <div className="empty-overlay">
      <div className="empty-card">
        <strong>把项目材料放到一张画布上</strong>
        <p>
          拖入文件，或直接粘贴文字、截图、URL。络雀只记录地址，不移动原文件；重复文件会自动定位。
        </p>
        <div className="empty-hints">
          <span>拖入文件</span>
          <span>粘贴文字</span>
          <span>粘贴截图</span>
          <span>粘贴 URL</span>
        </div>
        <Button type="primary" onClick={onDismiss}>
          返回画布
        </Button>
      </div>
    </div>
  )
}
