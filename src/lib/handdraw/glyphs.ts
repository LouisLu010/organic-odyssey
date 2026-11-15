import type { AtomLabel, Bounds, HanddrawPoint, HanddrawStroke, LabelRecognition, Settings } from './types'
import {
  bounds,
  boundsCenter,
  boundsDiagonal,
  boundsGap,
  boundsHeight,
  boundsOverlapRatio,
  boundsWidth,
  cornerStrength,
  dedupePoints,
  distance,
  fitCircle,
  pointBoundsDistance,
  polylineLength,
  resamplePolyline,
  segmentsIntersect,
  simplifyRdp,
  unionBounds,
} from './geometry'

export interface GlyphRecognitionInput {
  /** 全部手写笔迹，含原始下标。 */
  strokes: readonly HanddrawStroke[]
  /** 估计的键长像素尺度。 */
  scale: number
  settings: Settings
}

/** 低于该置信度的标签不占用笔画，但仍会返回给界面提示。 */
const CLAIM_CONFIDENCE = 0.55
/** 低于该置信度的“最佳猜测”不再当作标签输出，只给无法识别的提示。 */
const REPORT_CONFIDENCE = 0.3
/** 匹配栅格尺寸（按字高归一化后，字高占 26 格）。 */
const GRID_WIDTH = 128
const GRID_HEIGHT = 32
const INK_HEIGHT_CELLS = 26
const INK_MARGIN_X = 4
const INK_MARGIN_Y = 3
const GRID_CELLS = GRID_WIDTH * GRID_HEIGHT
/** 覆盖判定的容差与距离截断（栅格数）。 */
const COVER_TOLERANCE_CELLS = 3
const DISTANCE_CAP_CELLS = 6
/** 参与方向一致性比较的最大匹配距离（栅格数）。 */
const DIRECTION_RADIUS_CELLS = 2

/* ------------------------------------------------------------------------- *
 * 通用小工具
 * ------------------------------------------------------------------------- */

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function sanitizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

function finitePoint(point: HanddrawPoint | undefined): point is HanddrawPoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
}

function mean(values: readonly number[]): number {
  if (!values.length) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

/* ------------------------------------------------------------------------- *
 * 内置矢量字符模板
 *
 * 坐标约定：y = 0 为字顶（大写字母顶线），y = 1 为基线；x 从 0 开始向右。
 * 小写 x-height 字母画在 0.4～1 之间，带降部的字母可以超过 1。
 * 手写风格通过倾斜（slant）与横向拉伸（widthScale）两种仿射变体模拟。
 * ------------------------------------------------------------------------- */

type GlyphStrokes = HanddrawPoint[][]

function linePoints(x1: number, y1: number, x2: number, y2: number): HanddrawPoint[] {
  return [{ x: x1, y: y1 }, { x: x2, y: y2 }]
}

/** Catmull-Rom 平滑，把少量控制点变成手写感的曲线。 */
function smoothCurve(control: readonly HanddrawPoint[]): HanddrawPoint[] {
  if (control.length < 2) return control.map(point => ({ x: point.x, y: point.y }))
  const count = control.length
  const result: HanddrawPoint[] = []
  for (let index = 0; index < count - 1; index += 1) {
    const first = control[Math.max(0, index - 1)]
    const second = control[index]
    const third = control[index + 1]
    const fourth = control[Math.min(count - 1, index + 2)]
    for (let step = 0; step < 9; step += 1) {
      const t = step / 9
      const t2 = t * t
      const t3 = t2 * t
      result.push({
        x: 0.5 * (2 * second.x + (-first.x + third.x) * t
          + (2 * first.x - 5 * second.x + 4 * third.x - fourth.x) * t2
          + (-first.x + 3 * second.x - 3 * third.x + fourth.x) * t3),
        y: 0.5 * (2 * second.y + (-first.y + third.y) * t
          + (2 * first.y - 5 * second.y + 4 * third.y - fourth.y) * t2
          + (-first.y + 3 * second.y - 3 * third.y + fourth.y) * t3),
      })
    }
  }
  result.push({ x: control[count - 1].x, y: control[count - 1].y })
  return result
}

/** 把扁平坐标数组 [x0,y0,x1,y1,...] 变成平滑曲线。 */
function curve(...coordinates: number[]): HanddrawPoint[] {
  const control: HanddrawPoint[] = []
  for (let index = 0; index + 1 < coordinates.length; index += 2) control.push({ x: coordinates[index], y: coordinates[index + 1] })
  return smoothCurve(control)
}

/** 椭圆/圆弧采样；闭合环不重复首尾点。 */
function ring(cx: number, cy: number, rx: number, ry: number, startDegrees: number, endDegrees: number, steps: number): HanddrawPoint[] {
  const closed = Math.abs(endDegrees - startDegrees) >= 359.5
  const count = closed ? steps : steps + 1
  const points: HanddrawPoint[] = []
  for (let index = 0; index < count; index += 1) {
    const ratio = closed ? index / steps : index / steps
    const angle = (startDegrees + (endDegrees - startDegrees) * ratio) * Math.PI / 180
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) })
  }
  return points
}

/** 全部字符的“印刷体骨架”，键为大写/小写/数字/符号。 */
function buildCharShapes(): Record<string, GlyphStrokes> {
  return {
    C: [ring(0.33, 0.5, 0.3, 0.5, 48, 312, 20)],
    O: [ring(0.33, 0.5, 0.3, 0.5, 0, 360, 24)],
    H: [linePoints(0.12, 0, 0.12, 1), linePoints(0.64, 0, 0.64, 1), linePoints(0.12, 0.52, 0.64, 0.52)],
    N: [linePoints(0.1, 1, 0.1, 0), linePoints(0.1, 0, 0.62, 1), linePoints(0.62, 1, 0.62, 0)],
    S: [curve(0.56, 0.1, 0.38, 0.01, 0.16, 0.08, 0.13, 0.26, 0.32, 0.42, 0.5, 0.56, 0.52, 0.76, 0.36, 0.96, 0.15, 0.98, 0.04, 0.86)],
    P: [linePoints(0.1, 0, 0.1, 1), curve(0.1, 0.04, 0.4, 0.02, 0.56, 0.14, 0.54, 0.34, 0.3, 0.48, 0.1, 0.5)],
    F: [linePoints(0.1, 0, 0.1, 1), linePoints(0.1, 0.03, 0.52, 0.03), linePoints(0.1, 0.47, 0.44, 0.47)],
    I: [linePoints(0.1, 0, 0.1, 1)],
    B: [
      linePoints(0.1, 0, 0.1, 1),
      curve(0.1, 0.02, 0.36, 0.02, 0.5, 0.12, 0.48, 0.28, 0.28, 0.42, 0.1, 0.46),
      curve(0.1, 0.48, 0.38, 0.46, 0.56, 0.58, 0.54, 0.78, 0.34, 0.96, 0.1, 0.96),
    ],
    M: [linePoints(0.06, 1, 0.06, 0), linePoints(0.06, 0, 0.32, 0.62), linePoints(0.32, 0.62, 0.58, 0), linePoints(0.58, 0, 0.58, 1)],
    l: [linePoints(0.08, 0, 0.08, 1)],
    r: [linePoints(0.08, 0.4, 0.08, 1), curve(0.08, 0.5, 0.16, 0.42, 0.28, 0.4, 0.33, 0.47)],
    b: [linePoints(0.08, 0, 0.08, 1), ring(0.3, 0.74, 0.18, 0.24, 0, 360, 16)],
    a: [ring(0.26, 0.7, 0.17, 0.28, 0, 360, 16), linePoints(0.43, 0.42, 0.43, 1)],
    h: [linePoints(0.08, 0, 0.08, 1), curve(0.08, 0.56, 0.16, 0.42, 0.3, 0.4, 0.42, 0.52, 0.42, 1)],
    n: [linePoints(0.08, 0.4, 0.08, 1), curve(0.08, 0.56, 0.18, 0.42, 0.32, 0.42, 0.42, 0.56, 0.42, 1)],
    o: [ring(0.21, 0.7, 0.18, 0.29, 0, 360, 16)],
    g: [ring(0.24, 0.7, 0.18, 0.28, 0, 360, 16), curve(0.42, 0.55, 0.42, 0.92, 0.38, 1.16, 0.26, 1.24, 0.14, 1.14)],
    s: [curve(0.34, 0.46, 0.2, 0.4, 0.1, 0.47, 0.14, 0.58, 0.26, 0.66, 0.34, 0.76, 0.3, 0.9, 0.16, 0.98, 0.06, 0.9)],
    i: [linePoints(0.08, 0.4, 0.08, 1), ring(0.08, 0.12, 0.035, 0.035, 0, 360, 6)],
    '2': [curve(0.1, 0.22, 0.18, 0.03, 0.38, 0.01, 0.47, 0.16, 0.38, 0.4, 0.16, 0.68, 0.07, 0.88, 0.1, 0.98, 0.48, 0.98)],
    '3': [curve(0.1, 0.12, 0.26, 0, 0.42, 0.06, 0.44, 0.24, 0.3, 0.4, 0.2, 0.46, 0.34, 0.5, 0.46, 0.66, 0.44, 0.86, 0.28, 1, 0.1, 0.9)],
    '4': [linePoints(0.34, 0.02, 0.06, 0.68), linePoints(0.04, 0.68, 0.5, 0.68), linePoints(0.36, 0.3, 0.36, 1)],
    '8': [ring(0.24, 0.28, 0.16, 0.23, 0, 360, 14), ring(0.24, 0.74, 0.18, 0.26, 0, 360, 14)],
    A: [linePoints(0.06, 1, 0.3, 0), linePoints(0.3, 0, 0.54, 1), linePoints(0.16, 0.62, 0.44, 0.62)],
    L: [linePoints(0.1, 0, 0.1, 1), linePoints(0.1, 1, 0.52, 1)],
    K: [linePoints(0.1, 0, 0.1, 1), linePoints(0.5, 0, 0.12, 0.55), linePoints(0.18, 0.42, 0.54, 1)],
    Z: [linePoints(0.06, 0.03, 0.46, 0.03), linePoints(0.46, 0.03, 0.08, 0.97), linePoints(0.08, 0.97, 0.48, 0.97)],
    u: [linePoints(0.08, 0.4, 0.08, 0.86), curve(0.08, 0.86, 0.12, 0.99, 0.26, 1.0, 0.36, 0.92, 0.4, 0.4)],
    e: [curve(0.35, 0.68, 0.24, 0.6, 0.1, 0.64, 0.04, 0.78, 0.1, 0.93, 0.24, 1.0, 0.36, 0.92), linePoints(0.04, 0.7, 0.35, 0.7)],
    '+': [linePoints(0.04, 0.5, 0.4, 0.5), linePoints(0.22, 0.32, 0.22, 0.68)],
    '-': [linePoints(0.04, 0.54, 0.38, 0.56)],
  }
}

/** 手写风格变体：倾斜 + 横向缩放。 */
interface TemplateStyle {
  slant: number
  widthScale: number
}

const TEMPLATE_STYLES: readonly TemplateStyle[] = [
  { slant: 0, widthScale: 1 },
  { slant: 0.12, widthScale: 1 },
  { slant: -0.06, widthScale: 1.12 },
  { slant: 0.05, widthScale: 0.88 },
  { slant: 0.02, widthScale: 1.34 },
]

function transformPoint(point: HanddrawPoint, style: TemplateStyle): HanddrawPoint {
  return {
    x: (point.x + style.slant * (1 - point.y)) * style.widthScale,
    y: point.y,
  }
}

function transformStrokes(strokes: GlyphStrokes, style: TemplateStyle): GlyphStrokes {
  return strokes.map(stroke => stroke.map(point => transformPoint(point, style)))
}

/** 一个标签由若干字符（可含下标）按顺序组成。 */
interface LabelCharSpec {
  char: string
  subscript?: boolean
}

interface LabelSpec {
  text: string
  element: string
  sequence: readonly LabelCharSpec[]
}

