import type { AnswerRow, Assessment, GameProgress, Level, LevelProgress } from '../types'

export const STORAGE_KEY = 'organic-odyssey.progress.v1'

type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function createEmptyProgress(): GameProgress {
  return { version: 1, levels: {}, notes: {}, lastLevel: null, studyDays: [] }
}

export function createLevelProgress(level: Level): LevelProgress {
  return {
    answers: level.steps.map(() => ({ product: '', reagents: '', conditions: '' })),
    hintsUsed: 0,
    attempts: 0,
    bestScore: 0,
    stars: 0,
    completed: false,
    explanationViewed: false,
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntegerInRange(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function isAnswerRow(value: unknown): value is AnswerRow {
  return isRecord(value) && typeof value.product === 'string' && typeof value.reagents === 'string' && typeof value.conditions === 'string'
}

function parseLevelProgress(value: unknown): LevelProgress | undefined {
  if (
    !isRecord(value) || !Array.isArray(value.answers) || !value.answers.every(isAnswerRow)
    || !isIntegerInRange(value.hintsUsed) || !isIntegerInRange(value.attempts)
    || !isIntegerInRange(value.bestScore, 100) || !isIntegerInRange(value.stars, 3)
    || typeof value.completed !== 'boolean' || typeof value.explanationViewed !== 'boolean'
    || (value.warmupAnswer !== undefined && !isIntegerInRange(value.warmupAnswer))
  ) return undefined

  return {
    answers: value.answers.map(({ product, reagents, conditions }) => ({ product, reagents, conditions })),
    hintsUsed: value.hintsUsed,
    attempts: value.attempts,
    bestScore: value.bestScore,
    stars: value.stars,
    completed: value.completed,
    explanationViewed: value.explanationViewed,
    ...(value.warmupAnswer !== undefined ? { warmupAnswer: value.warmupAnswer } : {}),
  }
}

function isStudyDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(0)
  parsed.setFullYear(year, month - 1, day)
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
}

export function readProgress(storage: ReadStorage | undefined = browserStorage()): GameProgress {
  try {
    const serialized = storage?.getItem(STORAGE_KEY)
    if (!serialized) return createEmptyProgress()
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.levels) || !isRecord(value.notes)) return createEmptyProgress()

    const levels: GameProgress['levels'] = {}
    for (const [id, stored] of Object.entries(value.levels)) {
      if (UNSAFE_KEYS.has(id)) continue
      const level = parseLevelProgress(stored)
      if (level) levels[id] = level
    }

    const notes = Object.fromEntries(Object.entries(value.notes).filter(([id, note]) => !UNSAFE_KEYS.has(id) && typeof note === 'string')) as GameProgress['notes']
    return {
      version: 1,
      levels,
      notes,
      lastLevel: typeof value.lastLevel === 'string' && !UNSAFE_KEYS.has(value.lastLevel) ? value.lastLevel : null,
      studyDays: Array.isArray(value.studyDays) ? [...new Set(value.studyDays.filter(isStudyDate))] : [],
    }
  } catch {
    return createEmptyProgress()
  }
}

export function writeProgress(progress: GameProgress, storage: WriteStorage | undefined = browserStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(progress))
    return true
  } catch {
    return false
  }
}

export function formatStudyDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) return ''
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function recordCompletion(progress: GameProgress, level: Level, assessment: Assessment): GameProgress {
  const previous = progress.levels[level.id] ?? createLevelProgress(level)
  const today = formatStudyDate(new Date())
  return {
    ...progress,
    levels: {
      ...progress.levels,
      [level.id]: {
        ...previous,
        attempts: previous.attempts + 1,
        bestScore: Math.max(previous.bestScore, assessment.score),
        stars: Math.max(previous.stars, assessment.stars),
        completed: previous.completed || assessment.complete,
      },
    },
    lastLevel: level.id,
    studyDays: progress.studyDays.includes(today) ? [...progress.studyDays] : [...progress.studyDays, today],
  }
}
