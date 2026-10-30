/**
 * 无边框窗口的标题栏：左侧 logo，搜索绝对居中，右侧操作与窗口按钮。
 * 搜索的下拉面板依赖 `.search-area` 的 z-index 浮在画布之上。
 */
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import Button from 'antd/es/button'
import Dropdown from 'antd/es/dropdown'
import Input from 'antd/es/input'
import type { InputRef } from 'antd/es/input'
import type { MenuProps } from 'antd/es/menu'
import Popover from 'antd/es/popover'
import Tooltip from 'antd/es/tooltip'
import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import logoUrl from '../../assets/ploceusTidy.jpg'
import type { SearchEntry } from '@/types/scene'
import type { SearchFilter } from '@/workspace/useSearch'
import SystemIcon from './SystemIcon'

interface TitleBarProps {
  query: string
  results: SearchEntry[]
  onQueryChange: (value: string) => void
  onSelectResult: (entry: SearchEntry) => void
  onOpenResult: (entry: SearchEntry) => void
  onNewText: () => void
  onNewRichText: () => void
  onSettings: () => void
  /** 内容管理：文字与富文本的集中列表。 */
  onOpenContentManager: () => void
  /** 左侧大纲树的开关状态。 */
  outlineOpen: boolean
  onToggleOutline: () => void
  filter: SearchFilter
  onFilterChange: (filter: SearchFilter) => void
  /** 有可用更新时在设置按钮上打红点，不打断当前操作。 */
  hasUpdate: boolean
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
}

export interface TitleBarHandle {
  focusSearch: () => void
}

const TYPE_LABEL: Record<string, string> = {
  file: '文件',
  folder: '文件夹',
  image: '图片',
  video: '视频',
  link: '链接',
  text: '文字',
  richtext: '富文本',
  annotation: '标注',
  group: '空间',
  edge: '连线',
}

/** 快捷键说明：鼠标悬停问号即可查看，不占用画布空间。 */
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '空格 + 左键拖拽', label: '平移画布' },
  { keys: 'Alt + 滚轮', label: '以指针为中心缩放' },
  { keys: '左键拖拽空白', label: '框选多个对象' },
  { keys: 'Shift + 点击', label: '追加或取消选中' },
  { keys: '方向键 / Shift + 方向键', label: '微调 1px / 10px' },
  { keys: '拖拽四向圆点', label: '连线到另一个对象' },
  { keys: 'Ctrl + 点击/拖拽文件', label: '拖到外部程序打开' },
  { keys: '双击文字或富文本', label: '打开内容编辑弹窗' },
  { keys: '双击文件', label: '打开原文件' },
  { keys: 'G / L', label: '把选中对象放进空间 / 建立连线' },
  { keys: '右键对象', label: '打开、定位、标注、属性、删除' },
  { keys: 'Delete / Ctrl+Z / Ctrl+Shift+Z', label: '删除 / 撤销 / 重做' },
  { keys: 'Ctrl+S', label: '立即保存（编辑弹窗内也不关闭）' },
  { keys: 'Ctrl+A / Ctrl+K', label: '全选 / 聚焦搜索' },
  { keys: 'Ctrl+Alt+Space', label: '任意位置唤起并搜索' },
]

const FILTERS: { key: SearchFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'file', label: '文件' },
  { key: 'content', label: '文字' },
  { key: 'group', label: '空间' },
  { key: 'edge', label: '连线' },
  { key: 'annotation', label: '标注' },
]

const HELP_PANEL = (
  <div className="shortcut-panel">
    <div className="shortcut-caption">画布操作</div>
    {SHORTCUTS.map((item) => (
      <div key={item.keys} className="shortcut-row">
        <kbd>{item.keys}</kbd>
        <span>{item.label}</span>
      </div>
    ))}
  </div>
)

