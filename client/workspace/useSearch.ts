/**
 * 顶部搜索：把场景里的对象与标注拍平成搜索结果，并按匹配质量排序。
 */
import { useMemo } from 'react'
import type { SearchEntry, SceneAnnotation, SceneNode } from '@/types/scene'
import { normalizeSearch, searchRank } from '@/lib/search'

export function useSearch(
  query: string,
  nodes: SceneNode[],
  annotations: SceneAnnotation[],
  nodeById: Map<string, SceneNode>,
) {
  const entries = useMemo(() => {
    const list: SearchEntry[] = []
    nodes.forEach((node) => {
      list.push({
        nodeId: node.id,
        type: node.kind,
        title: node.name,
        subtitle: node.path ?? node.url ?? node.subtitle,
        icon: node.icon,
        searchText: `${node.name} ${node.path ?? ''} ${node.subtitle} ${node.body ?? ''} ${node.url ?? ''}`,
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
        annotationId: annotation.id,
      })
    })
    return list
  }, [annotations, nodeById, nodes])

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
