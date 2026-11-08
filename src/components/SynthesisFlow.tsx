import { lazy, Suspense, useState } from 'react'
import { ArrowRight, Check, CheckCircle2, Expand, Maximize2, MousePointer2, Pencil, Plus, RotateCcw, Send, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { FormEvent } from 'react'
import type { Game } from '../hooks/useGame'
import { createLevelProgress, normalizeChemical } from '../lib/game'
import type { AnswerRow, Assessment, Level } from '../types'
import { Molecule } from './Molecule'

const StructureEditor = lazy(() => import('./StructureEditor'))

function answerSmiles(level: Level, index: number, product: string) {
  if (product.startsWith('@smiles:')) return product.slice(8)
  if (!product) return undefined
  const step = level.steps[index]
  return [step.product, ...step.productAliases].some(alias => normalizeChemical(alias) === normalizeChemical(product)) ? step.smiles : undefined
}

function ArrowFields({ index, answer, direction, onChange, assessment }: { index: number; answer: AnswerRow; direction: 'right' | 'left' | 'down'; onChange: (key: keyof AnswerRow, value: string) => void; assessment?: Assessment['steps'][number] }) {
  return <div className={`flow-arrow direction-${direction}`}>
    <label className={assessment ? assessment.reagents ? 'matched' : 'needs-review' : ''}><span className="sr-only">第 {index + 1} 步主要试剂</span><span className="flow-field-label" aria-hidden="true">主要试剂 / 催化剂</span><textarea rows={2} aria-label={`第 ${index + 1} 步主要试剂`} value={answer.reagents} maxLength={600} onChange={event => onChange('reagents', event.target.value)} placeholder="试剂 / 催化剂" spellCheck={false} /></label>
    <span className="flow-arrow-line" aria-hidden="true">{direction === 'down' ? <svg className="flow-direction-desktop" width="24" height="65" viewBox="0 0 24 65" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 2v58m-6-7 6 7 6-7" /></svg> : <svg className="flow-direction-desktop" width="112" height="24" viewBox="0 0 112 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d={direction === 'left' ? 'M109 12H4m7-6-7 6 7 6' : 'M3 12h104m-7-6 7 6-7 6'} /></svg>}<svg className="flow-direction-mobile" width="24" height="100" viewBox="0 0 24 100" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3v90m-6-7 6 7 6-7" /></svg></span>
    <label className={assessment ? assessment.conditions ? 'matched' : 'needs-review' : ''}><span className="sr-only">第 {index + 1} 步反应条件</span><span className="flow-field-label" aria-hidden="true">溶剂 / 反应条件</span><textarea rows={2} aria-label={`第 ${index + 1} 步反应条件`} value={answer.conditions} maxLength={600} onChange={event => onChange('conditions', event.target.value)} placeholder="溶剂 / 条件" spellCheck={false} /></label>
    <span className="arrow-step-label">反应 {index + 1}</span>
  </div>
}

export function SynthesisFlow({ level, game, assessment, onSubmit, onEdit }: { level: Level; game: Game; assessment: Assessment | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onEdit: () => void }) {
  const [editing, setEditing] = useState<number | null>(null)
  const [scale, setScale] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const answers = game.progress.levels[level.id]?.answers ?? createLevelProgress(level).answers
  const completeNodes = answers.filter(answer => answer.product).length

  return <div className={`synthesis-flow-editor ${expanded ? 'canvas-expanded' : ''}`}>
    <div className="canvas-toolbar"><div><span className="canvas-tool active"><MousePointer2 size={14} />合成画布</span><button type="button" className="canvas-tool" onClick={() => setEditing(answers.findIndex(answer => !answer.product) < 0 ? 0 : answers.findIndex(answer => !answer.product))}><Pencil size={14} />绘制分子</button></div><div className="zoom-tools"><button type="button" className="icon-button" aria-label="缩小画布" disabled={scale <= .6} onClick={() => setScale(value => Math.max(.6, Math.round((value - .1) * 10) / 10))}><ZoomOut size={15} /></button><span>{Math.round(scale * 100)}%</span><button type="button" className="icon-button" aria-label="放大画布" disabled={scale >= 1.2} onClick={() => setScale(value => Math.min(1.2, Math.round((value + .1) * 10) / 10))}><ZoomIn size={15} /></button><button type="button" className="icon-button" aria-label="重置画布缩放" onClick={() => setScale(1)}><RotateCcw size={14} /></button><button type="button" className="icon-button" aria-label={expanded ? '退出全屏画布' : '展开画布'} onClick={() => setExpanded(value => !value)}>{expanded ? <X size={16} /> : <Maximize2 size={15} />}</button></div></div>
    <form onSubmit={onSubmit}>
      <div className="flow-scroll"><div className="flow-scale-wrapper" style={{ width: 852 * scale, height: (level.steps.length > 2 ? 500 : 230) * scale }}><div className="flow-grid" style={{ transform: `scale(${scale})` }}>
        <div className="flow-node start-node" style={{ gridColumn: 1, gridRow: 1 }}><span className="flow-node-label">起始原料</span><Molecule smiles={level.startSmiles} label={level.start} compact /><span className="start-node-name">{level.id === 'epoxide-strategy' ? '苯' : 'START'}</span></div>
        {level.steps.map((_, index) => {
          const position = [{ column: 3, row: 1 }, { column: 5, row: 1 }, { column: 5, row: 3 }, { column: 3, row: 3 }][index]
          const arrowPosition = [{ column: 2, row: 1, direction: 'right' }, { column: 4, row: 1, direction: 'right' }, { column: 5, row: 2, direction: 'down' }, { column: 4, row: 3, direction: 'left' }][index] as { column: number; row: number; direction: 'right' | 'left' | 'down' }
          const row = answers[index] ?? { product: '', reagents: '', conditions: '' }
          const smiles = answerSmiles(level, index, row.product)
          const result = assessment?.steps[index]
          return <div className="flow-grid-fragment" key={index}>
            <div style={{ gridColumn: arrowPosition.column, gridRow: arrowPosition.row }} className="flow-arrow-position"><ArrowFields index={index} answer={row} direction={arrowPosition.direction} onChange={(key, value) => { game.answer(level, index, key, value); onEdit() }} assessment={result} /></div>
            <button type="button" className={`flow-node editable-node ${smiles ? 'has-structure' : ''} ${result?.product ? 'structure-matched' : ''} ${result && !result.product ? 'structure-review' : ''}`} style={{ gridColumn: position.column, gridRow: position.row }} onClick={() => setEditing(index)} aria-label={`绘制第 ${index + 1} 步${index === level.steps.length - 1 ? '目标产物' : '中间体'}结构`}><span className="flow-node-label">{index === level.steps.length - 1 ? '目标产物' : `中间体 ${String.fromCharCode(65 + index)}`}{result?.product ? <Check size={12} /> : null}</span>{smiles ? <><Molecule smiles={smiles} label={`第 ${index + 1} 步所绘结构`} compact /><span className="node-edit-affordance"><Pencil size={10} />编辑结构</span></> : <span className="empty-structure"><span><Pencil size={21} strokeWidth={1.3} /><Plus size={10} /></span><strong>点击绘制结构</strong><small>{String.fromCharCode(65 + index)}</small></span>}</button>
          </div>
        })}
        {level.steps.length > 2 ? <div className="flow-canvas-note" style={{ gridColumn: '1 / 3', gridRow: 3 }}><span className="canvas-legend"><span className="legend-swatch" />已绘制 {completeNodes} / {level.steps.length} 个产物</span><p>在节点中画出键线式，<br />在箭头上下补全试剂与条件。</p><span>沿箭头方向，逐步推演。</span></div> : null}
      </div></div></div>
      <div className="canvas-footer"><button className="button primary" type="submit"><Send size={14} />验证合成路线</button><span><CheckCircle2 size={12} />结构与条件自动保存</span><span className="canvas-pan-note"><Expand size={12} />小屏幕可左右滑动</span></div>
    </form>
    {assessment ? <div className="flow-assessment-breakdown">{assessment.steps.map((step, index) => <details key={index} className={step.status}><summary><span>{step.status === 'correct' ? <CheckCircle2 size={14} /> : <span className="review-dot" />}</span>反应 {index + 1}<span>{step.status === 'correct' ? '关键点已匹配' : '还有关键点待核查'}</span></summary><p>{step.feedback}</p><div><span className={step.product ? 'is-correct' : ''}>产物 {step.product ? '✓' : '待复核'}</span><span className={step.reagents ? 'is-correct' : ''}>试剂 {step.reagents ? '✓' : '待复核'}</span><span className={step.conditions ? 'is-correct' : ''}>条件 {step.conditions ? '✓' : '待复核'}</span></div></details>)}</div> : null}
    <p className="assessment-notice">结构按连接关系、官能团和键级匹配，忽略手性与双键 E/Z；旋转、画法和原子编号不影响结果。试剂与条件按关键点评估，未匹配的等效路线可对照解析复核。</p>
    {editing !== null ? <Suspense fallback={<div className="editor-loading" role="status">正在准备分子画板…</div>}><StructureEditor title={`绘制${editing === level.steps.length - 1 ? '目标产物' : `中间体 ${String.fromCharCode(65 + editing)}`}`} initialSmiles={answerSmiles(level, editing, answers[editing]?.product ?? '') ?? (editing === 0 ? level.startSmiles : answerSmiles(level, editing - 1, answers[editing - 1]?.product ?? ''))} onSave={smiles => { game.answer(level, editing, 'product', `@smiles:${smiles}`); setEditing(null); onEdit() }} onClose={() => setEditing(null)} /></Suspense> : null}
  </div>
}

export function ReferenceFlow({ level }: { level: Level }) {
  return <div className="reference-flow-scroll"><div className="reference-flow"><div className="reference-node"><Molecule smiles={level.startSmiles} label={level.start} compact /><span>起始原料</span></div>{level.steps.map((step, index) => <div className="reference-pair" key={index}><div className="reference-arrow"><span>{step.reagents}</span><ArrowRight size={70} strokeWidth={1.2} /><span>{step.conditions}</span></div><div className="reference-node"><Molecule smiles={step.smiles} label={step.product} compact /><span>{index === level.steps.length - 1 ? '目标产物' : `中间体 ${String.fromCharCode(65 + index)}`}</span></div></div>)}</div></div>
}
