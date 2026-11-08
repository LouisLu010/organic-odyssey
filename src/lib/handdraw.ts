import type { EditorGraph } from './moleculeEditor'

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

export type HanddrawErrorCode = 'EMPTY' | 'INVALID_INPUT' | 'LIMIT_EXCEEDED' | 'UNRECOGNIZED'

export class HanddrawRecognitionError extends Error {
  readonly code: HanddrawErrorCode

  constructor(code: HanddrawErrorCode, message: string) {
    super(message)
    this.name = 'HanddrawRecognitionError'
    this.code = code
  }
}

interface Segment {
  a: HanddrawPoint
  b: HanddrawPoint
  order: number
}

interface Settings {
  snapDistance: number
  simplifyTolerance: number
  minBondLength: number
  parallelDistance: number
  maxStrokes: number
  maxPoints: number
}

const DEFAULTS: Settings = {
  snapDistance: 11,
  simplifyTolerance: 4,
  minBondLength: 12,
  parallelDistance: 12,
  maxStrokes: 160,
  maxPoints: 20000,
}
const MAX_SEGMENTS = 320
const PARALLEL_COSINE = Math.cos(Math.PI / 15)
const DUPLICATE_DISTANCE = 2.5

function distance(a: HanddrawPoint, b: HanddrawPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function projection(point: HanddrawPoint, a: HanddrawPoint, b: HanddrawPoint): { t: number; distance: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (!length) return { t: 0, distance: distance(point, a) }
  const t = ((point.x - a.x) * (dx / length) + (point.y - a.y) * (dy / length)) / length
  return { t, distance: distance(point, { x: a.x + Math.max(0, Math.min(1, t)) * dx, y: a.y + Math.max(0, Math.min(1, t)) * dy }) }
}

function simplify(points: HanddrawPoint[], tolerance: number): HanddrawPoint[] {
  if (points.length <= 2) return points.slice()
  const keep = new Set([0, points.length - 1])
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    let largest = tolerance
    let selected = -1
    for (let index = start + 1; index < end; index += 1) {
      const deviation = projection(points[index], points[start], points[end]).distance
      if (deviation > largest) { largest = deviation; selected = index }
    }
    if (selected >= 0) {
      keep.add(selected)
      if (keep.size > MAX_SEGMENTS + 4) throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '笔迹拐点太多，请简化后分次识别。')
      stack.push([start, selected], [selected, end])
    }
  }
  return [...keep].sort((left, right) => left - right).map(index => points[index])
}

function intersects(first: Segment, second: Segment, margin = 0): boolean {
  const dx = first.b.x - first.a.x
  const dy = first.b.y - first.a.y
  const otherX = second.b.x - second.a.x
  const otherY = second.b.y - second.a.y
  const denominator = dx * otherY - dy * otherX
  if (Math.abs(denominator) < 1e-8) return false
  const offsetX = second.a.x - first.a.x
  const offsetY = second.a.y - first.a.y
  const alongFirst = (offsetX * otherY - offsetY * otherX) / denominator
  const alongSecond = (offsetX * dy - offsetY * dx) / denominator
  return alongFirst > margin && alongFirst < 1 - margin && alongSecond > margin && alongSecond < 1 - margin
}

function cornerStrength(points: HanddrawPoint[], index: number, armLength = 9): number {
  function arm(direction: number): HanddrawPoint {
    let current = index
    let remaining = armLength
    while (current + direction >= 0 && current + direction < points.length) {
      const next = current + direction
      const length = distance(points[current], points[next])
      if (length >= remaining) return { x: points[current].x + (points[next].x - points[current].x) * remaining / length, y: points[current].y + (points[next].y - points[current].y) * remaining / length }
      remaining -= length
      current = next
    }
    return points[current]
  }
  const before = arm(-1)
  const after = arm(1)
  const left = distance(before, points[index])
  const right = distance(after, points[index])
  if (!left || !right) return 0
  return 1 + ((before.x - points[index].x) * (after.x - points[index].x) + (before.y - points[index].y) * (after.y - points[index].y)) / (left * right)
}

