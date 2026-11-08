import { ArrowRight, Check, ChevronDown, Clock3, FileText, Search, Sparkles, Star } from 'lucide-react'
import { useState } from 'react'
import type { GameProgress, Level } from '../types'
import { Molecule } from './Molecule'

const filters = ['全部关卡', '2026', '2025', '2024', '高考改编', '模拟精选']

export function Stars({ count = 0 }: { count?: number }) {
  return <span className="stars" aria-label={`${count} 颗星，共 3 颗`}>{[1, 2, 3].map(star => <Star key={star} size={15} strokeWidth={1.5} className={star <= count ? 'earned' : ''} fill={star <= count ? 'currentColor' : 'none'} />)}</span>
}

function LevelCard({ level, progress, onStart }: { level: Level; progress: GameProgress; onStart: (level: Level) => void }) {
  const current = progress.levels[level.id]
  return <article className={`level-card tone-${level.color}`}>
    <div className="level-visual"><Molecule smiles={level.smiles} label={level.target} compact /><span className="visual-corner" aria-hidden="true">{String(level.number).padStart(2, '0')}</span><span className="molecule-caption">{level.tags[0]}</span></div>
    <div className="level-card-content">
      <div className="level-card-top"><span className="level-number">LEVEL {String(level.number).padStart(2, '0')}</span><Stars count={current?.stars} /></div>
      <h3>{level.title}</h3>
      <p className="card-subtitle">{level.subtitle}</p>
      <div className="level-source"><FileText size={13} /><span>{level.source.year} · {level.source.title.replace(/20\d{2} 年?|20\d{2} 届|2025—2026 学年度下期|高 2026 届/g, '').replace(/第.*题/, '').trim()}</span></div>
      <div className="card-divider" />
      <div className="card-meta"><span className="difficulty">难度 <span className="difficulty-dots" aria-label={`难度 ${level.difficulty}，满级 5`}>{[1, 2, 3, 4, 5].map(dot => <i key={dot} className={dot <= level.difficulty ? 'filled' : ''} />)}</span></span><span><Clock3 size={12} />{level.minutes} 分钟</span></div>
      <button className={`card-button ${current?.completed ? 'completed' : ''}`} onClick={() => onStart(level)}>{current?.completed ? <><Check size={15} />再次挑战</> : current ? '继续挑战' : '开始挑战'}<ArrowRight size={15} /></button>
    </div>
  </article>
}

export function Explore({ levels, progress, onStart }: { levels: Level[]; progress: GameProgress; onStart: (level: Level) => void }) {
  const [filter, setFilter] = useState('全部关卡')
  const [search, setSearch] = useState('')
  const [chapter, setChapter] = useState('all')
  const completed = levels.filter(level => progress.levels[level.id]?.completed).length
  const suggested = levels.find(level => level.id === progress.lastLevel && !progress.levels[level.id]?.completed) ?? levels.find(level => !progress.levels[level.id]?.completed) ?? levels[0]
  const visible = levels.filter(level => {
    const matchesFilter = filter === '全部关卡' || String(level.source.year) === filter || (filter === '高考改编' && level.source.kind === '高考') || (filter === '模拟精选' && level.source.kind === '模拟')
    const matchesSearch = `${level.title}${level.subtitle}${level.tags.join('')}${level.source.title}`.toLowerCase().includes(search.trim().toLowerCase())
    return matchesFilter && matchesSearch && (chapter === 'all' || level.chapter === chapter)
  })

  return <div className="explore-page page-enter">
    <div className="page-heading"><h1>探索合成的无限可能</h1><p>从一道真题开始，成为有机合成的解谜者。</p></div>
    <section className="explore-hero" aria-label="开启合成之旅">
      <img src={`${import.meta.env.BASE_URL}assets/molecular-hero.webp`} alt="淡紫色玻璃与银色键连接的装饰分子雕塑" className="hero-art" width="1536" height="1024" />
      <div className="hero-copy"><h2>把线索，连成答案。</h2><p>每一步都有依据，每条路线都有可能。<br />在书写与推理中，找到属于你的合成路线。</p><button className="button primary" onClick={() => onStart(suggested)}>{progress.lastLevel ? '继续合成之旅' : '开启合成之旅'}<ArrowRight size={17} /></button></div>
      <span className="hero-small-note">思考 · 推演 · 合成</span>
    </section>
    <section className="synthesis-map" aria-labelledby="map-heading">
      <div className="section-heading"><div><h2 id="map-heading">你的合成地图<span className="heading-dot" /></h2><p>由浅入深，让每一次成键都有迹可循。</p></div><div className="map-progress"><span><strong>{completed}</strong> / {levels.length} 关已完成</span><div className="progress-track"><span style={{ width: `${completed / Math.max(1, levels.length) * 100}%` }} /></div></div></div>
      <div className="map-tools"><div className="filter-tabs" aria-label="题源筛选">{filters.map(item => <button key={item} className={filter === item ? 'selected' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="map-search"><Search size={15} /><input aria-label="搜索关卡" placeholder="搜索关卡、考点" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      <div className="map-caption"><span><Sparkles size={13} />每关必做合成路线 · 前置推理自由挑战</span><div className="chapter-select"><select aria-label="按训练阶段筛选" value={chapter} onChange={event => setChapter(event.target.value)}><option value="all">全部训练阶段</option><option value="chain">碳链构建</option><option value="functional">官能团转化</option><option value="strategy">合成策略</option></select><ChevronDown size={13} /></div></div>
      {visible.length ? <div className="level-grid">{visible.map(level => <LevelCard key={level.id} level={level} progress={progress} onStart={onStart} />)}</div> : <div className="empty-state"><Search size={30} /><h3>还没有匹配的合成任务</h3><p>换一个年份、考点或训练阶段试试。</p><button className="button secondary" onClick={() => { setFilter('全部关卡'); setChapter('all'); setSearch('') }}>查看全部关卡</button></div>}
      <p className="source-note"><FileText size={14} />题源均附原卷链接。关卡经过教学改编，新增步骤与信息反应会在题内明确说明。</p>
    </section>
  </div>
}
