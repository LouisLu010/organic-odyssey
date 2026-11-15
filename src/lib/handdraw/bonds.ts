import {
  bounds,
  boundsDiagonal,
  boundsHeight,
  boundsWidth,
  dedupePoints,
  distance,
  distanceToSegment,
  lineAngle,
  parallelAngleDifference,
  parallelOffset,
  parallelOverlap,
  polygonArea,
  projection,
  segmentsIntersect,
  unitVector,
} from './geometry'
import type { BondLine, HanddrawPoint, HanddrawStroke, InkExtraction, MergedBond, Settings } from './types'

/** 无法可靠估计键长时的回退尺度（画布像素）。 */
const FALLBACK_SCALE = 44
const MIN_SCALE = 16
const MAX_SCALE = 140

/** 拐角检测参数：以弧长窗口度量方向变化，并用 3 倍窗口确认“拐角是局部的”。 */
const CORNER_WINDOW = 5
const CORNER_MIN_TURN = 0.28
const CORNER_WINDOW_RATIO = 1.8
const CORNER_CLUSTER_ARC = 6
const SMOOTH_ITERATIONS = 2

/** RDP 顶点后处理：方向变化小于该角度的顶点视为“浅弯”并合并。 */
const FLATTEN_TURN = 0.35
/** 无拐角笔迹允许的弓形程度：弦高 / 弦长，超过则视为圆弧而不是键线。 */
const ARC_DEVIATION_RATIO = 0.22

/** 开放折线顶点清理：两端手抖小勾 / 中间短夹边的合并阈值（相对 scale）。 */
const OPEN_SHORT_EDGE_FACTOR = 0.3
/** 浅折角合并阈值（弧度，约 38°）；真实折线链/六边形拐角约 60°，不会误并。 */
const SHALLOW_FOLD_TURN = 0.66
/** 短夹边两端转角都很尖锐时更像“真的画短了”：保留并提示，而不是当手抖吞掉。 */
const SHARP_SHOULDER_TURN = 0.85
/** 扫描拐角与已有顶点的最小间距（相对 scale），避免重复加顶点产生碎线段。 */
const CORNER_SNAP_FACTOR = 0.05
/** 长弯曲笔画作为“弓形键”输出的条件：路径长、弦长够、弯曲不过分。 */
const BOWED_BOND_PATH_FACTOR = 1.05
const BOWED_BOND_CHORD_FACTOR = 0.55
const BOWED_BOND_BULGE_RATIO = 0.32
/** 弯到可能是“圆角拐角画成弧线”的程度：路径明显长于键长时在鼓出最大处切开补回顶点。 */
const BOWED_BOND_SPLIT_PATH_FACTOR = 1.35

/** 多重键合并参数。间距以 scale 为单位，同时用 settings.parallelDistance 约束重画判定。 */
const MERGE_ANGLE = Math.PI / 12
const MERGE_OVERLAP_RATIO = 0.5
const MERGE_LENGTH_RATIO = 0.25
const MERGE_MIN_SPACING_FACTOR = 0.07
/** 折返重描的方向余弦阈值：约 139° 以上视为“画过去又折回”。 */
const FOLD_BACK_COSINE = -0.75

/** 安全上限：避免极端噪点输入让 RDP 退化；正常键线式远低于该值。 */
const MAX_SIMPLIFY_VERTICES = 600
const MAX_SEGMENTS = 320

const WARNING_SHORT = '已忽略过短的键线，请把化学键画长一些。'
const WARNING_REDRAW = '已将同一位置的重画笔迹按一根键处理。'
const WARNING_TOO_MANY_PARALLEL = '检测到超过三条邻近平行线，已按三键保留；请检查是否有多画的线。'
const WARNING_FOLD_BACK = '检测到折返重描，已按单键处理；如需双键请并排画两条平行线。'
const WARNING_RING_DISCARD = '已忽略自相交或拐点过多的闭合笔迹，请把环的直边画清楚（3～8 个顶点）。'
const WARNING_LIMIT = '识别出的线段太多，请只绘制一个较清晰的结构。'

/** 清洗后的几何参数；非法值回退到默认值，保证纯函数对坏输入也不崩溃。 */
interface EffectiveSettings {
  simplifyTolerance: number
  minBondLength: number
  snapDistance: number
  parallelDistance: number
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function effectiveSettings(settings: Settings | undefined): EffectiveSettings {
  const raw: Partial<Settings> = settings && typeof settings === 'object' ? settings : {}
  return {
    simplifyTolerance: positiveOr(raw.simplifyTolerance, 4),
    minBondLength: positiveOr(raw.minBondLength, 12),
    snapDistance: positiveOr(raw.snapDistance, 11),
    parallelDistance: positiveOr(raw.parallelDistance, 12),
  }
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return FALLBACK_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function makePoint(x: number, y: number): HanddrawPoint {
  return { x, y }
}

function copyPoint(point: HanddrawPoint): HanddrawPoint {
  return { x: point.x, y: point.y }
}

function makeLine(a: HanddrawPoint, b: HanddrawPoint, strokeIndex: number): BondLine {
  return { a: copyPoint(a), b: copyPoint(b), strokeIndex }
}

function lineLength(line: BondLine): number {
  return distance(line.a, line.b)
}

/** 方向变化：向量 a→b 与 b→c 的夹角，0 表示直行，π 表示折返。 */
function directionTurn(a: HanddrawPoint, b: HanddrawPoint, c: HanddrawPoint): number {
  const firstX = b.x - a.x
  const firstY = b.y - a.y
  const secondX = c.x - b.x
  const secondY = c.y - b.y
  const lengths = Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY)
  if (!(lengths > 1e-9)) return 0
  const cosine = (firstX * secondX + firstY * secondY) / lengths
  return Math.acos(Math.max(-1, Math.min(1, cosine)))
}

/** 两条有向线段的书写方向是否近似相反（折返重描）。 */
function isAntiParallelDirected(first: BondLine, second: BondLine): boolean {
  const firstUnit = unitVector(first.a, first.b)
  const secondUnit = unitVector(second.a, second.b)
  return firstUnit.x * secondUnit.x + firstUnit.y * secondUnit.y <= FOLD_BACK_COSINE
}

function cumulativeArcLengths(points: readonly HanddrawPoint[]): number[] {
  const cumulative = [0]
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]))
  }
  return cumulative
}

