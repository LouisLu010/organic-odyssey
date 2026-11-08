import { Molecule } from 'openchemlib'
import { describe, expect, it } from 'vitest'
import { levels } from '../data/levels'
import type { EditorGraph } from './moleculeEditor'
import { addEditorBond, addEditorRing, ELEMENT_NUMBERS, getEditorExtensionPoint, layoutEditorGraph, parseEditorSmiles, removeEditorAtom, removeEditorBond, serializeEditorGraph } from './moleculeEditor'

function identity(smiles: string): string {
  const molecule = Molecule.fromSmiles(smiles)
  molecule.stripStereoInformation()
  return molecule.getIDCode()
}

function empty(): EditorGraph {
  return { atoms: [], bonds: [] }
}

function insideCanvas(graph: EditorGraph) {
  for (const atom of graph.atoms) {
    expect(atom.x).toBeGreaterThanOrEqual(60 - 1e-8)
    expect(atom.x).toBeLessThanOrEqual(580 + 1e-8)
    expect(atom.y).toBeGreaterThanOrEqual(60 - 1e-8)
    expect(atom.y).toBeLessThanOrEqual(300 + 1e-8)
  }
}

describe('SMILES 与编辑图转换', () => {
  it.each(levels)('$id 全部标准结构往返后连接关系一致', level => {
    for (const smiles of [level.startSmiles, ...level.steps.map(step => step.smiles)]) {
      const graph = parseEditorSmiles(smiles)
      insideCanvas(graph)
      expect(identity(serializeEditorGraph(graph))).toBe(identity(smiles))
    }
  })

  it.each(['C[C@H](O)C(=O)O', 'C[C@@H](O)C(=O)O', 'C/C=C/C', 'C/C=C\\C'])('忽略 %s 的手性及双键立体信息', smiles => {
    const output = serializeEditorGraph(parseEditorSmiles(smiles))
    expect(output).not.toMatch(/[@/\\]/)
    expect(identity(output)).toBe(identity(smiles))
  })

  it('常见元素均有原子序号，并可显示工具栏以外的元素', () => {
    for (const element of ['C', 'O', 'N', 'S', 'F', 'Cl', 'Br', 'I', 'P', 'Mg', 'H']) expect(ELEMENT_NUMBERS[element]).toBeGreaterThan(0)
    const graph = parseEditorSmiles('[SiH4].[Na+].[Cl-]')
    expect(graph.atoms.map(atom => atom.element)).toEqual(expect.arrayContaining(['Si', 'Na', 'Cl']))
    expect(identity(serializeEditorGraph(graph))).toBe(identity('[SiH4].[Na+].[Cl-]'))
  })

  it('单个原子居中，小分子键长为 44，长分子自动缩小', () => {
    expect(parseEditorSmiles('O').atoms[0]).toMatchObject({ element: 'O', x: 320, y: 180 })
    const small = parseEditorSmiles('CC')
    expect(Math.hypot(small.atoms[0].x - small.atoms[1].x, small.atoms[0].y - small.atoms[1].y)).toBeCloseTo(44)
    const long = parseEditorSmiles('C'.repeat(100))
    insideCanvas(long)
    expect(Math.max(...long.atoms.map(atom => atom.x)) - Math.min(...long.atoms.map(atom => atom.x))).toBeCloseTo(520)
  })

  it('空结构与错误 SMILES 给出明确错误', () => {
    expect(() => parseEditorSmiles(' ')).toThrow('EMPTY')
    expect(() => parseEditorSmiles('C1CC')).toThrow('INVALID_GRAPH')
    expect(() => serializeEditorGraph(empty())).toThrow('EMPTY')
  })

  it('保留单双三键和合法电荷', () => {
    for (const smiles of ['CC', 'C=O', 'C#N', '[NH4+]', '[O-]C=O']) {
      const graph = parseEditorSmiles(smiles)
      expect(identity(serializeEditorGraph(graph))).toBe(identity(smiles))
    }
    expect(parseEditorSmiles('C#N').bonds[0].order).toBe(3)
    expect(parseEditorSmiles('C=O').bonds[0].order).toBe(2)
  })
})

