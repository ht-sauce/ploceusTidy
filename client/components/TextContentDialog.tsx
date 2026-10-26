/**
 * 纯文本内容弹窗：多行编辑文字卡的内容，保存后写回名称与正文。
 * 复用 `TextPromptDialog` 的弹窗形态，只是把单行输入换成多行文本域。
 */
import Input from 'antd/es/input'
import Modal from 'antd/es/modal'
import { useState } from 'react'

interface TextContentDialogProps {
  initialText: string
  onCancel: () => void
  onSave: (text: string) => void
}

export default function TextContentDialog({
  initialText,
  onCancel,
  onSave,
}: TextContentDialogProps) {
  const [text, setText] = useState(initialText)

  return (
    <Modal
      open
      title="编辑文字"
      width={520}
      okText="保存"
      cancelText="取消"
      onOk={() => onSave(text)}
      onCancel={onCancel}
    >
      <Input.TextArea
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoSize={{ minRows: 8, maxRows: 16 }}
        placeholder="写下结论、待办或项目说明；第一行会作为卡片名称"
      />
    </Modal>
  )
}
