import type { EditorAtom, EditorBond, EditorGraph } from '../moleculeEditor'
import { mergeBondLinesWithWarnings } from './bonds'
import {
  averagePoint, boundsCenter, boundsHeight, boundsWidth, distance, parallelAngleDifference,
  pointBoundsDistance, pointInPolygon, projection, segmentsIntersect,
} from './geometry'
import type {
  AssemblyInput, AssemblyResult, AtomLabel, HanddrawPoint, MergedBond, Settings,
} from './types'

/** 元素常见最高价，仅用于给用户提示，不作为化学合法性硬校验。 */
const MAX_VALENCE: Readonly<Record<string, number>> = Object.freeze({
  H: 1, B: 3, C: 4, N: 3, O: 2, F: 1, Si: 4, P: 5, S: 6, Cl: 1, Br: 1, I: 1,
  Li: 1, Na: 1, K: 1, Mg: 2, Ca: 2, Al: 3, Fe: 3, Zn: 2, Cu: 2, Ag: 1, Ba: 2, Mn: 2, Ni: 2,
})

const KNOWN_ELEMENTS = new Set(Object.keys(MAX_VALENCE))
const MAX_CYCLE_LENGTH = 8
const MAX_CYCLES = 400
/** 低于该置信度的标签不参与装配，只作为提示。与 glyph-engine 的 claim 阈值一致。 */
const MIN_CONFIDENCE = 0.55
/** 小于该长度的键更可能是噪声，装配时丢弃。 */
const MIN_BOND_PX = 6

interface InternalNode {
  point: HanddrawPoint
  label?: AtomLabel
}

interface InternalBond {
  from: number
  to: number
  order: number
}

interface InternalCycle {
  atoms: number[]
  bonds: number[]
}

interface FragmentAtom {
  element: string
  charge: number
  /** 相对标签锚点的位置，单位是 scale。 */
  dx: number
  dy: number
}

interface LabelFragment {
  atoms: FragmentAtom[]
  bonds: [number, number, number][]
}

/** 常见基团缩写展开成真实原子连接；第一个原子是连接原子。 */
const LABEL_FRAGMENTS: Readonly<Record<string, LabelFragment>> = Object.freeze({
  COOH: {
    atoms: [{ element: 'C', charge: 0, dx: 0, dy: 0 }, { element: 'O', charge: 0, dx: 0.85, dy: -0.55 }, { element: 'O', charge: 0, dx: -0.45, dy: 0.8 }],
    bonds: [[0, 1, 2], [0, 2, 1]],
  },
  CHO: {
    atoms: [{ element: 'C', charge: 0, dx: 0, dy: 0 }, { element: 'O', charge: 0, dx: 0.9, dy: -0.6 }],
    bonds: [[0, 1, 2]],
  },
  NO2: {
    atoms: [{ element: 'N', charge: 1, dx: 0, dy: 0 }, { element: 'O', charge: 0, dx: 0.9, dy: -0.55 }, { element: 'O', charge: -1, dx: -0.45, dy: 0.8 }],
    bonds: [[0, 1, 2], [0, 2, 1]],
  },
  CN: {
    atoms: [{ element: 'C', charge: 0, dx: 0, dy: 0 }, { element: 'N', charge: 0, dx: 0.9, dy: 0 }],
    bonds: [[0, 1, 3]],
  },
  SO3H: {
    atoms: [
      { element: 'S', charge: 0, dx: 0, dy: 0 },
      { element: 'O', charge: 0, dx: 0.85, dy: -0.6 },
      { element: 'O', charge: 0, dx: -0.85, dy: -0.6 },
      { element: 'O', charge: 0, dx: 0, dy: 0.9 },
    ],
    bonds: [[0, 1, 2], [0, 2, 2], [0, 3, 1]],
  },
  COOCH3: {
    atoms: [
      { element: 'C', charge: 0, dx: 0, dy: 0 },
      { element: 'O', charge: 0, dx: 0.8, dy: -0.6 },
      { element: 'O', charge: 0, dx: -0.5, dy: 0.75 },
      { element: 'C', charge: 0, dx: -0.5, dy: 1.7 },
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 1]],
  },
  COOMe: {
    atoms: [
      { element: 'C', charge: 0, dx: 0, dy: 0 },
      { element: 'O', charge: 0, dx: 0.8, dy: -0.6 },
      { element: 'O', charge: 0, dx: -0.5, dy: 0.75 },
      { element: 'C', charge: 0, dx: -0.5, dy: 1.7 },
    ],
    bonds: [[0, 1, 2], [0, 2, 1], [2, 3, 1]],
  },
  OMe: {
    atoms: [{ element: 'O', charge: 0, dx: 0, dy: 0 }, { element: 'C', charge: 0, dx: 0.9, dy: 0.3 }],
    bonds: [[0, 1, 1]],
  },
  OCH3: {
    atoms: [{ element: 'O', charge: 0, dx: 0, dy: 0 }, { element: 'C', charge: 0, dx: 0.9, dy: 0.3 }],
    bonds: [[0, 1, 1]],
  },
  COO: {
    atoms: [{ element: 'C', charge: 0, dx: 0, dy: 0 }, { element: 'O', charge: 0, dx: 0.85, dy: -0.55 }, { element: 'O', charge: -1, dx: -0.45, dy: 0.8 }],
    bonds: [[0, 1, 2], [0, 2, 1]],
  },
})

