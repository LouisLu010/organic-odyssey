import { describe, expect, it } from 'vitest'
import type { EditorGraph } from './moleculeEditor'
import { fitEditorViewport, hitTestEditorGraph } from './editorViewport'

function graph(points: [number, number][], bonds: [number, number][] = []): EditorGraph {
  return {
    atoms: points.map(([x, y]) => ({ element: 'C', x, y, charge: 0 })),
    bonds: bonds.map(([from, to]) => ({ from, to, order: 1 })),
  }
}

const PHONE = { width: 332, height: 300 }
const MISS = { atom: -1, bond: -1 }

describe('fitEditorViewport', () => {
  it('空图以默认坐标居中，44 单位键长初始显示约 60 px', () => {
    expect(fitEditorViewport(graph([]), PHONE)).toEqual({ center: { x: 320, y: 180 }, zoom: 1.35 })
    const viewport = fitEditorViewport(graph([[298, 180], [342, 180]], [[0, 1]]), PHONE)
    expect(viewport).toEqual({ center: { x: 320, y: 180 }, zoom: 1.35 })
    expect(44 * viewport.zoom).toBeCloseTo(59.4)
  })

  it('使用实际分子包围盒中心，平移后的分子不会偏离画布中央', () => {
    expect(fitEditorViewport(graph([[900, -440], [944, -418]]), PHONE)).toEqual({ center: { x: 922, y: -429 }, zoom: 1.35 })
    expect(fitEditorViewport(graph([[-60, 700]]), PHONE)).toEqual({ center: { x: -60, y: 700 }, zoom: 1.35 })
  })

  it('长分子按屏幕两侧各 44 px 留白适配', () => {
    const result = fitEditorViewport(graph([[0, 0], [500, 40]]), PHONE)
    expect(result.center).toEqual({ x: 250, y: 20 })
    expect(result.zoom).toBeCloseTo((332 - 88) / 500)
    expect((PHONE.width - 500 * result.zoom) / 2).toBeCloseTo(44)
  })

  it('竖向结构同时受上下边距约束', () => {
    const result = fitEditorViewport(graph([[100, -200], [120, 200]]), PHONE)
    expect(result.zoom).toBeCloseTo((300 - 88) / 400)
    expect((PHONE.height - 400 * result.zoom) / 2).toBeCloseTo(44)
  })

  it('短屏减少留白，同时保留端点的完整触摸范围', () => {
    const molecule = graph([[0, 0], [88, 88]])
    const size = { width: 298, height: 123 }
    const viewport = fitEditorViewport(molecule, size)
    expect(viewport.zoom).toBeCloseTo((123 - 36) / 88)
    expect(viewport.zoom).toBeGreaterThan(0.9)
    for (const atom of molecule.atoms) {
      const screenY = size.height / 2 + (atom.y - viewport.center.y) * viewport.zoom
      expect(screenY).toBeGreaterThanOrEqual(18)
      expect(screenY).toBeLessThanOrEqual(size.height - 18)
    }
    const landscape = fitEditorViewport(molecule, { width: 123, height: 298 })
    expect(landscape.zoom).toBeCloseTo(viewport.zoom)
  })

  it('极大分子保持最小缩放，剩余内容通过相机平移访问', () => {
    expect(fitEditorViewport(graph([[-1000, -1000], [1000, 1000]]), PHONE).zoom).toBe(0.45)
  })

  it.each([[0.1, 0.45], [0.8, 0.8], [9, 2.5], [NaN, 1.35], [Infinity, 1.35]])('首选缩放 %s 规范为 %s', (preferred, expected) => {
    expect(fitEditorViewport(graph([[0, 0]]), PHONE, preferred).zoom).toBe(expected)
  })

  it('忽略无效原子坐标，全无效时使用空图相机', () => {
    expect(fitEditorViewport(graph([[NaN, 4], [Infinity, 2], [40, 60], [80, 100]]), PHONE)).toEqual({ center: { x: 60, y: 80 }, zoom: 1.35 })
    expect(fitEditorViewport(graph([[NaN, 4], [Infinity, 2]]), PHONE)).toEqual({ center: { x: 320, y: 180 }, zoom: 1.35 })
  })

  it('未测到画布尺寸时使用默认大小，极小画布仍返回有限相机', () => {
    const molecule = graph([[0, 0], [300, 100]])
    expect(fitEditorViewport(molecule, { width: 0, height: NaN })).toEqual(fitEditorViewport(molecule, { width: 640, height: 360 }))
    expect(fitEditorViewport(molecule, { width: 10, height: 10 }).zoom).toBe(0.45)
  })

  it('极大但有限的正负坐标不会溢出相机中心', () => {
    const result = fitEditorViewport(graph([[-1e308, 0], [1e308, 0]]), PHONE)
    expect(result).toEqual({ center: { x: 0, y: 0 }, zoom: 0.45 })
  })
})

