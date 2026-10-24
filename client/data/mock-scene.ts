/**
 * 浏览器调试用模拟数据：1000 条引用 + 分组 + 连线 + 标注。
 * 只在 `pnpm dev` 的浏览器模式下加载；桌面客户端始终从 SQLite 读取。
 */
import type {
  SceneAnnotation,
  SceneEdge,
  SceneGroup,
  SceneNode,
  SceneNodeKind,
  SystemIconKind,
} from '@/types/scene'

const TILE_W = 72
const TILE_H = 64
const GAP_X = 8
const GAP_Y = 8

interface GroupSpec extends SceneGroup {
  cols: number
  rows: number
  root: string
}

// 分组尺寸按 72×64 图标格收高：左右 16px 内边距、标题区 40px、底部 16px。
const GROUP_SPECS: GroupSpec[] = [
  {
    id: 'bid',
    title: '投标 · 滨江项目',
    x: 40,
    y: 40,
    w: 1656,
    h: 1648,
    cols: 20,
    rows: 20,
    root: 'D:\\Projects\\滨江',
  },
  {
    id: 'home',
    title: '装修 · 新家',
    x: 1740,
    y: 40,
    w: 1656,
    h: 1648,
    cols: 20,
    rows: 20,
    root: 'D:\\Projects\\装修',
  },
  {
    id: 'samples',
    title: '材料 · 供应商',
    x: 40,
    y: 1728,
    w: 1656,
    h: 1648,
    cols: 20,
    rows: 20,
    root: 'D:\\Projects\\材料',
  },
  {
    id: 'other',
    title: '其他 · 待归档',
    x: 1740,
    y: 1728,
    w: 1656,
    h: 1648,
    cols: 20,
    rows: 20,
    root: 'D:\\Projects\\待归档',
  },
]

const PREFIXES: Record<string, string[]> = {
  bid: [
    '招标文件',
    '工程量清单',
    '总平面图',
    '技术标',
    '报价单',
    '评标记录',
    '合同附件',
    '现场照片',
    '会议纪要',
    '材料报审',
  ],
  home: [
    '装修合同',
    '客厅效果图',
    '预算表',
    '施工图',
    '主材清单',
    '验收记录',
    '设计说明',
    '报价对比',
  ],
  samples: ['材料样品', '木纹样', '瓷砖样', '供应商报价', '检测报告', '色卡', '交期表', '付款节点'],
  other: ['待归档清单', '旧版文件', '参考资料', '临时导出'],
}

const FILE_KINDS: Array<{
  ext: string
  icon: SystemIconKind
  kind: SceneNodeKind
}> = [
  { ext: 'pdf', icon: 'pdf', kind: 'file' },
  { ext: 'docx', icon: 'docx', kind: 'file' },
  { ext: 'xlsx', icon: 'xlsx', kind: 'file' },
  { ext: 'dwg', icon: 'dwg', kind: 'file' },
  { ext: 'txt', icon: 'txt', kind: 'file' },
  { ext: 'jpg', icon: 'image', kind: 'image' },
  { ext: 'mp4', icon: 'video', kind: 'video' },
  { ext: 'exe', icon: 'exe', kind: 'file' },
  { ext: 'pdf', icon: 'pdf', kind: 'file' },
  { ext: 'png', icon: 'image', kind: 'image' },
]

function positionOf(group: GroupSpec, index: number) {
  const col = index % group.cols
  const row = Math.floor(index / group.cols)
  return {
    x: group.x + 24 + col * (TILE_W + GAP_X),
    y: group.y + 50 + row * (TILE_H + GAP_Y),
  }
}

