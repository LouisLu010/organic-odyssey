import { describe, expect, it } from 'vitest'
import { extractInk, mergeBondLines, mergeBondLinesWithWarnings } from './bonds'
import { DEFAULT_SETTINGS } from './types'
import type { BondLine, HanddrawPoint, HanddrawStroke, MergedBond, Settings } from './types'

function point(x: number, y: number): HanddrawPoint {
  return { x, y }
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

function line(x1: number, y1: number, x2: number, y2: number): HanddrawStroke {
  return [point(x1, y1), point(x2, y2)]
}

/** 沿折线等距采样并叠加确定性手抖，模拟真实手写。 */
function sampled(vertices: readonly HanddrawPoint[], jitter = 0, seed = 0, step = 2): HanddrawStroke {
  return vertices.slice(1).flatMap((to, index) => {
    const from = vertices[index]
    const count = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step))
    return Array.from({ length: count }, (_, sample) => {
      const ratio = sample / count
      return point(
        from.x + (to.x - from.x) * ratio + (sample ? Math.sin(sample * 2.3 + index + seed) * jitter : 0),
        from.y + (to.y - from.y) * ratio + (sample ? Math.cos(sample * 1.7 + index + seed) * jitter : 0),
      )
    })
  }).concat(vertices[vertices.length - 1])
}

function polygon(size: number, side: number, center = point(300, 300)): HanddrawPoint[] {
  const radius = side / (2 * Math.sin(Math.PI / size))
  const vertices = Array.from({ length: size }, (_, index) => point(
    center.x + Math.cos(-Math.PI / 2 + index * Math.PI * 2 / size) * radius,
    center.y + Math.sin(-Math.PI / 2 + index * Math.PI * 2 / size) * radius,
  ))
  return [...vertices, vertices[0]]
}

/** 把闭合环路径重复画两圈：用于“自由绘画重描”场景。 */
function twoRounds(ring: readonly HanddrawPoint[]): HanddrawPoint[] {
  const loop = ring.slice(0, -1)
  return [...loop, ...loop, loop[0]]
}

function circle(radius: number, gapAngle = 0, jitter = 0, center = point(300, 300)): HanddrawStroke {
  const count = Math.max(48, Math.round(radius * 3))
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = index / count * (2 * Math.PI - gapAngle)
    const wobble = jitter ? Math.sin(index * 1.9) * jitter : 0
    return point(
      center.x + (radius + wobble) * Math.cos(angle),
      center.y + (radius + wobble * 0.6) * Math.sin(angle),
    )
  })
}

function arc(radius: number, sweep: number, startAngle = -0.3, jitter = 0, center = point(300, 300)): HanddrawStroke {
  const count = 61
  return Array.from({ length: count }, (_, index) => {
    const angle = startAngle + index / (count - 1) * sweep
    const wobble = jitter ? Math.sin(index * 1.9) * jitter : 0
    return point(center.x + (radius + wobble) * Math.cos(angle), center.y + (radius + wobble) * Math.sin(angle))
  })
}

function bondLine(ax: number, ay: number, bx: number, by: number, strokeIndex = 0): BondLine {
  return { a: point(ax, ay), b: point(bx, by), strokeIndex }
}

function segmentLength(segment: BondLine): number {
  return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
}

/** 端点接近任一给定点的线段数量。 */
function endpointsNear(segments: readonly BondLine[], anchors: readonly HanddrawPoint[], tolerance = 2): number {
  return segments.filter(segment => anchors.some(anchor =>
    Math.hypot(segment.a.x - anchor.x, segment.a.y - anchor.y) <= tolerance
    || Math.hypot(segment.b.x - anchor.x, segment.b.y - anchor.y) <= tolerance)).length
}

function expectPointNear(actual: HanddrawPoint, expected: HanddrawPoint, tolerance = 2): void {
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThanOrEqual(tolerance)
}

function expectBondNear(bond: MergedBond, a: HanddrawPoint, b: HanddrawPoint, tolerance = 2): void {
  const direct = Math.hypot(bond.a.x - a.x, bond.a.y - a.y) + Math.hypot(bond.b.x - b.x, bond.b.y - b.y)
  const reversed = Math.hypot(bond.a.x - b.x, bond.a.y - b.y) + Math.hypot(bond.b.x - a.x, bond.b.y - a.y)
  expect(Math.min(direct, reversed)).toBeLessThanOrEqual(tolerance)
}