/** 按弧长取折线上的一点；closed 为真时环回，否则截断到首尾点。 */
function pointAtArc(points: readonly HanddrawPoint[], cumulative: readonly number[], arc: number, closed: boolean): HanddrawPoint {
  const last = points.length - 1
  const total = cumulative[last]
  if (!(total > 0)) return copyPoint(points[0])
  let target = arc
  if (closed) {
    target %= total
    if (target < 0) target += total
  } else {
    if (target <= 0) return copyPoint(points[0])
    if (target >= total) return copyPoint(points[last])
  }
  let low = 0
  let high = last
  while (low < high) {
    const middle = (low + high) >> 1
    if (cumulative[middle] < target) low = middle + 1
    else high = middle
  }
  if (low === 0) return copyPoint(points[0])
  const segmentLength = cumulative[low] - cumulative[low - 1]
  const ratio = segmentLength > 0 ? (target - cumulative[low - 1]) / segmentLength : 0
  const from = points[low - 1]
  const to = points[low]
  return makePoint(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)
}

/** 某点前后各 window 弧长范围内的方向变化，抗手抖。 */
function turnAtArc(points: readonly HanddrawPoint[], cumulative: readonly number[], arc: number, window: number, closed: boolean): number {
  const current = pointAtArc(points, cumulative, arc, closed)
  const before = pointAtArc(points, cumulative, arc - window, closed)
  const after = pointAtArc(points, cumulative, arc + window, closed)
  const incomingX = current.x - before.x
  const incomingY = current.y - before.y
  const outgoingX = after.x - current.x
  const outgoingY = after.y - current.y
  const lengths = Math.hypot(incomingX, incomingY) * Math.hypot(outgoingX, outgoingY)
  if (!(lengths > 1e-9)) return 0
  const cosine = (incomingX * outgoingX + incomingY * outgoingY) / lengths
  return Math.acos(Math.max(-1, Math.min(1, cosine)))
}

/** 加权移动平均，用于抑制高频手抖后再测量方向。 */
function smoothPolyline(points: readonly HanddrawPoint[], iterations: number): HanddrawPoint[] {
  let current = points.map(copyPoint)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next: HanddrawPoint[] = []
    for (let index = 0; index < current.length; index += 1) {
      if (index === 0 || index === current.length - 1) {
        next.push(copyPoint(current[index]))
        continue
      }
      const before = current[index - 1]
      const middle = current[index]
      const after = current[index + 1]
      next.push(makePoint((before.x + 2 * middle.x + after.x) / 4, (before.y + 2 * middle.y + after.y) / 4))
    }
    current = next
  }
  return current
}

interface CornerCandidate {
  index: number
  arc: number
  strength: number
}

/**
 * 扫描整条折线找“局部拐角”：小窗口内方向变化明显，且 3 倍窗口不会继续同比例变大。
 * 圆弧/圆的方向变化随窗口线性增长，会被比值条件排除；折线拐角则集中在很小一段。
 */
function findSharpCorners(rawPoints: readonly HanddrawPoint[], closed: boolean): CornerCandidate[] {
  if (rawPoints.length < 3) return []
  const points = smoothPolyline(rawPoints, SMOOTH_ITERATIONS)
  const cumulative = cumulativeArcLengths(points)
  const total = cumulative[cumulative.length - 1]
  if (!(total > CORNER_WINDOW * 2)) return []
  const candidates: CornerCandidate[] = []
  for (let index = 0; index < points.length; index += 1) {
    const arc = cumulative[index]
    // 开放折线首尾附近的窗口会被截断，测量不可靠，直接跳过。
    if (!closed && (arc < CORNER_WINDOW * 2 || total - arc < CORNER_WINDOW * 2)) continue
    const turn = turnAtArc(points, cumulative, arc, CORNER_WINDOW, closed)
    if (turn < CORNER_MIN_TURN) continue
    const wideTurn = turnAtArc(points, cumulative, arc, CORNER_WINDOW * 3, closed)
    if (wideTurn > turn * CORNER_WINDOW_RATIO) continue
    candidates.push({ index, arc, strength: turn })
  }
  const clusters: CornerCandidate[][] = []
  for (const candidate of candidates) {
    const cluster = clusters.find(group => {
      const gap = Math.abs(candidate.arc - group[0].arc)
      const cyclicGap = closed ? total - gap : gap
      return Math.min(gap, cyclicGap) <= CORNER_CLUSTER_ARC
    })
    if (cluster) cluster.push(candidate)
    else clusters.push([candidate])
  }
  return clusters
    .map(group => group.reduce((best, candidate) => (candidate.strength > best.strength ? candidate : best)))
    .sort((left, right) => left.arc - right.arc)
}

/** 带下标的 RDP 简化；返回保留点的原始下标。 */
function simplifyIndices(points: readonly HanddrawPoint[], tolerance: number): number[] {
  const count = points.length
  if (count <= 2) return Array.from({ length: count }, (_, index) => index)
  const keep = new Set<number>([0, count - 1])
  const stack: [number, number][] = [[0, count - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    let largest = tolerance
    let selected = -1
    for (let index = start + 1; index < end; index += 1) {
      const deviation = projection(points[index], points[start], points[end]).distance
      if (deviation > largest) {
        largest = deviation
        selected = index
      }
    }
    if (selected >= 0) {
      keep.add(selected)
      stack.push([start, selected], [selected, end])
      if (keep.size > MAX_SIMPLIFY_VERTICES) break
    }
  }
  return [...keep].sort((left, right) => left - right)
}

/** 合并方向变化很小的 RDP 顶点，把轻微弓形的键线还原成一条直线。 */
function flattenVertices(points: readonly HanddrawPoint[], indices: readonly number[], turnThreshold: number): number[] {
  if (indices.length <= 2) return [...indices]
  const flattened: number[] = [indices[0]]
  for (let position = 1; position < indices.length - 1; position += 1) {
    const previous = flattened[flattened.length - 1]
    const current = indices[position]
    const next = indices[position + 1]
    const turn = directionTurn(points[previous], points[current], points[next])
    if (turn >= turnThreshold) flattened.push(current)
  }
  flattened.push(indices[indices.length - 1])
  return flattened
}

/** 由全部笔迹估计“典型键长”，忽略字母/圆圈等短笔迹。 */
function estimateScale(strokes: readonly HanddrawStroke[], settings: EffectiveSettings): number {
  const runs: number[] = []
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) continue
    const points = dedupePoints(stroke, 0.6)
    if (points.length < 2) continue
    const pathLength = points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0)
    if (!(pathLength > 0)) continue
    const gap = distance(points[0], points[points.length - 1])
    const closedLoopCandidate = gap <= Math.max(settings.snapDistance, pathLength * 0.08)
    // 没有任何尖角的闭合笔迹是圆/椭圆/字母 O：它的弦长不是键长，跳过。
    if (closedLoopCandidate) {
      const loop = [...points.map(copyPoint), copyPoint(points[0])]
      if (findSharpCorners(loop, true).length === 0) continue
    }
    const indices = simplifyIndices(points, settings.simplifyTolerance)
    const flattened = flattenVertices(points, indices, FLATTEN_TURN)
    for (let position = 1; position < flattened.length; position += 1) {
      const length = distance(points[flattened[position - 1]], points[flattened[position]])
      if (Number.isFinite(length) && length > 1) runs.push(length)
    }
  }
  if (!runs.length) return FALLBACK_SCALE
  runs.sort((left, right) => left - right)
  // 手写字母的笔画通常远短于键长；只在“最长的一簇”直线段里取中位数，
  // 既不会被大量字母短笔迹拉低，也不会被个别超长涂抹带偏。
  const longest = runs[runs.length - 1]
  const threshold = Math.max(longest * 0.8, Math.min(longest, settings.minBondLength))
  const selected = runs.filter(length => length >= threshold)
  if (!selected.length) return FALLBACK_SCALE
  const middle = selected.length >> 1
  const median = selected.length % 2 ? selected[middle] : (selected[middle - 1] + selected[middle]) / 2
  return clampScale(median)
}

