/**
 * 画布图标与缩略图缓存。
 * 系统图标由 SVG 序列化成 data URL 再解码为位图，解码完成前画布画不出图标，
 * 因此必须回调通知调用方重渲染一次。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import SystemIcon from '@/components/SystemIcon'
import type { SystemIconKind } from '@/types/scene'

/** 进程内缩略图缓存：请求过的 data URL 转成 HTMLImageElement 复用。 */
export const THUMB_IMAGES = new Map<string, HTMLImageElement | null>()
/** 系统图标 data URL 缓存：SVG 渲染一次后转图片，Konva 直接绘制。 */
export const ICON_IMAGES = new Map<SystemIconKind, HTMLImageElement>()

let iconLoadStarted = false

const KINDS: SystemIconKind[] = [
  'folder',
  'pdf',
  'docx',
  'xlsx',
  'dwg',
  'exe',
  'image',
  'video',
  'txt',
  'link',
  'text',
]

export function startIconLoad(onSettled: () => void) {
  if (iconLoadStarted) {
    onSettled()
    return
  }
  iconLoadStarted = true
  let pending = KINDS.length
  const settle = () => {
    pending -= 1
    if (pending === 0) onSettled()
  }

  KINDS.forEach((kind) => {
    const svg = renderToStaticMarkup(<SystemIcon kind={kind} size={32} />)
    // React 序列化可能省略 xmlns，浏览器会直接判为无效 SVG；缺了就补上。
    const withNamespace = svg.includes('xmlns=')
      ? svg
      : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
    const image = new window.Image()
    image.onload = () => {
      ICON_IMAGES.set(kind, image)
      settle()
    }
    image.onerror = () => {
      // 图标缺失会退化成纯文字，属于可见缺陷，必须留下可诊断的痕迹。
      console.error(`[络雀] 系统图标加载失败：${kind}`)
      settle()
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`
  })
}

/** 读取语义令牌；主题切换由上层重渲染触发，此处每次渲染取最新值。 */
export function cssVar(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}