function makeGeneratedNode(group: GroupSpec, index: number): SceneNode {
  const number = String(index + 1).padStart(3, '0')
  const prefix = PREFIXES[group.id][index % PREFIXES[group.id].length]
  const position = positionOf(group, index)
  const base = {
    id: `${group.id}-${index}`,
    groupId: group.id,
    z: 0,
    isExists: true,
    x: position.x,
    y: position.y,
    w: TILE_W,
    h: TILE_H,
  }

  if (index % 19 === 0) {
    return {
      ...base,
      kind: 'folder',
      icon: 'folder',
      name: `${prefix}-${number}`,
      path: `${group.root}\\${prefix}\\${prefix}-${number}`,
      subtitle: `文件夹 · ${8 + (index % 20)} 项`,
    }
  }

  if (index % 23 === 0) {
    const body = `项目备注：${prefix} 的第 ${number} 条记录，待补充结论与下一步。`
    return {
      ...base,
      kind: 'text',
      icon: 'text',
      name: `备注-${number}`,
      subtitle: body,
      body,
    }
  }

  if (index % 37 === 0) {
    const url = `https://example.com/${group.id}/${number}`
    return {
      ...base,
      kind: 'link',
      icon: 'link',
      name: `链接-${number}`,
      subtitle: 'example.com',
      url,
    }
  }

  const fileKind = FILE_KINDS[index % FILE_KINDS.length]
  const name = `${prefix}-${number}.${fileKind.ext}`
  return {
    ...base,
    kind: fileKind.kind,
    icon: fileKind.icon,
    name,
    path: `${group.root}\\${prefix}\\${name}`,
    subtitle: `${group.root}\\${prefix}`,
  }
}

export const sceneGroups: SceneGroup[] = GROUP_SPECS.map((group) => ({
  id: group.id,
  title: group.title,
  x: group.x,
  y: group.y,
  w: group.w,
  h: group.h,
}))

export const sceneNodes: SceneNode[] = GROUP_SPECS.flatMap((group) =>
  Array.from({ length: group.cols * group.rows }, (_, index) => makeGeneratedNode(group, index)),
)

function replaceNode(groupId: string, index: number, patch: Partial<SceneNode>): void {
  const node = sceneNodes.find((item) => item.id === `${groupId}-${index}`)
  if (!node) throw new Error(`Mock node not found: ${groupId}-${index}`)
  Object.assign(node, patch)
}

replaceNode('bid', 0, {
  kind: 'file',
  icon: 'pdf',
  name: '滨江项目招标文件.pdf',
  path: 'D:\\Projects\\滨江\\招标\\滨江项目招标文件.pdf',
  subtitle: 'D:\\Projects\\滨江\\招标',
})
replaceNode('bid', 1, {
  kind: 'file',
  icon: 'xlsx',
  name: '工程量清单.xlsx',
  path: 'D:\\Projects\\滨江\\造价\\工程量清单.xlsx',
  subtitle: 'D:\\Projects\\滨江\\造价',
})
replaceNode('bid', 2, {
  kind: 'file',
  icon: 'dwg',
  name: '总平面图.dwg',
  path: 'D:\\Projects\\滨江\\图纸\\总平面图.dwg',
  subtitle: 'D:\\Projects\\滨江\\图纸',
})
replaceNode('bid', 3, {
  kind: 'text',
  icon: 'text',
  name: '甲方要求',
  subtitle: '周三前提交技术标；报价单单独密封；踏勘照片随标书附上。',
  body: '周三前提交技术标；报价单单独密封；踏勘照片随标书附上。',
})
replaceNode('bid', 4, {
  kind: 'link',
  icon: 'link',
  name: '滨江新区管委会公告',
  subtitle: 'binjiang.gov.cn',
  url: 'https://www.binjiang.gov.cn/notice/2026-10',
})
replaceNode('bid', 5, {
  kind: 'image',
  icon: 'image',
  name: '现场踏勘-01.jpg',
  path: 'D:\\Projects\\滨江\\现场\\现场踏勘-01.jpg',
  subtitle: 'D:\\Projects\\滨江\\现场',
})
replaceNode('bid', 6, {
  kind: 'file',
  icon: 'exe',
  name: '标书制作工具.exe',
  path: 'D:\\Tools\\标书制作工具\\标书制作工具.exe',
  subtitle: 'D:\\Tools\\标书制作工具',
})