/** 到首尾弦的最大偏离，用于区分“略微弓形的键线”和“明显圆弧”。 */
function maximumChordDeviation(points: readonly HanddrawPoint[]): number {
  if (points.length < 2) return 0
  const first = points[0]
  const last = points[points.length - 1]
  let maximum = 0
  for (const point of points) {
    const deviation = distanceToSegment(point, first, last)
    if (Number.isFinite(deviation) && deviation > maximum) maximum = deviation
  }
  return maximum
}

/** 环上折线点在每条边弦上的最大偏差：圆弧会明显鼓出，手绘直边只有手抖。 */
function ringEdgeDeviations(points: readonly HanddrawPoint[], cornerIndices: readonly number[]): number[] {
  const deviations: number[] = []
  for (let position = 0; position < cornerIndices.length; position += 1) {
    const start = cornerIndices[position]
    const end = cornerIndices[(position + 1) % cornerIndices.length]
    const chordFrom = points[start]
    const chordTo = points[end]
    let maximum = 0
    if (end > start) {
      for (let index = start + 1; index < end; index += 1) {
        const deviation = distanceToSegment(points[index], chordFrom, chordTo)
        if (deviation > maximum) maximum = deviation
      }
    } else {
      for (let index = start + 1; index < points.length; index += 1) {
        const deviation = distanceToSegment(points[index], chordFrom, chordTo)
        if (deviation > maximum) maximum = deviation
      }
      for (let index = 1; index < end; index += 1) {
        const deviation = distanceToSegment(points[index], chordFrom, chordTo)
        if (deviation > maximum) maximum = deviation
      }
    }
    deviations.push(maximum)
  }
  return deviations
}

/** 在给定弧长区间内寻找最强的“拐角样”采样点，用于补回漏检的偏弱拐角。 */
function findCornerInArc(
  points: readonly HanddrawPoint[],
  cumulative: readonly number[],
  fromArc: number,
  toArc: number,
  closed: boolean,
  totalArc?: number,
): CornerCandidate | undefined {
  const total = totalArc ?? cumulative[cumulative.length - 1]
  let best: CornerCandidate | undefined
  for (let index = 0; index < points.length; index += 1) {
    let arc = cumulative[index]
    let relative = arc - fromArc
    const span = toArc - fromArc
    if (closed && span < 0) relative += total
    if (relative < 0 || relative > (span < 0 ? span + total : span)) continue
    if (closed) {
      arc %= total
    }
    if (!closed && (arc < CORNER_WINDOW * 2 || total - arc < CORNER_WINDOW * 2)) continue
    const turn = turnAtArc(points, cumulative, cumulative[index], CORNER_WINDOW, closed)
    const wideTurn = turnAtArc(points, cumulative, cumulative[index], CORNER_WINDOW * 3, closed)
    if (wideTurn > turn * 2.4) continue
    if (!best || turn > best.strength) best = { index, arc, strength: turn }
  }
  if (best && best.strength >= 0.15) return best
  return undefined
}

type ClosedAnalysis =
  | { kind: 'circle' }
  | { kind: 'smooth' }
  | { kind: 'invalid' }
  | { kind: 'ring'; segments: BondLine[] }
  | { kind: 'open' }

interface RingCorner {
  index: number
  arc: number
  strength: number
}

/**
 * 合并空间上近似重合的拐点，并识别“同一笔把同一个环画了两圈/重描”。
 *
 * 自由绘画下用户容易沿同一路径重描：同一顶点会在路径后段再次出现，
 * 按空间距离聚类即可合并；若合并的两个拐点沿路径相距很远（超过约 0.12 周长），
 * 说明笔迹重复覆盖了同一段，应只保留第一圈（返回 repeatStartArc）。
 */
function clusterCoincidentCorners(
  loop: readonly HanddrawPoint[],
  corners: readonly RingCorner[],
  scale: number,
  total: number,
  minimumBondLength: number,
): { corners: RingCorner[]; repeatStartArc: number | undefined } {
  if (corners.length < 2) return { corners: corners.map(corner => ({ ...corner })), repeatStartArc: undefined }
  // 相邻拐点的典型空间间距：避免在“很短的真实边”上把两个不同的顶点合并。
  const gaps: number[] = []
  for (let position = 0; position < corners.length; position += 1) {
    gaps.push(distance(loop[corners[position].index], loop[corners[(position + 1) % corners.length].index]))
  }
  gaps.sort((left, right) => left - right)
  const medianGap = gaps[gaps.length >> 1]
  const threshold = Math.max(2.5, Math.min(scale * 0.22, medianGap * 0.35))
  const clusters: { representative: RingCorner; arcs: number[] }[] = []
  for (const corner of corners) {
    const point = loop[corner.index]
    const cluster = clusters.find(item => distance(loop[item.representative.index], point) <= threshold)
    if (cluster) cluster.arcs.push(corner.arc)
    else clusters.push({ representative: corner, arcs: [corner.arc] })
  }
  // 两个“重合拐点”在路径上相距足够远，才说明是把环重描了一遍。
  const repeatGap = Math.max(minimumBondLength * 2, total * 0.12)
  let repeatStartArc: number | undefined
  for (const cluster of clusters) {
    if (cluster.arcs.length < 2) continue
    const firstArc = cluster.arcs[0]
    for (let position = 1; position < cluster.arcs.length; position += 1) {
      if (cluster.arcs[position] - firstArc < repeatGap) continue
      const repeatArc = cluster.arcs[position]
      repeatStartArc = repeatStartArc === undefined ? repeatArc : Math.min(repeatStartArc, repeatArc)
      break
    }
  }
  return { corners: clusters.map(cluster => cluster.representative), repeatStartArc }
}