function snapTolerance(settings: Settings, scale: number): number {
  return Math.max(settings.snapDistance, Math.min(scale * 0.24, 24))
}

function labelAttachTolerance(label: AtomLabel, settings: Settings, scale: number): number {
  const base = Math.max(settings.snapDistance * 1.1, Math.min(scale * 0.3, 26))
  return label.shape === 'circle' ? Math.max(settings.snapDistance, Math.min(scale * 0.2, 18)) : base
}

/** 圆圈半径超过该比例时视为芳环记号候选，不吸附到键端点（避免把苯环内圆圈建成氧原子）。 */
const AROMATIC_CIRCLE_RADIUS_FACTOR = 0.42
/** 键端吸附圆圈 O 时，键延长方向与“端点→圆心”方向夹角余弦下限（约 70°）。 */
const CIRCLE_ATTACH_COSINE = 0.34

function elementValence(element: string): number {
  return MAX_VALENCE[element] ?? 4
}

/** 标签文本去掉电荷后缀后的键，用于查基团缩写表。 */
function fragmentKey(label: AtomLabel): string {
  return label.text.replace(/[+\-−]$/, '').toUpperCase()
}

function fragmentFor(label: AtomLabel): LabelFragment | undefined {
  const key = fragmentKey(label)
  if (!key || key === label.element.toUpperCase()) return undefined
  return Object.hasOwn(LABEL_FRAGMENTS, key) ? LABEL_FRAGMENTS[key] : undefined
}

function incidentBonds(bonds: readonly (InternalBond | null)[], node: number): number[] {
  const result: number[] = []
  bonds.forEach((bond, index) => { if (bond && (bond.from === node || bond.to === node)) result.push(index) })
  return result
}

/** 校验 glyph-engine 返回的标签，过滤脏数据，避免坏输入把装配器带崩。 */
function sanitizeLabels(labels: readonly AtomLabel[], strokeCount: number, warnings: Set<string>): AtomLabel[] {
  const result: AtomLabel[] = []
  let skipped = 0
  for (const label of labels) {
    if (!label || typeof label !== 'object') { skipped += 1; continue }
    if (typeof label.text !== 'string' || !label.text.trim()) { skipped += 1; continue }
    if (typeof label.element !== 'string' || !/^[A-Z][a-z]?$/.test(label.element)) { skipped += 1; continue }
    if (!Number.isFinite(label.confidence) || label.confidence < MIN_CONFIDENCE) continue
    if (!Number.isFinite(label.anchor?.x) || !Number.isFinite(label.anchor?.y)) { skipped += 1; continue }
    if (!label.bounds || [label.bounds.minX, label.bounds.minY, label.bounds.maxX, label.bounds.maxY].some(value => !Number.isFinite(value))) { skipped += 1; continue }
    const strokes = [...new Set(label.strokes.filter(index => Number.isInteger(index) && index >= 0 && index < strokeCount))]
    if (!strokes.length) { skipped += 1; continue }
    result.push({
      text: label.text.trim(),
      element: label.element,
      charge: Number.isFinite(label.charge) ? Math.round(label.charge) : 0,
      confidence: label.confidence,
      bounds: label.bounds,
      anchor: label.anchor,
      strokes,
      shape: label.shape === 'circle' ? 'circle' : 'text',
      alternatives: Array.isArray(label.alternatives) ? label.alternatives.slice(0, 3) : [],
    })
  }
  if (skipped) warnings.add('有手写标签数据不完整，已忽略；请重画对应元素符号。')
  return result
}

/** 低置信标签不参与装配，提示用户重画或识别后手改。 */
function addLowConfidenceWarnings(labels: readonly AtomLabel[], warnings: Set<string>): void {
  for (const label of labels) {
    if (!label || typeof label.text !== 'string' || !label.text.trim()) continue
    if (!Number.isFinite(label.confidence) || label.confidence < 0.3 || label.confidence >= MIN_CONFIDENCE) continue
    warnings.add(`手写标注“${label.text}”不够清楚，未自动识别为原子；如它是元素符号，请重画清楚或识别后点选修改。`)
  }
}

/**
 * 清除笔迹末端的小勾/回勾：同一笔迹里，短于约 0.15*scale 的线段如果和同笔迹的
 * 另一条长线段共用一个端点，视为手抖或收笔小勾，直接丢弃（否则会多出一个假原子，
 * 并破坏顶点间隙闭合的方向判断）。
 */
