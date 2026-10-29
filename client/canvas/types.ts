/** 画布域共享类型：右键目标与视口状态。 */

/** 右键目标：节点、空间、连线或画布空白（canvas 无 id）。 */
export interface CanvasContextTarget {
  kind: 'node' | 'group' | 'edge' | 'canvas'
  id?: string
}

/** 视口：屏幕坐标 = 世界坐标 * scale + (x, y)。 */
export interface CanvasViewport {
  x: number
  y: number
  scale: number
}

export interface StageSize {
  width: number
  height: number
}
