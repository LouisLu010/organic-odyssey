import { describe, expect, it } from 'vitest'
import { recognizeAtomLabels } from './glyphs'
import type { HanddrawPoint, HanddrawStroke, Settings } from './types'

/*
 * 本文件的“手写笔画”全部由本文件自己的生成器独立绘制：
 * 极坐标椭圆、Catmull-Rom 平滑 + 低频手抖、手写比例与笔画顺序都刻意与
 * glyphs.ts 内置的矢量字符模板不同，避免用实现模板自证。
 */

const SETTINGS: Settings = {
  snapDistance: 11,
  simplifyTolerance: 4,
  minBondLength: 12,
  parallelDistance: 12,
  maxStrokes: 160,
  maxPoints: 20000,
}

const SCALE = 60

function recognize(strokes: readonly HanddrawStroke[], scale = SCALE) {
  return recognizeAtomLabels({ strokes, scale, settings: SETTINGS })
}

/* ------------------------------------------------------------------------- *
 * 独立手写生成器
 * ------------------------------------------------------------------------- */

interface LabelOptions {
  scale?: number
  seed?: number
  heightFactor?: number
  gap?: number
  slant?: number
  widthScale?: number
  wobble?: number
  rotation?: number
  reverseStrokeOrder?: boolean
  charge?: '+' | '-'
  trimEnd?: number
  x?: number
  y?: number
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function catmull(control: readonly number[][], samplesPerSegment: number): HanddrawPoint[] {
  const points = control.map(pair => ({ x: pair[0], y: pair[1] }))
  if (points.length < 2) return points
  const result: HanddrawPoint[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[Math.max(0, index - 1)]
    const second = points[index]
    const third = points[index + 1]
    const fourth = points[Math.min(points.length - 1, index + 2)]
    for (let step = 0; step < samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment
      const t2 = t * t
      const t3 = t2 * t
      result.push({
        x: 0.5 * (2 * second.x + (-first.x + third.x) * t + (2 * first.x - 5 * second.x + 4 * third.x - fourth.x) * t2 + (-first.x + 3 * second.x - 3 * third.x + fourth.x) * t3),
        y: 0.5 * (2 * second.y + (-first.y + third.y) * t + (2 * first.y - 5 * second.y + 4 * third.y - fourth.y) * t2 + (-first.y + 3 * second.y - 3 * third.y + fourth.y) * t3),
      })
    }
  }
  const last = points[points.length - 1]
  result.push({ x: last.x, y: last.y })
  return result
}

function polar(cx: number, cy: number, rx: number, ry: number, startDeg: number, endDeg: number, steps: number, wobble: number, rng: () => number): number[][] {
  const closed = Math.abs(endDeg - startDeg) >= 359.5
  const count = closed ? steps : steps + 1
  const phase = rng() * Math.PI * 2
  const points: number[][] = []
  for (let index = 0; index < count; index += 1) {
    const ratio = index / steps
    const angle = ((startDeg + (endDeg - startDeg) * ratio) * Math.PI) / 180
    const radiusScale = 1 + wobble * Math.sin(angle * 2 + phase) + wobble * 0.5 * Math.sin(angle * 3 + phase * 1.7)
    points.push([cx + rx * radiusScale * Math.cos(angle), cy + ry * radiusScale * Math.sin(angle)])
  }
  return points
}

function ellipseControl(cx: number, cy: number, rx: number, ry: number, steps: number, wobble: number, rng: () => number): number[][] {
  return polar(cx, cy, rx, ry, 0, 360, steps, wobble, rng)
}

/** 每个字符 = 若干条笔迹；每条笔迹是控制点数组（会被平滑 + 加手抖）。 */
const HAND_CHARS: Record<string, (rng: () => number) => number[][][]> = {
  C: rng => [[...polar(0.33, 0.5, 0.29, 0.47, 52, 308, 9, 0.05, rng)]],
  O: rng => [[...ellipseControl(0.33, 0.5, 0.29, 0.46, 13, 0.08, rng)]],
  H: () => [
    [[0.12, 0.04], [0.08, 0.35], [0.1, 0.66], [0.13, 0.97]],
    [[0.57, 0.02], [0.55, 0.33], [0.58, 0.65], [0.56, 0.98]],
    [[0.1, 0.54], [0.32, 0.5], [0.56, 0.53]],
  ],
  N: () => [
    [[0.09, 0.97], [0.08, 0.5], [0.1, 0.03]],
    [[0.09, 0.05], [0.3, 0.45], [0.55, 0.94]],
    [[0.55, 0.03], [0.54, 0.5], [0.55, 0.97]],
  ],
  S: () => [[[0.5, 0.07], [0.32, 0.0], [0.14, 0.1], [0.19, 0.29], [0.38, 0.44], [0.46, 0.62], [0.34, 0.9], [0.16, 0.99], [0.05, 0.86]]],
  P: () => [
    [[0.11, 0.97], [0.1, 0.5], [0.12, 0.03]],
    [[0.11, 0.05], [0.32, 0.02], [0.5, 0.1], [0.51, 0.29], [0.32, 0.46], [0.11, 0.5]],
  ],
  F: () => [
    [[0.1, 0.98], [0.09, 0.5], [0.1, 0.02]],
    [[0.09, 0.04], [0.28, 0.03], [0.47, 0.05]],
    [[0.09, 0.48], [0.24, 0.47], [0.4, 0.48]],
  ],
  I: () => [[[0.12, 0.02], [0.1, 0.5], [0.12, 0.98]]],
  B: () => [
    [[0.1, 0.97], [0.09, 0.5], [0.11, 0.03]],
    [[0.1, 0.04], [0.3, 0.02], [0.47, 0.1], [0.47, 0.25], [0.3, 0.42], [0.11, 0.45]],
    [[0.1, 0.47], [0.33, 0.46], [0.51, 0.56], [0.52, 0.75], [0.32, 0.95], [0.1, 0.96]],
  ],
  L: () => [[[0.1, 0.02], [0.09, 0.5], [0.11, 0.98]], [[0.1, 0.97], [0.3, 0.97], [0.47, 0.95]]],
  K: () => [
    [[0.1, 0.98], [0.09, 0.5], [0.1, 0.02]],
    [[0.47, 0.03], [0.31, 0.28], [0.12, 0.52]],
    [[0.17, 0.42], [0.33, 0.68], [0.49, 0.98]],
  ],
  Z: () => [
    [[0.08, 0.04], [0.28, 0.03], [0.47, 0.05]],
    [[0.45, 0.04], [0.25, 0.4], [0.1, 0.72], [0.09, 0.97]],
    [[0.1, 0.96], [0.3, 0.97], [0.48, 0.95]],
  ],
  A: () => [
    [[0.08, 0.98], [0.16, 0.55], [0.28, 0.03]],
    [[0.28, 0.03], [0.4, 0.52], [0.49, 0.98]],
    [[0.15, 0.6], [0.3, 0.58], [0.43, 0.62]],
  ],
  M: () => [[[0.07, 0.98], [0.07, 0.04], [0.28, 0.6], [0.48, 0.03], [0.48, 0.98]]],
  U: () => [[[0.1, 0.03], [0.08, 0.45], [0.12, 0.82], [0.22, 0.98], [0.36, 0.98], [0.46, 0.82], [0.49, 0.45], [0.47, 0.03]]],
  l: () => [[[0.09, 0.02], [0.08, 0.5], [0.12, 0.92], [0.16, 1.0]]],
  r: () => [
    [[0.1, 0.42], [0.09, 0.7], [0.1, 1.0]],
    [[0.1, 0.53], [0.2, 0.43], [0.31, 0.41], [0.36, 0.48]],
  ],
  a: () => [
    [[0.09, 0.55], [0.2, 0.42], [0.36, 0.44], [0.43, 0.6], [0.36, 0.94], [0.24, 1.01], [0.12, 0.92]],
    [[0.43, 0.44], [0.42, 0.72], [0.45, 1.0]],
  ],
  b: rng => [
    [[0.1, 0.02], [0.09, 0.5], [0.11, 0.98]],
    [...polar(0.31, 0.75, 0.19, 0.24, 0, 360, 11, 0.06, rng) as number[][]],
  ],
  h: () => [
    [[0.1, 0.02], [0.09, 0.5], [0.11, 0.99]],
    [[0.1, 0.56], [0.22, 0.41], [0.38, 0.42], [0.44, 0.6], [0.43, 0.99]],
  ],
  n: () => [
    [[0.1, 0.42], [0.09, 0.7], [0.1, 0.99]],
    [[0.1, 0.56], [0.2, 0.42], [0.36, 0.43], [0.42, 0.6], [0.41, 0.99]],
  ],
  o: rng => [[...ellipseControl(0.22, 0.71, 0.18, 0.28, 10, 0.07, rng)]],
  g: rng => [
    [...ellipseControl(0.25, 0.7, 0.18, 0.27, 10, 0.07, rng)],
    [[0.42, 0.56], [0.44, 0.85], [0.42, 1.1], [0.32, 1.22], [0.18, 1.16]],
  ],
  s: () => [[[0.35, 0.46], [0.22, 0.41], [0.11, 0.48], [0.17, 0.6], [0.29, 0.67], [0.34, 0.79], [0.25, 0.94], [0.11, 0.97], [0.05, 0.88]]],
  i: () => [
    [[0.11, 0.42], [0.1, 0.7], [0.11, 0.99]],
    [[0.105, 0.1], [0.11, 0.16]],
  ],
  u: () => [
    [[0.09, 0.42], [0.08, 0.68], [0.1, 0.88]],
    [[0.41, 0.42], [0.4, 0.66], [0.38, 0.85]],
    [[0.09, 0.86], [0.18, 0.99], [0.32, 1.0], [0.41, 0.87]],
  ],
  e: () => [
    [[0.36, 0.66], [0.25, 0.6], [0.12, 0.64], [0.06, 0.78], [0.12, 0.92], [0.24, 1.0], [0.36, 0.92]],
    [[0.06, 0.72], [0.22, 0.7], [0.35, 0.71]],
  ],
  '2': () => [[[0.12, 0.2], [0.2, 0.05], [0.37, 0.02], [0.47, 0.16], [0.4, 0.38], [0.22, 0.62], [0.1, 0.85], [0.09, 0.97], [0.3, 0.97], [0.48, 0.96]]],
  '3': () => [[[0.12, 0.1], [0.28, 0.0], [0.44, 0.08], [0.44, 0.26], [0.3, 0.42], [0.22, 0.47], [0.35, 0.52], [0.47, 0.7], [0.44, 0.88], [0.28, 1.0], [0.11, 0.9]]],
  '4': _rng => [
    [[0.36, 0.03], [0.2, 0.3], [0.07, 0.65]],
    [[0.05, 0.67], [0.25, 0.66], [0.48, 0.68]],
    [[0.37, 0.3], [0.37, 0.65], [0.38, 0.98]],
  ],
  '+': () => [[[0.05, 0.5], [0.25, 0.5], [0.42, 0.51]], [[0.23, 0.33], [0.24, 0.5], [0.23, 0.68]]],
  '-': () => [[[0.06, 0.55], [0.24, 0.54], [0.4, 0.56]]],
}

function wobblePoints(points: readonly HanddrawPoint[], amplitude: number, rng: () => number): HanddrawPoint[] {
  if (!amplitude) return points.map(point => ({ ...point }))
  const phase = rng() * Math.PI * 2
  const frequency = 2.2 + rng() * 3.2
  return points.map((point, index) => ({
    x: point.x + amplitude * (Math.sin(index * frequency + phase) + 0.45 * Math.sin(index * frequency * 2.7 + phase * 1.9)),
    y: point.y + amplitude * (Math.sin(index * frequency * 1.3 + phase * 0.7) + 0.45 * Math.cos(index * frequency * 2.1 + phase * 2.3)),
  }))
}

function drawChar(char: string, options: { rng: () => number; slant?: number; widthScale?: number; wobble?: number }): HanddrawStroke[] {
  const paths = HAND_CHARS[char]
  if (!paths) throw new Error(`missing handwritten char ${char}`)
  return paths(options.rng).map(path => {
    const control = path.length === 1 ? [path[0], path[0]] : path
    const points = wobblePoints(catmull(control, 7), options.wobble ?? 0.022, options.rng)
    return points.map(point => ({
      x: (point.x + (options.slant ?? 0) * (1 - point.y)) * (options.widthScale ?? 1),
      y: point.y,
    }))
  })
}

function parseLabel(label: string): { char: string; subscript: boolean }[] {
  const items: { char: string; subscript: boolean }[] = []
  for (const char of label) items.push({ char, subscript: /[0-9]/.test(char) })
  return items
}

function pointsBounds(points: readonly HanddrawPoint[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { minX, minY, maxX, maxY }
}

function rotatePoints(points: readonly HanddrawPoint[], center: HanddrawPoint, angle: number): HanddrawPoint[] {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return points.map(point => {
    const dx = point.x - center.x
    const dy = point.y - center.y
    return { x: center.x + dx * cosine - dy * sine, y: center.y + dx * sine + dy * cosine }
  })
}

/** 画一个标签，返回像素坐标的笔画数组。 */
function drawLabel(label: string, options: LabelOptions = {}): HanddrawStroke[] {
  const rng = makeRng(options.seed ?? 1)
  const scale = options.scale ?? SCALE
  const height = (options.heightFactor ?? 0.55) * scale
  const gap = options.gap ?? 0.12
  const items = parseLabel(label)
  const strokes: HanddrawStroke[] = []
  let cursor = 0
  for (const item of items) {
    let charStrokes = drawChar(item.char, { rng, slant: options.slant, widthScale: options.widthScale, wobble: options.wobble })
    if (item.subscript) charStrokes = charStrokes.map(stroke => stroke.map(point => ({ x: point.x * 0.62, y: 0.46 + point.y * 0.62 })))
    const box = pointsBounds(charStrokes.flat())
    const shift = cursor - box.minX
    for (const stroke of charStrokes) strokes.push(stroke.map(point => ({ x: point.x + shift, y: point.y })))
    cursor += box.maxX - box.minX + (item.subscript ? gap * 0.55 : gap)
  }
  const box = pointsBounds(strokes.flat())
  const originX = options.x ?? 200
  const originY = options.y ?? 200
  let scaled = strokes.map(stroke => stroke.map(point => ({
    x: originX + (point.x - box.minX) * height,
    y: originY + (point.y - box.minY) * height,
  })))
  const centerX = originX + ((box.maxX - box.minX) * height) / 2
  const centerY = originY + ((box.maxY - box.minY) * height) / 2
  if (options.rotation) scaled = scaled.map(stroke => rotatePoints(stroke, { x: centerX, y: centerY }, options.rotation!))
  let ordered = options.reverseStrokeOrder ? [...scaled].reverse() : scaled
  if (options.charge) {
    const signStrokes = drawChar(options.charge, { rng, wobble: 0.012 })
    const signBox = pointsBounds(signStrokes.flat())
    const signHeight = height * 0.42
    const signX = originX + (box.maxX - box.minX) * height + height * 0.16
    const signY = originY - height * 0.04
    const sign = signStrokes.map(stroke => stroke.map(point => ({
      x: signX + (point.x - signBox.minX) * signHeight,
      y: signY + (point.y - signBox.minY) * signHeight,
    })))
    ordered = [...ordered, ...sign]
  }
  if (options.trimEnd) {
    const last = ordered[ordered.length - 1]
    ordered[ordered.length - 1] = last.slice(0, Math.max(2, Math.round(last.length * (1 - options.trimEnd))))
  }
  return ordered
}

/** 画一条带手抖的直线键线。 */
function drawBond(a: HanddrawPoint, b: HanddrawPoint, options: { seed?: number; wobble?: number; bow?: number } = {}): HanddrawStroke {
  const rng = makeRng(options.seed ?? 5)
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(3, Math.round(length / 6))
  const normalX = -(b.y - a.y) / (length || 1)
  const normalY = (b.x - a.x) / (length || 1)
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps
    const offset = (options.bow ?? 0) * Math.sin(Math.PI * ratio) + (rng() - 0.5) * (options.wobble ?? 0.5)
    return {
      x: a.x + (b.x - a.x) * ratio + normalX * offset,
      y: a.y + (b.y - a.y) * ratio + normalY * offset,
    }
  })
}

