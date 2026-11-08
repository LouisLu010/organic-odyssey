import { describe, expect, it } from 'vitest'
import type { EditorGraph } from './moleculeEditor'
import { HanddrawRecognitionError, recognizeHanddraw } from './handdraw'
import type { HanddrawOptions, HanddrawPoint, HanddrawStroke } from './handdraw'

function point(x: number, y: number): HanddrawPoint { return { x, y } }
function line(x1: number, y1: number, x2: number, y2: number): HanddrawStroke { return [point(x1, y1), point(x2, y2)] }

function polygon(size: number, side = 50, center = point(150, 150)): HanddrawStroke {
  const radius = side / (2 * Math.sin(Math.PI / size))
  const vertices = Array.from({ length: size }, (_, index) => point(center.x + Math.cos(-Math.PI / 2 + index * Math.PI * 2 / size) * radius, center.y + Math.sin(-Math.PI / 2 + index * Math.PI * 2 / size) * radius))
  return [...vertices, { ...vertices[0] }]
}

function sampled(vertices: HanddrawStroke, jitter = 0, seed = 0): HanddrawStroke {
  return vertices.slice(1).flatMap((to, index) => {
    const from = vertices[index]
    const count = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2))
    return Array.from({ length: count }, (_, step) => {
      const ratio = step / count
      return point(from.x + (to.x - from.x) * ratio + (step ? Math.sin(step * 2.3 + index + seed) * jitter : 0), from.y + (to.y - from.y) * ratio + (step ? Math.cos(step * 1.7 + index + seed) * jitter : 0))
    })
  }).concat(vertices.at(-1)!)
}

function circle(radius: number, gap = 0): HanddrawStroke {
  return Array.from({ length: 101 }, (_, index) => {
    const angle = index / 100 * (2 * Math.PI - gap)
    return point(150 + radius * Math.cos(angle), 150 + radius * Math.sin(angle))
  })
}

function degrees(graph: EditorGraph): number[] {
  return graph.atoms.map((_, index) => graph.bonds.filter(bond => bond.from === index || bond.to === index).length).sort((left, right) => left - right)
}

function expectError(strokes: readonly (readonly HanddrawPoint[])[], code: HanddrawRecognitionError['code'], options?: HanddrawOptions) {
  try {
    recognizeHanddraw(strokes, options)
    expect.fail('Recognition should fail')
  } catch (error) {
    expect(error).toBeInstanceOf(HanddrawRecognitionError)
    expect(error).toMatchObject({ code })
    expect((error as Error).message.length).toBeGreaterThan(5)
  }
}

