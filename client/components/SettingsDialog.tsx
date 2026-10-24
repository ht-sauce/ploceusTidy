import { useState } from 'react'
import { App as AntApp, Button, Modal, Switch } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  workspacePath: string
}

export default function SettingsDialog({ open, onClose, workspacePath }: SettingsDialogProps) {
  const { message } = AntApp.useApp()
  const [desktopPin, setDesktopPin] = useState(false)
  const [pauseWhenMinimized, setPauseWhenMinimized] = useState(true)

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      title="设置"
      className="settings-modal"
      mask={{ closable: true }}
      keyboard
    >
      <section className="settings-section">
        <h3>本地工作空间</h3>
        <div className="workspace-path">
          <code>{workspacePath || '工作空间尚未初始化'}</code>
          <span>SQLite · 截图资源 · 缩略图</span>
        </div>
        <div className="settings-actions">
          <Button
            size="small"
            onClick={() => message.info('正式版会复制、校验后切换 dataWorkSpace')}
          >
            更改位置
          </Button>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => message.info('正式版会在资源管理器中打开 dataWorkSpace')}
          >
            打开目录
          </Button>
        </div>
      </section>

      <section className="settings-section">
        <h3>窗口</h3>
        <div className="settings-row">
          <div>
            <strong>桌面常驻</strong>
            <span>像桌面工具一样置底显示，默认关闭</span>
          </div>
          <Switch
            checked={desktopPin}
            onChange={(checked) => {
              setDesktopPin(checked)
              message.info(checked ? '桌面常驻：开（演示）' : '桌面常驻：关')
            }}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>最小化时暂停渲染</strong>
            <span>窗口不可见时停止画布与缩略图加载</span>
          </div>
          <Switch
            checked={pauseWhenMinimized}
            onChange={(checked) => {
              setPauseWhenMinimized(checked)
              message.info(checked ? '最小化暂停渲染：开' : '最小化暂停渲染：关')
            }}
          />
        </div>
      </section>

      <section className="settings-section">
        <h3>数据</h3>
        <div className="settings-row settings-row-danger">
          <div>
            <strong>重建工作空间</strong>
            <span>清空索引重新导入；原文件永远不动</span>
          </div>
          <Button
            danger
            size="small"
            onClick={() => message.warning('重建需要二次确认；原文件不会被动')}
          >
            重建
          </Button>
        </div>
      </section>

      <p className="settings-note">
        络雀不连接云端，不上传文件内容或元数据。URL
        只交给系统浏览器打开；SQLite、截图副本与缩略图都存放在 dataWorkSpace。
      </p>

      <div className="settings-footer">
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Modal>
  )
}