function extractSegments(stroke: readonly HanddrawPoint[], settings: Settings, warnings: Set<string>): Segment[] {
  const points: HanddrawPoint[] = []
  for (const point of stroke) {
    if (!points.length || distance(points.at(-1)!, point) >= 0.6) points.push({ x: point.x, y: point.y })
  }
  if (points.length < 2) { warnings.add('已忽略点状或过短的笔迹，请用清晰线段表示化学键。'); return [] }
  const pathLength = points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0)
  const closed = distance(points[0], points.at(-1)!) <= settings.snapDistance && pathLength >= settings.minBondLength * 3
  let vertices: HanddrawPoint[]
  if (closed) {
    const xs = points.map(point => point.x)
    const ys = points.map(point => point.y)
    const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    const loop = points.slice(0, -1)
    const wrapped = [...loop, ...loop, ...loop]
    const armLength = Math.min(14, diagonal * 0.12)
    const positions = [0]
    for (let index = 1; index < loop.length; index += 1) positions.push(positions[index - 1] + distance(loop[index - 1], loop[index]))
    const perimeter = positions.at(-1)! + distance(loop.at(-1)!, loop[0])
    const candidates = loop.map((point, index) => ({ point, index, strength: cornerStrength(wrapped, loop.length + index, armLength) }))
      .filter(candidate => candidate.strength >= 0.15).sort((left, right) => right.strength - left.strength)
    const selected: typeof candidates = []
    for (const candidate of candidates) {
      if (selected.some(other => {
        const alongPath = Math.abs(positions[candidate.index] - positions[other.index])
        return Math.min(alongPath, perimeter - alongPath) < armLength * 1.5 || distance(candidate.point, other.point) < settings.minBondLength
      })) continue
      selected.push(candidate)
    }
    vertices = selected.sort((left, right) => left.index - right.index).map(candidate => candidate.point)
    const followsStraightEdges = vertices.length >= 3 && loop.every(point => vertices.some((vertex, index) => projection(point, vertex, vertices[(index + 1) % vertices.length]).distance <= settings.simplifyTolerance * 1.4))
    if (vertices.length < 3 || vertices.length > 8 || !followsStraightEdges) {
      warnings.add('已忽略圆形、圆弧或不清晰的闭合笔迹；请画有明显直边和拐角的 3～8 元环，元素 O 请在识别后添加。')
      return []
    }
    vertices = [...vertices, vertices[0]]
  } else {
    vertices = simplify(points, settings.simplifyTolerance)
    if (vertices.length > 2 && !points.some((_, index) => cornerStrength(points, index) >= 0.15)) {
      warnings.add('已忽略没有明显拐角的圆弧笔迹；请画直键或折线，元素文字请在识别后添加。')
      return []
    }
  }

  const segments = vertices.slice(1).map((point, index) => ({ a: vertices[index], b: point, order: 1 }))
  if (closed && (segments.some(segment => distance(segment.a, segment.b) < settings.minBondLength)
    || segments.some((segment, index) => segments.slice(index + 1).some(other => intersects(segment, other))))) {
    warnings.add('已忽略边过短或自相交的闭合笔迹，请重新画清楚环的直边。')
    return []
  }
  const valid = segments.filter(segment => distance(segment.a, segment.b) >= settings.minBondLength)
  if (valid.length !== segments.length) warnings.add('已忽略过短的线段，请把化学键画长一些。')
  return valid
}

function parallelRelation(first: Segment, second: Segment): { separation: number; maximum: number } | undefined {
  const length = distance(first.a, first.b)
  const otherLength = distance(second.a, second.b)
  const ux = (first.b.x - first.a.x) / length
  const uy = (first.b.y - first.a.y) / length
  const cosine = ((second.b.x - second.a.x) * ux + (second.b.y - second.a.y) * uy) / otherLength
  if (Math.abs(cosine) < PARALLEL_COSINE) return undefined
  const start = (second.a.x - first.a.x) * ux + (second.a.y - first.a.y) * uy
  const end = (second.b.x - first.a.x) * ux + (second.b.y - first.a.y) * uy
  const overlap = Math.max(0, Math.min(length, Math.max(start, end)) - Math.max(0, Math.min(start, end)))
  if (overlap < Math.min(length, otherLength) * 0.75 || Math.min(length, otherLength) / Math.max(length, otherLength) < 0.4) return undefined
  const offsetA = -(second.a.x - first.a.x) * uy + (second.a.y - first.a.y) * ux
  const offsetB = -(second.b.x - first.a.x) * uy + (second.b.y - first.a.y) * ux
  if (offsetA * offsetB < 0 && Math.max(Math.abs(offsetA), Math.abs(offsetB)) > DUPLICATE_DISTANCE) return undefined
  if (Math.min(Math.abs(offsetA), Math.abs(offsetB)) <= DUPLICATE_DISTANCE
    && Math.max(Math.abs(offsetA), Math.abs(offsetB)) > DUPLICATE_DISTANCE * 1.6) return undefined
  return { separation: Math.abs((offsetA + offsetB) / 2), maximum: Math.max(Math.abs(offsetA), Math.abs(offsetB)) }
}

