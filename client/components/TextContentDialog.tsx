/**
 * 纯文本内容弹窗：多行编辑文字卡的内容，保存后写回名称与正文。
 * 复用 `TextPromptDialog` 的弹窗形态，只是把单行输入换成多行文本域。
 *
 * 快捷键：Ctrl+S 就地保存并留在弹窗（继续写），「保存」按钮保存并关闭，取消时若有改动先确认。
 */
import AntApp from 'antd/es/app'
import Input from 'antd/es/input'
import Modal from 'antd/es/modal'
import { useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

interface TextContentDialogProps {
  initialText: string
  onCancel: () => void
  /** 保存并关闭。 */
  onSave: (text: string) => void
  /** 就地保存：写回内容但不关闭弹窗。 */
  onQuickSave: (text: string) => void
}

export default function TextContentDialog({
  initialText,
  onCancel,
  onSave,
  onQuickSave,
}: TextContentDialogProps) {
  const [text, setText] = useState(initialText)
  const { modal } = AntApp.useApp()
  const dirty = text !== initialText

  const quickSave = () => {
    if (!dirty) return
    onQuickSave(text)
  }

  const requestCancel = () => {
    if (!dirty) {
      onCancel()
      return
    }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '这段文字还没有保存，关闭后改动会丢失。',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: onCancel,
    })
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    event.stopPropagation()
    quickSave()
  }

  return (
    <Modal
      open
      title="编辑文字"
      width={520}
      okText="保存"
      cancelText="取消"
      onOk={() => onSave(text)}
      onCancel={requestCancel}
    >
      <Input.TextArea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        autoSize={{ minRows: 8, maxRows: 16 }}
        placeholder="写下结论、待办或项目说明；第一行会作为卡片名称（Ctrl+S 保存但不关闭）"
      />
    </Modal>
  )
}
