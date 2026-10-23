import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AppUpdateControls } from './app-update-controls'
import { AppUpdateError } from '@/lib/platform/app-updates'
import type { AppUpdateSnapshot } from '@/lib/platform/app-update-controller'

const initial: AppUpdateSnapshot = {
  phase: 'idle',
  version: null,
  downloaded: 0,
  total: null,
  error: null,
}

function render(state: Partial<AppUpdateSnapshot>) {
  return renderToStaticMarkup(
    createElement(AppUpdateControls, {
      state: { ...initial, ...state },
      onCheck: vi.fn(),
      onInstall: vi.fn(),
    }),
  )
}

it('keeps installation unavailable while a background package is still downloading or verifying', () => {
  const downloading = render({
    phase: 'downloading',
    version: '0.1.6',
    downloaded: 40,
    total: 100,
  })
  expect(downloading).toContain('40%')
  expect(downloading).not.toContain('立即更新')
  expect(downloading).toMatch(/<button[^>]*disabled=""/)
  const verifying = render({ phase: 'downloading', downloaded: 100, total: 100 })
  expect(verifying).toContain('验证更新包')
  expect(verifying).not.toContain('立即更新')
})

it('offers an immediate install from the shared ready state, including after a blocked attempt', () => {
  const html = render({
    phase: 'ready',
    version: '0.1.6',
    error: new AppUpdateError('running_windows'),
  })
  expect(html).toContain('0.1.6 已下载')
  expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>立即更新<\/button>/)
  expect(html).toContain('先停止所有运行中的窗口')
  expect(html).toContain('role="alert"')
})

it('does not offer installation again when the update is installed but restart failed', () => {
  const html = render({
    phase: 'installed',
    version: '0.1.6',
    error: new AppUpdateError('relaunch_failed'),
  })
  expect(html).not.toContain('立即更新')
  expect(html).toContain('手动重新打开应用')
  expect(html).toMatch(/<button[^>]*disabled=""/)
})
