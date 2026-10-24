/**
 * 搜索匹配与排序：归一化后做子串匹配，按名称精确、前缀、子串、路径分档。
 * 只在内存中执行，不索引文件内容；5 万引用后再评估 FTS5 或 n-gram 索引。
 */
import type { SearchEntry } from '@/types/scene'

/** NFKC 归一、大小写折叠、斜杠统一、压缩空白；只用于匹配，不改变展示文本。 */
export function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
}

/**
 * 匹配分级：0 名称精确、1 名称前缀、2 名称子串、3 路径/副标题、-1 不匹配。
 * 标注条目与普通对象共用同一套规则。
 */
export function searchRank(entry: SearchEntry, query: string): number {
  if (!query) return 3
  const title = normalizeSearch(entry.title)
  if (title === query) return 0
  if (title.startsWith(query)) return 1
  if (title.includes(query)) return 2
  const context = normalizeSearch(`${entry.subtitle} ${entry.searchText}`)
  return context.includes(query) ? 3 : -1
}