describe('直线、折线与端点吸附', () => {
  it('手抖直线识别为单键，所有原子默认不带电的碳', () => {
    const { graph, warnings } = recognizeHanddraw([sampled(line(50, 80, 110, 80), 1.2)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toEqual([{ from: 0, to: 1, order: 1 }])
    expect(graph.atoms.every(atom => atom.element === 'C' && atom.charge === 0)).toBe(true)
    expect(warnings).toEqual([])
  })

  it('一笔连续折线只在端点与明显拐角建立碳原子', () => {
    const vertices = [point(20, 100), point(65, 75), point(110, 100), point(155, 75), point(200, 100)]
    const { graph } = recognizeHanddraw([sampled(vertices, 0.9)])
    expect(graph.atoms).toHaveLength(5)
    expect(graph.bonds).toHaveLength(4)
    expect(degrees(graph)).toEqual([1, 1, 2, 2, 2])
    expect(graph.bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('长直线不凭长度擅自增加碳原子', () => {
    const { graph } = recognizeHanddraw([sampled(line(0, 0, 250, 0), 0.5)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
  })

  it('分笔碳链的近端点吸附，保留实际屏幕坐标', () => {
    const { graph } = recognizeHanddraw([line(20, 80, 65, 55), line(69, 58, 110, 80)])
    expect(graph.atoms).toHaveLength(3)
    expect(graph.bonds).toHaveLength(2)
    expect(graph.atoms.some(atom => atom.x === 67 && atom.y === 56.5)).toBe(true)
  })

  it('端点相距超过吸附范围时不强行连接并给出提示', () => {
    const { graph, warnings } = recognizeHanddraw([line(0, 0, 50, 0), line(63, 0, 110, 0)])
    expect(graph.atoms).toHaveLength(4)
    expect(warnings.some(warning => warning.includes('未相连'))).toBe(true)
  })

  it('分支在已有折线顶点处吸附', () => {
    const { graph, warnings } = recognizeHanddraw([[point(10, 80), point(60, 50), point(110, 80)], line(61, 53, 60, 0)])
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds).toHaveLength(3)
    expect(degrees(graph)).toEqual([1, 1, 1, 3])
    expect(warnings).toEqual([])
  })

  it('夹角很小但从同一点发散的支线不误合并成双键', () => {
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), line(0, 0, 60, 10)])
    expect(graph.atoms).toHaveLength(3)
    expect(graph.bonds).toHaveLength(2)
    expect(graph.bonds.every(bond => bond.order === 1)).toBe(true)
    expect(degrees(graph)).toEqual([1, 1, 2])
  })

  it('支线接在键中段时不自动插入碳原子，给出明确连接警告', () => {
    const { graph, warnings } = recognizeHanddraw([line(0, 50, 100, 50), line(50, 50, 50, 0)])
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds).toHaveLength(2)
    expect(warnings.some(warning => warning.includes('中段') && warning.includes('不连接'))).toBe(true)
  })

  it('交叉直线不擅自当作四价碳连接', () => {
    const { graph, warnings } = recognizeHanddraw([line(0, 0, 80, 80), line(0, 80, 80, 0)])
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds).toHaveLength(2)
    expect(graph.atoms.some(atom => atom.x === 40 && atom.y === 40)).toBe(false)
    expect(warnings.some(warning => warning.includes('交叉') && warning.includes('未自动'))).toBe(true)
  })

  it('吸附距离可调整，短键两端不会吸成同一个原子', () => {
    expect(recognizeHanddraw([line(0, 0, 50, 0), line(63, 0, 100, 30)], { snapDistance: 15 }).graph.atoms).toHaveLength(3)
    const { graph } = recognizeHanddraw([line(0, 0, 14, 0), line(7, 1, 7, 30)], { snapDistance: 20 })
    expect(graph.bonds.every(bond => bond.from !== bond.to)).toBe(true)
  })
})

describe('多边形环与圆形排除', () => {
  it.each([3, 4, 5, 6, 7, 8])('有真实手抖的一笔 %i 元多边形保留准确顶点数', size => {
    const { graph } = recognizeHanddraw([sampled(polygon(size), 0.8)])
    expect(graph.atoms).toHaveLength(size)
    expect(graph.bonds).toHaveLength(size)
    expect(degrees(graph)).toEqual(Array(size).fill(2))
  })

  it('多种手抖相位不会把真实多边形的一个拐角误拆成两个碳', () => {
    for (let size = 3; size <= 8; size += 1) for (let seed = 0; seed < 8; seed += 1) {
      const { graph } = recognizeHanddraw([sampled(polygon(size, 60), 1.2, seed)])
      expect(graph.atoms, `${size}-member ring, noise phase ${seed}`).toHaveLength(size)
      expect(graph.bonds).toHaveLength(size)
    }
  })

  it('分六笔、端点轻微错开的六边形形成六元环', () => {
    const ring = polygon(6)
    const strokes = ring.slice(1).map((to, index) => sampled([point(ring[index].x + Math.sin(index) * 2, ring[index].y + Math.cos(index) * 2), point(to.x + Math.cos(index) * 2, to.y + Math.sin(index) * 2)], 0.7))
    const { graph } = recognizeHanddraw(strokes)
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(degrees(graph)).toEqual([2, 2, 2, 2, 2, 2])
  })

  it('从一条边中段起笔的连续六边形不增加额外碳原子', () => {
    const ring = polygon(6)
    const midpoint = point((ring[0].x + ring[1].x) / 2, (ring[0].y + ring[1].y) / 2)
    const { graph } = recognizeHanddraw([sampled([midpoint, ...ring.slice(1), midpoint], 0.5)])
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
  })

  it.each([12, 20, 40, 80])('半径 %i px 的圆或字母 O 不会被猜成碳环', radius => {
    expectError([circle(radius)], 'UNRECOGNIZED')
  })

  it('有小缺口的 O 与椭圆同样不被识别成环', () => {
    expectError([circle(25, 0.1)], 'UNRECOGNIZED')
    expectError([circle(30, 0.6)], 'UNRECOGNIZED')
    expectError([circle(40).map(p => point(p.x, 150 + (p.y - 150) * 0.6))], 'UNRECOGNIZED')
  })

  it('混有圆圈的直键只识别直键，并提示不支持元素 O 文字', () => {
    const { graph, warnings } = recognizeHanddraw([line(10, 10, 60, 10), circle(20)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
    expect(warnings.some(warning => warning.includes('元素 O'))).toBe(true)
  })

  it('分多笔的圆弧不能绕过圆形保护成为大碳环', () => {
    const round = circle(40)
    expectError([round.slice(0, 26), round.slice(25, 51), round.slice(50, 76), round.slice(75)], 'UNRECOGNIZED')
  })

  it('自相交闭环不能作为正常碳环保存', () => {
    expectError([[point(0, 0), point(60, 60), point(0, 60), point(60, 0), point(0, 0)]], 'UNRECOGNIZED')
  })
})

describe('多重键、短内线与重画', () => {
  it.each([false, true])('平行等长双线合并为双键，反向书写：%s', reverse => {
    const second = line(0, 8, 60, 8)
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), reverse ? second.reverse() : second])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toEqual([{ from: 0, to: 1, order: 2 }])
    expect(graph.atoms.every(atom => atom.y === 4)).toBe(true)
  })

  it('平行三线合并为三键，不依赖各线书写顺序', () => {
    const strokes = [line(0, 0, 60, 0), line(0, 16, 60, 16), line(0, 8, 60, 8)]
    const { graph } = recognizeHanddraw(strokes)
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(3)
  })

  it('较短内线增加键级，保留完整外线端点', () => {
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), line(12, 7, 48, 7)])
    expect(graph.bonds).toEqual([{ from: 0, to: 1, order: 2 }])
    expect(graph.atoms.map(atom => [atom.x, atom.y])).toEqual([[0, 0], [60, 0]])
  })

  it('六边形加三条内缩短线得到苯环的交替单双键', () => {
    const ring = polygon(6)
    const inner = [0, 2, 4].map(index => {
      const from = ring[index]
      const to = ring[index + 1]
      const dx = to.x - from.x
      const dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      return [point(from.x + dx * 0.18 - dy / length * 6, from.y + dy * 0.18 + dx / length * 6), point(to.x - dx * 0.18 - dy / length * 6, to.y - dy * 0.18 + dx / length * 6)]
    })
    const { graph, warnings } = recognizeHanddraw([sampled(ring, 0.6), ...inner.map(stroke => sampled(stroke, 0.4))])
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(graph.bonds.filter(bond => bond.order === 2)).toHaveLength(3)
    expect(graph.atoms.every((_, index) => graph.bonds.filter(bond => bond.from === index || bond.to === index).reduce((sum, bond) => sum + bond.order, 0) === 3)).toBe(true)
    expect(warnings).toEqual([])
  })

  it('同一位置反向重画带轻微手抖时仍为单键', () => {
    const { graph, warnings } = recognizeHanddraw([sampled(line(0, 0, 60, 0), 0.8), sampled(line(60, 1, 0, 1), 0.9)])
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(1)
    expect(warnings.some(warning => warning.includes('重画'))).toBe(true)
  })

  it('共线短重描不被误当第二根键线', () => {
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), line(15, 1, 45, 1)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds[0].order).toBe(1)
  })

  it('过远平行线保持独立，而不是化学双键', () => {
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), line(0, 30, 60, 30)])
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds.map(bond => bond.order)).toEqual([1, 1])
  })

  it('多于三条平行线不给出非法四键，并明确警告', () => {
    const { graph, warnings } = recognizeHanddraw([0, 7, 14, 21].map(y => line(0, y, 60, y)))
    expect(graph.bonds[0].order).toBe(3)
    expect(warnings.some(warning => warning.includes('超过三条'))).toBe(true)
  })

  it('近平行但实际相交的线不合并成双键', () => {
    const { graph, warnings } = recognizeHanddraw([line(0, 0, 70, 0), line(0, -6, 70, 6)])
    expect(graph.bonds.every(bond => bond.order === 1)).toBe(true)
    expect(warnings.some(warning => warning.includes('交叉'))).toBe(true)
  })

  it('碳原子总键级超过 4 时警告而不假装已验证化学合法性', () => {
    const ends = [point(60, 0), point(20, 60), point(-50, 35), point(-50, -35), point(20, -60)]
    const { graph, warnings } = recognizeHanddraw(ends.map(end => [point(0, 0), end]))
    expect(graph.bonds).toHaveLength(5)
    expect(warnings.some(warning => warning.includes('超过 4'))).toBe(true)
  })
})