describe('尺度估计', () => {
  it('单根明显键时 scale 取该键长度', () => {
    const extraction = extractInk([line(0, 0, 90, 0)], settings())
    expect(extraction.scale).toBeGreaterThan(70)
    expect(extraction.scale).toBeLessThanOrEqual(92)
  })

  it('忽略圆圈/字母类短笔迹的干扰', () => {
    const strokes: HanddrawStroke[] = [
      sampled([point(0, 100), point(90, 100)], 0.8),
      sampled([point(90, 100), point(150, 55)], 0.8),
      sampled([point(150, 55), point(210, 100)], 0.8),
      circle(20, 0, 0.8, point(320, 90)),
      sampled([point(400, 55), point(400, 135)], 0.6),
      sampled([point(440, 55), point(440, 135)], 0.6),
      sampled([point(400, 95), point(440, 95)], 0.6),
    ]
    const extraction = extractInk(strokes, settings())
    expect(extraction.scale).toBeGreaterThan(70)
    expect(extraction.scale).toBeLessThanOrEqual(120)
  })

  it('clamp 到合理范围，且单根过短的键不会给出极小尺度', () => {
    expect(extractInk([line(0, 0, 400, 0)], settings()).scale).toBeLessThanOrEqual(140)
    expect(extractInk([line(0, 0, 400, 0)], settings()).scale).toBeGreaterThanOrEqual(16)
    expect(extractInk([line(0, 0, 6, 0)], settings()).scale).toBeGreaterThanOrEqual(16)
  })

  it('只有圆/点等无长直线笔迹时回退到常用尺度', () => {
    expect(extractInk([circle(20, 0, 0.6)], settings()).scale).toBeGreaterThanOrEqual(30)
    expect(extractInk([circle(20, 0, 0.6)], settings()).scale).toBeLessThanOrEqual(60)
    expect(extractInk([[point(5, 5)]], settings()).scale).toBeGreaterThanOrEqual(30)
  })

  it('单根键 + 一手写字母时不把字母笔画当成键长', () => {
    const letterStrokes: HanddrawStroke[] = [
      sampled([point(220, 60), point(220, 100)], 0.5),
      sampled([point(250, 60), point(250, 100)], 0.5),
      sampled([point(220, 80), point(250, 80)], 0.5),
      sampled([point(280, 60), point(280, 100)], 0.5),
      sampled([point(280, 100), point(300, 80), point(280, 60)], 0.5),
    ]
    const extraction = extractInk([sampled(line(80, 80, 132, 72), 0.8), ...letterStrokes], settings())
    expect(extraction.scale).toBeGreaterThan(40)
    expect(extraction.scale).toBeLessThanOrEqual(70)
  })

  it('一笔八边形在稀疏采样与更明显手抖下仍保留 8 条边', () => {
    const extraction = extractInk([sampled(polygon(8, 52), 1.2, 3, 3)], settings())
    expect(extraction.segments).toHaveLength(8)
    expect(extraction.segments.every(segment => segmentLength(segment) >= 20)).toBe(true)
  })

  it('空输入不崩溃且返回空结果', () => {
    const extraction = extractInk([], settings())
    expect(extraction.segments).toEqual([])
    expect(extraction.warnings).toEqual([])
    expect(extraction.scale).toBeGreaterThan(0)
  })
})

