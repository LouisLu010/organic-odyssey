import { describe, expect, it } from 'vitest'
import type { EditorGraph } from './moleculeEditor'
import { addEditorRing, parseEditorSmiles } from './moleculeEditor'
import { getEditorBondLines } from './bondGeometry'

function graph(points: [number, number][], bonds: [number, number, number][]): EditorGraph {
  return {
    atoms: points.map(([x, y]) => ({ element: 'C', x, y, charge: 0 })),
    bonds: bonds.map(([from, to, order]) => ({ from, to, order })),
  }
}

function expectFinite(graph: EditorGraph) {
  graph.bonds.forEach((_, index) => {
    for (const line of getEditorBondLines(graph, index)) expect(Object.values(line).every(Number.isFinite)).toBe(true)
  })
}

function normalizedSegments(lines: ReturnType<typeof getEditorBondLines>) {
  return lines.map(line => [[line.x1, line.y1], [line.x2, line.y2]]
    .map(point => point.map(value => Math.round(value * 1e7) / 1e7))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]))
    .sort((left, right) => left[0][0] - right[0][0] || left[0][1] - right[0][1] || left[1][0] - right[1][0] || left[1][1] - right[1][1])
}

describe('环内双键', () => {
  it('苯环的三条双键沿原边连续，内线缩短并靠近环心', () => {
    const benzene = addEditorRing({ atoms: [], bonds: [] }, 320, 180, 6, true)
    const snapshot = structuredClone(benzene)
    let doubles = 0
    benzene.bonds.forEach((bond, index) => {
      const lines = getEditorBondLines(benzene, index)
      const from = benzene.atoms[bond.from]
      const to = benzene.atoms[bond.to]
      expect(lines[0]).toEqual({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })
      if (bond.order === 2) {
        doubles += 1
        expect(lines).toHaveLength(2)
        const [outer, inner] = lines
        expect(Math.hypot(inner.x2 - inner.x1, inner.y2 - inner.y1)).toBeCloseTo(44 * 0.64)
        const distance = (line: typeof outer) => Math.hypot((line.x1 + line.x2) / 2 - 320, (line.y1 + line.y2) / 2 - 180)
        expect(distance(inner)).toBeLessThan(distance(outer))
      } else expect(lines).toHaveLength(1)
    })
    expect(doubles).toBe(3)
    expect(benzene).toEqual(snapshot)
  })

  it('反向书写键端点不改变苯环的实际线段位置', () => {
    const original = addEditorRing({ atoms: [], bonds: [] }, 320, 180, 6, true)
    const reversed = { ...original, bonds: original.bonds.map(bond => ({ ...bond, from: bond.to, to: bond.from })) }
    original.bonds.forEach((_, index) => {
      expect(normalizedSegments(getEditorBondLines(reversed, index))).toEqual(normalizedSegments(getEditorBondLines(original, index)))
    })
  })

  it('六元环不自动变成芳香环，孤立环内双键仍按原键级显示', () => {
    const ring = addEditorRing({ atoms: [], bonds: [] }, 320, 180, 6, false)
    expect(ring.bonds.flatMap((_, index) => getEditorBondLines(ring, index))).toHaveLength(6)
    ring.bonds[1].order = 2
    expect(ring.bonds.flatMap((_, index) => getEditorBondLines(ring, index))).toHaveLength(7)
    expect(ring.bonds.map(bond => bond.order)).toEqual([1, 2, 1, 1, 1, 1])
  })

  it('排除目标边的最短路径选择三元环而非同边的六元环', () => {
    const fused = graph([[0, 0], [44, 0], [22, 30], [60, -30], [44, -60], [0, -60], [-16, -30]], [
      [0, 1, 2], [1, 3, 1], [3, 4, 1], [4, 5, 1], [5, 6, 1], [6, 0, 1], [0, 2, 1], [2, 1, 1],
    ])
    const lines = getEditorBondLines(fused, 0)
    expect(lines[0]).toEqual({ x1: 0, y1: 0, x2: 44, y2: 0 })
    expect(lines[1].y1).toBeGreaterThan(0)
    expect(lines[1].y2).toBeGreaterThan(0)
    expect(lines[1].y1).toBeLessThan(10)
    expectFinite(fused)
  })

  it('稠环共享边有等长候选时，反向键仍选同侧', () => {
    const fused = graph([[0, -22], [0, 22], [-38, 44], [-76, 22], [-76, -22], [-38, -44], [38, 44], [76, 22], [76, -22], [38, -44]], [
      [0, 1, 2], [1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 0, 1], [1, 6, 1], [6, 7, 2], [7, 8, 1], [8, 9, 2], [9, 0, 1],
    ])
    const reversed = { ...fused, bonds: [{ from: 1, to: 0, order: 2 }, ...fused.bonds.slice(1)] }
    expect(normalizedSegments(getEditorBondLines(fused, 0))).toEqual(normalizedSegments(getEditorBondLines(reversed, 0)))
    expect(getEditorBondLines(fused, 0)[1].x1).toBeLessThan(0)
    expectFinite(fused)
  })

  it('共线退化闭环回退对称双线，不画重叠内线', () => {
    const flat = graph([[0, 0], [44, 0], [22, 0]], [[0, 1, 2], [0, 2, 1], [2, 1, 1]])
    const [first, second] = getEditorBondLines(flat, 0)
    expect(first.y1).toBeCloseTo(-second.y1)
    expect(first.y1).not.toBe(0)
    expectFinite(flat)
  })

  it('缩放分子时内线的偏移和端点缩短同比缩放', () => {
    const ring = addEditorRing({ atoms: [], bonds: [] }, 0, 0, 6, true)
    const small = { ...ring, atoms: ring.atoms.map(atom => ({ ...atom, x: atom.x / 2, y: atom.y / 2 })) }
    const normal = getEditorBondLines(ring, 0)
    const scaled = getEditorBondLines(small, 0)
    normal.forEach((line, index) => Object.entries(line).forEach(([key, value]) => expect(scaled[index][key as keyof typeof line]).toBeCloseTo(value / 2)))
  })
})

