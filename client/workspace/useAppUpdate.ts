/**
 * 自动更新：启动后后台检查（24h 节流）、手动检查、下载与安装重启。
 *
 * 边界：
 * - 检查只读 GitHub Releases 上的 `latest.json`，不发送任何本地数据（HC-13）；
 * - 更新包由插件用内置公钥验签，签名不符直接失败，不会执行下载物；
 * - 安装会替换程序并重启进程，因此安装前必须先落库（`onBeforeInstall` 抛错即中止）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import type { MessageInstance } from 'antd/es/message/interface'
import { desktopApi, isDesktopClient, logLine } from '@/lib/tauri-api'

export type UpdatePhase =
  /** 尚未检查或自动检查被节流跳过 */
  'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** 新版本号；未发现更新时为 null。 */
  version: string | null
  /** 发布说明（取 release 正文）；可能为空。 */
  notes: string | null
  /** 下载进度百分比。 */
  percent: number
  error: string | null
}

/** 后台检查间隔：一天一次足够，避免每次启动都打 GitHub。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 启动后延迟：先让窗口与画布就绪，不与加载抢网络与主线程。 */
const START_DELAY_MS = 8000
const CHECKED_AT_KEY = 'update_checked_at'

const INITIAL: UpdateStatus = {
  phase: 'idle',
  version: null,
  notes: null,
  percent: 0,
  error: null,
}

interface UpdateOptions {
  message: MessageInstance
  /** 安装前落库；失败向上抛以中止安装（更新完丢数据比不更新更糟）。 */
  onBeforeInstall: () => Promise<void>
}

export function useAppUpdate({ message, onBeforeInstall }: UpdateOptions) {
  const [status, setStatus] = useState<UpdateStatus>(INITIAL)
  const updateRef = useRef<Update | null>(null)
  const checkingRef = useRef(false)

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (!isDesktopClient || checkingRef.current) return
      checkingRef.current = true
      setStatus((previous) => ({ ...previous, phase: 'checking', error: null }))
      try {
        const update = await check()
        if (!update) {
          updateRef.current = null
          setStatus({ ...INITIAL, phase: 'latest' })
          if (manual) message.success('已是最新版本')
          return
        }
        updateRef.current = update
        setStatus({
          phase: 'available',
          version: update.version,
          notes: update.body ?? null,
          percent: 0,
          error: null,
        })
        if (!manual) message.info(`发现新版本 ${update.version}，可在「设置 → 关于」更新`)
        // 只有真正连上更新源才记时间，断网时下一次启动继续尝试。
        void desktopApi.metaSet(CHECKED_AT_KEY, String(Date.now())).catch(() => {
          // 记录失败只影响节流，不影响更新本身。
        })
      } catch (error) {
        const text = String(error)
        logLine('warn', `检查更新失败：${text}`)
        // 自动检查失败不打扰用户：联网异常是常态，下次启动再试。
        setStatus((previous) => (manual ? { ...previous, phase: 'error', error: text } : previous))
        if (manual) message.error(`检查更新失败：${text}`)
      } finally {
        checkingRef.current = false
      }
    },
    [message],
  )

  // 启动后台检查：读上次检查时间决定是否真的要打网络。
  useEffect(() => {
    if (!isDesktopClient) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const raw = await desktopApi.metaGet(CHECKED_AT_KEY).catch(() => null)
        const last = Number(raw ?? 0)
        if (Number.isFinite(last) && last > 0 && Date.now() - last < CHECK_INTERVAL_MS) return
        if (cancelled) return
        await runCheck(false)
      })()
    }, START_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [runCheck])

  /** 下载 → 落库 → 安装 → 重启；任一步失败都停在可重试状态。 */
  const install = useCallback(async () => {
    const update = updateRef.current
    if (!update) return
    setStatus((previous) => ({ ...previous, phase: 'downloading', percent: 0, error: null }))
    try {
      let total = 0
      let received = 0
      await update.download((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength
          const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
          setStatus((previous) =>
            previous.phase === 'downloading' ? { ...previous, percent } : previous,
          )
        }
      })
      await onBeforeInstall()
      setStatus((previous) => ({ ...previous, phase: 'ready', percent: 100 }))
      await update.install()
      await relaunch()
    } catch (error) {
      const text = String(error)
      logLine('error', `安装更新失败：${text}`)
      setStatus((previous) => ({ ...previous, phase: 'error', error: text }))
      message.error(`更新失败：${text}`)
    }
  }, [message, onBeforeInstall])

  const checkNow = useCallback(() => void runCheck(true), [runCheck])
  const hasUpdate = status.phase === 'available' || status.phase === 'ready'

  return { status, hasUpdate, checkNow, install }
}