describe('输入边界与不可变性', () => {
  it('空画布与空笔迹返回 EMPTY 错误', () => {
    expectError([], 'EMPTY')
    expectError([[]], 'EMPTY')
  })

  it('点状、零长度与过短笔迹返回 UNRECOGNIZED', () => {
    expectError([[point(0, 0)]], 'UNRECOGNIZED')
    expectError([line(0, 0, 0, 0)], 'UNRECOGNIZED')
    expectError([line(0, 0, 3, 2)], 'UNRECOGNIZED')
  })

  it.each([NaN, Infinity, -Infinity, 1000001])('拒绝非法坐标 %s', value => {
    expectError([line(0, 0, value, 50)], 'INVALID_INPUT')
  })

  it('拒绝非数组与缺失坐标，不因坏输入触发普通 TypeError', () => {
    expectError(null as unknown as HanddrawStroke[], 'INVALID_INPUT')
    expectError([null] as unknown as HanddrawStroke[], 'INVALID_INPUT')
    expectError([[null]] as unknown as HanddrawStroke[], 'INVALID_INPUT')
    expectError([[{ x: 1 }]] as HanddrawStroke[], 'INVALID_INPUT')
  })

  it.each([{ snapDistance: 0 }, { simplifyTolerance: -1 }, { minBondLength: NaN }, { parallelDistance: Infinity }, { maxStrokes: 0.5 }, { maxPoints: 50000 }])('拒绝非法选项 %j', options => {
    expectError([line(0, 0, 50, 0)], 'INVALID_INPUT', options)
  })

  it('笔画、采样点和分段数量均有清晰上限', () => {
    expectError([line(0, 0, 50, 0), line(50, 0, 100, 30)], 'LIMIT_EXCEEDED', { maxStrokes: 1 })
    expectError([sampled(line(0, 0, 50, 0))], 'LIMIT_EXCEEDED', { maxPoints: 5 })
    const zigzag = Array.from({ length: 330 }, (_, index) => point(index * 30, index % 2 ? 0 : 40))
    expectError([zigzag], 'LIMIT_EXCEEDED')
  })

  it('允许少量点状杂笔并给出提示，不污染有效结构', () => {
    const { graph, warnings } = recognizeHanddraw([[point(4, 4)], line(0, 20, 60, 20)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
    expect(warnings.some(warning => warning.includes('点状'))).toBe(true)
  })

  it('冻结的采样点、笔迹和选项始终不变', () => {
    const strokes = [sampled(polygon(6), 0.5), line(150, 100, 150, 50)]
    const snapshot = structuredClone(strokes)
    strokes.forEach(stroke => { stroke.forEach(Object.freeze); Object.freeze(stroke) })
    Object.freeze(strokes)
    const options = Object.freeze({ snapDistance: 11 })
    const result = recognizeHanddraw(strokes, options)
    expect(result.graph.bonds.length).toBeGreaterThan(0)
    expect(strokes).toEqual(snapshot)
  })
})
