import { Molecule } from 'openchemlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { levels } from '../data/levels'
import type { AnswerRow, Assessment, Level, RouteStep } from '../types'
import { assessRoute, createEmptyProgress, createLevelProgress, formatStudyDate, normalizeChemical, readProgress, recordCompletion, STORAGE_KEY, writeProgress } from './game'

const step: RouteStep = {
  product: 'C6H5CH2CH2OH',
  smiles: 'OCCc1ccccc1',
  productAliases: ['PhCH2CH2OH', '苯乙醇'],
  reagents: 'NaOH 水溶液',
  reagentGroups: [['NaOH', '氢氧化钠']],
  conditions: '水溶液，加热',
  conditionGroups: [['水溶液', 'H2O', '水'], ['加热', '△']],
  explanation: '取代反应。',
  pitfall: '乙醇溶液易消去。',
}

const level: Level = {
  id: 'route-test', number: 1, title: '路线测试', subtitle: '', chapter: 'chain', difficulty: 4,
  minutes: 10, source: { title: '测试用例', year: 2024, kind: '模拟', url: '', question: '', adaptation: '' },
  color: 'purple', molecule: 'styrene', start: 'PhCH2CH2Br', startSmiles: 'BrCCc1ccccc1', target: step.product, task: '',
  information: [], tags: [], warmup: { question: '', options: ['A'], correct: 0, explanation: '' },
  steps: [step], hints: ['提示'], retrosynthesis: '', overall: '', alternatives: [],
}