function removeTrailingStubs(bonds: readonly MergedBond[], settings: Settings, scale: number): MergedBond[] {
  const threshold = Math.min(30, Math.max(settings.minBondLength * 2, scale * 0.18))
  const lengthOf = (bond: MergedBond) => distance(bond.a, bond.b)
  const drop = new Set<number>()
  bonds.forEach((bond, index) => {
    if (lengthOf(bond) >= threshold) return
    const stubStroke = bond.lines[0]?.strokeIndex
    if (stubStroke === undefined) return
    for (const [otherIndex, other] of bonds.entries()) {
      if (otherIndex === index || drop.has(otherIndex)) continue
      if (lengthOf(other) < lengthOf(bond) * 1.6) continue
      const shares = distance(bond.a, other.a) < 1.2 || distance(bond.a, other.b) < 1.2
        || distance(bond.b, other.a) < 1.2 || distance(bond.b, other.b) < 1.2
      if (!shares) continue
      if (!other.lines.some(line => line.strokeIndex === stubStroke)) continue
      drop.add(index)
      break
    }
  })
  return drop.size ? bonds.filter((_, index) => !drop.has(index)) : bonds.slice()
}

/**
 * 在 T 型支链处把被指的键拆开：一条键的端点落在另一条键的中段且方向明显不同时，
 * 在中段的投影点插入连接原子。
 */
function splitBondsAtJunctions(bonds: readonly MergedBond[], settings: Settings, scale: number, warnings: Set<string>): MergedBond[] {
  const snap = snapTolerance(settings, scale)
  const splitPoints: { t: number; point: HanddrawPoint }[][] = bonds.map(() => [])
  bonds.forEach((source, sourceIndex) => {
    for (const end of [source.a, source.b]) {
      bonds.forEach((target, targetIndex) => {
        if (sourceIndex === targetIndex) return
        const hit = projection(end, target.a, target.b)
        if (hit.t <= 0.14 || hit.t >= 0.86 || hit.distance > snap) return
        const sourceAngle = Math.atan2(source.b.y - source.a.y, source.b.x - source.a.x)
        const targetAngle = Math.atan2(target.b.y - target.a.y, target.b.x - target.a.x)
        if (parallelAngleDifference(sourceAngle, targetAngle) < Math.PI / 6) return
        splitPoints[targetIndex].push({ t: hit.t, point: hit.projected })
      })
    }
  })
  let splitCount = 0
  const result: MergedBond[] = []
  bonds.forEach((bond, index) => {
    const points = splitPoints[index]
    if (!points.length) { result.push(bond); return }
    const ordered = points.slice().sort((left, right) => left.t - right.t)
    let previous = bond.a
    const push = (next: HanddrawPoint) => {
      if (distance(previous, next) < MIN_BOND_PX) { previous = next; return }
      result.push({ a: previous, b: next, order: bond.order, lines: bond.lines })
      previous = next
    }
    for (const entry of ordered) push(entry.point)
    push(bond.b)
    splitCount += 1
  })
  if (splitCount) warnings.add('已在化学键中段加入连接原子（T 型支链），请核对支链所连位置。')
  return result
}

/**
 * 端点吸附：把距离足够近、且不属于同一根键的两个端点并成同一个原子。
 * 使用并查集 + 距离排序，并保护“不要把环压扁成一条边”。
 *
 * 真实手写环通常一条边一条边画，相邻两笔在顶点处会留下较大间隙（像“断触”）。
 * 因此除正常 snap 距离外，再允许“两侧都是孤立端点、互为最近、夹角像折角”的
 * 远距离顶点合并（vertexGap），让分笔画成的环也能闭合。
 */
