import type { EditorAtom, EditorGraph } from './moleculeEditor'

interface BondLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

function validAtom(graph: EditorGraph, index: number): boolean {
  const atom = graph.atoms[index]
  return Number.isInteger(index) && Boolean(atom) && Number.isFinite(atom.x) && Number.isFinite(atom.y)
}

/** 排除目标边，固定搜索方向，保证稠环共边的反向画法选择同一个最短环。 */
function shortestRing(graph: EditorGraph, bondIndex: number): EditorAtom[] | undefined {
  const bond = graph.bonds[bondIndex]
  const start = Math.min(bond.from, bond.to)
  const end = Math.max(bond.from, bond.to)
  const neighbours = Array.from({ length: graph.atoms.length }, () => [] as number[])
  graph.bonds.forEach((edge, index) => {
    if (index === bondIndex || edge.from === edge.to || !validAtom(graph, edge.from) || !validAtom(graph, edge.to)) return
    // 重复边不构成二元环，搜索时一起排除。
    if (Math.min(edge.from, edge.to) === start && Math.max(edge.from, edge.to) === end) return
    neighbours[edge.from].push(edge.to)
    neighbours[edge.to].push(edge.from)
  })
  neighbours.forEach(list => list.sort((left, right) => left - right))

  const parents = new Map<number, number>([[start, -1]])
  const queue = [start]
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]
    for (const next of neighbours[current]) {
      if (parents.has(next)) continue
      parents.set(next, current)
      if (next === end) {
        const path: EditorAtom[] = []
        for (let atom = end; atom !== -1; atom = parents.get(atom)!) path.push(graph.atoms[atom])
        return path
      }
      queue.push(next)
    }
  }
  return undefined
}

/** 只计算显示线段，不修改原子连接、键级或芳香性。 */
export function getEditorBondLines(graph: EditorGraph, bondIndex: number): BondLine[] {
  if (!Number.isInteger(bondIndex) || bondIndex < 0 || bondIndex >= graph.bonds.length) return []
  const bond = graph.bonds[bondIndex]
  if (!validAtom(graph, bond.from) || !validAtom(graph, bond.to) || ![0, 1, 2, 3].includes(bond.order)) return []
  const from = graph.atoms[bond.from]
  const to = graph.atoms[bond.to]
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length <= 1e-8) return []

  const ux = dx / length
  const uy = dy / length
  const nx = -uy
  const ny = ux
  const line = (offset: number, trim = 0): BondLine => ({
    x1: from.x + nx * offset + ux * trim,
    y1: from.y + ny * offset + uy * trim,
    x2: to.x + nx * offset - ux * trim,
    y2: to.y + ny * offset - uy * trim,
  })

  let lines: BondLine[]
  if (bond.order === 2) {
    const ring = shortestRing(graph, bondIndex)
    const center = ring?.reduce((point, atom) => ({ x: point.x + atom.x / ring.length, y: point.y + atom.y / ring.length }), { x: 0, y: 0 })
    const insideDistance = center ? (center.x - (from.x + dx / 2)) * nx + (center.y - (from.y + dy / 2)) * ny : 0
    if (Number.isFinite(insideDistance) && Math.abs(insideDistance) > length * 1e-6) {
      const inset = Math.sign(insideDistance) * Math.min(length * 0.13, Math.abs(insideDistance) * 0.45)
      lines = [line(0), line(inset, length * 0.18)]
    } else {
      // 无环或环布局退化时保留对称双线，避免两线重叠。
      lines = [line(-length * 0.06), line(length * 0.06)]
    }
  } else if (bond.order === 3) {
    lines = [line(-length * 0.1), line(0), line(length * 0.1)]
  } else {
    lines = [line(0)]
  }
  return lines.every(segment => Object.values(segment).every(Number.isFinite)) ? lines : []
}
