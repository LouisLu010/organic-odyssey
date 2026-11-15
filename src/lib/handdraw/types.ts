import type { EditorGraph } from '../moleculeEditor'

export interface HanddrawPoint {
  x: number
  y: number
}

export type HanddrawStroke = HanddrawPoint[]

export interface HanddrawOptions {
  snapDistance?: number
  simplifyTolerance?: number
  minBondLength?: number
  parallelDistance?: number
  maxStrokes?: number
  maxPoints?: number
}

/** 解析后的识别参数，所有字段必有值。 */
export type Settings = Required<HanddrawOptions>

export const DEFAULT_SETTINGS: Settings = {
  snapDistance: 11,
  simplifyTolerance: 4,
  minBondLength: 12,
  parallelDistance: 12,
  maxStrokes: 160,
  maxPoints: 20000,
}

/** 轴对齐包围盒，坐标使用画布像素。 */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 一笔手写笔迹，带原始下标，便于笔画归属回溯。 */
export interface IndexedStroke {
  index: number
  points: HanddrawPoint[]
}

/** 从笔迹中切出的一条直线段，代表一根键的一条线。 */
export interface BondLine {
  a: HanddrawPoint
  b: HanddrawPoint
  /** 来源笔迹下标；同一条笔迹可以切出多条线段。 */
  strokeIndex: number
}

/** 多条平行线合并后的化学键。 */
export interface MergedBond {
  a: HanddrawPoint
  b: HanddrawPoint
  /** 键级：1 单键、2 双键、3 三键。 */
  order: number
  /** 组成该键的各条平行线；单键时只有一条。 */
  lines: BondLine[]
}

/** 手写几何分析结果：键线段与键长尺度。 */
export interface InkExtraction {
  /** 估计的键长（画布像素），用于所有尺度相关的阈值。 */
  scale: number
  segments: BondLine[]
  warnings: string[]
}

/** 手写文字笔画按空间聚成的原子标签候选。 */
export interface AtomLabel {
  /** 归一化后的标签文本，例如 'O'、'OH'、'NH2'、'Cl'、'COOH'、'O-'。 */
  text: string
  /** 标签代表的主元素符号。 */
  element: string
  /** 形式电荷。 */
  charge: number
  /** 0～1，越高越可信。 */
  confidence: number
  /** 标签墨迹包围盒。 */
  bounds: Bounds
  /** 键应该连接到的锚点（通常为包围盒中心，或朝键一侧的边缘中点）。 */
  anchor: HanddrawPoint
  /** 该标签用到的原始笔画下标。 */
  strokes: number[]
  /** circle 表示检测到闭合圆环，可能是字母 O 或芳环圆圈。 */
  shape: 'text' | 'circle'
  /** 次优识别结果，用于提示与兜底。 */
  alternatives: { text: string; element: string; charge: number; confidence: number }[]
}

/** 原子标签识别结果。 */
export interface LabelRecognition {
  labels: AtomLabel[]
  /** 已被标签墨迹占用的原始笔画下标；装配时应从键线中剔除。 */
  claimedStrokes: number[]
  warnings: string[]
}

/** assemble 的输入。 */
export interface AssemblyInput {
  strokes: readonly HanddrawStroke[]
  extraction: InkExtraction
  labels: LabelRecognition
  settings: Settings
}

/** assemble 的输出。 */
export interface AssemblyResult {
  graph: EditorGraph
  warnings: string[]
}