/** 一笔闭合多边形（所有顶点由同一笔画画出，手抖沿弧长连续）。 */
function drawClosedPolygon(count: number, center: HanddrawPoint, radius: number, options: { seed?: number; wobble?: number; rotation?: number } = {}): HanddrawStroke {
  const rng = makeRng(options.seed ?? 11)
  const rotation = options.rotation ?? -Math.PI / 2
  const wobble = options.wobble ?? 1
  const phase = rng() * Math.PI * 2
  const vertices = Array.from({ length: count }, (_, index) => {
    const angle = rotation + (index * 2 * Math.PI) / count
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
  })
  const points: HanddrawPoint[] = []
  let along = 0
  for (let edge = 0; edge < count; edge += 1) {
    const a = vertices[edge]
    const b = vertices[(edge + 1) % count]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(2, Math.round(length / 4))
    const normalX = -(b.y - a.y) / length
    const normalY = (b.x - a.x) / length
    for (let step = 0; step < steps; step += 1) {
      const ratio = step / steps
      const offset = wobble * (0.7 * Math.sin((along + ratio * length) * 0.21 + phase) + 0.3 * Math.sin((along + ratio * length) * 0.43 + phase * 1.7))
      points.push({
        x: a.x + (b.x - a.x) * ratio + normalX * offset,
        y: a.y + (b.y - a.y) * ratio + normalY * offset,
      })
    }
    along += length
  }
  points.push({ ...vertices[0] })
  return points
}

