/**
 * 内容管理：集中管理画布上的文字卡与富文本卡。
 *
 * 边界：
 * - 只处理 `text` / `richtext` 两类应用内内容（文件引用走画布本身）；
 * - 列表不加载正文，字数用纯文本投影计算，避免打开面板就拉几十万字；
 * - 「移动到空间」交给 store 的统一命令，落点排在空间内容末尾；
 * - 导出走 Rust：纯文本写 `.txt`，富文本写 `.html` 并复制正文引用的本地媒体。
 */
import { useMemo, useState } from 'react'
import AntApp from 'antd/es/app'
import Button from 'antd/es/button'
import Input from 'antd/es/input'
import Modal from 'antd/es/modal'
import Select from 'antd/es/select'
import { ExportOutlined, AimOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ExportItem, SceneGroup, SceneNode } from '@/types/scene'
import { desktopApi } from '@/lib/tauri-api'

interface ContentManagerDialogProps {
  open: boolean
  nodes: SceneNode[]
  groups: SceneGroup[]
  onClose: () => void
  onLocate: (id: string) => void
  onEdit: (id: string) => void
  onMoveToGroup: (id: string, groupId: string) => void
  onDelete: (id: string) => void
}

const TYPE_LABEL: Record<string, string> = {
  text: '纯文本',
  richtext: '富文本',
}

/** 导出文件名清洗：与 Rust 侧规则保持一致（非法字符换成下划线）。 */
function exportName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
}

/** 拆分保存路径为目录 + 文件名；Windows 反斜杠与正斜杠都兼容。 */
function splitPath(target: string) {
  const index = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'))
  if (index < 0) return { dir: target, fileName: target }
  return { dir: target.slice(0, index), fileName: target.slice(index + 1) }
}

export default function ContentManagerDialog({
  open,
  nodes,
  groups,
  onClose,
  onLocate,
  onEdit,
  onMoveToGroup,
  onDelete,
}: ContentManagerDialogProps) {
  const { message } = AntApp.useApp()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return nodes
    return nodes.filter((node) => `${node.name} ${node.subtitle}`.toLowerCase().includes(keyword))
  }, [nodes, query])

  /** 取正文：首屏不加载正文，导出前按需拉取。 */
  const loadBody = async (node: SceneNode) => {
    if (node.body !== undefined) return node.body
    const body = await desktopApi.nodeBody(node.id)
    return body ?? ''
  }

  const exportItems = async (targets: SceneNode[]): Promise<ExportItem[]> => {
    const items: ExportItem[] = []
    for (const node of targets) {
      items.push({
        name: exportName(node.name),
        kind: node.kind === 'richtext' ? 'richtext' : 'text',
        body: await loadBody(node),
      })
    }
    return items
  }

  const reportResult = (files: string[], media: number, warnings: string[]) => {
    message.success(`已导出 ${files.length} 个文件${media > 0 ? `，含 ${media} 个媒体` : ''}`)
    if (warnings.length > 0) message.warning(`部分媒体未复制：${warnings[0]}`)
  }

  const handleExportOne = async (node: SceneNode) => {
    setBusy(true)
    try {
      const ext = node.kind === 'richtext' ? 'html' : 'txt'
      const target = await desktopApi.pickExportFile(`${exportName(node.name)}.${ext}`)
      if (!target) return
      const { dir, fileName } = splitPath(target)
      const items = await exportItems([node])
      const result = await desktopApi.exportContents({ items, dir, fileName })
      reportResult(result.files, result.media, result.warnings)
    } catch (error) {
      message.error(`导出失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleExportAll = async () => {
    if (filtered.length === 0) return
    setBusy(true)
    try {
      const dir = await desktopApi.pickFolder()
      if (!dir) return
      const items = await exportItems(filtered)
      const result = await desktopApi.exportContents({ items, dir })
      reportResult(result.files, result.media, result.warnings)
    } catch (error) {
      message.error(`导出失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={780}
      title={`内容管理（${nodes.length}）`}
      className="content-manager"
    >
      <div className="content-manager-tools">
        <Input
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按标题或正文片段筛选"
          className="content-manager-search"
        />
        <Button icon={<ExportOutlined />} loading={busy} onClick={() => void handleExportAll()}>
          导出全部
        </Button>
      </div>

      <div className="content-manager-list">
        <div className="content-manager-row is-head">
          <span>名称</span>
          <span>类型</span>
          <span>所属空间</span>
          <span>字符</span>
          <span>操作</span>
        </div>
        {filtered.map((node) => (
          <div key={node.id} className="content-manager-row">
            <span className="content-manager-name" title={node.subtitle}>
              {node.name}
            </span>
            <span>{TYPE_LABEL[node.kind] ?? node.kind}</span>
            <span>
              <Select
                size="small"
                value={node.groupId || ''}
                popupMatchSelectWidth={false}
                onChange={(value) => onMoveToGroup(node.id, value)}
                options={[
                  { value: '', label: '未分组' },
                  ...groups.map((group) => ({ value: group.id, label: group.title })),
                ]}
                aria-label={`把 ${node.name} 移动到空间`}
              />
            </span>
            <span className="content-manager-count">{node.subtitle.length}</span>
            <span className="content-manager-actions">
              <Button
                type="text"
                size="small"
                icon={<AimOutlined />}
                aria-label="定位"
                title="在画布上定位"
                onClick={() => onLocate(node.id)}
              />
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label="编辑"
                title="编辑内容"
                onClick={() => onEdit(node.id)}
              />
              <Button
                type="text"
                size="small"
                icon={<ExportOutlined />}
                aria-label="导出"
                title={node.kind === 'richtext' ? '导出为 HTML（含本地媒体）' : '导出为 TXT'}
                loading={busy}
                onClick={() => void handleExportOne(node)}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除"
                title="从画布删除"
                onClick={() => onDelete(node.id)}
              />
            </span>
          </div>
        ))}
        {filtered.length === 0 ? (
          <p className="content-manager-empty">
            {nodes.length === 0 ? '还没有文字或富文本内容。' : '没有匹配的内容。'}
          </p>
        ) : null}
      </div>

      <p className="details-note">
        富文本导出为 HTML，正文引用的图片/视频会复制到同一目录；纯文本导出为
        TXT。原内容仍留在画布上。
      </p>
    </Modal>
  )
}