/** 由环上的拐角构造首尾相接的边，供环校验复用。 */
function buildRingSegments(loop: readonly HanddrawPoint[], indices: readonly number[], strokeIndex: number): BondLine[] {
  const segments: BondLine[] = []
  for (let position = 0; position < indices.length; position += 1) {
    segments.push(makeLine(loop[indices[position]], loop[indices[(position + 1) % indices.length]], strokeIndex))
  }
  return segments
}

/** 环上非相邻边是否相交（自相交笔迹不能当环）。 */
function ringSelfIntersects(segments: readonly BondLine[]): boolean {
  for (let first = 0; first < segments.length; first += 1) {
    for (let second = first + 1; second < segments.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === segments.length - 1)) continue
      if (segmentsIntersect(segments[first], segments[second])) return true
    }
  }
  return false
}

/** 闭合笔迹：先排除圆/椭圆类整笔，再尝试还原 3～8 元环的每条直边。 */
function analyzeClosedStroke(
  points: readonly HanddrawPoint[],
  strokeIndex: number,
  scale: number,
  settings: EffectiveSettings,
  warnings: Set<string>,
): ClosedAnalysis {
  const loop = [...points.map(copyPoint), copyPoint(points[0])]
  const rawCorners = findSharpCorners(loop, true)
  // 没有任何尖角：圆、椭圆或字母 O，整笔留给 glyph 识别，不下探成折线。
  if (rawCorners.length === 0) return { kind: 'circle' }
  if (rawCorners.length < 3) return { kind: 'open' }
  let corners: RingCorner[] = rawCorners.map(corner => ({
    ...corner,
    index: corner.index >= loop.length - 1 ? 0 : corner.index,
  }))
  const smoothed = smoothPolyline(loop, SMOOTH_ITERATIONS)
  const cumulative = cumulativeArcLengths(smoothed)
  const total = cumulative[cumulative.length - 1]
  // 把“落回起点”的拐角（其弧长接近总长）归一到起点位置，便于后续环边校验。
  corners = corners
    .map(corner => (corner.index === 0 && corner.arc > total * 0.5 ? { ...corner, arc: 0 } : corner))
    .sort((left, right) => left.arc - right.arc)

  // 自由绘画常见“同一圈重描两遍”：先合并近似重合的拐点，再只保留第一圈。
  const clustered = clusterCoincidentCorners(loop, corners, scale, total, settings.minBondLength)
  corners = clustered.corners
  let ringLoop: HanddrawPoint[] = loop
  let ringTotal = total
  if (clustered.repeatStartArc !== undefined) {
    let cut = loop.length - 1
    for (let index = 0; index < loop.length; index += 1) {
      if (cumulative[index] >= clustered.repeatStartArc - 1e-6) {
        cut = index
        break
      }
    }
    cut = Math.max(2, Math.min(cut, loop.length - 1))
    ringLoop = loop.slice(0, cut + 1).map(copyPoint)
    ringTotal = cumulative[cut]
    corners = corners.filter(corner => corner.arc < clustered.repeatStartArc! - 1e-6)
  }
  if (corners.length < 3) return { kind: 'open' }
  if (corners.length > 8) {
    warnings.add(WARNING_RING_DISCARD)
    return { kind: 'invalid' }
  }
  // 明显自相交的闭合涂鸦不是环，直接丢弃（但给提示，避免整笔静默消失）。
  if (ringSelfIntersects(buildRingSegments(ringLoop, corners.map(corner => corner.index), strokeIndex))) {
    warnings.add(WARNING_RING_DISCARD)
    return { kind: 'invalid' }
  }
  // 用围成的面积区分“圈/环”（面积大）与折返涂鸦（面积接近 0）。
  const diagonal = boundsDiagonal(bounds(points))
  const loopRatio = diagonal > 0 ? polygonArea(ringLoop) / (diagonal * diagonal) : 1
  if (loopRatio < 0.12) return { kind: 'open' }

  // 漏检拐角会让某条边明显偏长：在长边中段补一个最像拐角的采样点。
  for (let attempt = 0; attempt < 3 && corners.length < 8; attempt += 1) {
    const arclengths = corners.map(corner => corner.arc)
    const edgeArcLengths: number[] = []
    for (let index = 0; index < corners.length; index += 1) {
      const next = (index + 1) % corners.length
      edgeArcLengths.push(next > index ? arclengths[next] - arclengths[index] : ringTotal - arclengths[index] + arclengths[next])
    }
    const sortedArcLengths = edgeArcLengths.slice().sort((left, right) => left - right)
    const medianArc = sortedArcLengths[Math.floor(sortedArcLengths.length / 2)]
    let longestPosition = 0
    for (let index = 1; index < edgeArcLengths.length; index += 1) if (edgeArcLengths[index] > edgeArcLengths[longestPosition]) longestPosition = index
    const longestEdge = edgeArcLengths[longestPosition]
    if (longestEdge <= medianArc * 1.7) break
    const startArc = arclengths[longestPosition]
    const endArc = arclengths[(longestPosition + 1) % corners.length]
    const inserted = findCornerInArc(smoothed, cumulative, startArc + longestEdge * 0.25, endArc - longestEdge * 0.25, true, ringTotal)
    if (!inserted) break
    corners = [...corners, { index: inserted.index >= loop.length - 1 ? 0 : inserted.index, arc: inserted.arc, strength: inserted.strength }]
      .sort((left, right) => left.arc - right.arc)
  }

  // 顶点太近（同一个拐角被拆成两个）时合并较弱的一个；真实短边不在这里修。
  const minimumEdge = settings.minBondLength
  while (corners.length > 3) {
    let shortest = Infinity
    let shortestPosition = -1
    for (let position = 0; position < corners.length; position += 1) {
      const length = distance(ringLoop[corners[position].index], ringLoop[corners[(position + 1) % corners.length].index])
      if (length < shortest) {
        shortest = length
        shortestPosition = position
      }
    }
    if (shortest >= minimumEdge * 0.3) break
    const first = shortestPosition
    const second = (shortestPosition + 1) % corners.length
    const removePosition = corners[first].strength <= corners[second].strength ? first : second
    corners = corners.filter((_, position) => position !== removePosition)
  }
  if (corners.length < 3) return { kind: 'open' }

  const ringSegments = buildRingSegments(ringLoop, corners.map(corner => corner.index), strokeIndex)
  const edgeLengths = ringSegments.map(lineLength)
  // 过短的边（差得比较多说明是真实短边而非重复拐点）：降级为折线，让后续过滤给出提示。
  if (edgeLengths.some(length => length < minimumEdge)) return { kind: 'open' }
  const sortedEdges = edgeLengths.slice().sort((left, right) => left - right)
  const medianEdge = sortedEdges[Math.floor(sortedEdges.length / 2)]
  if (sortedEdges[0] < medianEdge * 0.3) return { kind: 'open' }
  // 环上每条直边应接近键长尺度；明显偏短说明这是采样稀疏的圆/字母 O，而不是环。
  if (medianEdge < Math.max(minimumEdge, scale * 0.4)) {
    const width = boundsWidth(bounds(ringLoop))
    const height = boundsHeight(bounds(ringLoop))
    const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height))
    // 又扁又窄的闭合笔迹不是圆，丢弃时给提示，避免整笔静默消失。
    if (aspect > 1.6) {
      warnings.add(WARNING_RING_DISCARD)
      return { kind: 'invalid' }
    }
    return { kind: 'circle' }
  }
  // 边明显鼓起说明是圆弧而不是直边；有 3 个以上拐角却无法成环时给出提示。
  const smoothLimit = Math.max(3, settings.simplifyTolerance * 1.5)
  const deviations = ringEdgeDeviations(ringLoop, corners.map(corner => corner.index))
  if (deviations.some(deviation => deviation > smoothLimit)) {
    warnings.add(WARNING_RING_DISCARD)
    return { kind: 'invalid' }
  }
  if (ringSelfIntersects(ringSegments)) {
    warnings.add(WARNING_RING_DISCARD)
    return { kind: 'invalid' }
  }
  return { kind: 'ring', segments: ringSegments }
}

