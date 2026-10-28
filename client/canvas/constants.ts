/**
 * 画布渲染与交互常量：迷你地图范围、名称预算、连线锚点、空间配色。
 * 只放与渲染相关的数值，不放业务状态。
 */

/** 迷你地图最小映射范围；内容超出时按实际包围盒扩展。 */
export const MINIMAP_MIN_W = 1200
export const MINIMAP_MIN_H = 900
/** 迷你地图最多绘制的对象点数，超大画布按步长抽样，避免 DOM 爆炸。 */
export const MINIMAP_MAX_DOTS = 400

/**
 * 超大选择集拖动降级阈值：选中数量超过它时，拖动只移动一个包围盒 ghost，
 * 不逐个驱动 Konva 图形（10 万次 position 调用每帧必然卡死），松手一次提交。
 */
export const GHOST_DRAG_LIMIT = 2000

/** 图标格两行约能放下 12 个中文字符，超出就压缩主体、保留后缀。 */
export const NAME_LINE_BUDGET = 6

/** 卡片高度自适应：图标区 + 名称行 + 标注预留。 */
export const NODE_ICON_TOP = 3
export const NODE_ICON_SIZE = 32
/** 名称字号提高对比度后加大 1px（11 → 12），行高按 1.15 倍随之调整。 */
export const NODE_NAME_FONT_SIZE = 12
export const NODE_LINE_HEIGHT = 14
export const NODE_PADDING_BOTTOM = 4
/**
 * 标注条的独占高度（含与卡片下边框的间距）。
 * 标注曾贴在下边框线上，与描边重叠后几乎看不清；现在整块让出 18px：
 * 文字牌约 12px 高，上下各留 ~5px，既不压线也不显得脱开。
 */
export const NODE_ANNOTATION_HEIGHT = 18
/** 标注文字牌顶边相对卡片底边的偏移：height 减该值即文字牌 y。 */
export const NODE_ANNOTATION_INSET = 17

/**
 * Konva 渲染倍率：不低于 2 倍，低 DPI 屏也能保持文字锐利。
 * 过高会显著增加显存占用，上限 2.5。
 */
export const STAGE_PIXEL_RATIO = Math.min(
  2.5,
  Math.max(2, typeof window === 'undefined' ? 2 : window.devicePixelRatio || 1),
)

/** 空间默认配色：高饱和、彼此可区分；用户可再用取色器改。 */
export const GROUP_PALETTE = ['#7C6FB0', '#3F86B8', '#3E9B7C', '#C08A3A', '#B25E77', '#4E8E9E']

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