replaceNode('home', 0, {
  kind: 'file',
  icon: 'pdf',
  name: '装修合同.pdf',
  path: 'D:\\Projects\\装修\\合同\\装修合同.pdf',
  subtitle: 'D:\\Projects\\装修\\合同',
})
replaceNode('home', 1, {
  kind: 'image',
  icon: 'image',
  name: '客厅效果图.png',
  path: 'D:\\Projects\\装修\\效果图\\客厅效果图.png',
  subtitle: 'D:\\Projects\\装修\\效果图',
})
replaceNode('home', 2, {
  kind: 'text',
  icon: 'text',
  name: '装修预算',
  subtitle: '预算上限 28 万；儿童房与厨房不能省；保留原木风。',
  body: '预算上限 28 万；儿童房与厨房不能省；保留原木风。',
})
replaceNode('home', 3, {
  kind: 'link',
  icon: 'link',
  name: '小红书收藏：原木风',
  subtitle: 'xiaohongshu.com',
  url: 'https://www.xiaohongshu.com/explore/66f2a1c3',
})

replaceNode('samples', 0, {
  kind: 'folder',
  icon: 'folder',
  name: '材料样品',
  path: 'D:\\Projects\\装修\\材料样品',
  subtitle: '文件夹 · 12 项',
})
replaceNode('samples', 1, {
  kind: 'image',
  icon: 'image',
  name: '样品-木纹.jpg',
  path: 'D:\\Projects\\装修\\材料样品\\样品-木纹.jpg',
  subtitle: 'D:\\Projects\\装修\\材料样品',
})
replaceNode('samples', 2, {
  kind: 'text',
  icon: 'text',
  name: '供应商对比',
  subtitle: 'A 交期 7 天 / B 10 天；木纹色差需寄样确认。',
  body: 'A 交期 7 天 / B 10 天；木纹色差需寄样确认。',
})

replaceNode('other', 0, {
  kind: 'file',
  icon: 'txt',
  name: '待归档清单.txt',
  path: 'D:\\Projects\\待归档\\待归档清单.txt',
  subtitle: 'D:\\Projects\\待归档',
})

export const sceneAnnotations: SceneAnnotation[] = [
  {
    id: 'a-tender',
    nodeIds: ['bid-0'],
    color: 'amber',
    text: '技术标必须引用工程量清单第 3.2 条；报价单单独密封。',
  },
  {
    id: 'a-site',
    nodeIds: ['bid-5'],
    color: 'red',
    text: '现场东侧有高压线，总平面图需标注安全距离。',
  },
  {
    id: 'a-notice',
    nodeIds: ['bid-4'],
    color: 'blue',
    text: '公告截止 11/03，保证金需提前两个工作日缴纳。',
  },
  {
    id: 'a-budget',
    nodeIds: ['home-2'],
    color: 'teal',
    text: '预算上限 28 万；儿童房与厨房不降配置。',
  },
]

export const sceneEdges: SceneEdge[] = [
  { id: 'e-1', from: 'bid-0', to: 'bid-1' },
  { id: 'e-2', from: 'bid-1', to: 'bid-2' },
  { id: 'e-3', from: 'bid-4', to: 'bid-3' },
  { id: 'e-4', from: 'bid-5', to: 'bid-3' },
  { id: 'e-5', from: 'bid-3', to: 'bid-1' },
  { id: 'e-6', from: 'home-0', to: 'home-2' },
  { id: 'e-7', from: 'home-1', to: 'home-2' },
  { id: 'e-8', from: 'samples-0', to: 'samples-1' },
  { id: 'e-9', from: 'samples-1', to: 'samples-2' },
]
