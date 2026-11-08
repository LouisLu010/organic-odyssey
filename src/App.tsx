import { lazy, Suspense, useEffect } from 'react'
import { Compass } from 'lucide-react'
import { levels } from './data/levels'
import { Shell } from './components/Shell'
import { Explore } from './components/Explore'
import { useGame, useRoute } from './hooks/useGame'
import type { Level, Page } from './types'

const LevelWorkspace = lazy(() => import('./components/LevelWorkspace'))
const AtlasPage = lazy(() => import('./components/StudyPages').then(module => ({ default: module.AtlasPage })))
const NotesPage = lazy(() => import('./components/StudyPages').then(module => ({ default: module.NotesPage })))
const ProfilePage = lazy(() => import('./components/StudyPages').then(module => ({ default: module.ProfilePage })))

export default function App() {
  const { route, navigate } = useRoute()
  const game = useGame()
  const levelId = route.startsWith('level/') ? route.slice(6) : null
  const level = levels.find(item => item.id === levelId)
  const page: Page = route === 'atlas' || route === 'notes' || route === 'profile' ? route : 'explore'
  const registerStart = game.start

  useEffect(() => {
    if (level) registerStart(level)
  }, [level, registerStart])

  useEffect(() => {
    window.scrollTo(0, 0)
    document.title = level ? `${level.title} · 有机漫游` : '有机漫游 · 在思考中合成'
  }, [route, level])

  function start(target: Level) {
    navigate(`level/${target.id}`)
  }

  const nextLevel = level ? levels[levels.indexOf(level) + 1] : undefined

  return <Shell page={page} navigate={navigate} saved={game.saved}><Suspense fallback={<div className="empty-state"><Compass size={26} /><p>正在准备你的合成研究所…</p></div>}>
    {level ? <LevelWorkspace key={level.id} level={level} game={game} onBack={() => navigate('explore')} onNext={nextLevel ? () => start(nextLevel) : undefined} />
      : page === 'atlas' ? <AtlasPage levels={levels} onStart={start} />
        : page === 'notes' ? <NotesPage levels={levels} game={game} onStart={start} />
          : page === 'profile' ? <ProfilePage levels={levels} game={game} onStart={start} />
            : <Explore levels={levels} progress={game.progress} onStart={start} />}
  </Suspense></Shell>
}