/** 沿折线等距采样并叠加手抖，模拟一笔连续画出的折返笔画。 */
function sampledStroke(points: readonly HanddrawPoint[], jitter: number, seed = 7): HanddrawStroke {
  const rng = makeRng(seed)
  const result: HanddrawPoint[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index]
    const b = points[index + 1]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(1, Math.round(length / 4))
    for (let step = 0; step < steps; step += 1) {
      const ratio = step / steps
      result.push({
        x: a.x + (b.x - a.x) * ratio + (rng() - 0.5) * jitter,
        y: a.y + (b.y - a.y) * ratio + (rng() - 0.5) * jitter,
      })
    }
  }
  result.push({ ...points[points.length - 1] })
  return result
}

function transformStrokes(strokes: readonly HanddrawStroke[], factor: number, offset: HanddrawPoint = { x: 0, y: 0 }): HanddrawStroke[] {
  return strokes.map(stroke => stroke.map(point => ({ x: point.x * factor + offset.x, y: point.y * factor + offset.y })))
}

function shiftStrokes(strokes: readonly HanddrawStroke[], dx: number, dy: number): HanddrawStroke[] {
  return strokes.map(stroke => stroke.map(point => ({ x: point.x + dx, y: point.y + dy })))
}

/* ------------------------------------------------------------------------- *
 * 断言助手
 * ------------------------------------------------------------------------- */

