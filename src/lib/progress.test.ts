import { describe, expect, it, vi } from 'vitest'
import { useGame } from '../hooks/useGame'
import { createEmptyProgress, readProgress } from './progress'

vi.mock('openchemlib', () => {
  throw new Error('The homepage must not import OpenChemLib')
})

describe('首页进度模块', () => {
  it('Hook 与进度读取无需加载化学引擎即可运行', () => {
    expect(useGame).toBeTypeOf('function')
    expect(readProgress({ getItem: () => null })).toEqual(createEmptyProgress())
  })
})
