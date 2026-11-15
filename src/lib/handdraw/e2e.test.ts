// 手写键线式识别 — 独立端到端验收（verifier 手工夹具，不复用实现者模板）
//
// 本文件由 /tmp/handdraw-demo/gen-e2e.mjs 从独立夹具生成器生成，请勿手工修改。
// 覆盖：乙醇/正丁醇 OH、乙酸 C=O+OH、乙腈三键+N、氯乙烷 Cl、甲胺 NH2、苯/吡啶
// （六边形+内圆圈）、环己烷/环丙烷/环戊烷/环辛烷、乙烯/乙炔、丙酸 COOH、断开片段、
// 自由绘画形态（一笔环+支链不抬笔、环边乱序反向、先写字母后补键、一笔折返双键、
// 同一笔重描环两圈、长链全抬笔分段画、200 笔上限；真实手写分笔画环（六边各一笔、
// 顶点 16–24px 间隙、两笔各 3 边、分笔环+支链），
// 以及用户真实手绘照片矢量化的 4 个潦草苯环（顶点不对齐、边弯曲、内圈开口，原样嵌入），
// T 型支链、醛基 H 标注、N+/O− 电荷，以及字母笔画顺序/形状变体。
// 判据：原子元素与数量、键数、键级多重集、形式电荷、openchemlib IDCode 化学等价、
// 中文 warnings、每笔归属（不静默丢弃）、输入不可变性、入口错误码。
import { describe, expect, it } from 'vitest'
import { Molecule } from 'openchemlib'
import { HanddrawRecognitionError, recognizeHanddraw } from '../handdraw'

// 独立手写风格夹具库（verifier 自写几何，不引用 src/lib/handdraw/glyphs.ts 的模板）
//
// 目标：用“像真人手写”的笔画验证手写键线式识别：带手抖、不同大小/角度/笔画顺序，
// 元素字母（O/H/N/C/l/2/+/−）全部由本文件独立绘制。
//
// 每个夹具：{ id, name, strokes, expected }
//   strokes  = HanddrawStroke[]（点坐标数组，画布像素）
//   expected = {
//     smiles: 期望的规范 SMILES（用 openchemlib IDCode 做化学等价判据）
//     atoms:  元素 -> 个数（目标分子用隐式氢，H 不作为显式原子）
//     bonds:  键数
//     orders: 排序后的键级多重集
//     charges: { positive, negative } 正/负电荷原子个数
//     minWarnings: 期望至少几条 warning（例如断开片段提示）
//     bondLength: 该夹具的手写键线名义长度（像素），供覆盖率/容差使用
//   }
//
// 本文件同时被 Node 校验脚本与 e2e 测试生成器使用，保持无依赖、确定性。


// ---------------- 类型 ----------------

/** 手写点（画布像素）。 */
interface Point { x: number; y: number }
type Stroke = Point[]

interface FixtureExpected {
  /** 期望的规范 SMILES。 */
  smiles: string
  /** 目标分子（隐式氢）的元素 -> 个数。 */
  atoms: Record<string, number>
  bonds: number
  orders: number[]
  charges: { positive: number; negative: number }
  minWarnings: number
  /** 该夹具手写键线的名义长度（像素）。 */
  bondLength: number
}

interface Fixture {
  id: string
  name: string
  strokes: Stroke[]
  expected: FixtureExpected
}

/** 单位字高（1.0）坐标下的字母笔画定义。 */
interface GlyphDef { width: number; strokes: number[][][] }

interface PenStyle { jitter?: number; step?: number; letterJitter?: number; letterStep?: number; bow?: number }
interface LineOptions { trimA?: number; trimB?: number; bow?: number; extendA?: number; extendB?: number }
interface DoubleBondOptions extends LineOptions { offset?: number; side?: number; shortenA?: number; shortenB?: number }
interface TripleBondOptions extends LineOptions { offset?: number; shorten?: number }
interface LabelOptions {
  height?: number
  rotation?: number
  letterJitter?: number
  letterStep?: number
  seed?: number
  italic?: number
  gap?: number
  glyphOverrides?: Record<string, GlyphDef>
}
interface LabelMeasurement { width: number; height: number; items: { char: string; glyph: GlyphDef; scale: number; advance: number }[] }
interface RenderedLabel { strokes: Stroke[]; width: number; height: number; rotation: number }

interface Pen {
  strokes: Stroke[]
  config: Required<PenStyle>
  line(a: Point, b: Point, options?: LineOptions): void
  polyline(points: Point[], options?: { amp?: number; step?: number }): void
  doubleBond(a: Point, b: Point, options?: DoubleBondOptions): void
  tripleBond(a: Point, b: Point, options?: TripleBondOptions): void
  label(text: string, center: Point, options?: LabelOptions): RenderedLabel
  labelBeyond(text: string, bondEnd: Point, direction: Point, options?: LabelOptions): { center: Point; rendered: RenderedLabel }
  ring(vertices: Point[], options?: { close?: boolean; trim?: (index: number) => number; bow?: number }): void
  closedOutline(vertices: Point[]): void
  random(): number
}

const BASE_BOND = 52
const DEFAULT_SEED = 20_260_111

// ---------------- 基础几何 / 随机数 ----------------

function rng(seed: number): () => number {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function normalize(x: number, y: number): Point {
  const length = Math.hypot(x, y)
  return length < 1e-9 ? { x: 0, y: 0 } : { x: x / length, y: y / length }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function roundStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.map(stroke => stroke.map(point => ({ x: round(point.x), y: round(point.y) })))
}

/** 沿折线按弧长采样，并叠加手抖（弧度方向的正弦叠加 + 端部收幅）。 */
function handStroke(points: Point[], { amp = 1.1, step = 3, seed = 1 }: { amp?: number; step?: number; seed?: number } = {}): Point[] {
  const random = rng(seed)
  const phaseA = random() * Math.PI * 2
  const phaseB = random() * Math.PI * 2
  const freqA = 0.16 + random() * 0.15
  const freqB = 0.52 + random() * 0.45
  let total = 0
  for (let index = 1; index < points.length; index += 1) total += dist(points[index - 1], points[index])
  if (total < 1e-6) return [{ x: points[0].x, y: points[0].y }]
  const result: Point[] = []
  let travelled = 0
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const length = dist(a, b)
    if (length < 1e-6) continue
    const ux = (b.x - a.x) / length
    const uy = (b.y - a.y) / length
    const count = Math.max(1, Math.round(length / step))
    for (let stepIndex = 0; stepIndex < count; stepIndex += 1) {
      const ratio = stepIndex / count
      const along = travelled + ratio * length
      const envelope = 0.35 + 0.65 * Math.min(1, along / 8, (total - along) / 8)
      const wobble = amp * envelope * (0.62 * Math.sin(along * freqA + phaseA) + 0.38 * Math.sin(along * freqB + phaseB))
      result.push({
        x: a.x + (b.x - a.x) * ratio - uy * wobble,
        y: a.y + (b.y - a.y) * ratio + ux * wobble,
      })
    }
    travelled += length
  }
  const last = points[points.length - 1]
  result.push({ x: last.x, y: last.y })
  return result
}

function transformStrokes(strokes: Stroke[], { scale = 1, rotate = 0, dx = 0, dy = 0, origin = { x: 0, y: 0 }, reverse = false }: { scale?: number; rotate?: number; dx?: number; dy?: number; origin?: Point; reverse?: boolean } = {}): Stroke[] {
  const cos = Math.cos(rotate)
  const sin = Math.sin(rotate)
  let result = strokes.map(stroke => stroke.map(point => {
    const localX = (point.x - origin.x) * scale
    const localY = (point.y - origin.y) * scale
    return {
      x: origin.x + localX * cos - localY * sin + dx,
      y: origin.y + localX * sin + localY * cos + dy,
    }
  }))
  if (reverse) result = result.slice().reverse().map(stroke => stroke.slice().reverse())
  return result
}

function polygonVertices(count: number, center: Point, radius: number, rotation = -Math.PI / 2): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = rotation + index * 2 * Math.PI / count
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
  })
}

// ---------------- 手写字母（独立几何，单位字高 1，字身中心在原点） ----------------

function ellipseStrokes(rx: number, ry: number, startAngle: number, sweep: number, count = 20): number[][][] {
  const points: number[][] = []
  for (let index = 0; index <= count; index += 1) {
    const angle = startAngle + sweep * index / count
    points.push([rx * Math.cos(angle), ry * Math.sin(angle)])
  }
  return [points]
}

const GLYPHS: Record<string, GlyphDef> = {
  O: { width: 0.64, strokes: ellipseStrokes(0.3, 0.47, 0.35, Math.PI * 1.98, 22) },
  C: { width: 0.62, strokes: ellipseStrokes(0.3, 0.47, 0.85, Math.PI * 2 - 1.7, 16) },
  H: {
    width: 0.66,
    strokes: [
      [[-0.28, -0.5], [-0.28, 0.5]],
      [[0.28, -0.5], [0.28, 0.5]],
      [[-0.31, 0.02], [0.31, 0.02]],
    ],
  },
  N: {
    width: 0.66,
    strokes: [
      [[-0.28, -0.5], [-0.29, 0.5]],
      [[-0.28, -0.5], [0.28, 0.5]],
      [[0.28, -0.5], [0.29, 0.5]],
    ],
  },
  l: { width: 0.26, strokes: [[[-0.03, -0.5], [0.02, 0.32], [0.16, 0.47]]] },
  '2': {
    width: 0.42,
    strokes: [[
      [-0.18, -0.12], [-0.12, -0.28], [0.02, -0.34], [0.16, -0.24], [0.18, -0.1],
      [0.08, 0.08], [-0.18, 0.34], [0.2, 0.34],
    ]],
  },
  '+': { width: 0.34, strokes: [[[-0.15, 0], [0.15, 0]], [[0, 0.15], [0, -0.15]]] },
  S: {
    width: 0.64,
    strokes: [[
      [0.2, -0.36], [0.08, -0.47], [-0.12, -0.45], [-0.24, -0.3], [-0.16, -0.12],
      [0.02, -0.02], [0.2, 0.1], [0.24, 0.28], [0.12, 0.44], [-0.08, 0.47], [-0.24, 0.38],
    ]],
  },
  '-': { width: 0.34, strokes: [[[-0.15, 0], [0.15, 0]]] },
}

const CHAR_GAP_RATIO = 0.1
const SUBSCRIPT_SCALE = 0.58
const CHARGE_SCALE = 0.5

function isSubscript(char: string): boolean {
  return /[0-9]/.test(char)
}

function isChargeSign(char: string): boolean {
  return char === '+' || char === '-'
}

function charScale(char: string): number {
  if (isSubscript(char)) return SUBSCRIPT_SCALE
  if (isChargeSign(char)) return CHARGE_SCALE
  return 1
}

function glyphFor(char: string, overrides: Record<string, GlyphDef> = {}): GlyphDef {
  const glyph = overrides[char] ?? GLYPHS[char]
  if (!glyph) throw new Error(`fixture glyph missing: ${char}`)
  return glyph
}

