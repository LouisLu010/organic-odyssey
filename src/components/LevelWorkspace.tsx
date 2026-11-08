import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, ExternalLink, FileText, Flag, Lightbulb, NotebookPen, RotateCcw, Sparkles, Star, Trophy } from 'lucide-react'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Game } from '../hooks/useGame'
import { assessRoute, createLevelProgress } from '../lib/game'
import type { Assessment, Level } from '../types'
import { Stars } from './Explore'
import { Molecule } from './Molecule'
import { ReferenceFlow, SynthesisFlow } from './SynthesisFlow'
import '../styles/mobile-workspace.css'

function SourceDisclosure({ level }: { level: Level }) {
  return <details className="source-disclosure"><summary><FileText size={14} />题目出处与改编说明<ChevronDown size={14} /></summary><div><strong>{level.source.title}</strong><p>{level.source.question}</p><p>{level.source.adaptation}</p><a href={level.source.url} target="_blank" rel="noreferrer">查看公开原卷<ExternalLink size={12} /></a></div></details>
}

function Warmup({ level, game }: { level: Level; game: Game }) {
  const answer = game.progress.levels[level.id]?.warmupAnswer
  return <section className="warmup-panel"><div className="panel-title"><Sparkles size={17} /><h3>热身思考</h3><span>选做</span></div><p>{level.warmup.question}</p><div className="warmup-options" role="group" aria-label="热身题选项">{level.warmup.options.map((option, index) => <button key={option} className={`${answer === index ? 'selected' : ''} ${answer !== undefined && index === level.warmup.correct ? 'correct' : ''}`} aria-pressed={answer === index} onClick={() => game.updateLevel(level, previous => ({ ...previous, warmupAnswer: index }))}><span>{String.fromCharCode(65 + index)}</span>{option}{answer === index ? <Check size={12} /> : null}</button>)}</div>{answer !== undefined ? <div className={`warmup-feedback ${answer === level.warmup.correct ? 'correct' : ''}`} role="status"><strong>{answer === level.warmup.correct ? '线索找对了。' : '再想一想这个变化。'}</strong><p>{level.warmup.explanation}</p></div> : <span className="warmup-note">不影响通关，先想一想也许会有新发现。</span>}</section>
}

function ResearchAssistant({ level, game }: { level: Level; game: Game }) {
  const current = game.progress.levels[level.id] ?? createLevelProgress(level)
  return <section className="assistant-panel"><div className="panel-title"><Lightbulb size={18} /><h3>研究助手</h3></div><p className="assistant-intro">卡住很正常。先观察，再倒着想。</p><div className="hint-list">{level.hints.map((hint, index) => <div className={`hint-item ${index < current.hintsUsed ? 'unlocked' : ''}`} key={hint}><span className="hint-number">0{index + 1}</span><div><strong>{['寻找断键的线索', '走近关键的转化', '把思路连成路线'][index] ?? '进一步思考'}</strong>{index < current.hintsUsed ? <p>{hint}</p> : <span>等待你发现</span>}</div>{index >= current.hintsUsed ? <CircleHelp size={13} /> : null}</div>)}</div><button className="button secondary hint-button" disabled={current.hintsUsed >= level.hints.length} onClick={() => game.updateLevel(level, previous => ({ ...previous, hintsUsed: Math.min(previous.hintsUsed + 1, level.hints.length) }))}>{current.hintsUsed >= level.hints.length ? '所有线索都已展开' : '解锁下一条提示'}<Lightbulb size={14} /></button><p className="hint-rating"><Star size={11} />独立完成 3 星 · 使用提示 2 星 · 学习解析后完成 1 星</p></section>
}

