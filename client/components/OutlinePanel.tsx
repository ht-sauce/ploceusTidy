/**
 * 左侧大纲树：把空间与对象平铺成可折叠的树，解决「画布放大了找不到」。
 *
 * 边界：
 * - 只做导航（定位 + 选中），不改任何场景数据；
 * - 树的展开/收起是纯界面状态，不持久化，也不进撤销栈；
 * - 折叠空间（画布上的）不影响树里的展开状态，两处互不干扰。
 */
import { useMemo, useState } from 'react'
import Button from 'antd/es/button'
import { CloseOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import type { SceneGroup, SceneNode } from '@/types/scene'
import SystemIcon from './SystemIcon'

interface OutlinePanelProps {
  nodes: SceneNode[]
  groups: SceneGroup[]
  selectedIds: string[]
  selectedGroupId: string | null
  onLocateNode: (id: string) => void
  onLocateGroup: (id: string) => void
  onClose: () => void
}

interface GroupBucket {
  group: SceneGroup
  members: SceneNode[]
}

export default function OutlinePanel({
  nodes,
  groups,
  selectedIds,
  selectedGroupId,
  onLocateNode,
  onLocateGroup,
  onClose,
}: OutlinePanelProps) {
  // 默认全部展开：刚打开就要能看到结构；用户收起后不再自动改回来。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const buckets = useMemo(() => {
    const byGroup = new Map<string, SceneNode[]>()
    const loose: SceneNode[] = []
    nodes.forEach((node) => {
      if (!node.groupId) {
        loose.push(node)
        return
      }
      const list = byGroup.get(node.groupId)
      if (list) list.push(node)
      else byGroup.set(node.groupId, [node])
    })
    const grouped: GroupBucket[] = groups.map((group) => ({
      group,
      members: byGroup.get(group.id) ?? [],
    }))
    return { grouped, loose }
  }, [groups, nodes])

  const allKeys = useMemo(
    () => ['loose', ...buckets.grouped.map((bucket) => bucket.group.id)],
    [buckets.grouped],
  )

  const toggle = (key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = () => setCollapsed(new Set())
  const collapseAll = () => setCollapsed(new Set(allKeys))

  const renderNode = (node: SceneNode) => (
    <button
      key={node.id}
      type="button"
      className={`outline-row outline-node${selectedIds.includes(node.id) ? ' is-active' : ''}`}
      onClick={() => onLocateNode(node.id)}
      title={node.path ?? node.name}
    >
      <SystemIcon kind={node.icon} size={14} />
      <span className="outline-label">{node.name}</span>
    </button>
  )

  return (
    <aside className="outline-panel">
      <div className="outline-head">
        <span className="details-kicker">大纲</span>
        <span className="outline-count">{nodes.length} 个对象</span>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="关闭大纲"
          onClick={onClose}
        />
      </div>

      <div className="outline-tools">
        <Button type="link" size="small" onClick={expandAll}>
          全部展开
        </Button>
        <Button type="link" size="small" onClick={collapseAll}>
          全部收起
        </Button>
      </div>

      <div className="outline-body">
        {buckets.grouped.map(({ group, members }) => {
          const open = !collapsed.has(group.id)
          return (
            <div key={group.id} className="outline-branch">
              <div
                className={`outline-row outline-group${selectedGroupId === group.id ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  className="outline-twisty"
                  aria-label={open ? '收起空间' : '展开空间'}
                  aria-expanded={open}
                  onClick={() => toggle(group.id)}
                >
                  {open ? <DownOutlined /> : <RightOutlined />}
                </button>
                <button
                  type="button"
                  className="outline-group-title"
                  onClick={() => onLocateGroup(group.id)}
                  title={group.title}
                >
                  <span
                    className="outline-dot"
                    style={{ background: group.color || 'var(--accent)' }}
                  />
                  <span className="outline-label">{group.title}</span>
                  <span className="outline-badge">{members.length}</span>
                </button>
              </div>
              {open ? <div className="outline-children">{members.map(renderNode)}</div> : null}
            </div>
          )
        })}

        {buckets.loose.length > 0 ? (
          <div className="outline-branch">
            <div className="outline-row outline-group">
              <button
                type="button"
                className="outline-twisty"
                aria-label={collapsed.has('loose') ? '展开未分组' : '收起未分组'}
                aria-expanded={!collapsed.has('loose')}
                onClick={() => toggle('loose')}
              >
                {collapsed.has('loose') ? <RightOutlined /> : <DownOutlined />}
              </button>
              <span className="outline-group-title is-static">
                <span className="outline-label">未分组</span>
                <span className="outline-badge">{buckets.loose.length}</span>
              </span>
            </div>
            {collapsed.has('loose') ? null : (
              <div className="outline-children">{buckets.loose.map(renderNode)}</div>
            )}
          </div>
        ) : null}

        {nodes.length === 0 ? (
          <p className="outline-empty">画布还是空的，拖入文件或新建文字。</p>
        ) : null}
      </div>
    </aside>
  )
}