function measureLabel(text: string, height: number, overrides: Record<string, GlyphDef> = {}): LabelMeasurement {
  const items = []
  let width = 0
  for (const char of text) {
    const glyph = glyphFor(char, overrides)
    const scale = charScale(char)
    const advance = glyph.width * scale * height
    items.push({ char, glyph, scale, advance })
    width += advance
  }
  width += CHAR_GAP_RATIO * height * Math.max(0, items.length - 1)
  return { width, height, items }
}

/** 渲染一个手写标签文本，返回笔画与包围盒。 */
function renderLabelStrokes(text: string, center: Point, { height = 26, rotation = 0, letterJitter = 0.5, letterStep = 1.7, seed = 1, italic = 0.04, glyphOverrides = {} }: LabelOptions = {}): RenderedLabel {
  const measured = measureLabel(text, height, glyphOverrides)
  const gap = CHAR_GAP_RATIO * height
  let cursor = -measured.width / 2
  const rawStrokes: Stroke[] = []
  for (const item of measured.items) {
    const scale = item.scale
    const glyphHeight = scale * height
    const centerX = cursor + item.advance / 2
    let centerY = 0
    if (isSubscript(item.char)) centerY = (0.5 - 0.5 * scale) * height
    else if (isChargeSign(item.char)) centerY = (-0.5 + 0.5 * scale) * height
    for (const stroke of item.glyph.strokes) {
      rawStrokes.push(stroke.map(([unitX, unitY]) => {
        const localX = unitX * glyphHeight
        const localY = unitY * glyphHeight
        return { x: localX - italic * localY, y: localY }
      }).map(point => ({ x: centerX + point.x, y: centerY + point.y })))
    }
    cursor += item.advance + gap
  }
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  let localSeed = seed
  const strokes = rawStrokes.map(stroke => {
    const rotated = stroke.map(point => ({
      x: center.x + point.x * cos - point.y * sin,
      y: center.y + point.x * sin + point.y * cos,
    }))
    localSeed += 1
    return handStroke(rotated, { amp: letterJitter, step: letterStep, seed: localSeed })
  })
  return { strokes, width: measured.width, height, rotation }
}

/** 标签相对某一方向的包围盒半尺寸（用于把键线画到文字边缘）。 */
function labelHalfExtentAlong(rendered: { width: number; height: number; rotation: number }, direction: Point): number {
  const labelAngle = rendered.rotation || 0
  const directionAngle = Math.atan2(direction.y, direction.x)
  const relative = directionAngle - labelAngle
  return Math.abs(Math.cos(relative)) * rendered.width / 2 + Math.abs(Math.sin(relative)) * rendered.height / 2
}

// ---------------- 笔（负责把笔画写进夹具） ----------------

function createPen(seed: number, style: PenStyle = {}): Pen {
  const random = rng(seed)
  const strokes: Stroke[] = []
  const config: Required<PenStyle> = {
    jitter: 1.15,
    step: 3,
    letterJitter: 0.52,
    letterStep: 1.7,
    bow: 0.75,
    ...style,
  }
  let seedCounter = seed % 100_000

  function pushStroke(points: Point[], { amp = config.jitter, step = config.step }: { amp?: number; step?: number } = {}): void {
    seedCounter += 1
    strokes.push(handStroke(points, { amp, step, seed: seed * 7919 + seedCounter * 104_729 }))
  }

  function line(a: Point, b: Point, options: LineOptions = {}): void {
    const { trimA = 0, trimB = 0, bow = config.bow, extendA = 0, extendB = 0 } = options
    const length = dist(a, b)
    if (length < 1e-6) return
    const unit = normalize(b.x - a.x, b.y - a.y)
    const start = { x: a.x + unit.x * (trimA - extendA), y: a.y + unit.y * (trimA - extendA) }
    const end = { x: b.x - unit.x * (trimB - extendB), y: b.y - unit.y * (trimB - extendB) }
    const span = dist(start, end)
    const points = [start]
    if (span > 24 && bow > 0) {
      const bend = (random() - 0.5) * 2 * bow
      points.push({ x: (start.x + end.x) / 2 - unit.y * bend, y: (start.y + end.y) / 2 + unit.x * bend })
    }
    points.push(end)
    pushStroke(points)
  }

  function polyline(points: Point[], options: { amp?: number; step?: number } = {}): void {
    if (points.length < 2) return
    pushStroke(points, options)
  }

  function doubleBond(a: Point, b: Point, options: DoubleBondOptions = {}): void {
    const { offset = 8, side = 1, trimA = 0, trimB = 0, shortenA = 0.14, shortenB = 0.16 } = options
    line(a, b, { trimA, trimB })
    const length = dist(a, b)
    const unit = normalize(b.x - a.x, b.y - a.y)
    const offsetX = -unit.y * side * offset
    const offsetY = unit.x * side * offset
    const start = {
      x: a.x + unit.x * (trimA + length * shortenA) + offsetX,
      y: a.y + unit.y * (trimA + length * shortenA) + offsetY,
    }
    const end = {
      x: b.x - unit.x * (trimB + length * shortenB) + offsetX,
      y: b.y - unit.y * (trimB + length * shortenB) + offsetY,
    }
    pushStroke([start, end], { amp: config.jitter * 0.8 })
  }

  function tripleBond(a: Point, b: Point, options: TripleBondOptions = {}): void {
    const { offset = 7.5, trimA = 0, trimB = 0, shorten = 0.12 } = options
    const length = dist(a, b)
    const unit = normalize(b.x - a.x, b.y - a.y)
    line(a, b, { trimA, trimB })
    for (const side of [-1, 1]) {
      const offsetX = -unit.y * side * offset
      const offsetY = unit.x * side * offset
      const start = {
        x: a.x + unit.x * (trimA + length * shorten) + offsetX,
        y: a.y + unit.y * (trimA + length * shorten) + offsetY,
      }
      const end = {
        x: b.x - unit.x * (trimB + length * shorten) + offsetX,
        y: b.y - unit.y * (trimB + length * shorten) + offsetY,
      }
      pushStroke([start, end], { amp: config.jitter * 0.75 })
    }
  }

  function label(text: string, center: Point, options: LabelOptions = {}): RenderedLabel {
    const rendered = renderLabelStrokes(text, center, {
      height: options.height ?? 0.5 * BASE_BOND,
      rotation: options.rotation ?? 0,
      letterJitter: options.letterJitter ?? config.letterJitter,
      letterStep: options.letterStep ?? config.letterStep,
      seed: options.seed ?? seed * 31 + seedCounter,
      italic: options.italic ?? 0.04,
    })
    strokes.push(...rendered.strokes)
    return rendered
  }

  /** 在 bondEnd 之外写一个标签：键端 = 文字左/下边缘，符合真人“画到字边”的习惯。 */
  function labelBeyond(text: string, bondEnd: Point, direction: Point, options: LabelOptions = {}): { center: Point; rendered: RenderedLabel } {
    const height = options.height ?? 0.48 * BASE_BOND
    const rotation = options.rotation ?? 0
    const directionUnit = normalize(direction.x, direction.y)
    const measured = measureLabel(text, height, options.glyphOverrides)
    const probe = { width: measured.width, height, rotation }
    const extent = labelHalfExtentAlong(probe, directionUnit)
    const gap = options.gap ?? 2
    const center = {
      x: bondEnd.x + directionUnit.x * (extent + gap),
      y: bondEnd.y + directionUnit.y * (extent + gap),
    }
    const rendered = label(text, center, { ...options, height, rotation })
    return { center, rendered }
  }

  function ring(vertices: Point[], options: { close?: boolean; trim?: (index: number) => number; bow?: number } = {}): void {
    const { close = true, trim = () => 0 } = options
    for (let index = 0; index < vertices.length; index += 1) {
      if (index === vertices.length - 1 && !close) break
      const a = vertices[index]
      const b = vertices[(index + 1) % vertices.length]
      line(a, b, { trimA: trim(index), trimB: trim((index + 1) % vertices.length), bow: options.bow ?? config.bow })
    }
  }

  function closedOutline(vertices: Point[]): void {
    pushStroke([...vertices, vertices[0]])
  }

  return { strokes, config, line, polyline, doubleBond, tripleBond, label, labelBeyond, ring, closedOutline, random }
}

// ---------------- 夹具定义 ----------------

const ZIG = { dx: 48, dy: 22 }
const ZIG_LENGTH = Math.hypot(ZIG.dx, ZIG.dy)

function zigzag(start: Point, count: number, options: { dx?: number; dy?: number; flip?: number } = {}): Point[] {
  const { dx = ZIG.dx, dy = ZIG.dy, flip = 1 } = options
  const vertices = [{ x: start.x, y: start.y }]
  for (let index = 1; index <= count; index += 1) {
    vertices.push({
      x: vertices[index - 1].x + dx,
      y: vertices[index - 1].y + (index % 2 === 1 ? -dy : dy) * flip,
    })
  }
  return vertices
}