describe('图编辑操作', () => {
  it('新增键不改变输入，重复连接不会覆盖原有键级', () => {
    const graph = parseEditorSmiles('C.O')
    const bonded = addEditorBond(graph, 0, 1, 2)
    expect(graph.bonds).toHaveLength(0)
    expect(bonded.bonds).toEqual([{ from: 0, to: 1, order: 2 }])
    expect(identity(serializeEditorGraph(bonded))).toBe(identity('C=O'))
    const duplicate = addEditorBond(bonded, 1, 0, 1)
    expect(duplicate.bonds).toEqual(bonded.bonds)
    expect(duplicate).not.toBe(bonded)
    duplicate.atoms[0].x = 999
    expect(bonded.atoms[0].x).not.toBe(999)
    expect(addEditorBond(graph, 0, 1).bonds[0].order).toBe(1)
  })

  it.each([[0, 0, 1], [-1, 1, 1], [0, 2, 1], [0.5, 1, 1], [0, 1, 4]])('拒绝非法连接 %j', (from, to, order) => {
    expect(() => addEditorBond(parseEditorSmiles('C.O'), from, to, order)).toThrow('INVALID_GRAPH')
  })

  it('删除中间原子时删除相邻键并修复前后键索引', () => {
    const graph = parseEditorSmiles('CCCO')
    const removed = removeEditorAtom(graph, 1)
    expect(graph.atoms).toHaveLength(4)
    expect(graph.bonds).toHaveLength(3)
    expect(removed.atoms).toHaveLength(3)
    expect(removed.bonds).toEqual([{ from: 1, to: 2, order: 1 }])
    expect(identity(serializeEditorGraph(removed))).toBe(identity('C.CO'))
    removed.atoms[0].charge = 1
    expect(graph.atoms[0].charge).toBe(0)
    expect(() => removeEditorAtom(graph, 4)).toThrow('INVALID_GRAPH')
  })

  it('删除末端和首端原子后保留正确索引', () => {
    const graph = parseEditorSmiles('CCCO')
    expect(removeEditorAtom(graph, 3).bonds).toEqual([{ from: 0, to: 1, order: 1 }, { from: 1, to: 2, order: 1 }])
    expect(removeEditorAtom(graph, 0).bonds).toEqual([{ from: 0, to: 1, order: 1 }, { from: 1, to: 2, order: 1 }])
  })

  it('删除单个键不改变原子和输入图', () => {
    const graph = parseEditorSmiles('CCO')
    const removed = removeEditorBond(graph, 0)
    expect(removed.bonds).toHaveLength(1)
    expect(graph.bonds).toHaveLength(2)
    expect(removed.atoms).toEqual(graph.atoms)
    expect(removed.atoms[0]).not.toBe(graph.atoms[0])
    expect(() => removeEditorBond(graph, -1)).toThrow('INVALID_GRAPH')
    expect(() => removeEditorBond(graph, 2)).toThrow('INVALID_GRAPH')
    expect(() => removeEditorBond(graph, 0.5)).toThrow('INVALID_GRAPH')
  })

  it('新绘苯环采用交替单双键，环边长为 44', () => {
    const source = empty()
    const graph = addEditorRing(source, 320, 180, 6, true)
    expect(source.atoms).toHaveLength(0)
    expect(graph.atoms).toHaveLength(6)
    expect(graph.bonds.map(bond => bond.order)).toEqual([2, 1, 2, 1, 2, 1])
    for (const bond of graph.bonds) expect(Math.hypot(graph.atoms[bond.from].x - graph.atoms[bond.to].x, graph.atoms[bond.from].y - graph.atoms[bond.to].y)).toBeCloseTo(44)
    expect(identity(serializeEditorGraph(graph))).toBe(identity('c1ccccc1'))
  })

  it('三元环替换一个氧即为环氧乙烷，可添加第二个独立环', () => {
    const triangle = addEditorRing(empty(), 160, 180, 3, false)
    triangle.atoms[0].element = 'O'
    expect(identity(serializeEditorGraph(triangle))).toBe(identity('C1CO1'))
    const both = addEditorRing(triangle, 450, 180, 6, false)
    expect(triangle.atoms).toHaveLength(3)
    expect(both.atoms).toHaveLength(9)
    expect(both.bonds.slice(3).every(bond => bond.from >= 3 && bond.to >= 3)).toBe(true)
    expect(identity(serializeEditorGraph(both))).toBe(identity('C1CO1.C1CCCCC1'))
  })

  it('拒绝芳香三元环和不合法环参数', () => {
    expect(() => addEditorRing(empty(), 320, 180, 3, true)).toThrow('INVALID_GRAPH')
    expect(() => addEditorRing(empty(), NaN, 180, 6, false)).toThrow('INVALID_GRAPH')
    expect(() => addEditorRing(empty(), 320, 180, 4 as 6, false)).toThrow('INVALID_GRAPH')
  })

  it('整理结构保持连接关系、忽略立体且不修改原图', () => {
    const source = parseEditorSmiles('COC(=O)/C=C/c1cccc(S(=O)(=O)Nc2ccccc2)c1')
    const snapshot = structuredClone(source)
    const arranged = layoutEditorGraph(source)
    expect(source).toEqual(snapshot)
    insideCanvas(arranged)
    expect(identity(serializeEditorGraph(arranged))).toBe(identity(serializeEditorGraph(source)))
    expect(layoutEditorGraph(empty())).toEqual(empty())
  })
})