describe('直线与手抖', () => {
  it('手抖直线切成一条线段，端点接近原笔画端点', () => {
    const extraction = extractInk([sampled(line(40, 80, 160, 90), 1.2)], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(extraction.segments[0].strokeIndex).toBe(0)
    expectPointNear(extraction.segments[0].a, point(40, 80), 3)
    expectPointNear(extraction.segments[0].b, point(160, 90), 3)
    expect(extraction.warnings).toEqual([])
  })

  it('弓形的手抖键线仍还原成一条直线段', () => {
    const bowed = Array.from({ length: 61 }, (_, index) => {
      const ratio = index / 60
      return point(40 + 120 * ratio, 100 + Math.sin(Math.PI * ratio) * 10)
    })
    const extraction = extractInk([bowed], settings())
    expect(extraction.segments).toHaveLength(1)
    expectPointNear(extraction.segments[0].a, point(40, 100), 1)
    expectPointNear(extraction.segments[0].b, point(160, 100), 1)
  })

  it('多条笔迹分别输出线段并保留原始 strokeIndex', () => {
    const extraction = extractInk([
      sampled(line(0, 0, 80, 0), 0.8),
      circle(18, 0, 0.5, point(200, 100)),
      sampled(line(0, 80, 80, 80), 0.8),
    ], settings())
    expect(extraction.segments).toHaveLength(2)
    expect(extraction.segments.map(segment => segment.strokeIndex).sort()).toEqual([0, 2])
  })

  it('折线链每个拐点之间输出一条线段', () => {
    const vertices = [point(20, 140), point(80, 90), point(140, 140), point(200, 90), point(260, 140)]
    const extraction = extractInk([sampled(vertices, 0.8)], settings())
    expect(extraction.segments).toHaveLength(4)
    expect(extraction.segments.every(segment => segment.strokeIndex === 0)).toBe(true)
    for (const segment of extraction.segments) expect(segmentLength(segment)).toBeGreaterThan(30)
    // 每个内部拐点都应是某条线段的端点。
    for (const vertex of vertices.slice(1, -1)) expect(endpointsNear(extraction.segments, [vertex], 3)).toBeGreaterThan(0)
  })

  it('分笔画的折线只输出各自的直线段', () => {
    const extraction = extractInk([
      sampled(line(0, 0, 70, 0), 0.6),
      sampled(line(70, 0, 120, 50), 0.6),
      sampled(line(120, 50, 170, 0), 0.6),
    ], settings())
    expect(extraction.segments).toHaveLength(3)
    expect(extraction.segments.map(segment => segment.strokeIndex)).toEqual([0, 1, 2])
  })

  it('没有任何拐角的直线不被切成多段', () => {
    const extraction = extractInk([sampled(line(0, 40, 250, 44), 1.2)], settings())
    expect(extraction.segments).toHaveLength(1)
  })
})

describe('闭合笔迹：多边形环与圆形排除', () => {
  it.each([3, 4, 5, 6, 7, 8])('一笔 %i 元环保留 %i 条边', size => {
    const ring = polygon(size, 50)
    for (let seed = 0; seed < 3; seed += 1) {
      const extraction = extractInk([sampled(ring, 0.8, seed)], settings())
      expect(extraction.segments, `ring ${size} seed ${seed}`).toHaveLength(size)
      for (const segment of extraction.segments) expect(segmentLength(segment)).toBeGreaterThan(12)
      expect(extraction.segments.every(segment => segment.strokeIndex === 0)).toBe(true)
      // 每条边的两个端点都应落在多边形顶点附近。
      expect(endpointsNear(extraction.segments, ring, 3)).toBeGreaterThanOrEqual(size)
    }
  })

  it('从一条边中段起笔的一笔六元环仍然保留 6 个顶点', () => {
    const ring = polygon(6, 50)
    const middle = point((ring[0].x + ring[1].x) / 2, (ring[0].y + ring[1].y) / 2)
    const stroke = sampled([middle, ...ring.slice(1), middle], 0.5)
    const extraction = extractInk([stroke], settings())
    expect(extraction.segments).toHaveLength(6)
    expect(endpointsNear(extraction.segments, ring, 3)).toBeGreaterThanOrEqual(6)
  })

  it('分笔画闭合的环每条边独立输出', () => {
    const ring = polygon(6, 50)
    const strokes = ring.slice(1).map((to, index) => sampled([ring[index], to], 0.6))
    const extraction = extractInk(strokes, settings())
    expect(extraction.segments).toHaveLength(6)
    expect(extraction.segments.map(segment => segment.strokeIndex).sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it.each([12, 20, 40])('半径 %i 的圆不被当成键线', radius => {
    for (const gap of [0, 0.35]) {
      const extraction = extractInk([circle(radius, gap, 0.8)], settings())
      expect(extraction.segments, `circle radius ${radius} gap ${gap}`).toEqual([])
    }
  })

  it('椭圆与开口圆弧也不被当成键线', () => {
    const ellipse = circle(24, 0, 0.6).map(cell => point(cell.x, 300 + (cell.y - 300) * 0.6))
    expect(extractInk([ellipse], settings()).segments).toEqual([])
    expect(extractInk([arc(20, 2.6, -0.3, 0.6)], settings()).segments).toEqual([])
    expect(extractInk([arc(40, Math.PI, 0, 0.8)], settings()).segments).toEqual([])
  })

  it('混有圆圈时直键仍被识别，圆圈静默交给 glyph', () => {
    const extraction = extractInk([sampled(line(10, 10, 90, 10), 0.6), circle(20, 0, 0.6, point(300, 100))], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(extraction.warnings).toEqual([])
  })

  it('自相交的闭合涂鸦被丢弃并给出中文提示', () => {
    const bowtie = [point(0, 0), point(70, 70), point(0, 70), point(70, 0), point(0, 0)]
    const extraction = extractInk([sampled(bowtie, 0.5)], settings())
    expect(extraction.segments).toEqual([])
    expect(extraction.warnings.some(warning => warning.includes('闭合笔迹'))).toBe(true)
  })

  it('闭合笔迹里出现过短的边时降级为折线，不输出过短键线', () => {
    // 三角形的一条边缩到 10px：闭合环校验失败后降级为折线，过短边被手抖清理静默吸收。
    const shortened = sampled([point(0, 0), point(10, 0), point(26, 45), point(0, 0)], 0.4)
    const extraction = extractInk([shortened], settings())
    expect(extraction.segments.length).toBeGreaterThan(0)
    expect(extraction.segments.every(segment => segmentLength(segment) >= 12)).toBe(true)
  })

  it('六边形环 + 内侧圆圈只输出环的 6 条边，不产生警告', () => {
    const ring = sampled(polygon(6, 58), 0.8)
    const innerCircle = Array.from({ length: 27 }, (_, index) => {
      const angle = index / 26 * Math.PI * 2.02
      return point(300 + 27 * Math.cos(angle), 300 + 25 * Math.sin(angle))
    })
    const extraction = extractInk([ring, innerCircle], settings())
    expect(extraction.segments).toHaveLength(6)
    expect(extraction.warnings).toEqual([])
  })
})

describe('自由绘画：环重描与抬笔拆段', () => {
  it('一笔把六元环重描两圈仍只输出一个六元环', () => {
    const ring = polygon(6, 55, point(300, 200))
    const extraction = extractInk([sampled(twoRounds(ring), 0.4)], settings())
    expect(extraction.scale).toBeGreaterThan(40)
    expect(extraction.warnings).toEqual([])
    expect(extraction.segments).toHaveLength(6)
    expect(extraction.segments.every(segment => segment.strokeIndex === 0)).toBe(true)
    for (const vertex of ring.slice(0, -1)) expect(endpointsNear(extraction.segments, [vertex], 4)).toBeGreaterThan(0)
    const bonds = mergeBondLines(extraction.segments, settings(), extraction.scale)
    expect(bonds).toHaveLength(6)
    expect(bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it.each([3, 5, 8])('一笔把 %i 元环重描两圈仍输出 %i 条边', size => {
    const ring = polygon(size, 55, point(300, 200))
    for (let seed = 0; seed < 3; seed += 1) {
      const extraction = extractInk([sampled(twoRounds(ring), 0.4, seed)], settings())
      expect(extraction.segments, `ring ${size} seed ${seed}`).toHaveLength(size)
      expect(extraction.warnings).toEqual([])
    }
  })

  it('从一条边中段起笔把六边形重描两圈仍输出 6 条等长直边', () => {
    const ring = polygon(6, 55, point(300, 200))
    const middle = point((ring[0].x + ring[1].x) / 2, (ring[0].y + ring[1].y) / 2)
    const loop = [middle, ...ring.slice(1), middle]
    const doubled = [...loop.slice(0, -1), ...loop.slice(0, -1), loop[0]]
    const extraction = extractInk([sampled(doubled, 0.4)], settings())
    expect(extraction.segments).toHaveLength(6)
    for (const segment of extraction.segments) expect(segmentLength(segment)).toBeGreaterThan(45)
    expect(extraction.warnings).toEqual([])
  })

  it('反向重描两圈（第二圈倒着画）也能合并成一个环', () => {
    const ring = polygon(6, 55, point(300, 200))
    const forward = ring.slice(0, -1)
    const doubled = [...forward, forward[0], ...forward.slice().reverse()]
    const extraction = extractInk([sampled(doubled, 0.4)], settings())
    expect(extraction.segments).toHaveLength(6)
    expect(extraction.warnings).toEqual([])
  })

  it('重描两圈后仍然自相交的无效闭合笔迹继续被拒绝并提示', () => {
    const bowtie = [point(0, 0), point(70, 70), point(0, 70), point(70, 0)]
    const doubled = [...bowtie, ...bowtie, bowtie[0]]
    const extraction = extractInk([sampled(doubled, 0.4)], settings())
    expect(extraction.segments).toEqual([])
    expect(extraction.warnings.some(warning => warning.includes('闭合笔迹'))).toBe(true)
  })

  it('三笔完全重合的环只产生 6 根单键，不重复建键', () => {
    const ring = polygon(6, 55, point(300, 200))
    const extraction = extractInk([sampled(ring, 0.5), sampled(ring, 0.5, 3), sampled(ring, 0.5, 7)], settings())
    expect(extraction.segments).toHaveLength(18)
    const result = mergeBondLinesWithWarnings(extraction.segments, settings(), extraction.scale)
    expect(result.bonds).toHaveLength(6)
    expect(result.bonds.every(bond => bond.order === 1)).toBe(true)
    expect(result.bonds.every(bond => bond.lines.length === 3)).toBe(true)
    expect(result.warnings.some(warning => warning.includes('重画'))).toBe(true)
  })

  it('一笔连续画完六元环再接着画支链：6 条环边 + 1 条支链', () => {
    const ring = polygon(6, 55, point(300, 200))
    const order = [2, 3, 4, 5, 0, 1, 2]
    const vertices = order.map(index => ring[index])
    const start = ring[2]
    const unit = { x: (start.x - 300) / 55, y: (start.y - 200) / 55 }
    const branchEnd = point(start.x + unit.x * 55, start.y + unit.y * 55)
    const extraction = extractInk([sampled([...vertices, branchEnd], 0.5)], settings())
    expect(extraction.segments).toHaveLength(7)
    expect(extraction.warnings).toEqual([])
    const bonds = mergeBondLines(extraction.segments, settings(), extraction.scale)
    expect(bonds).toHaveLength(7)
    expect(bonds.every(bond => bond.order === 1)).toBe(true)
  })
})

describe('用户潦草手绘环（照片矢量化回归）', () => {
  /** drawing0 的左侧+底部+右下长笔（含 26° 手抖浅折角）。 */
  const scribbleDrawing0Stroke2: [number, number][] = [
    [86, 419], [86.9, 419.2], [89.5, 419.6], [93, 420.3], [101, 421.7], [105.1, 422.7], [109.5, 424.1],
    [112.8, 425.6], [118.2, 428.4], [123.2, 432.1], [132.6, 440.3], [143.5, 450.2], [166.5, 471.8],
    [177, 481.5], [185.6, 488.9], [189.2, 491.6], [191.8, 492.4], [194.2, 491.5], [199, 488.3],
    [204.6, 483.7], [216.4, 473.3], [223.8, 466.4], [233.8, 456.2], [243.3, 446.1], [261.7, 425.9],
    [269.6, 416], [275.2, 406.4], [276.4, 400.3], [274.6, 391.7], [274.7, 383.2], [276.9, 366.6],
    [280.4, 347.2], [288.6, 305.8], [292.3, 287.4], [295.1, 273.6], [296, 269],
  ]
  /** drawing3 的右侧弯曲边（手画的弧线环边）。 */
  const scribbleDrawing3Stroke3: [number, number][] = [
    [1728, 449], [1729.2, 448.4], [1732.6, 446.6], [1737.3, 444.2], [1747.7, 438.8], [1754.3, 434.9],
    [1763.7, 428.7], [1772.7, 422.2], [1790.3, 408.8], [1798.4, 401.4], [1805, 392.2], [1807.9, 384.5],
    [1810.1, 370.5], [1811, 361.2], [1811.6, 347.6], [1811.7, 334], [1811.3, 307], [1811.3, 294.6],
    [1811.5, 284.2], [1812, 279.5], [1813, 275.5], [1813.5, 273.8], [1813.9, 272.4], [1814, 272],
  ]

  it('手抖 26° 浅折角被合并，真实 60° 折线拐角保留', () => {
    const shallow = sampled([point(0, 100), point(100, 100), point(200, 150)], 0.5)
    expect(extractInk([shallow], settings()).segments).toHaveLength(1)
    const sharp = sampled([point(0, 100), point(100, 100), point(150, 187)], 0.5)
    expect(extractInk([sharp], settings()).segments).toHaveLength(2)
  })

  it('潦草长笔迹不再在浅折角处切分出多余顶点', () => {
    const stroke = scribbleDrawing0Stroke2.map(([x, y]) => point(x, y))
    const extraction = extractInk([stroke], settings())
    expect(extraction.warnings).toEqual([])
    expect(extraction.segments).toHaveLength(3)
    for (const segment of extraction.segments) expect(segmentLength(segment)).toBeGreaterThan(90)
    // 浅折角 (118,428) 不再是任何线段的端点。
    for (const segment of extraction.segments) {
      expect(Math.hypot(segment.a.x - 118.2, segment.a.y - 428.4)).toBeGreaterThan(8)
      expect(Math.hypot(segment.b.x - 118.2, segment.b.y - 428.4)).toBeGreaterThan(8)
    }
    expectPointNear(extraction.segments[0].a, point(86, 419), 2)
    expectPointNear(extraction.segments[2].b, point(296, 269), 2)
  })

  it('手画的弯曲长环边作为弓形键输出，并在圆角处补回顶点', () => {
    const stroke = scribbleDrawing3Stroke3.map(([x, y]) => point(x, y))
    const extraction = extractInk([stroke], settings())
    expect(extraction.warnings).toEqual([])
    expect(extraction.segments).toHaveLength(2)
    expectPointNear(extraction.segments[0].a, point(1728, 449), 2)
    expectPointNear(extraction.segments[1].b, point(1814, 272), 2)
    expectPointNear(extraction.segments[0].b, extraction.segments[1].a, 0.5)
    const chord = Math.hypot(extraction.segments[1].b.x - extraction.segments[0].a.x, extraction.segments[1].b.y - extraction.segments[0].a.y)
    expect(chord).toBeGreaterThan(150)
  })

  it('弯曲不过分的长弧只输出一条弓形键，不额外拆出原子', () => {
    const straight = sampled(line(0, 200, 100, 200), 0.5)
    // 半径 55.3、张角 1.9 的弧：弦长 ≈90、路径 ≈105（≈1.05*scale），弦高/弦长 ≈0.26。
    const radius = 90 / (2 * Math.sin(0.95))
    const curved = Array.from({ length: 61 }, (_, index) => {
      const angle = -0.95 + index / 60 * 1.9
      return point(400 + radius * Math.cos(angle), 200 + radius * Math.sin(angle))
    })
    const extraction = extractInk([straight, curved], settings())
    expect(extraction.scale).toBeGreaterThan(80)
    expect(extraction.warnings).toEqual([])
    expect(extraction.segments).toHaveLength(2)
    const bowed = extraction.segments[1]
    expect(segmentLength(bowed)).toBeGreaterThan(80)
    expectPointNear(bowed.a, curved[0], 2)
    expectPointNear(bowed.b, curved[curved.length - 1], 2)
  })

  it('手抖收笔小勾不再触发“过短键线”提示', () => {
    const hooked = sampled([point(0, 100), point(100, 100), point(105, 105)], 0.5)
    const extraction = extractInk([hooked], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(extraction.warnings).toEqual([])
    expect(segmentLength(extraction.segments[0])).toBeGreaterThan(90)
  })
})

describe('多重键合并', () => {
  it('两条平行线合并为双键，代表端点取最长成员线', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 100, 0), bondLine(10, 12, 90, 12)], settings(), 80)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(2)
    expectBondNear(bonds[0], point(0, 0), point(100, 0))
    expect(bonds[0].lines).toHaveLength(2)
  })

  it('反向书写的平行线同样合并为双键', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 100, 0), bondLine(90, 12, 10, 12)], settings(), 80)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(2)
  })

  it('较短的内部平行线合并为双键并保留外线端点', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 100, 0), bondLine(25, 10, 70, 10)], settings(), 80)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(2)
    expectBondNear(bonds[0], point(0, 0), point(100, 0))
  })

  it('两端不齐、轻微不平行的双线仍合并为双键', () => {
    const bonds = mergeBonds([bondLine(0, 0, 100, 0), bondLine(-8, 9, 96, 15)], 80)
    expect(bonds[0].order).toBe(2)
  })

  it('三条平行线合并为三键', () => {
    const bonds = mergeBondLines([
      bondLine(0, 0, 100, 0),
      bondLine(5, 10, 95, 10),
      bondLine(0, 20, 100, 20),
    ], settings(), 80)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(3)
    expect(bonds[0].lines).toHaveLength(3)
  })

  it('四条平行线最多输出三键并提示', () => {
    const result = mergeBondLinesWithWarnings([
      bondLine(0, 0, 100, 0),
      bondLine(0, 10, 100, 10),
      bondLine(0, 20, 100, 20),
      bondLine(0, 30, 100, 30),
    ], settings(), 80)
    expect(result.bonds).toHaveLength(1)
    expect(result.bonds[0].order).toBe(3)
    expect(result.warnings.some(warning => warning.includes('超过三条'))).toBe(true)
  })

  it('同一位置重画压成单键并提示，lines 保留全部重画线', () => {
    const result = mergeBondLinesWithWarnings([bondLine(0, 0, 100, 0), bondLine(98, 2, 2, 2)], settings(), 80)
    expect(result.bonds).toHaveLength(1)
    expect(result.bonds[0].order).toBe(1)
    expect(result.warnings.some(warning => warning.includes('重画'))).toBe(true)
    expect(result.bonds[0].lines).toHaveLength(2)
  })

  it('共线的一段短重描按单键处理', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 100, 0), bondLine(25, 2, 75, 2)], settings(), 80)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(1)
  })

  it('双键中一条线被重画时仍是双键，lines 保留全部重画线', () => {
    const result = mergeBondLinesWithWarnings([
      bondLine(0, 0, 100, 0),
      bondLine(2, 1, 98, 1),
      bondLine(15, 10, 85, 10),
    ], settings(), 80)
    expect(result.bonds).toHaveLength(1)
    expect(result.bonds[0].order).toBe(2)
    expect(result.bonds[0].lines).toHaveLength(3)
    expect(result.warnings.some(warning => warning.includes('重画'))).toBe(true)
  })

  it('独立且相距较远的平行线不会被误并', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 100, 0), bondLine(0, 55, 100, 55)], settings(), 80)
    expect(bonds).toHaveLength(2)
    expect(bonds.map(bond => bond.order)).toEqual([1, 1])
  })

  it('近平行但相交的线不会被误并', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 120, 0), bondLine(0, -8, 120, 8)], settings(), 80)
    expect(bonds).toHaveLength(2)
    expect(bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('同一点发散的支线不会被误并', () => {
    const bonds = mergeBondLines([bondLine(0, 0, 100, 0), bondLine(0, 0, 100, 14)], settings(), 80)
    expect(bonds).toHaveLength(2)
    expect(bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('分笔环的相邻两边不会因靠近而合并', () => {
    const bonds = mergeBondLines([
      bondLine(0, 0, 100, 0),
      bondLine(100, 0, 150, 86),
      bondLine(150, 86, 0, 0),
    ], settings(), 100)
    expect(bonds).toHaveLength(3)
    expect(bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('输入顺序不同但几何相同，输出顺序稳定可复现', () => {
    const segments = [
      bondLine(0, 60, 100, 60),
      bondLine(0, 0, 100, 0),
      bondLine(0, 10, 100, 10),
    ]
    const first = mergeBondLines(segments, settings(), 80)
    const second = mergeBondLines(segments, settings(), 80)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    // 输出顺序按输入线段首次出现顺序：先是第 0 条单键，再是第 1、2 条组成的双键。
    expect(first[0].order).toBe(1)
    expect(first[1].order).toBe(2)
  })

  it('空输入与非法线段不崩溃', () => {
    expect(mergeBondLines([], settings(), 80)).toEqual([])
    const degenerate: BondLine[] = [
      { a: point(0, 0), b: point(0, 0), strokeIndex: 0 },
      { a: point(Number.NaN, 0), b: point(10, 0), strokeIndex: 1 },
    ]
    expect(mergeBondLines(degenerate, settings(), 80)).toEqual([])
    expect(mergeBondLines([bondLine(0, 0, 100, 0)], settings(), Number.NaN)).toHaveLength(1)
  })

  it('多重键间距上限按 scale 收紧，过远的平行线保持独立', () => {
    // 0.2*scale 的手绘双键间距可合并；0.26*scale 已明显偏大，按独立键处理。
    expect(mergeBondLines([bondLine(0, 0, 100, 0), bondLine(0, 20, 100, 20)], settings(), 80)[0].order).toBe(2)
    expect(mergeBondLines([bondLine(0, 0, 100, 0), bondLine(0, 26, 100, 26)], settings(), 80)).toHaveLength(2)
    expect(mergeBondLines([bondLine(0, 0, 100, 0), bondLine(0, 70, 100, 70)], settings(), 60)).toHaveLength(2)
    // 十条线段排成一行但不互相靠近时也不会连锁误并。
    const chain = Array.from({ length: 4 }, (_, index) => bondLine(0, index * 40, 100, index * 40))
    expect(mergeBondLines(chain, settings(), 80).every(bond => bond.order === 1)).toBe(true)
  })
})

/** 便捷入口：用默认 settings 合并。 */
function mergeBonds(segments: readonly BondLine[], scale: number): MergedBond[] {
  return mergeBondLines(segments, settings(), scale)
}

describe('折返重描', () => {
  it('完全折返重描按单键输出并提示', () => {
    const stroke = sampled([point(0, 0), point(100, 0), point(0, 0)], 0.5)
    const extraction = extractInk([stroke], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(extraction.warnings.some(warning => warning.includes('折返'))).toBe(true)
  })

  it('折返且带轻微漂移时输出两条反向平行线，合并为双键', () => {
    const stroke = sampled([point(0, 0), point(100, 0), point(0, 14)], 0.4)
    const extraction = extractInk([stroke], settings())
    expect(extraction.segments).toHaveLength(2)
    const bonds = mergeBondLines(extraction.segments, settings(), extraction.scale)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(2)
  })

  it('U 形折返（一笔画双键）丢弃连接段，得到两条平行线', () => {
    const stroke = sampled([
      point(0, 0), point(100, 0), point(108, 4), point(108, 12), point(100, 16), point(0, 16),
    ], 0.3)
    const extraction = extractInk([stroke], settings())
    expect(extraction.segments).toHaveLength(2)
    expect(extraction.segments.every(segment => segmentLength(segment) > 80)).toBe(true)
    const bonds = mergeBondLines(extraction.segments, settings(), extraction.scale)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(2)
  })

  it('折返过近时不产生两条重合的双键线', () => {
    const stroke = sampled([point(0, 0), point(120, 0), point(0, 4)], 0.4)
    const extraction = extractInk([stroke], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(mergeBondLines(extraction.segments, settings(), extraction.scale)).toHaveLength(1)
  })
})

describe('过短线与上限', () => {
  it('折线中的过短线段被过滤并提示', () => {
    const zigzag = [point(0, 100), point(90, 100), point(94, 107), point(184, 107)]
    const extraction = extractInk([sampled(zigzag, 0.3)], settings())
    expect(extraction.warnings.some(warning => warning.includes('过短'))).toBe(true)
    expect(extraction.segments.every(segment => segmentLength(segment) >= 12)).toBe(true)
  })

  it('标签里的小笔画不刷“过短”提示', () => {
    const charge = [line(0, 0, 8, 0), line(4, -4, 4, 4)]
    const extraction = extractInk([...charge, line(0, 40, 90, 40)], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(extraction.warnings).not.toContain('已忽略过短的键线，请把化学键画长一些。')
  })

  it('线段数量超过上限时给出提示而不是静默截断', () => {
    const zigzag = Array.from({ length: 330 }, (_, index) => point(index * 20, index % 2 ? 0 : 40))
    const extraction = extractInk([zigzag], settings())
    expect(extraction.segments.length).toBeGreaterThan(320)
    expect(extraction.warnings.some(warning => warning.includes('太多'))).toBe(true)
  })
})

describe('健壮性与不可变性', () => {
  it('非法 settings 不崩溃，回退默认值', () => {
    const broken = { ...DEFAULT_SETTINGS, simplifyTolerance: Number.NaN, minBondLength: -3, snapDistance: 0 } as Settings
    const extraction = extractInk([sampled(line(0, 0, 90, 0), 0.6)], broken)
    expect(extraction.segments.length).toBeGreaterThan(0)
    expect(extraction.scale).toBeGreaterThan(0)
  })

  it('包含非法坐标的笔迹被忽略', () => {
    const extraction = extractInk([
      [point(Number.NaN, 0), point(10, 0)],
      sampled(line(0, 0, 90, 0), 0.6),
    ], settings())
    expect(extraction.segments).toHaveLength(1)
    expect(extraction.segments[0].strokeIndex).toBe(1)
  })

  it('冻结的输入笔迹不会被修改', () => {
    const strokes = [sampled(line(0, 0, 90, 0), 0.8), sampled(polygon(6, 50), 0.6)]
    const snapshot = structuredClone(strokes)
    for (const stroke of strokes) {
      for (const cell of stroke) Object.freeze(cell)
      Object.freeze(stroke)
    }
    Object.freeze(strokes)
    const extraction = extractInk(strokes, Object.freeze(settings()))
    expect(extraction.segments.length).toBeGreaterThan(0)
    expect(strokes).toEqual(snapshot)
  })

  it('合并输出不复用输入对象，避免下游误改', () => {
    const first = bondLine(0, 0, 100, 0)
    const bonds = mergeBondLines([first], settings(), 80)
    expect(bonds[0].a).not.toBe(first.a)
    bonds[0].a.x = -1
    expect(first.a.x).toBe(0)
  })

  it('多根手写键的完整链路：提取 + 合并', () => {
    const extraction = extractInk([
      sampled(line(0, 0, 100, 0), 0.8),
      sampled(line(0, 14, 100, 14), 0.8),
    ], settings())
    expect(extraction.segments).toHaveLength(2)
    const bonds = mergeBondLines(extraction.segments, settings(), extraction.scale)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].order).toBe(2)
  })
})