function clusterEndpoints(
  points: readonly HanddrawPoint[],
  originalIndex: readonly number[],
  bondOfEndpoint: readonly number[],
  bonds: readonly MergedBond[],
  snap: number,
  vertexGap: number,
  partnerRef: (originalEndpoint: number) => { cluster?: number; label?: number },
): { parents: number[]; farMerges: number } {
  const parents = points.map((_, index) => index)
  const members = points.map((_, index) => [index])
  function root(index: number): number {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index] }
    return index
  }
  function partnerKey(originalEndpoint: number): number {
    const ref = partnerRef(originalEndpoint ^ 1)
    if (ref.label !== undefined) return -(ref.label + 2)
    if (ref.cluster !== undefined) return root(ref.cluster)
    return -(1_000_000 + (originalEndpoint ^ 1))
  }
  // 每个端点沿自己的键指向“另一个端点”的方向，用于判断两笔在顶点处是否成折角。
  const directions = points.map((point, index) => {
    const bond = bonds[bondOfEndpoint[index]]
    const other = distance(point, bond.a) <= distance(point, bond.b) ? bond.b : bond.a
    const length = distance(point, other) || 1
    return { x: (other.x - point.x) / length, y: (other.y - point.y) / length }
  })
  const pairs: { left: number; right: number; distance: number; far: boolean }[] = []
  points.forEach((point, left) => {
    for (let right = left + 1; right < points.length; right += 1) {
      if (bondOfEndpoint[left] === bondOfEndpoint[right]) continue
      const separation = distance(point, points[right])
      if (separation > vertexGap) continue
      if (segmentsIntersect(bonds[bondOfEndpoint[left]], bonds[bondOfEndpoint[right]], 0.12)) continue
      const far = separation > snap
      if (far) {
        // 远处端点只接受“折角”关系：夹角太接近 0° 或 180° 时更可能是同一条线的断触续画，
        // 不应在这里合并（交给正常 snap / 装配器其它规则）。
        const cosine = directions[left].x * directions[right].x + directions[left].y * directions[right].y
        if (!(cosine > -0.95 && cosine < 0.72)) continue
      }
      pairs.push({ left, right, distance: separation, far })
    }
  })
  // 每个端点的最近候选，用于远距离配对时要求“互为最近”，避免把附近的无关端点吸进来。
  const nearest = points.map(() => Infinity)
  for (const pair of pairs) {
    if (pair.distance < nearest[pair.left]) nearest[pair.left] = pair.distance
    if (pair.distance < nearest[pair.right]) nearest[pair.right] = pair.distance
  }
  pairs.sort((left, right) => left.distance - right.distance || left.left - right.left || left.right - right.right)
  let farMerges = 0
  for (const pair of pairs) {
    const left = root(pair.left)
    const right = root(pair.right)
    if (left === right) continue
    if (pair.far) {
      if (members[left].length !== 1 || members[right].length !== 1) continue
      if (nearest[pair.left] !== pair.distance || nearest[pair.right] !== pair.distance) continue
    }
    if (partnerKey(originalIndex[pair.left]) === partnerKey(originalIndex[pair.right])) continue
    const combined = [...members[left], ...members[right]]
    const xs = combined.map(index => points[index].x)
    const ys = combined.map(index => points[index].y)
    const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    if (spread > (pair.far ? vertexGap * 1.4 : snap * 1.8)) continue
    parents[right] = left
    members[left] = combined
    if (pair.far) farMerges += 1
  }
  return { parents: points.map((_, index) => root(index)), farMerges }
}

/** 圆圈中心是否落在键 from→end 延长方向约 70° 的扇形内（端点在圆内时视为指向）。 */
function pointsToward(from: HanddrawPoint, end: HanddrawPoint, target: HanddrawPoint): boolean {
  const bondX = end.x - from.x
  const bondY = end.y - from.y
  const targetX = target.x - end.x
  const targetY = target.y - end.y
  const lengths = Math.hypot(bondX, bondY) * Math.hypot(targetX, targetY)
  if (!(lengths > 1e-9)) return true
  return (bondX * targetX + bondY * targetY) / lengths >= CIRCLE_ATTACH_COSINE
}

/** 为每个键端点找最近的原子标签，距离在标签允许范围内才算连接。 */
function attachLabelsToEndpoints(
  endpoints: readonly HanddrawPoint[],
  labels: readonly AtomLabel[],
  settings: Settings,
  scale: number,
): (number | undefined)[] {
  const tolerances = labels.map(label => labelAttachTolerance(label, settings, scale))
  const attachable = labels.map(label => label.shape !== 'circle' || labelRadius(label) <= scale * AROMATIC_CIRCLE_RADIUS_FACTOR)
  return endpoints.map((point, endpointIndex) => {
    // 端点 2k、2k+1 属于同一根键；由另一端指向本端的方向就是键的延伸方向。
    const partner = endpoints[endpointIndex ^ 1]
    let best = -1
    let bestDistance = Infinity
    labels.forEach((label, index) => {
      if (!attachable[index]) return
      const separation = pointBoundsDistance(point, label.bounds)
      if (separation > tolerances[index] || separation >= bestDistance) return
      // 圆圈 O 必须位于键的延长线一侧：环顶点旁边的芳环内圈只是贴得近，不是键连着的氧原子。
      if (label.shape === 'circle' && partner && !pointsToward(partner, point, boundsCenter(label.bounds))) return
      best = index
      bestDistance = separation
    })
    return best >= 0 ? best : undefined
  })
}

