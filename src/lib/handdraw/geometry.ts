import type { Bounds, HanddrawPoint } from './types'

export function distance(a: HanddrawPoint, b: HanddrawPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: HanddrawPoint, b: HanddrawPoint): HanddrawPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function averagePoint(points: readonly HanddrawPoint[]): HanddrawPoint {
  if (!points.length) return { x: 0, y: 0 }
  let x = 0
  let y = 0
  for (const point of points) { x += point.x; y += point.y }
  return { x: x / points.length, y: y / points.length }
}

export function polylineLength(points: readonly HanddrawPoint[]): number {
  let length = 0
  for (let index = 1; index < points.length; index += 1) length += distance(points[index - 1], points[index])
  return length
}

export function bounds(points: readonly HanddrawPoint[]): Bounds {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
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

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

export function expandBounds(box: Bounds, padding: number): Bounds {
  return { minX: box.minX - padding, minY: box.minY - padding, maxX: box.maxX + padding, maxY: box.maxY + padding }
}

export function boundsWidth(box: Bounds): number {
  return box.maxX - box.minX
}

export function boundsHeight(box: Bounds): number {
  return box.maxY - box.minY
}

export function boundsDiagonal(box: Bounds): number {
  return Math.hypot(boundsWidth(box), boundsHeight(box))
}

export function boundsCenter(box: Bounds): HanddrawPoint {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
}

export function pointInBounds(point: HanddrawPoint, box: Bounds): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY
}

/** 点到矩形的最短距离，点在盒内为 0。 */
export function pointBoundsDistance(point: HanddrawPoint, box: Bounds): number {
  const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX)
  const dy = Math.max(box.minY - point.y, 0, point.y - box.maxY)
  return Math.hypot(dx, dy)
}

/** 两个包围盒的间隙距离，相交时返回 0。 */
export function boundsGap(a: Bounds, b: Bounds): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0)
  return Math.hypot(dx, dy)
}

/** 两个包围盒是否相交或间距不超过 gap。 */
export function boundsNear(a: Bounds, b: Bounds, gap: number): boolean {
  return boundsGap(a, b) <= gap
}

/** 两盒在 x / y 方向上的重叠比例（相对于较窄者），0 表示不重叠。 */
export function boundsOverlapRatio(a: Bounds, b: Bounds): { x: number; y: number } {
  const overlapX = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX))
  const overlapY = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY))
  const narrowX = Math.min(boundsWidth(a), boundsWidth(b))
  const narrowY = Math.min(boundsHeight(a), boundsHeight(b))
  return {
    x: narrowX > 0 ? overlapX / narrowX : 0,
    y: narrowY > 0 ? overlapY / narrowY : 0,
  }
}

/** 去掉距离过近的采样点，避免手抖重复点影响几何计算。 */
export function dedupePoints(points: readonly HanddrawPoint[], minDistance = 0.6): HanddrawPoint[] {
  const result: HanddrawPoint[] = []
  for (const point of points) {
    if (!result.length || distance(result[result.length - 1], point) >= minDistance) result.push({ x: point.x, y: point.y })
  }
  return result
}

/** 点在线段方向上的投影：t 为归一化位置（可越界），distance 为到线段的距离。 */
export function projection(point: HanddrawPoint, a: HanddrawPoint, b: HanddrawPoint): { t: number; distance: number; projected: HanddrawPoint } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return { t: 0, distance: distance(point, a), projected: { x: a.x, y: a.y } }
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
  const clamped = Math.max(0, Math.min(1, t))
  const projected = { x: a.x + clamped * dx, y: a.y + clamped * dy }
  return { t, distance: distance(point, projected), projected }
}

export function distanceToSegment(point: HanddrawPoint, a: HanddrawPoint, b: HanddrawPoint): number {
  return projection(point, a, b).distance
}

/**
 * Ramer-Douglas-Peucker 折线简化。
 * 结果保留首尾点与原顺序，不计入被替换掉的中间点。
 */
export function simplifyRdp(points: readonly HanddrawPoint[], tolerance: number): HanddrawPoint[] {
  if (points.length <= 2) return points.map(point => ({ x: point.x, y: point.y }))
  const keep = new Set<number>([0, points.length - 1])
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
      stack.push([start, selected], [selected, end])
    }
  }
  return [...keep].sort((left, right) => left - right).map(index => ({ x: points[index].x, y: points[index].y }))
}