/** 判断开放笔迹是否是“明显圆弧/字母笔画”（没有尖角且弯曲程度大）。 */
function isCurvedStroke(points: readonly HanddrawPoint[], settings: EffectiveSettings): boolean {
  if (points.length < 2) return false
  const chord = distance(points[0], points[points.length - 1])
  const deviation = maximumChordDeviation(points)
  if (!Number.isFinite(deviation)) return true
  if (chord < 1e-3) return deviation > Math.max(settings.simplifyTolerance, 3)
  return deviation > Math.max(settings.simplifyTolerance, chord * ARC_DEVIATION_RATIO)
}

/**
 * 开放笔迹后处理：识别折返重描，丢弃 U 形折返连接段，过滤过短线段并给出提示。
 * 返回的 BondLine 保留原始书写方向，便于 mergeBondLines 判断折返。
 */
function postProcessChain(
  chain: BondLine[],
  strokeExtent: number,
  scale: number,
  settings: EffectiveSettings,
  warnings: Set<string>,
): BondLine[] {
  const minimum = settings.minBondLength
  const connectorLimit = Math.max(minimum * 1.6, scale * 0.8)
  // 折返连接段（U 形转弯）可能略长于最短键长，按尺度给一个更宽的上限。
  const connectorSegmentLimit = Math.max(minimum, scale * 0.22)
  const folded: BondLine[] = []
  let position = 0
  while (position < chain.length) {
    const current = chain[position]
    const currentLength = lineLength(current)
    // 形态一：长线 — 一串短线（U 形折返）— 长线，且两条长线反向近似平行。
    if (currentLength >= minimum) {
      let scan = position + 1
      let connectorLength = 0
      while (scan < chain.length && lineLength(chain[scan]) < connectorSegmentLimit) {
        connectorLength += lineLength(chain[scan])
        scan += 1
      }
      if (scan < chain.length) {
        const other = chain[scan]
        const otherLength = lineLength(other)
        if (
          scan > position + 1
          && otherLength >= minimum
          && connectorLength <= connectorLimit
          && connectorLength <= Math.min(currentLength, otherLength) * 0.8
          && isAntiParallelDirected(current, other)
          && distance(current.b, other.a) <= connectorLength + 2
        ) {
          folded.push(current)
          position = scan
          continue
        }
      } else if (folded.length > 0 && connectorLength <= connectorLimit) {
        // 折返最后一段连接线回到起点（一笔画出的闭合双键）：静默丢弃。
        const endPoint = chain[chain.length - 1].b
        if (distance(endPoint, folded[0].a) <= connectorLimit && isAntiParallelDirected(current, folded[0])) {
          folded.push(current)
          break
        }
      }
    }
    // 形态二：两条长线首尾相接、书写方向相反（画过去又折回）。
    if (position + 1 < chain.length) {
      const next = chain[position + 1]
      const nextLength = lineLength(next)
      if (currentLength >= minimum && nextLength >= minimum && isAntiParallelDirected(current, next)) {
        const farSeparation = distance(current.a, next.b)
        if (farSeparation <= Math.max(2.5, scale * 0.1)) {
          // 几乎完全重描：按单键处理，避免输出两条重合线的非法双键。
          folded.push(currentLength >= nextLength ? current : next)
          warnings.add(WARNING_FOLD_BACK)
          position += 2
          continue
        }
        folded.push(current)
        folded.push(next)
        position += 2
        continue
      }
    }
    folded.push(current)
    position += 1
  }

  const segments: BondLine[] = []
  let droppedShort = 0
  for (const segment of folded) {
    const length = lineLength(segment)
    if (length >= minimum) segments.push(segment)
    else droppedShort = Math.max(droppedShort, length)
  }
  // 只有整笔明显是键线级别（长度接近 scale）、且被丢弃的确实是“差一点”的键线时才提示；
  // 字母/电荷/折返连接段等短笔迹不刷提示，避免用户误以为画错。
  if (droppedShort >= minimum * 0.45 && strokeExtent >= Math.max(minimum, scale * 0.7)) warnings.add(WARNING_SHORT)
  return segments
}

/**
 * 开放折线顶点清理（自由绘画鲁棒性）：
 * 1) 去掉笔画首尾的手抖小勾（短边处的端点）；
 * 2) 合并中间的手抖短夹边（两端转角都不尖锐时），避免碎线段产生假原子；
 * 3) 合并浅折角（转向 < ~38°，或转向较小且相邻边偏短），避免手抖弯折被当成碳原子。
 * 两端转角都很尖锐的短夹边保留，交给后续过滤并提示“画长一些”。
 */
