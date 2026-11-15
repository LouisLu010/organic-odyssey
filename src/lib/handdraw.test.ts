import { describe, expect, it } from 'vitest'
import type { EditorGraph } from './moleculeEditor'
import { HanddrawRecognitionError, recognizeHanddraw } from './handdraw'
import type { HanddrawOptions, HanddrawPoint, HanddrawStroke } from './handdraw'

function point(x: number, y: number): HanddrawPoint { return { x, y } }
function line(x1: number, y1: number, x2: number, y2: number): HanddrawStroke { return [point(x1, y1), point(x2, y2)] }

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

function polygon(size: number, side = 50, center = point(150, 150)): HanddrawStroke {
  const radius = side / (2 * Math.sin(Math.PI / size))
  const vertices = Array.from({ length: size }, (_, index) => point(center.x + Math.cos(-Math.PI / 2 + index * Math.PI * 2 / size) * radius, center.y + Math.sin(-Math.PI / 2 + index * Math.PI * 2 / size) * radius))
  return [...vertices, { ...vertices[0] }]
}

function circle(radius: number, center = point(150, 150), gap = 0): HanddrawStroke {
  return Array.from({ length: 41 }, (_, index) => {
    const angle = index / 40 * (2 * Math.PI - gap)
    return point(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle))
  })
}

function degrees(graph: EditorGraph): number[] {
  return graph.atoms.map((_, index) => graph.bonds.filter(bond => bond.from === index || bond.to === index).length).sort((left, right) => left - right)
}

function elements(graph: EditorGraph): string[] {
  return graph.atoms.map(atom => atom.element).sort()
}

