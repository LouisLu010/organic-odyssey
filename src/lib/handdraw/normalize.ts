import { estimateInkScale } from './bonds'
import { distance } from './geometry'
import type { HanddrawOptions, HanddrawPoint, HanddrawStroke, Settings } from './types'

/**
 * 识别前的笔迹归一化：统一绘画尺寸与采样密度。
 *
 * 识别各阶段有不少以像素计的阈值（拐角窗口、平滑、RDP 容差、吸附距离等），
 * 都是按“键长约 50 像素、采样间距约 3 像素”调出来的。手机上画得小、平板上画得大、
 * 快速划线时采样稀疏，都会让这些阈值失配。这里先估计键长，把整幅绘画等比缩放到
 * 标准键长，再按弧长等距重采样；识别完成后把坐标按同一比例换算回画布像素。
 */

/** 归一化后的目标键长（像素）。 */
export const CANONICAL_BOND_LENGTH = 50
/**
 * 归一化后相邻采样点的弧长间距（像素）。拐角检测的平滑按采样点下标进行，
 * 间距固定后平滑范围（约 ±6 像素）才稳定；实测 3 像素在各种采样密度下最稳。
 */
export const RESAMPLE_SPACING = 3
/** 缩放倍数上下限：超出时只做部分缩放，避免极端输入把噪点放大成键。 */
const MIN_FACTOR = 0.25
const MAX_FACTOR = 4
/** 重采样后的总点数上限，超出时自动放宽间距。 */
const MAX_RESAMPLED_POINTS = 40000

/** 以像素为单位、需要随绘画缩放的识别参数。 */
const PIXEL_OPTIONS = ['snapDistance', 'simplifyTolerance', 'minBondLength', 'parallelDistance'] as const

export interface NormalizedInk {
  strokes: HanddrawStroke[]
  /** 画布坐标 × factor = 归一化坐标。 */
  factor: number
  settings: Settings
}

function clampFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor))
}

/** 按弧长等距重采样一笔，保留首尾点；单点或零长度笔迹原样复制。 */
export function resampleStroke(points: readonly HanddrawPoint[], spacing: number): HanddrawStroke {
  if (points.length < 2) return points.map(point => ({ x: point.x, y: point.y }))
  const result: HanddrawStroke = [{ x: points[0].x, y: points[0].y }]
  // 下一个采样点距离当前线段起点的弧长。
  let next = spacing
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const length = distance(from, to)
    if (!(length > 0)) continue
    while (next <= length) {
      const ratio = next / length
      result.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio })
      next += spacing
    }
    next -= length
  }
  const last = points[points.length - 1]
  const tail = result[result.length - 1]
  // 末尾不足半个间距的余段直接把最后一个采样点挪到真实终点，避免出现极短末段。
  if (result.length > 1 && distance(tail, last) < spacing * 0.5) result[result.length - 1] = { x: last.x, y: last.y }
  else result.push({ x: last.x, y: last.y })
  return result
}

function transform(strokes: readonly (readonly HanddrawPoint[])[], factor: number, spacing: number): HanddrawStroke[] {
  return strokes.map(stroke => resampleStroke(stroke.map(point => ({ x: point.x * factor, y: point.y * factor })), spacing))
}

function totalLength(strokes: readonly (readonly HanddrawPoint[])[]): number {
  let total = 0
  for (const stroke of strokes) for (let index = 1; index < stroke.length; index += 1) total += distance(stroke[index - 1], stroke[index])
  return total
}

/** 估计缩放倍数：先在原始坐标上估计键长，缩放后再复核一次，减少阈值失配带来的偏差。 */
function estimateFactor(strokes: readonly HanddrawStroke[], settings: Settings): number {
  const first = estimateInkScale(strokes, settings)
  if (first === undefined) return 1
  let factor = clampFactor(CANONICAL_BOND_LENGTH / first)
  const refined = estimateInkScale(transform(strokes, factor, RESAMPLE_SPACING), settings)
  if (refined !== undefined) factor = clampFactor(factor * CANONICAL_BOND_LENGTH / refined)
  return factor
}

export function normalizeInk(strokes: readonly HanddrawStroke[], settings: Settings, options: HanddrawOptions): NormalizedInk {
  const factor = estimateFactor(strokes, settings)
  const scaled: Settings = { ...settings, inkScale: factor }
  // 用户显式给出的像素参数按画布像素理解，随绘画一起缩放；默认值本身就是标准尺寸下的取值。
  for (const key of PIXEL_OPTIONS) if (options[key] !== undefined) scaled[key] = settings[key] * factor
  const spacing = Math.max(RESAMPLE_SPACING, (totalLength(strokes) * factor) / MAX_RESAMPLED_POINTS)
  return { strokes: transform(strokes, factor, spacing), factor, settings: scaled }
}
