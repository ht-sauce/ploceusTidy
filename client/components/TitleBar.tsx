import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, Input, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
  PlusOutlined,
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
