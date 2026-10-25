/**
 * 画布渲染与交互常量：LOD 档位、迷你地图范围、名称预算、连线锚点。
 * 只放与渲染相关的数值，不放业务状态。
 */

/** 迷你地图最小映射范围；内容超出时按实际包围盒扩展。 */
export const MINIMAP_MIN_W = 1200
export const MINIMAP_MIN_H = 900
/** 迷你地图最多绘制的对象点数，超大画布按步长抽样，避免 DOM 爆炸。 */
export const MINIMAP_MAX_DOTS = 400

/** LOD 阈值：<50% 色点，50%–70% 简化行，≥70% 完整图标格。 */
export const LOD_DOT = 0.5
export const LOD_COMPACT = 0.7

/** 图标格两行约能放下 12 个中文字符，超出就压缩主体、保留后缀。 */
export const NAME_LINE_BUDGET = 6

/** 四向锚点顺序：上、右、下、左；选中后用于拖出连线。 */
export type HandleSide = 'top' | 'right' | 'bottom' | 'left'
export const HANDLE_SIDES: HandleSide[] = ['top', 'right', 'bottom', 'left']

/** 画布读取的语义色令牌快照，每次渲染重新取，主题切换后自然生效。 */
export interface CanvasTokens {
  primary: string
  border: string
  selectedBg: string
  text: string
  textSecondary: string
  surface: string
  error: string
}