function cleanupOpenVertices(
  points: readonly HanddrawPoint[],
  vertices: readonly number[],
  scale: number,
  settings: EffectiveSettings,
): number[] {
  const shortEdge = Math.max(settings.minBondLength * 1.5, scale * OPEN_SHORT_EDGE_FACTOR)
  let result = [...vertices]
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false
    // 首尾手抖小勾：很短的内侧边（或短边 + 尖锐小勾）去掉端点，保留内侧真实顶点。
    const endpointStub = Math.max(settings.minBondLength, scale * 0.18)
    if (result.length > 2) {
      const leading = distance(points[result[0]], points[result[1]])
      const leadingTurn = directionTurn(points[result[0]], points[result[1]], points[result[2]])
      if (leading < endpointStub || (leading < shortEdge && leadingTurn >= SHARP_SHOULDER_TURN)) {
        result = result.slice(1)
        changed = true
      }
    }
    if (result.length > 2) {
      const trailingStart = result.length - 2
      const trailing = distance(points[result[trailingStart]], points[result[trailingStart + 1]])
      const trailingTurn = directionTurn(points[result[trailingStart - 1]], points[result[trailingStart]], points[result[trailingStart + 1]])
      if (trailing < endpointStub || (trailing < shortEdge && trailingTurn >= SHARP_SHOULDER_TURN)) {
        result = result.slice(0, -1)
        changed = true
      }
    }
    // 中间短夹边：两端转角都尖锐时保留，否则合并成一个顶点。
    for (let index = 1; index + 2 < result.length; index += 1) {
      const before = points[result[index - 1]]
      const current = points[result[index]]
      const next = points[result[index + 1]]
      const following = points[result[index + 2]]
      if (distance(current, next) >= shortEdge) continue
      const turnBefore = directionTurn(before, current, next)
      const turnAfter = directionTurn(current, next, following)
      if (turnBefore >= SHARP_SHOULDER_TURN && turnAfter >= SHARP_SHOULDER_TURN) continue
      const outerBefore = distance(before, current)
      const outerAfter = distance(next, following)
      result = outerBefore >= outerAfter
        ? result.filter((_, position) => position !== index + 1)
        : result.filter((_, position) => position !== index)
      changed = true
    }
    // 浅折角：转向很小，或转向较小且相邻有短边时合并。
    for (let index = 1; index + 1 < result.length; index += 1) {
      const before = points[result[index - 1]]
      const current = points[result[index]]
      const next = points[result[index + 1]]
      const turn = directionTurn(before, current, next)
      if (turn >= SHALLOW_FOLD_TURN) continue
      if (turn >= 0.5 && Math.min(distance(before, current), distance(current, next)) >= scale * 0.5) continue
      result = result.filter((_, position) => position !== index)
      changed = true
      break
    }
    if (!changed) break
  }
  return result
}

/** 由保留顶点构造连续线段链。 */
function buildChain(points: readonly HanddrawPoint[], vertices: readonly number[], strokeIndex: number): BondLine[] {
  const chain: BondLine[] = []
  for (let position = 1; position < vertices.length; position += 1) {
    const from = points[vertices[position - 1]]
    const to = points[vertices[position]]
    if (distance(from, to) < 0.5) continue
    chain.push(makeLine(from, to, strokeIndex))
  }
  return chain
}

/** 开放笔迹：折线链、弓形单键或圆弧/字母笔画。 */
function analyzeOpenStroke(
  points: readonly HanddrawPoint[],
  strokeIndex: number,
  scale: number,
  settings: EffectiveSettings,
  warnings: Set<string>,
): BondLine[] {
  const corners = findSharpCorners(points, false)
  const last = points.length - 1
  const chord = distance(points[0], points[last])
  const pathLength = points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0)
  if (corners.length === 0) {
    // 没有尖角也有可能是“一笔画双键”：两段平行长线由圆弧/U 形连接（没有明显折返角）。
    const smoothIndices = flattenVertices(points, simplifyIndices(points, settings.simplifyTolerance), FLATTEN_TURN)
    if (smoothIndices.length > 3) {
      const probeWarnings = new Set<string>()
      const processed = postProcessChain(buildChain(points, smoothIndices, strokeIndex), boundsDiagonal(bounds(points)), scale, settings, probeWarnings)
      if (processed.length === 2 && isAntiParallelDirected(processed[0], processed[1])) {
        for (const warning of probeWarnings) warnings.add(warning)
        return processed
      }
    }
    // 手画的环边常是弧线：够长的弯曲笔画按“弓形键”输出，只有短弧/圈类留给 glyph。
    if (isCurvedStroke(points, settings)) {
      const deviation = maximumChordDeviation(points)
      const bulged = chord < 1e-3 ? Infinity : deviation / chord
      const longEnough = pathLength >= scale * BOWED_BOND_PATH_FACTOR
      const chordEnough = chord >= Math.max(settings.minBondLength, scale * BOWED_BOND_CHORD_FACTOR)
      if (longEnough && chordEnough && bulged <= BOWED_BOND_BULGE_RATIO) {
        // 鼓得明显时可能是“圆角拐角画成了弧线”：在离弦最远处切开，补回顶点。
        if (bulged >= 0.16 && pathLength >= scale * BOWED_BOND_SPLIT_PATH_FACTOR) {
          let bulgeIndex = -1
          let bulgeDeviation = -1
          for (let index = 1; index < last; index += 1) {
            const deviation = distanceToSegment(points[index], points[0], points[last])
            if (deviation > bulgeDeviation) {
              bulgeDeviation = deviation
              bulgeIndex = index
            }
          }
          const minimumHalf = Math.max(settings.minBondLength, scale * 0.4)
          if (bulgeIndex > 0 && distance(points[0], points[bulgeIndex]) >= minimumHalf && distance(points[bulgeIndex], points[last]) >= minimumHalf) {
            return [
              makeLine(points[0], points[bulgeIndex], strokeIndex),
              makeLine(points[bulgeIndex], points[last], strokeIndex),
            ]
          }
        }
        return [makeLine(points[0], points[last], strokeIndex)]
      }
      return []
    }
    if (chord >= settings.minBondLength) return [makeLine(points[0], points[last], strokeIndex)]
    // 过短的直笔迹（电荷符号、标点等）不刷提示，交给装配器的“未识别”提示。
    return []
  }
  const indices = flattenVertices(points, simplifyIndices(points, settings.simplifyTolerance), FLATTEN_TURN)
  const vertices: number[] = []
  for (const index of indices) {
    if (index < 0 || index >= points.length) continue
    if (vertices.length && index <= vertices[vertices.length - 1]) continue
    vertices.push(index)
  }
  // 扫描到的拐角只在与现成顶点相距足够远时补入，避免碎线段（手抖小勾）。
  const cornerSnap = Math.max(4, scale * CORNER_SNAP_FACTOR)
  for (const corner of corners) {
    if (vertices.includes(corner.index)) continue
    if (vertices.some(index => distance(points[index], points[corner.index]) < cornerSnap)) continue
    vertices.push(corner.index)
  }
  vertices.sort((left, right) => left - right)
  // 补上真正的首尾点，并合并几乎重合的相邻顶点（RDP 顶点与拐角扫描可能重复）。
  if (vertices[0] !== 0) vertices.unshift(0)
  if (vertices[vertices.length - 1] !== last) vertices.push(last)
  const nearVertex = Math.max(2, settings.minBondLength * 0.2)
  const mergedVertices: number[] = []
  for (const index of vertices) {
    const previous = mergedVertices[mergedVertices.length - 1]
    if (previous !== undefined && distance(points[previous], points[index]) < nearVertex) {
      // 保留更靠外的那一个，让线段端点尽量贴近真实笔画端点。
      if (index === last) mergedVertices[mergedVertices.length - 1] = index
      continue
    }
    mergedVertices.push(index)
  }
  const cleaned = cleanupOpenVertices(points, mergedVertices, scale, settings)
  if (cleaned.length < 2) return []
  const chain = buildChain(points, cleaned, strokeIndex)
  if (!chain.length) return []
  const strokeExtent = boundsDiagonal(bounds(points))
  return postProcessChain(chain, strokeExtent, scale, settings, warnings)
}

