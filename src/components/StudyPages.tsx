import { useId, useState } from 'react'
import { ArrowRight, Award, BookOpen, Check, ChevronDown, Download, Feather, FlaskConical, Lightbulb, Search, Sparkles, Star, Target, Trophy } from 'lucide-react'
import { reactions } from '../data/reactions'
import type { Reaction } from '../data/reactions'
import type { Game } from '../hooks/useGame'
import { formatStudyDate } from '../lib/game'
import type { Chapter, Level } from '../types'
import { Molecule } from './Molecule'
import '../styles/study.css'

interface StudyProps {
  levels: Level[]
  onStart: (level: Level) => void
}

interface ProgressStudyProps extends StudyProps {
  game: Game
}

const CATEGORIES = ['全部反应', '构建碳链', '官能团转化', '选择性与保护'] as const
const CHAPTERS: { id: Chapter; name: string; description: string }[] = [
  { id: 'chain', name: '碳链启程', description: '找到构建碳骨架的那根关键键。' },
  { id: 'functional', name: '官能团迷宫', description: '让每一步转化都指向目标。' },
  { id: 'strategy', name: '合成终局', description: '在选择性与路线优化中做出判断。' },
]

function relatedLevel(reaction: Reaction, levels: Level[]) {
  return levels.find(level => {
    const content = `${level.title} ${level.subtitle} ${level.tags.join(' ')} ${level.information.join(' ')} ${level.steps.map(step => `${step.product} ${step.reagents} ${step.explanation}`).join(' ')}`
    return reaction.keywords.some(keyword => content.includes(keyword))
  })
}

function ReactionEntry({ reaction, level, onStart }: { reaction: Reaction; level?: Level; onStart: StudyProps['onStart'] }) {
  return (
    <article className="reaction-entry">
      <div className="reaction-entry-title">
        <div>
          <span className="reaction-english">{reaction.english}</span>
          <h2>{reaction.name}</h2>
        </div>
        <span className="study-category">{reaction.category}</span>
      </div>
      <div className="reaction-example-label">代表例 · {reaction.exampleLabels[0]}转化为{reaction.exampleLabels[1]}</div>
      <div className="reaction-structure-flow" role="group" aria-label={`${reaction.exampleLabels[0]}经${reaction.arrowReagents}，${reaction.arrowConditions}生成${reaction.exampleLabels[1]}`}>
        <div className="reaction-molecule-node">
          {reaction.reactantCoefficient ? <span className="reaction-coefficient" aria-label={`${reaction.reactantCoefficient} 分子`}>{reaction.reactantCoefficient}</span> : null}
          <Molecule smiles={reaction.exampleSmiles[0]} label={reaction.exampleLabels[0]} compact />
          <span className="reaction-molecule-name">{reaction.exampleLabels[0]}</span>
        </div>
        <div className="reaction-arrow-labels">
          <span className="reaction-arrow-reagents">{reaction.arrowReagents}</span>
          <svg className="reaction-flow-arrow" viewBox="0 0 100 20" preserveAspectRatio="none" fill="none" aria-hidden="true"><path d="M2 10H96M89 5L97 10L89 15" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="reaction-arrow-conditions">{reaction.arrowConditions}</span>
        </div>
        <div className="reaction-molecule-node">
          <Molecule smiles={reaction.exampleSmiles[1]} label={reaction.exampleLabels[1]} compact />
          <span className="reaction-molecule-name">{reaction.exampleLabels[1]}</span>
        </div>
      </div>
      <details className="reaction-explanation">
        <summary>原理、条件与易错点 <ChevronDown size={15} /></summary>
        <dl className="reaction-details">
          <div><dt>反应条件</dt><dd>{reaction.conditions}</dd></div>
          <div><dt>为什么这样做</dt><dd>{reaction.principle}</dd></div>
          <div className="reaction-pitfall"><dt><Lightbulb size={15} /> 易错提醒</dt><dd>{reaction.pitfall}</dd></div>
          <div><dt>通式对照</dt><dd className="reaction-general-formula">{reaction.formula}</dd></div>
        </dl>
        {reaction.reference ? <a className="reaction-reference" href={reaction.reference.url} target="_blank" rel="noreferrer">教材参考：{reaction.reference.title}</a> : null}
      </details>
      <div className="reaction-entry-bottom">
        <span className={`reaction-scope ${reaction.knownInformation ? 'information' : ''}`}>
          {reaction.knownInformation ? '信息反应 · 作答时以题设为准' : '课内反应 · 注意适用条件'}
        </span>
        {level ? <button className="study-text-button" onClick={() => onStart(level)}>关联挑战 {String(level.number).padStart(2, '0')} <ArrowRight size={15} /></button> : null}
      </div>
    </article>
  )
}

