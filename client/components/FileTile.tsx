/**
 * 高密度节点行：固定 176×28、16px 系统图标、单行文件名。
 * 完整路径/内容放入 Tooltip，避免行内换行破坏密度。
 */
import { Tooltip } from 'antd'
import type { SceneNode } from '@/types/scene'
import SystemIcon from './SystemIcon'

interface FileTileProps {
  node: SceneNode
  selected: boolean
  pulse: boolean
  annotationColor?: string
  onAnnotation: () => void
}

export default function FileTile({
  node,
  selected,
  pulse,
  annotationColor,
  onAnnotation,
}: FileTileProps) {
  const detail = node.path ?? node.url ?? node.body ?? node.subtitle

  return (
    <Tooltip
      mouseEnterDelay={0.35}
      title={
        <div className="tile-tooltip">
          <div>{node.name}</div>
          {detail ? <div className="tile-tooltip-detail">{detail}</div> : null}
        </div>
      }
    >
      <div
        className={[
          'file-tile',
          node.kind === 'text' ? 'is-text' : '',
          selected ? 'is-selected' : '',
          pulse ? 'is-pulse' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-node-id={node.id}
        style={{
          left: node.x,
          top: node.y,
          width: node.w,
          height: node.h,
        }}
      >
        <SystemIcon kind={node.icon} size={16} className="tile-icon" />
        <span className="tile-name">{node.name}</span>
        {annotationColor ? (
          <button
            type="button"
            className={`tile-annotation ${annotationColor}`}
            aria-label="查看标注"
            title="查看标注"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onAnnotation()
            }}
          />
        ) : null}
      </div>
    </Tooltip>
  )
}