function findCycles(nodes: readonly InternalNode[], bonds: readonly InternalBond[]): InternalCycle[] {
  const adjacency: { to: number; bond: number }[][] = nodes.map(() => [])
  bonds.forEach((bond, index) => {
    adjacency[bond.from].push({ to: bond.to, bond: index })
    adjacency[bond.to].push({ to: bond.from, bond: index })
  })
  const seen = new Set<string>()
  const cycles: InternalCycle[] = []
  for (let start = 0; start < nodes.length; start += 1) {
    const atoms = [start]
    const cycleBonds: number[] = []
    const visited = new Set([start])
    const dfs = (current: number) => {
      if (cycles.length >= MAX_CYCLES) return
      for (const edge of adjacency[current]) {
        if (edge.to === start) {
          if (atoms.length < 3) continue
          const key = [...atoms].sort((left, right) => left - right).join(':')
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push({ atoms: atoms.slice(), bonds: cycleBonds.slice() })
          }
          continue
        }
        if (visited.has(edge.to) || atoms.length >= MAX_CYCLE_LENGTH) continue
        visited.add(edge.to)
        atoms.push(edge.to)
        cycleBonds.push(edge.bond)
        dfs(edge.to)
        atoms.pop()
        cycleBonds.pop()
        visited.delete(edge.to)
      }
    }
    dfs(start)
  }
  return cycles
}

function cyclePolygon(cycle: InternalCycle, nodes: readonly InternalNode[]): HanddrawPoint[] {
  return cycle.atoms.map(index => nodes[index].point)
}

function cycleRingRadius(polygon: readonly HanddrawPoint[], center: HanddrawPoint): number {
  return Math.max(...polygon.map(point => distance(point, center)))
}

function cycleInradius(polygon: readonly HanddrawPoint[], center: HanddrawPoint): number {
  let radius = Infinity
  for (let index = 0; index < polygon.length; index += 1) {
    radius = Math.min(radius, projection(center, polygon[index], polygon[(index + 1) % polygon.length]).distance)
  }
  return radius
}

function labelRadius(label: AtomLabel): number {
  return (boundsWidth(label.bounds) + boundsHeight(label.bounds)) / 4
}

/**
 * 在环上按交替方式加入双键，返回要提升为双键的键下标。
 * 六元环取 3 条互不相邻的边，五元环取 2 条；并检查元素价态。
 */
function kekuleMatching(cycle: InternalCycle, nodes: readonly InternalNode[], bonds: readonly InternalBond[]): number[] | undefined {
  const target = cycle.atoms.length === 6 ? 3 : cycle.atoms.length === 5 ? 2 : -1
  if (target < 0) return undefined
  const atomValence = new Map<number, number>()
  for (const atom of cycle.atoms) atomValence.set(atom, 0)
  for (const bond of bonds) {
    if (atomValence.has(bond.from)) atomValence.set(bond.from, atomValence.get(bond.from)! + bond.order)
    if (atomValence.has(bond.to)) atomValence.set(bond.to, atomValence.get(bond.to)! + bond.order)
  }
  const elementOf = (node: number): string => nodes[node].label?.element ?? 'C'
  const chargeOf = (node: number): number => nodes[node].label?.charge ?? 0
  const canDouble = (atom: number): boolean => atomValence.get(atom)! + 1 <= elementValence(elementOf(atom)) + Math.max(0, chargeOf(atom))
  const candidateEdges = cycle.bonds.slice().sort((left, right) => left - right)
  const chosen: number[] = []
  const usedAtoms = new Set<number>()
  const search = (startIndex: number): boolean => {
    if (chosen.length === target) return true
    if (startIndex >= candidateEdges.length) return false
    if (candidateEdges.length - startIndex < target - chosen.length) return false
    const bondIndex = candidateEdges[startIndex]
    const bond = bonds[bondIndex]
    if (!usedAtoms.has(bond.from) && !usedAtoms.has(bond.to) && canDouble(bond.from) && canDouble(bond.to)) {
      const firstValence = atomValence.get(bond.from)!
      const secondValence = atomValence.get(bond.to)!
      atomValence.set(bond.from, firstValence + 1)
      atomValence.set(bond.to, secondValence + 1)
      chosen.push(bondIndex)
      usedAtoms.add(bond.from)
      usedAtoms.add(bond.to)
      if (search(startIndex + 1)) return true
      chosen.pop()
      usedAtoms.delete(bond.from)
      usedAtoms.delete(bond.to)
      atomValence.set(bond.from, firstValence)
      atomValence.set(bond.to, secondValence)
    }
    return search(startIndex + 1)
  }
  return search(0) ? chosen.slice() : undefined
}

