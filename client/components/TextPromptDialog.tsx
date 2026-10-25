/**
 * 通用文本输入弹窗：连线标签、空间标题等单行文本编辑共用。
 * 通过 `open` 控制显示，调用方用 key 重建以带入初始值。
 */
import { Input, Modal } from 'antd'
import { useState } from 'react'

interface TextPromptDialogProps {
  open: boolean
  title: string
  placeholder: string
  initialText: string
  maxLength?: number
  onCancel: () => void
  onSave: (text: string) => void
}

export default function TextPromptDialog({
  open,
  title,
  placeholder,
  initialText,
  maxLength = 32,
  onCancel,
  onSave,
}: TextPromptDialogProps) {
  const [text, setText] = useState(initialText)

  return (
    <Modal
      open={open}
      title={title}
      okText="保存"
      cancelText="取消"
      onOk={() => onSave(text)}
      onCancel={onCancel}
      keyboard
      destroyOnHidden
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        onPressEnter={() => onSave(text)}
      />
    </Modal>
  )
}