function analyzeStroke(
  stroke: HanddrawStroke,
  strokeIndex: number,
  scale: number,
  settings: EffectiveSettings,
  warnings: Set<string>,
): BondLine[] {
  if (!Array.isArray(stroke)) return []
  const points = dedupePoints(stroke, 0.6)
  if (points.length < 2) return []
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return []
  }
  const pathLength = points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0)
  if (!(pathLength > 0)) return []
  const gap = distance(points[0], points[points.length - 1])
  // 与装配器的端点吸附阈值保持一致：端点会被吸到一起的笔迹才按“闭合”理解。
  const closeGap = Math.max(settings.snapDistance, Math.min(scale * 0.24, 24))
  const closedCandidate = gap <= closeGap && pathLength >= settings.minBondLength * 2.2
  if (closedCandidate) {
    const analysis = analyzeClosedStroke(points, strokeIndex, scale, settings, warnings)
    if (analysis.kind === 'ring') return analysis.segments
    if (analysis.kind === 'circle' || analysis.kind === 'invalid') return []
    // 'smooth' / 'open'：不当作环，交给开放笔迹分析（圆弧仍会被判为曲线而丢弃）。
  }
  return analyzeOpenStroke(points, strokeIndex, scale, settings, warnings)
}

/**
 * 手写几何分析：估计键长尺度，把笔迹切成直线段候选，并给出提示。
 *
 * 只输出“键线候选直段”，不负责合并键级；字母/圆圈类整笔会被静默留给 glyph-engine，
 * 只有确实处理不了的键线几何才写中文提示。返回的线段顺序与输入笔迹顺序一致。
 */
export function extractInk(strokes: readonly HanddrawStroke[], settings: Settings): InkExtraction {
  const warnings = new Set<string>()
  if (!Array.isArray(strokes)) return { scale: FALLBACK_SCALE, segments: [], warnings: [] }
  const effective = effectiveSettings(settings)
  const scale = estimateScale(strokes, effective)
  const segments: BondLine[] = []
  for (let index = 0; index < strokes.length; index += 1) {
    segments.push(...analyzeStroke(strokes[index], index, scale, effective, warnings))
    if (segments.length > MAX_SEGMENTS) {
      // 与 handdraw.ts 的 LIMIT_EXCEEDED 检查呼应：这里不静默截断，只给出提示。
      warnings.add(WARNING_LIMIT)
      break
    }
  }
  return { scale, segments, warnings: [...warnings] }
}

export interface BondMergeResult {
  bonds: MergedBond[]
  warnings: string[]
}

interface WorkingLine {
  line: BondLine
  /** 输入线段下标，用于稳定排序。 */
  index: number
  length: number
}

interface LineGroup {
  /** 组内最长的一条线，作为代表线。 */
  representative: WorkingLine
  /** 同一位置重画的合并成员（第一条为 representative）。 */
  members: WorkingLine[]
}

/** 两条线段是否“几乎同位置”：方向接近、重叠足够、两端都贴在一起。 */
function isNearDuplicate(representative: WorkingLine, candidate: WorkingLine, tolerance: number): boolean {
  const first = representative.line
  const second = candidate.line
  const angle = parallelAngleDifference(lineAngle(first.a, first.b), lineAngle(second.a, second.b))
  if (angle > MERGE_ANGLE) return false
  const overlap = parallelOverlap(first, second)
  if (overlap < Math.min(representative.length, candidate.length) * MERGE_OVERLAP_RATIO) return false
  const offsetA = Math.abs(parallelOffset(first, second.a))
  const offsetB = Math.abs(parallelOffset(first, second.b))
  return Math.max(offsetA, offsetB) <= tolerance
}

/** 折返重描：同一笔画出、共享折返点、书写方向相反、两端分开一定距离。 */
function isFoldBackPair(
  representative: WorkingLine,
  candidate: WorkingLine,
  scale: number,
  minimumSpacing: number,
  maximumSpacing: number,
): boolean {
  const first = representative.line
  const second = candidate.line
  if (first.strokeIndex !== second.strokeIndex) return false
  const sharedTolerance = Math.max(2.5, scale * 0.05)
  let farSeparation = 0
  if (distance(first.b, second.a) <= sharedTolerance) farSeparation = distance(first.a, second.b)
  else if (distance(first.a, second.b) <= sharedTolerance) farSeparation = distance(first.b, second.a)
  else if (distance(first.a, second.a) <= sharedTolerance) farSeparation = distance(first.b, second.b)
  else return false
  if (!isAntiParallelDirected(first, second)) return false
  if (farSeparation > Math.max(representative.length, candidate.length) * 0.32) return false
  return farSeparation >= minimumSpacing && farSeparation <= maximumSpacing
}

/** 多重键允许的最大垂直间距：兼顾手绘双键与“并排的独立键”的区分。 */
function maximumMergeSpacing(scale: number, settings: EffectiveSettings): number {
  return Math.max(settings.parallelDistance, Math.min(scale * 0.3, 24))
}

