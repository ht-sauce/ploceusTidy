/**
 * 顶部搜索：把场景里的对象、标注、空间与连线拍平成搜索结果，并按匹配质量排序。
 * 空间标题与连线标签与对象名同等参与匹配，名称都带拼音首字母。
 */
import { useMemo } from 'react'
import type { SearchEntry, SceneAnnotation, SceneEdge, SceneGroup, SceneNode } from '@/types/scene'
import { normalizeSearch, pinyinInitials, searchRank } from '@/lib/search'

export function useSearch(
  query: string,
  nodes: SceneNode[],
  groups: SceneGroup[],
  edges: SceneEdge[],
  annotations: SceneAnnotation[],
  nodeById: Map<string, SceneNode>,
) {
  const entries = useMemo(() => {
    const list: SearchEntry[] = []
    const groupCounts = new Map<string, number>()
    nodes.forEach((node) => {
      if (node.groupId) groupCounts.set(node.groupId, (groupCounts.get(node.groupId) ?? 0) + 1)
    })
    nodes.forEach((node) => {
      list.push({
        nodeId: node.id,
        type: node.kind,
        title: node.name,
        subtitle: node.path ?? node.url ?? node.subtitle,
        icon: node.icon,
        searchText: `${node.name} ${node.path ?? ''} ${node.subtitle} ${node.body ?? ''} ${node.url ?? ''}`,
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
    return list
  }, [annotations, edges, groups, nodeById, nodes])

  const results = useMemo(() => {
    const normalized = normalizeSearch(query)
    if (!normalized) return entries.slice(0, 6)
    return entries
      .map((entry) => ({ entry, rank: searchRank(entry, normalized) }))
      .filter((item) => item.rank >= 0)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 9)
      .map((item) => item.entry)
  }, [entries, query])

  return { results }
}