function Explanation({ level, onPractice }: { level: Level; onPractice: () => void }) {
  return <div className="explanation-content"><div className="reference-heading"><BookOpen size={16} /><h3>完整合成路线</h3><span>沿箭头，逐步查看</span></div><ReferenceFlow level={level} /><section className="retrosynthesis"><div className="panel-title"><Flag size={17} /><h3>先从目标倒着想</h3></div><p>{level.retrosynthesis}</p></section><div className="explanation-steps">{level.steps.map((step, index) => <section className="explanation-step" key={index}><span className="step-number">{index + 1}</span><div><h3>第 {index + 1} 步<span className="chem">{step.product}</span></h3><div className="explanation-reaction"><Molecule smiles={index === 0 ? level.startSmiles : level.steps[index - 1].smiles} label={index === 0 ? level.start : level.steps[index - 1].product} compact /><div className="mini-reaction-arrow"><span>{step.reagents}</span><ArrowRight size={64} strokeWidth={1.1} /><span>{step.conditions}</span></div><Molecule smiles={step.smiles} label={step.product} compact /></div><p>{step.explanation}</p><div className="pitfall"><CircleHelp size={14} /><span>{step.pitfall}</span></div></div></section>)}</div><section className="explanation-overall"><h3>把每一步放回整条路线</h3><p>{level.overall}</p><h4>其他路线与边界</h4><ul>{level.alternatives.map(alternative => <li key={alternative}>{alternative}</li>)}</ul></section><button className="button secondary" onClick={onPractice}><NotebookPen size={15} />回到画布，试着独立重建路线</button></div>
}

