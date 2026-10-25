/**
 * 右侧属性面板：只展示选中对象的元数据，打开/定位/标注等动作走画布右键菜单。
 * 标注编辑复用同一块面板；面板由用户主动打开，不随选择自动出现。
 */
import { useState } from 'react'
import { Button, Input } from 'antd'
import { CloseOutlined, LinkOutlined } from '@ant-design/icons'
import type { SceneAnnotation, SceneNode } from '@/types/scene'
import SystemIcon from './SystemIcon'

interface DetailsPanelProps {
  node: SceneNode | null
  annotation: SceneAnnotation | null
  annotationTargets: SceneNode[]
  mode: 'details' | 'annotation'
  onClose: () => void
  onRelink: (node: SceneNode) => void
  onSaveAnnotation: (text: string) => void
  onDeleteAnnotation: () => void
}

const TYPE_LABEL: Record<string, string> = {
  file: '文件引用',
  folder: '文件夹引用',
  image: '图片引用',
  video: '视频引用',
  text: '文字卡',
  link: '链接卡',
}

export default function DetailsPanel({
  node,
  annotation,
  annotationTargets,
  mode,
  onClose,
  onRelink,
  onSaveAnnotation,
  onDeleteAnnotation,
}: DetailsPanelProps) {
  const [annotationText, setAnnotationText] = useState(annotation?.text ?? '')

  if (mode === 'annotation' && annotation) {
    const targetLabel =
      annotationTargets.length <= 2
        ? annotationTargets.map((target) => target.name).join('、')
        : `${annotationTargets[0]?.name ?? '对象'} 等 ${annotationTargets.length} 个对象`

    return (
      <aside className="details-panel">
        <div className="details-head">
          <span className="details-kicker">标注</span>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            aria-label="关闭"
            onClick={onClose}
          />
        </div>

        <div className="annotation-target">
          <span className="annotation-color" />
          <span>{targetLabel}</span>
        </div>

        <Input.TextArea
          value={annotationText}
          onChange={(event) => setAnnotationText(event.target.value)}
          autoSize={{ minRows: 5, maxRows: 9 }}
          placeholder="写下结论、待办或下一步"
        />

        <p className="details-note">
          标注会跟随对象，也可以在顶部搜索中命中；一次可标注多个选中对象。
        </p>

        <div className="details-actions">
          <Button type="primary" block onClick={() => onSaveAnnotation(annotationText)}>
            保存
          </Button>
          <Button danger block onClick={onDeleteAnnotation}>
            删除标注
          </Button>
        </div>
      </aside>
    )
  }

  if (!node) return null

  return (
    <aside className="details-panel">
      <div className="details-head">
        <span className="details-kicker">属性</span>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="关闭"
          onClick={onClose}
        />
      </div>

      <div className="details-title">
        <SystemIcon kind={node.icon} size={22} />
        <div>
          <h2>{node.name}</h2>
          <p>{TYPE_LABEL[node.kind] ?? '画布对象'}</p>
        </div>
      </div>

      <div className="details-path">{node.path ?? node.url ?? node.subtitle}</div>

      <div className="details-meta">
        <div>
          <span>类型</span>
          <strong>{node.icon.toUpperCase()}</strong>
        </div>
        <div>
          <span>状态</span>
          <strong>{node.isExists ? '可用' : '缺失'}</strong>
        </div>
      </div>

      {!node.isExists && node.kind !== 'text' && node.kind !== 'link' ? (
        <div className="details-actions">
          <Button type="primary" block icon={<LinkOutlined />} onClick={() => onRelink(node)}>
            重新关联文件
          </Button>
        </div>
      ) : null}

      <p className="details-note">
        只记录路径与展示元数据，不复制文件内容。原文件由系统默认程序打开。
      </p>
    </aside>
  )
}