const LABEL_SPECS: readonly LabelSpec[] = [
  { text: 'H', element: 'H', sequence: [{ char: 'H' }] },
  { text: 'C', element: 'C', sequence: [{ char: 'C' }] },
  { text: 'N', element: 'N', sequence: [{ char: 'N' }] },
  { text: 'O', element: 'O', sequence: [{ char: 'O' }] },
  { text: 'S', element: 'S', sequence: [{ char: 'S' }] },
  { text: 'P', element: 'P', sequence: [{ char: 'P' }] },
  { text: 'F', element: 'F', sequence: [{ char: 'F' }] },
  { text: 'I', element: 'I', sequence: [{ char: 'I' }] },
  { text: 'B', element: 'B', sequence: [{ char: 'B' }] },
  { text: 'Cl', element: 'Cl', sequence: [{ char: 'C' }, { char: 'l' }] },
  { text: 'Br', element: 'Br', sequence: [{ char: 'B' }, { char: 'r' }] },
  { text: 'Si', element: 'Si', sequence: [{ char: 'S' }, { char: 'i' }] },
  { text: 'Na', element: 'Na', sequence: [{ char: 'N' }, { char: 'a' }] },
  { text: 'Li', element: 'Li', sequence: [{ char: 'L' }, { char: 'i' }] },
  { text: 'K', element: 'K', sequence: [{ char: 'K' }] },
  { text: 'Mg', element: 'Mg', sequence: [{ char: 'M' }, { char: 'g' }] },
  { text: 'Ca', element: 'Ca', sequence: [{ char: 'C' }, { char: 'a' }] },
  { text: 'Al', element: 'Al', sequence: [{ char: 'A' }, { char: 'l' }] },
  { text: 'Fe', element: 'Fe', sequence: [{ char: 'F' }, { char: 'e' }] },
  { text: 'Zn', element: 'Zn', sequence: [{ char: 'Z' }, { char: 'n' }] },
  { text: 'Cu', element: 'Cu', sequence: [{ char: 'C' }, { char: 'u' }] },
  { text: 'Ag', element: 'Ag', sequence: [{ char: 'A' }, { char: 'g' }] },
  { text: 'Ba', element: 'Ba', sequence: [{ char: 'B' }, { char: 'a' }] },
  { text: 'Mn', element: 'Mn', sequence: [{ char: 'M' }, { char: 'n' }] },
  { text: 'Ni', element: 'Ni', sequence: [{ char: 'N' }, { char: 'i' }] },
  { text: 'OH', element: 'O', sequence: [{ char: 'O' }, { char: 'H' }] },
  { text: 'NH', element: 'N', sequence: [{ char: 'N' }, { char: 'H' }] },
  { text: 'NH2', element: 'N', sequence: [{ char: 'N' }, { char: 'H' }, { char: '2', subscript: true }] },
  { text: 'CH2', element: 'C', sequence: [{ char: 'C' }, { char: 'H' }, { char: '2', subscript: true }] },
  { text: 'CH3', element: 'C', sequence: [{ char: 'C' }, { char: 'H' }, { char: '3', subscript: true }] },
  { text: 'COOH', element: 'C', sequence: [{ char: 'C' }, { char: 'O' }, { char: 'O' }, { char: 'H' }] },
  { text: 'CHO', element: 'C', sequence: [{ char: 'C' }, { char: 'H' }, { char: 'O' }] },
  { text: 'CN', element: 'C', sequence: [{ char: 'C' }, { char: 'N' }] },
  { text: 'NO2', element: 'N', sequence: [{ char: 'N' }, { char: 'O' }, { char: '2', subscript: true }] },
  { text: 'SO3H', element: 'S', sequence: [{ char: 'S' }, { char: 'O' }, { char: '3', subscript: true }, { char: 'H' }] },
  { text: 'SH', element: 'S', sequence: [{ char: 'S' }, { char: 'H' }] },
  { text: 'COO', element: 'C', sequence: [{ char: 'C' }, { char: 'O' }, { char: 'O' }] },
  { text: 'COOCH3', element: 'C', sequence: [{ char: 'C' }, { char: 'O' }, { char: 'O' }, { char: 'C' }, { char: 'H' }, { char: '3', subscript: true }] },
  { text: 'COOMe', element: 'C', sequence: [{ char: 'C' }, { char: 'O' }, { char: 'O' }, { char: 'M' }, { char: 'e' }] },
  { text: 'OMe', element: 'O', sequence: [{ char: 'O' }, { char: 'M' }, { char: 'e' }] },
  { text: 'OCH3', element: 'O', sequence: [{ char: 'O' }, { char: 'C' }, { char: 'H' }, { char: '3', subscript: true }] },
]

/**
 * 装配器支持的元素符号集合（与 Lead 的 assemble.ts 对齐）。
 * 字符回退只允许拼出这里的元素，避免生成装配器不认识的原子。
 */
const SUPPORTED_ELEMENTS = new Set([
  'H', 'B', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'Br', 'I',
  'Li', 'Na', 'K', 'Mg', 'Ca', 'Al', 'Fe', 'Zn', 'Cu', 'Ag', 'Ba', 'Mn', 'Ni',
])

/** 匹配模板：归一化后的栅格距离场 + 文本信息。 */
interface InkTemplate {
  text: string
  element: string
  charge: number
  aspect: number
  distance: Float32Array
  inkCells: Int32Array
  /** 与 inkCells 对齐的墨迹局部方向（双角表示，方向取模 π 等价）。 */
  dirCos: Float32Array
  dirSin: Float32Array
  /** 标签各字符在归一化栅格里的 x 边界（cell 坐标），用于逐字符复核。 */
  charBoundaries?: number[]
  /** 笔画方向构成：横 / 竖 / 斜 的长度占比，用于区分 H 与 N 这类近似形状。 */
  structure: [number, number, number]
  kind: 'label' | 'char'
}

interface CandidateGrid {
  points: HanddrawPoint[]
  distance: Float32Array
  inkCells: Int32Array
  aspect: number
  dirCos: Float32Array
  dirSin: Float32Array
  dirMask: Uint8Array
  structure: [number, number, number]
}

function gridIndexOf(x: number, y: number): number {
  const column = clamp(Math.round(x), 0, GRID_WIDTH - 1)
  const row = clamp(Math.round(y), 0, GRID_HEIGHT - 1)
  return row * GRID_WIDTH + column
}

function markCell(x: number, y: number, mask: Uint8Array, cells: number[]): void {
  const index = gridIndexOf(x, y)
  if (!mask[index]) {
    mask[index] = 1
    cells.push(index)
  }
}

/** 把多条笔迹分别栅格化后合并；不同笔迹之间不能连线（否则会凭空多出墨迹）。 */
function rasterizeCellStrokes(strokes: readonly (readonly HanddrawPoint[])[]): { mask: Uint8Array; cells: number[] } {
  const mask = new Uint8Array(GRID_CELLS)
  const cells: number[] = []
  for (const stroke of strokes) {
    const result = rasterizeCellPoints(stroke)
    for (const cell of result.cells) {
      if (!mask[cell]) {
        mask[cell] = 1
        cells.push(cell)
      }
    }
  }
  return { mask, cells }
}

/** 把一串栅格坐标点连成带粗度的掩码，避免采样点之间出现空洞。 */
function rasterizeCellPoints(points: readonly HanddrawPoint[]): { mask: Uint8Array; cells: number[] } {
  const mask = new Uint8Array(GRID_CELLS)
  const cells: number[] = []
  if (!points.length) return { mask, cells }
  markCell(points[0].x, points[0].y, mask, cells)
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1]
    const second = points[index]
    const steps = Math.max(1, Math.ceil(distance(first, second) * 1.6))
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps
      markCell(first.x + (second.x - first.x) * ratio, first.y + (second.y - first.y) * ratio, mask, cells)
    }
  }
  return { mask, cells }
}

/** 两遍倒角距离变换，返回每个栅格到最近墨迹的距离（格数）。 */
function buildDistanceField(mask: Uint8Array): Float32Array {
  const infinity = 1e6
  const distanceField = new Float32Array(GRID_CELLS)
  for (let index = 0; index < GRID_CELLS; index += 1) distanceField[index] = mask[index] ? 0 : infinity
  const diagonal = Math.SQRT2
  for (let row = 0; row < GRID_HEIGHT; row += 1) {
    for (let column = 0; column < GRID_WIDTH; column += 1) {
      const index = row * GRID_WIDTH + column
      let best = distanceField[index]
      if (column > 0) best = Math.min(best, distanceField[index - 1] + 1)
      if (row > 0) {
        best = Math.min(best, distanceField[index - GRID_WIDTH] + 1)
        if (column > 0) best = Math.min(best, distanceField[index - GRID_WIDTH - 1] + diagonal)
        if (column < GRID_WIDTH - 1) best = Math.min(best, distanceField[index - GRID_WIDTH + 1] + diagonal)
      }
      distanceField[index] = best
    }
  }
  for (let row = GRID_HEIGHT - 1; row >= 0; row -= 1) {
    for (let column = GRID_WIDTH - 1; column >= 0; column -= 1) {
      const index = row * GRID_WIDTH + column
      let best = distanceField[index]
      if (column < GRID_WIDTH - 1) best = Math.min(best, distanceField[index + 1] + 1)
      if (row < GRID_HEIGHT - 1) {
        best = Math.min(best, distanceField[index + GRID_WIDTH] + 1)
        if (column < GRID_WIDTH - 1) best = Math.min(best, distanceField[index + GRID_WIDTH + 1] + diagonal)
        if (column > 0) best = Math.min(best, distanceField[index + GRID_WIDTH - 1] + diagonal)
      }
      distanceField[index] = best
    }
  }
  return distanceField
}

/** 计算折线采样点在栅格内的局部方向（双角表示）。 */
function directionAt(points: readonly HanddrawPoint[], index: number): { cos: number; sin: number } | undefined {
  if (points.length < 2) return undefined
  const before = points[Math.max(0, index - 1)]
  const after = points[Math.min(points.length - 1, index + 1)]
  let dx = after.x - before.x
  let dy = after.y - before.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) {
    dx = 1
    dy = 0
  } else {
    dx /= length
    dy /= length
  }
  return { cos: dx * dx - dy * dy, sin: 2 * dx * dy }
}

/** 由方向（双角表示）统计横/竖/斜墨迹占比。 */
function structureFromDirections(entries: readonly { direction: { cos: number; sin: number }; weight: number }[]): [number, number, number] {
  let horizontal = 0
  let vertical = 0
  let diagonal = 0
  for (const entry of entries) {
    // cos(2θ) = 1 表示水平，= -1 表示竖直，≈0 表示斜线。
    if (entry.direction.cos >= 0.55) horizontal += entry.weight
    else if (entry.direction.cos <= -0.55) vertical += entry.weight
    else diagonal += entry.weight
  }
  const total = horizontal + vertical + diagonal
  if (!(total > 1e-9)) return [0, 0, 0]
  return [horizontal / total, vertical / total, diagonal / total]
}

function structureFromStrokes(strokes: readonly GlyphStrokes[number][]): [number, number, number] {
  const entries: { direction: { cos: number; sin: number }; weight: number }[] = []
  for (const stroke of strokes) {
    for (let index = 1; index < stroke.length; index += 1) {
      const dx = stroke[index].x - stroke[index - 1].x
      const dy = stroke[index].y - stroke[index - 1].y
      const length = Math.hypot(dx, dy)
      if (length < 1e-9) continue
      entries.push({ direction: { cos: (dx * dx - dy * dy) / (length * length), sin: (2 * dx * dy) / (length * length) }, weight: length })
    }
  }
  return structureFromDirections(entries)
}

/** 把模板骨架栅格化为距离场 + 方向场。 */
interface RasterizedTemplate {
  aspect: number
  distance: Float32Array
  inkCells: Int32Array
  dirCos: Float32Array
  dirSin: Float32Array
  /** 归一化映射：cellX = INK_MARGIN_X + (x - originX) * cellScale。 */
  originX: number
  cellScale: number
}

function rasterizeTemplate(strokes: GlyphStrokes): RasterizedTemplate | undefined {
  const all = strokes.flat()
  if (all.length < 2) return undefined
  const box = bounds(all)
  const width = boundsWidth(box)
  const height = boundsHeight(box)
  if (!(width > 1e-6)) return undefined
  // 纯横线（减号）高度为 0，用宽度估计一个虚拟高度，保证归一化可算。
  const effectiveHeight = Math.max(height, width * 0.2, 1e-3)
  const scale = INK_HEIGHT_CELLS / effectiveHeight
  const cellStrokes: HanddrawPoint[][] = []
  for (const stroke of strokes) {
    const length = polylineLength(stroke)
    const count = clamp(Math.ceil(length * scale * 1.5) + 1, 2, 400)
    cellStrokes.push(resamplePolyline(stroke, count).map(point => ({
      x: INK_MARGIN_X + (point.x - box.minX) * scale,
      y: INK_MARGIN_Y + (point.y - box.minY) * scale,
    })))
  }
  const { mask, cells } = rasterizeCellStrokes(cellStrokes)
  if (!cells.length) return undefined
  const dirCosMap = new Float32Array(GRID_CELLS)
  const dirSinMap = new Float32Array(GRID_CELLS)
  for (const stroke of cellStrokes) {
    for (let index = 0; index < stroke.length; index += 1) {
      const direction = directionAt(stroke, index)
      if (!direction) continue
      const cell = gridIndexOf(stroke[index].x, stroke[index].y)
      dirCosMap[cell] = direction.cos
      dirSinMap[cell] = direction.sin
    }
  }
  const dirCos = new Float32Array(cells.length)
  const dirSin = new Float32Array(cells.length)
  for (let index = 0; index < cells.length; index += 1) {
    dirCos[index] = dirCosMap[cells[index]]
    dirSin[index] = dirSinMap[cells[index]]
  }
  return { aspect: width / effectiveHeight, distance: buildDistanceField(mask), inkCells: Int32Array.from(cells), dirCos, dirSin, originX: box.minX, cellScale: scale }
}