describe('开链键与退化输入', () => {
  it.each([0, 1, 2, 3])('开链 %i 级键线数及间距正确', order => {
    const molecule = graph([[0, 0], [44, 0]], [[0, 1, order]])
    const lines = getEditorBondLines(molecule, 0)
    expect(lines).toHaveLength(order > 1 ? order : 1)
    expect(lines.every(line => line.x1 === 0 && line.x2 === 44)).toBe(true)
    expect(lines.reduce((sum, line) => sum + line.y1, 0)).toBeCloseTo(0)
    if (order === 2) expect(lines[1].y1 - lines[0].y1).toBeCloseTo(44 * 0.12)
    if (order === 3) expect(lines[1]).toEqual({ x1: 0, y1: 0, x2: 44, y2: 0 })
  })

  it('反向开链双键与三键保持同一组线段', () => {
    for (const order of [2, 3]) {
      const original = graph([[10, 20], [35, 61]], [[0, 1, order]])
      const reversed = { ...original, bonds: [{ from: 1, to: 0, order }] }
      expect(normalizedSegments(getEditorBondLines(original, 0))).toEqual(normalizedSegments(getEditorBondLines(reversed, 0)))
    }
  })

  it.each(['c1ccccc1', 'C1=CC2=CC=CC=C2C=C1', 'C1=CC1', 'C1CO1', 'O=C=O', 'C#N', 'C1=CC=CC=C1C=O'])('%s 的几何全部有限且不改变分子', smiles => {
    const molecule = parseEditorSmiles(smiles)
    const snapshot = structuredClone(molecule)
    molecule.atoms.forEach(Object.freeze)
    molecule.bonds.forEach(Object.freeze)
    Object.freeze(molecule.atoms)
    Object.freeze(molecule.bonds)
    Object.freeze(molecule)
    expectFinite(molecule)
    expect(molecule).toEqual(snapshot)
  })

  it('非环的外接双键不因连接着苯环而误判成环内双键', () => {
    const molecule = parseEditorSmiles('O=Cc1ccccc1')
    const index = molecule.bonds.findIndex(bond => molecule.atoms[bond.from].element === 'O' || molecule.atoms[bond.to].element === 'O')
    const bond = molecule.bonds[index]
    const lines = getEditorBondLines(molecule, index)
    expect(lines).toHaveLength(2)
    expect((lines[0].x1 + lines[1].x1) / 2).toBeCloseTo(molecule.atoms[bond.from].x)
    expect((lines[0].y1 + lines[1].y1) / 2).toBeCloseTo(molecule.atoms[bond.from].y)
  })

  it('重复反向边不被视为二元环，坏邻接不影响有效边', () => {
    const molecule = graph([[0, 0], [44, 0]], [[0, 1, 2], [1, 0, 1], [0, 0, 1], [1, 9, 1], [1, -1, 1]])
    const lines = getEditorBondLines(molecule, 0)
    expect(lines[0].y1).toBeCloseTo(-lines[1].y1)
    expectFinite(molecule)
  })

  it('非法索引、缺失原子、自键、零长与非有限坐标返回空线段', () => {
    const molecule = graph([[0, 0], [44, 0]], [[0, 1, 1]])
    for (const index of [-1, 1, 0.5, NaN]) expect(getEditorBondLines(molecule, index)).toEqual([])
    for (const invalid of [
      graph([[0, 0]], [[0, 2, 1]]),
      graph([[0, 0]], [[0, 0, 2]]),
      graph([[0, 0], [0, 0]], [[0, 1, 2]]),
      graph([[0, 0], [NaN, 1]], [[0, 1, 2]]),
      graph([[Infinity, 0], [1, 1]], [[0, 1, 2]]),
      graph([[0, 0], [44, 0]], [[0, 1, 4]]),
      graph([[-1e308, 0], [1e308, 0]], [[0, 1, 2]]),
    ]) expect(getEditorBondLines(invalid, 0)).toEqual([])
  })

  it('极小的有效三元环不产生 NaN 或 Infinity', () => {
    const molecule = graph([[0, 0], [1e-7, 0], [5e-8, 1e-8]], [[0, 1, 2], [1, 2, 1], [2, 0, 1]])
    expect(getEditorBondLines(molecule, 0)).toHaveLength(2)
    expectFinite(molecule)
  })
})