/** 识别环内的芳环圆圈：从原子中移除，并把环上键级提升为交替双键。 */
function applyAromaticCircles(
  nodes: readonly InternalNode[],
  bonds: InternalBond[],
  labels: readonly AtomLabel[],
  labelNodes: readonly number[],
  warnings: Set<string>,
): Set<number> {
  const aromaticLabels = new Set<number>()
  const cycles = findCycles(nodes, bonds)
  labels.forEach((label, labelIndex) => {
    // 纸上手画的芳环内圈常常是开口/不规则椭圆，被识别成文字 O 而不是 circle；
    // 只要它是无键相连的 O、位于 5/6 元环内且尺寸像内圈，也按芳香记号处理。
    const isCircle = label.shape === 'circle'
    const isOxygenMarker = label.element === 'O' && label.text.replace(/[+\-−]$/, '') === 'O'
    if (!isCircle && !isOxygenMarker) return
    const node = labelNodes[labelIndex]
    if (node === undefined) return
    if (incidentBonds(bonds, node).length) return
    const radius = labelRadius(label)
    // 芳环记号的几何位置以笔画包围盒中心为准（anchor 可能偏向某一侧，用于建键方向）。
    const center = boundsCenter(label.bounds)
    for (const cycle of cycles) {
      if (cycle.atoms.length !== 6 && cycle.atoms.length !== 5) continue
      const polygon = cyclePolygon(cycle, nodes)
      if (!pointInPolygon(center, polygon)) continue
      const ringRadius = cycleRingRadius(polygon, center)
      const inradius = cycleInradius(polygon, center)
      if (radius > inradius * 1.05 || radius < Math.min(ringRadius * 0.12, inradius * 0.25)) continue
      const unsaturated = cycle.bonds.filter(bondIndex => bonds[bondIndex].order > 1).length
      const target = cycle.atoms.length === 6 ? 3 : 2
      if (unsaturated) {
        // 已经画出双键，圆圈只作为芳香记号移除；若不足交替数，提示用户核对。
        if (unsaturated < target) warnings.add('环内圆圈与已画双键并存，已按已画键级保留；请核对芳环键级。')
        aromaticLabels.add(labelIndex)
        return
      }
      const matching = kekuleMatching(cycle, nodes, bonds)
      if (!matching) {
        warnings.add('检测到芳环圆圈，但环上元素价态不允许自动排布双键；已按独立的氧原子处理，请手动补双键。')
        return
      }
      for (const bondIndex of matching) bonds[bondIndex].order = 2
      aromaticLabels.add(labelIndex)
      return
    }
  })
  return aromaticLabels
}

interface EmitContext {
  hiddenNodes: ReadonlySet<number>
}

function emitGraph(
  nodes: readonly InternalNode[],
  bonds: readonly InternalBond[],
  aromaticLabels: ReadonlySet<number>,
  labelNodes: readonly number[],
  scale: number,
  warnings: Set<string>,
  context: EmitContext,
): EditorGraph {
  const atomIndexOfNode = new Map<number, number>()
  const atoms: EditorAtom[] = []
  const bondList: EditorBond[] = []
  const removedNodes = new Set<number>(context.hiddenNodes)
  labelNodes.forEach((node, labelIndex) => { if (aromaticLabels.has(labelIndex)) removedNodes.add(node) })

  nodes.forEach((node, nodeIndex) => {
    if (removedNodes.has(nodeIndex)) return
    const label = node.label
    if (!label) {
      atomIndexOfNode.set(nodeIndex, atoms.length)
      atoms.push({ element: 'C', charge: 0, x: node.point.x, y: node.point.y })
      return
    }
    if (label.element === 'H') return
    const fragment = fragmentFor(label)
    if (fragment) {
      const base = atoms.length
      atomIndexOfNode.set(nodeIndex, base)
      const center = boundsCenter(label.bounds)
      fragment.atoms.forEach(spec => atoms.push({
        element: spec.element,
        charge: spec.charge,
        x: center.x + spec.dx * scale,
        y: center.y + spec.dy * scale,
      }))
      for (const [from, to, order] of fragment.bonds) bondList.push({ from: base + from, to: base + to, order })
      return
    }
    if (!KNOWN_ELEMENTS.has(label.element)) {
      warnings.add(`手写标签“${label.text}”包含暂不支持的元素，已按碳原子处理，请点选修正。`)
      atomIndexOfNode.set(nodeIndex, atoms.length)
      atoms.push({ element: 'C', charge: 0, ...boundsCenter(label.bounds) })
      return
    }
    atomIndexOfNode.set(nodeIndex, atoms.length)
    atoms.push({ element: label.element, charge: label.charge, ...boundsCenter(label.bounds) })
  })

  for (const bond of bonds) {
    const from = atomIndexOfNode.get(bond.from)
    const to = atomIndexOfNode.get(bond.to)
    if (from === undefined || to === undefined) continue
    if (from === to) {
      warnings.add('有一根键的两端落在同一个原子上，已忽略该键；请检查是否画了闭环。')
      continue
    }
    bondList.push({ from, to, order: bond.order })
  }
  return { atoms, bonds: bondList }
}

/**
 * 接近但没连上的端点提示：手绘环/链时如果两笔端点差一点点没接上，
 * 给一条可操作中文提示，而不是只报“多个片段”。
 */