/**
 * 拐角强度：1 + cos(转角)。共线直行为 0，直角约 1，折返约 2。
 * 取拐点前后各 armLength 像素的平均方向，抗手抖。
 */
export function cornerStrength(points: readonly HanddrawPoint[], index: number, armLength = 9): number {
  if (index <= 0 || index >= points.length - 1) return 0
  function arm(direction: number): HanddrawPoint {
    let current = index
    let remaining = armLength
    while (current + direction >= 0 && current + direction < points.length) {
      const next = current + direction
      const length = distance(points[current], points[next])
      if (length >= remaining) {
        return {
          x: points[current].x + (points[next].x - points[current].x) * remaining / length,
          y: points[current].y + (points[next].y - points[current].y) * remaining / length,
        }
      }
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

/** 折线在 index 处的转角，弧度，0 表示直行，π 表示折返。 */
export function turnAngle(points: readonly HanddrawPoint[], index: number): number {
  if (index <= 0 || index >= points.length - 1) return 0
  const before = points[index - 1]
  const current = points[index]
  const after = points[index + 1]
  const ax = current.x - before.x
  const ay = current.y - before.y
  const bx = after.x - current.x
  const by = after.y - current.y
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by)
  if (!lengths) return 0
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / lengths)))
}

export function lineAngle(a: HanddrawPoint, b: HanddrawPoint): number {
  return Math.atan2(b.y - a.y, b.x - a.x)
}

/** 两个方向角之间的最小夹角，0～π/2 用于无向直线。 */
export function parallelAngleDifference(first: number, second: number): number {
  const difference = Math.abs(((first - second) % Math.PI + Math.PI) % Math.PI)
  return Math.min(difference, Math.PI - difference)
}

/**
 * 两条线段是否在内部相交（端点接触不算）。
 * margin 越大，越靠近端点越不视为交叉。
 */
export function segmentsIntersect(
  first: { a: HanddrawPoint; b: HanddrawPoint },
  second: { a: HanddrawPoint; b: HanddrawPoint },
  margin = 0,
): boolean {
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

/** 两条平行线段沿主轴方向的重叠长度。 */
export function parallelOverlap(first: { a: HanddrawPoint; b: HanddrawPoint }, second: { a: HanddrawPoint; b: HanddrawPoint }): number {
  const length = distance(first.a, first.b)
  if (!length) return 0
  const ux = (first.b.x - first.a.x) / length
  const uy = (first.b.y - first.a.y) / length
  const start = (second.a.x - first.a.x) * ux + (second.a.y - first.a.y) * uy
  const end = (second.b.x - first.a.x) * ux + (second.b.y - first.a.y) * uy
  return Math.max(0, Math.min(length, Math.max(start, end)) - Math.max(0, Math.min(start, end)))
}

/** 到起点的垂距（带符号）用于判断两条平行线在主轴哪一侧。 */
export function parallelOffset(first: { a: HanddrawPoint; b: HanddrawPoint }, point: HanddrawPoint): number {
  const length = distance(first.a, first.b)
  if (!length) return 0
  const ux = (first.b.x - first.a.x) / length
  const uy = (first.b.y - first.a.y) / length
  return -(point.x - first.a.x) * uy + (point.y - first.a.y) * ux
}

/** 按弧长等距重采样折线（含首尾点），用于模板匹配与光滑处理。 */
export function resamplePolyline(points: readonly HanddrawPoint[], count: number): HanddrawPoint[] {
  if (!points.length) return []
  if (points.length === 1 || count <= 1) return [{ x: points[0].x, y: points[0].y }]
  const total = polylineLength(points)
  if (total === 0) return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }))
  const step = total / (count - 1)
  const result: HanddrawPoint[] = [{ x: points[0].x, y: points[0].y }]
  let segmentStart = 0
  let segmentLength = distance(points[0], points[1])
  let travelled = 0
  for (let index = 1; index < count - 1; index += 1) {
    const target = index * step
    while (segmentStart < points.length - 2 && travelled + segmentLength < target) {
      travelled += segmentLength
      segmentStart += 1
      segmentLength = distance(points[segmentStart], points[segmentStart + 1])
    }
    const ratio = segmentLength ? (target - travelled) / segmentLength : 0
    result.push({
      x: points[segmentStart].x + (points[segmentStart + 1].x - points[segmentStart].x) * ratio,
      y: points[segmentStart].y + (points[segmentStart + 1].y - points[segmentStart].y) * ratio,
    })
  }
  result.push({ x: points[points.length - 1].x, y: points[points.length - 1].y })
  return result
}

