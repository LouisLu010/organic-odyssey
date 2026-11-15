import { describe, expect, it } from 'vitest'
import type { EditorGraph } from '../moleculeEditor'
import { assembleGraph, graphIsEmpty } from './assemble'
import { DEFAULT_SETTINGS } from './types'
import type { AtomLabel, BondLine, HanddrawPoint, HanddrawStroke, InkExtraction, LabelRecognition, Settings } from './types'

function point(x: number, y: number): HanddrawPoint { return { x, y } }

function line(ax: number, ay: number, bx: number, by: number, strokeIndex = 0): BondLine {
  return { a: point(ax, ay), b: point(bx, by), strokeIndex }
}

function ink(segments: BondLine[], scale = 50): InkExtraction {
  return { scale, segments, warnings: [] }
}

function dummyStrokes(count: number): HanddrawStroke[] {
  return Array.from({ length: count }, (_, index) => [point(index, 0), point(index + 1, 0)])
}

function atomLabel(overrides: Partial<AtomLabel> = {}): AtomLabel {
  return {
    text: 'O',
    element: 'O',
    charge: 0,
    confidence: 0.9,
    bounds: { minX: 195, minY: 188, maxX: 225, maxY: 212 },
    anchor: point(210, 200),
    strokes: [1],
    shape: 'text',
    alternatives: [],
    ...overrides,
  }
}

function recognition(labels: AtomLabel[] = []): LabelRecognition {
  return { labels, claimedStrokes: labels.flatMap(label => label.strokes), warnings: [] }
}

function build(segments: BondLine[], labels: AtomLabel[] = [], options: Partial<Settings> = {}, strokeCount?: number): EditorGraph {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...options }
  const count = strokeCount ?? Math.max(1, ...segments.map(segment => segment.strokeIndex + 1), ...labels.flatMap(label => label.strokes.map(stroke => stroke + 1)))
  return assembleGraph({ strokes: dummyStrokes(count), extraction: ink(segments), labels: recognition(labels), settings }).graph
}

function resultOf(segments: BondLine[], labels: AtomLabel[] = []): { graph: EditorGraph; warnings: string[] } {
  const settings: Settings = { ...DEFAULT_SETTINGS }
  return assembleGraph({ strokes: dummyStrokes(4), extraction: ink(segments), labels: recognition(labels), settings })
}

function atomElements(graph: EditorGraph): string[] {
  return graph.atoms.map(atom => atom.element).sort()
}

function bondOrders(graph: EditorGraph): number[] {
  return graph.bonds.map(bond => bond.order).sort((left, right) => left - right)
}

function hexagon(center = point(300, 200), radius = 50, withCircle = false): { segments: BondLine[]; circle?: AtomLabel } {
  const vertices = Array.from({ length: 6 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 3
    return point(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle))
  })
  const segments = vertices.map((vertex, index) => ({ a: vertex, b: vertices[(index + 1) % 6], strokeIndex: index }))
  if (!withCircle) return { segments }
  const circle = atomLabel({
    text: 'O',
    shape: 'circle',
    bounds: { minX: center.x - 25, minY: center.y - 25, maxX: center.x + 25, maxY: center.y + 25 },
    anchor: center,
    strokes: [6],
  })
  return { segments, circle }
}

function pentagon(center = point(300, 200), radius = 45): HanddrawPoint[] {
  return Array.from({ length: 5 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / 5
    return point(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle))
  })
}

describe('装配器：键线与端点吸附', () => {
  it('一根直线得到两个碳原子和一根单键', () => {
    const graph = build([line(100, 200, 200, 200)])
    expect(atomElements(graph)).toEqual(['C', 'C'])
    expect(graph.bonds).toEqual([{ from: 0, to: 1, order: 1 }])
  })

  it('分笔折线在近端点吸附成链，端点坐标为两端均值', () => {
    const graph = build([line(100, 200, 150, 160, 0), line(154, 162, 200, 200, 1)])
    expect(graph.atoms).toHaveLength(3)
    expect(graph.bonds).toHaveLength(2)
    expect(graph.atoms.some(atom => atom.x === 152 && atom.y === 161)).toBe(true)
  })

  it('端点相距过远不强行成环，并提示多个片段', () => {
    const result = resultOf([line(100, 200, 150, 200, 0), line(180, 200, 230, 200, 1)])
    expect(result.graph.atoms).toHaveLength(4)
    expect(result.warnings.some(warning => warning.includes('未相连'))).toBe(true)
  })

  it('T 型支链接到键中段时自动拆键并插入原子', () => {
    const result = resultOf([line(100, 200, 200, 200, 0), line(150, 130, 150, 200, 1)])
    expect(result.graph.atoms).toHaveLength(4)
    expect(result.graph.bonds).toHaveLength(3)
    expect(result.warnings.some(warning => warning.includes('中段'))).toBe(true)
  })

  it('闭环正六边形被识别为六元环，全部单键', () => {
    const graph = build(hexagon().segments)
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds).toHaveLength(6)
    expect(bondOrders(graph)).toEqual([1, 1, 1, 1, 1, 1])
  })
})

