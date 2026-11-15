import { describe, expect, it } from 'vitest'
import {
  averagePoint, bounds, boundsCenter, boundsDiagonal, boundsGap, boundsHeight, boundsNear, boundsOverlapRatio,
  boundsWidth, cornerStrength, cosine, dedupePoints, distance, distanceToSegment, expandBounds, fitCircle,
  lineAngle, midpoint, parallelAngleDifference, parallelOffset, parallelOverlap, pointBoundsDistance, pointInBounds,
  pointInPolygon, polygonArea, polylineLength, projection, resamplePolyline, segmentsIntersect, signedPolygonArea,
  simplifyRdp, straightRuns, turnAngle, unionBounds, unitVector,
} from './geometry'
import type { HanddrawPoint } from './types'

function p(x: number, y: number): HanddrawPoint { return { x, y } }

describe('基础几何量', () => {
  it('距离、中点、平均点与折线长度', () => {
    expect(distance(p(0, 0), p(3, 4))).toBe(5)
    expect(midpoint(p(0, 0), p(10, 4))).toEqual({ x: 5, y: 2 })
    expect(averagePoint([p(0, 0), p(10, 0), p(5, 3)])).toEqual({ x: 5, y: 1 })
    expect(averagePoint([])).toEqual({ x: 0, y: 0 })
    expect(polylineLength([p(0, 0), p(3, 4), p(3, 10)])).toBe(11)
    expect(polylineLength([p(1, 1)])).toBe(0)
  })

  it('单位方向与余弦对零长度安全', () => {
    expect(unitVector(p(0, 0), p(0, 0))).toEqual({ x: 0, y: 0 })
    const unit = unitVector(p(1, 1), p(4, 5))
    expect(unit).toEqual({ x: 0.6, y: 0.8 })
    expect(cosine(unit, unit)).toBeCloseTo(1)
    expect(cosine(p(1, 0), p(-1, 0))).toBeCloseTo(-1)
    expect(cosine(p(0, 0), p(1, 0))).toBe(0)
    expect(lineAngle(p(0, 0), p(0, 5))).toBeCloseTo(Math.PI / 2)
  })
})