export function AtlasPage({ levels, onStart }: StudyProps) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('全部反应')
  const [search, setSearch] = useState('')
  const searchId = useId()
  const query = search.trim().toLocaleLowerCase()
  const filtered = reactions.filter(reaction =>
    (category === '全部反应' || reaction.category === category)
    && (!query || `${reaction.name} ${reaction.english} ${reaction.formula} ${reaction.keywords.join(' ')}`.toLocaleLowerCase().includes(query)),
  )

  return (
    <div className="study-page atlas-page">
      <div className="page-heading"><h1>理解反应，才能自由合成。</h1><p>把零散的知识，整理成可以调用的合成工具。</p></div>
      <div className="atlas-toolbar">
        <div className="study-filter-group" aria-label="反应类别">
          {CATEGORIES.map(item => <button key={item} aria-pressed={item === category} className={item === category ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <label className="atlas-search" htmlFor={searchId}><Search size={17} /><input id={searchId} value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、试剂或反应式" aria-label="搜索反应图鉴" /></label>
      </div>
      <div className="atlas-count" role="status">找到 {filtered.length} 种反应<span>先读键线式，再沿箭头追踪成键与官能团变化。</span></div>
      {filtered.length ? <div className="reaction-list">{filtered.map(reaction => <ReactionEntry key={reaction.id} reaction={reaction} level={relatedLevel(reaction, levels)} onStart={onStart} />)}</div> : <div className="empty-state study-empty"><Search size={34} /><h2>换一条线索试试</h2><p>可以搜索「水解」「PCC」或「保护」。</p><button className="button secondary" onClick={() => { setSearch(''); setCategory('全部反应') }}>查看全部反应</button></div>}
      <p className="study-footnote">图鉴用于梳理反应思路。涉及超出课内范围的反应，关卡会提供所需信息。</p>
    </div>
  )
}

function exportNotes(levels: Level[], notes: Record<string, string>) {
  const entries = levels.filter(level => notes[level.id]?.trim()).map(level =>
    `## ${String(level.number).padStart(2, '0')} · ${level.title}\n\n${notes[level.id].trim()}\n\n来源：${level.source.title}，${level.source.question}\n`,
  )
  const text = `# 有机漫游 · 我的合成笔记\n\n导出日期：${formatStudyDate(new Date())}\n\n${entries.join('\n---\n\n')}`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `有机漫游-合成笔记-${formatStudyDate(new Date())}.md`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function NotesPage({ levels, game, onStart }: ProgressStudyProps) {
  const [selectedId, setSelectedId] = useState(() => game.progress.lastLevel ?? levels[0]?.id ?? '')
  const [exported, setExported] = useState(false)
  const selected = levels.find(level => level.id === selectedId) ?? levels[0]
  const noteCount = levels.filter(level => game.progress.notes[level.id]?.trim()).length
  const currentNote = selected ? game.progress.notes[selected.id] ?? '' : ''
  const noteId = useId()

  return (
    <div className="study-page notes-page">
      <div className="study-heading-row"><div className="page-heading"><h1>把顿悟，留在纸上。</h1><p>记录走过的弯路，下一次就能更接近答案。</p></div><button className="button secondary" disabled={noteCount === 0} onClick={() => { exportNotes(levels, game.progress.notes); setExported(true) }}><Download size={17} /> 导出笔记</button></div>
      {exported ? <p className="study-inline-notice" role="status"><Check size={16} /> 已生成 Markdown 文件，可在下载目录中查看。</p> : null}
      <div className="notes-workspace">
        <aside className="notes-levels" aria-label="选择笔记所属关卡">
          <div className="notes-list-heading"><BookOpen size={17} /><span>合成手记</span><small>{noteCount} 篇记录</small></div>
          {levels.map(level => <button key={level.id} className={`note-level ${level.id === selected?.id ? 'selected' : ''}`} aria-current={level.id === selected?.id ? 'true' : undefined} onClick={() => setSelectedId(level.id)}><span className="note-level-number">{String(level.number).padStart(2, '0')}</span><span><strong>{level.title}</strong><small>{game.progress.notes[level.id]?.trim() ? `${game.progress.notes[level.id].trim().length} 字 · 已记录` : '等待你的第一条思路'}</small></span>{game.progress.notes[level.id]?.trim() ? <Feather size={15} /> : null}</button>)}
        </aside>
        {selected ? <section className="note-editor" aria-labelledby="note-title"><div className="note-editor-top"><span>关卡 {String(selected.number).padStart(2, '0')}</span><span className={`note-save-status ${game.saved ? '' : 'unsaved'}`} role="status">{game.saved ? <><Check size={13} /> 已保存到本机</> : '当前浏览器无法保存'}</span></div><h2 id="note-title">{selected.title}</h2><p className="note-source">{selected.source.year} · {selected.source.title}</p><div className="note-prompt"><Lightbulb size={18} /><p>从「为什么」开始写：目标物该在哪里断键？哪一步需要保护？这次最容易忽略什么条件？</p></div><label className="note-editor-label" htmlFor={noteId}>我的思考</label><textarea id={noteId} value={currentNote} onChange={event => game.note(selected.id, event.target.value)} placeholder={'写下你的逆合成思路……\n\n我选择这条路线，是因为：\n\n下次需要注意：'} spellCheck={false} /><div className="note-editor-bottom"><span>{currentNote.length} 字</span><button className="study-text-button" onClick={() => onStart(selected)}>回到这道挑战 <ArrowRight size={15} /></button></div></section> : <div className="empty-state study-empty"><Feather size={34} /><h2>笔记本已经准备好</h2><p>关卡加载后，可以在这里记录你的思考。</p></div>}
      </div>
      <p className="study-footnote">笔记保存在当前浏览器中。可以导出 Markdown 文件，继续整理你的反应思路。</p>
    </div>
  )
}

function StudyWeek({ days }: { days: string[] }) {
  const active = new Set(days)
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - index))
    return { key: formatStudyDate(date), label: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()] }
  })
  return <div className="study-week" aria-label="最近 7 天学习记录">{dates.map(({ key, label }) => <div key={key} className={active.has(key) ? 'studied' : ''} title={`${key}${active.has(key) ? ' · 已学习' : ' · 暂无记录'}`}><span>周{label}</span><span className="study-day-dot">{active.has(key) ? <Check size={16} /> : <span />}</span><small>{key.slice(5).replace('-', '/')}</small></div>)}</div>
}