describe('装配器：原子标签与基团', () => {
  it('键端标签识别为氧原子并与键相连', () => {
    const graph = build([line(100, 200, 200, 200)], [atomLabel()])
    expect(atomElements(graph)).toEqual(['C', 'O'])
    expect(graph.bonds).toHaveLength(1)
    expect(graph.atoms.filter(atom => atom.element === 'O')[0]).toMatchObject({ x: 210, y: 200 })
  })

  it('标签夹在两根键中间时作为中心原子连接两侧', () => {
    const label = atomLabel({ text: 'O', bounds: { minX: 192, minY: 188, maxX: 212, maxY: 212 }, anchor: point(202, 200), strokes: [2] })
    const graph = build([line(100, 200, 190, 200, 0), line(214, 200, 300, 200, 1)], [label])
    expect(atomElements(graph)).toEqual(['C', 'C', 'O'])
    expect(graph.bonds).toHaveLength(2)
  })

  it('独立标签变成孤立原子（例如水分子）', () => {
    const graph = build([line(100, 200, 200, 200)], [atomLabel({ anchor: point(500, 200), bounds: { minX: 485, minY: 185, maxX: 515, maxY: 215 } })])
    expect(atomElements(graph)).toEqual(['C', 'C', 'O'])
    expect(graph.bonds).toHaveLength(1)
  })

  it('COOH 展开成羧基片段', () => {
    const label = atomLabel({
      text: 'COOH', element: 'C', strokes: [1],
      bounds: { minX: 200, minY: 188, maxX: 260, maxY: 214 }, anchor: point(205, 200),
    })
    const graph = build([line(100, 200, 200, 200)], [label])
    expect(atomElements(graph)).toEqual(['C', 'C', 'O', 'O'])
    expect(bondOrders(graph)).toEqual([1, 1, 2])
  })

  it('NO2 展开成带形式电荷的硝基', () => {
    const label = atomLabel({
      text: 'NO2', element: 'N', strokes: [1],
      bounds: { minX: 200, minY: 188, maxX: 250, maxY: 214 }, anchor: point(205, 200),
    })
    const graph = build([line(100, 200, 200, 200)], [label])
    expect(atomElements(graph)).toEqual(['C', 'N', 'O', 'O'])
    expect(graph.atoms.find(atom => atom.element === 'N')?.charge).toBe(1)
    expect(graph.atoms.find(atom => atom.element === 'O' && atom.charge === -1)).toBeDefined()
    expect(bondOrders(graph)).toEqual([1, 1, 2])
  })

  it('CN 展开成三键', () => {
    const label = atomLabel({
      text: 'CN', element: 'C', strokes: [1],
      bounds: { minX: 200, minY: 190, maxX: 240, maxY: 210 }, anchor: point(205, 200),
    })
    const graph = build([line(100, 200, 200, 200)], [label])
    expect(atomElements(graph)).toEqual(['C', 'C', 'N'])
    expect(bondOrders(graph)).toEqual([1, 3])
  })

  it('手写 H 按隐式氢省略，不产生非法显式氢', () => {
    const hLabel = atomLabel({ text: 'H', element: 'H', strokes: [1], bounds: { minX: 200, minY: 188, maxX: 220, maxY: 212 }, anchor: point(210, 200) })
    const result = resultOf([line(100, 200, 200, 200)], [hLabel])
    expect(atomElements(result.graph)).toEqual(['C'])
    expect(result.graph.bonds).toHaveLength(0)
    expect(result.warnings.some(warning => warning.includes('隐式氢'))).toBe(true)
  })

  it('不认识的元素按碳处理并提示', () => {
    const label = atomLabel({ text: 'Xx', element: 'Xx', strokes: [1] })
    const result = resultOf([line(100, 200, 200, 200)], [label])
    expect(result.graph.atoms.some(atom => atom.element === 'C')).toBe(true)
    expect(result.warnings.some(warning => warning.includes('暂不支持'))).toBe(true)
  })

  it('低置信标签不参与装配，只给提示', () => {
    const label = atomLabel({ confidence: 0.4 })
    const result = resultOf([line(100, 200, 200, 200)], [label])
    expect(atomElements(result.graph)).toEqual(['C', 'C'])
    expect(result.warnings.some(warning => warning.includes('不够清楚'))).toBe(true)
  })

  it('标签笔画会从键线中剔除', () => {
    const label = atomLabel({ anchor: point(350, 200), bounds: { minX: 335, minY: 185, maxX: 365, maxY: 215 }, strokes: [1] })
    const graph = build([line(100, 200, 200, 200, 0), line(300, 200, 400, 200, 1)], [label])
    expect(atomElements(graph)).toEqual(['C', 'C', 'O'])
    expect(graph.bonds).toHaveLength(1)
  })
})