describe('包围盒工具', () => {
  it('求包围盒并派生尺寸、中心', () => {
    const box = bounds([p(4, 8), p(-2, 3), p(6, -1)])
    expect(box).toEqual({ minX: -2, minY: -1, maxX: 6, maxY: 8 })
    expect(boundsWidth(box)).toBe(8)
    expect(boundsHeight(box)).toBe(9)
    expect(boundsCenter(box)).toEqual({ x: 2, y: 3.5 })
    expect(boundsDiagonal(box)).toBeCloseTo(Math.hypot(8, 9))
    expect(bounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('合并、扩展、包含关系与点到盒距离', () => {
    const merged = unionBounds({ minX: 0, minY: 0, maxX: 2, maxY: 2 }, { minX: 5, minY: -3, maxX: 6, maxY: 1 })
    expect(merged).toEqual({ minX: 0, minY: -3, maxX: 6, maxY: 2 })
    expect(expandBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 2)).toEqual({ minX: -2, minY: -2, maxX: 3, maxY: 3 })
    expect(pointInBounds(p(1, 2), { minX: 0, minY: 0, maxX: 2, maxY: 3 })).toBe(true)
    expect(pointInBounds(p(-1, 2), { minX: 0, minY: 0, maxX: 2, maxY: 3 })).toBe(false)
    expect(pointBoundsDistance(p(2, 2), { minX: 0, minY: 0, maxX: 1, maxY: 1 })).toBeCloseTo(Math.hypot(1, 1))
    expect(pointBoundsDistance(p(0.5, 0.5), { minX: 0, minY: 0, maxX: 1, maxY: 1 })).toBe(0)
  })

  it('盒间隙、邻近判定与重叠比例', () => {
    const first = { minX: 0, minY: 0, maxX: 2, maxY: 2 }
    const near = { minX: 4, minY: 0, maxX: 6, maxY: 2 }
    const overlap = { minX: 1, minY: 1, maxX: 3, maxY: 3 }
    expect(boundsGap(first, near)).toBe(2)
    expect(boundsGap(first, overlap)).toBe(0)
    expect(boundsNear(first, near, 2)).toBe(true)
    expect(boundsNear(first, near, 1.9)).toBe(false)
    expect(boundsOverlapRatio(first, overlap)).toEqual({ x: 0.5, y: 0.5 })
    expect(boundsOverlapRatio(first, near)).toEqual({ x: 0, y: 1 })
    expect(boundsOverlapRatio({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, first)).toEqual({ x: 0, y: 0 })
  })
})

describe('投影、简化与拐角', () => {
  it('投影参数可越界，距离以线段为准', () => {
    const hit = projection(p(5, 3), p(0, 0), p(10, 0))
    expect(hit.t).toBeCloseTo(0.5)
    expect(hit.distance).toBe(3)
    expect(hit.projected).toEqual({ x: 5, y: 0 })
    const beyond = projection(p(20, 0), p(0, 0), p(10, 0))
    expect(beyond.t).toBe(2)
    expect(beyond.distance).toBe(10)
    expect(beyond.projected).toEqual({ x: 10, y: 0 })
    expect(projection(p(1, 1), p(2, 2), p(2, 2))).toEqual({ t: 0, distance: Math.hypot(1, 1), projected: { x: 2, y: 2 } })
    expect(distanceToSegment(p(5, 2), p(0, 0), p(10, 0))).toBe(2)
  })

  it('RDP 简化保留直角与首尾点', () => {
    const zigzag = [p(0, 0), p(25, 0.5), p(50, 0), p(75, 25), p(100, 25), p(100, 50)]
    const simplified = simplifyRdp(zigzag, 2)
    expect(simplified[0]).toEqual(p(0, 0))
    expect(simplified.at(-1)).toEqual(p(100, 50))
    expect(simplified).toContainEqual(p(50, 0))
    expect(simplified).toContainEqual(p(75, 25))
    expect(simplified).toContainEqual(p(100, 25))
    expect(simplifyRdp([p(0, 0), p(1, 1)], 5)).toEqual([p(0, 0), p(1, 1)])
  })

  it('拐角强度区分直行、直角和折返', () => {
    const straight = [p(0, 0), p(10, 0), p(20, 0)]
    expect(cornerStrength(straight, 1, 9)).toBeCloseTo(0)
    const right = [p(0, 0), p(10, 0), p(10, 10)]
    expect(cornerStrength(right, 1, 9)).toBeCloseTo(1)
    const back = [p(0, 0), p(10, 0), p(0, 0)]
    expect(cornerStrength(back, 1, 9)).toBeCloseTo(2)
    expect(cornerStrength(straight, 0, 9)).toBe(0)
    expect(cornerStrength(straight, 2, 9)).toBe(0)
  })

  it('转角与直线夹角', () => {
    const points = [p(0, 0), p(10, 0), p(10, 10)]
    expect(turnAngle(points, 1)).toBeCloseTo(Math.PI / 2)
    expect(turnAngle(points, 0)).toBe(0)
    expect(turnAngle([p(0, 0), p(1, 0), p(2, 0.0001)], 1)).toBeCloseTo(0, 3)
    expect(parallelAngleDifference(0.1, Math.PI + 0.1)).toBeCloseTo(0)
    expect(parallelAngleDifference(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    expect(parallelAngleDifference(0, Math.PI / 4)).toBeCloseTo(Math.PI / 4)
  })
})

describe('线段关系', () => {
  it('内部交叉判定与端点接触区分', () => {
    const first = { a: p(0, 0), b: p(10, 10) }
    const second = { a: p(0, 10), b: p(10, 0) }
    expect(segmentsIntersect(first, second)).toBe(true)
    expect(segmentsIntersect(first, second, 0.1)).toBe(true)
    const touching = { a: p(0, 0), b: p(-5, 5) }
    expect(segmentsIntersect(first, touching)).toBe(false)
    expect(segmentsIntersect({ a: p(0, 0), b: p(10, 0) }, { a: p(0, 2), b: p(10, 2) })).toBe(false)
    expect(segmentsIntersect({ a: p(0, 0), b: p(0, 0) }, second)).toBe(false)
    expect(segmentsIntersect(first, second, 0.6)).toBe(false)
  })

  it('平行方向上的重叠长度与垂距', () => {
    const base = { a: p(0, 0), b: p(10, 0) }
    expect(parallelOverlap(base, { a: p(2, 3), b: p(8, 3) })).toBe(6)
    expect(parallelOverlap(base, { a: p(20, 3), b: p(30, 3) })).toBe(0)
    expect(parallelOverlap({ a: p(0, 0), b: p(0, 0) }, base)).toBe(0)
    expect(parallelOffset(base, p(5, 3))).toBe(3)
    expect(parallelOffset(base, p(5, -3))).toBe(-3)
    expect(parallelOffset({ a: p(0, 0), b: p(0, 0) }, p(1, 1))).toBe(0)
  })
})

describe('重采样与圆拟合', () => {
  it('按弧长等距重采样，保留首尾点', () => {
    const resampled = resamplePolyline([p(0, 0), p(10, 0), p(10, 10)], 5)
    expect(resampled).toHaveLength(5)
    expect(resampled[0]).toEqual(p(0, 0))
    expect(resampled.at(-1)).toEqual(p(10, 10))
    expect(resampled[2]).toEqual(p(10, 0))
    expect(resamplePolyline([p(3, 4)], 4)).toEqual([p(3, 4)])
    expect(resamplePolyline([], 4)).toEqual([])
    expect(resamplePolyline([p(1, 1), p(1, 1)], 3)).toEqual([p(1, 1), p(1, 1), p(1, 1)])
    expect(resamplePolyline([p(0, 0), p(5, 0)], 1)).toEqual([p(0, 0)])
  })

  it('圆拟合恢复圆心、半径与误差', () => {
    const circle = Array.from({ length: 24 }, (_, index) => {
      const angle = index / 24 * Math.PI * 2
      return p(20 + 5 * Math.cos(angle), -3 + 5 * Math.sin(angle))
    })
    const fit = fitCircle(circle)
    expect(fit).toBeDefined()
    expect(fit!.center.x).toBeCloseTo(20)
    expect(fit!.center.y).toBeCloseTo(-3)
    expect(fit!.radius).toBeCloseTo(5)
    expect(fit!.rms).toBeLessThan(1e-6)
    expect(fitCircle([p(0, 0), p(1, 1)])).toBeUndefined()
    expect(fitCircle([p(0, 0), p(1, 1), p(2, 2)])).toBeUndefined()
    expect(fitCircle([p(0, 0), p(1, 1), p(-1, -1), p(2, 2)])).toBeUndefined()
  })
})

describe('多边形与折线切分', () => {
  const square = [p(0, 0), p(10, 0), p(10, 10), p(0, 10)]
  it('有向面积、面积与点包含', () => {
    expect(signedPolygonArea(square)).toBeCloseTo(100)
    expect(signedPolygonArea([...square].reverse())).toBeCloseTo(-100)
    expect(polygonArea(square)).toBeCloseTo(100)
    expect(pointInPolygon(p(5, 5), square)).toBe(true)
    expect(pointInPolygon(p(15, 5), square)).toBe(false)
    expect(pointInPolygon(p(5, 5), [p(0, 0), p(10, 0), p(10, 10)])).toBe(true)
    expect(pointInPolygon(p(5, 5), [p(0, 0), p(1, 1), p(2, 2)])).toBe(false)
  })

  it('直线段切分把折线拆成相邻两两线段', () => {
    const runs = straightRuns([p(0, 0), p(20, 0), p(20, 20)], 2)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual([p(0, 0), p(20, 0)])
    expect(runs[1]).toEqual([p(20, 0), p(20, 20)])
    expect(straightRuns([p(0, 0)], 2)).toEqual([])
  })

  it('去重采样点保留首个与转折点', () => {
    const deduped = dedupePoints([p(0, 0), p(0.1, 0.1), p(1, 0), p(60, 60)], 0.6)
    expect(deduped).toEqual([p(0, 0), p(1, 0), p(60, 60)])
    expect(dedupePoints([])).toEqual([])
  })
})