function bondOrders(graph: EditorGraph): number[] {
  return graph.bonds.map(bond => bond.order).sort((left, right) => left - right)
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

describe('输入边界与错误码', () => {
  it('空画布与空笔迹返回 EMPTY', () => {
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

describe('键线与环识别', () => {
  it('手抖直线识别为单键，端点是默认碳', () => {
    const { graph, warnings } = recognizeHanddraw([sampled(line(50, 80, 150, 80), 1.2)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toEqual([{ from: 0, to: 1, order: 1 }])
    expect(graph.atoms.every(atom => atom.element === 'C' && atom.charge === 0)).toBe(true)
    expect(warnings).toEqual([])
  })

  it('长直线不凭长度擅自增加碳原子', () => {
    const { graph } = recognizeHanddraw([sampled(line(0, 0, 250, 0), 0.5)])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
  })

  it('一笔连续折线只在端点与明显拐角建立碳原子', () => {
    const vertices = [point(20, 100), point(65, 75), point(110, 100), point(155, 75), point(200, 100)]
    const { graph } = recognizeHanddraw([sampled(vertices, 0.9)])
    expect(graph.atoms).toHaveLength(5)
    expect(graph.bonds).toHaveLength(4)
    expect(degrees(graph)).toEqual([1, 1, 2, 2, 2])
    expect(graph.bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('分笔碳链的近端点吸附', () => {
    const { graph } = recognizeHanddraw([line(20, 80, 65, 55), line(69, 58, 110, 80)])
    expect(graph.atoms).toHaveLength(3)
    expect(graph.bonds).toHaveLength(2)
  })

  it.each([3, 4, 5, 6, 7, 8])('有真实手抖的一笔 %i 元多边形保留准确顶点数', size => {
    const { graph } = recognizeHanddraw([sampled(polygon(size), 0.8)])
    expect(graph.atoms).toHaveLength(size)
    expect(graph.bonds).toHaveLength(size)
    expect(degrees(graph)).toEqual(Array(size).fill(2))
  })

  it('分六笔、端点轻微错开的六边形形成六元环', () => {
    const ring = polygon(6)
    const strokes = ring.slice(1).map((to, index) => sampled([point(ring[index].x + Math.sin(index) * 2, ring[index].y + Math.cos(index) * 2), point(to.x + Math.cos(index) * 2, to.y + Math.sin(index) * 2)], 0.7))
    const { graph } = recognizeHanddraw(strokes)
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(degrees(graph)).toEqual([2, 2, 2, 2, 2, 2])
  })

  it('T 型支链在长键中段自动建立连接原子', () => {
    const { graph, warnings } = recognizeHanddraw([line(40, 120, 160, 120), line(100, 40, 100, 120)])
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds).toHaveLength(3)
    expect(warnings.some(warning => warning.includes('中段'))).toBe(true)
  })

  it('交叉直线不擅自当作四价碳连接，并给出提示', () => {
    const { graph, warnings } = recognizeHanddraw([line(0, 0, 80, 80), line(0, 80, 80, 0)])
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds).toHaveLength(2)
    expect(graph.atoms.some(atom => atom.x === 40 && atom.y === 40)).toBe(false)
    expect(warnings.some(warning => warning.includes('交叉'))).toBe(true)
  })

  it('圆圈不会被猜成碳环，而是识别为氧原子', () => {
    const { graph } = recognizeHanddraw([circle(25)])
    expect(graph.atoms).toHaveLength(1)
    expect(graph.atoms[0].element).toBe('O')
    expect(graph.bonds).toHaveLength(0)
  })
})

describe('多重键识别', () => {
  it.each([false, true])('平行等长双线合并为双键，反向书写：%s', reverse => {
    const second = line(0, 8, 60, 8)
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), reverse ? second.reverse() : second])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(2)
  })

  it('平行三线合并为三键', () => {
    const strokes = [line(0, 0, 60, 0), line(0, 16, 60, 16), line(0, 8, 60, 8)]
    const { graph } = recognizeHanddraw(strokes)
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(3)
  })

  it('较短内线增加键级，保留完整外线端点', () => {
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), line(12, 7, 48, 7)])
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(2)
    expect(graph.atoms).toHaveLength(2)
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
    const { graph } = recognizeHanddraw([sampled(ring, 0.6), ...inner.map(stroke => sampled(stroke, 0.4))])
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(graph.bonds.filter(bond => bond.order === 2)).toHaveLength(3)
    expect(graph.atoms.every((_, index) => graph.bonds.filter(bond => bond.from === index || bond.to === index).reduce((sum, bond) => sum + bond.order, 0) === 3)).toBe(true)
  })

  it('过远平行线保持独立，而不是化学双键', () => {
    const { graph } = recognizeHanddraw([line(0, 0, 60, 0), line(0, 30, 60, 30)])
    expect(graph.bonds).toHaveLength(2)
    expect(graph.bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('同一位置反向重画带轻微手抖时仍为单键', () => {
    const { graph } = recognizeHanddraw([sampled(line(0, 0, 60, 0), 0.8), sampled(line(60, 1, 0, 1), 0.9)])
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(1)
  })
})

describe('手写原子标签与芳环圆圈', () => {
  it('键端手写的圆圈 O 识别为氧原子并连键', () => {
    const { graph } = recognizeHanddraw([line(60, 120, 140, 120), circle(11, point(158, 120))])
    expect(graph.atoms).toHaveLength(2)
    expect(elements(graph)).toEqual(['C', 'O'])
    expect(graph.bonds).toHaveLength(1)
  })

  it('键端手写的 N 字母识别为氮原子', () => {
    // 丙胺骨架：C-C-N（N：左竖、上左到下右的斜线、右竖）
    const strokes = [sampled([point(60, 130), point(105, 100), point(150, 130)], 0.6), line(168, 138, 168, 102), line(168, 102, 182, 138), line(182, 138, 182, 102)]
    const { graph } = recognizeHanddraw(strokes)
    expect(graph.bonds.length).toBeGreaterThanOrEqual(2)
    expect(elements(graph)).toContain('N')
  })

  it('苯环内圆圈提升为三个交替双键，不生成额外氧原子', () => {
    const ring = sampled(polygon(6, 60, point(150, 140)), 0.6)
    const strokes = [ring, circle(24, point(150, 140))]
    const { graph } = recognizeHanddraw(strokes)
    expect(graph.atoms).toHaveLength(6)
    expect(elements(graph)).toEqual(Array(6).fill('C'))
    expect(graph.bonds).toHaveLength(6)
    expect(graph.bonds.filter(bond => bond.order === 2)).toHaveLength(3)
  })

  it('孤立手写的 O 识别为单个氧原子（水）', () => {
    const { graph } = recognizeHanddraw([circle(20, point(150, 150))])
    expect(graph.atoms).toHaveLength(1)
    expect(graph.atoms[0].element).toBe('O')
  })

  it('多片段结构保留全部片段并提示', () => {
    const { graph, warnings } = recognizeHanddraw([line(20, 60, 90, 90), line(200, 60, 270, 90)])
    expect(graph.bonds).toHaveLength(2)
    expect(warnings.some(warning => warning.includes('未相连'))).toBe(true)
  })
})

describe('自由绘画：任意笔顺、笔数、抬笔', () => {
  function hexVertices(center = point(300, 200), radius = 55): HanddrawPoint[] {
    return Array.from({ length: 6 }, (_, index) => point(
      center.x + radius * Math.cos(-Math.PI / 2 + index * Math.PI / 3),
      center.y + radius * Math.sin(-Math.PI / 2 + index * Math.PI / 3),
    ))
  }
  function topology(graph: EditorGraph): string {
    const degreeCounts = degrees(graph).join(',')
    return `${elements(graph).join('')}|${graph.bonds.length}|${bondOrders(graph).join(',')}|${degreeCounts}`
  }
  function branchEnd(vertex: HanddrawPoint, center = point(300, 200)): HanddrawPoint {
    const length = Math.hypot(vertex.x - center.x, vertex.y - center.y)
    return point(vertex.x + (vertex.x - center.x) / length * 60, vertex.y + (vertex.y - center.y) / length * 60)
  }

  it('一笔连续画完六元环再接支链，不需要抬笔', () => {
    const vertices = hexVertices()
    const branch = branchEnd(vertices[2])
    const stroke = sampled([vertices[2], vertices[3], vertices[4], vertices[5], vertices[0], vertices[1], vertices[2], branch], 0.7)
    const { graph } = recognizeHanddraw([stroke])
    expect(graph.atoms).toHaveLength(7)
    expect(graph.bonds).toHaveLength(7)
    expect(degrees(graph)).toEqual([1, 2, 2, 2, 2, 2, 3])
    expect(graph.bonds.every(bond => bond.order === 1)).toBe(true)
  })

  it('环边乱序、正反方向交替画，与一笔连续画得到相同结构', () => {
    const vertices = hexVertices()
    const branch = branchEnd(vertices[2])
    const oneStroke = recognizeHanddraw([sampled([vertices[2], vertices[3], vertices[4], vertices[5], vertices[0], vertices[1], vertices[2], branch], 0.7)]).graph
    const edges = Array.from({ length: 6 }, (_, index) => {
      const from = vertices[index]
      const to = vertices[(index + 1) % 6]
      return index % 2 ? sampled([to, from], 0.5) : sampled([from, to], 0.5)
    })
    const shuffled = [edges[3], edges[0], edges[5], edges[2], edges[1], edges[4], sampled([vertices[2], branch], 0.5)]
    const randomOrder = recognizeHanddraw(shuffled).graph
    expect(topology(randomOrder)).toBe(topology(oneStroke))
  })

  it('先写字母后写键，与先写键后写字母结果一致', () => {
    const bond = sampled([point(240, 200), point(300, 200)], 0.6)
    const oxygen = circle(14, point(318, 200))
    const before = recognizeHanddraw([oxygen, bond]).graph
    const after = recognizeHanddraw([bond, oxygen]).graph
    expect(elements(before)).toEqual(['C', 'O'])
    expect(topology(before)).toBe(topology(after))
    expect(before.bonds).toHaveLength(1)
  })

  it('一笔折返画双键（U 形回描）得到双键', () => {
    const stroke = sampled([point(300, 180), point(420, 180), point(420, 196), point(300, 196)], 0.5)
    const { graph } = recognizeHanddraw([stroke])
    expect(graph.atoms).toHaveLength(2)
    expect(graph.bonds).toHaveLength(1)
    expect(graph.bonds[0].order).toBe(2)
  })

  it('自由绘画模式提高笔数上限后，多笔内容不再触发逐笔上限', () => {
    const many: HanddrawStroke[] = Array.from({ length: 200 }, (_, index) => {
      const x = 40 + (index % 20) * 28
      const y = 40 + Math.floor(index / 20) * 34
      return [point(x, y), point(x + 12, y + 8)]
    })
    let limited: string | undefined
    try { recognizeHanddraw(many, { maxStrokes: 512, maxPoints: 30000 }) } catch (error) {
      limited = error instanceof HanddrawRecognitionError ? error.code : 'OTHER'
    }
    expect(limited).not.toBe('LIMIT_EXCEEDED')
    expectError(many, 'LIMIT_EXCEEDED')
  })
})

describe('真实分笔画环（不需要一笔画成）', () => {
  function hexVertices(center = point(300, 200), radius = 55): HanddrawPoint[] {
    return Array.from({ length: 6 }, (_, index) => point(
      center.x + radius * Math.cos(-Math.PI / 2 + index * Math.PI / 3),
      center.y + radius * Math.sin(-Math.PI / 2 + index * Math.PI / 3),
    ))
  }
  /** 每条边单独画，两端分别在顶点附近留出 gap/2 的空隙（模拟真人抬笔）。 */
  function sixEdges(gap: number, jitter = 0.5): HanddrawStroke[] {
    const vertices = hexVertices()
    const half = gap / 2
    return Array.from({ length: 6 }, (_, index) => {
      const from = vertices[index]
      const to = vertices[(index + 1) % 6]
      const length = Math.hypot(to.x - from.x, to.y - from.y)
      const ux = (to.x - from.x) / length
      const uy = (to.y - from.y) / length
      return sampled([point(from.x + ux * half, from.y + uy * half), point(to.x - ux * half, to.y - uy * half)], jitter)
    })
  }
  function twoStroke(gap: number): HanddrawStroke[] {
    const vertices = hexVertices()
    const half = gap / 2
    const edge = (index: number) => {
      const from = vertices[index]
      const to = vertices[(index + 1) % 6]
      const length = Math.hypot(to.x - from.x, to.y - from.y)
      const ux = (to.x - from.x) / length
      const uy = (to.y - from.y) / length
      return [point(from.x + ux * half, from.y + uy * half), point(to.x - ux * half, to.y - uy * half)]
    }
    const first: HanddrawPoint[] = []
    for (let index = 0; index < 3; index += 1) first.push(...edge(index).slice(0, -1))
    first.push(edge(2).at(-1)!)
    const second: HanddrawPoint[] = []
    for (let index = 3; index < 6; index += 1) second.push(...edge(index).slice(0, -1))
    second.push(edge(5).at(-1)!)
    return [sampled(first, 0.5), sampled(second, 0.5)]
  }

  it.each([14, 22, 30])('六条边分开画、顶点间隙 %spx，仍自动连成六元环', gap => {
    const { graph, warnings } = recognizeHanddraw(sixEdges(gap))
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(degrees(graph)).toEqual([2, 2, 2, 2, 2, 2])
    expect(warnings).toEqual([])
  })

  it('分两笔画成的六边形（顶点间隙 18px）也是六元环', () => {
    const { graph } = recognizeHanddraw(twoStroke(18))
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(degrees(graph)).toEqual([2, 2, 2, 2, 2, 2])
  })

  it('六条边分开画的苯环 + 圈内圆圈，按芳香环处理', () => {
    const { graph } = recognizeHanddraw([...sixEdges(14), circle(26, point(300, 200))])
    expect(elements(graph)).toEqual(Array(6).fill('C'))
    expect(graph.bonds).toHaveLength(6)
    expect(bondOrders(graph).filter(order => order === 2)).toHaveLength(3)
    expect(degrees(graph)).toEqual([2, 2, 2, 2, 2, 2])
  })
})
