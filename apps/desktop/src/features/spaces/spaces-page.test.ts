import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SpacesPage } from './spaces-page'

describe('window management', () => {
  it('does not offer a local-only window creation flow in a web preview', () => {
    const html = renderToStaticMarkup(createElement(SpacesPage))
    expect(html).not.toContain('浏览器 Profiles')
    expect(html).not.toContain('配置保存在本地')
    expect(html).toContain('请在 Nexus 桌面应用中创建和打开窗口')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?创建窗口<\/button>/s)
  })
})
