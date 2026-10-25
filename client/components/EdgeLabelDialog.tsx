/**
 * 连线标签编辑弹窗：双击连线或右键菜单触发，留空表示清除标签。
 */
import { Input, Modal } from 'antd'
import { useState } from 'react'

interface EdgeLabelDialogProps {
  /** 非空表示弹窗打开，值为连线 ID。 */
  edgeId: string | null
  initialText: string
  onCancel: () => void
  onSave: (text: string) => void
}

export default function EdgeLabelDialog({
  edgeId,
  initialText,
  onCancel,
  onSave,
}: EdgeLabelDialogProps) {
  const [text, setText] = useState(initialText)

  return (
    <Modal
      open={edgeId !== null}
      title="连线标签"
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
        placeholder="留空则清除标签"
        maxLength={24}
        onPressEnter={() => onSave(text)}
      />
    </Modal>
  )
}
