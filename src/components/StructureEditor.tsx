import { useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, Check, ChevronDown, Eraser, Move, PencilLine, PencilRuler, Redo2, Sparkles, Undo2, X } from 'lucide-react'
import { getEditorBondLines } from '../lib/bondGeometry'
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
const EMPTY_GRAPH: EditorGraph = { atoms: [], bonds: [] }
const MAIN_TOOLS: { value: Tool; label: string }[] = [{ value: 'bond', label: '画键' }, { value: 'O', label: 'O 氧' }, { value: 'N', label: 'N 氮' }, { value: 'benzene', label: '苯环' }, { value: 'erase', label: '橡皮' }]
const MORE_TOOLS: { value: Tool; label: string }[] = [{ value: 'C', label: 'C 碳' }, { value: 'S', label: 'S 硫' }, { value: 'Mg', label: 'Mg 镁' }, { value: 'Br', label: 'Br 溴' }, { value: 'Cl', label: 'Cl 氯' }, { value: 'F', label: 'F 氟' }, { value: 'I', label: 'I 碘' }, { value: 'P', label: 'P 磷' }, { value: 'N+', label: 'N⁺ 带正电氮' }, { value: 'O-', label: 'O⁻ 带负电氧' }, { value: 'ring3', label: '三元环' }, { value: 'ring6', label: '六元环' }, { value: 'move', label: '移动原子' }]
const TOOL_HELP: Record<string, string> = { bond: '点空白处开始画碳链；点端点延长，点已有键切换单／双／三键。拖动可连接两个原子。', erase: '点原子或化学键删除；删错了可以撤销。', move: '拖动原子调整位置，分子的连接关系不变。', benzene: '点空白处放入苯环，点原子可接上一个苯环。', ring3: '点空白处放入三元环，再用 O 替换一个顶点即可画环氧基。', ring6: '点空白处放入六元环，点原子可接上一个环。' }
const BENZENE_ICON = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 2 8.66 5v10L12 22l-8.66-5V7Z" /><path d="m12.8 5.6 4.34 2.5m0 7.8-4.34 2.5M6.5 14.5v-5" /></svg>

function structureError(error: unknown): string {
  const message = String(error)
  if (message.includes('EMPTY')) return '画布还是空的。点一下空白处画碳链，或选一个环放入。'
  if (/valence|VALENCE/i.test(message)) return '有原子的成键数过多，请检查键型、原子和电荷。'
  return '这个结构暂时无法识别，请检查原子和化学键后再保存。'
}

