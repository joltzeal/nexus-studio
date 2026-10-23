import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WindowKernelPicker } from './window-kernel-picker'

const props = {
  value: { kind: 'base' as const },
  onChange: vi.fn(),
  license: { configured: true, plan: 'free', expires: null },
  installed: [
    { kind: 'base' as const, version: '145.0.7632.109.2', binaryPath: '/base/browser' },
    {
      kind: 'latest' as const,
      version: '155.0.8059.39.1',
      binaryPath: '/latest/browser',
    },
  ],
  loading: false,
  error: null,
  disabled: false,
}

describe('window kernel picker', () => {
  it('offers base selection even when a free activation is configured', () => {
    const html = renderToStaticMarkup(createElement(WindowKernelPicker, props))

    expect(html).toMatch(/<button[^>]*data-state="on"[^>]*>基础内核<\/button>/)
    expect(html).toContain('指定基础版本（可选）')
    expect(html).toContain('window-base-version')
    expect(html).toContain('保存激活码不会更换此窗口的内核')
    expect(html).not.toContain('window-browser-version')
  })

  it('disables only the latest option when no activation is configured', () => {
    const html = renderToStaticMarkup(
      createElement(WindowKernelPicker, { ...props, license: null }),
    )

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>最新内核<\/button>/)
    const base = html.match(/<button\b[^>]*>基础内核<\/button>/)?.[0]
    expect(base).toBeDefined()
    expect(base).not.toContain('disabled=""')
  })

  it('shows the actual selected base version without labelling every platform as 145', () => {
    const html = renderToStaticMarkup(
      createElement(WindowKernelPicker, {
        ...props,
        value: { kind: 'base', version: '146.0.7680.177.5' },
        installed: [
          { kind: 'base', version: '146.0.7680.177.5', binaryPath: '/base/chrome.exe' },
        ],
      }),
    )

    expect(html).toContain('value="146.0.7680.177.5"')
    expect(html).not.toContain('145')
  })

  it('explains free latest concurrency without offering unsupported version pinning', () => {
    const html = renderToStaticMarkup(
      createElement(WindowKernelPicker, { ...props, value: { kind: 'latest' } }),
    )

    expect(html).toContain('免费计划同时最多打开一个新版内核窗口')
    expect(html).toContain('Chromium 155.0.8059.39.1')
    expect(html).not.toContain('window-base-version')
    expect(html).not.toContain('window-browser-version')
  })

  it('retains exact latest version selection for a supported plan', () => {
    const html = renderToStaticMarkup(
      createElement(WindowKernelPicker, {
        ...props,
        license: { configured: true, plan: 'pro', expires: null },
        value: { kind: 'latest', version: '154.0.1.2.3' },
      }),
    )

    expect(html).toContain('window-browser-version')
    expect(html).toContain('154.0.1.2.3')
  })

  it('keeps default base creation available if inventory cannot be read', () => {
    const html = renderToStaticMarkup(
      createElement(WindowKernelPicker, {
        ...props,
        installed: [],
        error: 'unavailable',
      }),
    )

    expect(html).toContain('本地版本暂时无法读取，仍可填写版本；留空即可使用默认基础版本')
    expect(html).not.toContain('disabled=""')
  })
})