export function ProfilePage({ levels, game, onStart }: ProgressStudyProps) {
  const results = levels.map(level => game.progress.levels[level.id])
  const completed = results.filter(result => result?.completed).length
  const stars = results.reduce((sum, result) => sum + (result?.stars ?? 0), 0)
  const attempts = results.reduce((sum, result) => sum + (result?.attempts ?? 0), 0)
  const next = levels.find(level => !game.progress.levels[level.id]?.completed) ?? levels[0]
  const achievements = [
    { title: '第一根新键', subtitle: '完成任意 1 道合成挑战', earned: completed >= 1, Icon: FlaskConical },
    { title: '独立推理者', subtitle: '任意关卡获得 3 颗星', earned: results.some(result => (result?.stars ?? 0) >= 3), Icon: Sparkles },
    { title: '思考的习惯', subtitle: '在 3 个不同日期开启学习', earned: game.progress.studyDays.length >= 3, Icon: Feather },
    { title: '合成探险家', subtitle: '完成地图中的全部关卡', earned: levels.length > 0 && completed === levels.length, Icon: Trophy },
  ]

  return (
    <div className="study-page profile-page">
      <div className="page-heading"><h1>每一步思考，都有回响。</h1><p>这里记录你在有机合成世界里走过的路。</p></div>
      <div className="profile-summary"><div className="profile-avatar"><FlaskConical size={32} strokeWidth={1.5} /></div><div><h2>{completed === levels.length && levels.length ? '合成探险家' : completed >= 3 ? '进阶研究员' : '有机合成探索者'}</h2><p>{completed ? '答案背后的逻辑，正在变得清晰。' : '第一道挑战，是一切可能的起点。'}</p></div><span className="profile-level">{completed} / {levels.length} 关已完成</span></div>
      <div className="profile-stats"><div><Target size={20} /><strong>{completed}<small> / {levels.length}</small></strong><span>完成关卡</span></div><div><Star size={20} /><strong>{stars}<small> / {levels.length * 3}</small></strong><span>收集星星</span></div><div><FlaskConical size={20} /><strong>{attempts}</strong><span>路线提交</span></div><div><BookOpen size={20} /><strong>{game.progress.studyDays.length}</strong><span>学习天数</span></div></div>
      <div className="profile-middle"><section className="profile-chapters"><div className="section-heading"><h2>你的研究进程</h2><span>3 个章节</span></div>{CHAPTERS.map((chapter, index) => { const chapterLevels = levels.filter(level => level.chapter === chapter.id); const count = chapterLevels.filter(level => game.progress.levels[level.id]?.completed).length; const percent = chapterLevels.length ? Math.round(count / chapterLevels.length * 100) : 0; return <div className="profile-chapter" key={chapter.id}><span className="profile-chapter-number">0{index + 1}</span><div><div className="profile-chapter-label"><strong>{chapter.name}</strong><span>{count} / {chapterLevels.length}</span></div><p>{chapter.description}</p><div className="profile-progress-track" role="progressbar" aria-label={`${chapter.name}完成进度`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div></div></div> })}</section><section className="profile-activity"><div className="section-heading"><h2>让思考保持生长</h2></div><p>最近 7 天，每一个圆点都是一次出发。</p><StudyWeek days={game.progress.studyDays} /><div className="profile-activity-note"><span className="study-legend-dot" /> 开启关卡或提交路线，记录一次学习。</div></section></div>
      <section className="profile-achievements"><div className="section-heading"><h2>属于你的成就</h2><span>{achievements.filter(item => item.earned).length} / {achievements.length} 已解锁</span></div><div className="achievement-list">{achievements.map(({ title, subtitle, earned, Icon }) => <div key={title} className={`achievement ${earned ? 'earned' : ''}`}><div className="achievement-icon"><Icon size={26} strokeWidth={1.5} /></div><div><h3>{title}</h3><p>{subtitle}</p><span>{earned ? <><Check size={12} /> 已解锁</> : '等待解锁'}</span></div></div>)}</div></section>
      {next ? <div className="profile-next"><div className="profile-next-mark"><Award size={28} /></div><div><span>{completed === levels.length ? '重温一次，或许有新的发现' : '下一次发现，已经在等你'}</span><h2>{next.title}</h2></div><button className="button primary" onClick={() => onStart(next)}>{completed === levels.length ? '再次挑战' : '继续探索'}<ArrowRight size={17} /></button></div> : null}
    </div>
  )
}