describe('装配器：芳环圆圈与电荷标注', () => {
  it('六元环内的圆圈不建氧原子，提升为三个交替双键', () => {
    const { segments, circle } = hexagon(point(300, 200), 50, true)
    const graph = build(segments, [circle!])
    expect(atomElements(graph)).toEqual(['C', 'C', 'C', 'C', 'C', 'C'])
    expect(graph.bonds).toHaveLength(6)
    expect(graph.bonds.filter(bond => bond.order === 2)).toHaveLength(3)
  })

  it('已经画了交替双键的苯环，圆圈只作为芳香记号移除', () => {
    const { segments, circle } = hexagon(point(300, 200), 50, true)
    const withDouble = segments.map((segment, index) => index % 2 === 0 ? { ...segment, order: 2 } : segment)
    const graph = build(withDouble, [circle!])
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds.filter(bond => bond.order === 2)).toHaveLength(3)
  })

  it('五元环顶点上的圆圈标签作为氧原子，圈内圆圈完成呋喃式芳环', () => {
    const vertices = pentagon()
    const center = point(300, 200)
    const circle = atomLabel({
      text: 'O', shape: 'circle',
      bounds: { minX: center.x - 20, minY: center.y - 20, maxX: center.x + 20, maxY: center.y + 20 },
      anchor: center, strokes: [5],
    })
    const oLabel = atomLabel({
      text: 'O', element: 'O', shape: 'circle',
      bounds: { minX: vertices[0].x - 10, minY: vertices[0].y - 10, maxX: vertices[0].x + 10, maxY: vertices[0].y + 10 },
      anchor: vertices[0], strokes: [6],
    })
    const segments: BondLine[] = vertices.map((vertex, index) => ({ a: vertex, b: vertices[(index + 1) % 5], strokeIndex: index }))
    const graph = build(segments, [circle, oLabel])
    expect(graph.atoms).toHaveLength(5)
    expect(graph.bonds).toHaveLength(5)
    expect(graph.bonds.filter(bond => bond.order === 2)).toHaveLength(2)
    expect(graph.atoms.filter(atom => atom.element === 'O')).toHaveLength(1)
  })

  it('圆圈不在任何环内时作为孤立氧原子', () => {
    const circle = atomLabel({ shape: 'circle', anchor: point(500, 200), bounds: { minX: 480, minY: 180, maxX: 520, maxY: 220 }, strokes: [1] })
    const graph = build([line(100, 200, 200, 200, 0)], [circle])
    expect(graph.atoms.filter(atom => atom.element === 'O')).toHaveLength(1)
    expect(graph.bonds).toHaveLength(1)
  })

  it('带正电荷的氮标注写入形式电荷', () => {
    const label = atomLabel({ text: 'N+', element: 'N', charge: 1, strokes: [1] })
    const graph = build([line(100, 200, 200, 200)], [label])
    expect(graph.atoms.find(atom => atom.element === 'N')?.charge).toBe(1)
  })
})

describe('装配器：警告与边界', () => {
  it('价态超限给出中文提示但不崩溃', () => {
    const segments = [0, 1, 2, 3, 4].map(index => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / 5
      return line(300, 200, 300 + Math.cos(angle) * 80, 200 + Math.sin(angle) * 80, index)
    })
    const result = resultOf(segments)
    expect(result.graph.bonds.length).toBe(5)
    expect(result.warnings.some(warning => warning.includes('超过'))).toBe(true)
  })

  it('没有归属的画面内容给提示，不静默丢弃', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS }
    const strokes: HanddrawStroke[] = [
      [point(100, 200), point(200, 200)],
      [point(400, 200), point(450, 200)],
    ]
    const result = assembleGraph({ strokes, extraction: ink([line(100, 200, 200, 200, 0)]), labels: recognition(), settings })
    expect(result.warnings.some(warning => warning.includes('没有识别成原子'))).toBe(true)
  })

  it('空图返回空结果，供上层报 UNRECOGNIZED', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS }
    const result = assembleGraph({ strokes: dummyStrokes(1), extraction: ink([]), labels: recognition(), settings })
    expect(graphIsEmpty(result.graph)).toBe(true)
  })

  it('标签数据不完整时忽略并提示', () => {
    const broken = [{ ...atomLabel(), strokes: [99] } as AtomLabel]
    const settings: Settings = { ...DEFAULT_SETTINGS }
    const result = assembleGraph({ strokes: dummyStrokes(2), extraction: ink([line(100, 200, 200, 200)]), labels: recognition(broken), settings })
    expect(graphIsEmpty(result.graph)).toBe(false)
    expect(result.warnings.some(warning => warning.includes('不完整'))).toBe(true)
  })
})

describe('装配器：手绘闭环提示', () => {
  it('两笔端点接近但没连上时给出可操作提示', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS }
    const strokes: HanddrawStroke[] = [
      [point(100, 200), point(160, 200)],
      [point(190, 200), point(250, 200)],
    ]
    const result = assembleGraph({
      strokes,
      extraction: ink([line(100, 200, 160, 200, 0), line(190, 200, 250, 200, 1)]),
      labels: recognition(),
      settings,
    })
    expect(result.warnings.some(warning => warning.includes('端点'))).toBe(true)
  })
})
