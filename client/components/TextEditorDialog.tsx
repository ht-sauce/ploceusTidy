import { useState } from 'react'
import { Input, Modal } from 'antd'
import type { SceneNode } from '@/types/scene'

interface TextEditorDialogProps {
  node: SceneNode | null
  onClose: () => void
  onSave: (nodeId: string, text: string) => void
}

export default function TextEditorDialog({ node, onClose, onSave }: TextEditorDialogProps) {
  const [text, setText] = useState(node?.body ?? node?.subtitle ?? '')

  if (!node) return null

  return (
    <Modal
      open
      title="编辑文字"
      okText="保存"
      cancelText="取消"
      onCancel={onClose}
      onOk={() => onSave(node.id, text)}
      keyboard
    >
      <Input.TextArea
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoSize={{ minRows: 6, maxRows: 14 }}
        placeholder="记录结论、待办或项目说明"
      />
    </Modal>
  )
}