function combineParallel(segments: Segment[], settings: Settings, warnings: Set<string>): Segment[] {
  const sorted = segments.slice().sort((left, right) => distance(right.a, right.b) - distance(left.a, left.b))
  const unique: Segment[] = []
  for (const segment of sorted) {
    if (unique.some(existing => {
      const relation = parallelRelation(existing, segment)
      return relation && relation.separation <= DUPLICATE_DISTANCE && relation.maximum <= DUPLICATE_DISTANCE * 1.6
    })) warnings.add('已将同一位置的重画笔迹按一根键处理。')
    else unique.push(segment)
  }

  const consumed = new Set<number>()
  const result: Segment[] = []
  unique.forEach((seed, index) => {
    if (consumed.has(index)) return
    consumed.add(index)
    const group = [seed]
    let changed = true
    while (changed) {
      changed = false
      for (let candidate = 0; candidate < unique.length; candidate += 1) {
        if (consumed.has(candidate)) continue
        const line = unique[candidate]
        const aligned = parallelRelation(seed, line)
        if (!aligned || !group.some(member => {
          const relation = parallelRelation(member, line)
          return relation && relation.separation <= settings.parallelDistance && relation.maximum <= settings.parallelDistance * 1.35
        })) continue
        consumed.add(candidate)
        group.push(line)
        changed = true
      }
    }
    if (group.length > 3) warnings.add('检测到超过三条邻近平行线，已按三键保留；请检查是否有多画的线。')
    const lines = group.slice(0, 3)
    const seedLength = distance(seed.a, seed.b)
    if (lines.length > 1 && lines.every(line => distance(line.a, line.b) >= seedLength * 0.85)) {
      const ux = (seed.b.x - seed.a.x) / seedLength
      const uy = (seed.b.y - seed.a.y) / seedLength
      const alignedLines = lines.map(line => (line.b.x - line.a.x) * ux + (line.b.y - line.a.y) * uy < 0 ? { a: line.b, b: line.a } : line)
      result.push({
        a: { x: alignedLines.reduce((sum, line) => sum + line.a.x / lines.length, 0), y: alignedLines.reduce((sum, line) => sum + line.a.y / lines.length, 0) },
        b: { x: alignedLines.reduce((sum, line) => sum + line.b.x / lines.length, 0), y: alignedLines.reduce((sum, line) => sum + line.b.y / lines.length, 0) },
        order: lines.length,
      })
    } else result.push({ ...seed, order: lines.length })
  })
  return result
}

function snapEndpoints(segments: Segment[], snapDistance: number): EditorGraph {
  const points = segments.flatMap(segment => [segment.a, segment.b])
  const parents = points.map((_, index) => index)
  const members = points.map((_, index) => [index])
  function root(index: number): number {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index] }
    return index
  }
  const pairs: { left: number; right: number; distance: number }[] = []
  points.forEach((point, left) => points.slice(left + 1).forEach((other, offset) => {
    const right = left + offset + 1
    const separation = distance(point, other)
    if (Math.floor(left / 2) !== Math.floor(right / 2) && separation <= snapDistance
      && !intersects(segments[Math.floor(left / 2)], segments[Math.floor(right / 2)], 0.12)) pairs.push({ left, right, distance: separation })
  }))
  pairs.sort((left, right) => left.distance - right.distance || left.left - right.left || left.right - right.right)
  for (const pair of pairs) {
    const left = root(pair.left)
    const right = root(pair.right)
    if (left === right || members[left].some(first => members[right].some(second => Math.floor(first / 2) === Math.floor(second / 2)
      || root(first ^ 1) === root(second ^ 1)))) continue
    const combined = [...members[left], ...members[right]]
    const xs = combined.map(index => points[index].x)
    const ys = combined.map(index => points[index].y)
    if (Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) > snapDistance * 1.8) continue
    parents[right] = left
    members[left] = combined
  }
  const atomIndices = new Map<number, number>()
  const graph: EditorGraph = { atoms: [], bonds: [] }
  for (let index = 0; index < points.length; index += 1) {
    const cluster = root(index)
    if (atomIndices.has(cluster)) continue
    atomIndices.set(cluster, graph.atoms.length)
    graph.atoms.push({
      element: 'C', charge: 0,
      x: members[cluster].reduce((sum, member) => sum + points[member].x / members[cluster].length, 0),
      y: members[cluster].reduce((sum, member) => sum + points[member].y / members[cluster].length, 0),
    })
  }
  segments.forEach((segment, index) => {
    const from = atomIndices.get(root(index * 2))!
    const to = atomIndices.get(root(index * 2 + 1))!
    const existing = graph.bonds.find(bond => bond.from === from && bond.to === to || bond.from === to && bond.to === from)
    if (existing) existing.order = Math.max(existing.order, segment.order)
    else graph.bonds.push({ from, to, order: segment.order })
  })
  return graph
}

