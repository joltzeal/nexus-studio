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

  it('keeps migration controls disabled and renders no fabricated windows in a preview', () => {
    const html = renderToStaticMarkup(createElement(SpacesPage))
    const buttons =
      html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
    for (const label of ['导出', '导入', '设备同步']) {
      expect(buttons.find((button) => button.endsWith(`${label}</button>`))).toMatch(
        /\bdisabled=""/,
      )
    }
    expect(html).toContain('全选当前筛选下的已关闭窗口')
    expect(html).toContain('已选 0')
    expect(html).toContain('还没有窗口')
  })
})