function nearestAtom(graph: EditorGraph, point: Point, exclude = -1): number {
  let result = -1
  let distance = 19
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
  const [error, setError] = useState('')
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<{ from: Point; to: Point } | null>(null)
  const [drawingSize, setDrawingSize] = useState({ width: 640, height: 360 })
  const dialogRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const closeRef = useRef(onClose)
  const undoRef = useRef(() => {})
  const redoRef = useRef(() => {})
  const gestureRef = useRef<{ point: Point; atom: number; bond: number; moved: boolean; pointer: number } | null>(null)
  const titleId = useId()
  const helpId = useId()
  const importId = useId()
  const errorId = useId()
  const aspect = drawingSize.width / drawingSize.height
  const halfWidth = Math.max(0, ...graph.atoms.map(atom => Math.abs(atom.x - 320)))
  const halfHeight = Math.max(0, ...graph.atoms.map(atom => Math.abs(atom.y - 180)))
  const viewWidth = Math.max(drawingSize.width, halfWidth * 2 + 80, (halfHeight * 2 + 80) * aspect)
  const viewHeight = viewWidth / aspect
  const labelScale = viewWidth / drawingSize.width
  const viewBox = `${320 - viewWidth / 2} ${180 - viewHeight / 2} ${viewWidth} ${viewHeight}`

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

  useEffect(() => { closeRef.current = onClose; undoRef.current = undo; redoRef.current = redo })

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.querySelector<HTMLButtonElement>('.structure-editor-close')?.focus()
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
    const observer = new ResizeObserver(entries => setDrawingSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }))
    if (svgRef.current) observer.observe(svgRef.current)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', keydown, true)
      document.body.style.overflow = previousOverflow
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [])

  function eventPoint(event: PointerEvent<SVGSVGElement>): Point {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return { x: 320, y: 180 }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: Math.max(20, Math.min(620, point.x)), y: Math.max(24, Math.min(336, point.y)) }
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
    try { commit(layoutEditorGraph(next)) } catch (cause) { setError(structureError(cause)) }
  }

  function tap(point: Point, atom: number, bond: number) {
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
      commit({ ...graph, bonds: graph.bonds.map((current, index) => index === bond ? { ...current, order: current.order >= 3 ? 1 : current.order + 1 } : current) })
    } else if (atom >= 0) {
      const nextPoint = getEditorExtensionPoint(graph, atom)
      const next = { ...graph, atoms: [...graph.atoms, { ...nextPoint, element: 'C', charge: 0 }] }
      commit(addEditorBond(next, atom, next.atoms.length - 1))
    } else {
      const start = { x: Math.min(point.x, 570), y: Math.max(55, point.y) }
      const atoms = [...graph.atoms, { ...start, element: 'C', charge: 0 }, { x: start.x + 38, y: start.y - 22, element: 'C', charge: 0 }]
      commit(addEditorBond({ ...graph, atoms }, atoms.length - 2, atoms.length - 1))
    }
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const target = event.target as Element
    const atom = Number(target.closest('[data-atom]')?.getAttribute('data-atom') ?? -1)
    const bond = Number(target.closest('[data-bond]')?.getAttribute('data-bond') ?? -1)
    const point = atom >= 0 ? graph.atoms[atom] : eventPoint(event)
    gestureRef.current = { point, atom, bond, moved: false, pointer: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointer !== event.pointerId || !['bond', 'move'].includes(tool)) return
    const point = eventPoint(event)
    if (Math.hypot(point.x - gesture.point.x, point.y - gesture.point.y) > 8) gesture.moved = true
    if (gesture.moved && tool === 'bond') setPreview({ from: gesture.point, to: point })
    else if (gesture.moved && gesture.atom >= 0) setPreview({ from: point, to: point })
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current
    gestureRef.current = null
    setPreview(null)
    if (!gesture || gesture.pointer !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!gesture.moved) { tap(gesture.point, gesture.atom, gesture.bond); return }
    const point = eventPoint(event)
    if (tool === 'move' && gesture.atom >= 0) {
      commit({ ...graph, atoms: graph.atoms.map((atom, index) => index === gesture.atom ? { ...atom, ...point } : atom) })
      return
    }
    if (tool !== 'bond') return
    const atoms = [...graph.atoms]
    const from = gesture.atom >= 0 ? gesture.atom : atoms.push({ ...gesture.point, element: 'C', charge: 0 }) - 1
    let to = nearestAtom(graph, point, from)
    if (to < 0) {
      const angle = Math.round(Math.atan2(point.y - gesture.point.y, point.x - gesture.point.x) / (Math.PI / 6)) * Math.PI / 6
      const length = Math.max(44, Math.min(88, Math.hypot(point.x - gesture.point.x, point.y - gesture.point.y)))
      to = atoms.push({ x: Math.max(20, Math.min(620, gesture.point.x + Math.cos(angle) * length)), y: Math.max(24, Math.min(336, gesture.point.y + Math.sin(angle) * length)), element: 'C', charge: 0 }) - 1
    }
    commit(addEditorBond({ ...graph, atoms }, from, to))
  }

  function importStructure() {
    try {
      const next = parseEditorSmiles(importText.trim())
      serializeEditorGraph(next)
      commit(next)
      setImportText('')
    } catch (cause) { setError(structureError(cause)) }
  }

  return createPortal(<div className="structure-editor-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="structure-editor-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={helpId} ref={dialogRef} tabIndex={-1}>
      <header className="structure-editor-header"><div className="structure-editor-title-icon"><PencilRuler size={21} strokeWidth={1.5} /></div><div><span>简易分子画板</span><h2 id={titleId}>{title}</h2></div><button className="structure-editor-close" aria-label="关闭分子绘图" onClick={onClose}><X size={21} /></button></header>
      <div className="simple-editor-toolbar" role="group" aria-label="分子绘图工具">{MAIN_TOOLS.map(item => <button key={item.value} type="button" aria-pressed={tool === item.value} className={tool === item.value ? 'selected' : ''} onClick={() => setTool(item.value)}>{item.value === 'bond' ? <PencilLine size={16} /> : item.value === 'benzene' ? BENZENE_ICON : item.value === 'erase' ? <Eraser size={16} /> : null}{item.label}</button>)}<select aria-label="更多原子和环工具" value={MORE_TOOLS.some(item => item.value === tool) ? tool : ''} onChange={event => setTool(event.target.value as Tool)}><option value="" disabled>更多…</option>{MORE_TOOLS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
      <p className="simple-editor-instruction" id={helpId}>{TOOL_HELP[tool] ?? `点已有原子替换成 ${tool}，也可点空白处放入，再用“画键”连接。`}</p>
      <div className="structure-editor-canvas-frame"><svg ref={svgRef} className={`simple-molecule-canvas tool-${tool}`} viewBox={viewBox} role="group" aria-label="键线式分子绘图画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gestureRef.current = null; setPreview(null) }}>
        {!graph.atoms.length ? <g className="simple-canvas-empty" pointerEvents="none"><PencilLine x="302" y="132" width="36" height="36" strokeWidth="1.2" /><text x="320" y="203" textAnchor="middle" fontSize={15 * labelScale}>点一下这里，开始画碳链</text></g> : null}
        {graph.bonds.map((bond, index) => {
          const from = graph.atoms[bond.from]
          const to = graph.atoms[bond.to]
          return <g key={index} data-bond={index} role="button" tabIndex={0} aria-label={`化学键 ${index + 1}：${bond.order === 2 ? '双键' : bond.order === 3 ? '三键' : '单键'}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tap({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, -1, index) } }} className="simple-editor-bond"><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={18 * labelScale} />{getEditorBondLines(graph, index).map((line, lineIndex) => <line key={lineIndex} {...line} className="visible-bond" vectorEffect="non-scaling-stroke" />)}</g>
        })}
        {graph.atoms.map((atom, index) => {
          const label = atomLabel(atom, index, graph)
          return <g key={index} data-atom={index} role="button" tabIndex={0} aria-label={`原子 ${index + 1} ${atom.element}${label.charge}`} className={`simple-editor-atom element-${atom.element}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tap(atom, index, -1) } }}><circle cx={atom.x} cy={atom.y} r={13 * labelScale} fill="transparent" className="atom-touch-target" />{label.text ? <><rect x={atom.x - (label.hydrogens ? 15 : 9) * labelScale} y={atom.y - 10 * labelScale} width={(label.hydrogens ? 30 : 18) * labelScale} height={20 * labelScale} fill="white" pointerEvents="none" /><text x={atom.x} y={atom.y} textAnchor="middle" dominantBaseline="central" fontSize={17 * labelScale} pointerEvents="none">{label.text}{label.hydrogens ? <tspan>H{label.hydrogens > 1 ? <tspan baselineShift="sub" fontSize=".65em">{label.hydrogens}</tspan> : null}</tspan> : null}{label.charge ? <tspan baselineShift="super" fontSize=".65em">{label.charge}</tspan> : null}</text></> : <circle cx={atom.x} cy={atom.y} r="3.2" className="carbon-handle" pointerEvents="none" />}</g>
        })}
        {preview ? <line x1={preview.from.x} y1={preview.from.y} x2={preview.to.x} y2={preview.to.y} className="bond-preview" vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null}
        {tool === 'move' && preview ? <Move x={preview.to.x - 10} y={preview.to.y - 10} width="20" height="20" pointerEvents="none" /> : null}
      </svg></div>
      <div className="simple-editor-bottom-tools"><div><button aria-label="撤销一步" title="撤销（⌘/Ctrl Z）" disabled={!history.past.length} onClick={undo}><Undo2 size={17} /><span>撤销</span></button><button aria-label="重做一步" disabled={!history.future.length} onClick={redo}><Redo2 size={17} /><span>重做</span></button><button onClick={() => { try { commit(layoutEditorGraph(graph)) } catch (cause) { setError(structureError(cause)) } }} disabled={!graph.atoms.length}><Sparkles size={16} />整理结构</button></div><span aria-live="polite">{graph.atoms.length ? `${graph.atoms.length} 个原子` : '空白画布'}</span></div>
      <p className="simple-editor-stereo-note"><Check size={13} />只看连接与键型，无需画楔线或区分 E/Z。</p>
      <details className="structure-editor-advanced"><summary>高级选项：导入 SMILES（可选）<ChevronDown size={15} /></summary><div className="structure-editor-import"><label htmlFor={importId}>SMILES 结构字符串</label><div><input id={importId} value={importText} onChange={event => setImportText(event.target.value)} placeholder="例如：CCO" autoComplete="off" spellCheck={false} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); importStructure() } }} /><button type="button" onClick={importStructure}><ArrowDownToLine size={15} />导入画布</button></div></div></details>
      {error ? <p className="structure-editor-error" id={errorId} role="alert">{error}</p> : null}
      <footer className="structure-editor-footer"><button className="structure-editor-clear" onClick={() => commit(EMPTY_GRAPH)} disabled={!graph.atoms.length}><Eraser size={16} />清空画布</button><div><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" onClick={() => { try { onSave(serializeEditorGraph(graph)) } catch (cause) { setError(structureError(cause)) } }} aria-describedby={error ? errorId : undefined}><Check size={16} />保存结构</button></div></footer>
    </div>
  </div>, document.body)
}