function inspectGraph(graph: EditorGraph, settings: Settings, warnings: Set<string>): void {
  const adjacency = graph.atoms.map(() => [] as number[])
  graph.bonds.forEach(bond => { adjacency[bond.from].push(bond.to); adjacency[bond.to].push(bond.from) })
  const visited = new Set<number>()
  let components = 0
  graph.atoms.forEach((_, index) => {
    if (visited.has(index)) return
    components += 1
    const queue = [index]
    visited.add(index)
    for (let head = 0; head < queue.length; head += 1) for (const next of adjacency[queue[head]]) {
      if (!visited.has(next)) { visited.add(next); queue.push(next) }
    }
    if (queue.length > 8 && queue.every(atom => adjacency[atom].length === 2)) {
      throw new HanddrawRecognitionError('UNRECOGNIZED', '闭合笔迹包含过多拐点，可能是圆形或字母 O；请改画清晰的 3～8 元环。')
    }
  })
  if (components > 1) warnings.add('检测到多个未相连的片段，请检查需要连接的端点是否靠近。')
  graph.atoms.forEach((atom, atomIndex) => {
    const valence = graph.bonds.reduce((sum, bond) => sum + (bond.from === atomIndex || bond.to === atomIndex ? bond.order : 0), 0)
    if (valence > 4) warnings.add('有碳原子的总键级超过 4，请在保存前修正连接或键型。')
    if (graph.bonds.some(bond => {
      if (bond.from === atomIndex || bond.to === atomIndex) return false
      const hit = projection(atom, graph.atoms[bond.from], graph.atoms[bond.to])
      return hit.t > 0.12 && hit.t < 0.88 && hit.distance <= settings.snapDistance
    })) warnings.add('有端点落在另一根键的中段，已保持不连接；如需支链，请在预览中明确添加连接点。')
  })
  if (graph.bonds.some((bond, index) => graph.bonds.slice(index + 1).some(other => {
    if ([bond.from, bond.to].some(atom => atom === other.from || atom === other.to)) return false
    return intersects({ a: graph.atoms[bond.from], b: graph.atoms[bond.to], order: bond.order }, { a: graph.atoms[other.from], b: graph.atoms[other.to], order: other.order })
  }))) warnings.add('检测到交叉的化学键，交叉处未自动视为连接；请确认连接关系。')
}

/** 仅识别直键与折线端点，不识别元素文字、圆圈芳香记号或立体化学。坐标使用画布屏幕像素。 */
export function recognizeHanddraw(strokes: readonly (readonly HanddrawPoint[])[], options: HanddrawOptions = {}): { graph: EditorGraph; warnings: string[] } {
  if (!Array.isArray(strokes)) throw new HanddrawRecognitionError('INVALID_INPUT', '笔迹必须是由坐标点数组组成的列表。')
  const settings = { ...DEFAULTS, ...options }
  for (const [key, value] of Object.entries(settings)) {
    if (!Number.isFinite(value) || value <= 0 || (key === 'maxStrokes' || key === 'maxPoints') && !Number.isInteger(value)) {
      throw new HanddrawRecognitionError('INVALID_INPUT', '识别参数必须是有效的正数，数量上限必须是整数。')
    }
  }
  if (settings.maxStrokes > 512 || settings.maxPoints > 30000) throw new HanddrawRecognitionError('INVALID_INPUT', '识别上限过大，请限制在 512 笔、30000 个采样点以内。')
  if (!strokes.length) throw new HanddrawRecognitionError('EMPTY', '画布还是空的，请先画出键线式结构。')
  if (strokes.length > settings.maxStrokes) throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '笔画太多，请分次识别或清除多余笔迹。')
  let count = 0
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) throw new HanddrawRecognitionError('INVALID_INPUT', '每笔笔迹必须是坐标点数组。')
    count += stroke.length
    if (count > settings.maxPoints) throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '采样点太多，请简化笔迹后再识别。')
    for (const point of stroke) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6) {
        throw new HanddrawRecognitionError('INVALID_INPUT', '笔迹含有无效或超出范围的坐标，请重新绘制。')
      }
    }
  }
  if (!count) throw new HanddrawRecognitionError('EMPTY', '画布还是空的，请先画出键线式结构。')
  const warnings = new Set<string>()
  const segments: Segment[] = []
  for (const stroke of strokes) {
    segments.push(...extractSegments(stroke, settings, warnings))
    if (segments.length > MAX_SEGMENTS) throw new HanddrawRecognitionError('LIMIT_EXCEEDED', '识别出的线段太多，请只绘制一个较清晰的结构。')
  }
  if (!segments.length) throw new HanddrawRecognitionError('UNRECOGNIZED', [...warnings][0] ?? '没有识别出化学键，请画清楚直线、折线或多边形环。')
  const graph = snapEndpoints(combineParallel(segments, settings, warnings), settings.snapDistance)
  inspectGraph(graph, settings, warnings)
  return { graph, warnings: [...warnings] }
}