export default function LevelWorkspace({ level, game, onBack, onNext }: { level: Level; game: Game; onBack: () => void; onNext?: () => void }) {
  const [tab, setTab] = useState<'answer' | 'explanation'>('answer')
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [resetPrompt, setResetPrompt] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [explanationPrompt, setExplanationPrompt] = useState(false)
  const [taskExpanded, setTaskExpanded] = useState(false)
  const feedbackRef = useRef<HTMLDivElement>(null)
  const informationRef = useRef<HTMLDetailsElement>(null)
  const canvasRef = useRef<HTMLElement>(null)
  const current = game.progress.levels[level.id] ?? createLevelProgress(level)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = assessRoute(level, current.answers, current.hintsUsed, current.explanationViewed)
    setAssessment(result)
    game.submit(level, result)
    requestAnimationFrame(() => feedbackRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }))
  }

  function openExplanation() {
    if (current.completed || current.explanationViewed) { setTab('explanation'); return }
    setExplanationPrompt(true)
  }

  return <div className="level-workspace page-enter">
    <div className="level-back-row"><button className="text-button" onClick={onBack}><ArrowLeft size={15} />返回合成地图</button><div><span className="level-code">LEVEL {String(level.number).padStart(2, '0')}</span><Stars count={current.stars} /></div></div>
    <div className="level-page-heading"><div className="page-heading"><h1>{level.title}</h1><p>{level.subtitle}</p></div><div className="level-heading-meta"><span className="tag">{level.difficulty === 5 ? '进阶挑战' : '推理挑战'}</span><span>{level.minutes} 分钟</span></div></div>
    <div className="source-line"><FileText size={13} /><span>{level.source.year} · {level.source.kind === '高考' ? '高考改编' : '模拟精选'} · {level.source.question}</span><span className="source-line-divider" />{level.tags.map(tag => <span className="source-tag" key={tag}>{tag}</span>)}</div>
    <div className="play-layout"><div className="play-main">
      <section className={`task-panel compact-task-panel ${taskExpanded ? 'task-expanded' : ''}`}><div><div className="panel-title"><FlaskIcon /><h2>合成任务</h2><span className="task-required">键线式路线 · 必做</span></div><p className="task-text" id={`task-${level.id}`}>{level.task}</p><div className="mobile-task-actions"><button type="button" aria-expanded={taskExpanded} aria-controls={`task-${level.id}`} onClick={() => setTaskExpanded(value => !value)}>{taskExpanded ? '收起题目' : '展开题目'}<ChevronDown size={14} /></button><button type="button" onClick={() => { if (informationRef.current) { informationRef.current.open = true; informationRef.current.scrollIntoView({ block: 'start' }) } }}><BookOpen size={14} />已知信息</button></div></div><div className="target-structure"><span>目标结构</span><Molecule smiles={level.smiles} label={level.target} compact /></div></section>
      <section className="editor-panel" ref={canvasRef}><div className="editor-tabs" role="tablist" aria-label="作答与解析"><button role="tab" aria-selected={tab === 'answer'} className={tab === 'answer' ? 'selected' : ''} onClick={() => setTab('answer')}><NotebookPen size={15} />作答画布</button><button role="tab" aria-selected={tab === 'explanation'} className={tab === 'explanation' ? 'selected' : ''} onClick={openExplanation}><BookOpen size={15} />合成解析</button><button className="reset-button" onClick={() => setResetPrompt(true)} aria-label="重新填写本关路线"><RotateCcw size={13} />重新绘制</button></div>
        {explanationPrompt ? <div className="inline-confirm" role="alert"><BookOpen size={19} /><div><strong>要展开这份合成思路吗？</strong><p>现在查看将记为学习模式，本次完成可获得 1 星。你也可以继续尝试或先看提示。</p><div><button className="button secondary" onClick={() => { game.updateLevel(level, previous => ({ ...previous, explanationViewed: true })); setTab('explanation'); setExplanationPrompt(false) }}>展开解析，边学边练</button><button className="button ghost" onClick={() => setExplanationPrompt(false)}>继续独立思考</button></div></div></div> : null}
        {resetPrompt ? <div className="inline-confirm" role="alert"><RotateCcw size={18} /><div><strong>清空本关作答草稿？</strong><p>已获得的通关记录和星级会保留，使用提示与解析的记录也会保留。</p><div><button className="button secondary" onClick={() => { game.resetLevel(level); setAssessment(null); setResetPrompt(false) }}>清空草稿</button><button className="button ghost" onClick={() => setResetPrompt(false)}>取消</button></div></div></div> : null}
        {tab === 'answer' ? <SynthesisFlow level={level} game={game} assessment={assessment} onSubmit={submit} onEdit={() => setAssessment(null)} /> : <Explanation level={level} onPractice={() => setTab('answer')} />}
      </section>
      {assessment ? <div ref={feedbackRef} className={`assessment-result ${assessment.complete ? 'success' : ''}`} role="status" aria-live="polite"><div className="assessment-icon">{assessment.complete ? <Trophy size={26} /> : <Lightbulb size={24} />}</div><div><h3>{assessment.complete ? '合成成功，思路已经连起来了！' : '离完整路线，又近了一步'}</h3><p>{assessment.complete ? '所有预设关键点已匹配。看看每一步为什么成立，或继续挑战下一关。' : '回到各步查看结构、试剂和条件的匹配反馈；未识别的等效路线可对照解析。'}</p><span className="assessment-score">关键点匹配 <strong>{assessment.score}</strong> / 100 {assessment.complete ? <Stars count={assessment.stars} /> : null}</span><div className="assessment-actions"><button className="button secondary" onClick={openExplanation}>复盘详细解析<BookOpen size={14} /></button>{assessment.complete && onNext ? <button className="button primary" onClick={onNext}>挑战下一关<ArrowRight size={14} /></button> : null}</div></div></div> : null}
      <section className="level-note"><button onClick={() => setShowNote(value => !value)} aria-expanded={showNote}><NotebookPen size={15} /><span>记录这次合成的灵感</span><ChevronRight className={showNote ? 'rotated' : ''} size={15} /></button>{showNote ? <label><span>本关笔记，与「我的笔记」同步保存</span><textarea aria-label="本关学习笔记" value={game.progress.notes[level.id] ?? ''} onChange={event => game.note(level.id, event.target.value)} placeholder="我在哪一步卡住了？这次发现了什么规律？" rows={5} maxLength={20000} /></label> : null}</section>
    </div><aside className="play-support"><details className="information-box support-information" ref={informationRef} open><summary><BookOpen size={14} />已知信息<ChevronDown size={14} /></summary><ol>{level.information.map(info => <li key={info}>{info}</li>)}</ol></details><button type="button" className="mobile-return-to-canvas button secondary" onClick={() => { setTab('answer'); canvasRef.current?.scrollIntoView({ block: 'start' }) }}><NotebookPen size={15} />回到作答画布</button><ResearchAssistant level={level} game={game} /><Warmup level={level} game={game} /><SourceDisclosure level={level} /><div className="support-quote"><span>“</span><p>合成的乐趣，<br />藏在每一个「为什么」里。</p><i>保持好奇，继续推演。</i></div></aside></div>
  </div>
}

function FlaskIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v6l-6 10a1.3 1.3 0 0 0 1.2 2h13.6a1.3 1.3 0 0 0 1.2-2L14 9V3M7 15h10" /></svg> }
