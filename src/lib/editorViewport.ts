import type { EditorAtom, EditorGraph } from './moleculeEditor'

interface Point {
  x: number
  y: number
}

interface ViewportSize {
  width: number
  height: number
}

interface EditorViewport {
  center: Point
  zoom: number
}

interface EditorHit {
  atom: number
  bond: number
}

const DEFAULT_ZOOM = 1.35
const MIN_ZOOM = 0.45
const MAX_ZOOM = 2.5
const FIT_MARGIN = 44
const ATOM_RADIUS = 18
const BOND_RADIUS = 14

function fitMargin(dimension: number): number {
  return Math.min(FIT_MARGIN, Math.max(ATOM_RADIUS, (dimension - 120) / 2))
}

function finitePoint(point: Point | undefined): point is Point {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function validAtom(atoms: EditorAtom[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && finitePoint(atoms[index])
}

/** zoom 表示每个分子坐标单位占用的屏幕像素；居中与缩放不改变分子坐标。 */
export function fitEditorViewport(graph: EditorGraph, size: ViewportSize, preferredZoom = DEFAULT_ZOOM): EditorViewport {
  const preferred = Number.isFinite(preferredZoom) ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, preferredZoom)) : DEFAULT_ZOOM
  const atoms = graph.atoms.filter(finitePoint)
  if (!atoms.length) return { center: { x: 320, y: 180 }, zoom: preferred }

  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 640
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 360
  let minX = atoms[0].x
  let maxX = minX
  let minY = atoms[0].y
  let maxY = minY
  for (const atom of atoms) {
    minX = Math.min(minX, atom.x)
    maxX = Math.max(maxX, atom.x)
    minY = Math.min(minY, atom.y)
    maxY = Math.max(maxY, atom.y)
  }
  const spanX = maxX - minX
  const spanY = maxY - minY
  const fitX = spanX > 0 ? Math.max(1, width - fitMargin(width) * 2) / spanX : preferred
  const fitY = spanY > 0 ? Math.max(1, height - fitMargin(height) * 2) / spanY : preferred
  return {
    center: { x: minX / 2 + maxX / 2, y: minY / 2 + maxY / 2 },
    zoom: Math.max(MIN_ZOOM, Math.min(preferred, fitX, fitY)),
  }
}

/** point 使用分子坐标；触摸范围按屏幕像素计算，与 DOM 绘制顺序无关。 */
export function hitTestEditorGraph(graph: EditorGraph, point: Point, zoom: number): EditorHit {
  const miss = { atom: -1, bond: -1 }
  if (!finitePoint(point) || !Number.isFinite(zoom) || zoom <= 0) return miss

  let atomIndex = -1
  let atomDistance = ATOM_RADIUS
  graph.atoms.forEach((atom, index) => {
    if (!finitePoint(atom)) return
    const distance = Math.hypot((atom.x - point.x) * zoom, (atom.y - point.y) * zoom)
    if (distance <= atomDistance && (atomIndex < 0 || distance < atomDistance)) {
      atomIndex = index
      atomDistance = distance
    }
  })

  let bondIndex = -1
  let bondDistance = BOND_RADIUS
  let shortBondCenter = false
  graph.bonds.forEach((bond, index) => {
    if (bond.from === bond.to || !validAtom(graph.atoms, bond.from) || !validAtom(graph.atoms, bond.to)) return
    const from = graph.atoms[bond.from]
    const to = graph.atoms[bond.to]
    const dx = (to.x - from.x) * zoom
    const dy = (to.y - from.y) * zoom
    const length = Math.hypot(dx, dy)
    if (!Number.isFinite(length) || length === 0) return
    const px = (point.x - from.x) * zoom
    const py = (point.y - from.y) * zoom
    const ux = dx / length
    const uy = dy / length
    const projection = (px * ux + py * uy) / length
    const distance = Math.abs(px * uy - py * ux)
    if (!Number.isFinite(projection) || !Number.isFinite(distance) || projection < 0.18 || projection > 0.82 || distance > BOND_RADIUS) return

    // 短键缩小后不足 36 px，必须留下可点的中段，不能让两个端点触摸圈占满整条键。
    const endpointGuard = Math.min(ATOM_RADIUS, length * 0.3)
    if (Math.min(Math.hypot(px, py), Math.hypot(px - dx, py - dy)) < endpointGuard) return
    if (bondIndex >= 0 && distance >= bondDistance) return
    bondIndex = index
    bondDistance = distance
    shortBondCenter = length <= ATOM_RADIUS * 2 && projection >= 0.3 && projection <= 0.7
      && (atomIndex === bond.from || atomIndex === bond.to)
  })

  if (atomIndex >= 0 && !shortBondCenter) return { atom: atomIndex, bond: -1 }
  return bondIndex >= 0 ? { atom: -1, bond: bondIndex } : miss
}
