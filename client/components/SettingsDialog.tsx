/**
 * 设置弹窗：外观（四套主题）、本地工作空间、窗口行为与数据维护。
 * 所有开关写入 `app_meta`；迁移与重建都带二次确认，失败保留旧状态。
 */
import { useEffect, useState } from 'react'
import AntApp from 'antd/es/app'
import Button from 'antd/es/button'
import Modal from 'antd/es/modal'
import Switch from 'antd/es/switch'
import { FolderOpenOutlined } from '@ant-design/icons'
import type { ThemeId, WorkspaceInfo } from '@/types/scene'
import type { UpdateStatus } from '@/workspace/useAppUpdate'
import { THEMES, normalizeTheme } from '@/lib/theme'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  themeId: ThemeId
  onThemeChange: (id: ThemeId) => void
  workspace: WorkspaceInfo | null
  onWorkspaceChanged: (info: WorkspaceInfo) => void
  /** 最小化暂停偏好变化时同步给工作空间，立即生效。 */
  onPauseWhenMinimizedChange: (value: boolean) => void
  /** 全量校验引用是否仍存在（文件被搬走后不必重启应用）。 */
  onRevalidateRefs: () => void
  onSceneCleared: () => void
  /** 更新状态与动作：「关于」区据此显示检查结果、进度与安装入口。 */
  update: {
    status: UpdateStatus
    onCheck: () => void
    onInstall: () => void
  }
}

/** 更新状态一句话说明：文案只描述后果与下一步，不暴露底层错误码。 */
function updateHint(status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'latest':
      return '已是最新版本'
    case 'available':
      return `发现新版本 ${status.version}：下载后会自动重启完成安装，数据不受影响`
    case 'downloading':
      return `正在下载更新包 ${status.percent}%`
    case 'ready':
      return '更新包已就绪，正在重启安装…'
    case 'error':
      return `检查或安装失败：${status.error ?? '未知原因'}；可稍后重试`
    default:
      return '每次启动会自动检查一次，也可以现在手动检查'
  }
}

