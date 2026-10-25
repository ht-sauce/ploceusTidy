/**
 * 取色器弹窗：空间主色与连线颜色共用。
 * 颜色直接写回场景数据，用于区分多个空间与多条关系。
 */
import ColorPicker from 'antd/es/color-picker'
import Modal from 'antd/es/modal'
import { useState } from 'react'

interface ColorPickerDialogProps {
  open: boolean
  title: string
  value?: string
  fallback: string
  onCancel: () => void
  onSave: (color: string) => void
}

export default function ColorPickerDialog({
  open,
  title,
  value,
  fallback,
  onCancel,
  onSave,
}: ColorPickerDialogProps) {
  const [color, setColor] = useState(value || fallback)

  return (
    <Modal
      open={open}
      title={title}
      okText="应用"
      cancelText="取消"
      onOk={() => onSave(color)}
      onCancel={onCancel}
      destroyOnHidden
    >
      <div className="color-picker-row">
        <ColorPicker
          value={color}
          disabledAlpha
          showText
          onChange={(next) => setColor(next.toHexString())}
        />
        <span className="color-picker-hint">选一个区分度高的颜色，便于识别多个空间与连线。</span>
      </div>
    </Modal>
  )
}