const correctAnswer: AnswerRow = { product: 'PhCH2CH2OH', reagents: 'NaOH 水溶液', conditions: '△' }
const assessment: Assessment = { steps: [], score: 100, complete: true, stars: 3 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('normalizeChemical', () => {
  it.each([
    [' PhCH₂CH₂OH ', 'C6H5CH2CH2OH'],
    ['Ｃ₆Ｈ₅－ＣＨ₂－ＣＨ₂－ＯＨ', 'C6H5CH2CH2OH'],
    ['Na⁺ + COO⁻', 'Na++COO-'],
    ['加热 Δ ∆ △', '△△△△'],
    ['CH₃C≡N', 'CH3C#N'],
    ['Phosphoric', 'Phosphoric'],
    ['', ''],
  ])('统一 %s 的书写形式', (input, expected) => {
    expect(normalizeChemical(input)).toBe(expected)
  })

  it('保留元素大小写的化学含义', () => {
    expect(normalizeChemical('CO')).not.toBe(normalizeChemical('Co'))
    expect(normalizeChemical('NaOH')).not.toBe(normalizeChemical('naoh'))
  })
})

describe('assessRoute', () => {
  it('识别 Ph、上下标和单键符号的等价书写', () => {
    const result = assessRoute(level, [{ ...correctAnswer, product: ' C₆H₅—CH₂—CH₂—OH ' }], 0, false)
    expect(result).toMatchObject({ score: 100, complete: true, stars: 3 })
    expect(result.steps[0].status).toBe('correct')
  })

  it('允许将加热等条件写在试剂栏', () => {
    expect(assessRoute(level, [{ ...correctAnswer, reagents: 'NaOH，H₂O，Δ', conditions: '' }], 0, false).complete).toBe(true)
  })

  it('每组可选别名为 OR，各组之间为 AND', () => {
    const multi = { ...level, steps: [{ ...step, reagentGroups: [['NaOH', '氢氧化钠'], ['CuO', '氧化铜']] }] }
    const answer = { ...correctAnswer, reagents: '氢氧化钠、氧化铜、水' }
    expect(assessRoute(multi, [answer], 0, false).complete).toBe(true)
    expect(assessRoute(multi, [{ ...answer, reagents: '氢氧化钠、水' }], 0, false).steps[0].reagents).toBe(false)
  })

  it('严格区分元素、完整试剂和结构，不凭关键词猜对', () => {
    for (const [expected, entered] of [['CO', 'Co'], ['CO', 'CO2'], ['Cu', 'CuO'], ['H2', 'H2SO4'], ['NaOH', 'naoh']]) {
      const specific = { ...level, steps: [{ ...step, reagentGroups: [[expected]], conditionGroups: [] }] }
      const result = assessRoute(specific, [{ ...correctAnswer, reagents: entered, conditions: '' }], 0, false)
      expect(result.steps[0].reagents).toBe(false)
    }
    const result = assessRoute(level, [{ ...correctAnswer, product: 'PhCH(OH)CH3' }], 0, false)
    expect(result.steps[0]).toMatchObject({ product: false, status: 'unrecognized', points: 50 })
    expect(result.steps[0].feedback).toContain('不能据此断言')
    expect(result.complete).toBe(false)
  })

  it('不把无水或否定表达当作满足条件', () => {
    const dry = assessRoute(level, [{ ...correctAnswer, reagents: 'NaOH、无水乙醇', conditions: '不加热' }], 0, false)
    expect(dry.steps[0].conditions).toBe(false)
    const negated = assessRoute(level, [{ ...correctAnswer, reagents: '不使用NaOH，水溶液', conditions: '△' }], 0, false)
    expect(negated.steps[0].reagents).toBe(false)
  })

  it('遇到较早的错误子串后继续寻找真正匹配的试剂', () => {
    const specific = { ...level, steps: [{ ...step, reagentGroups: [['Cu']], conditionGroups: [] }] }
    expect(assessRoute(specific, [{ ...correctAnswer, reagents: 'CuO/Cu', conditions: '' }], 0, false).complete).toBe(true)
  })

  it('空条件组不要求额外条件，但空别名组不能通过', () => {
    const noConditions = { ...level, steps: [{ ...step, conditionGroups: [] }] }
    expect(assessRoute(noConditions, [{ ...correctAnswer, conditions: '' }], 0, false).complete).toBe(true)
    const invalid = { ...level, steps: [{ ...step, reagentGroups: [['']] }] }
    expect(assessRoute(invalid, [correctAnswer], 0, false).complete).toBe(false)
  })

  it('空行与缺失行记 0 分，空题目不能直接通关', () => {
    expect(assessRoute(level, [], 0, false)).toMatchObject({ score: 0, complete: false, stars: 0 })
    expect(assessRoute(level, [], 0, false).steps[0].status).toBe('empty')
    expect(assessRoute({ ...level, steps: [] }, [], 0, false)).toEqual({ steps: [], score: 0, complete: false, stars: 0 })
  })

  it('按产品 50、试剂 30、条件 20 计分，取各步均分', () => {
    expect(assessRoute(level, [{ ...correctAnswer, reagents: '', conditions: '' }], 0, false).score).toBe(50)
    expect(assessRoute(level, [{ ...correctAnswer, reagents: 'NaOH', conditions: '' }], 0, false).score).toBe(80)
    const twoSteps = { ...level, steps: [step, step] }
    expect(assessRoute(twoSteps, [correctAnswer], 0, false)).toMatchObject({ score: 50, complete: false, stars: 0 })
    expect(assessRoute(level, [{ product: '', reagents: 'NaOH 水溶液', conditions: '△' }], 0, false).steps[0].feedback).toContain('尚未填写中间体')
  })

  it('依据提示与解析记录给予星级，未完成无星', () => {
    expect(assessRoute(level, [correctAnswer], 1, false).stars).toBe(2)
    expect(assessRoute(level, [correctAnswer], 0, true).stars).toBe(1)
    expect(assessRoute(level, [correctAnswer], 3, true).stars).toBe(1)
    expect(assessRoute(level, [], 0, true).stars).toBe(0)
  })
})

describe('分子图判题', () => {
  it('绘图保存的乙醛 CC=O 与颠倒原子次序 O=CC 均可识别', () => {
    const first = levels[0]
    for (const smiles of ['CC=O', 'O=CC']) {
      const answers = first.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
      answers[0].product = `@smiles:${smiles}`
      expect(assessRoute(first, answers, 0, false)).toMatchObject({ score: 100, complete: true })
    }
  })

  it('芳香式、凯库勒式和原子顺序改变表示同一个分子图', () => {
    for (const smiles of ['OCCc1ccccc1', 'c1ccccc1CCO', 'OCCC1=CC=CC=C1']) {
      expect(assessRoute(level, [{ ...correctAnswer, product: `@smiles:${smiles}` }], 0, false).complete).toBe(true)
    }
  })

  it('不同官能团位置、额外碎片和分子式不能伪装成同一结构', () => {
    for (const product of ['@smiles:CC(O)c1ccccc1', '@smiles:OCCc1ccccc1.O', 'C8H10O', 'OCCc1ccccc1']) {
      expect(assessRoute(level, [{ ...correctAnswer, product }], 0, false).steps[0]).toMatchObject({ product: false, status: 'unrecognized' })
    }
  })

  it.each(['@smiles:', '@smiles:C1CC', '@smiles:bad smiles'])('坏结构 %s 不抛异常且不会通过', product => {
    const result = assessRoute(level, [{ ...correctAnswer, product }], 0, false)
    expect(result.complete).toBe(false)
    expect(result.steps[0].status).toBe('unrecognized')
  })

  it.each([
    ['lactide', 2, ['C[C@H](O)C(=O)O', 'C[C@@H](O)C(=O)O', 'CC(O)C(=O)O']],
    ['styrene-network', 0, ['O=C(O)/C=C/c1ccccc1', 'O=C(O)/C=C\\c1ccccc1', 'O=C(O)C=Cc1ccccc1']],
    ['styrene-network', 3, ['CC[C@H](O)c1ccccc1', 'CC[C@@H](O)c1ccccc1', 'CCC(O)c1ccccc1']],
    ['bupivacaine', 3, ['CCCCN1CCCC[C@H]1C(=O)Nc1c(C)cccc1C', 'CCCCN1CCCC[C@@H]1C(=O)Nc1c(C)cccc1C', 'CCCCN1CCCCC1C(=O)Nc1c(C)cccc1C']],
  ] as const)('%s 第 %i 步接受 R/S、E/Z 和未标立体的相同连接结构', (id, index, variants) => {
    const targetLevel = levels.find(item => item.id === id)!
    for (const smiles of variants) {
      const answers = targetLevel.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
      answers[index].product = `@smiles:${smiles}`
      expect(assessRoute(targetLevel, answers, 0, false)).toMatchObject({ score: 100, complete: true })
    }
  })

  it.each(levels.filter(item => item.molecule === 'belinostat'))('$id 同样接受 E、Z 和未画构型的相同连接结构', targetLevel => {
    const lastIndex = targetLevel.steps.length - 1
    for (const smiles of [targetLevel.steps[lastIndex].smiles, targetLevel.steps[lastIndex].smiles.replaceAll('/', ''), targetLevel.steps[lastIndex].smiles.replace('/C=C/', '/C=C\\')]) {
      const answers = targetLevel.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
      answers[lastIndex].product = `@smiles:${smiles}`
      const result = assessRoute(targetLevel, answers, 0, false)
      expect(result).toMatchObject({ score: 100, complete: true })
      expect(result.steps[lastIndex].feedback).not.toContain('构型')
    }
  })

  it('忽略立体仍不能把缺少磺酰胺的结构判成贝利司他', () => {
    const targetLevel = levels.find(item => item.id === 'belinostat-shortcut')!
    const answers = targetLevel.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
    answers[2].product = '@smiles:O=C(NO)/C=C/c1ccccc1'
    const result = assessRoute(targetLevel, answers, 0, false)
    expect(result.complete).toBe(false)
    expect(result.steps[2]).toMatchObject({ product: false, status: 'unrecognized' })
  })

  it.each(levels.filter(item => item.molecule === 'belinostat'))('$id 仍拒绝位置异构、官能团和键级错误及额外片段', targetLevel => {
    const lastIndex = targetLevel.steps.length - 1
    const standard = targetLevel.steps[lastIndex].smiles
    const wrongStructures = [
      standard.replace('c1cccc(S(=O)(=O)Nc2ccccc2)c1', 'c1ccc(S(=O)(=O)Nc2ccccc2)cc1'),
      standard.replace('/C=C/', 'CC'),
      standard.replace('S(=O)(=O)', 'S(=O)'),
      `${standard}.O`,
    ]
    for (const smiles of wrongStructures) {
      const answers = targetLevel.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
      answers[lastIndex].product = `@smiles:${smiles}`
      const result = assessRoute(targetLevel, answers, 0, false)
      expect(result.complete).toBe(false)
      expect(result.steps[lastIndex]).toMatchObject({ product: false, status: 'unrecognized' })
    }
  })

  it.each(levels)('$id 的全部标准分子图均能完成结构判题', targetLevel => {
    const answers = targetLevel.steps.map(({ smiles, reagents, conditions }) => ({ product: `@smiles:${smiles}`, reagents, conditions }))
    expect(assessRoute(targetLevel, answers, 0, false)).toMatchObject({ score: 100, complete: true })
  })

  it('全部 31 个起点及步骤结构可生成规范分子图编码', () => {
    const smiles = levels.flatMap(targetLevel => [targetLevel.startSmiles, ...targetLevel.steps.map(routeStep => routeStep.smiles)])
    expect(smiles).toHaveLength(31)
    for (const text of smiles) expect(Molecule.fromSmiles(text).getIDCode()).not.toBe('d@')
  })

  it('标准结构配置损坏时安全返回未识别', () => {
    const invalid = { ...level, steps: [{ ...step, smiles: 'invalid' }] }
    expect(assessRoute(invalid, [{ ...correctAnswer, product: '@smiles:OCCc1ccccc1' }], 0, false).complete).toBe(false)
    const blank = { ...level, steps: [{ ...step, smiles: '' }] }
    expect(assessRoute(blank, [{ ...correctAnswer, product: '@smiles:OCCc1ccccc1' }], 0, false).complete).toBe(false)
  })
})

describe('无水反应与后处理顺序', () => {
  it.each([
    ['epoxide-strategy', 2, '先酸性水解，再无水醚中开环'],
    ['styrene-network', 3, '先加水，再无水醚中反应'],
    ['styrene-network', 3, '先加酸，然后无水开环'],
    ['belinostat-chain', 0, '先水解，随后无水还原'],
    ['belinostat-chain', 0, '先H2O后无水还原'],
  ] as const)('%s 的第 %i 步不接受 %s', (id, index, conditions) => {
    const targetLevel = levels.find(item => item.id === id)!
    const answers = targetLevel.steps.map(({ product, reagents, conditions: standardConditions }) => ({ product, reagents, conditions: standardConditions }))
    answers[index].conditions = conditions
    const result = assessRoute(targetLevel, answers, 0, false)
    expect(result.complete).toBe(false)
    expect(result.steps[index].conditions).toBe(false)
    expect(result.steps[index].feedback).toContain('操作顺序颠倒')
  })

  it('同一子句不能同时要求无水和水溶液，标准先无水后水解仍可通过', () => {
    const targetLevel = levels.find(item => item.id === 'epoxide-strategy')!
    const answers = targetLevel.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
    expect(assessRoute(targetLevel, answers, 0, false).complete).toBe(true)
    answers[1].conditions = '无水乙醚水溶液'
    const result = assessRoute(targetLevel, answers, 0, false)
    expect(result.steps[1].conditions).toBe(false)
    expect(result.steps[1].feedback).toContain('矛盾')
  })

  it('分开的无水反应与随后加水子句不被误判为矛盾', () => {
    const targetLevel = levels.find(item => item.id === 'styrene-network')!
    const answers = targetLevel.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
    answers[3].conditions = '先无水乙醚中反应随后加H2O水解'
    expect(assessRoute(targetLevel, answers, 0, false).complete).toBe(true)
  })
})

describe('progress', () => {
  it('为新关卡创建独立空行和独立存档', () => {
    const one = createEmptyProgress()
    one.notes.first = '笔记'
    expect(createEmptyProgress().notes).toEqual({})
    const created = createLevelProgress({ ...level, steps: [step, step] })
    created.answers[0].product = '答案'
    expect(created.answers[1].product).toBe('')
    expect(created).toMatchObject({ hintsUsed: 0, attempts: 0, bestScore: 0, stars: 0, completed: false, explanationViewed: false })
  })

  it('在 SSR、缺少存档或 localStorage 禁用时安全降级', () => {
    vi.stubGlobal('window', undefined)
    expect(readProgress()).toEqual(createEmptyProgress())
    expect(writeProgress(createEmptyProgress())).toBe(false)
    expect(readProgress({ getItem: () => null })).toEqual(createEmptyProgress())
    const blocked = Object.defineProperty({}, 'localStorage', { get() { throw new Error('Blocked') } })
    vi.stubGlobal('window', blocked)
    expect(readProgress()).toEqual(createEmptyProgress())
    expect(writeProgress(createEmptyProgress())).toBe(false)
    expect(readProgress({ getItem() { throw new Error('Blocked') } })).toEqual(createEmptyProgress())
  })

  it.each(['{', 'null', '[]', '{"version":2,"levels":{},"notes":{}}', '{"version":1,"levels":[],"notes":{}}', '{"version":1,"levels":{}}'])('拒绝损坏的存档 %s', serialized => {
    expect(readProgress({ getItem: () => serialized })).toEqual(createEmptyProgress())
  })

  it('恢复合法存档，并过滤损坏关卡、危险键和无效学习日期', () => {
    const stored = {
      ...createEmptyProgress(),
      levels: { good: { ...createLevelProgress(level), warmupAnswer: 1 }, bad: { answers: [] }, negative: { ...createLevelProgress(level), stars: -1 } },
      notes: { good: '复盘', bad: 12 },
      lastLevel: level.id,
      studyDays: ['2026-11-08', '2026-11-08', '2026-02-30', '2024-02-29', '2026-2-1', null],
    }
    const serialized = JSON.stringify(stored).replace('"levels":{', '"levels":{"__proto__":{},')
    const restored = readProgress({ getItem: () => serialized })
    expect(Object.keys(restored.levels)).toEqual(['good'])
    expect(restored.levels.good.warmupAnswer).toBe(1)
    expect(restored.notes).toEqual({ good: '复盘' })
    expect(restored.lastLevel).toBe(level.id)
    expect(restored.studyDays).toEqual(['2026-11-08', '2024-02-29'])
  })

  it('过滤无效字段与损坏答案，缺省顶层可选值安全恢复', () => {
    const base = createLevelProgress(level)
    const corrupt = [
      { ...base, answers: [null] }, { ...base, hintsUsed: '1' }, { ...base, attempts: -1 },
      { ...base, bestScore: 101 }, { ...base, completed: 'true' },
      { ...base, explanationViewed: null }, { ...base, warmupAnswer: -1 },
    ]
    const levels = Object.fromEntries(corrupt.map((value, index) => [String(index), value]))
    const restored = readProgress({ getItem: () => JSON.stringify({ version: 1, levels, notes: { constructor: '危险键' }, lastLevel: 'constructor', studyDays: null }) })
    expect(restored).toEqual(createEmptyProgress())
  })

  it('写入成功可恢复；配额与序列化失败不抛错', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    const progress = createEmptyProgress()
    progress.levels[level.id] = createLevelProgress(level)
    expect(writeProgress(progress, storage)).toBe(true)
    expect(data.has(STORAGE_KEY)).toBe(true)
    expect(readProgress(storage)).toEqual(progress)
    expect(writeProgress(progress, { setItem() { throw new Error('QuotaExceededError') } })).toBe(false)
    const circular = createEmptyProgress()
    Object.assign(circular.notes, { circular })
    expect(writeProgress(circular, storage)).toBe(false)
  })

  it('记录尝试和学习日，不修改输入且不会降低完成记录', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 8, 9))
    const initial = createEmptyProgress()
    const finished = recordCompletion(initial, level, assessment)
    expect(initial.levels).toEqual({})
    expect(finished.levels[level.id]).toMatchObject({ attempts: 1, bestScore: 100, stars: 3, completed: true })
    expect(finished.studyDays).toEqual(['2026-11-08'])
    expect(finished.lastLevel).toBe(level.id)
    const retried = recordCompletion(finished, level, { ...assessment, score: 50, stars: 0, complete: false })
    expect(retried.levels[level.id]).toMatchObject({ attempts: 2, bestScore: 100, stars: 3, completed: true })
    expect(retried.studyDays).toEqual(['2026-11-08'])
    expect(finished.levels[level.id].attempts).toBe(1)
    vi.setSystemTime(new Date(2026, 10, 9, 9))
    expect(recordCompletion(retried, level, assessment).studyDays).toEqual(['2026-11-08', '2026-11-09'])
  })

  it('按本地日历日期格式化，拒绝无效日期', () => {
    expect(formatStudyDate(new Date(2026, 0, 2, 0, 1))).toBe('2026-01-02')
    expect(formatStudyDate(new Date('invalid'))).toBe('')
  })
})
