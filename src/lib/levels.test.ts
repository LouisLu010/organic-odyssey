import SmilesDrawer from 'smiles-drawer'
import { describe, expect, it } from 'vitest'
import { levels } from '../data/levels'
import type { AnswerRow, Level } from '../types'
import { assessRoute } from './game'

function standardAnswers(level: Level): AnswerRow[] {
  return level.steps.map(({ product, reagents, conditions }) => ({ product, reagents, conditions }))
}

const commonWrongProducts: Record<string, string[]> = {
  lactide: ['CH2=CHOH', 'CH3COOH', 'CH3COCOOH', '聚乳酸'],
  'protect-amine': ['C6H5COCH3', 'o-O2NC6H4NHCOCH3', 'p-H2NC6H4NH2'],
  'epoxide-strategy': ['C6H6Br6', 'C6H6', 'PhC(CH3)2CH2OH'],
  'styrene-network': ['PhCH2CH3', 'PhCH2CH3', 'PhCHO', 'PhCH2CH(OH)CH3'],
  bupivacaine: ['2-ClC5H4N', 'Py-2-CONH-p-C6H4CH3', '全氢化布比卡因中间体', 'N-仲丁基布比卡因'],
  'belinostat-chain': ['ArCH2CH2OH', 'ArCOOH', 'p-(PhNHSO2)C6H4CH=CHCOOCH3'],
  'belinostat-shortcut': ['m-BrC6H4NHSO2Ph', 'ArCH=CHCOOH', 'ArCH=CHCONH2'],
}

describe.each(levels)('题库整合：$number $title', level => {
  it('公开参考答案所有步骤均可获得 100 分并通关', () => {
    const result = assessRoute(level, standardAnswers(level), 0, false)
    expect(result.steps.map(step => ({ index: step.index, status: step.status, feedback: step.feedback }))).toEqual(
      level.steps.map((_, index) => ({ index, status: 'correct', feedback: '中间体、试剂与条件的关键点均匹配。' })),
    )
    expect(result).toMatchObject({ score: 100, complete: true, stars: 3 })
  })

  it('空白路线得 0 分且不会通关', () => {
    const blank = level.steps.map(() => ({ product: '', reagents: '', conditions: '' }))
    expect(assessRoute(level, blank, 0, false)).toMatchObject({ score: 0, complete: false, stars: 0 })
  })

  it('任意一步使用常见错误结构都无法通关', () => {
    const wrongProducts = commonWrongProducts[level.id]
    expect(wrongProducts).toHaveLength(level.steps.length)
    for (let index = 0; index < level.steps.length; index += 1) {
      const answers = standardAnswers(level)
      answers[index] = { ...answers[index], product: wrongProducts[index] }
      const result = assessRoute(level, answers, 0, false)
      expect(result.complete, `第 ${index + 1} 步错误结构 ${wrongProducts[index]} 不应通过`).toBe(false)
      expect(result.steps[index]).toMatchObject({ product: false, status: 'unrecognized' })
      expect(result.score).toBeLessThan(100)
    }
  })

  it('具有可用的目标 SMILES，且纯解析器能解析', () => {
    expect(level.smiles).toBeTypeOf('string')
    let parsed = false
    let error: unknown
    SmilesDrawer.parse(level.smiles!, () => { parsed = true }, parseError => { error = parseError })
    expect(error).toBeUndefined()
    expect(parsed).toBe(true)
  })

  it('具备明确的原题定位、改编说明和必要已知信息', () => {
    expect(level.source.title.trim()).not.toBe('')
    expect(level.source.question).toMatch(/第\s*\d+\s*题/)
    expect(level.source.adaptation.length).toBeGreaterThan(20)
    expect(new URL(level.source.url).protocol).toBe('https:')
    expect(level.information.length).toBeGreaterThan(0)
    expect(level.retrosynthesis.length).toBeGreaterThan(20)
    expect(level.steps.every(step => step.explanation.length > 10 && step.pitfall.length > 10)).toBe(true)
    expect(level.warmup.correct).toBeGreaterThanOrEqual(0)
    expect(level.warmup.correct).toBeLessThan(level.warmup.options.length)
  })
})

describe('题库整体约束', () => {
  it('覆盖 2024、2025、2026 年以及高考、模拟两类来源', () => {
    expect([...new Set(levels.map(level => level.source.year))].sort()).toEqual([2024, 2025, 2026])
    expect(new Set(levels.map(level => level.source.kind))).toEqual(new Set(['高考', '模拟']))
  })

  it('关卡标识和编号唯一，所有关卡有实质性路线书写任务', () => {
    expect(new Set(levels.map(level => level.id)).size).toBe(levels.length)
    expect(new Set(levels.map(level => level.number)).size).toBe(levels.length)
    expect(levels.every(level => level.steps.length >= 3 && level.difficulty >= 4)).toBe(true)
  })

  it('先无水、再水解的标准条件能被识别，去掉后处理水也不能靠无水一词通过', () => {
    const level = levels.find(item => item.id === 'styrene-network')!
    const answers = standardAnswers(level)
    expect(assessRoute(level, answers, 0, false).complete).toBe(true)
    answers[3] = { ...answers[3], reagents: 'CH3MgBr', conditions: '先无水醚中反应，再结束' }
    const result = assessRoute(level, answers, 0, false)
    expect(result.complete).toBe(false)
    expect(result.steps[3].reagents).toBe(false)
  })

  it('LiAlH4 还原要求水后处理，不能把无水条件中的水当成反应试剂', () => {
    const level = levels.find(item => item.id === 'belinostat-chain')!
    const answers = standardAnswers(level)
    answers[0] = { ...answers[0], reagents: 'LiAlH4', conditions: '先无水条件还原，随后分离' }
    expect(assessRoute(level, answers, 0, false).steps[0].reagents).toBe(false)
  })
})