export interface CircleFit {
  center: HanddrawPoint
  radius: number
  /** 半径方向的均方根误差；圆越规整越小。 */
  rms: number
}

/** 代数最小二乘圆拟合（Kåsa），失败时返回 undefined。 */
export function fitCircle(points: readonly HanddrawPoint[]): CircleFit | undefined {
  if (points.length < 3) return undefined
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumYY = 0
  let sumXY = 0
  let sumXZ = 0
  let sumYZ = 0
  let sumZ = 0
  for (const point of points) {
    const z = point.x * point.x + point.y * point.y
    sumX += point.x
    sumY += point.y
    sumXX += point.x * point.x
    sumYY += point.y * point.y
    sumXY += point.x * point.y
    sumXZ += point.x * z
    sumYZ += point.y * z
    sumZ += z
  }
  const count = points.length
  // 正规方程：[Σx² Σxy Σx; Σxy Σy² Σy; Σx Σy n] · [D E F]ᵀ = -[Σxz Σyz Σz]ᵀ
  const matrix = [
    [sumXX, sumXY, sumX, -sumXZ],
    [sumXY, sumYY, sumY, -sumYZ],
    [sumX, sumY, count, -sumZ],
  ]
  for (let column = 0; column < 3; column += 1) {
    let pivot = column
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
    if (Math.abs(matrix[pivot][column]) < 1e-9) return undefined
    if (pivot !== column) { const swap = matrix[pivot]; matrix[pivot] = matrix[column]; matrix[column] = swap }
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue
      const factor = matrix[row][column] / matrix[column][column]
      for (let cell = column; cell < 4; cell += 1) matrix[row][cell] -= factor * matrix[column][cell]
    }
  }
  const d = matrix[0][3] / matrix[0][0]
  const e = matrix[1][3] / matrix[1][1]
  const f = matrix[2][3] / matrix[2][2]
  const center = { x: -d / 2, y: -e / 2 }
  const squaredRadius = center.x * center.x + center.y * center.y - f
  if (!(squaredRadius > 0)) return undefined
  const radius = Math.sqrt(squaredRadius)
  let squaredError = 0
  for (const point of points) {
    const error = distance(point, center) - radius
    squaredError += error * error
  }
  return { center, radius, rms: Math.sqrt(squaredError / count) }
}

/** 多边形有向面积，逆时针为正。 */
export function signedPolygonArea(polygon: readonly HanddrawPoint[]): number {
  let area = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

export function polygonArea(polygon: readonly HanddrawPoint[]): number {
  return Math.abs(signedPolygonArea(polygon))
}

/** 射线法判断点是否在多边形内。 */
export function pointInPolygon(point: HanddrawPoint, polygon: readonly HanddrawPoint[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index]
    const last = polygon[previous]
    if ((current.y > point.y) !== (last.y > point.y)
      && point.x < (last.x - current.x) * (point.y - current.y) / (last.y - current.y) + current.x) inside = !inside
  }
  return inside
}

/** 单位方向向量。 */
export function unitVector(a: HanddrawPoint, b: HanddrawPoint): HanddrawPoint {
  const length = distance(a, b)
  if (!length) return { x: 0, y: 0 }
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
}

/** 两向量夹角余弦。 */
export function cosine(a: HanddrawPoint, b: HanddrawPoint): number {
  const lengths = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)
  if (!lengths) return 0
  return Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / lengths))
}

/** 将折线按直线段近似切分：每段内点到弦距离不超过 tolerance。 */
export function straightRuns(points: readonly HanddrawPoint[], tolerance: number): HanddrawPoint[][] {
  if (points.length < 2) return []
  const simplified = simplifyRdp(points, tolerance)
  const runs: HanddrawPoint[][] = []
  for (let index = 1; index < simplified.length; index += 1) runs.push([simplified[index - 1], simplified[index]])
  return runs
}
