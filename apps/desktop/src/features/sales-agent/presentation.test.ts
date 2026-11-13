import { describe, expect, it } from 'vitest'
import { moneyLabel, recoveryHint, retrySeconds, stageLabel } from './presentation'

describe('Agent business progress', () => {
  it('translates workflow and isolation stages without exposing unknown internals', () => {
    expect(stageLabel('image_review')).toBe('检查商品图片')
    expect(stageLabel('capture_baseline')).toBe('核对提交前记录')
    expect(stageLabel('sync')).toBe('同步发布记录')
    expect(stageLabel('isolating')).toBe('正在隔离执行窗口')
    expect(stageLabel('future_internal_stage')).toBe('正在处理')
    expect(stageLabel('')).toBe('等待开始')
  })

  it('keeps unknown submissions and pending sync recovery distinct', () => {
    expect(recoveryHint('result_unknown')).toContain('核对结果')
    expect(recoveryHint('result_unknown')).toContain('不要重复提交')
    expect(recoveryHint('sync_pending')).toContain('同步记录')
    expect(recoveryHint('blocked')).toContain('禁止写入')
  })

  it('counts down from a persisted retry time and distinguishes missing times', () => {
    const now = Date.parse('2026-11-13T00:00:00Z')
    expect(retrySeconds('2026-11-13T00:00:02.001Z', now)).toBe(3)
    expect(retrySeconds('2026-11-13T00:00:00Z', now)).toBe(0)
    expect(retrySeconds('2026-11-12T23:59:59Z', now)).toBe(0)
    expect(retrySeconds(null, now)).toBeNull()
    expect(retrySeconds('invalid', now)).toBeNull()
  })

  it('never represents unknown model cost as free', () => {
    expect(moneyLabel(null)).toBe('费用未知')
    expect(moneyLabel(0)).toContain('0.0000')
    expect(moneyLabel(1.25)).toContain('1.2500')
  })
})