/** 两条平行线能否组成同一根多重键。 */
function isMultiBondPair(
  representative: WorkingLine,
  candidate: WorkingLine,
  minimumSpacing: number,
  maximumSpacing: number,
): boolean {
  const first = representative.line
  const second = candidate.line
  const firstLength = representative.length
  const secondLength = candidate.length
  if (!(firstLength > 0) || !(secondLength > 0)) return false
  const longest = Math.max(firstLength, secondLength)
  if (Math.min(firstLength, secondLength) / longest < MERGE_LENGTH_RATIO) return false
  const angle = parallelAngleDifference(lineAngle(first.a, first.b), lineAngle(second.a, second.b))
  if (angle > MERGE_ANGLE) return false
  const overlap = parallelOverlap(first, second)
  if (overlap < Math.min(firstLength, secondLength) * MERGE_OVERLAP_RATIO) return false
  // 近平行但相交的线不能合并。
  if (segmentsIntersect(first, second)) return false
  const offsetA = parallelOffset(first, second.a)
  const offsetB = parallelOffset(first, second.b)
  const absoluteA = Math.abs(offsetA)
  const absoluteB = Math.abs(offsetB)
  const spacing = (absoluteA + absoluteB) / 2
  if (spacing < minimumSpacing || spacing > maximumSpacing) return false
  // 间距相对键长过大时更可能是并排的两根独立键。
  if (spacing > longest * 0.32) return false
  // 端点贴着代表线（共享端点/一端相交）的是支链或折返，不按平行双线合并。
  if (Math.min(absoluteA, absoluteB) < spacing * 0.25) return false
  if (offsetA * offsetB < 0 && Math.max(absoluteA, absoluteB) > minimumSpacing) return false
  return true
}

function representativeLine(group: LineGroup): WorkingLine {
  return group.members.reduce((best, member) => (member.length > best.length ? member : best))
}

function buildGroup(distinct: LineGroup[]): MergedBond {
  const allLines: WorkingLine[] = []
  for (const group of distinct) allLines.push(...group.members)
  allLines.sort((left, right) => right.length - left.length || left.index - right.index)
  const representative = allLines[0]
  return {
    a: copyPoint(representative.line.a),
    b: copyPoint(representative.line.b),
    order: Math.min(3, distinct.length),
    lines: allLines.map(member => member.line),
  }
}

function cleanLines(segments: readonly BondLine[]): WorkingLine[] {
  const lines: WorkingLine[] = []
  if (!Array.isArray(segments)) return lines
  for (let index = 0; index < segments.length; index += 1) {
    const line = segments[index]
    if (!line || !line.a || !line.b) continue
    const { x: ax, y: ay } = line.a
    const { x: bx, y: by } = line.b
    if (![ax, ay, bx, by].every(value => typeof value === 'number' && Number.isFinite(value))) continue
    const length = distance(line.a, line.b)
    if (!(length >= 0.5)) continue
    lines.push({ line: { a: copyPoint(line.a), b: copyPoint(line.b), strokeIndex: line.strokeIndex }, index, length })
  }
  return lines
}

/**
 * 把直线段候选合并成化学键（单键/双键/三键），并返回用户可见提示。
 *
 * 处理顺序：同一位置重画归并 → 平行线分组成多重键（含折返重描）→ 取最长成员线的端点作为代表端点。
 * 输出顺序与输入线段首次出现的顺序一致，保证同输入同输出。
 */
export function mergeBondLinesWithWarnings(
  segments: readonly BondLine[],
  settings: Settings,
  scale: number,
): BondMergeResult {
  const effective = effectiveSettings(settings)
  const safeScale = Number.isFinite(scale) && scale > 0 ? Math.min(scale, MAX_SCALE * 4) : FALLBACK_SCALE
  const lines = cleanLines(segments)
  const warnings = new Set<string>()
  if (!lines.length) return { bonds: [], warnings: [] }
  // 重画判定距离：略小于“双键最小间距”，保证间距 0.1*scale 左右的手绘双键仍能被当成双键。
  const duplicateDistance = Math.max(2, Math.min(effective.parallelDistance * 0.5, safeScale * 0.09))
  const minimumSpacing = Math.max(duplicateDistance * 1.15, safeScale * MERGE_MIN_SPACING_FACTOR)
  const maximumSpacing = maximumMergeSpacing(safeScale, effective)

  // 1. 按长度从长到短归并“几乎重合”的重画线；最长的一条代表这根键。
  const ordered = lines.slice().sort((left, right) => right.length - left.length || left.index - right.index)
  const groups: LineGroup[] = []
  for (const candidate of ordered) {
    const target = groups.find(group => isNearDuplicate(group.representative, candidate, duplicateDistance))
    if (target) {
      target.members.push(candidate)
      warnings.add(WARNING_REDRAW)
    } else {
      groups.push({ representative: candidate, members: [candidate] })
    }
  }
  groups.sort((left, right) => left.representative.index - right.representative.index)

  // 2. 以最长线为种子，把 band 宽度内的平行线聚成一根多重键。
  const consumed = new Set<LineGroup>()
  const bonds: { bond: MergedBond; key: number }[] = []
  for (const seed of groups) {
    if (consumed.has(seed)) continue
    consumed.add(seed)
    const distinct: LineGroup[] = [seed]
    // 只与“种子线”和“最新加入的线”比较：既支持沿相邻线传递分组
    // （四条间距略大的手绘平行线仍能收成三键），又保证 O(n²) 的复杂度。
    const compatibleWith = (member: WorkingLine, candidate: WorkingLine): boolean =>
      isMultiBondPair(member, candidate, minimumSpacing, maximumSpacing)
      || isFoldBackPair(member, candidate, safeScale, minimumSpacing, maximumSpacing)
    for (const candidate of groups) {
      if (consumed.has(candidate)) continue
      const last = representativeLine(distinct[distinct.length - 1])
      if (!compatibleWith(seed.representative, candidate.representative) && !compatibleWith(last, candidate.representative)) continue
      consumed.add(candidate)
      distinct.push(candidate)
    }
    if (distinct.length > 3) warnings.add(WARNING_TOO_MANY_PARALLEL)
    const bond = buildGroup(distinct)
    const key = Math.min(...distinct.flatMap(group => group.members.map(member => member.index)))
    bonds.push({ bond, key })
  }
  bonds.sort((left, right) => left.key - right.key)
  return { bonds: bonds.map(entry => entry.bond), warnings: [...warnings] }
}

/**
 * 把直线段候选合并成化学键（单键/双键/三键）。
 *
 * 由 bond-engine 实现；装配器在剔除原子标签笔迹后调用本函数。
 */
export function mergeBondLines(segments: readonly BondLine[], settings: Settings, scale: number): MergedBond[] {
  return mergeBondLinesWithWarnings(segments, settings, scale).bonds
}
