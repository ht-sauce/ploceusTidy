/**
 * 纯文本内容弹窗：多行编辑文字卡的内容，改动在停顿后自动写回（防抖 500ms）。
 * 复用 `TextPromptDialog` 的弹窗形态，只是把单行输入换成多行文本域。
 *
 * 自动保存意味着关闭不再需要二次确认：关闭前会把尚未写回的那一次改动立即落库。
 * Ctrl+S 仍然可用，用来立即保存并给出「已保存」反馈。
 */
import Input from 'antd/es/input'
import Modal from 'antd/es/modal'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** 输入停顿多久算一次自动保存；太短会频繁写库，太长又会让「输入后立刻关窗」丢字。 */
const AUTOSAVE_DELAY = 500

interface TextContentDialogProps {
  initialText: string
  onCancel: () => void
  /** 保存并关闭。 */
  onSave: (text: string) => void
  /** 就地保存：写回内容但不关闭弹窗。 */
  onQuickSave: (text: string) => void
  /** 自动保存：静默写回，不关闭弹窗、不提示。 */
  onAutoSave: (text: string) => void
}

export default function TextContentDialog({
  initialText,
  onCancel,
  onSave,
  onQuickSave,
  onAutoSave,
}: TextContentDialogProps) {
  const [text, setText] = useState(initialText)
  /** 最新输入：关闭时不等 React 状态刷新，直接读它；只在输入回调里更新。 */
  const latestRef = useRef(initialText)
  /** 已经写回过的内容，避免同一份文字重复写库。 */
  const savedRef = useRef(initialText)
  const timerRef = useRef(0)

  /** 立即写回待保存的改动；已同步过则什么也不做。 */
  const flush = () => {
    window.clearTimeout(timerRef.current)
    timerRef.current = 0
    const value = latestRef.current
    if (value === savedRef.current) return
    savedRef.current = value
    onAutoSave(value)
  }

  // 卸载时清掉未触发的定时器；关闭路径本身都会先 flush。
  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const handleChange = (value: string) => {
    latestRef.current = value
    setText(value)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flush, AUTOSAVE_DELAY)
  }

  const handleCancel = () => {
    flush()
    onCancel()
  }

  const handleSave = () => {
    flush()
    onSave(latestRef.current)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    event.stopPropagation()
    flush()
    onQuickSave(latestRef.current)
  }

  return (
    <Modal
      open
      title="编辑文字"
      width={520}
      okText="保存"
      cancelText="关闭"
      onOk={handleSave}
      onCancel={handleCancel}
    >
      <Input.TextArea
        value={text}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        autoSize={{ minRows: 8, maxRows: 16 }}
        placeholder="写下结论、待办或项目说明；第一行会作为卡片名称（改动会自动保存）"
      />
      <p className="rich-editor-hint">改动会自动保存；关闭不会丢失，Ctrl+S 可立即保存。</p>
    </Modal>
  )
}