/** 按字符序列拼出标签模板骨架；下标字母缩小并下移。同时返回每个字符的 x 区间。 */
function composeLabel(
  charShapes: Record<string, GlyphStrokes>,
  spec: LabelSpec,
  style: TemplateStyle,
): { strokes: GlyphStrokes; ranges: { minX: number; maxX: number }[] } {
  const result: GlyphStrokes = []
  const ranges: { minX: number; maxX: number }[] = []
  let cursor = 0
  for (const item of spec.sequence) {
    const shape = charShapes[item.char]
    if (!shape) continue
    let transformed = transformStrokes(shape, style)
    if (item.subscript) {
      transformed = transformed.map(stroke => stroke.map(point => ({ x: point.x * 0.6, y: 0.47 + point.y * 0.6 })))
    }
    const box = bounds(transformed.flat())
    const shift = cursor - box.minX
    for (const stroke of transformed) result.push(stroke.map(point => ({ x: point.x + shift, y: point.y })))
    ranges.push({ minX: cursor, maxX: cursor + boundsWidth(box) })
    cursor += boundsWidth(box) + (item.subscript ? 0.07 : 0.11)
  }
  return { strokes: result, ranges }
}

/** 每个标签的字符布局（归一化 cell 坐标），首次构建模板时缓存。 */
const labelCharLayouts = new Map<string, { boundaries: number[]; chars: string[] }>()

function mapBoundariesToCells(ranges: readonly { minX: number; maxX: number }[], raster: RasterizedTemplate): number[] {
  const cells = ranges.map(range => ({
    start: INK_MARGIN_X + (range.minX - raster.originX) * raster.cellScale,
    end: INK_MARGIN_X + (range.maxX - raster.originX) * raster.cellScale,
  }))
  const boundaries = [cells[0].start]
  for (let index = 1; index < cells.length; index += 1) boundaries.push((cells[index - 1].end + cells[index].start) / 2)
  boundaries.push(cells[cells.length - 1].end)
  return boundaries
}

function registerLabelLayout(spec: LabelSpec, ranges: readonly { minX: number; maxX: number }[], raster: RasterizedTemplate): void {
  if (labelCharLayouts.has(spec.text)) return
  labelCharLayouts.set(spec.text, {
    boundaries: mapBoundariesToCells(ranges, raster),
    chars: spec.sequence.map(item => item.char),
  })
}

let labelTemplateCache: InkTemplate[] | undefined
let charTemplateCache: InkTemplate[] | undefined

function buildLabelTemplates(): InkTemplate[] {
  const charShapes = buildCharShapes()
  const templates: InkTemplate[] = []
  for (const spec of LABEL_SPECS) {
    for (const style of TEMPLATE_STYLES) {
      const composed = composeLabel(charShapes, spec, style)
      const raster = rasterizeTemplate(composed.strokes)
      if (!raster) continue
      registerLabelLayout(spec, composed.ranges, raster)
      templates.push({
        text: spec.text,
        element: spec.element,
        charge: 0,
        aspect: raster.aspect,
        distance: raster.distance,
        inkCells: raster.inkCells,
        dirCos: raster.dirCos,
        dirSin: raster.dirSin,
        charBoundaries: mapBoundariesToCells(composed.ranges, raster),
        structure: structureFromStrokes(composed.strokes),
        kind: 'label',
      })
    }
  }
  return templates
}

function buildCharTemplates(): InkTemplate[] {
  const charShapes = buildCharShapes()
  const templates: InkTemplate[] = []
  for (const [char, shape] of Object.entries(charShapes)) {
    for (const style of TEMPLATE_STYLES) {
      const raster = rasterizeTemplate(transformStrokes(shape, style))
      if (!raster) continue
      templates.push({
        text: char,
        element: /^[A-Z]$/.test(char) ? char : '',
        charge: 0,
        aspect: raster.aspect,
        distance: raster.distance,
        inkCells: raster.inkCells,
        dirCos: raster.dirCos,
        dirSin: raster.dirSin,
        structure: structureFromStrokes(transformStrokes(shape, style)),
        kind: 'char',
      })
    }
  }
  return templates
}

function getLabelTemplates(): InkTemplate[] {
  if (!labelTemplateCache) labelTemplateCache = buildLabelTemplates()
  return labelTemplateCache
}

function getCharTemplates(): InkTemplate[] {
  if (!charTemplateCache) charTemplateCache = buildCharTemplates()
  return charTemplateCache
}

/* ------------------------------------------------------------------------- *
 * 笔迹特征提取与“文字候选”筛选
 * ------------------------------------------------------------------------- */

interface StrokeInfo {
  /** 原始笔画下标。 */
  index: number
  points: HanddrawPoint[]
  simplified: HanddrawPoint[]
  bounds: Bounds
  width: number
  height: number
  length: number
  chord: number
  /** 弦长 / 弧长：越接近 1 越直。 */
  straightness: number
  /** 首尾距离 / 包围盒对角：越小越像闭合环。 */
  closedness: number
  maxRun: number
  role: 'bond' | 'glyph'
}

function buildStrokeInfo(index: number, raw: readonly HanddrawPoint[], tolerance: number): StrokeInfo | undefined {
  const valid: HanddrawPoint[] = []
  for (const point of raw) if (finitePoint(point)) valid.push({ x: point.x, y: point.y })
  const points = dedupePoints(valid, 0.5)
  if (!points.length) return undefined
  const simplified = simplifyRdp(points, tolerance)
  const box = bounds(points)
  const width = boundsWidth(box)
  const height = boundsHeight(box)
  const length = polylineLength(points)
  const chord = length > 0 ? distance(points[0], points[points.length - 1]) : 0
  const diagonal = boundsDiagonal(box)
  let maxRun = 0
  for (let index = 1; index < simplified.length; index += 1) {
    maxRun = Math.max(maxRun, distance(simplified[index - 1], simplified[index]))
  }
  return {
    index,
    points,
    simplified,
    bounds: box,
    width,
    height,
    length,
    chord,
    straightness: length > 1e-6 ? chord / length : 0,
    closedness: diagonal > 1e-6 ? chord / diagonal : 0,
    maxRun,
    role: 'glyph',
  }
}

function estimateScaleFromStrokes(strokes: readonly StrokeInfo[]): number {
  const chords: number[] = []
  for (const stroke of strokes) {
    if (stroke.straightness >= 0.9 && stroke.chord >= 8) chords.push(stroke.chord)
  }
  chords.sort((left, right) => left - right)
  if (chords.length) return clamp(chords[Math.floor(chords.length / 2)], 8, 400)
  const diagonals = strokes.map(stroke => boundsDiagonal(stroke.bounds)).filter(value => value > 4).sort((left, right) => left - right)
  if (diagonals.length) return clamp(diagonals[Math.floor(diagonals.length / 2)] * 1.6, 8, 400)
  return 24
}

interface BondSegment {
  a: HanddrawPoint
  b: HanddrawPoint
  strokeIndex: number
}

/**
 * 双键/三键的内侧短线：两条长直、近似平行、间距小且投影重叠的笔画。
 * 它们是键线而不是字母（比如 H 的两竖），必须在进入文字聚类前就判为键。
 */
function markParallelBondStrokes(strokes: readonly StrokeInfo[], scale: number): void {
  const candidates = strokes.filter(stroke => stroke.points.length >= 2
    && stroke.straightness >= 0.86
    && stroke.chord >= 0.45 * scale)
  const cosineLimit = Math.cos((13 * Math.PI) / 180)
  interface LineGeometry {
    stroke: StrokeInfo
    start: HanddrawPoint
    end: HanddrawPoint
    ux: number
    uy: number
  }
  const lines: LineGeometry[] = candidates.map(stroke => {
    const start = stroke.points[0]
    const end = stroke.points[stroke.points.length - 1]
    const length = stroke.chord
    return { stroke, start, end, ux: (end.x - start.x) / length, uy: (end.y - start.y) / length }
  })
  function nearlyParallel(first: LineGeometry, second: LineGeometry): boolean {
    return Math.abs(first.ux * second.ux + first.uy * second.uy) >= cosineLimit
  }
  function lateralOffset(reference: LineGeometry, point: HanddrawPoint): number {
    return Math.abs(-(point.x - reference.start.x) * reference.uy + (point.y - reference.start.y) * reference.ux)
  }
  // 双键/三键的内侧短线旁边一定还有一根更长的同向主键线；字母的两根平行竖笔没有这样的主线。
  function hasLongerParallelCompanion(pair: readonly [LineGeometry, LineGeometry]): boolean {
    const pairMax = Math.max(pair[0].stroke.chord, pair[1].stroke.chord)
    for (const line of lines) {
      if (line.stroke === pair[0].stroke || line.stroke === pair[1].stroke) continue
      if (line.stroke.chord < pairMax * 1.15) continue
      if (!nearlyParallel(line, pair[0])) continue
      if (lateralOffset(line, pair[0].start) > 0.35 * scale) continue
      return true
    }
    return false
  }
  for (let first = 0; first < lines.length; first += 1) {
    for (let second = first + 1; second < lines.length; second += 1) {
      const a = lines[first]
      const b = lines[second]
      if (!nearlyParallel(a, b)) continue
      const offsetA = lateralOffset(a, b.start)
      const offsetB = lateralOffset(a, b.end)
      if (Math.min(offsetA, offsetB) > 0.2 * scale) continue
      if (Math.max(offsetA, offsetB) > 0.28 * scale) continue
      const startProjection = (b.start.x - a.start.x) * a.ux + (b.start.y - a.start.y) * a.uy
      const endProjection = (b.end.x - a.start.x) * a.ux + (b.end.y - a.start.y) * a.uy
      const overlap = Math.max(0, Math.min(a.stroke.chord, Math.max(startProjection, endProjection)) - Math.max(0, Math.min(startProjection, endProjection)))
      if (overlap < 0.4 * Math.min(a.stroke.chord, b.stroke.chord)) continue
      const pairHasKnownBond = a.stroke.role === 'bond' || b.stroke.role === 'bond'
      if (!pairHasKnownBond && !hasLongerParallelCompanion([a, b])) continue
      a.stroke.role = 'bond'
      b.stroke.role = 'bond'
    }
  }
}

/**
 * 一笔“折返”画出的多重键（U 形）：去程一条长直线、折回一条近似平行的长直线，
 * 中间用很短的连接段相连。这种笔画整体是键线，不能进入文字聚类，否则会产生
 * “无法识别为原子标签”的误导提示。
 *
 * 防误判：两条直段都要足够长（≥0.4*scale）且直线度高；中间连接段总和很短；
 * 两段近似反平行、横向间距不超过 0.3*scale、投影重叠大。
 * 字母 U/C/S、圆圈、涂鸦的直段长度或连接段长度都不满足这些条件。
 */
/** 把简化顶点映射回原始点的单调下标，用于计算每一折线段的真实直线度。 */
function mapSimplifiedIndices(points: readonly HanddrawPoint[], simplified: readonly HanddrawPoint[]): number[] {
  const indices: number[] = []
  let searchFrom = 0
  for (const vertex of simplified) {
    let bestIndex = searchFrom
    let bestDistance = Infinity
    for (let index = searchFrom; index < points.length; index += 1) {
      const value = distance(points[index], vertex)
      if (value < bestDistance) {
        bestDistance = value
        bestIndex = index
      }
    }
    if (!indices.length || bestIndex > indices[indices.length - 1]) indices.push(bestIndex)
    searchFrom = bestIndex
  }
  return indices
}

/** 折线段的直线度：1 - 最大垂距/弦长，1 表示完全笔直。 */
function runStraightness(points: readonly HanddrawPoint[], startIndex: number, endIndex: number): number {
  if (endIndex <= startIndex) return 0
  const first = points[startIndex]
  const second = points[endIndex]
  const chord = distance(first, second)
  if (!(chord > 1e-6)) return 0
  let maxDeviation = 0
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const point = points[index]
    const deviation = Math.abs(((second.x - first.x) * (first.y - point.y) - (first.x - point.x) * (second.y - first.y)) / chord)
    if (deviation > maxDeviation) maxDeviation = deviation
  }
  return 1 - maxDeviation / chord
}