describe('hitTestEditorGraph', () => {
  it('空图与画布空白返回未命中', () => {
    expect(hitTestEditorGraph(graph([]), { x: 320, y: 180 }, 1.35)).toEqual(MISS)
    expect(hitTestEditorGraph(graph([[0, 0]]), { x: 300, y: 200 }, 1)).toEqual(MISS)
  })

  it('原子以屏幕 18 px 为触摸半径，恰好在边界仍可选', () => {
    const molecule = graph([[20, 40]])
    expect(hitTestEditorGraph(molecule, { x: 29, y: 40 }, 2)).toEqual({ atom: 0, bond: -1 })
    expect(hitTestEditorGraph(molecule, { x: 29.1, y: 40 }, 2)).toEqual(MISS)
  })

  it('重叠原子触摸范围选择最近者，不受后绘制原子覆盖', () => {
    const molecule = graph([[0, 0], [20, 0]])
    expect(hitTestEditorGraph(molecule, { x: 2, y: 0 }, 1)).toEqual({ atom: 0, bond: -1 })
    expect(hitTestEditorGraph(molecule, { x: 18, y: 0 }, 1)).toEqual({ atom: 1, bond: -1 })
    expect(hitTestEditorGraph(molecule, { x: 10, y: 0 }, 1)).toEqual({ atom: 0, bond: -1 })
  })

  it('普通键的中段选键，两端选原子', () => {
    const molecule = graph([[0, 0], [44, 0]], [[0, 1]])
    expect(hitTestEditorGraph(molecule, { x: 22, y: 0 }, 1.35)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 5, y: 0 }, 1.35)).toEqual({ atom: 0, bond: -1 })
    expect(hitTestEditorGraph(molecule, { x: 39, y: 0 }, 1.35)).toEqual({ atom: 1, bond: -1 })
  })

  it('键按屏幕 14 px 容差选择，超出容差不命中', () => {
    const molecule = graph([[0, 0], [100, 0]], [[0, 1]])
    expect(hitTestEditorGraph(molecule, { x: 50, y: 7 }, 2)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 50, y: 7.1 }, 2)).toEqual(MISS)
  })

  it('键投影只接受 0.18 到 0.82 的中段', () => {
    const molecule = graph([[0, 0], [200, 0]], [[0, 1]])
    expect(hitTestEditorGraph(molecule, { x: 36, y: 0 }, 1)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 164, y: 0 }, 1)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 35, y: 0 }, 1)).toEqual(MISS)
    expect(hitTestEditorGraph(molecule, { x: 165, y: 0 }, 1)).toEqual(MISS)
  })

  it.each([0.45, 0.6, 0.8, 36 / 44])('缩放 %s 时短键的中点仍可选，两端仍可选原子', zoom => {
    const molecule = graph([[0, 0], [44, 0]], [[0, 1]])
    expect(hitTestEditorGraph(molecule, { x: 22, y: 0 }, zoom)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 4, y: 0 }, zoom)).toEqual({ atom: 0, bond: -1 })
    expect(hitTestEditorGraph(molecule, { x: 40, y: 0 }, zoom)).toEqual({ atom: 1, bond: -1 })
  })

  it('短键中段不会抢走不属于该键的更近原子', () => {
    const molecule = graph([[0, 0], [44, 0], [22, 1]], [[0, 1]])
    expect(hitTestEditorGraph(molecule, { x: 22, y: 1 }, 0.45)).toEqual({ atom: 2, bond: -1 })
  })

  it('短键端点保护随键长自适应，普通键仍保护两端 18 px', () => {
    const short = graph([[0, 0], [20, 0]], [[0, 1]])
    expect(hitTestEditorGraph(short, { x: 5.9, y: 0 }, 1)).toEqual({ atom: 0, bond: -1 })
    expect(hitTestEditorGraph(short, { x: 6, y: 0 }, 1)).toEqual({ atom: -1, bond: 0 })
    const normal = graph([[0, 0], [60, 0]], [[0, 1]])
    expect(hitTestEditorGraph(normal, { x: 17, y: 0 }, 1)).toEqual({ atom: 0, bond: -1 })
  })

  it('相邻或重叠键选择距离最近者，同距时固定选择第一条', () => {
    const molecule = graph([[0, 0], [100, 0], [0, 12], [100, 12]], [[0, 1], [2, 3]])
    expect(hitTestEditorGraph(molecule, { x: 50, y: 2 }, 1)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 50, y: 11 }, 1)).toEqual({ atom: -1, bond: 1 })
    expect(hitTestEditorGraph(molecule, { x: 50, y: 6 }, 1)).toEqual({ atom: -1, bond: 0 })
  })

  it('斜键与反向端点的命中结果一致', () => {
    const molecule = graph([[40, 70], [0, 0]], [[0, 1]])
    const reversed = { ...molecule, bonds: [{ from: 1, to: 0, order: 1 }] }
    expect(hitTestEditorGraph(molecule, { x: 20, y: 35 }, 1.35)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(molecule, { x: 20, y: 35 }, 1.35)).toEqual(hitTestEditorGraph(reversed, { x: 20, y: 35 }, 1.35))
  })

  it('忽略无效坐标、自键、坏端点与零长度键', () => {
    const molecule = graph([[0, 0], [100, 0], [NaN, 0], [Infinity, 0], [0, 0]], [[0, 1], [0, 0], [0, 9], [0, -1], [0, 0.5], [0, 2], [3, 1], [0, 4]])
    expect(hitTestEditorGraph(molecule, { x: 50, y: 0 }, 1)).toEqual({ atom: -1, bond: 0 })
    expect(hitTestEditorGraph(graph([[0, 0], [0, 0]], [[0, 1]]), { x: 12, y: 0 }, 1)).toEqual({ atom: 0, bond: -1 })
    expect(hitTestEditorGraph(graph([[-1e308, 0], [1e308, 0]], [[0, 1]]), { x: 0, y: 0 }, 1)).toEqual(MISS)
  })

  it.each([0, -1, NaN, Infinity])('拒绝无效缩放 %s', zoom => {
    expect(hitTestEditorGraph(graph([[0, 0]]), { x: 0, y: 0 }, zoom)).toEqual(MISS)
  })

  it('无效触摸坐标返回未命中', () => {
    expect(hitTestEditorGraph(graph([[0, 0]]), { x: NaN, y: 0 }, 1)).toEqual(MISS)
    expect(hitTestEditorGraph(graph([[0, 0]]), { x: 0, y: Infinity }, 1)).toEqual(MISS)
  })

  it('相机和命中计算均不修改冻结的输入图或坐标', () => {
    const molecule = graph([[100, 200], [144, 200]], [[0, 1]])
    const snapshot = structuredClone(molecule)
    molecule.atoms.forEach(Object.freeze)
    molecule.bonds.forEach(Object.freeze)
    Object.freeze(molecule.atoms)
    Object.freeze(molecule.bonds)
    Object.freeze(molecule)
    const point = Object.freeze({ x: 122, y: 200 })
    const size = Object.freeze({ width: 332, height: 300 })
    expect(fitEditorViewport(molecule, size).zoom).toBe(1.35)
    expect(hitTestEditorGraph(molecule, point, 1.35)).toEqual({ atom: -1, bond: 0 })
    expect(molecule).toEqual(snapshot)
  })
})
