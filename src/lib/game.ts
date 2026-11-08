import { Molecule } from 'openchemlib'
import type { AnswerRow, Assessment, GameProgress, Level, LevelProgress, StepAssessment } from '../types'

export const STORAGE_KEY = 'organic-odyssey.progress.v1'

type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>

const NEGATION = /(?:不|非|无|未|勿|禁止|不要|无需|无须|不使用|不加|不含|不加入|不用|缺少|没有|避免)$/
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** 只统一书写形式，不推测连接方式、官能团或反应等价性。 */
export function normalizeChemical(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\u200B\uFEFF]/g, '')
    .replace(/[−–—﹣]/g, '-')
    .replace(/[Δ∆△]|加热/g, '△')
    .replace(/≡/g, '#')
    .replace(/Ph(?=[A-Z\d(\-+]|$)/g, 'C6H5')
    .replace(/([A-Za-z\d)])-(?=[A-Z(])/g, '$1')
}

function matchesTerm(input: string, rawTerm: string): boolean {
  const term = normalizeChemical(rawTerm)
  if (!term) return false

  let position = input.indexOf(term)
  while (position !== -1) {
    const before = input.slice(0, position)
    const after = input.slice(position + term.length)
    const startsLatin = /^[A-Za-z\d]/.test(term)
    const endsLatin = /[A-Za-z\d]$/.test(term)
    const hasLeftBoundary = !startsLatin || !/[A-Za-z\d]$/.test(before)
    const hasRightBoundary = !endsLatin || !/^[A-Za-z\d]/.test(after)

    if (hasLeftBoundary && hasRightBoundary && !NEGATION.test(before)) return true
    position = input.indexOf(term, position + 1)
  }
  return false
}

function matchesGroups(input: string, groups: string[][]): boolean {
  return groups.every(group => group.some(term => matchesTerm(input, term)))
}

function matchProduct(level: Level, index: number, input: string): { matches: boolean; feedback?: string } {
  const step = level.steps[index]
  if (!input.trim().startsWith('@smiles:')) {
    const normalized = normalizeChemical(input)
    return { matches: normalized !== '' && [step.product, ...step.productAliases].some(alias => normalizeChemical(alias) === normalized) }
  }

  try {
    const entered = Molecule.fromSmiles(input.trim().slice('@smiles:'.length).trim())
    const expected = Molecule.fromSmiles(step.smiles)
    if (!entered.getAllAtoms() || !expected.getAllAtoms()) return { matches: false }
    entered.stripStereoInformation()
    expected.stripStereoInformation()
    return { matches: entered.getIDCode() === expected.getIDCode() }
  } catch {
    return { matches: false, feedback: '暂时无法解析这幅结构。请检查原子、化学键与环连接后重新保存；系统不会把无法识别的图直接认定为化学错误。' }
  }
}

/** 仅拦截明确的次序颠倒和同一子句内的水相矛盾，不推断任意自然语言操作。 */
function dryConditionConflict(level: Level, index: number, input: string): string | undefined {
  const step = level.steps[index]
  const requiresDry = step.conditionGroups.some(group => group.some(term => term === '无水' || term === '干燥'))
  if (!requiresDry) return undefined

  const hasWaterWorkup = /水解|后处理/.test(step.conditions)
  const reversed = /先(?:加入|加|用|进行|在)?(?:酸性水解|酸性后处理|水解|酸化|H3O\+|H2O|水|酸)[^；;。]*(?:再|随后|然后|之后|后)[^；;。]*(?:无水|干燥|开环|还原|Grignard|有机镁|反应)/.test(input)
  if (hasWaterWorkup && reversed) {
    return '操作顺序颠倒：先加水或酸会消耗有机镁试剂或 LiAlH4。应先完成无水反应，再进行水解或酸性后处理。'
  }
  const clauses = input.split(/[，,；;。]|随后|然后|之后|再/)
  if (clauses.some(clause => /无水|干燥/.test(clause) && /水溶液|水相|水中|H2O/.test(clause))) {
    return '无水条件与同一步写出的水溶液条件矛盾；有机镁或 LiAlH4 反应应先在无水体系进行，再单独后处理。'
  }
  return undefined
}

function assessStep(level: Level, answers: AnswerRow[], index: number): StepAssessment {
  const step = level.steps[index]
  const answer = answers[index] ?? { product: '', reagents: '', conditions: '' }
  const productInput = normalizeChemical(answer.product)
  const combinedInput = `${normalizeChemical(answer.reagents)};${normalizeChemical(answer.conditions)}`
  const empty = !productInput && !normalizeChemical(answer.reagents) && !normalizeChemical(answer.conditions)
  const productMatch = matchProduct(level, index, answer.product)
  const product = productMatch.matches
  const reagents = matchesGroups(combinedInput, step.reagentGroups)
  const conditionConflict = dryConditionConflict(level, index, combinedInput)
  const conditions = matchesGroups(combinedInput, step.conditionGroups) && !conditionConflict
  const points = empty ? 0 : (product ? 50 : 0) + (reagents ? 30 : 0) + (conditions ? 20 : 0)

  let status: StepAssessment['status']
  let feedback: string
  if (empty) {
    status = 'empty'
    feedback = '这一步尚未作答，请填写中间体、试剂与反应条件。'
  } else if (!product) {
    status = 'unrecognized'
    feedback = productMatch.feedback ?? (productInput
      ? '暂未识别该中间体。系统只比对预设关键点，不能据此断言路线在化学上错误；请检查结构简式，或对照解析核查等效路线。'
      : '尚未填写中间体。系统只比对预设关键点，请补充这一箭头后的结构。')
  } else if (reagents && conditions) {
    status = 'correct'
    feedback = '中间体、试剂与条件的关键点均匹配。'
  } else {
    status = 'partial'
    const missing = [!reagents ? '试剂关键点尚未全部匹配' : '', !conditions ? '反应条件尚未全部匹配' : ''].filter(Boolean)
    feedback = conditionConflict ?? `中间体已匹配；${missing.join('；')}。`
  }

  return { index, product, reagents, conditions, status, points, feedback }
}

export function assessRoute(level: Level, answers: AnswerRow[], hintsUsed: number, explanationViewed: boolean): Assessment {
  const steps = level.steps.map((_, index) => assessStep(level, answers, index))
  const score = steps.length ? Math.round(steps.reduce((total, step) => total + step.points, 0) / steps.length) : 0
  const complete = steps.length > 0 && steps.every(step => step.status === 'correct')
  const stars = complete ? (explanationViewed ? 1 : hintsUsed > 0 ? 2 : 3) : 0
  return { steps, score, complete, stars }
}

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
