import { ArrowRight, BookOpen, ChartNoAxesCombined, Compass, FlaskConical, Hexagon, Menu, NotebookPen, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Page } from '../types'

const navigation = [
  { id: 'explore', name: '合成探险', icon: Compass },
  { id: 'atlas', name: '反应图鉴', icon: BookOpen },
  { id: 'notes', name: '我的笔记', icon: NotebookPen },
  { id: 'profile', name: '学习档案', icon: ChartNoAxesCombined },
] as const

function Brand() {
  return <div className="brand"><div className="brand-mark" aria-hidden="true"><Hexagon /><span /><span /><span /></div><strong>有机漫游</strong><span className="brand-english">ORGANIC ODYSSEY</span></div>
}

export function Shell({ page, navigate, children, saved }: { page: Page; navigate: (path: string) => void; children: ReactNode; saved: boolean }) {
  const [mobileMenu, setMobileMenu] = useState(false)
  const current = navigation.find(item => item.id === page)
  function go(path: string) { navigate(path); setMobileMenu(false) }

  return <div className="app-shell">
    {mobileMenu ? <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileMenu(false)} /> : null}
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}>
      <button className="brand-button" onClick={() => go('explore')} aria-label="有机漫游首页"><Brand /></button>
      <nav className="navigation" aria-label="主导航">
        {navigation.map(({ id, name, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => go(id)} aria-current={page === id ? 'page' : undefined}><Icon size={20} strokeWidth={1.7} />{name}{page === id ? <span className="nav-dot" /> : null}</button>)}
      </nav>
      <button className="sidebar-note" onClick={() => go('atlas')}><FlaskConical size={39} strokeWidth={1.25} /><strong>玩懂每一次反应</strong><span>科学推理，比记忆更进一步。</span><span className="round-arrow"><ArrowRight size={17} /></span></button>
      <div className="sidebar-footer"><span className="connection-dot" />属于你的有机合成研究所</div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(value => !value)} aria-label={mobileMenu ? '关闭导航' : '打开导航'}>{mobileMenu ? <X size={20} /> : <Menu size={20} />}</button><span>研究所</span><span className="breadcrumb-divider">/</span><span>{current?.name}</span></div>
        <div className="topbar-right"><span className="local-save"><span className={`connection-dot ${saved ? '' : 'warning-dot'}`} />{saved ? '进度已保存在本机' : '当前进度仅保留在本次会话'}</span><button className="avatar" onClick={() => go('profile')} aria-label="打开学习档案"><UserRound size={19} strokeWidth={1.7} /></button></div>
      </header>
      <main className="main-content" id="main-content">{children}</main>
      <footer className="page-footer"><span>有机漫游 · 2024—2026 题源精选</span><span>答案不止一条，思考从不止步。</span></footer>
    </div>
  </div>
}
