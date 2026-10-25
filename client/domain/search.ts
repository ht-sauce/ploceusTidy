/**
 * 搜索匹配与排序（领域层，纯函数）：归一化后子串匹配 + 名称拼音首字母，
 * 按名称精确、前缀、子串、路径分档。只在内存执行，不索引文件内容。
 */
import { pinyin } from 'pinyin-pro'
import type { SearchEntry } from '@/types/scene'

/** 首字母缓存：场景刷新会重复构建条目，避免逐次全量拼音转换。上限按 10 万级画布留余量。 */
const INITIALS_CACHE = new Map<string, string>()
const CACHE_LIMIT = 300000

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
 * 预归一化条目：标题与上下文只归一化一次。
 * 万级条目下逐键查询若每次都对全量条目 normalize，单次按键就是上百毫秒；
 * 预归一化后每键只做字符串比较。
 */
export interface PreparedSearch {
  entry: SearchEntry
  title: string
  context: string
}

export function prepareSearch(entry: SearchEntry): PreparedSearch {
  return {
    entry,
    title: normalizeSearch(entry.title),
    context: normalizeSearch(`${entry.subtitle} ${entry.searchText}`),
  }
}

/**
 * 匹配分级（预归一化条目版）：0 名称精确、1 名称前缀、2 名称子串或拼音首字母、
 * 3 路径/副标题、-1 不匹配；标注、空间与连线共用同一套规则。
 */
export function preparedRank(prepared: PreparedSearch, query: string): number {
  if (!query) return 3
  if (prepared.title === query) return 0
  if (prepared.title.startsWith(query)) return 1
  if (prepared.title.includes(query)) return 2
  const compact = query.replace(/\s+/g, '')
  if (prepared.entry.pinyin && compact) {
    if (prepared.entry.pinyin.startsWith(compact)) return 1
    if (prepared.entry.pinyin.includes(compact)) return 2
  }
  return prepared.context.includes(query) ? 3 : -1
}
