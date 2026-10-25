/**
 * 关联对象选择器：一个对象连了多个目标时，让用户选择要跳转到哪一个。
 */
import Modal from 'antd/es/modal'
import type { CanvasContextTarget } from '@/canvas/types'

export interface NeighborOption {
  id: string
  label: string
  kind: CanvasContextTarget['kind']
}

interface NeighborPickerDialogProps {
  open: boolean
  options: NeighborOption[]
  onCancel: () => void
  onPick: (id: string) => void
}

export default function NeighborPickerDialog({
  open,
  options,
  onCancel,
  onPick,
}: NeighborPickerDialogProps) {
  return (
    <Modal
      open={open}
      title="选择要跳转的关联对象"
      footer={null}
      onCancel={onCancel}
      destroyOnHidden
    >
      <div className="neighbor-list">
        {options.map((option) => (
          <button
            key={`${option.kind}-${option.id}`}
            type="button"
            className="neighbor-option"
            onClick={() => onPick(option.id)}
          >
            <span className="neighbor-kind">{option.kind === 'group' ? '空间' : '对象'}</span>
            <span className="neighbor-label">{option.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