function addNearMissHint(graph: EditorGraph, scale: number, warnings: Set<string>): void {
  const adjacency = graph.atoms.map(() => [] as number[])
  graph.bonds.forEach(bond => { adjacency[bond.from].push(bond.to); adjacency[bond.to].push(bond.from) })
  const free = graph.atoms.map((atom, index) => ({ atom, index })).filter(({ index }) => adjacency[index].length === 1)
  const threshold = Math.max(26, scale * 0.55)
  for (let first = 0; first < free.length; first += 1) for (let second = first + 1; second < free.length; second += 1) {
    if (distance(free[first].atom, free[second].atom) <= threshold) {
      warnings.add('检测到两笔端点离得很近但没有连上；如果想成环或接上，请把端点画得更靠近一些。')
      return
    }
  }
}

function validateGraph(graph: EditorGraph, warnings: Set<string>): void {
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
  })
  if (components > 1) warnings.add('检测到多个未相连的片段，请检查需要连接的端点是否靠近。')
  const valence = graph.atoms.map(() => 0)
  for (const bond of graph.bonds) { valence[bond.from] += bond.order; valence[bond.to] += bond.order }
  graph.atoms.forEach((atom, atomIndex) => {
    if (valence[atomIndex] > elementValence(atom.element) + atom.charge) {
      warnings.add(`有 ${atom.element} 原子的总键级超过常见化合价，请核对键级、电荷或元素标注。`)
    }
  })
  graph.bonds.forEach((bond, index) => {
    for (const other of graph.bonds.slice(index + 1)) {
      if (bond.from === other.from || bond.from === other.to || bond.to === other.from || bond.to === other.to) continue
      if (segmentsIntersect(
        { a: graph.atoms[bond.from], b: graph.atoms[bond.to] },
        { a: graph.atoms[other.from], b: graph.atoms[other.to] },
      )) {
        warnings.add('检测到交叉的化学键，交叉处未自动视为连接；请核对连接关系。')
        return
      }
    }
  })
}

/** 氢原子标注：从图中取出，按隐式氢处理。 */
function removeHydrogenLabels(
  internalBonds: (InternalBond | null)[],
  labelNodes: readonly number[],
  labels: readonly AtomLabel[],
  warnings: Set<string>,
): Set<number> {
  const hidden = new Set<number>()
  labels.forEach((label, index) => {
    if (label.element !== 'H') return
    const node = labelNodes[index]
    if (node === undefined) return
    const incident = incidentBonds(internalBonds, node)
    if (incident.length > 1) warnings.add('手写标注的 H 连接了多根键，已忽略此标注；请检查是否漏画碳原子。')
    else if (incident.length === 1) warnings.add('手写标注的 H 按隐式氢处理，已省略该 H 与它所在的键。')
    else warnings.add('手写标注的 H 没有连接化学键，已忽略；氢原子默认省略。')
    incident.forEach(bondIndex => { internalBonds[bondIndex] = null })
    hidden.add(node)
  })
  return hidden
}