function isFoldedBondStroke(stroke: StrokeInfo, scale: number): boolean {
  if (stroke.points.length < 8 || stroke.simplified.length < 3) return false
  if (stroke.simplified.length > 9) return false
  // 折返笔画总长约为最长直段的 2～3.4 倍；复杂涂鸦会远超这个比例。
  if (stroke.length > 3.4 * stroke.maxRun) return false
  const runIndices = mapSimplifiedIndices(stroke.points, stroke.simplified)
  interface Run {
    a: HanddrawPoint
    b: HanddrawPoint
    length: number
    ux: number
    uy: number
    straightness: number
  }
  const runs: Run[] = []
  for (let index = 1; index < stroke.simplified.length; index += 1) {
    const a = stroke.simplified[index - 1]
    const b = stroke.simplified[index]
    const length = distance(a, b)
    if (!(length > 1e-6)) continue
    runs.push({
      a,
      b,
      length,
      ux: (b.x - a.x) / length,
      uy: (b.y - a.y) / length,
      straightness: runStraightness(stroke.points, runIndices[index - 1], runIndices[index]),
    })
  }
  if (runs.length < 2) return false
  const minimumRun = 0.4 * scale
  const maximumConnector = 0.3 * scale
  const cosineLimit = Math.cos((13 * Math.PI) / 180)
  const maximumOffset = 0.3 * scale
  for (let first = 0; first < runs.length - 1; first += 1) {
    if (runs[first].length < minimumRun || runs[first].straightness < 0.94) continue
    for (let second = first + 1; second < runs.length; second += 1) {
      if (runs[second].length < minimumRun || runs[second].straightness < 0.94) continue
      let connector = 0
      for (let index = first + 1; index < second; index += 1) connector += runs[index].length
      if (connector > maximumConnector) continue
      const firstRun = runs[first]
      const secondRun = runs[second]
      // 两条直段要近似反平行（折返），不能是同向折线链。
      const dot = firstRun.ux * secondRun.ux + firstRun.uy * secondRun.uy
      if (dot > -cosineLimit) continue
      const offsetA = Math.abs(-(secondRun.a.x - firstRun.a.x) * firstRun.uy + (secondRun.a.y - firstRun.a.y) * firstRun.ux)
      const offsetB = Math.abs(-(secondRun.b.x - firstRun.a.x) * firstRun.uy + (secondRun.b.y - firstRun.a.y) * firstRun.ux)
      if (Math.min(offsetA, offsetB) > maximumOffset) continue
      if (Math.max(offsetA, offsetB) > maximumOffset) continue
      const startProjection = (secondRun.a.x - firstRun.a.x) * firstRun.ux + (secondRun.a.y - firstRun.a.y) * firstRun.uy
      const endProjection = (secondRun.b.x - firstRun.a.x) * firstRun.ux + (secondRun.b.y - firstRun.a.y) * firstRun.uy
      const overlap = Math.max(0, Math.min(firstRun.length, Math.max(startProjection, endProjection)) - Math.max(0, Math.min(startProjection, endProjection)))
      if (overlap < 0.6 * Math.min(firstRun.length, secondRun.length)) continue
      return true
    }
  }
  return false
}

/** 已判定为键的笔迹上的直线段，用于标签锚点吸附。 */
function collectAnchorSegments(strokes: readonly StrokeInfo[], scale: number): BondSegment[] {
  const segments: BondSegment[] = []
  const minimum = Math.max(0.4 * scale, 5)
  for (const stroke of strokes) {
    if (stroke.role !== 'bond') continue
    for (let index = 1; index < stroke.simplified.length; index += 1) {
      const first = stroke.simplified[index - 1]
      const second = stroke.simplified[index]
      if (distance(first, second) >= minimum) segments.push({ a: first, b: second, strokeIndex: stroke.index })
    }
  }
  return segments
}

/** 判断一笔是键线还是文字笔画。长直键线（哪怕略微手抖）绝不能当文字。 */
function decideStrokeRole(stroke: StrokeInfo, scale: number, minBondLength: number): 'bond' | 'glyph' {
  if (stroke.points.length < 2) return 'glyph'
  // 一笔画出多根键（折线链）：存在接近键长的直线段。
  if (stroke.maxRun >= 0.88 * scale && (stroke.straightness >= 0.7 || stroke.chord >= 1.15 * scale)) return 'bond'
  // 长直线：典型单键（长度至少接近键长尺度与最小键长）。
  const longBondSpan = Math.max(0.75 * scale, Math.min(minBondLength, 0.9 * scale))
  if (stroke.straightness >= 0.9 && stroke.chord >= longBondSpan) return 'bond'
  return 'glyph'
}

/* ------------------------------------------------------------------------- *
 * 标签分组：把同一标签的多笔（H 的竖、横，NH2 的三个字符等）聚到一起
 * ------------------------------------------------------------------------- */

function horizontalGap(first: Bounds, second: Bounds): number {
  return Math.max(first.minX - second.maxX, second.minX - first.maxX, 0)
}

function verticalGap(first: Bounds, second: Bounds): number {
  return Math.max(first.minY - second.maxY, second.minY - first.maxY, 0)
}

function canGroupStrokes(first: StrokeInfo, second: StrokeInfo, scale: number): boolean {
  const overlap = boundsOverlapRatio(first.bounds, second.bounds)
  const gapX = horizontalGap(first.bounds, second.bounds)
  const gapY = verticalGap(first.bounds, second.bounds)
  const referenceHeight = Math.max(first.height, second.height, 0.2 * scale)
  const narrowHeight = Math.min(first.height, second.height)
  // 阈值对全局 scale 不完全敏感：字写大时按本簇字高放宽。
  if (gapX > Math.max(0.17 * scale, 0.35 * referenceHeight)) return false
  const verticalReach = gapY <= Math.max(0.13 * scale, 0.25 * narrowHeight) || overlap.y >= 0.28
  if (!verticalReach) return false
  const combined = unionBounds(first.bounds, second.bounds)
  if (boundsHeight(combined) > Math.max(1.25 * scale, 1.7 * referenceHeight)) return false
  if (boundsWidth(combined) > Math.max(4.8 * scale, 8 * referenceHeight)) return false
  return true
}

