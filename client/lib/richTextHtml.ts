/**
 * 富文本 HTML 与本地媒体协议的互转。
 *
 * 只改写 `src` 属性，不碰正文里的同名文本与链接：
 * 旧实现用全局 `assets/...` 替换，链接地址里出现 `assets/` 会被误改，
 * 打开再保存后链接就被永久写坏。
 */

/** 存储态：`src="assets/<name>"`；兼容单/双引号。 */
const ASSET_SRC_PATTERN = /(\ssrc=["'])assets\/([\w.-]+)(["'])/gi
/** 编辑态：`src="http://richasset.localhost/<name>"`；保存时还原。 */
const PROTOCOL_SRC_PATTERN = /(\ssrc=["'])https?:\/\/richasset\.localhost\/([\w.-]+)(["'])/gi

/** 展示前把本地媒体引用换成协议 URL。 */
export function toEditorHtml(html: string, toUrl: (name: string) => string): string {
  return html.replace(
    ASSET_SRC_PATTERN,
    (_match, prefix: string, name: string, quote: string) => `${prefix}${toUrl(name)}${quote}`,
  )
}

/** 保存前把协议 URL 还原成工作空间相对引用。 */
export function toStoredHtml(html: string): string {
  return html.replace(
    PROTOCOL_SRC_PATTERN,
    (_match, prefix: string, name: string, quote: string) => `${prefix}assets/${name}${quote}`,
  )
}
