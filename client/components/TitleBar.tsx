/**
 * 无边框窗口的标题栏：左侧 logo，搜索绝对居中，右侧操作与窗口按钮。
 * 搜索的下拉面板依赖 `.search-area` 的 z-index 浮在画布之上。
 */
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, Input, Popover, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import logoUrl from '../../assets/ploceusTidy.jpg'
import type { SearchEntry } from '@/types/scene'
import SystemIcon from './SystemIcon'

interface TitleBarProps {
  query: string
  results: SearchEntry[]
  onQueryChange: (value: string) => void
  onSelectResult: (entry: SearchEntry) => void
  onOpenResult: (entry: SearchEntry) => void
  onNewText: () => void
  onSettings: () => void
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
  annotation: '标注',
}

/** 快捷键说明：鼠标悬停问号即可查看，不占用画布空间。 */
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '空格 + 左键拖拽', label: '平移画布' },
  { keys: 'Alt + 滚轮', label: '以指针为中心缩放' },
  { keys: '左键拖拽空白', label: '框选多个对象' },
  { keys: 'Shift + 点击', label: '追加或取消选中' },
  { keys: '拖拽四向圆点', label: '连线到另一个对象' },
  { keys: '双击文字', label: '直接在画布上编辑' },
  { keys: '双击文件', label: '打开原文件' },
  { keys: 'G / L', label: '把选中对象放进空间 / 建立连线' },
  { keys: '右键对象', label: '打开、定位、标注、属性、删除' },
  { keys: 'Delete / Ctrl+Z', label: '删除 / 撤销删除' },
  { keys: 'Ctrl+A / Ctrl+K', label: '全选 / 聚焦搜索' },
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
    onSettings,
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
      const entry = results[activeIndex]
      if (!entry) return
      if (event.ctrlKey || event.metaKey) onOpenResult(entry)
      else onSelectResult(entry)
      setOpen(false)
    } else if (event.key === 'Escape') {
      event.preventDefault()
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
          placeholder="搜索文件、路径、文字、URL 或标注"
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
                <div className="search-caption">{query.trim() ? '搜索结果' : '最近 / 建议'}</div>
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
                <span>试试文件名、路径、文字、URL 或标注</span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="title-actions">
        <Tooltip title="新建文字">
          <Button
            className="title-icon-btn"
            type="text"
            icon={<PlusOutlined />}
            aria-label="新建文字"
            onClick={onNewText}
          />
        </Tooltip>
        <Tooltip title="设置">
          <Button
            className="title-icon-btn"
            type="text"
            icon={<SettingOutlined />}
            aria-label="设置"
            onClick={onSettings}
          />
        </Tooltip>
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
