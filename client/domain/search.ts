/**
 * 搜索匹配与排序（领域层，纯函数）：归一化后子串匹配 + 名称拼音首字母，
 * 按名称精确、前缀、子串、路径分档。只在内存执行，不索引文件内容。
 */
import { pinyin } from 'pinyin-pro'
import type { SearchEntry } from '@/types/scene'

/** 首字母缓存：场景刷新会重复构建条目，避免逐次全量拼音转换。 */
const INITIALS_CACHE = new Map<string, string>()
const CACHE_LIMIT = 20000

/** NFKC 归一、大小写折叠、斜杠统一、压缩空白；只用于匹配，不改变展示文本。 */
export function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
}

/** 名称的拼音首字母；非中文字符原样保留，便于「pdf2024」这类混合输入。 */
export function pinyinInitials(value: string): string {
  const cached = INITIALS_CACHE.get(value)
  if (cached !== undefined) return cached
  const initials = pinyin(value, {
    pattern: 'first',
    toneType: 'none',
    type: 'array',
  })
    .join('')
    .toLowerCase()
    .replace(/\s+/g, '')
  if (INITIALS_CACHE.size >= CACHE_LIMIT) INITIALS_CACHE.clear()
  INITIALS_CACHE.set(value, initials)
  return initials
}

/**
 * 匹配分级：0 名称精确、1 名称前缀、2 名称子串或拼音首字母、3 路径/副标题、-1 不匹配。
 * 标注、空间与连线共用同一套规则。
 */
export function searchRank(entry: SearchEntry, query: string): number {
  if (!query) return 3
  const title = normalizeSearch(entry.title)
  if (title === query) return 0
  if (title.startsWith(query)) return 1
  if (title.includes(query)) return 2
  const compact = query.replace(/\s+/g, '')
  if (entry.pinyin && compact) {
    if (entry.pinyin.startsWith(compact)) return 1
    if (entry.pinyin.includes(compact)) return 2
  }
  const context = normalizeSearch(`${entry.subtitle} ${entry.searchText}`)
  return context.includes(query) ? 3 : -1
}