function groupGlyphStrokes(strokes: readonly StrokeInfo[], scale: number): StrokeInfo[][] {
  const count = strokes.length
  const parent = Array.from({ length: count }, (_, index) => index)
  const rootBounds: Bounds[] = strokes.map(stroke => ({ ...stroke.bounds }))
  const rootMaxHeight: number[] = strokes.map(stroke => stroke.height)
  function find(index: number): number {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  function mergeable(firstRoot: number, secondRoot: number): boolean {
    const merged = unionBounds(rootBounds[firstRoot], rootBounds[secondRoot])
    const maxHeight = Math.max(rootMaxHeight[firstRoot], rootMaxHeight[secondRoot])
    if (boundsHeight(merged) > Math.max(1.35 * scale, 1.9 * maxHeight)) return false
    if (boundsWidth(merged) > Math.max(5.2 * scale, 9 * maxHeight)) return false
    return true
  }
  function union(first: number, second: number): void {
    const firstRoot = find(first)
    const secondRoot = find(second)
    if (firstRoot === secondRoot) return
    // 直接相邻的两笔可能通过中间笔把整圈环线桥接起来；合并前检查整组包围盒上限。
    if (!mergeable(firstRoot, secondRoot)) return
    parent[secondRoot] = firstRoot
    rootBounds[firstRoot] = unionBounds(rootBounds[firstRoot], rootBounds[secondRoot])
    rootMaxHeight[firstRoot] = Math.max(rootMaxHeight[firstRoot], rootMaxHeight[secondRoot])
  }
  // 反复扫描直到稳定：先合并的组可能让后面的合并条件变松/变紧。
  for (let pass = 0; pass < count; pass += 1) {
    let changed = false
    for (let first = 0; first < count; first += 1) {
      for (let second = first + 1; second < count; second += 1) {
        if (find(first) === find(second)) continue
        if (!canGroupStrokes(strokes[first], strokes[second], scale)) continue
        const before = find(first)
        union(first, second)
        if (find(first) !== before) changed = true
      }
    }
    if (!changed) break
  }
  const byRoot = new Map<number, StrokeInfo[]>()
  for (let index = 0; index < count; index += 1) {
    const root = find(index)
    const bucket = byRoot.get(root)
    if (bucket) bucket.push(strokes[index])
    else byRoot.set(root, [strokes[index]])
  }
  const groups = [...byRoot.values()]
  for (const group of groups) group.sort((left, right) => left.index - right.index)
  groups.sort((left, right) => left[0].index - right[0].index)
  return groups
}

/* ------------------------------------------------------------------------- *
 * 匹配栅格准备与模板比较
 * ------------------------------------------------------------------------- */

interface PointDirection {
  /** 双角余弦 cos(2θ)。 */
  cos: number
  /** 双角正弦 sin(2θ)。 */
  sin: number
}

interface GroupInk {
  strokes: StrokeInfo[]
  points: HanddrawPoint[]
  directions: PointDirection[]
  /** 每条笔画在 points 里的点数，用于栅格化时按笔画独立处理。 */
  strokePointCounts: number[]
  bounds: Bounds
  width: number
  height: number
  structure: [number, number, number]
}

function buildGroupInk(strokes: readonly StrokeInfo[]): GroupInk {
  let box = strokes[0].bounds
  for (let index = 1; index < strokes.length; index += 1) box = unionBounds(box, strokes[index].bounds)
  const height = boundsHeight(box)
  const points: HanddrawPoint[] = []
  const directions: PointDirection[] = []
  const strokePointCounts: number[] = []
  const spacing = Math.max(0.8, height / 22)
  for (const stroke of strokes) {
    const count = clamp(Math.ceil(stroke.length / spacing) + 1, 2, 90)
    const samples = resamplePolyline(stroke.points, count)
    for (let index = 0; index < samples.length; index += 1) {
      const direction = directionAt(samples, index)
      points.push(samples[index])
      directions.push(direction ?? { cos: 1, sin: 0 })
    }
    strokePointCounts.push(samples.length)
  }
  const structure = structureFromDirections(directions.map(direction => ({ direction, weight: 1 })))
  return { strokes: [...strokes], points, directions, strokePointCounts, bounds: box, width: boundsWidth(box), height, structure }
}

function rotatePoint(point: HanddrawPoint, center: HanddrawPoint, angle: number): HanddrawPoint {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return { x: center.x + dx * cosine - dy * sine, y: center.y + dx * sine + dy * cosine }
}

function prepareCandidateGrid(ink: GroupInk, center: HanddrawPoint, rotation: number): CandidateGrid | undefined {
  const cosine = Math.cos(2 * rotation)
  const sine = Math.sin(2 * rotation)
  const rotated = ink.points.map(point => (rotation === 0 ? point : rotatePoint(point, center, rotation)))
  const box = bounds(rotated)
  const height = boundsHeight(box)
  if (!(height > 1e-3) || rotated.length < 2) return undefined
  const scale = INK_HEIGHT_CELLS / height
  const cellPoints = rotated.map(point => ({
    x: INK_MARGIN_X + (point.x - box.minX) * scale,
    y: INK_MARGIN_Y + (point.y - box.minY) * scale,
  }))
  const cellStrokes: HanddrawPoint[][] = []
  let cursor = 0
  for (const count of ink.strokePointCounts) {
    cellStrokes.push(cellPoints.slice(cursor, cursor + count))
    cursor += count
  }
  const { mask, cells } = rasterizeCellStrokes(cellStrokes)
  if (!cells.length) return undefined
  const dirCos = new Float32Array(GRID_CELLS)
  const dirSin = new Float32Array(GRID_CELLS)
  const dirMask = new Uint8Array(GRID_CELLS)
  // 同一栅格内可能有多个采样点（多笔重叠）：累加双角向量，保证结果与笔画顺序无关。
  for (let index = 0; index < cellPoints.length; index += 1) {
    const direction = ink.directions[index]
    const cell = gridIndexOf(cellPoints[index].x, cellPoints[index].y)
    // 方向随旋转同步旋转：双角表达式下等于角度加 2·rotation。
    dirCos[cell] += direction.cos * cosine - direction.sin * sine
    dirSin[cell] += direction.cos * sine + direction.sin * cosine
    dirMask[cell] = 1
  }
  for (let index = 0; index < GRID_CELLS; index += 1) {
    if (!dirMask[index]) continue
    const length = Math.hypot(dirCos[index], dirSin[index])
    if (length < 1e-6) {
      dirCos[index] = 1
      dirSin[index] = 0
    } else {
      dirCos[index] /= length
      dirSin[index] /= length
    }
  }
  const rotatedDirections = ink.directions.map(direction => ({
    cos: direction.cos * cosine - direction.sin * sine,
    sin: direction.cos * sine + direction.sin * cosine,
  }))
  return {
    points: cellPoints,
    distance: buildDistanceField(mask),
    inkCells: Int32Array.from(cells),
    aspect: boundsWidth(box) / height,
    dirCos,
    dirSin,
    dirMask,
    structure: structureFromDirections(rotatedDirections.map(direction => ({ direction, weight: 1 }))),
  }
}

/** 两个候选模板的相似性评分，越小越像。综合双向 chamfer 距离与覆盖率。 */
interface TemplateComparison {
  raw: number
  forward: number
  backward: number
  precision: number
  recall: number
  direction: number
  aspectPenalty: number
  excessInk: number
}

/** 比较候选墨迹与模板：双向 chamfer 距离 + 覆盖率 + 局部方向一致性。 */
function compareTemplateParts(candidate: CandidateGrid, template: InkTemplate): TemplateComparison {
  const candidateCount = candidate.points.length
  const templateCount = template.inkCells.length
  if (!candidateCount || !templateCount) {
    return { raw: 10, forward: 1, backward: 1, precision: 0, recall: 0, direction: 0.5, aspectPenalty: 1.5, excessInk: 1 }
  }
  let forwardSum = 0
  let precisionHits = 0
  for (const point of candidate.points) {
    const index = gridIndexOf(point.x, point.y)
    const value = template.distance[index]
    forwardSum += value < DISTANCE_CAP_CELLS ? value : DISTANCE_CAP_CELLS
    if (value <= COVER_TOLERANCE_CELLS) precisionHits += 1
  }
  let backwardSum = 0
  let recallHits = 0
  let directionSum = 0
  let directionCount = 0
  for (let index = 0; index < templateCount; index += 1) {
    const cell = template.inkCells[index]
    const value = candidate.distance[cell]
    backwardSum += value < DISTANCE_CAP_CELLS ? value : DISTANCE_CAP_CELLS
    if (value <= COVER_TOLERANCE_CELLS) recallHits += 1
    if (value <= DIRECTION_RADIUS_CELLS && candidate.dirMask[cell]) {
      const dot = candidate.dirCos[cell] * template.dirCos[index] + candidate.dirSin[cell] * template.dirSin[index]
      directionSum += clamp01((1 - dot) / 2) * (1 - value / (DIRECTION_RADIUS_CELLS + 1))
      directionCount += 1
    }
  }
  const precision = precisionHits / candidateCount
  const recall = recallHits / templateCount
  const forward = forwardSum / candidateCount / DISTANCE_CAP_CELLS
  const backward = backwardSum / templateCount / DISTANCE_CAP_CELLS
  const direction = directionCount ? directionSum / directionCount : 0.25
  const aspectPenalty = Math.min(1.5, Math.abs(Math.log(candidate.aspect / template.aspect)))
  const inkRatio = candidate.inkCells.length / templateCount
  const excessInk = Math.max(0, Math.min(2, inkRatio - 1.9))
  const structureTerm = Math.abs(candidate.structure[0] - template.structure[0])
    + Math.abs(candidate.structure[1] - template.structure[1])
    + Math.abs(candidate.structure[2] - template.structure[2])
  const raw = 0.3 * (1 - precision) + 0.3 * (1 - recall)
    + 0.18 * forward + 0.12 * backward
    + 0.10 * direction
    + 0.06 * structureTerm
    + 0.06 * aspectPenalty + 0.04 * excessInk
  return { raw, forward, backward, precision, recall, direction, aspectPenalty, excessInk }
}

function compareTemplate(candidate: CandidateGrid, template: InkTemplate): number {
  return compareTemplateParts(candidate, template).raw
}

function aspectCompatible(candidateAspect: number, templateAspect: number): boolean {
  const ratio = candidateAspect / Math.max(templateAspect, 1e-3)
  return ratio <= 2.3 && ratio >= 1 / 2.3
}

interface ScoreEntry {
  text: string
  element: string
  raw: number
}

/** 对一组模板打分，按文本去重保留最佳分数，升序返回。 */
function scoreTemplates(candidate: CandidateGrid, templates: readonly InkTemplate[]): ScoreEntry[] {
  const best = new Map<string, ScoreEntry>()
  for (const template of templates) {
    if (!aspectCompatible(candidate.aspect, template.aspect)) continue
    const raw = compareTemplate(candidate, template)
    const current = best.get(template.text)
    if (!current || raw < current.raw) best.set(template.text, { text: template.text, element: template.element, raw })
  }
  return [...best.values()].sort((left, right) => left.raw - right.raw || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
}

const LABEL_ELEMENT = new Map(LABEL_SPECS.map(spec => [spec.text, spec.element] as const))

/**
 * 每个标签里“连接原子”（通常是第一个字符）中心的横向位置比例，
 * 用于把 anchor 放在元素字母附近而不是整组包围盒中心。
 */
let labelLayoutCache: Map<string, number> | undefined

function labelElementFraction(text: string): number {
  if (!labelLayoutCache) {
    const fractions = new Map<string, number>()
    const charShapes = buildCharShapes()
    for (const spec of LABEL_SPECS) {
      let total = 0
      let firstCenter = 0
      for (let index = 0; index < spec.sequence.length; index += 1) {
        const item = spec.sequence[index]
        const shape = charShapes[item.char]
        if (!shape) continue
        const width = boundsWidth(bounds(shape.flat())) * (item.subscript ? 0.6 : 1)
        if (index === 0) firstCenter = total + width / 2
        total += width + (item.subscript ? 0.07 : 0.11)
      }
      fractions.set(spec.text, total > 0 ? firstCenter / total : 0.5)
    }
    labelLayoutCache = fractions
  }
  const base = text.replace(/[+-]$/, '')
  return clamp(labelLayoutCache.get(base) ?? 0.5, 0.08, 0.92)
}

/** 字高相对键长的合理区间，超出后置信度打折。 */
function glyphSizeFactor(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0.6
  if (ratio < 0.3) return clamp(0.55 + (ratio / 0.3) * 0.45, 0.55, 1)
  if (ratio > 1.15) return clamp(1 - (ratio - 1.15) * 0.7, 0.55, 1)
  return 1
}

function confidenceFromRaw(raw: number, secondRaw: number, sizeFactor: number): number {
  const quality = clamp01(1.3 - raw * 2.6)
  const margin = clamp01((secondRaw - raw) / 0.12)
  return clamp01(quality * (0.82 + 0.18 * margin) * sizeFactor)
}

interface LabelMatch {
  text: string
  element: string
  charge: number
  confidence: number
  raw: number
  alternatives: { text: string; element: string; charge: number; confidence: number }[]
}

function buildLabelMatch(entries: readonly ScoreEntry[], heightRatio: number): LabelMatch {
  const top = entries[0]
  const second = entries[1]
  const sizeFactor = glyphSizeFactor(heightRatio)
  const confidence = confidenceFromRaw(top.raw, second ? second.raw : top.raw + 0.2, sizeFactor)
  const alternatives: LabelMatch['alternatives'] = []
  for (let index = 1; index < entries.length && alternatives.length < 3; index += 1) {
    const entry = entries[index]
    const entryConfidence = confidenceFromRaw(entry.raw, top.raw + 0.2, sizeFactor) * 0.85
    if (entryConfidence < 0.05) continue
    alternatives.push({ text: entry.text, element: entry.element, charge: 0, confidence: clamp01(entryConfidence) })
  }
  return { text: top.text, element: top.element, charge: 0, confidence, raw: top.raw, alternatives }
}

/**
 * 按标签模板的字符边界把候选墨迹切成字符段，逐字符与字符模板复核。
 * 用于区分整组 chamfer 接近的候选（例如 CN 与 OH、NH2 与 NO2）。
 */
function charLayoutVerification(ink: GroupInk, text: string): number {
  const layout = labelCharLayouts.get(text)
  if (!layout || !(ink.height > 1e-3)) return 0.5
  const toCell = (x: number): number => INK_MARGIN_X + ((x - ink.bounds.minX) / ink.height) * INK_HEIGHT_CELLS
  const slots: StrokeInfo[][] = layout.chars.map(() => [])
  for (const stroke of ink.strokes) {
    const start = toCell(stroke.bounds.minX)
    const end = toCell(stroke.bounds.maxX)
    // 按与各字符区间的横向重叠面积分配，跨字符的横笔（如 H 的横）才不会分错槽。
    let slot = layout.chars.length - 1
    let bestOverlap = -Infinity
    for (let index = 0; index < layout.chars.length; index += 1) {
      const slotStart = layout.boundaries[index]
      const slotEnd = layout.boundaries[index + 1]
      const overlap = Math.min(end, slotEnd) - Math.max(start, slotStart)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        slot = index
      }
    }
    slots[slot].push(stroke)
  }
  const charTemplates = getCharTemplates()
  let total = 0
  let counted = 0
  for (let index = 0; index < layout.chars.length; index += 1) {
    const char = layout.chars[index]
    if (!slots[index].length) continue
    const templates = charTemplates.filter(template => template.text === char)
    if (!templates.length) continue
    const subInk = buildGroupInk(slots[index])
    const grid = prepareCandidateGrid(subInk, boundsCenter(subInk.bounds), 0)
    if (!grid) continue
    let bestRaw = Infinity
    for (const template of templates) {
      if (!aspectCompatible(grid.aspect, template.aspect)) continue
      const raw = compareTemplate(grid, template)
      if (raw < bestRaw) bestRaw = raw
    }
    if (!Number.isFinite(bestRaw)) continue
    total += clamp01(1 - bestRaw / 0.25)
      counted += 1
  }
  if (!counted) return 0.5
  // 缺字符会显著降低复核分，避免把两字符标签当成单字符标签。
  return clamp01(total / layout.chars.length)
}

/** 标签整组匹配：先直立匹配，置信度不够时再尝试轻微旋转。 */
function matchLabelInk(ink: GroupInk, scale: number): LabelMatch | undefined {
  const center = boundsCenter(ink.bounds)
  const rotations = [0, 0.2, -0.2, 0.38, -0.38]
  const heightRatio = ink.height / scale
  let best: LabelMatch | undefined
  for (const rotation of rotations) {
    const grid = prepareCandidateGrid(ink, center, rotation)
    if (!grid) break
    const entries = scoreTemplates(grid, getLabelTemplates())
    if (!entries.length) continue
    // 整组 chamfer 分数接近时，用“字符切分 + 逐字符复核”打破平局。
    if (entries.length >= 2 && entries[1].raw - entries[0].raw < 0.06) {
      const contenders = entries.slice(0, 4).map(entry => ({
        ...entry,
        raw: entry.raw + 0.12 * (1 - charLayoutVerification(ink, entry.text)),
      }))
      contenders.sort((left, right) => left.raw - right.raw || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0))
      for (let index = 0; index < contenders.length; index += 1) entries[index] = contenders[index]
    }
      const match = buildLabelMatch(entries, heightRatio)
    if (!best || match.confidence > best.confidence + 1e-9) best = match
    if (best.confidence >= 0.82) break
  }
  return best
}

/* ------------------------------------------------------------------------- *
 * 圆圈（字母 O / 芳环内圈）检测与“直边多边形环”排除
 * ------------------------------------------------------------------------- */

/**
 * 单笔闭合多边形（三角/四边/五边/六边/八边手写环）看起来也像圈，
 * 但每条边都是直线。这里用平滑后的 RDP 顶点 + 每条边到弦的垂距判断，
 * 避免把环线当成字母 O 而整笔剔除。
 */
interface PolygonDiagnostics {
  closed: boolean
  vertexCount: number
  edges: number
  straightEdges: number
  diagonal: number
  longEdges: number
  longShare: number
}

function smoothPoints(points: readonly HanddrawPoint[]): HanddrawPoint[] {
  if (points.length < 3) return points.map(point => ({ x: point.x, y: point.y }))
  // 5 点平滑（[1,2,3,2,1]/9）：滤掉手抖，但保留多边形拐角的整体走向。
  const result: HanddrawPoint[] = [points[0]]
  for (let index = 1; index < points.length - 1; index += 1) {
    let sumX = 0
    let sumY = 0
    let weightSum = 0
    for (let offset = -2; offset <= 2; offset += 1) {
      const sample = index + offset
      if (sample < 0 || sample >= points.length) continue
      const weight = 3 - Math.abs(offset)
      sumX += points[sample].x * weight
      sumY += points[sample].y * weight
      weightSum += weight
    }
    result.push({ x: sumX / weightSum, y: sumY / weightSum })
  }
  result.push(points[points.length - 1])
  return result
}