function chineseWarningPresent(warnings: readonly string[]): boolean {
  return warnings.some(warning => /[\u4e00-\u9fa5]/.test(warning))
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

/* ------------------------------------------------------------------------- *
 * 一、输入健壮性与确定性
 * ------------------------------------------------------------------------- */

describe('输入健壮性与确定性', () => {
  it('空输入返回空结果，不抛异常', () => {
    expect(recognize([])).toEqual({ labels: [], claimedStrokes: [], warnings: [] })
  })

  it('非法笔画数据只给中文提示，不崩溃', () => {
    const strokes = [
      [{ x: Number.NaN, y: 10 }],
      [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    ] as HanddrawStroke[]
    const result = recognizeAtomLabels({ strokes, scale: SCALE, settings: SETTINGS })
    expect(Array.isArray(result.labels)).toBe(true)
    expect(chineseWarningPresent(result.warnings)).toBe(true)
    const broken = recognizeAtomLabels({ strokes: [null as unknown as HanddrawStroke], scale: SCALE, settings: SETTINGS })
    expect(Array.isArray(broken.labels)).toBe(true)
    expect(chineseWarningPresent(broken.warnings)).toBe(true)
  })

  it('缺失 strokes 字段时返回空结果', () => {
    const result = recognizeAtomLabels({ strokes: undefined as unknown as HanddrawStroke[], scale: SCALE, settings: SETTINGS })
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })

  it('无效 scale 时自行估计并给出中文提示', () => {
    const strokes = drawLabel('O', { seed: 2 })
    for (const scale of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = recognizeAtomLabels({ strokes, scale, settings: SETTINGS })
      expect(Array.isArray(result.labels)).toBe(true)
      expect(result.warnings.some(warning => warning.includes('尺度'))).toBe(true)
    }
  })

  it('纯函数：两次调用结果一致，且不修改输入', () => {
    const strokes = [...drawLabel('NH2', { seed: 7 }), drawBond({ x: 120, y: 320 }, { x: 180, y: 320 }, { seed: 9 })]
    const snapshot = JSON.stringify(strokes)
    const first = recognize(strokes)
    const second = recognize(strokes)
    expect(first).toEqual(second)
    expect(JSON.stringify(strokes)).toBe(snapshot)
  })

  it('对 160 笔、约 2 万采样点保持流畅', () => {
    const densify = (stroke: HanddrawStroke, count: number): HanddrawStroke => {
      const total = stroke.reduce((sum, point, index) => (index === 0 ? sum : sum + Math.hypot(point.x - stroke[index - 1].x, point.y - stroke[index - 1].y)), 0)
      if (!(total > 0)) return Array.from({ length: count }, () => ({ ...stroke[0] }))
      const result: HanddrawPoint[] = []
      let segment = 1
      let segmentStart = 0
      let segmentLength = Math.hypot(stroke[1].x - stroke[0].x, stroke[1].y - stroke[0].y)
      for (let index = 0; index < count; index += 1) {
        const target = (index / (count - 1)) * total
        while (segment < stroke.length - 1 && segmentStart + segmentLength < target) {
          segmentStart += segmentLength
          segment += 1
          segmentLength = Math.hypot(stroke[segment].x - stroke[segment - 1].x, stroke[segment].y - stroke[segment - 1].y)
        }
        const ratio = segmentLength ? (target - segmentStart) / segmentLength : 0
        const from = stroke[Math.max(0, segment - 1)]
        const to = stroke[Math.min(stroke.length - 1, segment)]
        result.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio })
      }
      return result
    }
    const strokes: HanddrawStroke[] = []
    for (let index = 0; index < 20; index += 1) {
      const label = index % 2 === 0 ? 'OH' : 'H'
      strokes.push(...shiftStrokes(drawLabel(label, { seed: 100 + index }), (index % 5) * 150, Math.floor(index / 5) * 130))
    }
    const rng = makeRng(77)
    while (strokes.length < 160) {
      const x = 30 + rng() * 900
      const y = 30 + rng() * 600
      strokes.push([{ x, y }, { x: x + 2 + rng() * 4, y: y + 1 + rng() * 4 }])
    }
    const dense = strokes.map(stroke => densify(stroke, 126))
    const pointCount = dense.reduce((total, stroke) => total + stroke.length, 0)
    expect(dense).toHaveLength(160)
    expect(pointCount).toBeGreaterThanOrEqual(20000)
    const started = Date.now()
    const result = recognize(dense)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(Array.isArray(result.labels)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * 二、单元素标签：印刷、手写、倾斜、加宽、旋转、笔画顺序反转
 * ------------------------------------------------------------------------- */

interface HandwrittenCase {
  label: string
  expected: string
  element: string
  options: LabelOptions
}

const SINGLE_ELEMENT_CASES: HandwrittenCase[] = [
  { label: 'H', expected: 'H', element: 'H', options: { seed: 11, wobble: 0.004 } },
  { label: 'C', expected: 'C', element: 'C', options: { seed: 12, wobble: 0.004 } },
  { label: 'N', expected: 'N', element: 'N', options: { seed: 13, wobble: 0.004 } },
  { label: 'O', expected: 'O', element: 'O', options: { seed: 14, wobble: 0.004 } },
  { label: 'S', expected: 'S', element: 'S', options: { seed: 15, wobble: 0.004 } },
  { label: 'P', expected: 'P', element: 'P', options: { seed: 16, wobble: 0.004 } },
  { label: 'F', expected: 'F', element: 'F', options: { seed: 17, wobble: 0.004 } },
  { label: 'B', expected: 'B', element: 'B', options: { seed: 18, wobble: 0.004 } },
  { label: 'H', expected: 'H', element: 'H', options: { seed: 21, wobble: 0.02, slant: 0.06 } },
  { label: 'N', expected: 'N', element: 'N', options: { seed: 22, wobble: 0.02, slant: 0.1 } },
  { label: 'S', expected: 'S', element: 'S', options: { seed: 23, wobble: 0.018 } },
  { label: 'P', expected: 'P', element: 'P', options: { seed: 24, wobble: 0.018 } },
  { label: 'B', expected: 'B', element: 'B', options: { seed: 25, wobble: 0.018 } },
  { label: 'F', expected: 'F', element: 'F', options: { seed: 26, wobble: 0.018 } },
  { label: 'H', expected: 'H', element: 'H', options: { seed: 27, wobble: 0.02, rotation: 0.15 } },
  { label: 'C', expected: 'C', element: 'C', options: { seed: 28, wobble: 0.02, widthScale: 1.2 } },
  { label: 'O', expected: 'O', element: 'O', options: { seed: 29, wobble: 0.02, rotation: -0.12 } },
  { label: 'N', expected: 'N', element: 'N', options: { seed: 30, wobble: 0.02, reverseStrokeOrder: true } },
  { label: 'H', expected: 'H', element: 'H', options: { seed: 31, wobble: 0.02, reverseStrokeOrder: true } },
  { label: 'O', expected: 'O', element: 'O', options: { seed: 32, wobble: 0.02, heightFactor: 0.4 } },
  { label: 'S', expected: 'S', element: 'S', options: { seed: 33, wobble: 0.02, heightFactor: 0.7 } },
]

describe('单元素标签识别', () => {
  for (const testCase of SINGLE_ELEMENT_CASES) {
    it(`识别 ${testCase.label}（seed=${testCase.options.seed}）`, () => {
      const strokes = drawLabel(testCase.label, testCase.options)
      const result = recognize(strokes)
      expect(result.labels.length).toBeGreaterThanOrEqual(1)
      const top = result.labels[0]
      expect(top.text).toBe(testCase.expected)
      expect(top.element).toBe(testCase.element)
      expect(top.charge).toBe(0)
      expect(top.confidence).toBeGreaterThanOrEqual(0.55)
      expect(['text', 'circle']).toContain(top.shape)
      for (const strokeIndex of top.strokes) expect(result.claimedStrokes).toContain(strokeIndex)
    })
  }
})

/* ------------------------------------------------------------------------- *
 * 三、多字符标签 / 常见基团 / 多笔画字母分组
 * ------------------------------------------------------------------------- */

interface GroupCase {
  label: string
  expected: string
  element: string
  minStrokes: number
}

const GROUP_CASES: GroupCase[] = [
  { label: 'OH', expected: 'OH', element: 'O', minStrokes: 2 },
  { label: 'NH', expected: 'NH', element: 'N', minStrokes: 2 },
  { label: 'NH2', expected: 'NH2', element: 'N', minStrokes: 3 },
  { label: 'CH2', expected: 'CH2', element: 'C', minStrokes: 3 },
  { label: 'CH3', expected: 'CH3', element: 'C', minStrokes: 3 },
  { label: 'COOH', expected: 'COOH', element: 'C', minStrokes: 4 },
  { label: 'CHO', expected: 'CHO', element: 'C', minStrokes: 3 },
  { label: 'CN', expected: 'CN', element: 'C', minStrokes: 2 },
  { label: 'NO2', expected: 'NO2', element: 'N', minStrokes: 3 },
  { label: 'SO3H', expected: 'SO3H', element: 'S', minStrokes: 4 },
  { label: 'SH', expected: 'SH', element: 'S', minStrokes: 1 },
  { label: 'COO', expected: 'COO', element: 'C', minStrokes: 3 },
  { label: 'OMe', expected: 'OMe', element: 'O', minStrokes: 3 },
  { label: 'OCH3', expected: 'OCH3', element: 'O', minStrokes: 3 },
  { label: 'COOMe', expected: 'COOMe', element: 'C', minStrokes: 4 },
]

describe('多字符标签与基团识别', () => {
  for (const testCase of GROUP_CASES) {
    it(`识别 ${testCase.label} 并合并多笔画字母`, () => {
      const strokes = drawLabel(testCase.label, { seed: 200 + testCase.expected.length * 7 + testCase.expected.charCodeAt(0) })
      const result = recognize(strokes)
      expect(result.labels.length).toBe(1)
      const top = result.labels[0]
      expect(top.text).toBe(testCase.expected)
      expect(top.element).toBe(testCase.element)
      expect(top.confidence).toBeGreaterThanOrEqual(0.55)
      expect(top.strokes.length).toBeGreaterThanOrEqual(testCase.minStrokes)
      // 标签笔画全部被认领
      expect(sortedUnique(top.strokes)).toEqual(top.strokes)
      for (const strokeIndex of top.strokes) expect(result.claimedStrokes).toContain(strokeIndex)
      expect(result.claimedStrokes).toEqual(sortedUnique(result.claimedStrokes))
    })
  }

  it('分开写的 H（三笔）必须聚成一个标签', () => {
    const strokes = drawLabel('H', { seed: 77 })
    expect(strokes.length).toBe(3)
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('H')
    expect(result.labels[0].strokes).toHaveLength(3)
    expect(result.claimedStrokes).toEqual([0, 1, 2])
  })

  it('NH2 的 N、H、下标 2 必须聚成一个标签', () => {
    const strokes = drawLabel('NH2', { seed: 35, wobble: 0.02 })
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('NH2')
    expect(result.labels[0].strokes.length).toBeGreaterThanOrEqual(5)
    expect(result.claimedStrokes.sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('SH 的 S 与三笔 H 必须聚成一个标签', () => {
    const strokes = drawLabel('SH', { seed: 42, wobble: 0.02 })
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('SH')
    expect(result.labels[0].strokes).toHaveLength(4)
  })
})

/* ------------------------------------------------------------------------- *
 * 四、形式电荷
 * ------------------------------------------------------------------------- */

describe('形式电荷识别', () => {
  const chargeCases: { label: string; charge: '+' | '-'; expected: string; elements: string; value: number }[] = [
    { label: 'N', charge: '+', expected: 'N+', elements: 'N', value: 1 },
    { label: 'O', charge: '-', expected: 'O-', elements: 'O', value: -1 },
    { label: 'NH', charge: '+', expected: 'NH+', elements: 'N', value: 1 },
    { label: 'COO', charge: '-', expected: 'COO-', elements: 'C', value: -1 },
  ]
  for (const testCase of chargeCases) {
    it(`识别 ${testCase.expected} 并把电荷号笔画并入标签`, () => {
      const strokes = drawLabel(testCase.label, { seed: 300 + testCase.expected.length * 3, charge: testCase.charge })
      const result = recognize(strokes)
      expect(result.labels.length).toBeGreaterThanOrEqual(1)
      const top = result.labels[0]
      expect(top.text).toBe(testCase.expected)
      expect(top.element).toBe(testCase.elements)
      expect(top.charge).toBe(testCase.value)
      expect(top.confidence).toBeGreaterThanOrEqual(0.55)
      expect(result.claimedStrokes.length).toBe(strokes.length)
    })
  }

  it('电荷号使用 ASCII 减号，便于装配器规范化', () => {
    const strokes = drawLabel('O', { seed: 311, charge: '-' })
    const top = recognize(strokes).labels[0]
    expect(top.text).toBe('O-')
    expect(top.text.includes('−')).toBe(false)
  })

  it('孤立的正负号只给中文提示、不生成标签', () => {
    const plus = drawChar('+', { rng: makeRng(41), wobble: 0.01 })
    const strokes = plus.map(stroke => stroke.map(point => ({ x: 120 + point.x * 22, y: 120 + point.y * 22 })))
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
    expect(chineseWarningPresent(result.warnings)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * 五、圆圈：字母 O、开口/椭圆、双弧、芳环内圈
 * ------------------------------------------------------------------------- */

function drawCircle(center: HanddrawPoint, radius: number, options: { seed?: number; wobble?: number; oval?: number; gapDegrees?: number } = {}): HanddrawStroke {
  const rng = makeRng(options.seed ?? 61)
  const phase = rng() * Math.PI * 2
  const oval = options.oval ?? 1
  const gap = ((options.gapDegrees ?? 0) * Math.PI) / 180
  const start = 0.4 + phase * 0.1
  const end = start + Math.PI * 2 - gap
  const steps = 44
  const points: HanddrawPoint[] = []
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + (end - start) * (index / steps)
    const wobble = 1 + (options.wobble ?? 0.025) * Math.sin(angle * 3 + phase) + (options.wobble ?? 0.025) * 0.5 * Math.sin(angle * 2 + phase * 1.7)
    points.push({ x: center.x + radius * oval * wobble * Math.cos(angle), y: center.y + radius * wobble * Math.sin(angle) })
  }
  return points
}

describe('圆圈识别', () => {
  it('手抖圆 / 椭圆 / 轻微开口的 O 都识别为圆', () => {
    const variants = [
      { options: { seed: 71, wobble: 0.03 } },
      { options: { seed: 72, wobble: 0.02, oval: 1.25 } },
      { options: { seed: 73, wobble: 0.02, oval: 0.82 } },
      { options: { seed: 74, wobble: 0.02, gapDegrees: 40 } },
    ]
    for (const variant of variants) {
      const strokes = [drawCircle({ x: 260, y: 240 }, 0.3 * SCALE, variant.options)]
      const result = recognize(strokes)
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0].text).toBe('O')
      expect(result.labels[0].element).toBe('O')
      expect(result.labels[0].shape).toBe('circle')
      expect(result.claimedStrokes).toEqual([0])
    }
  })

  it('两笔圆弧拼成的 O 也能识别', () => {
    const circle = drawCircle({ x: 260, y: 240 }, 0.3 * SCALE, { seed: 75, wobble: 0.02 })
    const middle = Math.floor(circle.length / 2)
    const first = circle.slice(0, middle + 1)
    const second = [...circle.slice(middle - 1)]
    const result = recognize([first, second])
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('O')
    expect(result.labels[0].shape).toBe('circle')
    expect(result.claimedStrokes).toEqual([0, 1])
  })

  it('较大的芳环内圆圈也返回 shape=circle，并保留半径信息', () => {
    const radius = 0.8 * SCALE
    const strokes = [drawCircle({ x: 300, y: 260 }, radius, { seed: 76, wobble: 0.02 })]
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(1)
    const top = result.labels[0]
    expect(top.text).toBe('O')
    expect(top.shape).toBe('circle')
    const halfWidth = (top.bounds.maxX - top.bounds.minX) / 2
    expect(halfWidth).toBeGreaterThan(0.42 * SCALE)
    expect(top.confidence).toBeGreaterThanOrEqual(0.55)
  })

  it('直径过大的圆给出中文提示', () => {
    const strokes = [drawCircle({ x: 300, y: 260 }, 1.5 * SCALE, { seed: 77, wobble: 0.01 })]
    const result = recognize(strokes)
    expect(result.warnings.some(warning => warning.includes('圆圈'))).toBe(true)
  })

  it('多段圆弧组成的开口圆不误判成 C', () => {
    const strokes = [drawCircle({ x: 260, y: 240 }, 0.3 * SCALE, { seed: 78, wobble: 0.02, gapDegrees: 50 })]
    const result = recognize(strokes)
    expect(result.labels[0].text).toBe('O')
  })
})

/* ------------------------------------------------------------------------- *
 * 六、直边多边形环绝不能被认领（P0 回归）
 * ------------------------------------------------------------------------- */

describe('直边多边形环不得被认领', () => {
  for (const count of [3, 4, 5, 6, 8]) {
    it(`一笔闭合 ${count} 边形不产生标签、不 claim 笔画`, () => {
      const strokes = [drawClosedPolygon(count, { x: 320, y: 300 }, 58, { seed: 500 + count, wobble: 1.2 })]
      const result = recognize(strokes)
      expect(result.labels).toHaveLength(0)
      expect(result.claimedStrokes).toHaveLength(0)
    })
  }

  it('干净无噪声的八边形也不得识别为 O', () => {
    const strokes = [drawClosedPolygon(8, { x: 330, y: 300 }, 65, { seed: 509, wobble: 0 })]
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })

  it('一笔闭合六边形 + 内部芳环圆圈：外圈不 claim，内圈识别为 circle', () => {
    const center = { x: 320, y: 300 }
    const hexagon = drawClosedPolygon(6, center, 58, { seed: 701, wobble: 1.1 })
    const circle = drawCircle(center, 27, { seed: 702, wobble: 0.03 })
    const result = recognize([hexagon, circle])
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('O')
    expect(result.labels[0].element).toBe('O')
    expect(result.labels[0].shape).toBe('circle')
    expect(result.labels[0].confidence).toBeGreaterThanOrEqual(0.7)
    expect(result.claimedStrokes).toEqual([1])
  })

  it('分笔绘制（每边一条线）的六边形环线全部不 claim', () => {
    const center = { x: 320, y: 300 }
    const radius = 58
    const vertices = Array.from({ length: 6 }, (_, index) => ({
      x: center.x + radius * Math.cos(-Math.PI / 2 + (index * Math.PI) / 3),
      y: center.y + radius * Math.sin(-Math.PI / 2 + (index * Math.PI) / 3),
    }))
    const strokes: HanddrawStroke[] = []
    for (let index = 0; index < 6; index += 1) strokes.push(drawBond(vertices[index], vertices[(index + 1) % 6], { seed: 600 + index, wobble: 0.6 }))
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------- *
 * 七、键线不得被认领（长键、双键/三键内线、折线链、标签旁的短键）
 * ------------------------------------------------------------------------- */

describe('键线不得被认领', () => {
  it('单根长键线不 claim', () => {
    const strokes = [drawBond({ x: 120, y: 300 }, { x: 190, y: 320 }, { seed: 81, wobble: 0.6 })]
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })

  it('三键的两条内侧短线不 claim（P0 回归）', () => {
    const a = { x: 140, y: 300 }
    const b = { x: 200, y: 320 }
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const ux = (b.x - a.x) / length
    const uy = (b.y - a.y) / length
    const nx = -uy
    const ny = ux
    const inner = (offset: number, shorten: number): HanddrawStroke => drawBond(
      { x: a.x + ux * length * shorten + nx * offset, y: a.y + uy * length * shorten + ny * offset },
      { x: b.x - ux * length * shorten + nx * offset, y: b.y - uy * length * shorten + ny * offset },
      { seed: 800 + offset, wobble: 0.3 },
    )
    const strokes = [drawBond(a, b, { seed: 82, wobble: 0.5 }), inner(7.5, 0.1), inner(-7.5, 0.1)]
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })

  it('双键（主键 + 内侧短线）不 claim', () => {
    const a = { x: 150, y: 240 }
    const b = { x: 210, y: 240 }
    const strokes = [drawBond(a, b, { seed: 83, wobble: 0.4 }), drawBond({ x: 158, y: 232 }, { x: 202, y: 232 }, { seed: 84, wobble: 0.3 })]
    const result = recognize(strokes)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })

  it('一笔画出的折线键链不 claim', () => {
    const chain = [
      { x: 120, y: 300 },
      { x: 165, y: 278 },
      { x: 210, y: 300 },
      { x: 255, y: 278 },
    ]
    const points: HanddrawPoint[] = []
    for (let index = 0; index < chain.length - 1; index += 1) {
      const segment = drawBond(chain[index], chain[index + 1], { seed: 85 + index, wobble: 0.4 })
      points.push(...(index === 0 ? segment : segment.slice(1)))
    }
    const result = recognize([points])
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
  })

  it('靠近标签的短键笔画不并入标签', () => {
    const label = drawLabel('O', { seed: 86, x: 200, y: 200 })
    // O 的包围盒右侧贴一条 0.6*scale 的短键
    const shortBond = drawBond({ x: 224, y: 215 }, { x: 260, y: 220 }, { seed: 87, wobble: 0.3 })
    const result = recognize([label[0], shortBond])
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('O')
    expect(result.claimedStrokes).toEqual([0])
  })
})

/* ------------------------------------------------------------------------- *
 * 七点五、自由绘画：折返笔画整体视为键线（不得产生文字 warning）
 * ------------------------------------------------------------------------- */

describe('折返笔画视为键线（自由绘画）', () => {
  it('一笔折返双键：无标签、无 claim、无 warning', () => {
    const stroke = sampledStroke([
      { x: 300, y: 180 },
      { x: 420, y: 180 },
      { x: 420, y: 196 },
      { x: 300, y: 196 },
    ], 0.5)
    const result = recognize([stroke], 120)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('换算到普通 scale 的折返双键同样安静', () => {
    const scale = 60
    const length = 1.4 * scale
    const spacing = 0.18 * scale
    const stroke = sampledStroke([
      { x: 200, y: 300 },
      { x: 200 + length, y: 300 },
      { x: 200 + length, y: 300 + spacing },
      { x: 200, y: 300 + spacing },
    ], 0.4, 21)
    const result = recognize([stroke], scale)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('一笔折返三键（三条平行长线）也视为键线', () => {
    const stroke = sampledStroke([
      { x: 200, y: 300 },
      { x: 340, y: 300 },
      { x: 340, y: 306 },
      { x: 200, y: 306 },
      { x: 200, y: 312 },
      { x: 340, y: 312 },
    ], 0.4, 23)
    const result = recognize([stroke], 140)
    expect(result.labels).toHaveLength(0)
    expect(result.claimedStrokes).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('单字母 U（一笔）不会被误判成折返键线而静默丢弃', () => {
    const result = recognize(drawLabel('U', { seed: 801, wobble: 0.02 }))
    // 无论 U 被识别成什么（词典里没有 U），都不能像键线一样完全不输出；
    // 要么走文字/低置信提示，要么给出无法识别 warning。
    expect(result.labels.length + result.warnings.length).toBeGreaterThan(0)
    if (result.labels.length === 0) {
      expect(result.claimedStrokes).toHaveLength(0)
      expect(chineseWarningPresent(result.warnings)).toBe(true)
    }
  })

  it('单字母 C / S 仍正常识别为原子标签，不回归', () => {
    for (const [label, seed] of [['C', 802], ['S', 803]] as const) {
      const result = recognize(drawLabel(label, { seed, wobble: 0.02 }))
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0].text).toBe(label)
      expect(result.claimedStrokes.length).toBeGreaterThanOrEqual(1)
      expect(result.warnings).toHaveLength(0)
    }
  })

  it('圆圈仍识别为 O，不因折返检测而回归', () => {
    const circle = drawCircle({ x: 240, y: 240 }, 0.3 * SCALE, { seed: 804, wobble: 0.02 })
    const result = recognize([circle])
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('O')
    expect(result.labels[0].shape).toBe('circle')
    expect(result.claimedStrokes).toEqual([0])
    expect(result.warnings).toHaveLength(0)
  })

  it('潦草涂鸦仍保留中文 warning（不被当成折返键线静默吞掉）', () => {
    const result = recognize(drawScribble(4321))
    expect(result.claimedStrokes).toHaveLength(0)
    expect(chineseWarningPresent(result.warnings)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * 八、分组、尺度与旋转鲁棒性
 * ------------------------------------------------------------------------- */

describe('分组、尺度与旋转鲁棒性', () => {
  it('斜体 NH2 仍然正确', () => {
    const strokes = drawLabel('NH2', { seed: 91, wobble: 0.02, slant: 0.16 })
    expect(recognize(strokes).labels[0].text).toBe('NH2')
  })

  it('OH 旋转 ±0.15 rad 后仍正确', () => {
    for (const rotation of [0.15, -0.15]) {
      const strokes = drawLabel('OH', { seed: 92, wobble: 0.02, rotation })
      const result = recognize(strokes)
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0].text).toBe('OH')
    }
  })

  it('整体缩放 ×0.6 与 ×2（scale 同步缩放）后仍正确', () => {
    for (const factor of [0.6, 2]) {
      const strokes = transformStrokes(drawLabel('COOH', { seed: 93 }), factor)
      const result = recognize(strokes, SCALE * factor)
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0].text).toBe('COOH')
    }
  })

  it('传入 scale 偏小 20% 时仍能正确分组识别（P1 回归）', () => {
    const strokes = drawLabel('NH2', { seed: 94, wobble: 0.02 })
    const result = recognize(strokes, 0.8 * SCALE)
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0].text).toBe('NH2')
  })

  it('两团分开的手写标签不会粘成一个标签', () => {
    const first = drawLabel('O', { seed: 95, x: 120, y: 260 })
    const second = drawLabel('H', { seed: 96, x: 400, y: 260 })
    const result = recognize([...first, ...second])
    expect(result.labels).toHaveLength(2)
    expect(result.labels.map(label => label.text).sort()).toEqual(['H', 'O'])
  })
})

/* ------------------------------------------------------------------------- *
 * 九、置信度、warning 与“潦草涂鸦”
 * ------------------------------------------------------------------------- */

function drawScribble(seed: number): HanddrawStroke[] {
  const rng = makeRng(seed)
  const strokes: HanddrawStroke[] = []
  for (let group = 0; group < 3; group += 1) {
    const points: HanddrawPoint[] = []
    const centerX = 200 + group * 40 + rng() * 20
    const centerY = 260 + rng() * 20
    for (let index = 0; index < 26; index += 1) {
      const angle = index * 1.7 + group
      points.push({
        x: centerX + Math.cos(angle) * (10 + index * 1.6) + (rng() - 0.5) * 12,
        y: centerY + Math.sin(angle * 1.3) * (8 + index * 1.4) + (rng() - 0.5) * 12,
      })
    }
    strokes.push(points)
  }
  return strokes
}

describe('低置信与 warning', () => {
  it('潦草涂鸦不 claim 笔画，并给出中文 warning', () => {
    const strokes = drawScribble(1234)
    const result = recognize(strokes)
    expect(result.claimedStrokes).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(chineseWarningPresent(result.warnings)).toBe(true)
    for (const label of result.labels) expect(label.confidence).toBeLessThan(0.55)
  })

  it('低置信标签仍会返回，但不会出现在 claimedStrokes 中', () => {
    // 极端潦草的 OH：大幅加粗倾斜 + 抖动
    const strokes = drawLabel('OH', { seed: 97, wobble: 0.12, slant: 0.3, widthScale: 1.4 })
    const result = recognize(strokes)
    const lowConfidence = result.labels.filter(label => label.confidence < 0.55)
    for (const label of lowConfidence) {
      for (const strokeIndex of label.strokes) expect(result.claimedStrokes.includes(strokeIndex)).toBe(false)
    }
    if (result.labels.length === 0) {
      expect(chineseWarningPresent(result.warnings)).toBe(true)
    } else if (lowConfidence.length > 0) {
      expect(result.warnings.some(warning => warning.includes('潦草'))).toBe(true)
    }
  })

  it('无法识别的文字状笔画不 claim，并给出中文提示', () => {
    // 星形涂鸦：5 条过中心的短线，字形像文字但又不像任何元素。
    const strokes: HanddrawStroke[] = []
    const center = { x: 240, y: 240 }
    for (let index = 0; index < 5; index += 1) {
      const angle = index * 1.26
      const radius = 14
      strokes.push([
        { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius },
        { x: center.x + Math.cos(angle + 0.4) * radius * 0.4, y: center.y + Math.sin(angle + 0.4) * radius * 0.4 },
        { x: center.x - Math.cos(angle) * radius, y: center.y - Math.sin(angle) * radius },
      ])
    }
    const result = recognize(strokes)
    expect(result.claimedStrokes).toHaveLength(0)
    for (const label of result.labels) expect(label.confidence).toBeLessThan(0.55)
    expect(chineseWarningPresent(result.warnings)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * 十、输出契约：alternatives / anchor / bounds / claimedStrokes
 * ------------------------------------------------------------------------- */

describe('输出契约', () => {
  it('labels/alternatives/anchor/bounds 字段完整且数值合法', () => {
    const strokes = [...drawLabel('OH', { seed: 111 }), drawBond({ x: 190, y: 215 }, { x: 150, y: 215 }, { seed: 112 })]
    const result = recognize(strokes)
    expect(result.labels.length).toBeGreaterThanOrEqual(1)
    for (const label of result.labels) {
      expect(label.confidence).toBeGreaterThanOrEqual(0)
      expect(label.confidence).toBeLessThanOrEqual(1)
      expect(Number.isFinite(label.anchor.x)).toBe(true)
      expect(Number.isFinite(label.anchor.y)).toBe(true)
      expect(Array.isArray(label.strokes)).toBe(true)
      expect(Array.isArray(label.alternatives)).toBe(true)
      for (const alternative of label.alternatives) {
        expect(typeof alternative.text).toBe('string')
        expect(alternative.confidence).toBeGreaterThanOrEqual(0)
        expect(alternative.confidence).toBeLessThanOrEqual(1)
      }
      const box = label.bounds
      expect(box.minX).toBeLessThanOrEqual(box.maxX)
      expect(box.minY).toBeLessThanOrEqual(box.maxY)
      for (const strokeIndex of label.strokes) {
        const stroke = strokes[strokeIndex]
        for (const point of stroke) {
          // 包围盒应覆盖标签笔画的采样点（允许 1px 抖动）
          expect(point.x).toBeGreaterThanOrEqual(box.minX - 1)
          expect(point.x).toBeLessThanOrEqual(box.maxX + 1)
          expect(point.y).toBeGreaterThanOrEqual(box.minY - 1)
          expect(point.y).toBeLessThanOrEqual(box.maxY + 1)
        }
      }
    }
  })

  it('有键从左侧接近时，anchor 落在标签左侧、靠近连接原子', () => {
    const strokes = [...drawLabel('COOH', { seed: 113 }), drawBond({ x: 198, y: 215 }, { x: 128, y: 215 }, { seed: 114 })]
    const result = recognize(strokes)
    const label = result.labels.find(item => item.text === 'COOH')
    expect(label).toBeDefined()
    expect(label!.anchor.x).toBeCloseTo(label!.bounds.minX, 1)
    expect(label!.anchor.y).toBeGreaterThan(label!.bounds.minY)
    expect(label!.anchor.y).toBeLessThan(label!.bounds.maxY)
  })

  it('没有键连接时 anchor 位于连接原子字母附近', () => {
    const strokes = drawLabel('OH', { seed: 115 })
    const result = recognize(strokes)
    const label = result.labels[0]
    expect(label.anchor.x).toBeGreaterThan(label.bounds.minX)
    expect(label.anchor.x).toBeLessThan(label.bounds.maxX)
    expect(label.anchor.y).toBeGreaterThan(label.bounds.minY)
    expect(label.anchor.y).toBeLessThan(label.bounds.maxY)
  })

  it('labels 顺序确定（按首笔下标升序）', () => {
    const strokes = [...drawLabel('O', { seed: 116, x: 120 }), ...drawLabel('H', { seed: 117, x: 420 })]
    const result = recognize(strokes)
    const firstStrokes = result.labels.map(label => label.strokes[0])
    expect(firstStrokes).toEqual([...firstStrokes].sort((left, right) => left - right))
  })

  it('claimedStrokes 去重且升序', () => {
    const strokes = [...drawLabel('O', { seed: 118 }), ...drawLabel('N', { seed: 119, x: 420 })]
    const result = recognize(strokes)
    expect(result.claimedStrokes).toEqual(sortedUnique(result.claimedStrokes))
  })
})

/* ------------------------------------------------------------------------- *
 * 十二、真实手绘潦草苯环（用户图片矢量化数据，来自 /tmp/scribble/strokes5.json）
 *
 * 4 个苯环的“圈内芳香记号”都是开口/不规则/手抖椭圆：glyph 侧必须返回
 * { text: O, shape: circle, confidence>=0.6 } 并 claim；外环长笔迹/弓形边不能
 * claim 成文字，也不能产生“无法识别为原子标签”的 warning 噪声。
 * ------------------------------------------------------------------------- */

const SCRIBBLE_SCALE_DRAWING_0 = 140
const SCRIBBLE_SCALE_DRAWING_3 = 136.7

/** [x, y] 折线点转笔画。 */
function polylineStroke(points: readonly (readonly [number, number])[]): HanddrawStroke {
  return points.map(point => ({ x: point[0], y: point[1] }))
}

/** drawing0 的内圈（开口不规则椭圆）。 */
const INNER_0_3: readonly (readonly [number, number])[] = [[208, 285], [207, 285], [205, 286], [203, 287], [196, 288], [193, 290], [190, 293], [188, 296], [184, 303], [182, 308], [181, 316], [180, 324], [179, 340], [179, 348], [179, 355], [179, 359], [180, 365], [181, 367], [182, 369], [184, 371], [186, 373], [189, 374], [193, 374], [197, 373], [205, 370], [210, 369], [215, 366], [218, 363], [225, 358], [228, 354], [233, 347], [236, 340], [244, 325], [247, 318], [249, 311], [250, 308], [249, 302], [249, 300], [247, 296], [245, 293], [239, 288], [237, 285], [233, 282], [231, 280], [225, 276], [223, 274], [219, 272], [215, 271], [209, 269], [206, 268], [204, 267], [203, 267]]

/** drawing1 的内圈（开口不规则椭圆）。 */
const INNER_1_3: readonly (readonly [number, number])[] = [[676, 268], [675, 268], [674, 269], [671, 271], [666, 274], [663, 276], [661, 279], [659, 282], [658, 287], [657, 291], [656, 297], [655, 304], [655, 316], [655, 323], [656, 328], [657, 331], [661, 333], [663, 335], [666, 335], [669, 335], [675, 334], [679, 332], [684, 329], [690, 324], [702, 315], [707, 310], [713, 304], [716, 300], [720, 293], [722, 289], [724, 285], [725, 282], [725, 275], [725, 272], [724, 269], [723, 266], [719, 263], [717, 261], [715, 259], [712, 257], [709, 256], [706, 255], [702, 254], [699, 253], [691, 251], [687, 251], [682, 250], [677, 251], [667, 251], [663, 252], [660, 252], [659, 252]]

/** drawing2 的内圈（开口不规则椭圆）。 */
const INNER_2_2: readonly (readonly [number, number])[] = [[1226, 328], [1227, 327], [1231, 323], [1235, 319], [1246, 308], [1251, 303], [1255, 298], [1257, 295], [1259, 290], [1260, 288], [1261, 285], [1261, 282], [1261, 279], [1260, 276], [1259, 274], [1257, 271], [1252, 268], [1249, 266], [1244, 264], [1239, 263], [1230, 262], [1225, 261], [1222, 261], [1221, 261]]

/** drawing3 的内圈（开口不规则椭圆）。 */
const INNER_3_2: readonly (readonly [number, number])[] = [[1736, 300], [1737, 300], [1741, 300], [1746, 300], [1757, 299], [1762, 300], [1767, 301], [1770, 302], [1772, 306], [1773, 308], [1773, 311], [1772, 313], [1769, 319], [1766, 322], [1762, 326], [1758, 330], [1748, 339], [1744, 343], [1739, 346], [1736, 349], [1731, 351], [1729, 353], [1726, 354], [1724, 354], [1720, 354], [1718, 354], [1716, 353], [1715, 353], [1713, 351], [1712, 350], [1711, 346], [1711, 341], [1712, 332], [1712, 327], [1713, 322], [1713, 318], [1715, 312], [1716, 309], [1718, 305], [1720, 302], [1723, 296], [1725, 294], [1727, 292], [1727, 291]]

/** drawing0 的外环长笔迹（弓形边/长折线）。 */
const OUTER_0_2: readonly (readonly [number, number])[] = [[86, 419], [87, 419], [90, 420], [93, 420], [101, 422], [105, 423], [110, 424], [113, 426], [118, 428], [123, 432], [133, 440], [143, 450], [167, 472], [177, 481], [186, 489], [189, 492], [192, 492], [194, 492], [199, 488], [205, 484], [216, 473], [224, 466], [234, 456], [243, 446], [262, 426], [270, 416], [275, 406], [276, 400], [275, 392], [275, 383], [277, 367], [280, 347], [289, 306], [292, 287], [295, 274], [296, 269]]

/** drawing3 的外环长笔迹（弓形边/长折线）。 */
const OUTER_3_3: readonly (readonly [number, number])[] = [[1728, 449], [1729, 448], [1733, 447], [1737, 444], [1748, 439], [1754, 435], [1764, 429], [1773, 422], [1790, 409], [1798, 401], [1805, 392], [1808, 385], [1810, 370], [1811, 361], [1812, 348], [1812, 334], [1811, 307], [1811, 295], [1812, 284], [1812, 279], [1813, 276], [1814, 274], [1814, 272], [1814, 272]]

/** drawing1 的外环长笔迹（弓形边/长折线）。 */
const OUTER_1_1: readonly (readonly [number, number])[] = [[578, 224], [577, 225], [574, 227], [571, 230], [562, 237], [558, 240], [554, 242], [551, 243], [548, 244], [546, 243], [545, 243], [545, 241], [546, 238], [550, 232], [561, 218], [576, 199], [609, 160], [624, 141], [638, 125], [645, 118], [652, 111], [656, 108], [661, 106], [664, 105], [670, 104], [672, 104], [674, 104], [675, 104]]

/** drawing0 的全部笔画（真实潦草苯环）。 */
const DRAWING_0_STROKES: HanddrawStroke[] = [
  polylineStroke([[106, 387], [106, 387], [105, 386], [103, 384], [101, 382], [99, 380], [98, 377], [98, 374], [98, 367], [98, 361], [99, 346], [101, 329], [104, 291], [106, 274], [108, 261], [110, 255], [114, 251], [115, 250], [117, 248], [117, 248]]),
  polylineStroke([[106, 230], [107, 229], [109, 227], [111, 224], [118, 218], [121, 214], [124, 209], [126, 205], [130, 198], [133, 193], [138, 186], [144, 179], [156, 166], [163, 158], [169, 150], [175, 142], [183, 130], [188, 123], [193, 117], [196, 114], [203, 108], [205, 106], [207, 105], [208, 104]]),
  polylineStroke([[86, 419], [87, 419], [90, 420], [93, 420], [101, 422], [105, 423], [110, 424], [113, 426], [118, 428], [123, 432], [133, 440], [143, 450], [167, 472], [177, 481], [186, 489], [189, 492], [192, 492], [194, 492], [199, 488], [205, 484], [216, 473], [224, 466], [234, 456], [243, 446], [262, 426], [270, 416], [275, 406], [276, 400], [275, 392], [275, 383], [277, 367], [280, 347], [289, 306], [292, 287], [295, 274], [296, 269]]),
  polylineStroke([[208, 285], [207, 285], [205, 286], [203, 287], [196, 288], [193, 290], [190, 293], [188, 296], [184, 303], [182, 308], [181, 316], [180, 324], [179, 340], [179, 348], [179, 355], [179, 359], [180, 365], [181, 367], [182, 369], [184, 371], [186, 373], [189, 374], [193, 374], [197, 373], [205, 370], [210, 369], [215, 366], [218, 363], [225, 358], [228, 354], [233, 347], [236, 340], [244, 325], [247, 318], [249, 311], [250, 308], [249, 302], [249, 300], [247, 296], [245, 293], [239, 288], [237, 285], [233, 282], [231, 280], [225, 276], [223, 274], [219, 272], [215, 271], [209, 269], [206, 268], [204, 267], [203, 267]]),
  polylineStroke([[284, 259], [284, 259], [284, 258], [283, 256], [282, 253], [281, 250], [277, 246], [273, 240], [265, 230], [260, 222], [254, 210], [249, 199], [239, 174], [234, 162], [229, 150], [225, 141], [217, 127], [214, 121], [212, 117], [211, 115]]),
]

/** drawing3 的全部笔画（真实潦草苯环）。 */
const DRAWING_3_STROKES: HanddrawStroke[] = [
  polylineStroke([[1720, 437], [1719, 436], [1715, 435], [1710, 433], [1699, 428], [1692, 424], [1683, 417], [1674, 409], [1656, 392], [1649, 384], [1643, 378], [1641, 375], [1640, 373], [1640, 372], [1640, 371], [1640, 371]]),
  polylineStroke([[1626, 382], [1626, 382], [1625, 381], [1623, 380], [1621, 379], [1619, 377], [1618, 376], [1618, 374], [1617, 371], [1618, 366], [1620, 353], [1622, 338], [1628, 304], [1631, 287], [1633, 271], [1634, 261], [1634, 246], [1638, 236], [1649, 220], [1664, 203], [1696, 170], [1711, 154], [1724, 140], [1730, 133], [1736, 126], [1739, 123], [1743, 121], [1745, 121], [1751, 122], [1753, 124], [1756, 127], [1759, 130], [1763, 138], [1766, 144], [1769, 155], [1772, 167], [1779, 192], [1782, 205], [1787, 218], [1791, 226], [1799, 238], [1802, 244], [1805, 250], [1806, 253], [1806, 257], [1806, 259], [1805, 262], [1804, 263], [1803, 266], [1802, 267], [1801, 268], [1801, 268]]),
  polylineStroke([[1736, 300], [1737, 300], [1741, 300], [1746, 300], [1757, 299], [1762, 300], [1767, 301], [1770, 302], [1772, 306], [1773, 308], [1773, 311], [1772, 313], [1769, 319], [1766, 322], [1762, 326], [1758, 330], [1748, 339], [1744, 343], [1739, 346], [1736, 349], [1731, 351], [1729, 353], [1726, 354], [1724, 354], [1720, 354], [1718, 354], [1716, 353], [1715, 353], [1713, 351], [1712, 350], [1711, 346], [1711, 341], [1712, 332], [1712, 327], [1713, 322], [1713, 318], [1715, 312], [1716, 309], [1718, 305], [1720, 302], [1723, 296], [1725, 294], [1727, 292], [1727, 291]]),
  polylineStroke([[1728, 449], [1729, 448], [1733, 447], [1737, 444], [1748, 439], [1754, 435], [1764, 429], [1773, 422], [1790, 409], [1798, 401], [1805, 392], [1808, 385], [1810, 370], [1811, 361], [1812, 348], [1812, 334], [1811, 307], [1811, 295], [1812, 284], [1812, 279], [1813, 276], [1814, 274], [1814, 272], [1814, 272]]),
]

describe('真实手绘潦草苯环：开口内圈识别为芳香圆圈', () => {
  for (const entry of [
    { name: 'drawing0 内圈', stroke: INNER_0_3, scale: SCRIBBLE_SCALE_DRAWING_0 },
    { name: 'drawing1 内圈', stroke: INNER_1_3, scale: SCRIBBLE_SCALE_DRAWING_0 },
    { name: 'drawing2 内圈', stroke: INNER_2_2, scale: SCRIBBLE_SCALE_DRAWING_0 },
    { name: 'drawing3 内圈', stroke: INNER_3_2, scale: SCRIBBLE_SCALE_DRAWING_3 },
  ]) {
    it(`${entry.name}单独识别为 O/circle 并 claim` , () => {
      const result = recognize([polylineStroke(entry.stroke)], entry.scale)
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0].text).toBe('O')
      expect(result.labels[0].element).toBe('O')
      expect(result.labels[0].shape).toBe('circle')
      expect(result.labels[0].confidence).toBeGreaterThanOrEqual(0.6)
      expect(result.claimedStrokes).toEqual([0])
      expect(result.warnings).toHaveLength(0)
    })
  }

  for (const entry of [
    { name: 'drawing0 的外环长笔迹', stroke: OUTER_0_2, scale: SCRIBBLE_SCALE_DRAWING_0 },
    { name: 'drawing3 的弓形右边', stroke: OUTER_3_3, scale: SCRIBBLE_SCALE_DRAWING_3 },
    { name: 'drawing1 的长折线边', stroke: OUTER_1_1, scale: SCRIBBLE_SCALE_DRAWING_0 },
  ]) {
    it(`${entry.name}不 claim、不产生 warning` , () => {
      const result = recognize([polylineStroke(entry.stroke)], entry.scale)
      expect(result.labels).toHaveLength(0)
      expect(result.claimedStrokes).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })
  }

  it('drawing0 整体：内圈 O 被 claim，外环长笔迹不 claim 且无文字 warning', () => {
    const result = recognize(DRAWING_0_STROKES, SCRIBBLE_SCALE_DRAWING_0)
    const inner = result.labels.find(label => label.strokes.includes(3))
    expect(inner).toBeDefined()
    expect(inner!.text).toBe('O')
    expect(inner!.shape).toBe('circle')
    expect(inner!.confidence).toBeGreaterThanOrEqual(0.6)
    expect(result.claimedStrokes).toContain(3)
    // 外环长笔迹（含浅折角长边）不能当文字 claim。
    expect(result.claimedStrokes.includes(2)).toBe(false)
    expect(result.warnings.some(warning => warning.includes('无法识别为原子标签'))).toBe(false)
  })

  it('drawing3 整体：内圈 O 被 claim，弓形右边不 claim 且无文字 warning', () => {
    const result = recognize(DRAWING_3_STROKES, SCRIBBLE_SCALE_DRAWING_3)
    const inner = result.labels.find(label => label.strokes.includes(2))
    expect(inner).toBeDefined()
    expect(inner!.text).toBe('O')
    expect(inner!.shape).toBe('circle')
    expect(inner!.confidence).toBeGreaterThanOrEqual(0.6)
    expect(result.claimedStrokes).toContain(2)
    expect(result.claimedStrokes.includes(3)).toBe(false)
    expect(result.warnings.some(warning => warning.includes('无法识别为原子标签'))).toBe(false)
  })
})

/* ------------------------------------------------------------------------- *
 * 十一、自评：≥20 个独立手写标签（印刷体 100%，混合风格 ≥90%）
 * ------------------------------------------------------------------------- */

interface SelfAssessmentCase {
  label: string
  expected: string
  options: LabelOptions
  printed: boolean
}

const SELF_ASSESSMENT_CASES: SelfAssessmentCase[] = [
  { label: 'H', expected: 'H', options: { seed: 1001, wobble: 0.003 }, printed: true },
  { label: 'C', expected: 'C', options: { seed: 1002, wobble: 0.003 }, printed: true },
  { label: 'N', expected: 'N', options: { seed: 1003, wobble: 0.003 }, printed: true },
  { label: 'O', expected: 'O', options: { seed: 1004, wobble: 0.003 }, printed: true },
  { label: 'S', expected: 'S', options: { seed: 1005, wobble: 0.003 }, printed: true },
  { label: 'P', expected: 'P', options: { seed: 1006, wobble: 0.003 }, printed: true },
  { label: 'F', expected: 'F', options: { seed: 1007, wobble: 0.003 }, printed: true },
  { label: 'B', expected: 'B', options: { seed: 1008, wobble: 0.003 }, printed: true },
  { label: 'Cl', expected: 'Cl', options: { seed: 1009, wobble: 0.003 }, printed: true },
  { label: 'OH', expected: 'OH', options: { seed: 1010, wobble: 0.003 }, printed: true },
  { label: 'H', expected: 'H', options: { seed: 1021, wobble: 0.02, slant: 0.08 }, printed: false },
  { label: 'N', expected: 'N', options: { seed: 1022, wobble: 0.02, slant: 0.12 }, printed: false },
  { label: 'O', expected: 'O', options: { seed: 1023, wobble: 0.025 }, printed: false },
  { label: 'C', expected: 'C', options: { seed: 1024, wobble: 0.02, widthScale: 1.2 }, printed: false },
  { label: 'Cl', expected: 'Cl', options: { seed: 1025, wobble: 0.02 }, printed: false },
  { label: 'Br', expected: 'Br', options: { seed: 1026, wobble: 0.02 }, printed: false },
  { label: 'OH', expected: 'OH', options: { seed: 1027, wobble: 0.02 }, printed: false },
  { label: 'NH2', expected: 'NH2', options: { seed: 1028, wobble: 0.02 }, printed: false },
  { label: 'CH3', expected: 'CH3', options: { seed: 1029, wobble: 0.02 }, printed: false },
  { label: 'COOH', expected: 'COOH', options: { seed: 1030, wobble: 0.018 }, printed: false },
  { label: 'CHO', expected: 'CHO', options: { seed: 1031, wobble: 0.018 }, printed: false },
  { label: 'CN', expected: 'CN', options: { seed: 1032, wobble: 0.02 }, printed: false },
  { label: 'NO2', expected: 'NO2', options: { seed: 1033, wobble: 0.02 }, printed: false },
  { label: 'SO3H', expected: 'SO3H', options: { seed: 1034, wobble: 0.018 }, printed: false },
  { label: 'SH', expected: 'SH', options: { seed: 1035, wobble: 0.02 }, printed: false },
  { label: 'OH', expected: 'OH', options: { seed: 1036, wobble: 0.02, rotation: 0.14 }, printed: false },
  { label: 'H', expected: 'H', options: { seed: 1037, wobble: 0.02, reverseStrokeOrder: true }, printed: false },
  { label: 'NH2', expected: 'NH2', options: { seed: 1038, wobble: 0.02, slant: 0.16 }, printed: false },
]

describe('自评：独立手写变体识别准确率', () => {
  it(`混合风格 ${SELF_ASSESSMENT_CASES.length} 个标签准确率 ≥ 90%`, () => {
    const failures: string[] = []
    for (const testCase of SELF_ASSESSMENT_CASES) {
      const strokes = drawLabel(testCase.label, testCase.options)
      const top = recognize(strokes).labels[0]
      if (!top || top.text !== testCase.expected) failures.push(`${testCase.expected}(seed=${testCase.options.seed}) → ${top?.text ?? 'none'}`)
    }
    const accuracy = (SELF_ASSESSMENT_CASES.length - failures.length) / SELF_ASSESSMENT_CASES.length
    expect({ accuracy, failures }).toEqual({ accuracy: 1, failures: [] })
    expect(accuracy).toBeGreaterThanOrEqual(0.9)
  })

  it('清楚的印刷体变体必须 100% 正确', () => {
    const printed = SELF_ASSESSMENT_CASES.filter(testCase => testCase.printed)
    for (const testCase of printed) {
      const strokes = drawLabel(testCase.label, testCase.options)
      const top = recognize(strokes).labels[0]
      expect({ expected: testCase.expected, actual: top?.text }).toEqual({ expected: testCase.expected, actual: testCase.expected })
    }
  })

  it('印刷体标签置信度应明显高于 0.7', () => {
    for (const testCase of SELF_ASSESSMENT_CASES.filter(item => item.printed)) {
      const top = recognize(drawLabel(testCase.label, testCase.options)).labels[0]
      expect(top.confidence).toBeGreaterThanOrEqual(0.7)
    }
  })
})
