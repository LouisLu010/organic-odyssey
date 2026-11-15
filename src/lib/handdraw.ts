import type { EditorGraph } from './moleculeEditor'
import { assembleGraph, graphIsEmpty } from './handdraw/assemble'
import { extractInk } from './handdraw/bonds'
import { HanddrawRecognitionError } from './handdraw/errors'
import { recognizeAtomLabels } from './handdraw/glyphs'
import { normalizeInk } from './handdraw/normalize'
import { DEFAULT_SETTINGS } from './handdraw/types'
import type { HanddrawOptions, HanddrawPoint, HanddrawStroke, Settings } from './handdraw/types'

export { HanddrawRecognitionError } from './handdraw/errors'
export type { HanddrawErrorCode } from './handdraw/errors'
export type { HanddrawOptions, HanddrawPoint, HanddrawStroke } from './handdraw/types'

/** 手绘识别结果：原子与键构成的编辑图，以及需要用户核对的中文提示。 */
export interface HanddrawRecognitionResult {
  graph: EditorGraph
  warnings: string[]
}

const MAX_SEGMENTS = 320

function resolveSettings(options: HanddrawOptions): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...options }
  for (const [key, value] of Object.entries(settings)) {
    if (!Number.isFinite(value) || value <= 0 || ((key === 'maxStrokes' || key === 'maxPoints') && !Number.isInteger(value))) {
      throw new HanddrawRecognitionError('INVALID_INPUT', '识别参数必须是有效的正数，数量上限必须是整数。')
    }
  }
  if (settings.maxStrokes > 512 || settings.maxPoints > 30000) {
    throw new HanddrawRecognitionError('INVALID_INPUT', '识别上限过大，请限制在 512 笔、30000 个采样点以内。')
  }
  return settings
}

/** 校验绘画数据本身，返回总采样点数。 */
function validateStrokes(strokes: readonly (readonly HanddrawPoint[])[], settings: Settings): number {
  if (!Array.isArray(strokes)) throw new HanddrawRecognitionError('INVALID_INPUT', '绘画数据必须是由坐标点组成的列表。')
  if (!strokes.length) throw new HanddrawRecognitionError('EMPTY', '画布还是空的，请先画出键线式结构。')
  if (strokes.length > settings.maxStrokes) throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '绘画内容太多，请减少内容或分次识别。')
  let count = 0
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) throw new HanddrawRecognitionError('INVALID_INPUT', '绘画数据格式不正确，请重新绘制。')
    count += stroke.length
    if (count > settings.maxPoints) throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '采样点太多，请简化绘画或分次识别。')
    for (const point of stroke) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6) {
        throw new HanddrawRecognitionError('INVALID_INPUT', '绘画含有无效或超出范围的坐标，请重新绘制。')
      }
    }
  }
  if (!count) throw new HanddrawRecognitionError('EMPTY', '画布还是空的，请先画出键线式结构。')
  return count
}

/**
 * 识别手写键线式：原子（手写元素符号、常见基团、芳环圆圈）与所有键线。
 *
 * 流程：键线几何分析 → 手写原子标签识别 → 剔除标签墨迹后合并多重键 → 端点吸附与装配。
 * 不识别立体化学（楔形键按普通键处理），不把圆圈当作碳环。
 */
export function recognizeHanddraw(strokes: readonly (readonly HanddrawPoint[])[], options: HanddrawOptions = {}): HanddrawRecognitionResult {
  const resolved = resolveSettings(options)
  validateStrokes(strokes, resolved)
  // 统一绘画尺寸与采样密度后再识别，识别结果按同一比例换算回画布坐标。
  const normalized = normalizeInk(strokes as readonly HanddrawStroke[], resolved, options)
  const ink = normalized.strokes
  const settings = normalized.settings

  const extraction = extractInk(ink, settings)
  if (extraction.segments.length > MAX_SEGMENTS) {
    throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '识别出的线段太多，请减少绘画内容或分次识别。')
  }
  const labels = recognizeAtomLabels({ strokes: ink, scale: extraction.scale, settings, bondStrokes: extraction.ringStrokes })
  const assembly = assembleGraph({ strokes: ink, extraction, labels, settings })
  if (graphIsEmpty(assembly.graph)) {
    const reason = assembly.warnings[0] ?? labels.warnings[0] ?? extraction.warnings[0]
    throw new HanddrawRecognitionError('UNRECOGNIZED', reason ?? '没有识别出原子或化学键，请画清楚直线、折线、环，或手写元素符号。')
  }
  const warnings = [...new Set([...extraction.warnings, ...labels.warnings, ...assembly.warnings])]
  const factor = normalized.factor
  const graph: EditorGraph = factor === 1 ? assembly.graph : {
    atoms: assembly.graph.atoms.map(atom => ({ ...atom, x: atom.x / factor, y: atom.y / factor })),
    bonds: assembly.graph.bonds,
  }
  return { graph, warnings }
}