function polygonDiagnostics(ink: GroupInk): PolygonDiagnostics {
  const empty: PolygonDiagnostics = { closed: false, vertexCount: 0, edges: 0, straightEdges: 0, diagonal: 0, longEdges: 0, longShare: 0 }
  if (ink.strokes.length !== 1 || ink.points.length < 10) return empty
  const diagonal = boundsDiagonal(ink.bounds)
  if (!(diagonal > 1)) return empty
  const raw = smoothPoints(ink.points)
  const closed = distance(raw[0], raw[raw.length - 1]) <= 0.25 * diagonal
  if (!closed) return { ...empty, diagonal }
  const tolerance = Math.max(1.2, 0.015 * diagonal)
  const simplified = simplifyRdp(raw, tolerance)
  const vertexCount = simplified.length - 1
  if (vertexCount < 3 || vertexCount > 14) return { ...empty, closed, diagonal, vertexCount }
  const indices: number[] = []
  let searchFrom = 0
  for (const vertex of simplified) {
    let bestIndex = searchFrom
    let bestDistance = Infinity
    for (let index = searchFrom; index < raw.length; index += 1) {
      const value = distance(raw[index], vertex)
      if (value < bestDistance) {
        bestDistance = value
        bestIndex = index
      }
    }
    if (!indices.length || bestIndex > indices[indices.length - 1]) indices.push(bestIndex)
    searchFrom = bestIndex
  }
  if (indices.length < 4) return { ...empty, closed, diagonal, vertexCount }
  const edges = indices.length - 1
  let perimeter = 0
  let longLength = 0
  let longEdges = 0
  let straightLongEdges = 0
  for (let index = 0; index < edges; index += 1) {
    const first = raw[indices[index]]
    const second = raw[indices[index + 1]]
    const chord = distance(first, second)
    perimeter += chord
    if (chord < 0.22 * diagonal) continue
    longEdges += 1
    longLength += chord
    let maxDeviation = 0
    for (let point = indices[index] + 1; point < indices[index + 1]; point += 1) {
      const deviation = Math.abs(
        ((second.x - first.x) * (first.y - raw[point].y) - (first.x - raw[point].x) * (second.y - first.y)) / chord,
      )
      if (deviation > maxDeviation) maxDeviation = deviation
    }
    if (maxDeviation / chord <= 0.06) straightLongEdges += 1
  }
  return {
    closed,
    diagonal,
    vertexCount,
    edges,
    longEdges,
    longShare: perimeter > 1e-6 ? longLength / perimeter : 0,
    straightEdges: longEdges >= 3 && straightLongEdges === longEdges && longLength >= 0.6 * perimeter ? longEdges : 0,
  }
}

function isStraightEdgedPolygon(ink: GroupInk): boolean {
  const diagnostics = polygonDiagnostics(ink)
  return diagnostics.closed
    && diagnostics.vertexCount >= 3
    && diagnostics.vertexCount <= 14
    && diagnostics.longEdges >= Math.max(3, Math.ceil(diagnostics.vertexCount * 0.45))
    && diagnostics.straightEdges >= 3
}

interface LoopInfo {
  center: HanddrawPoint
  radius: number
  /** 角度覆盖率，1 表示完整闭合圆。 */
  coverage: number
  closed: boolean
  /** 最长“直边”相对半径的比值；直边多边形（六边形等）接近或超过 1，手写圆明显更小。 */
  straightRunRatio: number
  /** 拟合残差 / 半径；平滑圆弧很小，多边形或潦草涂鸦偏大。 */
  rmsRatio: number
  /** 椭圆归一化后的径向离散度：平滑椭圆/圆很小，直边多边形（角与边半径差）明显更大。 */
  radialStdRatio: number
  /** 强拐角峰数量：平滑圆 0～2，直边多边形 ≥3。 */
  cornerPeakCount: number
}

function analyzeLoop(points: readonly HanddrawPoint[]): LoopInfo | undefined {
  if (points.length < 6) return undefined
  const fit = fitCircle(points)
  if (!fit || !(fit.radius > 1)) return undefined
  if (fit.rms / fit.radius > 0.3) return undefined
  const angles: number[] = []
  for (const point of points) {
    let angle = Math.atan2(point.y - fit.center.y, point.x - fit.center.x)
    if (angle < 0) angle += Math.PI * 2
    angles.push(angle)
  }
  angles.sort((left, right) => left - right)
  let largestGap = angles[0] + Math.PI * 2 - angles[angles.length - 1]
  for (let index = 1; index < angles.length; index += 1) largestGap = Math.max(largestGap, angles[index] - angles[index - 1])
  const coverage = clamp01(1 - largestGap / (Math.PI * 2))
  // 手写圆用 RDP 简化后每段都短；正多边形的边是完整直线，最长直边接近半径。
  const simplified = simplifyRdp(points, Math.max(0.5, fit.radius * 0.02))
  let longestRun = 0
  for (let index = 1; index < simplified.length; index += 1) {
    longestRun = Math.max(longestRun, distance(simplified[index - 1], simplified[index]))
  }
  // 用协方差主轴做“椭圆归一化”，再看向径离散度：椭圆会被拉回圆，直边多边形不会。
  let meanX = 0
  let meanY = 0
  for (const point of points) {
    meanX += point.x
    meanY += point.y
  }
  meanX /= points.length
  meanY /= points.length
  let covarianceXX = 0
  let covarianceYY = 0
  let covarianceXY = 0
  for (const point of points) {
    const dx = point.x - meanX
    const dy = point.y - meanY
    covarianceXX += dx * dx
    covarianceYY += dy * dy
    covarianceXY += dx * dy
  }
  covarianceXX /= points.length
  covarianceYY /= points.length
  covarianceXY /= points.length
  const trace = covarianceXX + covarianceYY
  const discriminant = Math.sqrt(Math.max(0, (covarianceXX - covarianceYY) * (covarianceXX - covarianceYY) / 4 + covarianceXY * covarianceXY))
  const eigenvalueFirst = Math.max(trace / 2 + discriminant, 1e-6)
  const eigenvalueSecond = Math.max(trace / 2 - discriminant, 1e-6)
  const angle = 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY)
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const rootFirst = Math.sqrt(eigenvalueFirst)
  const rootSecond = Math.sqrt(eigenvalueSecond)
  let radialSum = 0
  const radialValues: number[] = []
  for (const point of points) {
    const dx = point.x - meanX
    const dy = point.y - meanY
    const localX = (dx * cosine + dy * sine) / rootFirst
    const localY = (-dx * sine + dy * cosine) / rootSecond
    const radial = Math.hypot(localX, localY)
    radialValues.push(radial)
    radialSum += radial
  }
  const radialMean = radialSum / points.length
  let radialVariance = 0
  for (const value of radialValues) radialVariance += (value - radialMean) * (value - radialMean)
  const radialStdRatio = radialMean > 1e-6 ? Math.sqrt(radialVariance / points.length) / radialMean : 0
  // 强拐角峰：多边形每个顶点一个峰，平滑圆几乎没有。
  const path = resamplePolyline(points, 96)
  const perimeter = polylineLength(path)
  const arm = Math.max(3, (perimeter / 95) * 4)
  const strengths = path.map((_, index) => cornerStrength(path, index, arm))
  const peakIndices: number[] = []
  for (let index = 0; index < strengths.length; index += 1) {
    if (strengths[index] < 0.3) continue
    let isPeak = true
    for (let offset = -3; offset <= 3; offset += 1) {
      const other = (index + offset + strengths.length) % strengths.length
      if (strengths[other] > strengths[index]) {
        isPeak = false
        break
      }
    }
    if (!isPeak) continue
    const last = peakIndices[peakIndices.length - 1]
    if (last !== undefined && index - last < 6) continue
    peakIndices.push(index)
  }
  const cornerPeakCount = peakIndices.length
  return {
    center: fit.center,
    radius: fit.radius,
    coverage,
    closed: coverage >= 0.8,
    straightRunRatio: longestRun / fit.radius,
    rmsRatio: fit.rms / fit.radius,
    radialStdRatio,
    cornerPeakCount,
  }
}

/**
 * 手写“芳环内圈”检测：允许开口 20～35%、椭圆、径向抖动的不规则环。
 * 与 analyzeLoop 的区别是判据更宽容，但只对单笔、且形态确实是“绕圈”的墨迹
 * 生效（字母 C/S/U 等靠模板置信度保护，见 recognizeGroup 中的 override）。
 */
interface HandCircleCandidate {
  confidence: number
  radius: number
  coverage: number
  rmsRatio: number
}

function detectHandDrawnCircle(ink: GroupInk, scale: number): HandCircleCandidate | undefined {
  if (ink.strokes.length !== 1 || ink.points.length < 10) return undefined
  const stroke = ink.strokes[0]
  if (stroke.length < 0.5 * scale) return undefined
  // 太直的笔迹是键线，不可能是圈。
  const chordRatio = stroke.length > 1e-6 ? stroke.chord / stroke.length : 0
  if (chordRatio > 0.75) return undefined
  const fit = fitCircle(ink.points)
  if (!fit || !(fit.radius > 1)) return undefined
  const rmsRatio = fit.rms / fit.radius
  if (rmsRatio > 0.32) return undefined
  const angles = ink.points.map(point => {
    let angle = Math.atan2(point.y - fit.center.y, point.x - fit.center.x)
    if (angle < 0) angle += Math.PI * 2
    return angle
  }).sort((left, right) => left - right)
  let largestGap = angles[0] + Math.PI * 2 - angles[angles.length - 1]
  for (let index = 1; index < angles.length; index += 1) largestGap = Math.max(largestGap, angles[index] - angles[index - 1])
  const coverage = clamp01(1 - largestGap / (Math.PI * 2))
  if (coverage < 0.52) return undefined
  // 绕圈方向一致性：字母 S 这种来回拐的笔迹一致性很低。
  const path = resamplePolyline(ink.points, 64)
  let totalTurn = 0
  let netTurn = 0
  for (let index = 1; index < path.length - 1; index += 1) {
    const firstX = path[index].x - path[index - 1].x
    const firstY = path[index].y - path[index - 1].y
    const secondX = path[index + 1].x - path[index].x
    const secondY = path[index + 1].y - path[index].y
    const turn = Math.atan2(firstX * secondY - firstY * secondX, firstX * secondX + firstY * secondY)
    totalTurn += Math.abs(turn)
    netTurn += turn
  }
  if (!(totalTurn > 1e-6) || Math.abs(netTurn) / totalTurn < 0.7) return undefined
  if (totalTurn < 1.8) return undefined
  // 强拐角峰：正多边形/尖锐折线会被多边形判据先拦掉；这里再兜底限制。
  const perimeter = polylineLength(path)
  const arm = Math.max(3, (perimeter / 63) * 3)
  const strengths = path.map((_, index) => cornerStrength(path, index, arm))
  let cornerPeakCount = 0
  for (let index = 0; index < strengths.length; index += 1) {
    if (strengths[index] < 0.3) continue
    let isPeak = true
    for (let offset = -2; offset <= 2; offset += 1) {
      const other = (index + offset + strengths.length) % strengths.length
      if (strengths[other] > strengths[index]) {
        isPeak = false
        break
      }
    }
    if (isPeak) cornerPeakCount += 1
  }
  if (cornerPeakCount > 3) return undefined
  // 径向离散度兜底：排除乱涂的螺旋。
  if (fit.radius < 0.08 * scale && coverage < 0.7) return undefined
  const smooth = clamp01(1 - rmsRatio / 0.4)
  const coverageFactor = clamp01((coverage - 0.45) / 0.5)
  const confidence = clamp01(0.6 + 0.2 * coverageFactor + 0.2 * smooth + (coverage >= 0.85 ? 0.05 : 0))
  return { confidence, radius: fit.radius, coverage, rmsRatio }
}

/* ------------------------------------------------------------------------- *
 * 电荷符号（+ / −）识别与剥离
 * ------------------------------------------------------------------------- */

interface SignUnit {
  sign: '+' | '-'
  strokes: StrokeInfo[]
  bounds: Bounds
}

function isTinyStraight(stroke: StrokeInfo, scale: number): boolean {
  if (stroke.points.length < 2) return false
  return stroke.chord <= 0.34 * scale && stroke.chord >= 0.04 * scale && stroke.straightness >= 0.62
}

function horizontalish(stroke: StrokeInfo): boolean {
  if (stroke.points.length < 2) return false
  const dx = Math.abs(stroke.points[stroke.points.length - 1].x - stroke.points[0].x)
  const dy = Math.abs(stroke.points[stroke.points.length - 1].y - stroke.points[0].y)
  return dx >= dy * 1.6
}

function segmentOf(stroke: StrokeInfo): { a: HanddrawPoint; b: HanddrawPoint } {
  return { a: stroke.points[0], b: stroke.points[stroke.points.length - 1] }
}

