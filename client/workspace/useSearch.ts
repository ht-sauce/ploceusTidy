/**
 * 顶部搜索：按需构建搜索条目并按匹配质量排序。
 * 空查询不构建全量条目——10 万对象下每次场景变化（拖动落点、选中、校验）都要重建，
 * 是选中与拖动「反应慢」的主因之一；此时只给前几条对象作为建议。
 * 拼音首字母在空闲时分批预热，首个查询不会因全量转换而冻结。
 */
import { useEffect, useMemo } from 'react'
import type { SearchEntry, SceneAnnotation, SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import { normalizeSearch, pinyinInitials, prepareSearch, preparedRank } from '@/domain/search'

export function useSearch(
  query: string,
  nodes: SceneNode[],
  groups: SceneGroup[],
  edges: SceneEdge[],
  annotations: SceneAnnotation[],
  nodeById: Map<string, SceneNode>,
) {
  const normalized = normalizeSearch(query)
  const active = normalized.length > 0

  // 条目懒构建 + 预归一化：只有真正查询时才付全量构建成本，每键只做字符串比较。
  const prepared = useMemo(() => {
    if (!active) return null
    const list: SearchEntry[] = []
    const groupCounts = new Map<string, number>()
    nodes.forEach((node) => {
      if (node.groupId) groupCounts.set(node.groupId, (groupCounts.get(node.groupId) ?? 0) + 1)
    })
    nodes.forEach((node) => {
      // 富文本的 body 是 HTML，检索用纯文本投影，避免标签命中（搜 "div" 不该有结果）。
      const body = node.kind === 'richtext' ? '' : (node.body ?? '')
      list.push({
        nodeId: node.id,
        type: node.kind,
        title: node.name,
        subtitle: node.path ?? node.url ?? node.subtitle,
        icon: node.icon,
        searchText: `${node.name} ${node.path ?? ''} ${node.subtitle} ${body} ${node.url ?? ''}`,
        pinyin: pinyinInitials(node.name),
      })
    })
    groups.forEach((group) => {
      const count = groupCounts.get(group.id) ?? 0
      list.push({
        nodeId: group.id,
        type: 'group',
        title: group.title,
        subtitle: `空间 · ${count} 个对象`,
        icon: 'folder',
        searchText: `${group.title} 空间`,
        pinyin: pinyinInitials(group.title),
        groupId: group.id,
      })
    })
    annotations.forEach((annotation) => {
      const [firstNodeId] = annotation.nodeIds
      if (!firstNodeId) return
      const target = nodeById.get(firstNodeId)
      list.push({
        nodeId: firstNodeId,
        type: 'annotation',
        title: annotation.text,
        subtitle: `标注 · ${target?.name ?? '对象'}`,
        icon: 'text',
        searchText: `${annotation.text} ${target?.name ?? ''}`,
        pinyin: pinyinInitials(annotation.text),
        annotationId: annotation.id,
      })
    })
    edges.forEach((edge) => {
      // 没有标签的连线没有可搜索文本，跳过以免刷屏。
      if (!edge.label) return
      const from = nodeById.get(edge.from)?.name ?? edge.from
      const to = nodeById.get(edge.to)?.name ?? edge.to
      list.push({
        nodeId: edge.from,
        type: 'edge',
        title: edge.label,
        subtitle: `连线 · ${from} → ${to}`,
        icon: 'link',
        searchText: `${edge.label} ${from} ${to}`,
        pinyin: pinyinInitials(edge.label),
        edgeId: edge.id,
      })
    })
    return list.map(prepareSearch)
  }, [active, annotations, edges, groups, nodeById, nodes])

  const results = useMemo(() => {
    if (!prepared) {
      // 空查询只展示前几个对象作为建议，不构建全量条目。
      return nodes.slice(0, 6).map((node) => ({
        nodeId: node.id,
        type: node.kind,
        title: node.name,
        subtitle: node.path ?? node.url ?? node.subtitle,
        icon: node.icon,
        searchText: node.name,
        pinyin: '',
      }))
    }
    // top-9 线性选择：万级条目下省掉全量排序（O(N log N) → O(N)）；
    // 排序键只有名次，同名次保持输入顺序（与稳定排序的结果一致）。
    const top: { entry: SearchEntry; rank: number }[] = []
    prepared.forEach((item) => {
      const rank = preparedRank(item, normalized)
      if (rank < 0) return
      if (top.length < 9) {
        top.push({ entry: item.entry, rank })
        top.sort((left, right) => left.rank - right.rank)
        return
      }
      if (rank >= top[top.length - 1].rank) return
      top[top.length - 1] = { entry: item.entry, rank }
      top.sort((left, right) => left.rank - right.rank)
    })
    return top.map((hit) => hit.entry)
  }, [nodes, normalized, prepared])

  // 空闲预热拼音缓存：每批 2000 个、批间让出主线程，10 万对象也不会阻塞交互；
  // 场景变化后从头走一遍，缓存命中时只是 Map 查询，代价可忽略。
  useEffect(() => {
    let index = 0
    let cancelled = false
    const warm = () => {
      if (cancelled) return
      const end = Math.min(index + 2000, nodes.length)
      for (; index < end; index += 1) pinyinInitials(nodes[index].name)
      if (index < nodes.length) window.setTimeout(warm, 16)
    }
    const timer = window.setTimeout(warm, 600)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [nodes])

  return { results }
}