function fixtureEthanol() {
  const pen = createPen(11)
  const chain = zigzag({ x: 90, y: 300 }, 2)
  pen.line(chain[0], chain[1])
  const labelHeight = 0.48 * BASE_BOND
  const bondEnd = { x: chain[1].x + 48, y: chain[1].y - 22 }
  pen.line(chain[1], bondEnd)
  pen.labelBeyond('OH', bondEnd, { x: 48, y: -22 }, { height: labelHeight, rotation: 0.04 })
  return {
    id: 'ethanol-oh',
    name: '乙醇：C-C 链末端手写 OH',
    strokes: pen.strokes,
    expected: { smiles: 'CCO', atoms: { C: 2, O: 1 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureButanol() {
  // 笔画顺序与书写方向都与常规相反：先写 OH，再从右往左画碳链
  const pen = createPen(12)
  const chain = zigzag({ x: 80, y: 320 }, 3, { flip: 1 })
  // chain[3] 为末端；OH 在 chain[3] 右侧下方
  const direction = { x: 48, y: 22 }
  const bondEnd = { x: chain[3].x + 48, y: chain[3].y + 22 }
  const labelHeight = 0.46 * BASE_BOND
  pen.labelBeyond('OH', bondEnd, direction, { height: labelHeight, rotation: -0.05 })
  pen.line(chain[3], bondEnd)
  pen.line(chain[2], chain[3])
  pen.line(chain[1], chain[2])
  pen.line(chain[0], chain[1])
  return {
    id: 'butanol-oh-reversed',
    name: '正丁醇：反序、反向书写，末端 OH',
    strokes: pen.strokes,
    expected: { smiles: 'CCCCO', atoms: { C: 4, O: 1 }, bonds: 4, orders: [1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureAceticAcid() {
  const pen = createPen(13)
  const c1 = { x: 100, y: 330 }
  const c2 = { x: 152, y: 308 }
  pen.line(c1, c2)
  // C=O：从 c2 斜向上画双键，末端写 O
  const carbonylEnd = { x: c2.x + 10, y: c2.y - 48 }
  pen.doubleBond(c2, carbonylEnd, { offset: 7.5, side: -1, shortenA: 0.16, shortenB: 0.2 })
  pen.labelBeyond('O', carbonylEnd, { x: 10, y: -48 }, { height: 0.5 * BASE_BOND, rotation: 0.08 })
  // C-OH：从 c2 向右画单键，末端写 OH
  const hydroxylEnd = { x: c2.x + 52, y: c2.y + 4 }
  pen.line(c2, hydroxylEnd)
  pen.labelBeyond('OH', hydroxylEnd, { x: 52, y: 4 }, { height: 0.48 * BASE_BOND, rotation: -0.03 })
  return {
    id: 'acetic-acid',
    name: '乙酸：C=O 与手写 OH 同现',
    strokes: pen.strokes,
    expected: { smiles: 'CC(=O)O', atoms: { C: 2, O: 2 }, bonds: 3, orders: [1, 1, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureAcetonitrile() {
  const pen = createPen(14)
  const c1 = { x: 100, y: 300 }
  const c2 = { x: 152, y: 278 }
  pen.line(c1, c2)
  const direction = { x: 52, y: -22 }
  const tripleEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.tripleBond(c2, tripleEnd, { offset: 7, shorten: 0.14 })
  pen.labelBeyond('N', tripleEnd, direction, { height: 0.52 * BASE_BOND, rotation: 0.06, letterJitter: 0.6 })
  return {
    id: 'acetonitrile',
    name: '乙腈：三键 + 手写 N 字母',
    strokes: pen.strokes,
    expected: { smiles: 'CC#N', atoms: { C: 2, N: 1 }, bonds: 2, orders: [1, 3], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureChloroethane() {
  const pen = createPen(15)
  const c1 = { x: 94, y: 300 }
  const c2 = { x: 146, y: 278 }
  pen.line(c1, c2)
  const direction = { x: 50, y: 12 }
  const bondEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.line(c2, bondEnd)
  pen.labelBeyond('Cl', bondEnd, direction, { height: 0.5 * BASE_BOND, rotation: 0.03, letterJitter: 0.45 })
  return {
    id: 'chloroethane',
    name: '氯乙烷：手写 Cl 标签',
    strokes: pen.strokes,
    expected: { smiles: 'CCCl', atoms: { C: 2, Cl: 1 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureMethylamine() {
  const pen = createPen(16)
  const carbon = { x: 110, y: 300 }
  const direction = { x: 52, y: -8 }
  const bondEnd = { x: carbon.x + direction.x, y: carbon.y + direction.y }
  pen.line(carbon, bondEnd)
  pen.labelBeyond('NH2', bondEnd, direction, { height: 0.46 * BASE_BOND, rotation: 0.05 })
  return {
    id: 'methylamine-nh2',
    name: '甲胺：手写 NH2（多笔画 H + 下标 2）',
    strokes: pen.strokes,
    expected: { smiles: 'CN', atoms: { C: 1, N: 1 }, bonds: 1, orders: [1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND * 0.9 },
  }
}

function fixtureBenzene() {
  const pen = createPen(17)
  const center = { x: 320, y: 290 }
  const radius = 58
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2 + 0.08)
  pen.closedOutline(vertices)
  const circleRadius = 27
  const circle: Point[] = []
  for (let index = 0; index <= 26; index += 1) {
    const angle = 0.5 + index / 26 * Math.PI * 2.02
    const wobble = 1 + 0.035 * Math.sin(index * 1.7)
    circle.push({ x: center.x + circleRadius * wobble * Math.cos(angle), y: center.y + circleRadius * 0.94 * Math.sin(angle) })
  }
  pen.polyline(circle)
  return {
    id: 'benzene',
    name: '苯：六边形一笔 + 内圆圈（芳环标注）',
    strokes: pen.strokes,
    expected: { smiles: 'C1=CC=CC=C1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 2, 2, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixturePyridine() {
  const pen = createPen(18)
  const center = { x: 330, y: 285 }
  const radius = 58
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2)
  const nitrogenIndex = 0
  const labelHeight = 0.46 * BASE_BOND
  // 先写环上 N 标签（环顶点位置），再画分笔六边形；与 N 相邻的两根键收到字边
  const nRendered = pen.label('N', vertices[nitrogenIndex], { height: labelHeight, rotation: 0.04 })
  const halfExtent = labelHalfExtentAlong(nRendered, normalize(vertices[1].x - vertices[0].x, vertices[1].y - vertices[0].y))
  for (let index = 0; index < 6; index += 1) {
    const a = vertices[index]
    const b = vertices[(index + 1) % 6]
    const trimA = index === nitrogenIndex ? halfExtent : 0
    const trimB = (index + 1) % 6 === nitrogenIndex ? labelHalfExtentAlong(nRendered, normalize(b.x - a.x, b.y - a.y)) + 1 : 0
    pen.line(a, b, { trimA, trimB })
  }
  // 芳香内圆圈
  const circle: Point[] = []
  for (let index = 0; index <= 24; index += 1) {
    const angle = 1.1 + index / 24 * Math.PI * 2
    circle.push({ x: center.x + 26 * Math.cos(angle), y: center.y + 26 * 0.95 * Math.sin(angle) })
  }
  pen.polyline(circle)
  return {
    id: 'pyridine',
    name: '吡啶：环上手写 N + 内圆圈',
    strokes: pen.strokes,
    expected: { smiles: 'C1=CC=NC=C1', atoms: { C: 5, N: 1 }, bonds: 6, orders: [1, 1, 1, 2, 2, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureCyclohexane() {
  const pen = createPen(19)
  const center = { x: 320, y: 290 }
  const radius = 58
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2 + 0.15)
  // 分两笔：0-1-2-3 与 3-4-5-0，接缝处轻微重叠
  pen.polyline([vertices[0], vertices[1], vertices[2], vertices[3]])
  pen.polyline([vertices[3], vertices[4], vertices[5], vertices[0]])
  return {
    id: 'cyclohexane-split',
    name: '环己烷：两笔拼接的六边形（无圆圈）',
    strokes: pen.strokes,
    expected: { smiles: 'C1CCCCC1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureEthene() {
  const pen = createPen(20)
  const a = { x: 180, y: 290 }
  const direction = { x: 96, y: -12 }
  const b = { x: a.x + direction.x, y: a.y + direction.y }
  pen.doubleBond(a, b, { offset: 9, side: 1, shortenA: 0.1, shortenB: 0.22 })
  return {
    id: 'ethene',
    name: '乙烯：手绘双平行线',
    strokes: pen.strokes,
    expected: { smiles: 'C=C', atoms: { C: 2 }, bonds: 1, orders: [2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: Math.hypot(direction.x, direction.y) },
  }
}

function fixtureEthyne() {
  const pen = createPen(21)
  const a = { x: 180, y: 300 }
  const direction = { x: 104, y: -8 }
  const b = { x: a.x + direction.x, y: a.y + direction.y }
  pen.tripleBond(a, b, { offset: 8, shorten: 0.1 })
  return {
    id: 'ethyne',
    name: '乙炔：手绘三平行线',
    strokes: pen.strokes,
    expected: { smiles: 'C#C', atoms: { C: 2 }, bonds: 1, orders: [3], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: Math.hypot(direction.x, direction.y) },
  }
}

function fixturePropionicAcid() {
  // 丙酸 CH3-CH2-COOH：链上 2 个碳 + 末端 COOH 标签（标签里的 C 是羧基碳）
  const pen = createPen(22)
  const chain = zigzag({ x: 104, y: 322 }, 1, { flip: -1 })
  pen.line(chain[0], chain[1])
  const direction = { x: 50, y: -24 }
  const bondEnd = { x: chain[1].x + direction.x, y: chain[1].y + direction.y }
  pen.line(chain[1], bondEnd)
  pen.labelBeyond('COOH', bondEnd, direction, { height: 0.42 * BASE_BOND, rotation: 0.02, letterJitter: 0.45, letterStep: 1.5 })
  return {
    id: 'propionic-acid-cooh',
    name: '丙酸：末端手写 COOH 基团标签',
    strokes: pen.strokes,
    expected: { smiles: 'CCC(=O)O', atoms: { C: 3, O: 2 }, bonds: 4, orders: [1, 1, 1, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureTwoFragments() {
  const pen = createPen(23)
  // 左：乙烷单键
  pen.line({ x: 110, y: 300 }, { x: 166, y: 282 })
  // 右：乙烯双键，与左侧明显断开（远大于吸附半径）
  const a = { x: 380, y: 310 }
  const b = { x: 380 + 92, y: 310 - 16 }
  pen.doubleBond(a, b, { offset: 9, side: -1, shortenA: 0.12, shortenB: 0.18 })
  return {
    id: 'two-fragments',
    name: '两个断开片段：乙烷 + 乙烯',
    strokes: pen.strokes,
    expected: { smiles: 'CC.C=C', atoms: { C: 4 }, bonds: 2, orders: [1, 2], charges: { positive: 0, negative: 0 }, minWarnings: 1, bondLength: 62 },
  }
}

function fixtureTBranch() {
  const pen = createPen(24)
  const left = { x: 130, y: 300 }
  const right = { x: 130 + 2 * 52, y: 300 }
  const middle = { x: (left.x + right.x) / 2, y: 300 }
  // 一笔画穿整条水平主链；支链端点略压到主链中点（T 型）
  pen.polyline([left, right])
  pen.line({ x: middle.x + 1, y: middle.y - 62 }, { x: middle.x + 3, y: middle.y + 2 })
  return {
    id: 't-branch-isobutane',
    name: 'T 型支链：异丁烷（支链端点落在主链中段）',
    strokes: pen.strokes,
    expected: { smiles: 'CC(C)C', atoms: { C: 4 }, bonds: 3, orders: [1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: 52 },
  }
}

function fixtureAldehydeH() {
  const pen = createPen(25)
  const c1 = { x: 120, y: 320 }
  const c2 = { x: 172, y: 298 }
  pen.line(c1, c2)
  const direction = { x: 18, y: -50 }
  const carbonylEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.doubleBond(c2, carbonylEnd, { offset: 7, side: 1, shortenA: 0.16, shortenB: 0.2 })
  pen.labelBeyond('O', carbonylEnd, direction, { height: 0.5 * BASE_BOND, rotation: 0.03 })
  // H 标注：在羰基碳左侧写 H，不画键（代表隐式氢）
  pen.label('H', { x: c2.x - 34, y: c2.y - 8 }, { height: 0.44 * BASE_BOND, rotation: -0.05 })
  return {
    id: 'aldehyde-h',
    name: '乙醛：C=O + 手写 H 标注（H 不成为显式原子）',
    strokes: pen.strokes,
    expected: { smiles: 'CC=O', atoms: { C: 2, O: 1 }, bonds: 2, orders: [1, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureTetramethylammonium() {
  const pen = createPen(26)
  const center = { x: 320, y: 300 }
  const labelHeight = 0.44 * BASE_BOND
  const nRendered = pen.label('N+', center, { height: labelHeight, rotation: 0.02 })
  const innerRadius = Math.max(nRendered.width / 2, labelHeight / 2) + 6
  for (const angle of [-Math.PI * 0.75, -Math.PI * 0.25, Math.PI * 0.75, Math.PI * 0.25]) {
    const unit = { x: Math.cos(angle), y: Math.sin(angle) }
    const start = { x: center.x + unit.x * innerRadius, y: center.y + unit.y * innerRadius }
    const end = { x: center.x + unit.x * (innerRadius + 54), y: center.y + unit.y * (innerRadius + 54) }
    pen.line(start, end)
  }
  return {
    id: 'tetramethylammonium',
    name: '四甲铵阳离子：中心手写 N+（正电荷）',
    strokes: pen.strokes,
    expected: { smiles: 'C[N+](C)(C)C', atoms: { C: 4, N: 1 }, bonds: 4, orders: [1, 1, 1, 1], charges: { positive: 1, negative: 0 }, minWarnings: 0, bondLength: 54 },
  }
}

function fixtureAcetate() {
  const pen = createPen(27)
  const c1 = { x: 100, y: 330 }
  const c2 = { x: 152, y: 308 }
  pen.line(c1, c2)
  const carbonylEnd = { x: c2.x + 8, y: c2.y - 50 }
  pen.doubleBond(c2, carbonylEnd, { offset: 7, side: -1, shortenA: 0.16, shortenB: 0.2 })
  pen.labelBeyond('O', carbonylEnd, { x: 8, y: -50 }, { height: 0.48 * BASE_BOND, rotation: 0.04 })
  const direction = { x: 52, y: 6 }
  const singleEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.line(c2, singleEnd)
  pen.labelBeyond('O-', singleEnd, direction, { height: 0.46 * BASE_BOND, rotation: -0.04 })
  return {
    id: 'acetate-o-minus',
    name: '乙酸根：手写 O-（负电荷）',
    strokes: pen.strokes,
    expected: { smiles: 'CC(=O)[O-]', atoms: { C: 2, O: 2 }, bonds: 3, orders: [1, 1, 2], charges: { positive: 0, negative: 1 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

// ---------------- 尺寸 / 角度 / 笔画顺序变体 ----------------

function variantEthanolRotated() {
  const base = fixtureEthanol()
  const origin = { x: 200, y: 270 }
  const strokes = roundStrokes(transformStrokes(base.strokes, { scale: 0.82, rotate: -0.22, origin, reverse: true }))
  return {
    ...base,
    id: 'ethanol-oh-rotated',
    name: '乙醇变体：整体旋转 −12.6°、缩小 ×0.82、反序反向',
    strokes,
    expected: { ...base.expected, bondLength: BASE_BOND * 0.82 },
  }
}

function variantEthanolLarge() {
  const base = fixtureEthanol()
  const origin = { x: 190, y: 280 }
  const strokes = roundStrokes(transformStrokes(base.strokes, { scale: 1.24, rotate: 0.09, origin }))
  return {
    ...base,
    id: 'ethanol-oh-large',
    name: '乙醇变体：放大 ×1.24、旋转 +5.2°',
    strokes,
    expected: { ...base.expected, bondLength: BASE_BOND * 1.24 },
  }
}


// ---------------- 字母风格变体（不同笔画顺序/形状，模拟不同人的手写习惯） ----------------

const SPLIT_O_GLYPH: GlyphDef = {
  width: 0.65,
  strokes: [
    ellipseStrokes(0.29, 0.46, Math.PI * 0.42, Math.PI * 1.02, 12)[0],
    ellipseStrokes(0.29, 0.46, Math.PI * 1.44, Math.PI * 1.02, 12)[0],
  ],
}

const CROSS_FIRST_H_GLYPH: GlyphDef = {
  width: 0.66,
  strokes: [
    [[-0.31, 0.02], [0.31, 0.02]],
    [[-0.28, -0.5], [-0.28, 0.5]],
    [[0.28, -0.5], [0.28, 0.5]],
  ],
}

// 一笔写完的 N：左下 -> 左上 -> 右下 -> 右上
const SINGLE_STROKE_N_GLYPH: GlyphDef = {
  width: 0.66,
  strokes: [[[-0.28, 0.5], [-0.28, -0.5], [0.28, 0.5], [0.28, -0.5]]],
}

// 不带小勾的 l（很多人的 Cl 就是这样写的）
const STRAIGHT_L_GLYPH: GlyphDef = { width: 0.24, strokes: [[[-0.02, -0.5], [0.02, 0.5]]] }

function fixturePropaneOneStroke() {
  const pen = createPen(31)
  const vertices = zigzag({ x: 110, y: 300 }, 2)
  pen.polyline(vertices)
  return {
    id: 'propane-one-stroke',
    name: '丙烷：一笔画成的折线碳链',
    strokes: pen.strokes,
    expected: { smiles: 'CCC', atoms: { C: 3 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: ZIG_LENGTH },
  }
}

function fixtureCyclopropane() {
  const pen = createPen(32)
  const radius = 36
  pen.closedOutline(polygonVertices(3, { x: 320, y: 300 }, radius, -Math.PI / 2 + 0.1))
  return {
    id: 'cyclopropane',
    name: '环丙烷：一笔闭合三角形环',
    strokes: pen.strokes,
    expected: { smiles: 'C1CC1', atoms: { C: 3 }, bonds: 3, orders: [1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius * Math.sqrt(3) },
  }
}

function fixtureCyclopentane() {
  const pen = createPen(33)
  const radius = 46
  pen.closedOutline(polygonVertices(5, { x: 320, y: 300 }, radius, -Math.PI / 2 + 0.12))
  return {
    id: 'cyclopentane',
    name: '环戊烷：一笔闭合五边形环',
    strokes: pen.strokes,
    expected: { smiles: 'C1CCCC1', atoms: { C: 5 }, bonds: 5, orders: [1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: 2 * radius * Math.sin(Math.PI / 5) },
  }
}

function fixtureCyclooctane() {
  const pen = createPen(34)
  const radius = 68
  pen.closedOutline(polygonVertices(8, { x: 330, y: 300 }, radius, -Math.PI / 2 + 0.08))
  return {
    id: 'cyclooctane',
    name: '环辛烷：一笔闭合八边形环（3–8 元环上界）',
    strokes: pen.strokes,
    expected: { smiles: 'C1CCCCCCC1', atoms: { C: 8 }, bonds: 8, orders: [1, 1, 1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: 2 * radius * Math.sin(Math.PI / 8) },
  }
}

function fixtureMethanethiol() {
  const pen = createPen(35, { letterJitter: 0.62 })
  const carbon = { x: 120, y: 300 }
  const direction = { x: 52, y: -10 }
  const bondEnd = { x: carbon.x + direction.x, y: carbon.y + direction.y }
  pen.line(carbon, bondEnd)
  pen.labelBeyond('SH', bondEnd, direction, { height: 0.48 * BASE_BOND, rotation: 0.07, letterJitter: 0.66, letterStep: 1.6 })
  return {
    id: 'methanethiol-sh',
    name: '甲硫醇：手写 SH 标签（S + H，不同手写风格）',
    strokes: pen.strokes,
    expected: { smiles: 'CS', atoms: { C: 1, S: 1 }, bonds: 1, orders: [1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureDimethylSulfide() {
  const pen = createPen(36, { letterJitter: 0.58 })
  const left = { x: 96, y: 314 }
  const right = { x: 268, y: 300 }
  const center = { x: 182, y: 282 }
  const height = 0.5 * BASE_BOND
  const measured = measureLabel('S', height)
  pen.line(left, { x: center.x - measured.width / 2 - 2, y: center.y + 5 })
  pen.line({ x: center.x + measured.width / 2 + 2, y: center.y - 5 }, right)
  pen.label('S', center, { height, rotation: 0.04 })
  return {
    id: 'dimethyl-sulfide',
    name: '二甲硫醚：链中间单个手写 S 标签',
    strokes: pen.strokes,
    expected: { smiles: 'CSC', atoms: { C: 2, S: 1 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function variantEthanolSplitLetters() {
  const pen = createPen(37)
  const chain = zigzag({ x: 90, y: 300 }, 2)
  pen.line(chain[0], chain[1])
  const bondEnd = { x: chain[1].x + 48, y: chain[1].y - 22 }
  pen.line(chain[1], bondEnd)
  pen.labelBeyond('OH', bondEnd, { x: 48, y: -22 }, {
    height: 0.5 * BASE_BOND,
    rotation: -0.08,
    letterJitter: 0.6,
    glyphOverrides: { O: SPLIT_O_GLYPH, H: CROSS_FIRST_H_GLYPH },
  })
  return {
    id: 'ethanol-oh-split-letters',
    name: '乙醇变体：O 分两笔、H 先写横（不同笔画顺序）',
    strokes: pen.strokes,
    expected: { smiles: 'CCO', atoms: { C: 2, O: 1 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function variantAcetonitrileNOneStroke() {
  const pen = createPen(38)
  const c1 = { x: 100, y: 300 }
  const c2 = { x: 152, y: 278 }
  pen.line(c1, c2)
  const direction = { x: 52, y: -22 }
  const tripleEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.tripleBond(c2, tripleEnd, { offset: 7, shorten: 0.14 })
  pen.labelBeyond('N', tripleEnd, direction, { height: 0.52 * BASE_BOND, rotation: 0.06, letterJitter: 0.6, glyphOverrides: { N: SINGLE_STROKE_N_GLYPH } })
  return {
    id: 'acetonitrile-n-one-stroke',
    name: '乙腈变体：N 一笔连写（不同笔画顺序）',
    strokes: pen.strokes,
    expected: { smiles: 'CC#N', atoms: { C: 2, N: 1 }, bonds: 2, orders: [1, 3], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function variantChloroethaneStraightL() {
  const pen = createPen(39)
  const c1 = { x: 94, y: 300 }
  const c2 = { x: 146, y: 278 }
  pen.line(c1, c2)
  const direction = { x: 50, y: 12 }
  const bondEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.line(c2, bondEnd)
  pen.labelBeyond('Cl', bondEnd, direction, { height: 0.5 * BASE_BOND, rotation: -0.04, letterJitter: 0.45, glyphOverrides: { l: STRAIGHT_L_GLYPH } })
  return {
    id: 'chloroethane-l-no-hook',
    name: '氯乙烷变体：l 不带小勾（不同手写风格）',
    strokes: pen.strokes,
    expected: { smiles: 'CCCl', atoms: { C: 2, Cl: 1 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}


// ---------------- 自由绘画夹具（任意笔顺/笔数/抬笔/重描，配合自由绘画画布） ----------------

function fixtureOneStrokeRingBranch() {
  // 一笔不抬笔：先绕六元环画一圈，回到起点后直接连出支链
  const pen = createPen(40)
  const center = { x: 320, y: 286 }
  const radius = 55
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2 + 0.1)
  const outward = normalize(vertices[0].x - center.x, vertices[0].y - center.y)
  const branch = { x: vertices[0].x + outward.x * BASE_BOND, y: vertices[0].y + outward.y * BASE_BOND }
  pen.polyline([...vertices, vertices[0], branch])
  return {
    id: 'one-stroke-ring-branch',
    name: '自由绘画：一笔画完六元环后不抬笔连出支链',
    strokes: pen.strokes,
    expected: { smiles: 'CC1CCCCC1', atoms: { C: 7 }, bonds: 7, orders: [1, 1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureRandomOrderRing() {
  // 环的 6 条边乱序、正反方向交替，中间穿插支链笔画（模拟自由绘画任意笔顺）
  const pen = createPen(41)
  const center = { x: 320, y: 286 }
  const radius = 55
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2 + 0.12)
  const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]]
  const order = [3, 0, 5, 2, 1, 4]
  const outward = normalize(vertices[0].x - center.x, vertices[0].y - center.y)
  const branch = { x: vertices[0].x + outward.x * BASE_BOND, y: vertices[0].y + outward.y * BASE_BOND }
  order.forEach((edgeIndex, drawIndex) => {
    const [from, to] = edges[edgeIndex]
    if (drawIndex % 2 === 1) pen.line(vertices[to], vertices[from])
    else pen.line(vertices[from], vertices[to])
    if (drawIndex === 2) pen.line(vertices[0], branch)
  })
  return {
    id: 'random-order-ring',
    name: '自由绘画：环边乱序+正反方向交替+支链穿插',
    strokes: pen.strokes,
    expected: { smiles: 'CC1CCCCC1', atoms: { C: 7 }, bonds: 7, orders: [1, 1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureLettersBeforeBonds() {
  // 先写 OH 字母，再画键（顺序与常规相反）
  const pen = createPen(42)
  const c1 = { x: 110, y: 300 }
  const c2 = { x: 162, y: 278 }
  const direction = { x: 48, y: -22 }
  const bondEnd = { x: c2.x + direction.x, y: c2.y + direction.y }
  pen.labelBeyond('OH', bondEnd, direction, { height: 0.48 * BASE_BOND, rotation: 0.05 })
  pen.line(c2, bondEnd)
  pen.line(c1, c2)
  return {
    id: 'letters-before-bonds',
    name: '自由绘画：先写 OH 再补键（书写顺序反转）',
    strokes: pen.strokes,
    expected: { smiles: 'CCO', atoms: { C: 2, O: 1 }, bonds: 2, orders: [1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: BASE_BOND },
  }
}

function fixtureFoldedDouble() {
  // 一笔折返画双键：去程 + U 形折回；两线间距 10px（约 0.14×键长），折返连接段短于 minBondLength 会被忽略
  const pen = createPen(43)
  const a = { x: 190, y: 300 }
  const b = { x: 262, y: 298 }
  const offset = 10
  pen.polyline([
    a,
    b,
    { x: b.x + 1, y: b.y + offset },
    { x: a.x + 1, y: a.y + offset },
  ])
  return {
    id: 'folded-double',
    name: '自由绘画：一笔 U 形折返画双键',
    strokes: pen.strokes,
    expected: { smiles: 'C=C', atoms: { C: 2 }, bonds: 1, orders: [2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: 72 },
  }
}

function fixtureRingRedrawTwice() {
  // 同一笔把六元环画两圈（重描）；需要 bond-engine 的“环重描”合并修复
  const pen = createPen(44, { jitter: 1 })
  const center = { x: 320, y: 286 }
  const radius = 55
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2 + 0.1)
  const loop = [...vertices, vertices[0], ...vertices.slice(1), vertices[0]]
  pen.polyline(loop)
  return {
    id: 'ring-redraw-twice',
    name: '自由绘画：同一笔把六元环重描两圈',
    strokes: pen.strokes,
    expected: { smiles: 'C1CCCCC1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureFreeformManyStrokes() {
  // 长链每条键都抬笔分开画（多次抬笔），支链也独立一笔；与一笔连续画出结果等价
  const pen = createPen(45)
  const chain = zigzag({ x: 96, y: 322 }, 5, { flip: -1 })
  const previous = chain[0]
  const next = chain[2]
  const middle = { x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 }
  const outward = normalize(chain[1].x - middle.x, chain[1].y - middle.y)
  const branch = { x: chain[1].x + outward.x * BASE_BOND, y: chain[1].y + outward.y * BASE_BOND }
  pen.line(chain[0], chain[1])
  pen.line(chain[1], chain[2])
  pen.line(chain[1], branch)
  pen.line(chain[2], chain[3])
  pen.line(chain[3], chain[4])
  pen.line(chain[4], chain[5])
  return {
    id: 'freeform-many-strokes',
    name: '自由绘画：长链+支链全部抬笔分段画（多笔）',
    strokes: pen.strokes,
    expected: { smiles: 'CC(C)CCCC', atoms: { C: 7 }, bonds: 6, orders: [1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: ZIG_LENGTH },
  }
}


// ---------------- 真实分笔画夹具（用户真实习惯：环不一笔画成，顶点留间隙） ----------------

/** 把从 from 指向 toward 的直线端点向 toward 缩进 trim 像素。 */
function trimmedToward(from: Point, toward: Point, trim: number): Point {
  const unit = normalize(toward.x - from.x, toward.y - from.y)
  return { x: from.x + unit.x * trim, y: from.y + unit.y * trim }
}

/**
 * 真实手写六元环：六条边分别画，顶点处相邻两笔留 gap 像素的弦长间隙。
 * 顶点间隙通过“两端各缩进 gap/(2*sin60°)”精确控制。
 * 返回已画好的顶点坐标。
 */
function drawSeparatedHexagon(pen: Pen, center: Point, radius: number, gaps: number[], rotation = -Math.PI / 2 + 0.08): Point[] {
  const vertices = polygonVertices(6, center, radius, rotation)
  const trims = gaps.map(gap => gap / (2 * Math.sin(Math.PI / 3)))
  for (let index = 0; index < 6; index += 1) {
    const next = (index + 1) % 6
    pen.line(vertices[index], vertices[next], { trimA: trims[index], trimB: trims[next] })
  }
  return vertices
}

function fixtureBenzeneSixEdgesGaps() {
  // 真实习惯：六条边各一笔分开画，顶点留 16–24px 间隙；环内圆圈单独一笔
  const pen = createPen(46)
  const center = { x: 320, y: 288 }
  const radius = 58
  drawSeparatedHexagon(pen, center, radius, [16, 22, 18, 24, 20, 22])
  const circle: Point[] = []
  for (let index = 0; index <= 26; index += 1) {
    const angle = 0.6 + index / 26 * Math.PI * 2.0
    circle.push({ x: center.x + 27 * Math.cos(angle), y: center.y + 26.4 * Math.sin(angle) })
  }
  pen.polyline(circle)
  return {
    id: 'benzene-six-edges-gaps',
    name: '真实分笔画：六条边各一笔（顶点间隙16–24px）+ 独立内圈 → 苯',
    strokes: pen.strokes,
    expected: { smiles: 'C1=CC=CC=C1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 2, 2, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureCyclohexaneSixEdgesGaps() {
  // 六条边 6 笔，每顶点间隙约 20px，无芳环内圈
  const pen = createPen(47)
  const center = { x: 320, y: 288 }
  const radius = 58
  drawSeparatedHexagon(pen, center, radius, [20, 20, 20, 20, 20, 20])
  return {
    id: 'cyclohexane-six-edges-gaps',
    name: '真实分笔画：六条边各一笔、顶点间隙约20px → 环己烷',
    strokes: pen.strokes,
    expected: { smiles: 'C1CCCCC1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureRingTwoStrokesGaps() {
  // 两笔 polyline，各画 3 条边；两处连接顶点各留约 18px 间隙
  const pen = createPen(48)
  const center = { x: 320, y: 288 }
  const radius = 58
  const vertices = polygonVertices(6, center, radius, -Math.PI / 2 + 0.08)
  const trim = 18 / (2 * Math.sin(Math.PI / 3))
  pen.polyline([
    trimmedToward(vertices[0], vertices[1], trim),
    vertices[1],
    vertices[2],
    trimmedToward(vertices[3], vertices[2], trim),
  ])
  pen.polyline([
    trimmedToward(vertices[3], vertices[4], trim),
    vertices[4],
    vertices[5],
    trimmedToward(vertices[0], vertices[5], trim),
  ])
  return {
    id: 'ring-two-strokes-gaps',
    name: '真实分笔画：两笔各画3条边、连接顶点间隙约18px → 环己烷',
    strokes: pen.strokes,
    expected: { smiles: 'C1CCCCC1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

function fixtureRingWithSubstituentGaps() {
  // 环 6 边分开画（顶点间隙 9–22px），支链单独一笔、端点贴近环顶点（约7px，在 snap 范围内）
  const pen = createPen(49)
  const center = { x: 320, y: 288 }
  const radius = 58
  const vertices = drawSeparatedHexagon(pen, center, radius, [9, 18, 20, 22, 18, 20])
  const outward = normalize(vertices[0].x - center.x, vertices[0].y - center.y)
  const branchStart = { x: vertices[0].x + outward.x * 7, y: vertices[0].y + outward.y * 7 }
  const branchEnd = { x: vertices[0].x + outward.x * (7 + BASE_BOND), y: vertices[0].y + outward.y * (7 + BASE_BOND) }
  pen.line(branchStart, branchEnd)
  return {
    id: 'ring-with-substituent-gaps',
    name: '真实分笔画：环6边分开+支链端点贴近环顶点 → 甲基环己烷',
    strokes: pen.strokes,
    expected: { smiles: 'CC1CCCCC1', atoms: { C: 7 }, bonds: 7, orders: [1, 1, 1, 1, 1, 1, 1], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: radius },
  }
}

// ---------------- 用户真实手绘（照片矢量化）潦草苯环 ----------------
//
// 数据来源：用户提供的 4 个潦草手绘苯环照片，经阈值→细化→骨架路径追踪→简化/平滑矢量化；
// 原始文件 /tmp/handdraw-demo/scribble-rings.json（说明见 /tmp/scribble/README.md）。
// 这是用户真实画法：顶点不对齐、边弯曲、内圈开口，禁止为通过而简化输入。

interface ScribbleDrawing {
  id: string
  name: string
  /** 每个笔画是 [x, y] 折线，坐标保留 1 位小数以压缩体积。 */
  strokes: [number, number][][]
}

const USER_SCRIBBLE_RINGS: ScribbleDrawing[] = [
  {
    id: 'user-scribble-benzene-1',
    name: '用户实拍潦草苯环 1（5 笔：左竖、左上斜、左+底+右下长笔含浅折角、开口内圈、右上斜）',
    strokes: [
      [[106, 387], [105.7, 386.7], [104.7, 385.7], [103.4, 384.4], [100.6, 381.6], [99.3, 379.6], [98.3, 376.6], [98, 373.6], [98, 367.4], [98.4, 360.6],
       [99.4, 346], [100.9, 328.7], [104.1, 291.3], [106, 274.2], [108.2, 260.6], [110.2, 254.8], [113.8, 251.2], [115.4, 249.6], [116.6, 248.4], [117, 248]],
      [[106, 230], [106.7, 229.3], [108.7, 227.1], [111.4, 224.2], [117.6, 217.8], [120.7, 214], [123.9, 209.4], [126.2, 205.3], [129.8, 197.7], [132.8, 192.9],
       [138, 185.9], [143.9, 179.2], [156.1, 165.8], [162.5, 158.5], [169.5, 149.7], [174.7, 142.5], [183.3, 129.5], [187.8, 123.2], [192.8, 117.2], [196.4, 113.5],
       [202.6, 108.5], [205.3, 106.2], [207.3, 104.6], [208, 104]],
      [[86, 419], [86.9, 419.2], [89.5, 419.6], [93, 420.3], [101, 421.7], [105.1, 422.7], [109.5, 424.1], [112.8, 425.6], [118.2, 428.4], [123.2, 432.1],
       [132.6, 440.3], [143.5, 450.2], [166.5, 471.8], [177, 481.5], [185.6, 488.9], [189.2, 491.6], [191.8, 492.4], [194.2, 491.5], [199, 488.3], [204.6, 483.7],
       [216.4, 473.3], [223.8, 466.4], [233.8, 456.2], [243.3, 446.1], [261.7, 425.9], [269.6, 416], [275.2, 406.4], [276.4, 400.3], [274.6, 391.7], [274.7, 383.2],
       [276.9, 366.6], [280.4, 347.2], [288.6, 305.8], [292.3, 287.4], [295.1, 273.6], [296, 269]],
      [[208, 285], [207.3, 285.2], [205.3, 285.8], [202.6, 286.6], [196.4, 288.4], [193.3, 290], [190.1, 292.8], [187.8, 296.1], [184.2, 302.9], [182.5, 307.8],
       [180.9, 315.6], [180, 323.7], [179, 340.3], [178.6, 348.2], [178.6, 355.4], [179, 359.5], [180, 364.5], [180.8, 367], [182.2, 369.4], [183.6, 370.9],
       [186.4, 373.1], [188.7, 373.8], [192.5, 373.6], [196.7, 372.8], [205.3, 370.2], [209.8, 368.5], [214.8, 365.9], [218.4, 363.2], [224.6, 357.8], [228.1, 353.8],
       [232.5, 347], [236.4, 339.9], [243.6, 325.1], [246.8, 318], [249, 311.4], [249.7, 307.5], [249.3, 302.5], [248.6, 299.6], [246.8, 296.2], [244.5, 293.2],
       [239.5, 287.8], [236.7, 285], [233.3, 282], [230.5, 279.8], [225.5, 276.2], [222.5, 274.4], [218.7, 272.4], [215.2, 271.1], [208.8, 268.9], [205.9, 268],
       [203.7, 267.2], [203, 267]],
      [[284, 259], [283.9, 258.6], [283.5, 257.6], [283, 256.1], [282, 252.9], [280.5, 250.2], [277.3, 245.6], [273.3, 240.4], [264.7, 229.6], [259.8, 222.1],
       [253.8, 210.5], [248.7, 198.6], [239.3, 174.4], [234.4, 162.2], [228.8, 149.6], [224.6, 140.8], [217.4, 127.2], [214.2, 121.1], [211.8, 116.5], [211, 115]],
    ],
  },
  {
    id: 'user-scribble-benzene-2',
    name: '用户实拍潦草苯环 2（5 笔：左竖、左上斜、底部弯曲笔、开口内圈、右上斜）',
    strokes: [
      [[580, 377], [579.6, 376.5], [578.6, 374.9], [577.1, 372.8], [573.9, 368.2], [572.5, 361.7], [571.7, 346.9], [571.6, 328.8], [572.4, 289.2], [572.9, 271],
       [573.7, 255.8], [574.6, 248.9], [576.4, 243.1], [577.2, 240.6], [577.8, 238.6], [578, 238]],
      [[578, 224], [577.1, 224.8], [574.3, 227], [570.6, 230.1], [562.4, 236.9], [558.2, 240], [554.2, 242.4], [551.5, 243.3], [547.5, 243.7], [545.9, 243.5],
       [544.9, 242.5], [545, 241.1], [546, 237.9], [550.2, 232], [561.4, 217.6], [576.1, 199.5], [608.9, 159.5], [624.3, 141], [637.7, 125.4], [644.7, 117.9],
       [652.3, 111.1], [656.3, 108], [660.7, 105.6], [664.1, 104.7], [669.9, 104.3], [672.4, 104.2], [674.4, 104], [675, 104]],
      [[591, 375], [591.2, 375.4], [591.8, 376.8], [592.6, 378.5], [594.4, 382.5], [596.9, 385.8], [602.7, 392], [609.8, 398.8], [625.2, 413.2], [632.9, 419.9],
       [640.5, 425.7], [645.4, 428.6], [652.6, 431.4], [657, 432.8], [662.8, 434.2], [668.3, 435], [678.7, 436], [683.7, 436.7], [688.3, 437.7], [690.9, 438.6],
       [694.1, 440.4], [698.8, 438.6], [709.4, 431.6], [722.6, 421.5], [751.4, 398.5], [763.8, 384], [772.4, 363.6], [774.1, 344.1], [770.9, 305.9], [769.4, 289],
       [768.4, 276.2], [768, 272]],
      [[676, 268], [675.4, 268.4], [673.6, 269.4], [671.2, 270.9], [665.8, 274.1], [663.2, 276.2], [660.8, 279], [659.4, 281.8], [657.6, 287.2], [656.7, 291],
       [655.9, 297.2], [655.4, 303.5], [654.6, 316.5], [654.7, 322.6], [655.7, 327.8], [657.2, 330.6], [660.8, 333.4], [663, 334.6], [666.2, 335.2], [669.1, 335],
       [674.9, 334], [678.7, 332.4], [684.5, 328.8], [690.2, 324.4], [701.8, 314.6], [707.4, 309.6], [712.6, 304], [715.8, 299.9], [720.2, 293.1], [722.2, 289.4],
       [723.8, 285], [724.6, 281.6], [725.4, 275.4], [725.3, 272.3], [724.3, 268.9], [722.8, 266.5], [719.2, 262.5], [717.2, 260.6], [714.6, 258.6], [712.5, 257.4],
       [708.5, 255.6], [706, 254.6], [702.2, 253.6], [698.6, 252.7], [691.4, 251.3], [687.2, 250.7], [681.6, 250.5], [676.7, 250.6], [667.3, 251.4], [663.2, 251.7],
       [660, 251.9], [659, 252]],
      [[753, 269], [750.2, 263.4], [741.8, 246.4], [730.6, 223.9], [705.4, 173.1], [693.9, 150.2], [684.5, 132], [680.4, 124.8], [677.6, 121.2], [676.3, 119.6],
       [675.3, 118.4], [675, 118]],
    ],
  },
  {
    id: 'user-scribble-benzene-3',
    name: '用户实拍潦草苯环 3（3 笔：底左、左+上+右长笔、开口内圈）',
    strokes: [
      [[1202, 456], [1201.5, 455.9], [1199.9, 455.7], [1197.8, 455.4], [1193.2, 454.6], [1190.5, 453.9], [1187.3, 452.3], [1184.5, 450.5], [1179.5, 446.5], [1175.6, 442.6],
       [1169.2, 434.8], [1162.2, 425.7], [1147.8, 406.3], [1141.1, 397], [1135.3, 388.6], [1132.4, 383.9], [1129.6, 378.1], [1128.3, 375.6], [1127.3, 373.6], [1127, 373]],
      [[1219, 447], [1219.3, 447], [1220.3, 446.8], [1221.6, 446.7], [1224.4, 446.3], [1227.1, 445.1], [1232.1, 441.9], [1237.9, 437.7], [1250.1, 428.3], [1256.9, 422.8],
       [1265.1, 415.6], [1271.9, 409.1], [1284.1, 396.9], [1290.2, 391.2], [1296, 386.6], [1299.8, 384.4], [1305.2, 382.6], [1307.4, 381.1], [1308.6, 378.3], [1308.4, 375.2],
       [1306.6, 368.8], [1305.6, 364], [1304.6, 356.2], [1303.7, 348], [1302.3, 331], [1301.6, 321.9], [1301.2, 311.5], [1301, 303.2], [1301, 288.8], [1301.3, 281.5],
       [1302.3, 273.9], [1303.6, 268.6], [1306.4, 260.4], [1307.6, 256.3], [1308.2, 252.5], [1308, 250.1], [1307, 246.9], [1305.5, 244.5], [1302.3, 240.5], [1298.3, 236.3],
       [1289.7, 227.7], [1285.3, 222.9], [1280.7, 217.3], [1277.5, 212.6], [1272.5, 204.4], [1269.2, 199.5], [1264.4, 193.1], [1259.7, 187.4], [1250.3, 176.6], [1245.3, 170.1],
       [1239.5, 161.5], [1235, 153.6], [1227, 138.4], [1223.2, 131.4], [1219.4, 125.2], [1217.1, 122.1], [1213.9, 118.9], [1211.7, 117.6], [1208.5, 117.2], [1205.2, 117.6],
       [1198.8, 119.4], [1193.2, 123], [1183, 131.8], [1171.6, 143.1], [1147.4, 167.9], [1136.2, 179.7], [1126.6, 190.1], [1121.8, 195.8], [1117.2, 202.2], [1113.8, 206.3],
       [1108.2, 212.1], [1102.4, 217.6], [1090.6, 228.4], [1085.6, 234.8], [1082.4, 243.4], [1082.2, 251.1], [1084.8, 265.9], [1086, 276], [1087, 291.4], [1087.6, 307.2],
       [1088.4, 338.8], [1088.9, 353.4], [1089.7, 365.6], [1090.6, 371.2], [1092.4, 375.8], [1093.5, 378.2], [1094.9, 380.4], [1096.2, 381.9], [1098.8, 384.1], [1099.9, 385],
       [1100.7, 385.8], [1101, 386]],
      [[1226, 328], [1227.2, 326.8], [1230.6, 323.4], [1235.3, 318.7], [1245.7, 308.3], [1250.6, 303.1], [1254.8, 298.1], [1256.9, 294.8], [1259.1, 290.2], [1260, 287.6],
       [1260.8, 284.8], [1261, 282.5], [1261, 278.5], [1260.5, 276.3], [1258.9, 273.7], [1256.8, 271.5], [1252.2, 267.5], [1249, 265.6], [1244.2, 264], [1239.4, 263],
       [1229.6, 262], [1225.3, 261.5], [1222.1, 261.1], [1221, 261]],
    ],
  },
  {
    id: 'user-scribble-benzene-4',
    name: '用户实拍潦草苯环 4（4 笔：底左、左+上+右上长折线、内圈（曾被误判 Cl）、右侧弯曲弧边）',
    strokes: [
      [[1720, 437], [1718.8, 436.5], [1715, 434.9], [1710.1, 432.8], [1698.9, 428.2], [1692, 424.2], [1682.6, 417], [1673.6, 409], [1656.4, 392], [1648.6, 384.3],
       [1642.8, 377.9], [1640.7, 375.1], [1640.3, 372.9], [1640.2, 372], [1640, 371.2], [1640, 371]],
      [[1626, 382], [1625.7, 381.8], [1624.7, 381.2], [1623.4, 380.4], [1620.6, 378.6], [1619.2, 377.4], [1618.2, 375.8], [1617.7, 374.1], [1617.3, 370.9], [1617.8, 365.7],
       [1619.6, 353.3], [1622.1, 337.9], [1627.9, 304.1], [1630.5, 287.4], [1632.7, 271.2], [1633.6, 260.9], [1634.4, 246.1], [1638.3, 235.8], [1649.3, 219.8], [1663.8, 203.2],
       [1696.2, 169.8], [1711.2, 154], [1724, 140.4], [1730.1, 133.3], [1735.9, 125.7], [1739, 122.6], [1742.6, 120.6], [1745.5, 120.6], [1750.5, 122.4], [1753.2, 124],
       [1756.4, 127], [1758.8, 130.4], [1763.2, 137.6], [1765.8, 143.6], [1769.2, 154.6], [1772.4, 166.7], [1778.6, 192.3], [1782.2, 205], [1786.8, 217.6], [1791, 225.9],
       [1799, 238.1], [1802.5, 244], [1805.1, 249.6], [1806, 252.8], [1806, 257.2], [1805.8, 259.4], [1805.2, 261.6], [1804.4, 263.2], [1802.6, 265.8], [1801.8, 266.9],
       [1801.2, 267.7], [1801, 268]],
      [[1736, 300], [1737.2, 300], [1741, 299.8], [1745.9, 299.7], [1757.1, 299.3], [1762.4, 299.6], [1767, 300.6], [1769.6, 302.2], [1772.4, 305.8], [1773.4, 308],
       [1773.2, 310.8], [1772.1, 313.5], [1768.9, 318.5], [1766.4, 321.7], [1762.2, 326.1], [1757.7, 330.4], [1748.3, 338.6], [1743.6, 342.6], [1739, 346.4], [1735.8, 348.6],
       [1731.2, 351.4], [1728.7, 352.7], [1725.9, 353.7], [1723.8, 354], [1720.2, 354], [1718.4, 353.8], [1716.4, 353.4], [1715.1, 352.7], [1712.9, 351.3], [1712, 349.6],
       [1711.4, 345.8], [1711.3, 341.4], [1711.7, 331.6], [1712, 326.7], [1712.6, 321.5], [1713.3, 317.9], [1714.7, 312.1], [1715.8, 308.9], [1717.6, 305.1], [1719.5, 301.9],
       [1723.5, 296.1], [1725.2, 293.6], [1726.6, 291.6], [1727, 291]],
      [[1728, 449], [1729.2, 448.4], [1732.6, 446.6], [1737.3, 444.2], [1747.7, 438.8], [1754.3, 434.9], [1763.7, 428.7], [1772.7, 422.2], [1790.3, 408.8], [1798.4, 401.4],
       [1805, 392.2], [1807.9, 384.5], [1810.1, 370.5], [1811, 361.2], [1811.6, 347.6], [1811.7, 334], [1811.3, 307], [1811.3, 294.6], [1811.5, 284.2], [1812, 279.5],
       [1813, 275.5], [1813.5, 273.8], [1813.9, 272.4], [1814, 272]],
    ],
  },
]

const USER_SCRIBBLE_BOND_LENGTH = 140

/** 用户真实潦草苯环夹具：期望苯（6C / 6 键 / 3 双键），输入保持原始潦草笔迹。 */
function fixtureUserScribbleBenzene(index: number): Fixture {
  const drawing = USER_SCRIBBLE_RINGS[index]
  const strokes: Stroke[] = drawing.strokes.map(stroke => stroke.map(([x, y]) => ({ x, y })))
  return {
    id: drawing.id,
    name: drawing.name,
    strokes,
    expected: { smiles: 'C1=CC=CC=C1', atoms: { C: 6 }, bonds: 6, orders: [1, 1, 1, 2, 2, 2], charges: { positive: 0, negative: 0 }, minWarnings: 0, bondLength: USER_SCRIBBLE_BOND_LENGTH },
  }
}

const FIXTURE_BUILDERS: (() => Fixture)[] = [
  fixtureEthanol,
  fixtureButanol,
  fixtureAceticAcid,
  fixtureAcetonitrile,
  fixtureChloroethane,
  fixtureMethylamine,
  fixtureBenzene,
  fixturePyridine,
  fixtureCyclohexane,
  fixtureEthene,
  fixtureEthyne,
  fixturePropionicAcid,
  fixtureTwoFragments,
  fixtureTBranch,
  fixtureAldehydeH,
  fixtureTetramethylammonium,
  fixtureAcetate,
  variantEthanolRotated,
  variantEthanolLarge,
  fixturePropaneOneStroke,
  fixtureCyclopropane,
  fixtureCyclopentane,
  fixtureCyclooctane,
  fixtureMethanethiol,
  fixtureDimethylSulfide,
  variantEthanolSplitLetters,
  variantAcetonitrileNOneStroke,
  variantChloroethaneStraightL,
  fixtureOneStrokeRingBranch,
  fixtureRandomOrderRing,
  fixtureLettersBeforeBonds,
  fixtureFoldedDouble,
  fixtureRingRedrawTwice,
  fixtureFreeformManyStrokes,
  fixtureBenzeneSixEdgesGaps,
  fixtureCyclohexaneSixEdgesGaps,
  fixtureRingTwoStrokesGaps,
  fixtureRingWithSubstituentGaps,
  () => fixtureUserScribbleBenzene(0),
  () => fixtureUserScribbleBenzene(1),
  () => fixtureUserScribbleBenzene(2),
  () => fixtureUserScribbleBenzene(3),
]

function buildFixtures(): Fixture[] {
  return FIXTURE_BUILDERS.map(builder => {
    const fixture = builder()
    return {
      id: fixture.id,
      name: fixture.name,
      strokes: roundStrokes(fixture.strokes),
      expected: fixture.expected,
    }
  })
}

const FIXTURE_GLYPHS = GLYPHS
const FIXTURE_SEED = DEFAULT_SEED

// ============================================================================
// 以下为内嵌的独立手写夹具生成器（verifier 手写几何，20XX-XX 由 /tmp/handdraw-demo
// 生成；不从实现者的 glyphs.ts 模板派生，避免自证）。
// ============================================================================

// __FIXTURES_CORE__

// ============================================================================
// 独立判据工具（不依赖 src/lib 的实现细节：直接用 openchemlib 重建分子比对 IDCode）
// ============================================================================

interface GraphAtomLike { element: string; x: number; y: number; charge: number }
interface GraphBondLike { from: number; to: number; order: number }
interface GraphLike { atoms: GraphAtomLike[]; bonds: GraphBondLike[] }

const ELEMENT_NUMBERS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Molecule.cAtomLabel.slice(1, 119).map((label, index) => [label, index + 1])),
)
const BOND_TYPES: Record<number, number> = {
  1: Molecule.cBondTypeSingle,
  2: Molecule.cBondTypeDouble,
  3: Molecule.cBondTypeTriple,
}

function elementCounts(graph: GraphLike): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const atom of graph.atoms) counts[atom.element] = (counts[atom.element] ?? 0) + 1
  return counts
}

function sortedEntries(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

function sortedOrders(graph: GraphLike): number[] {
  return graph.bonds.map(bond => bond.order).sort((left, right) => left - right)
}

function chargeTotals(graph: GraphLike): { positive: number; negative: number } {
  let positive = 0
  let negative = 0
  for (const atom of graph.atoms) {
    if (atom.charge > 0) positive += atom.charge
    if (atom.charge < 0) negative += -atom.charge
  }
  return { positive, negative }
}

function graphToMolecule(graph: GraphLike): Molecule {
  const molecule = new Molecule(graph.atoms.length, graph.bonds.length)
  for (const atom of graph.atoms) {
    const atomicNumber = ELEMENT_NUMBERS[atom.element]
    if (!atomicNumber) throw new Error(`未知元素 ${atom.element}`)
    const index = molecule.addAtom(atomicNumber)
    molecule.setAtomX(index, atom.x)
    molecule.setAtomY(index, atom.y)
    molecule.setAtomCharge(index, atom.charge)
  }
  for (const bond of graph.bonds) {
    if (!BOND_TYPES[bond.order]) throw new Error(`非法键级 ${bond.order}`)
    molecule.setBondType(molecule.addBond(bond.from, bond.to), BOND_TYPES[bond.order])
  }
  molecule.ensureHelperArrays(Molecule.cHelperNeighbours)
  for (let index = 0; index < molecule.getAllAtoms(); index += 1) {
    if (molecule.getOccupiedValence(index) > molecule.getMaxValence(index)) throw new Error(`原子 ${index} 价键超限`)
  }
  molecule.stripStereoInformation()
  return molecule
}

function expectedIdCode(smiles: string): string {
  const molecule = Molecule.fromSmiles(smiles)
  molecule.stripStereoInformation()
  return molecule.getIDCode()
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y)
  const ratio = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + ratio * dx), point.y - (a.y + ratio * dy))
}

/** 每个输入笔画是否能在识别结果中找到归属（靠近某原子标签或某根键）。 */
function coverageReport(strokes: readonly Stroke[], graph: GraphLike, bondLength: number): { unattributed: number[] } {
  const atomTolerance = Math.max(16, bondLength * 0.75)
  const bondTolerance = Math.max(10, bondLength * 0.22)
  const unattributed: number[] = []
  const atoms = graph.atoms.map(atom => ({ x: atom.x, y: atom.y }))
  const bonds = graph.bonds
    .map(bond => ({ a: atoms[bond.from], b: atoms[bond.to] }))
    .filter(bond => bond.a !== undefined && bond.b !== undefined)
  strokes.forEach((stroke, index) => {
    if (!stroke.length) return
    let covered = 0
    for (const point of stroke) {
      const atomDistance = atoms.length ? Math.min(...atoms.map(atom => Math.hypot(point.x - atom.x, point.y - atom.y))) : Infinity
      const bondDistance = bonds.length ? Math.min(...bonds.map(bond => pointSegmentDistance(point, bond.a, bond.b))) : Infinity
      if (atomDistance <= atomTolerance || bondDistance <= bondTolerance) covered += 1
    }
    if (covered / stroke.length < 0.5) unattributed.push(index)
  })
  return { unattributed }
}

/** 结构合法性检查，返回问题列表（空数组表示合法）。 */
function graphProblems(graph: GraphLike): string[] {
  const problems: string[] = []
  if (!Array.isArray(graph.atoms) || !Array.isArray(graph.bonds)) return ['graph.atoms/bonds 不是数组']
  if (!graph.atoms.length) problems.push('没有任何原子')
  const seen = new Set<string>()
  graph.atoms.forEach((atom, index) => {
    if (!ELEMENT_NUMBERS[atom.element]) problems.push(`原子 ${index} 元素非法：${atom.element}`)
    if (!Number.isFinite(atom.x) || !Number.isFinite(atom.y)) problems.push(`原子 ${index} 坐标非有限数`)
    if (!Number.isInteger(atom.charge)) problems.push(`原子 ${index} 电荷非整数`)
    if (atom.element === 'H') problems.push(`原子 ${index} 是显式氢（期望使用隐式氢）`)
  })
  graph.bonds.forEach((bond, index) => {
    if (!Number.isInteger(bond.from) || !Number.isInteger(bond.to)) problems.push(`键 ${index} 端点非整数`)
    else if (bond.from < 0 || bond.to < 0 || bond.from >= graph.atoms.length || bond.to >= graph.atoms.length) problems.push(`键 ${index} 端点越界`)
    else if (bond.from === bond.to) problems.push(`键 ${index} 自环`)
    const pair = [Math.min(bond.from, bond.to), Math.max(bond.from, bond.to)].join(':')
    if (seen.has(pair)) problems.push(`键 ${index} 重复（同原子对）`)
    seen.add(pair)
    if (![1, 2, 3].includes(bond.order)) problems.push(`键 ${index} 键级非法：${bond.order}`)
  })
  return problems
}

function expectRecognitionError(strokes: unknown, code: string, options?: unknown): void {
  try {
    recognizeHanddraw(strokes as never, options as never)
  } catch (error) {
    expect(error).toBeInstanceOf(HanddrawRecognitionError)
    expect((error as HanddrawRecognitionError).code).toBe(code)
    expect((error as Error).message.length).toBeGreaterThan(5)
    expect(/[\u4e00-\u9fff]/.test((error as Error).message)).toBe(true)
    return
  }
  expect.fail(`期望抛出 ${code}，但识别成功返回了`)
}

const FIXTURES: Fixture[] = buildFixtures()

// ============================================================================
// 端到端验收
// ============================================================================

describe('手写识别端到端验收（verifier 独立手写夹具）', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.id} — ${fixture.name}（期望 ${fixture.expected.smiles}）`, () => {
      const strokes: Stroke[] = fixture.strokes.map(stroke => stroke.map(point => ({ x: point.x, y: point.y })))
      const snapshot = JSON.stringify(strokes)
      const result = recognizeHanddraw(strokes)
      const graph = result.graph as GraphLike
      const warnings = result.warnings

      // 输入不可变性
      expect(JSON.stringify(strokes)).toBe(snapshot)

      // 结果结构合法性（含：不得出现显式氢原子）
      expect(graphProblems(graph)).toEqual([])

      // 原子元素组成与数量
      expect(sortedEntries(elementCounts(graph))).toEqual(sortedEntries(fixture.expected.atoms))
      expect(graph.atoms.length).toBe(Object.values(fixture.expected.atoms).reduce((sum, count) => sum + count, 0))

      // 键数与键级
      expect(graph.bonds.length).toBe(fixture.expected.bonds)
      expect(sortedOrders(graph)).toEqual(fixture.expected.orders.slice().sort((left, right) => left - right))

      // 电荷（形式电荷总数）
      expect(chargeTotals(graph)).toEqual(fixture.expected.charges)

      // 化学等价：openchemlib IDCode（与 game.ts 判题同一判据）
      const actualIdCode = graphToMolecule(graph).getIDCode()
      expect(actualIdCode).toBe(expectedIdCode(fixture.expected.smiles))

      // warnings：中文可见文本，数量不低于期望
      for (const warning of warnings) {
        expect(typeof warning).toBe('string')
        expect(warning.trim().length).toBeGreaterThan(0)
        expect(/[\u4e00-\u9fff]/.test(warning)).toBe(true)
      }
      expect(warnings.length).toBeGreaterThanOrEqual(fixture.expected.minWarnings)

      // 不静默丢弃：每条笔画要么成为键/标签，要么有 warning
      const coverage = coverageReport(fixture.strokes, graph, fixture.expected.bondLength)
      if (coverage.unattributed.length > 0 && warnings.length === 0) {
        expect.fail(`${fixture.id}: 笔画 ${coverage.unattributed.join(',')} 既没有成为键/原子标签，也没有任何 warning（静默丢弃）`)
      }
    })
  }
})

describe('夹具期望数据自洽', () => {
  it('每个夹具的期望 SMILES 与期望原子/键/键级/电荷一致', () => {
    for (const fixture of FIXTURES) {
      const molecule = Molecule.fromSmiles(fixture.expected.smiles)
      molecule.stripStereoInformation()
      molecule.ensureHelperArrays(Molecule.cHelperNeighbours)
      const elements: Record<string, number> = {}
      for (let index = 0; index < molecule.getAllAtoms(); index += 1) {
        const element = molecule.getAtomLabel(index)
        elements[element] = (elements[element] ?? 0) + 1
      }
      expect(sortedEntries(elements)).toEqual(sortedEntries(fixture.expected.atoms))
      expect(molecule.getAllBonds()).toBe(fixture.expected.bonds)
      const orders: number[] = []
      for (let index = 0; index < molecule.getAllBonds(); index += 1) orders.push(molecule.getBondOrder(index))
      expect(orders.sort((left, right) => left - right)).toEqual(fixture.expected.orders.slice().sort((left, right) => left - right))
      let positive = 0
      let negative = 0
      for (let index = 0; index < molecule.getAllAtoms(); index += 1) {
        const charge = molecule.getAtomCharge(index)
        if (charge > 0) positive += charge
        if (charge < 0) negative += -charge
      }
      expect({ positive, negative }).toEqual(fixture.expected.charges)
    }
  })

  it('芳香式与 Kekulé 式、显式/隐式氢的 IDCode 等价（判据自检）', () => {
    expect(expectedIdCode('c1ccccc1')).toBe(expectedIdCode('C1=CC=CC=C1'))
    expect(expectedIdCode('c1ccncc1')).toBe(expectedIdCode('C1=CC=NC=C1'))
    expect(expectedIdCode('[H]C(C)=O')).toBe(expectedIdCode('CC=O'))
  })

  it('夹具生成确定性与固定种子（便于复现）', () => {
    expect(buildFixtures()).toEqual(buildFixtures())
    expect(FIXTURE_SEED).toBeGreaterThan(0)
    expect(Object.keys(FIXTURE_GLYPHS).length).toBeGreaterThan(8)
  })
})

describe('不静默丢弃', () => {
  it('每个笔画的墨迹都能在结果中找到归属，或有中文 warning（全部夹具）', () => {
    for (const fixture of FIXTURES) {
      const result = recognizeHanddraw(fixture.strokes)
      const graph = result.graph as GraphLike
      const coverage = coverageReport(fixture.strokes, graph, fixture.expected.bondLength)
      if (coverage.unattributed.length > 0) {
        expect(result.warnings.length).toBeGreaterThan(0)
      }
    }
  })

  it('游离的过短笔迹要给出中文 warning，不静默丢弃', () => {
    const ethanol = FIXTURES.find(fixture => fixture.id === 'ethanol-oh')
    if (!ethanol) expect.fail('缺少 ethanol-oh 夹具')
    const strokes: Stroke[] = [
      ...ethanol!.strokes.map(stroke => stroke.map(point => ({ x: point.x, y: point.y }))),
      [{ x: 560, y: 80 }, { x: 566, y: 84.5 }, { x: 571, y: 79.5 }],
    ]
    let result: { graph: GraphLike; warnings: string[] } | null = null
    try {
      result = recognizeHanddraw(strokes) as { graph: GraphLike; warnings: string[] }
    } catch (error) {
      expect(error).toBeInstanceOf(HanddrawRecognitionError)
      expect(/[\u4e00-\u9fff]/.test((error as Error).message)).toBe(true)
      return
    }
    expect(result!.warnings.length).toBeGreaterThan(0)
    expect(graphToMolecule(result!.graph).getIDCode()).toBe(expectedIdCode('CCO'))
  })

  it('只有无法解释的墨点时必须报警或报错，不能静默返回', () => {
    let warned = false
    try {
      const result = recognizeHanddraw([[{ x: 200, y: 200 }], [{ x: 244, y: 245 }]])
      warned = result.warnings.length > 0
    } catch (error) {
      warned = error instanceof HanddrawRecognitionError && /[\u4e00-\u9fff]/.test((error as Error).message)
    }
    expect(warned).toBe(true)
  })
})

describe('输入不可变性与确定性', () => {
  it('全部夹具：识别不修改输入笔画，且两次识别结果一致', () => {
    for (const fixture of FIXTURES) {
      const strokes: Stroke[] = fixture.strokes.map(stroke => stroke.map(point => ({ x: point.x, y: point.y })))
      const snapshot = JSON.stringify(strokes)
      const first = recognizeHanddraw(strokes)
      expect(JSON.stringify(strokes)).toBe(snapshot)
      const second = recognizeHanddraw(strokes)
      expect(graphToMolecule(second.graph as GraphLike).getIDCode()).toBe(graphToMolecule(first.graph as GraphLike).getIDCode())
      expect(second.warnings).toEqual(first.warnings)
    }
  })
})

describe('自由绘画：任意笔数与入口上限', () => {
  it('200 笔分段绘画在 maxStrokes=512 下可识别；默认上限 160 时给出 LIMIT_EXCEEDED', () => {
    const strokes: Stroke[] = []
    for (let index = 0; index < 200; index += 1) {
      strokes.push([
        { x: index * 40, y: 200 + Math.sin(index * 0.7) * 30 },
        { x: (index + 1) * 40, y: 200 + Math.sin((index + 1) * 0.7) * 30 },
      ])
    }
    const result = recognizeHanddraw(strokes, { maxStrokes: 512, maxPoints: 30000 })
    const graph = result.graph as GraphLike
    expect(graph.atoms.length).toBe(201)
    expect(graph.bonds.length).toBe(200)
    expect(graphToMolecule(graph).getIDCode()).toBe(expectedIdCode('C'.repeat(201)))
    expectRecognitionError(strokes, 'LIMIT_EXCEEDED')
  })
})

describe('入口校验与错误码', () => {
  it('空输入 → EMPTY', () => {
    expectRecognitionError([], 'EMPTY')
  })

  it('笔迹不是数组 → INVALID_INPUT', () => {
    expectRecognitionError('not-a-stroke-list', 'INVALID_INPUT')
  })

  it('坐标非法 → INVALID_INPUT', () => {
    expectRecognitionError([[{ x: Number.NaN, y: 10 }, { x: 20, y: 20 }]], 'INVALID_INPUT')
  })

  it('超过 maxStrokes 上限 → LIMIT_EXCEEDED', () => {
    const line = (offset: number): Point[] => [{ x: offset, y: 0 }, { x: offset + 40, y: 0 }]
    const strokes = Array.from({ length: 5 }, (_, index) => line(index * 40))
    expectRecognitionError(strokes, 'LIMIT_EXCEEDED', { maxStrokes: 3 })
  })

  it('超过 maxPoints 上限 → LIMIT_EXCEEDED', () => {
    const stroke: Point[] = Array.from({ length: 60 }, (_, index) => ({ x: index * 2, y: Math.sin(index) * 10 }))
    expectRecognitionError([stroke], 'LIMIT_EXCEEDED', { maxPoints: 30 })
  })

  it('非法 settings（0/负数）→ INVALID_INPUT', () => {
    expectRecognitionError([[{ x: 0, y: 0 }, { x: 40, y: 0 }]], 'INVALID_INPUT', { minBondLength: 0 })
    expectRecognitionError([[{ x: 0, y: 0 }, { x: 40, y: 0 }]], 'INVALID_INPUT', { snapDistance: -1 })
  })

  it('无法识别的笔迹 → UNRECOGNIZED 且信息为中文', () => {
    expectRecognitionError([[{ x: 100, y: 100 }], [{ x: 140, y: 140 }]], 'UNRECOGNIZED')
  })
})