/** 找出可能独立成组的 +/− 单元（不与其它笔画交叠）。 */
function findSignUnits(strokes: readonly StrokeInfo[], scale: number): SignUnit[] {
  const tiny = strokes.filter(stroke => isTinyStraight(stroke, scale))
  const used = new Set<number>()
  const units: SignUnit[] = []
  for (let first = 0; first < tiny.length; first += 1) {
    if (used.has(first)) continue
    for (let second = first + 1; second < tiny.length; second += 1) {
      if (used.has(second)) continue
      const firstStroke = tiny[first]
      const secondStroke = tiny[second]
      if (!segmentsIntersect(segmentOf(firstStroke), segmentOf(secondStroke), 0.12)) continue
      const firstHorizontal = horizontalish(firstStroke)
      const secondHorizontal = horizontalish(secondStroke)
      if (firstHorizontal === secondHorizontal) continue
      used.add(first)
      used.add(second)
      units.push({
        sign: '+',
        strokes: [firstStroke, secondStroke],
        bounds: unionBounds(firstStroke.bounds, secondStroke.bounds),
      })
      break
    }
  }
  for (let index = 0; index < tiny.length; index += 1) {
    if (used.has(index)) continue
    const stroke = tiny[index]
    if (!horizontalish(stroke) || stroke.chord < 0.05 * scale) continue
    used.add(index)
    units.push({ sign: '-', strokes: [stroke], bounds: stroke.bounds })
  }
  // 只保留与其它笔画在水平方向基本分离的符号，避免把字母的横笔（H 的横、4 的横）当成电荷。
  const touchGap = Math.max(1, 0.02 * scale)
  const kept = units.filter(unit => {
    for (const stroke of strokes) {
      if (unit.strokes.includes(stroke)) continue
      const overlap = boundsOverlapRatio(unit.bounds, stroke.bounds)
      const gapX = horizontalGap(unit.bounds, stroke.bounds)
      if (overlap.x > 0.35 || gapX <= touchGap) {
              return false
      }
    }
    return true
  })
  return kept
}

/** 找“伸出去”的直线笔画（多半是贴着标签的短键，不应并入标签）。 */
function findExtrudingStrokes(strokes: readonly StrokeInfo[], scale: number): StrokeInfo[] {
  if (strokes.length < 2) return []
  const result: StrokeInfo[] = []
  for (const stroke of strokes) {
    if (stroke.points.length < 2 || stroke.straightness < 0.8 || stroke.chord < 0.3 * scale) continue
    let core: Bounds | undefined
    for (const other of strokes) {
      if (other === stroke) continue
      core = core ? unionBounds(core, other.bounds) : other.bounds
    }
    if (!core) continue
    const firstReach = pointBoundsDistance(stroke.points[0], core)
    const lastReach = pointBoundsDistance(stroke.points[stroke.points.length - 1], core)
    if (Math.max(firstReach, lastReach) >= 0.45 * scale) result.push(stroke)
  }
  return result
}

/* ------------------------------------------------------------------------- *
 * 字符切分回退：字典标签匹配失败时按字符切开识别，再拼成合法元素符号
 * ------------------------------------------------------------------------- */

function segmentStrokesByX(strokes: readonly StrokeInfo[], scale: number): StrokeInfo[][] {
  if (strokes.length <= 1) return strokes.length ? [[...strokes]] : []
  const sorted = [...strokes].sort((left, right) => left.bounds.minX - right.bounds.minX || left.index - right.index)
  const clusters: StrokeInfo[][] = []
  let current: StrokeInfo[] = [sorted[0]]
  let currentMax = sorted[0].bounds.maxX
  for (let index = 1; index < sorted.length; index += 1) {
    const stroke = sorted[index]
    const closeEnough = stroke.bounds.minX - currentMax <= 0.06 * scale
    const overlaps = current.some(member => boundsOverlapRatio(member.bounds, stroke.bounds).x > 0.15)
    if (closeEnough || overlaps) {
      current.push(stroke)
      currentMax = Math.max(currentMax, stroke.bounds.maxX)
    } else {
      clusters.push(current)
      current = [stroke]
      currentMax = stroke.bounds.maxX
    }
  }
  clusters.push(current)
  return clusters
}

/** 单个字符匹配（字符模板），返回最佳字符与置信度。 */
function matchCharInk(ink: GroupInk, scale: number): { char: string; confidence: number; raw: number } | undefined {
  const center = boundsCenter(ink.bounds)
  const rotations = [0, 0.2, -0.2]
  const heightRatio = ink.height / scale
  let best: { char: string; confidence: number; raw: number } | undefined
  for (const rotation of rotations) {
    const grid = prepareCandidateGrid(ink, center, rotation)
    if (!grid) break
    const entries = scoreTemplates(grid, getCharTemplates())
    if (!entries.length) continue
    const top = entries[0]
    const second = entries[1]
    const sizeFactor = glyphSizeFactor(heightRatio)
    const confidence = confidenceFromRaw(top.raw, second ? second.raw : top.raw + 0.2, sizeFactor)
    const candidate = { char: top.text, confidence, raw: top.raw }
    if (!best || candidate.confidence > best.confidence + 1e-9) best = candidate
    if (best.confidence >= 0.8) break
  }
  return best
}

function interpretCharSequence(chars: readonly string[], baseConfidence: number): LabelMatch | undefined {
  if (!chars.length) return undefined
  const text = chars.join('')
  const labelElement = LABEL_ELEMENT.get(text)
  if (labelElement) {
    return { text, element: labelElement, charge: 0, confidence: clamp01(baseConfidence * 0.9), raw: 0.3, alternatives: [] }
  }
  if (SUPPORTED_ELEMENTS.has(text) && /^[A-Z][a-z]?$/.test(text)) {
    return { text, element: text, charge: 0, confidence: clamp01(baseConfidence * 0.88), raw: 0.3, alternatives: [] }
  }
  return undefined
}

function matchCharFallback(ink: GroupInk, scale: number): LabelMatch | undefined {
  const attempts: LabelMatch[] = []
  const segments = segmentStrokesByX(ink.strokes, scale)
  if (segments.length > 1) {
    const chars: string[] = []
    const confidences: number[] = []
    let complete = true
    for (const segment of segments) {
      if (!segment.length) continue
      const segmentInk = buildGroupInk(segment)
      const charMatch = matchCharInk(segmentInk, scale)
      if (!charMatch) {
        complete = false
        break
      }
      chars.push(charMatch.char)
      confidences.push(charMatch.confidence)
    }
    if (complete && chars.length === segments.length) {
      const interpreted = interpretCharSequence(chars, mean(confidences))
      if (interpreted) attempts.push(interpreted)
    }
  }
  const whole = matchCharInk(ink, scale)
  if (whole) {
    const interpreted = interpretCharSequence([whole.char], whole.confidence)
    if (interpreted) attempts.push(interpreted)
  }
  attempts.sort((left, right) => right.confidence - left.confidence)
  return attempts[0]
}

/* ------------------------------------------------------------------------- *
 * 单组标签识别
 * ------------------------------------------------------------------------- */

interface DraftLabel {
  text: string
  element: string
  charge: number
  confidence: number
  bounds: Bounds
  shape: 'text' | 'circle'
  strokes: number[]
  alternatives: { text: string; element: string; charge: number; confidence: number }[]
}

interface GroupRecognition {
  labels: DraftLabel[]
  signs: SignUnit[]
  warnings: string[]
}

function strokeNumbers(strokes: readonly StrokeInfo[], limit = 6): string {
  const numbers = [...new Set(strokes.map(stroke => stroke.index + 1))].sort((left, right) => left - right)
  const shown = numbers.slice(0, limit).map(value => String(value))
  return shown.join('、') + (numbers.length > limit ? ' 等' : '')
}

function unrecognizedWarning(strokes: readonly StrokeInfo[]): string {
  return `第 ${strokeNumbers(strokes)} 笔的手写符号无法识别为原子标签，已忽略（可能是潦草字母或圆圈）。`
}

function withCharge(match: LabelMatch, unit: SignUnit): LabelMatch {
  return {
    text: `${match.text}${unit.sign}`,
    element: match.element,
    charge: unit.sign === '+' ? 1 : -1,
    confidence: match.confidence,
    raw: match.raw,
    alternatives: match.alternatives,
  }
}

function draftFromMatch(match: LabelMatch, usedStrokes: readonly StrokeInfo[], shape: 'text' | 'circle'): DraftLabel {
  let box = usedStrokes[0].bounds
  for (let index = 1; index < usedStrokes.length; index += 1) box = unionBounds(box, usedStrokes[index].bounds)
  return {
    text: match.text,
    element: match.element,
    charge: match.charge,
    confidence: match.confidence,
    bounds: box,
    shape,
    strokes: sortedUniqueNumbers(usedStrokes.map(stroke => stroke.index)),
    alternatives: match.alternatives,
  }
}

function splitStrokesByLargestGap(strokes: readonly StrokeInfo[], scale: number): [StrokeInfo[], StrokeInfo[]] | undefined {
  if (strokes.length < 2) return undefined
  const sorted = [...strokes].sort((left, right) => left.bounds.minX - right.bounds.minX || left.index - right.index)
  let bestIndex = -1
  let bestGap = 0
  let runningMax = sorted[0].bounds.maxX
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index].bounds.minX - runningMax
    if (gap > bestGap) {
      bestGap = gap
      bestIndex = index
    }
    runningMax = Math.max(runningMax, sorted[index].bounds.maxX)
  }
  if (bestIndex < 0 || bestGap < 0.2 * scale) return undefined
  return [sorted.slice(0, bestIndex), sorted.slice(bestIndex)]
}


