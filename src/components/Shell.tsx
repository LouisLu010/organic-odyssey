import { ArrowRight, BookOpen, ChartNoAxesCombined, Compass, FlaskConical, Hexagon, Menu, NotebookPen, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
  const sidebarRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const current = navigation.find(item => item.id === page)
  function go(path: string) { navigate(path); setMobileMenu(false) }

  useEffect(() => {
    if (!mobileMenu) return
    const mobile = window.matchMedia('(max-width: 700px)')
    if (!mobile.matches) { setMobileMenu(false); return }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    function closeOnDesktop(event: MediaQueryListEvent) { if (!event.matches) setMobileMenu(false) }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setMobileMenu(false); return }
      if (event.key !== 'Tab' || !sidebarRef.current) return
      const controls = [...sidebarRef.current.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled && button.getClientRects().length > 0)
      const index = controls.indexOf(document.activeElement as HTMLButtonElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus() }
    }
    mobile.addEventListener('change', closeOnDesktop)
    document.addEventListener('keydown', handleKey)
    return () => {
      mobile.removeEventListener('change', closeOnDesktop)
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = previousOverflow
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [mobileMenu])

  return <div className="app-shell">
    {mobileMenu ? <button className="sidebar-backdrop" aria-label="关闭导航遮罩" tabIndex={-1} onClick={() => setMobileMenu(false)} /> : null}
    <aside id="site-navigation-panel" ref={sidebarRef} className={`sidebar ${mobileMenu ? 'is-open' : ''}`} role={mobileMenu ? 'dialog' : undefined} aria-modal={mobileMenu || undefined} aria-label="研究所导航">
      <button ref={closeButtonRef} className="sidebar-close" aria-label="关闭导航" onClick={() => setMobileMenu(false)}><X size={22} /></button>
      <button className="brand-button" onClick={() => go('explore')} aria-label="有机漫游首页"><Brand /></button>
      <nav className="navigation" aria-label="主导航">
        {navigation.map(({ id, name, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => go(id)} aria-current={page === id ? 'page' : undefined}><Icon size={20} strokeWidth={1.7} />{name}{page === id ? <span className="nav-dot" /> : null}</button>)}
      </nav>
      <button className="sidebar-note" onClick={() => go('atlas')}><FlaskConical size={39} strokeWidth={1.25} /><strong>玩懂每一次反应</strong><span>科学推理，比记忆更进一步。</span><span className="round-arrow"><ArrowRight size={17} /></span></button>
      <div className="sidebar-footer"><span className="connection-dot" />属于你的有机合成研究所</div>
    </aside>
    <div className="workspace" inert={mobileMenu || undefined}>
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(value => !value)} aria-label={mobileMenu ? '关闭导航' : '打开导航'} aria-controls="site-navigation-panel" aria-expanded={mobileMenu}>{mobileMenu ? <X size={22} /> : <Menu size={22} />}</button><span>研究所</span><span className="breadcrumb-divider">/</span><span>{current?.name}</span></div>
        <div className="topbar-right"><span className="local-save"><span className={`connection-dot ${saved ? '' : 'warning-dot'}`} />{saved ? '进度已保存在本机' : '当前进度仅保留在本次会话'}</span><button className="avatar" onClick={() => go('profile')} aria-label="打开学习档案"><UserRound size={19} strokeWidth={1.7} /></button></div>
      </header>
      <main className="main-content" id="main-content">{children}</main>
      <footer className="page-footer"><span>有机漫游 · 2024—2026 题源精选</span><span>答案不止一条，思考从不止步。</span></footer>
    </div>
  </div>
}
