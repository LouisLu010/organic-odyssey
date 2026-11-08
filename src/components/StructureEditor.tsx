import { useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, Check, ChevronDown, Eraser, Hand, Maximize2, PencilLine, Redo2, Sparkles, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { getEditorBondLines } from '../lib/bondGeometry'
import { fitEditorViewport, hitTestEditorGraph } from '../lib/editorViewport'
import { addEditorBond, addEditorRing, getEditorExtensionPoint, layoutEditorGraph, parseEditorSmiles, removeEditorAtom, removeEditorBond, serializeEditorGraph } from '../lib/moleculeEditor'
import type { EditorAtom, EditorGraph } from '../lib/moleculeEditor'
import '../styles/structure-editor.css'

interface StructureEditorProps {
  initialSmiles?: string
  title: string
  onSave: (smiles: string) => void
  onClose: () => void
}

type Tool = 'bond' | 'erase' | 'move' | 'benzene' | 'ring3' | 'ring6' | 'O' | 'N' | 'C' | 'S' | 'Mg' | 'Br' | 'Cl' | 'F' | 'I' | 'P' | 'N+' | 'O-'
type Point = { x: number; y: number }
type History = { past: EditorGraph[]; present: EditorGraph; future: EditorGraph[] }
type Camera = { center: Point; zoom: number }
type Gesture = { point: Point; screen: Point; atom: number; bond: number; moved: boolean; pointer: number; camera: Camera; pan: boolean }
const EMPTY_GRAPH: EditorGraph = { atoms: [], bonds: [] }
const UNBOUNDED_CANVAS = { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity }
const MAIN_TOOLS: { value: Tool; label: string }[] = [{ value: 'bond', label: '画键' }, { value: 'O', label: 'O 氧' }, { value: 'N', label: 'N 氮' }, { value: 'benzene', label: '苯环' }, { value: 'erase', label: '橡皮' }]
const MORE_TOOLS: { value: Tool; label: string }[] = [{ value: 'C', label: 'C 碳' }, { value: 'S', label: 'S 硫' }, { value: 'Mg', label: 'Mg 镁' }, { value: 'Br', label: 'Br 溴' }, { value: 'Cl', label: 'Cl 氯' }, { value: 'F', label: 'F 氟' }, { value: 'I', label: 'I 碘' }, { value: 'P', label: 'P 磷' }, { value: 'N+', label: 'N⁺ 带正电氮' }, { value: 'O-', label: 'O⁻ 带负电氧' }, { value: 'ring3', label: '三元环' }, { value: 'ring6', label: '六元环' }, { value: 'move', label: '移动原子' }]
const TOOL_HELP: Record<string, string> = { bond: '选好键型，点原子延长碳链，点已有键修改；也可拖动连接。', erase: '点原子或键删除，删错了点撤销。', move: '拖动原子调整位置；两指可缩放和平移画布。', benzene: '点空白处放苯环，点原子接苯环。', ring3: '点空白处放三元环，用 O 替换顶点可画环氧基。', ring6: '点空白处放六元环，点原子接上一个环。' }
const BENZENE_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 2 8.66 5v10L12 22l-8.66-5V7Z" /><path d="m12.8 5.6 4.34 2.5m0 7.8-4.34 2.5M6.5 14.5v-5" /></svg>

function structureError(error: unknown): string {
  const message = String(error)
  if (message.includes('EMPTY')) return '画布还是空的。点一下放入碳原子，或选择苯环。'
  if (/valence|VALENCE/i.test(message)) return '有原子的成键数过多，请检查键型、原子和电荷。'
  return '这个结构暂时无法识别，请检查原子和化学键后再保存。'
}

function nearestAtom(graph: EditorGraph, point: Point, zoom: number, exclude = -1): number {
  let result = -1
  let distance = 20 / zoom
  graph.atoms.forEach((atom, index) => {
    const current = Math.hypot(atom.x - point.x, atom.y - point.y)
    if (index !== exclude && current < distance) { result = index; distance = current }
  })
  return result
}

function atomLabel(atom: EditorAtom, index: number, graph: EditorGraph): { text: string; hydrogens: number; charge: string } {
  const bonds = graph.bonds.filter(bond => bond.from === index || bond.to === index)
  const valence = bonds.reduce((sum, bond) => sum + bond.order, 0)
  const target = atom.element === 'O' ? 2 + atom.charge : atom.element === 'N' ? 3 + atom.charge : 0
  const hydrogens = target > 0 ? Math.max(0, target - valence) : 0
  const text = atom.element === 'C' && bonds.length && !atom.charge ? '' : atom.element
  const charge = atom.charge ? `${Math.abs(atom.charge) > 1 ? Math.abs(atom.charge) : ''}${atom.charge > 0 ? '+' : '−'}` : ''
  return { text, hydrogens, charge }
}

export default function StructureEditor({ initialSmiles, title, onSave, onClose }: StructureEditorProps) {
  const [history, setHistory] = useState<History>(() => {
    let present = EMPTY_GRAPH
    try { if (initialSmiles) present = parseEditorSmiles(initialSmiles) } catch { /* 无法载入时允许重新画图。 */ }
    return { past: [], present, future: [] }
  })
  const graph = history.present
  const [tool, setTool] = useState<Tool>('bond')
  const [bondOrder, setBondOrder] = useState(1)
  const [panning, setPanning] = useState(false)
  const [camera, setCamera] = useState<Camera>({ center: { x: 320, y: 180 }, zoom: 1.35 })
  const [error, setError] = useState('')
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<{ from: Point; to: Point } | null>(null)
  const [drawingSize, setDrawingSize] = useState({ width: 640, height: 360 })
  const dialogRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const advancedRef = useRef<HTMLDetailsElement>(null)
  const closeRef = useRef(onClose)
  const undoRef = useRef(() => {})
  const redoRef = useRef(() => {})
  const initialGraphRef = useRef(graph)
  const fittedRef = useRef(false)
  const gestureRef = useRef<Gesture | null>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const pinchRef = useRef<{ distance: number; zoom: number; anchor: Point } | null>(null)
  const suppressTapRef = useRef(false)
  const titleId = useId()
  const helpId = useId()
  const importId = useId()
  const errorId = useId()
  const viewWidth = drawingSize.width / camera.zoom
  const viewHeight = drawingSize.height / camera.zoom
  const labelScale = 1 / camera.zoom
  const viewBox = `${camera.center.x - viewWidth / 2} ${camera.center.y - viewHeight / 2} ${viewWidth} ${viewHeight}`

  function commit(next: EditorGraph) {
    if (next === graph) return
    setHistory(previous => ({ past: [...previous.past.slice(-59), previous.present], present: next, future: [] }))
    setError('')
  }

  function undo() {
    setHistory(previous => previous.past.length ? { past: previous.past.slice(0, -1), present: previous.past.at(-1)!, future: [previous.present, ...previous.future] } : previous)
    setError('')
  }

  function redo() {
    setHistory(previous => previous.future.length ? { past: [...previous.past, previous.present], present: previous.future[0], future: previous.future.slice(1) } : previous)
    setError('')
  }

  function chooseTool(next: Tool) { setTool(next); setPanning(false); setError('') }
  function fit(next = graph) { setCamera(fitEditorViewport(next, drawingSize)) }
  function zoomBy(factor: number) { setCamera(previous => ({ ...previous, zoom: Math.max(.45, Math.min(2.5, previous.zoom * factor)) })) }

  function reveal(point: Point) {
    setCamera(previous => {
      const radiusX = Math.max(22, drawingSize.width / 2 - 42) / previous.zoom
      const radiusY = Math.max(22, drawingSize.height / 2 - 42) / previous.zoom
      return { ...previous, center: {
        x: Math.min(point.x + radiusX, Math.max(point.x - radiusX, previous.center.x)),
        y: Math.min(point.y + radiusY, Math.max(point.y - radiusY, previous.center.y)),
      } }
    })
  }

  useEffect(() => { closeRef.current = onClose; undoRef.current = undo; redoRef.current = redo })

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const scrollY = window.scrollY
    const previousStyle = { overflow: document.body.style.overflow, position: document.body.style.position, top: document.body.style.top, width: document.body.style.width }
    Object.assign(document.body.style, { overflow: 'hidden', position: 'fixed', top: `${-scrollY}px`, width: '100%' })
    dialogRef.current?.querySelector<HTMLButtonElement>('.structure-editor-close')?.focus({ preventScroll: true })
    function updateViewport() {
      backdropRef.current?.style.setProperty('--editor-viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`)
      backdropRef.current?.style.setProperty('--editor-viewport-top', `${window.visualViewport?.offsetTop ?? 0}px`)
    }
    updateViewport()
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      const typing = event.target instanceof Element && !!event.target.closest('input, textarea, select')
      if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoRef.current(); else undoRef.current()
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, summary, [tabindex="0"]')].filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1)?.focus() }
      else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) { event.preventDefault(); focusable[0]?.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    const observer = new ResizeObserver(entries => {
      const size = { width: entries[0].contentRect.width, height: entries[0].contentRect.height }
      if (!size.width || !size.height) return
      setDrawingSize(size)
      if (!fittedRef.current) { fittedRef.current = true; setCamera(fitEditorViewport(initialGraphRef.current, size)) }
    })
    if (svgRef.current) observer.observe(svgRef.current)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', keydown, true)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
      Object.assign(document.body.style, previousStyle)
      window.scrollTo(0, scrollY)
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [])

  function eventPoint(event: PointerEvent<SVGSVGElement>): Point {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return camera.center
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }

  function addRing(point: Point, atom: number) {
    const size = tool === 'ring3' ? 3 : 6
    const radius = 44 / (2 * Math.sin(Math.PI / size))
    const center = atom >= 0 ? { x: graph.atoms[atom].x + 44 + radius, y: graph.atoms[atom].y } : point
    let next = addEditorRing(graph, center.x, center.y, size, tool === 'benzene')
    if (atom >= 0) {
      let closest = graph.atoms.length
      next.atoms.slice(graph.atoms.length).forEach((candidate, offset) => {
        const current = graph.atoms.length + offset
        if (Math.hypot(candidate.x - graph.atoms[atom].x, candidate.y - graph.atoms[atom].y) < Math.hypot(next.atoms[closest].x - graph.atoms[atom].x, next.atoms[closest].y - graph.atoms[atom].y)) closest = current
      })
      next = addEditorBond(next, atom, closest)
    }
    try { const arranged = layoutEditorGraph(next); commit(arranged); fit(arranged) } catch (cause) { setError(structureError(cause)) }
  }

  function tap(point: Point, atom: number, bond: number) {
    if (panning) return
    if (tool === 'erase') {
      if (atom >= 0) commit(removeEditorAtom(graph, atom))
      else if (bond >= 0) commit(removeEditorBond(graph, bond))
      return
    }
    if (tool === 'move') return
    if (tool === 'benzene' || tool === 'ring3' || tool === 'ring6') { addRing(point, atom); return }
    if (tool !== 'bond') {
      const element = tool.replace(/[+-]/g, '')
      const charge = tool.endsWith('+') ? 1 : tool.endsWith('-') ? -1 : 0
      if (atom >= 0) commit({ ...graph, atoms: graph.atoms.map((current, index) => index === atom ? { ...current, element, charge } : current) })
      else commit({ ...graph, atoms: [...graph.atoms, { ...point, element, charge }] })
      return
    }
    if (bond >= 0) {
      commit({ ...graph, bonds: graph.bonds.map((current, index) => index === bond ? { ...current, order: bondOrder } : current) })
    } else if (atom >= 0) {
      const nextPoint = getEditorExtensionPoint(graph, atom, UNBOUNDED_CANVAS)
      const next = { ...graph, atoms: [...graph.atoms, { ...nextPoint, element: 'C', charge: 0 }] }
      commit(addEditorBond(next, atom, next.atoms.length - 1, bondOrder))
      reveal(nextPoint)
    } else {
      commit({ ...graph, atoms: [...graph.atoms, { ...point, element: 'C', charge: 0 }] })
    }
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture(event.pointerId)
    if (pointersRef.current.size > 1) {
      const [first, second] = [...pointersRef.current.values()]
      const rect = event.currentTarget.getBoundingClientRect()
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      pinchRef.current = { distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), zoom: camera.zoom, anchor: { x: camera.center.x + (midpoint.x - rect.left - rect.width / 2) / camera.zoom, y: camera.center.y + (midpoint.y - rect.top - rect.height / 2) / camera.zoom } }
      suppressTapRef.current = true
      gestureRef.current = null
      setPreview(null)
      return
    }
    const point = eventPoint(event)
    const target = hitTestEditorGraph(graph, point, camera.zoom)
    gestureRef.current = { point: target.atom >= 0 ? graph.atoms[target.atom] : point, screen: { x: event.clientX, y: event.clientY }, ...target, moved: false, pointer: event.pointerId, camera, pan: panning }
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const pinch = pinchRef.current
    if (pinch && pointersRef.current.size > 1) {
      const [first, second] = [...pointersRef.current.values()]
      const rect = event.currentTarget.getBoundingClientRect()
      const zoom = Math.max(.45, Math.min(2.5, pinch.zoom * Math.hypot(first.x - second.x, first.y - second.y) / pinch.distance))
      setCamera({ zoom, center: { x: pinch.anchor.x - ((first.x + second.x) / 2 - rect.left - rect.width / 2) / zoom, y: pinch.anchor.y - ((first.y + second.y) / 2 - rect.top - rect.height / 2) / zoom } })
      return
    }
    const gesture = gestureRef.current
    if (!gesture || gesture.pointer !== event.pointerId || suppressTapRef.current) return
    if (Math.hypot(event.clientX - gesture.screen.x, event.clientY - gesture.screen.y) > 10) gesture.moved = true
    if (!gesture.moved) return
    if (gesture.pan) {
      setCamera({ ...gesture.camera, center: { x: gesture.camera.center.x - (event.clientX - gesture.screen.x) / gesture.camera.zoom, y: gesture.camera.center.y - (event.clientY - gesture.screen.y) / gesture.camera.zoom } })
      return
    }
    const point = eventPoint(event)
    if (tool === 'bond') setPreview({ from: gesture.point, to: point })
    else if (tool === 'move' && gesture.atom >= 0) setPreview({ from: point, to: point })
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    pointersRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (suppressTapRef.current) {
      if (pointersRef.current.size < 2) pinchRef.current = null
      if (!pointersRef.current.size) suppressTapRef.current = false
      return
    }
    const gesture = gestureRef.current
    gestureRef.current = null
    setPreview(null)
    if (!gesture || gesture.pointer !== event.pointerId || gesture.pan) return
    if (!gesture.moved) { tap(gesture.point, gesture.atom, gesture.bond); return }
    const point = eventPoint(event)
    if (tool === 'move' && gesture.atom >= 0) {
      commit({ ...graph, atoms: graph.atoms.map((atom, index) => index === gesture.atom ? { ...atom, ...point } : atom) })
      return
    }
    if (tool !== 'bond') return
    const atoms = [...graph.atoms]
    const from = gesture.atom >= 0 ? gesture.atom : atoms.push({ ...gesture.point, element: 'C', charge: 0 }) - 1
    let to = nearestAtom(graph, point, camera.zoom, from)
    if (to < 0) {
      const angle = Math.round(Math.atan2(point.y - gesture.point.y, point.x - gesture.point.x) / (Math.PI / 6)) * Math.PI / 6
      const length = Math.max(44, Math.min(88, Math.hypot(point.x - gesture.point.x, point.y - gesture.point.y)))
      to = atoms.push({ x: gesture.point.x + Math.cos(angle) * length, y: gesture.point.y + Math.sin(angle) * length, element: 'C', charge: 0 }) - 1
    }
    commit(addEditorBond({ ...graph, atoms }, from, to, bondOrder))
    reveal(atoms[to])
  }

  function cancelPointers() { pointersRef.current.clear(); gestureRef.current = null; pinchRef.current = null; suppressTapRef.current = false; setPreview(null) }

  function importStructure() {
    try {
      const next = parseEditorSmiles(importText.trim())
      serializeEditorGraph(next)
      commit(next)
      fit(next)
      setImportText('')
      if (advancedRef.current) advancedRef.current.open = false
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    } catch (cause) { setError(structureError(cause)) }
  }

  return createPortal(<div ref={backdropRef} className="structure-editor-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="structure-editor-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={helpId} ref={dialogRef} tabIndex={-1}>
      <header className="structure-editor-header"><div><span>键线式分子画板</span><h2 id={titleId}>{title}</h2></div><button className="structure-editor-close" aria-label="关闭分子绘图" onClick={onClose}><X size={22} /></button></header>
      <div className="simple-editor-toolbar" role="group" aria-label="分子绘图工具">{MAIN_TOOLS.map(item => <button key={item.value} type="button" aria-pressed={tool === item.value && !panning} className={tool === item.value && !panning ? 'selected' : ''} onClick={() => chooseTool(item.value)}>{item.value === 'bond' ? <PencilLine size={18} /> : item.value === 'benzene' ? BENZENE_ICON : item.value === 'erase' ? <Eraser size={18} /> : null}{item.label}</button>)}<select aria-label="更多原子和环工具" value={MORE_TOOLS.some(item => item.value === tool) ? tool : ''} onChange={event => chooseTool(event.target.value as Tool)}><option value="" disabled>更多</option>{MORE_TOOLS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
      <div className="simple-editor-action-row"><div className="bond-order-controls" role="group" aria-label="选择键型">{[1, 2, 3].map(order => <button key={order} type="button" aria-label={`使用${['单', '双', '三'][order - 1]}键`} aria-pressed={tool === 'bond' && bondOrder === order && !panning} onClick={() => { chooseTool('bond'); setBondOrder(order) }}>{['单键', '双键', '三键'][order - 1]}</button>)}</div><div className="editor-history-controls"><button type="button" aria-label="撤销一步" title="撤销（⌘/Ctrl Z）" disabled={!history.past.length} onClick={undo}><Undo2 size={20} /></button><button type="button" aria-label="重做一步" disabled={!history.future.length} onClick={redo}><Redo2 size={20} /></button></div></div>
      <p className="simple-editor-instruction" id={helpId}>{panning ? '拖动画布移动视野；再次点手掌即可继续画图。' : TOOL_HELP[tool] ?? `点原子替换成 ${tool}，或在空白处放入后连键。`}</p>
      <div className="structure-editor-canvas-frame"><svg ref={svgRef} className={`simple-molecule-canvas tool-${panning ? 'pan' : tool}`} viewBox={viewBox} role="group" aria-label="键线式分子绘图画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelPointers}>
        {!graph.atoms.length ? <g className="simple-canvas-empty" pointerEvents="none"><text x={camera.center.x} y={camera.center.y - 12 * labelScale} textAnchor="middle" fontSize={17 * labelScale}>点一下放入碳原子</text><text x={camera.center.x} y={camera.center.y + 16 * labelScale} textAnchor="middle" fontSize={13 * labelScale}>再点原子延长，或选择苯环</text></g> : null}
        {graph.bonds.map((bond, index) => {
          const from = graph.atoms[bond.from]
          const to = graph.atoms[bond.to]
          return <g key={index} data-bond={index} role="button" tabIndex={0} aria-label={`化学键 ${index + 1}：${bond.order === 2 ? '双键' : bond.order === 3 ? '三键' : '单键'}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tap({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, -1, index) } }} className="simple-editor-bond"><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={28 * labelScale} />{getEditorBondLines(graph, index).map((line, lineIndex) => <line key={lineIndex} {...line} className="visible-bond" vectorEffect="non-scaling-stroke" />)}</g>
        })}
        {graph.atoms.map((atom, index) => {
          const label = atomLabel(atom, index, graph)
          return <g key={index} data-atom={index} role="button" tabIndex={0} aria-label={`原子 ${index + 1} ${atom.element}${label.charge}`} className={`simple-editor-atom element-${atom.element}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tap(atom, index, -1) } }}><circle cx={atom.x} cy={atom.y} r={18 * labelScale} fill="transparent" className="atom-touch-target" />{label.text ? <><rect x={atom.x - (label.hydrogens ? 15 : 9) * labelScale} y={atom.y - 11 * labelScale} width={(label.hydrogens ? 30 : 18) * labelScale} height={22 * labelScale} fill="white" pointerEvents="none" /><text x={atom.x} y={atom.y} textAnchor="middle" dominantBaseline="central" fontSize={19 * labelScale} pointerEvents="none">{label.text}{label.hydrogens ? <tspan>H{label.hydrogens > 1 ? <tspan baselineShift="sub" fontSize=".65em">{label.hydrogens}</tspan> : null}</tspan> : null}{label.charge ? <tspan baselineShift="super" fontSize=".65em">{label.charge}</tspan> : null}</text></> : <circle cx={atom.x} cy={atom.y} r={3.2 * labelScale} className="carbon-handle" pointerEvents="none" />}</g>
        })}
        {preview ? <line x1={preview.from.x} y1={preview.from.y} x2={preview.to.x} y2={preview.to.y} className="bond-preview" vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null}
      </svg><div className="editor-view-controls" role="group" aria-label="画板视图"><button type="button" aria-label="缩小分子视图" disabled={camera.zoom <= .45} onClick={() => zoomBy(.8)}><ZoomOut size={20} /></button><button type="button" aria-label="显示完整分子" onClick={() => fit()}><Maximize2 size={19} /></button><button type="button" aria-label="放大分子视图" disabled={camera.zoom >= 2.5} onClick={() => zoomBy(1.25)}><ZoomIn size={20} /></button><button type="button" aria-label="拖动画布" aria-pressed={panning} onClick={() => setPanning(value => !value)}><Hand size={20} /></button></div><span className="editor-zoom-value" aria-live="polite">{Math.round(camera.zoom * 100)}%</span></div>
      <div className="simple-editor-bottom-tools"><button type="button" onClick={() => { try { const next = layoutEditorGraph(graph); commit(next); fit(next) } catch (cause) { setError(structureError(cause)) } }} disabled={!graph.atoms.length}><Sparkles size={17} />整理结构</button><span>两指缩放、平移 · 端点和拐角是碳</span></div>
      <details ref={advancedRef} className="structure-editor-advanced"><summary>高级选项：导入 SMILES（可选）<ChevronDown size={16} /></summary><div className="structure-editor-import"><label htmlFor={importId}>SMILES 结构字符串</label><div><input id={importId} value={importText} onChange={event => setImportText(event.target.value)} placeholder="例如：CCO" autoComplete="off" spellCheck={false} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); importStructure() } }} /><button type="button" onClick={importStructure}><ArrowDownToLine size={16} />导入画布</button></div></div></details>
      {error ? <p className="structure-editor-error" id={errorId} role="alert">{error}</p> : null}
      <footer className="structure-editor-footer"><button className="structure-editor-clear" aria-label="清空画布" onClick={() => { commit(EMPTY_GRAPH); fit(EMPTY_GRAPH) }} disabled={!graph.atoms.length}><Eraser size={18} /><span>清空</span></button><div><span className="structure-editor-stereo-note">忽略立体异构</span><button className="button primary" onClick={() => { try { onSave(serializeEditorGraph(graph)) } catch (cause) { setError(structureError(cause)) } }} aria-describedby={error ? errorId : undefined}><Check size={18} />保存结构</button></div></footer>
    </div>
  </div>, document.body)
}