function recognizeGroup(strokes: readonly StrokeInfo[], scale: number, depth: number): GroupRecognition {
  if (!strokes.length) return { labels: [], signs: [], warnings: [] }
  const ink = buildGroupInk(strokes)
  const earlySignUnits = findSignUnits(strokes, scale)
  // 太小的一团：可能是孤立的 +/− 号。
  if (ink.height < 0.1 * scale && ink.width < 0.1 * scale) {
    return { labels: [], signs: earlySignUnits, warnings: [] }
  }
  // 整组都是电荷号（例如单独写的 +）：只当符号交给上层吸附，绝不解释成元素（避免 + 被当成 i）。
  if (earlySignUnits.length) {
    const signStrokeCount = new Set(earlySignUnits.flatMap(unit => unit.strokes)).size
    if (signStrokeCount === strokes.length) {
      return { labels: [], signs: earlySignUnits, warnings: [] }
    }
  }
  // 单独一条中等长度直线：更可能是键（交给 bond-engine），不当标签。
  if (strokes.length === 1) {
    const only = strokes[0]
    if (only.points.length >= 2 && only.straightness >= 0.82 && only.chord >= 0.24 * scale) {
      return { labels: [], signs: earlySignUnits, warnings: [] }
    }
  }
  // 一笔闭合的直边多边形（三角/四边形/八边形手写环）是键线结构，不是字母。
  if (isStraightEdgedPolygon(ink)) {
    return { labels: [], signs: [], warnings: [] }
  }

  const signUnits = earlySignUnits
  const extruding = findExtrudingStrokes(strokes, scale)
  const variants: StrokeInfo[][] = [[...strokes]]
  if (signUnits.length) {
    const signStrokes = new Set(signUnits.flatMap(unit => unit.strokes))
    variants.push(strokes.filter(stroke => !signStrokes.has(stroke)))
  }
  if (extruding.length) {
    const extrudingSet = new Set(extruding)
    variants.push(strokes.filter(stroke => !extrudingSet.has(stroke)))
  }
  if (signUnits.length && extruding.length) {
    const removed = new Set([...signUnits.flatMap(unit => unit.strokes), ...extruding])
    variants.push(strokes.filter(stroke => !removed.has(stroke)))
  }

  interface VariantResult {
    match: LabelMatch
    usedStrokes: StrokeInfo[]
    strippedSigns: SignUnit[]
    charFallback: boolean
  }
  let best: VariantResult | undefined
  let bestScore = -Infinity
  for (const variant of variants) {
    if (!variant.length) continue
    const variantInk = variant.length === strokes.length && variant.every((stroke, index) => stroke === strokes[index]) ? ink : buildGroupInk(variant)
    if (variantInk.height < 0.1 * scale) continue
    const match = matchLabelInk(variantInk, scale)
    if (!match) continue
    const removedSet = new Set(variant)
    const strippedSigns = signUnits.filter(unit => unit.strokes.every(stroke => !removedSet.has(stroke)))
    const strippedLines = extruding.filter(stroke => !removedSet.has(stroke))
    // 剥离明显独立的电荷号/伸出的短键后若仍然匹配，优先采用（避免把符号并进标签）。
    const variantScore = match.confidence + (strippedSigns.length ? 0.06 : 0) + (strippedLines.length ? 0.02 : 0)
    if (variantScore <= bestScore + 1e-9) continue
    bestScore = variantScore
    best = { match, usedStrokes: variant, strippedSigns, charFallback: false }
  }
  // 字典匹配不可靠时按字符切分回退。
  if (!best || best.match.confidence < 0.72) {
    const fallback = matchCharFallback(ink, scale)
    if (fallback && (!best || fallback.confidence > best.match.confidence + 0.02)) {
      best = { match: fallback, usedStrokes: [...strokes], strippedSigns: [], charFallback: true }
    }
  }
  // 整组匹配很不可靠时，可能是两团文字被误聚在一起：按最大水平间隙拆开重试。
  if (!best || best.match.confidence < 0.45) {
    if (depth < 2 && strokes.length >= 2) {
      const split = splitStrokesByLargestGap(strokes, scale)
      if (split) {
        const left = recognizeGroup(split[0], scale, depth + 1)
        const right = recognizeGroup(split[1], scale, depth + 1)
        const merged = [...left.labels, ...right.labels]
        if (merged.length && merged.every(label => label.confidence >= 0.42)) {
          return { labels: merged, signs: [...left.signs, ...right.signs], warnings: [...left.warnings, ...right.warnings] }
        }
      }
    }
  }
  if (!best) {
    const signs = findSignUnits(strokes, scale)
    if (signs.length) return { labels: [], signs, warnings: [] }
    const glyphLike = strokes.some(stroke => !(stroke.straightness >= 0.85 && stroke.chord >= 0.3 * scale))
    return { labels: [], signs: [], warnings: glyphLike ? [unrecognizedWarning(strokes)] : [] }
  }

  // 圆圈几何：闭合环一律按 O（芳环圆圈与字母 O 都走这里，装配器按尺寸区分）。
  const loop = analyzeLoop(ink.points)
  const smoothLoop = !!loop
    && loop.straightRunRatio < 0.85
    && loop.rmsRatio <= 0.18
    && loop.radialStdRatio <= 0.13
  const allStrokesCurved = strokes.every(stroke => stroke.straightness < 0.8)
  // 闭合直边多边形（六边形/五边形等）是键线结构，绝不能当字母 O 剔除。
  if (loop && loop.closed && loop.radius >= 0.3 * scale
    && (loop.straightRunRatio >= 0.85
      || (loop.radialStdRatio > 0.16 && loop.coverage >= 0.9)
      || (allStrokesCurved && loop.coverage >= 0.9 && loop.cornerPeakCount >= 3))) {
    return { labels: [], signs: [], warnings: [] }
  }
  let shape: DraftLabel['shape'] = 'text'
  const warnings: string[] = []
  if (loop && smoothLoop) {
    const strongest = best.match
    // 高质量闭合平滑圆：一定是字母 O 或芳环记号（装配器按半径区分），无需再比字符模板。
    if (loop.closed && loop.coverage >= 0.8 && loop.rmsRatio <= 0.15 && loop.radialStdRatio <= 0.12 && loop.cornerPeakCount <= 2 && allStrokesCurved) {
      strongest.text = 'O'
      strongest.element = 'O'
      strongest.confidence = Math.max(strongest.confidence, 0.7)
      shape = 'circle'
    } else if (loop.coverage >= 0.88 && loop.closed && (strongest.text === 'C' || strongest.text === 'O')) {
      strongest.text = 'O'
      strongest.element = 'O'
      strongest.confidence = Math.max(strongest.confidence, 0.7)
      shape = 'circle'
    } else if (loop.coverage >= 0.8 && (strongest.text === 'C' || strongest.text === 'O')) {
      strongest.text = 'O'
      strongest.element = 'O'
      strongest.confidence = Math.max(strongest.confidence, 0.62)
      shape = 'circle'
    } else if (strongest.text === 'O' && loop.closed) {
      shape = 'circle'
    }
    if (shape === 'circle' && loop.radius > 1.35 * scale) {
      warnings.push(`检测到直径很大的圆圈（第 ${strokeNumbers(strokes)} 笔），可能不是原子标签，请核对。`)
      strongest.confidence *= 0.72
    }
  }

  // 单笔手画内圈（开口/不规则椭圆）优先认作芳香圆圈 O，避免被读成 Cl/Fe/Ca 或低置信文字。
  if (strokes.length === 1) {
    const handCircle = detectHandDrawnCircle(ink, scale)
    if (handCircle) {
      const matchedText = best.match.text
      const matchedConfidence = best.match.confidence
      const keepSingleLetter = matchedText.length === 1 && matchedText !== 'O' && matchedConfidence >= 0.7
      if (!keepSingleLetter) {
        best.match = {
          text: 'O',
          element: 'O',
          charge: 0,
          confidence: Math.max(handCircle.confidence, matchedText === 'O' ? matchedConfidence : 0),
          raw: best.match.raw,
          alternatives: matchedText === 'O' ? best.match.alternatives : [],
        }
        shape = 'circle'
      }
    }
  }

  let finalMatch = best.match
  let finalStrokes = best.usedStrokes
  if (best.strippedSigns.length === 1) {
    finalMatch = withCharge(finalMatch, best.strippedSigns[0])
    finalStrokes = [...finalStrokes, ...best.strippedSigns[0].strokes]
  }
  const confidence = finalMatch.confidence
  if (confidence < REPORT_CONFIDENCE) {
    const signs = findSignUnits(strokes, scale)
    if (signs.length) return { labels: [], signs, warnings: [] }
    return { labels: [], signs: [], warnings: [unrecognizedWarning(strokes)] }
  }
  // 组内还有未解释的符号笔画：作为孤立符号交给上层吸附。
  const usedSigns = new Set(best.strippedSigns)
  const leftoverSigns = signUnits.filter(unit => !usedSigns.has(unit) && !best!.usedStrokes.includes(unit.strokes[0]))
  const labels = [draftFromMatch(finalMatch, finalStrokes, shape)]
  if (best.charFallback && finalMatch.confidence < 0.8) {
    warnings.push(`手写标签「${finalMatch.text}」是按单个字符拼合识别的，请核对。`)
  }
  return { labels, signs: leftoverSigns, warnings }
}

/* ------------------------------------------------------------------------- *
 * 主入口
 * ------------------------------------------------------------------------- */

function emptyResult(): LabelRecognition {
  return { labels: [], claimedStrokes: [], warnings: [] }
}

export function recognizeAtomLabels(input: GlyphRecognitionInput): LabelRecognition {
  const warnings: string[] = []
  const rawStrokes = input && Array.isArray(input.strokes) ? input.strokes : []
  if (!rawStrokes.length) return emptyResult()

  const settings = input.settings
  const simplifyTolerance = clamp(sanitizeNumber(settings?.simplifyTolerance, 4), 0.5, 20)
  const minBondLength = clamp(sanitizeNumber(settings?.minBondLength, 12), 2, 200)

  const prepared: StrokeInfo[] = []
  for (let index = 0; index < rawStrokes.length && index < 400; index += 1) {
    const raw = rawStrokes[index]
    if (!Array.isArray(raw)) {
      warnings.push(`第 ${index + 1} 笔的数据格式不正确，已跳过。`)
      continue
    }
    const info = buildStrokeInfo(index, raw, simplifyTolerance)
    if (!info) {
      warnings.push(`第 ${index + 1} 笔没有有效坐标，已跳过。`)
      continue
    }
    prepared.push(info)
  }
  if (!prepared.length) return { labels: [], claimedStrokes: [], warnings }

  let scale = sanitizeNumber(input.scale, Number.NaN)
  if (!Number.isFinite(scale) || scale <= 0) {
    scale = estimateScaleFromStrokes(prepared)
    warnings.push(`键长尺度无效，已按笔迹估计为约 ${Math.round(scale)} 像素。`)
  }
  const boundedScale = clamp(scale, 6, 600)

  for (const stroke of prepared) stroke.role = decideStrokeRole(stroke, boundedScale, minBondLength)
  markParallelBondStrokes(prepared, boundedScale)
  // 一笔折返画出的双键/三键（U 形）整体是键线，不能进入文字聚类。
  for (const stroke of prepared) {
    if (stroke.role === 'glyph' && isFoldedBondStroke(stroke, boundedScale)) stroke.role = 'bond'
  }
  // 手画环的“长弯曲边”：跨度很大（弦长 ≥0.85*scale）的开放笔迹是弓形键边；
  // 尺寸明显超过字高的开放笔迹也按键线处理。它们不参与文字聚类，也不产生 warning。
  // 字母笔画弦长通常 ≤0.5*scale，不会误判。
  for (const stroke of prepared) {
    if (stroke.role !== 'glyph' || stroke.closedness <= 0.25) continue
    if (stroke.chord >= 0.85 * boundedScale) {
      stroke.role = 'bond'
      continue
    }
    if (stroke.height >= 1.5 * boundedScale || stroke.width >= 2.5 * boundedScale) stroke.role = 'bond'
  }
  // 一笔闭合的大多边形（六边形/五边形等手写环）留给键线装配器，绝不参与文字聚类。
  for (const stroke of prepared) {
    if (stroke.role !== 'glyph') continue
    if (stroke.closedness > 0.3) continue
    if (boundsDiagonal(stroke.bounds) < 0.9 * boundedScale) continue
    if (isStraightEdgedPolygon(buildGroupInk([stroke]))) stroke.role = 'bond'
  }
  const bondSegments = collectAnchorSegments(prepared, boundedScale)
  const candidateStrokes = prepared.filter(stroke => stroke.role === 'glyph')
  if (!candidateStrokes.length) return { labels: [], claimedStrokes: [], warnings }

  const groups = groupGlyphStrokes(candidateStrokes, boundedScale)
  const draftLabels: DraftLabel[] = []
  const leftoverSigns: SignUnit[] = []
  for (const group of groups) {
    const recognized = recognizeGroup(group, boundedScale, 0)
    draftLabels.push(...recognized.labels)
    leftoverSigns.push(...recognized.signs)
    warnings.push(...recognized.warnings)
  }

  // 孤立的电荷符号：吸附到最近的已识别标签上。
  for (const unit of leftoverSigns) {
    let nearest: DraftLabel | undefined
    let nearestDistance = Infinity
    for (const label of draftLabels) {
      if (label.charge !== 0) continue
      const gap = boundsGap(unit.bounds, label.bounds)
      if (gap <= 0.3 * boundedScale && gap < nearestDistance) {
        nearest = label
        nearestDistance = gap
      }
    }
    if (!nearest) {
      warnings.push(`发现一个孤立的「${unit.sign}」符号（第 ${strokeNumbers(unit.strokes)} 笔），未关联到原子标签，已忽略。`)
      continue
    }
    nearest.charge = unit.sign === '+' ? 1 : -1
    nearest.text = `${nearest.text}${unit.sign}`
    nearest.strokes = sortedUniqueNumbers([...nearest.strokes, ...unit.strokes.map(stroke => stroke.index)])
  }

  // 计算锚点：靠近某条键时优先用该侧边中点，并靠近连接原子字母。
  const labels: AtomLabel[] = draftLabels.map(draft => {
    const anchor = computeAnchor(draft.bounds, bondSegments, boundedScale, labelElementFraction(draft.text))
    const label: AtomLabel = {
      text: draft.text,
      element: draft.element,
      charge: draft.charge,
      confidence: clamp01(draft.confidence),
      bounds: draft.bounds,
      anchor,
      strokes: draft.strokes,
      shape: draft.shape,
      alternatives: draft.alternatives,
    }
    if (label.confidence < CLAIM_CONFIDENCE) {
      warnings.push(`手写标签较潦草，已按「${label.text}」识别（置信度 ${label.confidence.toFixed(2)}），请核对。`)
    }
    return label
  })

  const claimed = new Set<number>()
  for (const label of labels) {
    if (label.confidence >= CLAIM_CONFIDENCE) for (const index of label.strokes) claimed.add(index)
  }

  labels.sort((left, right) => left.strokes[0] - right.strokes[0]
    || left.bounds.minX - right.bounds.minX
    || left.bounds.minY - right.bounds.minY)

  return { labels, claimedStrokes: sortedUniqueNumbers([...claimed]), warnings }
}

/** 标签锚点：默认取连接原子字母附近；若某条键的端点靠近标签某一侧则取该侧边中点。 */
function computeAnchor(box: Bounds, segments: readonly BondSegment[], scale: number, elementFraction: number): HanddrawPoint {
  const center = boundsCenter(box)
  const elementX = box.minX + boundsWidth(box) * elementFraction
  let left = false
  let right = false
  let top = false
  let bottom = false
  const margin = 0.3 * scale
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      if (pointBoundsDistance(end, box) > margin) continue
      if (end.x < box.minX) left = true
      else if (end.x > box.maxX) right = true
      else if (end.y < box.minY) top = true
      else if (end.y > box.maxY) bottom = true
    }
  }
  const sides = [left, right, top, bottom].filter(Boolean).length
  if (sides === 0 || sides > 1) return { x: elementX, y: center.y }
  if (left) return { x: box.minX, y: center.y }
  if (right) return { x: box.maxX, y: center.y }
  if (top) return { x: elementX, y: box.minY }
  return { x: elementX, y: box.maxY }
}