const TitleBar = forwardRef<TitleBarHandle, TitleBarProps>(function TitleBar(
  {
    query,
    results,
    onQueryChange,
    onSelectResult,
    onOpenResult,
    onNewText,
    onNewRichText,
    onSettings,
    onOpenContentManager,
    outlineOpen,
    onToggleOutline,
    filter,
    onFilterChange,
    hasUpdate,
    onMinimize,
    onMaximize,
    onClose,
  },
  ref,
) {
  const inputRef = useRef<InputRef>(null)
  const blurTimer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const focusSearch = useCallback(() => {
    inputRef.current?.focus()
    setOpen(true)
    setActiveIndex(0)
  }, [])

  // 「+」用的是菜单而不是直接新建：纯文本与富文本的编辑方式完全不同，先让用户选。
  const newMenu: MenuProps = {
    items: [
      { key: 'text', label: '纯文本' },
      { key: 'richtext', label: '富文本' },
    ],
    onClick: ({ key }) => {
      if (key === 'text') onNewText()
      else onNewRichText()
    },
  }

  // 齿轮拆成两块：系统设置（外观/工作空间/窗口/数据）与内容管理（文字与富文本）。
  const settingsMenu: MenuProps = {
    items: [
      { key: 'system', label: '系统设置' },
      { key: 'content', label: '内容管理' },
    ],
    onClick: ({ key }) => {
      if (key === 'content') onOpenContentManager()
      else onSettings()
    },
  }

  useImperativeHandle(ref, () => ({ focusSearch }), [focusSearch])

  const closeLater = () => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current)
    blurTimer.current = window.setTimeout(() => setOpen(false), 130)
  }

  const handleFocus = () => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current)
    setOpen(true)
    setActiveIndex(0)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      // 筛选后结果变短时 activeIndex 可能已越界，夹取到末尾而不是静默无响应。
      const entry = results[Math.min(activeIndex, results.length - 1)]
      if (!entry) return
      if (event.ctrlKey || event.metaKey) onOpenResult(entry)
      else onSelectResult(entry)
      setOpen(false)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      // 搜索框的 Esc 只关搜索面板：不再冒泡去清空画布选中。
      event.stopPropagation()
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const selectEntry = (entry: SearchEntry) => {
    onSelectResult(entry)
    setOpen(false)
  }

  return (
    // data-tauri-drag-region 只作用于标题栏本身，按钮与搜索框不会触发拖动。
    <header className="title-bar" data-tauri-drag-region>
      <div className="brand">
        <img className="brand-logo" src={logoUrl} alt="络雀" />
        <span className="brand-name">络雀</span>
      </div>

      <div className="search-area">
        <Input
          ref={inputRef}
          className="search-input"
          value={query}
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索文件、路径、文字、URL、标注、空间或连线"
          onChange={(event) => {
            onQueryChange(event.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onFocus={handleFocus}
          onBlur={closeLater}
          onKeyDown={handleKeyDown}
          aria-label="搜索画布"
        />

        {open ? (
          <div className="search-panel" role="listbox">
            {results.length > 0 ? (
              <>
                <div className="search-caption">{query.trim() ? '搜索结果' : '最近'}</div>
                <div className="search-filters" role="group" aria-label="按类型筛选">
                  {FILTERS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`search-filter${filter === item.key ? ' is-active' : ''}`}
                      aria-pressed={filter === item.key}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        onFilterChange(item.key)
                        // 结果集会变短，高亮必须回到第一条，否则 Enter 落到越界索引。
                        setActiveIndex(0)
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {results.map((entry, index) => (
                  <button
                    key={`${entry.type}-${entry.nodeId}-${index}`}
                    type="button"
                    className={`search-row${index === activeIndex ? ' is-active' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectEntry(entry)}
                    role="option"
                    aria-selected={index === activeIndex}
                  >
                    <SystemIcon kind={entry.icon} size={18} />
                    <span className="search-row-copy">
                      <span className="search-row-title">{entry.title}</span>
                      <span className="search-row-sub">{entry.subtitle}</span>
                    </span>
                    <span className="search-row-type">{TYPE_LABEL[entry.type] ?? '对象'}</span>
                  </button>
                ))}
                <div className="search-footer">
                  <span>Enter 定位</span>
                  <span>Ctrl Enter 打开</span>
                  <span>Esc 关闭</span>
                </div>
              </>
            ) : (
              <div className="search-empty">
                <strong>没有匹配结果</strong>
                <span>试试文件名、路径、文字、URL、标注、空间或连线</span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="title-actions">
        <Tooltip title="新建内容">
          <Dropdown menu={newMenu} placement="bottomRight" trigger={['click']}>
            <Button
              className="title-icon-btn"
              type="text"
              icon={<PlusOutlined />}
              aria-label="新建内容"
            />
          </Dropdown>
        </Tooltip>
        <Tooltip title={outlineOpen ? '收起大纲' : '展开大纲'}>
          <Button
            className={`title-icon-btn${outlineOpen ? ' is-active' : ''}`}
            type="text"
            icon={<UnorderedListOutlined />}
            aria-label="大纲"
            aria-pressed={outlineOpen}
            onClick={onToggleOutline}
          />
        </Tooltip>
        <Dropdown menu={settingsMenu} placement="bottomRight" trigger={['click']}>
          <Button
            // 有更新时用角标提示，不弹窗打断：气泡组件会吃掉 Dropdown 需要的点击事件。
            className={`title-icon-btn${hasUpdate ? ' has-update' : ''}`}
            type="text"
            icon={<SettingOutlined />}
            aria-label={hasUpdate ? '设置与内容管理（有新版本）' : '设置与内容管理'}
          />
        </Dropdown>
        <Popover
          content={HELP_PANEL}
          placement="bottomRight"
          trigger="hover"
          mouseEnterDelay={0.15}
        >
          <Button
            className="title-icon-btn"
            type="text"
            icon={<QuestionCircleOutlined />}
            aria-label="操作说明"
          />
        </Popover>
        <span className="window-divider" />
        <Tooltip title="最小化">
          <Button
            className="title-icon-btn window-btn"
            type="text"
            icon={<MinusOutlined />}
            aria-label="最小化"
            onClick={onMinimize}
          />
        </Tooltip>
        <Tooltip title="最大化">
          <Button
            className="title-icon-btn window-btn"
            type="text"
            icon={<BorderOutlined />}
            aria-label="最大化"
            onClick={onMaximize}
          />
        </Tooltip>
        <Tooltip title="关闭">
          <Button
            className="title-icon-btn window-btn close-btn"
            type="text"
            icon={<CloseOutlined />}
            aria-label="关闭"
            onClick={onClose}
          />
        </Tooltip>
      </div>
    </header>
  )
})

TitleBar.displayName = 'TitleBar'

export default TitleBar
