/**
 * 搜索领域用例：归一化、拼音首字母、预归一化与分级排序。
 * 排序分档直接决定「按下回车定位到哪一条」，改动必须有用例兜住。
 */
import { describe, expect, it } from 'vitest'
import { normalizeSearch, pinyinInitials, prepareSearch, preparedRank } from '@/domain/search'
import type { SearchEntry } from '@/types/scene'

function entry(patch: Partial<SearchEntry> = {}): SearchEntry {
  return {
    nodeId: 'n1',
    type: 'file',
    title: '项目材料.pdf',
    subtitle: 'D:/work/项目材料.pdf',
    icon: 'pdf',
    searchText: '项目材料.pdf D:/work/项目材料.pdf',
    pinyin: pinyinInitials('项目材料.pdf'),
    ...patch,
  }
}

describe('normalizeSearch', () => {
  it('大小写、斜杠与空白统一', () => {
    expect(normalizeSearch('  C:\\Work\\A.PDF ')).toBe('c:/work/a.pdf')
  })

  it('全角字符归一（NFKC）', () => {
    expect(normalizeSearch('ＡＢＣ')).toBe('abc')
  })
})

describe('pinyinInitials', () => {
  it('取汉字首字母，非中文原样保留', () => {
    expect(pinyinInitials('项目材料')).toBe('xmcl')
    expect(pinyinInitials('报告2024')).toBe('bg2024')
  })

  it('同一输入多次调用结果稳定（走缓存）', () => {
    expect(pinyinInitials('年度总结')).toBe(pinyinInitials('年度总结'))
  })
})

describe('preparedRank（匹配分级）', () => {
  const prepared = prepareSearch(entry())

  it('名称精确优先，其次前缀、子串、上下文', () => {
    expect(preparedRank(prepared, '项目材料.pdf')).toBe(0)
    expect(preparedRank(prepared, '项目')).toBe(1)
    expect(preparedRank(prepared, '材料')).toBe(2)
    expect(preparedRank(prepared, 'work')).toBe(3)
  })

  it('拼音首字母命中前缀与子串', () => {
    expect(preparedRank(prepared, 'xmcl')).toBe(1)
    expect(preparedRank(prepared, 'mcl')).toBe(2)
  })

  it('完全不匹配返回 -1', () => {
    expect(preparedRank(prepared, 'zzzz')).toBe(-1)
  })

  it('空查询按上下文处理（排序交给调用方）', () => {
    expect(preparedRank(prepared, '')).toBe(3)
  })
})
