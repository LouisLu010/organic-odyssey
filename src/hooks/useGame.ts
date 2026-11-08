import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createLevelProgress, formatStudyDate, readProgress, recordCompletion, writeProgress } from '../lib/progress'
import type { AnswerRow, Assessment, GameProgress, Level, LevelProgress } from '../types'

function subscribeRoute(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

export function useRoute() {
  const route = useSyncExternalStore(subscribeRoute, () => window.location.hash.slice(1) || 'explore')
  return { route, navigate: (target: string) => { window.location.hash = target } }
}

export function useGame() {
  const [progress, setProgress] = useState<GameProgress>(readProgress)
  const [saved, setSaved] = useState(true)

  useEffect(() => { setSaved(writeProgress(progress)) }, [progress])

  function updateLevel(level: Level, update: (previous: LevelProgress) => LevelProgress) {
    setProgress(previous => ({
      ...previous,
      levels: { ...previous.levels, [level.id]: update(previous.levels[level.id] ?? createLevelProgress(level)) },
    }))
  }

  const start = useCallback((level: Level) => {
    setProgress(previous => {
      const today = formatStudyDate(new Date())
      if (previous.lastLevel === level.id && previous.studyDays.includes(today) && previous.levels[level.id]) return previous
      return {
        ...previous,
        lastLevel: level.id,
        studyDays: previous.studyDays.includes(today) ? previous.studyDays : [...previous.studyDays, today],
        levels: { ...previous.levels, [level.id]: previous.levels[level.id] ?? createLevelProgress(level) },
      }
    })
  }, [])

  function answer(level: Level, index: number, key: keyof AnswerRow, value: string) {
    updateLevel(level, previous => ({
      ...previous,
      answers: level.steps.map((_, rowIndex) => {
        const row = previous.answers[rowIndex] ?? { product: '', reagents: '', conditions: '' }
        return rowIndex === index ? { ...row, [key]: value } : row
      }),
    }))
  }

  function submit(level: Level, assessment: Assessment) {
    setProgress(previous => recordCompletion(previous, level, assessment))
  }

  function note(id: string, value: string) {
    setProgress(previous => ({ ...previous, notes: { ...previous.notes, [id]: value } }))
  }

  function resetLevel(level: Level) {
    updateLevel(level, previous => ({
      ...previous,
      answers: createLevelProgress(level).answers,
      warmupAnswer: undefined,
    }))
  }

  return { progress, saved, start, answer, updateLevel, submit, note, resetLevel }
}

export type Game = ReturnType<typeof useGame>
