/**
 * 四套浅色主题的语义令牌：React、Ant Design 与画布共用同一份定义。
 * 只存主题 ID，不把色值写进数据库；缺省或非法值回退 `mist-purple`。
 */
import type { ThemeId } from '@/types/scene'

export interface ThemeTokens {
  id: ThemeId
  name: string
  primary: string
  primaryHover: string
  selectedBg: string
  hoverBg: string
  canvasBg: string
  surface: string
  border: string
}

export const THEMES: ThemeTokens[] = [
  {
    id: 'mist-purple',
    name: '灰雾紫',
    primary: '#756E87',
    primaryHover: '#625B73',
    selectedBg: '#E9E4F0',
    hoverBg: '#F3EFF7',
    canvasBg: '#F7F6F9',
    surface: '#FCFBFD',
    border: '#D6D0DE',
  },
  {
    id: 'slate-blue',
    name: '石板蓝灰',
    primary: '#536B82',
    primaryHover: '#455D74',
    selectedBg: '#E4ECF2',
    hoverBg: '#EEF3F7',
    canvasBg: '#F6F7F9',
    surface: '#FCFDFE',
    border: '#CFD8DF',
  },
  {
    id: 'reed-green',
    name: '青禾灰绿',
    primary: '#647A70',
    primaryHover: '#52675F',
    selectedBg: '#E4EDE7',
    hoverBg: '#EFF4F1',
    canvasBg: '#F6F8F6',
    surface: '#FCFDFC',
    border: '#D2DDD5',
  },
  {
    id: 'graphite',
    name: '石墨灰',
    primary: '#62666D',
    primaryHover: '#50545B',
    selectedBg: '#E8EAEE',
    hoverBg: '#F1F2F4',
    canvasBg: '#F6F7F8',
    surface: '#FCFCFD',
    border: '#D5D9DD',
  },
]

export const DEFAULT_THEME: ThemeId = 'mist-purple'

/** 校验持久化的主题 ID；非法值统一回退默认主题。 */
export function normalizeTheme(value: string | null | undefined): ThemeId {
  const match = THEMES.find((item) => item.id === value)
  return match ? match.id : DEFAULT_THEME
}

export function themeById(id: ThemeId): ThemeTokens {
  return THEMES.find((item) => item.id === id) ?? THEMES[0]
}

/** 把主题 ID 写到根节点，CSS 变量与画布读取同一个来源。 */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id
}
