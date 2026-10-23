import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TransferRecoveryNotice } from './transfer-recovery'

const defaults = {
  status: null,
  error: null,
  checking: false,
  onRetry: () => undefined,
}

describe('window transfer recovery notice', () => {
  it('leaves the initial page and confirmed zero-pending status free of recovery alerts', () => {
    expect(renderToStaticMarkup(createElement(TransferRecoveryNotice, defaults))).toBe('')
    expect(
      renderToStaticMarkup(
        createElement(TransferRecoveryNotice, {
          ...defaults,
          status: { pending: 0, warnings: ['过期的待恢复提示'] },
        }),
      ),
    ).toBe('')
  })

  it('shows actual pending warnings and an explicit retry action', () => {
    const html = renderToStaticMarkup(
      createElement(TransferRecoveryNotice, {
        ...defaults,
        status: {
          pending: 1,
          warnings: [
            '上次窗口迁移的插件资料尚待恢复，请安装或更新所需插件后刷新重试。',
            'studio.proxy-pool',
          ],
        },
      }),
    )
    expect(html).toContain('上次窗口迁移的插件资料尚待恢复')
    expect(html).toContain('studio.proxy-pool')
    expect(html).toContain('重试恢复')
    expect(html).not.toContain('已恢复')
  })

  it('still explains pending recovery if the backend has no detailed warning', () => {
    const html = renderToStaticMarkup(
      createElement(TransferRecoveryNotice, {
        ...defaults,
        status: { pending: 1, warnings: [] },
      }),
    )
    expect(html).toContain('请安装或更新所需插件后刷新重试')
  })

  it('shows a status failure separately while retaining prior pending warnings', () => {
    const html = renderToStaticMarkup(
      createElement(TransferRecoveryNotice, {
        ...defaults,
        status: { pending: 1, warnings: ['studio.proxy-pool 尚待恢复'] },
        error: '读取状态超时，恢复结果尚未确认。',
        checking: true,
      }),
    )
    expect(html).toContain('studio.proxy-pool 尚待恢复')
    expect(html).toContain('恢复结果尚未确认')
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).not.toContain('已恢复')
  })

  it('does not turn an unknown recovery status into a success or a pending count', () => {
    const html = renderToStaticMarkup(
      createElement(TransferRecoveryNotice, {
        ...defaults,
        error: '恢复状态接口暂不可用',
      }),
    )
    expect(html).toContain('恢复状态接口暂不可用')
    expect(html).toContain('重试恢复')
    expect(html).not.toContain('已恢复')
    expect(html).not.toContain('项待恢复')
  })
})
