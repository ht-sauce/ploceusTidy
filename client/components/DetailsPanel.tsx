/**
 * 右侧详情面板：展示选中节点的元数据、打开/定位动作，以及标注编辑。
 * 面板占用 280px 固定宽度，画布随之收缩而不是被覆盖。
 */
import { useState } from 'react'
import { Button, Input } from 'antd'
import {
  CloseOutlined,
  EditOutlined,
  ExportOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import type { SceneAnnotation, SceneNode } from '@/types/scene'
import SystemIcon from './SystemIcon'

interface DetailsPanelProps {
  node: SceneNode
  annotation: SceneAnnotation | null
  annotationTargets: SceneNode[]
  mode: 'details' | 'annotation'
  onClose: () => void
  onOpen: (node: SceneNode) => void
  onReveal: (node: SceneNode) => void
  onRelink: (node: SceneNode) => void
  onPreview: (node: SceneNode) => void
  onEditText: (node: SceneNode) => void
  onAddAnnotation: () => void
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
  onOpen,
  onReveal,
  onRelink,
  onPreview,
  onEditText,
  onAddAnnotation,
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
          <span className={`annotation-color ${annotation.color}`} />
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

  return (
    <aside className="details-panel">
      <div className="details-head">
        <span className="details-kicker">引用详情</span>
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

      <div className="details-actions">
        {!node.isExists && node.kind !== 'text' && node.kind !== 'link' ? (
          <Button type="primary" block icon={<LinkOutlined />} onClick={() => onRelink(node)}>
            重新关联文件
          </Button>
        ) : node.kind === 'text' ? (
          <Button type="primary" block icon={<EditOutlined />} onClick={() => onEditText(node)}>
            编辑文字
          </Button>
        ) : node.kind === 'image' ? (
          <Button type="primary" block icon={<EyeOutlined />} onClick={() => onPreview(node)}>
            预览图片
          </Button>
        ) : (
          <Button type="primary" block icon={<ExportOutlined />} onClick={() => onOpen(node)}>
            {node.kind === 'link'
              ? '打开链接'
              : node.kind === 'folder'
                ? '打开文件夹'
                : '打开原文件'}
          </Button>
        )}

        {node.kind !== 'text' && node.kind !== 'link' ? (
          <Button block icon={<FolderOpenOutlined />} onClick={() => onReveal(node)}>
            在资源管理器中定位
          </Button>
        ) : null}

        <Button block onClick={onAddAnnotation}>
          添加标注
        </Button>
      </div>

      <p className="details-note">
        只记录路径与展示元数据，不复制文件内容。原文件由系统默认程序打开。
      </p>
    </aside>
  )
}