/** 装配主入口：键线 + 原子标签 → EditorGraph。 */
export function assembleGraph(input: AssemblyInput): AssemblyResult {
  const { strokes, extraction, labels, settings } = input
  const warnings = new Set<string>()
  const scale = extraction.scale
  addLowConfidenceWarnings(labels.labels, warnings)
  const validLabels = sanitizeLabels(labels.labels, strokes.length, warnings)
  const claimed = new Set<number>()
  for (const label of validLabels) for (const stroke of label.strokes) claimed.add(stroke)

  const keptLines = extraction.segments.filter(line => !claimed.has(line.strokeIndex))
  const merged = mergeBondLinesWithWarnings(keptLines, settings, scale)
  merged.warnings.forEach(warning => warnings.add(warning))
  const mergedBonds = removeTrailingStubs(merged.bonds, settings, scale)
  const splitBonds = splitBondsAtJunctions(mergedBonds, settings, scale, warnings)
  const bonds = splitBonds.filter(bond => distance(bond.a, bond.b) >= MIN_BOND_PX)

  // 端点、标签与原子节点。
  const endpoints: HanddrawPoint[] = []
  const bondOfEndpoint: number[] = []
  bonds.forEach((bond, index) => { endpoints.push(bond.a, bond.b); bondOfEndpoint.push(index, index) })
  const labelNodes: number[] = validLabels.map(() => -1)
  const nodes: InternalNode[] = []
  validLabels.forEach((label, index) => { labelNodes[index] = nodes.length; nodes.push({ point: label.anchor, label }) })
  const attach = attachLabelsToEndpoints(endpoints, validLabels, settings, scale)
  const unattached = endpoints.map((point, index) => ({ point, index })).filter(entry => attach[entry.index] === undefined)
  const originalIndex = unattached.map(entry => entry.index)
  const clusterBondOfEndpoint = unattached.map(entry => bondOfEndpoint[entry.index])
  const clusterIndexByOriginal = new Map<number, number>()
  unattached.forEach((entry, index) => clusterIndexByOriginal.set(entry.index, index))
  const partnerRef = (originalEndpoint: number): { cluster?: number; label?: number } => {
    const partner = originalEndpoint ^ 1
    const partnerLabel = attach[partner]
    if (partnerLabel !== undefined) return { label: partnerLabel }
    const clusterIndex = clusterIndexByOriginal.get(partner)
    if (clusterIndex !== undefined) return { cluster: clusterIndex }
    return {}
  }
  const clusterPoints = unattached.map(entry => entry.point)
  const snap = snapTolerance(settings, scale)
  // 分笔画环的顶点间隙：约 0.9 倍键长（30～48px）。抬笔留下的空隙与手指精度有关，
  // 画得很小时再保留“画布上 30px”的下限（最多 1.3 倍键长），避免缩放后小图的环连不上。
  const inkScale = Number.isFinite(settings.inkScale) && settings.inkScale! > 0 ? settings.inkScale! : 1
  const vertexGap = Math.max(Math.min(48, Math.max(30, scale * 0.9)), Math.min(30 * inkScale, scale * 1.3))
  const cluster = clusterEndpoints(
    clusterPoints, originalIndex, clusterBondOfEndpoint, bonds, snap, vertexGap, partnerRef,
  )
  const clusterParents = cluster.parents
  const rootPoints = new Map<number, HanddrawPoint[]>()
  clusterParents.forEach((root, index) => {
    const list = rootPoints.get(root) ?? []
    list.push(clusterPoints[index])
    rootPoints.set(root, list)
  })
  const junctionNodeByRoot = new Map<number, number>()
  for (const [root, points] of [...rootPoints.entries()].sort((left, right) => left[0] - right[0])) {
    junctionNodeByRoot.set(root, nodes.length)
    nodes.push({ point: averagePoint(points) })
  }
  const endpointToNode: number[] = new Array(endpoints.length).fill(-1)
  unattached.forEach((entry, index) => { endpointToNode[entry.index] = junctionNodeByRoot.get(clusterParents[index])! })
  endpoints.forEach((_, index) => {
    if (attach[index] !== undefined) endpointToNode[index] = labelNodes[attach[index]!]
  })

  const bondLengths = bonds.map(bond => distance(bond.a, bond.b))
  const internalBonds: (InternalBond | null)[] = bonds.map((bond, index) => ({
    from: endpointToNode[index * 2],
    to: endpointToNode[index * 2 + 1],
    order: bond.order,
  }))
  const hiddenNodes = removeHydrogenLabels(internalBonds, labelNodes, validLabels, warnings)
  const seenPairs = new Map<string, number>()
  const deduped: InternalBond[] = []
  internalBonds.forEach((bond, index) => {
    if (!bond || bond.from !== bond.to) return
    // 很短的“自环”多半是标签旁的多余小笔画；只有明显画出的闭环才提示。
    if ((bondLengths[index] ?? 0) >= scale * 0.55) warnings.add('有一根键的两端落在同一个原子上，已忽略该键；请检查是否画了闭环。')
    internalBonds[index] = null
  })
  for (const bond of internalBonds) {
    if (!bond) continue
    const key = bond.from < bond.to ? `${bond.from}:${bond.to}` : `${bond.to}:${bond.from}`
    const existing = seenPairs.get(key)
    if (existing !== undefined) {
      deduped[existing] = { ...deduped[existing], order: Math.max(deduped[existing].order, bond.order) }
      warnings.add('同一对原子之间识别出多根键，已合并；请核对键级。')
      continue
    }
    seenPairs.set(key, deduped.length)
    deduped.push(bond)
  }
  const aromaticLabels = applyAromaticCircles(nodes, deduped, validLabels, labelNodes, warnings)
  const graph = emitGraph(nodes, deduped, aromaticLabels, labelNodes, scale, warnings, { hiddenNodes })

  // 画面内容都要有归属：成键、成为标签，或明确提示。
  const usedStrokes = new Set<number>(claimed)
  for (const bond of mergedBonds) for (const line of bond.lines) usedStrokes.add(line.strokeIndex)
  for (let index = 0; index < strokes.length; index += 1) {
    if (usedStrokes.has(index)) continue
    const strokePoints = strokes[index]
    if (!strokePoints || strokePoints.length < 2) continue
    warnings.add('画面中有一部分绘画没有识别成原子或键，可能是画得太短、太乱或相互重叠；请检查后重画或点选补充。')
    break
  }

  validateGraph(graph, warnings)
  addNearMissHint(graph, scale, warnings)
  return { graph, warnings: [...warnings] }
}

/** 供 handdraw.ts 判断是否需要报 UNRECOGNIZED。 */
export function graphIsEmpty(graph: EditorGraph): boolean {
  return !graph.atoms.length && !graph.bonds.length
}