describe('原子延长方向', () => {
  it.each([0, 1, 2, 3, 4, 5])('苯环顶点 %i 沿环外角平分线延长一根键', index => {
    const graph = addEditorRing(empty(), 320, 180, 6, true)
    const snapshot = structuredClone(graph)
    const point = getEditorExtensionPoint(graph, index)
    const atom = graph.atoms[index]
    expect(point.x).toBeCloseTo(320 + 2 * (atom.x - 320))
    expect(point.y).toBeCloseTo(180 + 2 * (atom.y - 180))
    expect(Math.hypot(point.x - atom.x, point.y - atom.y)).toBeCloseTo(44)
    expect(graph).toEqual(snapshot)
  })

  it('旋转后的苯环仍沿真实角平分线延长，不吸附到开链候选角', () => {
    const graph = addEditorRing(empty(), 320, 180, 6, true)
    const angle = Math.PI / 9
    graph.atoms = graph.atoms.map(atom => ({
      ...atom,
      x: 320 + (atom.x - 320) * Math.cos(angle) - (atom.y - 180) * Math.sin(angle),
      y: 180 + (atom.x - 320) * Math.sin(angle) + (atom.y - 180) * Math.cos(angle),
    }))
    const point = getEditorExtensionPoint(graph, 0)
    expect(point.x).toBeCloseTo(320 + 88 * Math.sin(angle))
    expect(point.y).toBeCloseTo(180 - 88 * Math.cos(angle))
  })

  it('拥挤取代苯优先沿局部环外方向，避免被其他取代基偏转', () => {
    const graph = parseEditorSmiles('CC(=O)Nc1ccc([N+](=O)[O-])cc1')
    const point = getEditorExtensionPoint(graph, 12)
    expect(point.x).toBeCloseTo(377.1576766497729)
    expect(point.y).toBeCloseTo(202)
    expect(Math.hypot(point.x - graph.atoms[12].x, point.y - graph.atoms[12].y)).toBeCloseTo(44)
  })

  it('环外位置已有原子时保留原有避碰候选', () => {
    const graph = addEditorRing(empty(), 320, 180, 6, true)
    graph.atoms.push({ element: 'C', x: 320, y: 92, charge: 0 })
    const point = getEditorExtensionPoint(graph, 0)
    expect(point.x).toBeCloseTo(358.1051177665153)
    expect(point.y).toBeCloseTo(114)
    expect(Math.hypot(point.x - 320, point.y - 92)).toBeGreaterThan(30)
  })

  it('环外位置越过画布边界时使用合法的原有候选', () => {
    const graph = addEditorRing(empty(), 320, 100, 6, true)
    const point = getEditorExtensionPoint(graph, 0)
    expect(point.x).toBeCloseTo(358.1051177665153)
    expect(point.y).toBeCloseTo(34)
    expect(point.x).toBeGreaterThanOrEqual(20)
    expect(point.x).toBeLessThanOrEqual(620)
    expect(point.y).toBeGreaterThanOrEqual(24)
    expect(point.y).toBeLessThanOrEqual(336)
  })

  it('开链的两个邻居不会被误判为环，闭合后才使用环外角平分线', () => {
    const graph: EditorGraph = {
      atoms: [
        { element: 'C', x: 320, y: 180, charge: 0 },
        { element: 'C', x: 320 + 44 * Math.cos(Math.PI / 9), y: 180 + 44 * Math.sin(Math.PI / 9), charge: 0 },
        { element: 'C', x: 320 + 44 * Math.cos(7 * Math.PI / 9), y: 180 + 44 * Math.sin(7 * Math.PI / 9), charge: 0 },
      ],
      bonds: [{ from: 0, to: 1, order: 1 }, { from: 0, to: 2, order: 1 }],
    }
    expect(getEditorExtensionPoint(graph, 0)).toEqual({ x: 320, y: 136 })
    const closed = addEditorBond(graph, 1, 2)
    const ringPoint = getEditorExtensionPoint(closed, 0)
    expect(ringPoint.x).toBeCloseTo(320 - 44 * Math.sin(Math.PI / 18))
    expect(ringPoint.y).toBeCloseTo(180 - 44 * Math.cos(Math.PI / 18))
  })

  it('孤立原子、单邻居和三配位节点保留原有候选评分', () => {
    const single: EditorGraph = { atoms: [{ element: 'C', x: 320, y: 180, charge: 0 }], bonds: [] }
    const singlePoint = getEditorExtensionPoint(single, 0)
    expect(singlePoint.x).toBeCloseTo(358.1051177665153)
    expect(singlePoint.y).toBeCloseTo(158)
    const end: EditorGraph = {
      atoms: [...single.atoms, { element: 'C', x: 364, y: 180, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: 1 }],
    }
    expect(getEditorExtensionPoint(end, 0)).toEqual({ x: 276, y: 180 })
    const branched = addEditorRing(empty(), 320, 180, 6, true)
    branched.atoms.push({ element: 'C', x: 320, y: 92, charge: 0 })
    branched.bonds.push({ from: 0, to: 6, order: 1 })
    const branchPoint = getEditorExtensionPoint(branched, 0)
    expect(branchPoint.x).toBeCloseTo(358.1051177665153)
    expect(branchPoint.y).toBeCloseTo(114)
  })

  it.each([
    { coordinates: [[320, 180], [320, 180], [364, 180]] },
    { coordinates: [[320, 180], [276, 180], [364, 180]] },
  ])('环边重合或共线时回退，不产生非有限坐标：$coordinates', ({ coordinates }) => {
    const graph: EditorGraph = {
      atoms: coordinates.map(([x, y]) => ({ element: 'C', x, y, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: 1 }, { from: 1, to: 2, order: 1 }, { from: 2, to: 0, order: 1 }],
    }
    const point = getEditorExtensionPoint(graph, 0)
    expect(Number.isFinite(point.x)).toBe(true)
    expect(Number.isFinite(point.y)).toBe(true)
    expect(Math.hypot(point.x - 320, point.y - 180)).toBeCloseTo(44)
  })

  it.each([-1, 1, 0.5, NaN])('拒绝不存在的起点 %s', index => {
    const graph: EditorGraph = { atoms: [{ element: 'C', x: 320, y: 180, charge: 0 }], bonds: [] }
    expect(() => getEditorExtensionPoint(graph, index)).toThrow('INVALID_GRAPH')
  })
})

describe('非法结构校验', () => {
  it.each(['C', 'O', 'N'])('拒绝 %s 的过高价态', element => {
    const limit = element === 'C' ? 4 : element === 'O' ? 2 : 3
    const graph: EditorGraph = {
      atoms: Array.from({ length: limit + 2 }, (_, index) => ({ element: index ? 'C' : element, x: index * 44, y: 100, charge: 0 })),
      bonds: Array.from({ length: limit + 1 }, (_, index) => ({ from: 0, to: index + 1, order: 1 })),
    }
    expect(() => serializeEditorGraph(graph)).toThrow('VALENCE')
  })

  it('拒绝重复键、自连接、无效索引和不支持的键级', () => {
    const base = parseEditorSmiles('CO')
    const invalidBonds = [
      [...base.bonds, { from: 1, to: 0, order: 1 }],
      [{ from: 0, to: 0, order: 1 }],
      [{ from: 0, to: 2, order: 1 }],
      [{ from: -1, to: 1, order: 1 }],
      [{ from: 0, to: 1, order: 1.5 }],
    ]
    for (const bonds of invalidBonds) expect(() => serializeEditorGraph({ ...base, bonds })).toThrow('INVALID_GRAPH')
    expect(() => serializeEditorGraph({ atoms: [], bonds: [{ from: 0, to: 1, order: 1 }] })).toThrow('INVALID_GRAPH')
  })

  it('拒绝未知元素、非有限坐标和非法电荷', () => {
    const base = parseEditorSmiles('C')
    for (const atom of [
      { ...base.atoms[0], element: 'fake' },
      { ...base.atoms[0], x: Infinity },
      { ...base.atoms[0], y: NaN },
      { ...base.atoms[0], charge: 0.5 },
    ]) expect(() => serializeEditorGraph({ atoms: [atom], bonds: [] })).toThrow('INVALID_GRAPH')
  })

  it('解析金属配位键保持 order 0，无法保真写出时明确拒绝', () => {
    const graph = parseEditorSmiles('[NH3]->[Cu+2]')
    expect(graph.bonds[0].order).toBe(0)
    expect(() => serializeEditorGraph(graph)).toThrow('INVALID_GRAPH')
  })

  it('拒绝运行时损坏的图容器', () => {
    expect(() => serializeEditorGraph({ atoms: null, bonds: [] } as unknown as EditorGraph)).toThrow('INVALID_GRAPH')
    expect(() => serializeEditorGraph({ atoms: [], bonds: null } as unknown as EditorGraph)).toThrow('INVALID_GRAPH')
  })
})
