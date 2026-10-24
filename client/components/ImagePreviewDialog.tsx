/** 图片预览：复用 Ant Design Image 的缩放与拖拽能力，不额外引入查看器。 */
import { Image, Modal } from 'antd'

interface ImagePreviewDialogProps {
  open: boolean
  src: string
  title: string
  onClose: () => void
}

export default function ImagePreviewDialog({ open, src, title, onClose }: ImagePreviewDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      footer={null}
      width="auto"
      onCancel={onClose}
      className="image-preview-modal"
      keyboard
    >
      <Image src={src} style={{ maxHeight: '70vh', maxWidth: '78vw', objectFit: 'contain' }} />
    </Modal>
  )
}