/** 字节数转可读大小；只用于设置面板展示。 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export default function SettingsDialog({
  open,
  onClose,
  themeId,
  onThemeChange,
  workspace,
  onWorkspaceChanged,
  onPauseWhenMinimizedChange,
  onRevalidateRefs,
  onSceneCleared,
  update,
}: SettingsDialogProps) {
  const { message, modal } = AntApp.useApp()
  // 本地刷新结果优先（迁移/重建后立即更新），否则用父组件传入的信息。
  const [fetched, setFetched] = useState<WorkspaceInfo | null>(null)
  const info = fetched ?? workspace
  const [desktopPin, setDesktopPin] = useState(false)
  const [pauseWhenMinimized, setPauseWhenMinimized] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !isDesktopClient) return
    Promise.all([
      desktopApi.metaGet('desktop_pin'),
      desktopApi.metaGet('pause_when_minimized'),
      desktopApi.workspaceGet(),
    ])
      .then(([pin, pause, next]) => {
        setDesktopPin(pin === '1')
        setPauseWhenMinimized(pause !== '0')
        setFetched(next)
      })
      .catch(() => {
        // 配置读取失败时保持默认值，不影响其他设置项。
      })
  }, [open])

  const handlePinChange = async (checked: boolean) => {
    setDesktopPin(checked)
    try {
      await desktopApi.windowSetPin(checked)
      await desktopApi.metaSet('desktop_pin', checked ? '1' : '0')
      message.success(checked ? '已置底常驻' : '已恢复普通窗口')
    } catch (error) {
      setDesktopPin(!checked)
      message.error(`切换桌面常驻失败：${String(error)}`)
    }
  }

  const handlePauseChange = async (checked: boolean) => {
    setPauseWhenMinimized(checked)
    try {
      await desktopApi.metaSet('pause_when_minimized', checked ? '1' : '0')
      onPauseWhenMinimizedChange(checked)
    } catch (error) {
      setPauseWhenMinimized(!checked)
      message.error(`保存设置失败：${String(error)}`)
    }
  }

  const handleOpenFolder = async () => {
    try {
      await desktopApi.workspaceOpen()
    } catch (error) {
      message.error(`打开目录失败：${String(error)}`)
    }
  }

  const handleMigrate = async () => {
    try {
      const target = await desktopApi.pickFolder()
      if (!target) return
      setBusy(true)
      const next = await desktopApi.workspaceMigrate(target)
      setFetched(next)
      onWorkspaceChanged(next)
      message.success('工作空间已迁移')
    } catch (error) {
      message.error(`迁移失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRebuild = () => {
    modal.confirm({
      title: '重建工作空间？',
      content: '将清空画布索引，截图副本会保留；原文件永远不会被修改。',
      okText: '确认重建',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          setBusy(true)
          await desktopApi.workspaceRebuild()
          onSceneCleared()
          const next = await desktopApi.workspaceGet()
          setFetched(next)
          onWorkspaceChanged(next)
          message.success('工作空间已重建')
        } catch (error) {
          message.error(`重建失败：${String(error)}`)
        } finally {
          setBusy(false)
        }
      },
    })
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      title="设置"
      className="settings-modal"
      mask={{ closable: true }}
      keyboard
    >
      <section className="settings-section">
        <h3>外观</h3>
        <div className="theme-grid">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`theme-swatch${item.id === themeId ? ' is-active' : ''}`}
              onClick={() => onThemeChange(normalizeTheme(item.id))}
              aria-pressed={item.id === themeId}
            >
              <span className="theme-dot" style={{ background: item.primary }} />
              <span className="theme-name">{item.name}</span>
            </button>
          ))}
        </div>
        <p className="settings-note">
          主题只改变界面语义色，不改变文件图标与画布内容；标注文字牌、空间与连线未自定义时跟随主题主色。
        </p>
      </section>

      <section className="settings-section">
        <h3>本地工作空间</h3>
        <div className="workspace-path">
          <code>{info?.path || '工作空间尚未初始化'}</code>
          <span>
            {info
              ? `${info.nodeCount.toLocaleString()} 个引用 · 数据库 ${formatBytes(
                  info.dbBytes,
                )} · 截图 ${formatBytes(info.assetsBytes)} · 缩略图 ${formatBytes(
                  info.thumbnailBytes,
                )}`
              : 'SQLite · 截图资源 · 缩略图'}
          </span>
        </div>
        <div className="settings-actions">
          <Button size="small" loading={busy} onClick={() => void handleMigrate()}>
            更改位置
          </Button>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => void handleOpenFolder()}
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
            <span>窗口压到普通窗口之下，像桌面工具一样常驻</span>
          </div>
          <Switch checked={desktopPin} onChange={(checked) => void handlePinChange(checked)} />
        </div>
        <div className="settings-row">
          <div>
            <strong>最小化时暂停渲染</strong>
            <span>窗口最小化或隐藏时暂停缩略图与画布动画，恢复后继续</span>
          </div>
          <Switch
            checked={pauseWhenMinimized}
            onChange={(checked) => void handlePauseChange(checked)}
          />
        </div>
      </section>

      <section className="settings-section">
        <h3>数据</h3>
        <div className="settings-row">
          <div>
            <strong>校验引用</strong>
            <span>重新比对原文件是否还在；被移动或删除的卡片会标回「缺失」</span>
          </div>
          <Button size="small" onClick={onRevalidateRefs}>
            立即校验
          </Button>
        </div>
        <div className="settings-row settings-row-danger">
          <div>
            <strong>重建工作空间</strong>
            <span>清空索引重新导入；截图副本保留，原文件永远不动</span>
          </div>
          <Button danger size="small" loading={busy} onClick={handleRebuild}>
            重建
          </Button>
        </div>
      </section>

      <section className="settings-section">
        <h3>关于</h3>
        <div className="settings-row">
          <div>
            <strong>络雀 {__APP_VERSION__}</strong>
            <span>Tauri 2 · React 19 · 纯本地，无云端与遥测</span>
          </div>
          {update.status.phase === 'available' || update.status.phase === 'downloading' ? (
            <Button
              size="small"
              type="primary"
              loading={update.status.phase === 'downloading'}
              onClick={update.onInstall}
            >
              {update.status.phase === 'downloading' ? '下载中' : '下载并安装'}
            </Button>
          ) : (
            <Button
              size="small"
              loading={update.status.phase === 'checking'}
              disabled={update.status.phase === 'ready'}
              onClick={update.onCheck}
            >
              检查更新
            </Button>
          )}
        </div>
        <p className="settings-note">{updateHint(update.status)}</p>
      </section>

      <div className="settings-footer">
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Modal>
  )
}
