export type Page = 'explore' | 'atlas' | 'notes' | 'profile'
export type Chapter = 'chain' | 'functional' | 'strategy'

export interface Source {
  title: string
  year: 2024 | 2025 | 2026
  kind: '高考' | '模拟'
  url: string
  question: string
  adaptation: string
}

export interface RouteStep {
  product: string
  smiles: string
  productAliases: string[]
  reagents: string
  reagentGroups: string[][]
  conditions: string
  conditionGroups: string[][]
  explanation: string
  pitfall: string
}

export interface Warmup {
  question: string
  options: string[]
  correct: number
  explanation: string
}

export interface Level {
  id: string
  number: number
  title: string
  subtitle: string
  chapter: Chapter
  difficulty: 3 | 4 | 5
  minutes: number
  source: Source
  color: 'purple' | 'green' | 'peach' | 'blue'
  molecule: 'lactide' | 'aspirin' | 'cinnamic' | 'styrene' | 'propanol' | 'protection' | 'bupivacaine' | 'belinostat'
  smiles?: string
  start: string
  startSmiles: string
  target: string
  task: string
  information: string[]
  tags: string[]
  warmup: Warmup
  steps: RouteStep[]
  hints: string[]
  retrosynthesis: string
  overall: string
  alternatives: string[]
}

export interface AnswerRow {
  product: string
  reagents: string
  conditions: string
}

export interface StepAssessment {
  index: number
  product: boolean
  reagents: boolean
  conditions: boolean
  status: 'correct' | 'partial' | 'unrecognized' | 'empty'
  points: number
  feedback: string
}

export interface Assessment {
  steps: StepAssessment[]
  score: number
  complete: boolean
  stars: number
}

export interface LevelProgress {
  answers: AnswerRow[]
  hintsUsed: number
  attempts: number
  bestScore: number
  stars: number
  completed: boolean
  explanationViewed: boolean
  warmupAnswer?: number
}

export interface GameProgress {
  version: 1
  levels: Record<string, LevelProgress>
  notes: Record<string, string>
  lastLevel: string | null
  studyDays: string[]
}
