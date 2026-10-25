/**
 * 应用入口：只负责主题状态与 Ant Design 容器。
 * 业务编排在工作空间容器，画布在 CanvasBoard，场景领域在 workspace/useSceneStore。
 */
import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd'
import Workspace from '@/workspace/Workspace'
import { desktopApi, isDesktopClient } from '@/lib/tauri-api'
import { DEFAULT_THEME, applyTheme, normalizeTheme, themeById } from '@/lib/theme'
import type { ThemeId } from '@/types/scene'

export default function App() {
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME)

  useEffect(() => {
    applyTheme(themeId)
  }, [themeId])

  useEffect(() => {
    if (!isDesktopClient) return
    desktopApi
      .metaGet('ui_theme')
      .then((value) => setThemeId(normalizeTheme(value)))
      .catch(() => {
        // 读取失败时保持默认主题，不影响启动。
      })
  }, [])

  const handleThemeChange = useCallback((id: ThemeId) => {
    const next = normalizeTheme(id)
    setThemeId(next)
    applyTheme(next)
    if (isDesktopClient) {
      void desktopApi.metaSet('ui_theme', next).catch(() => {
        // 持久化失败只在下次启动回退默认主题，不打断当前切换。
      })
    }
  }, [])

  const tokens = themeById(themeId)

  return (
    <ConfigProvider
      componentSize="small"
      theme={{
        algorithm: antdTheme.compactAlgorithm,
        token: {
          colorPrimary: tokens.primary,
          colorBgBase: tokens.surface,
          colorBgContainer: tokens.surface,
          colorBorder: tokens.border,
          borderRadius: 6,
          fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        },
      }}
    >
      <AntApp>
        <Workspace themeId={themeId} onThemeChange={handleThemeChange} />
      </AntApp>
    </ConfigProvider>
  )
}
