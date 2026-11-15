import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PluginsPage } from './plugins-page'

const html = renderToStaticMarkup(createElement(PluginsPage))

describe('plugin center without a host', () => {
  it('shows a desktop-only empty catalog instead of bundled private packages', () => {
    expect(html).toContain('插件中心')
    expect(html).toContain('仅桌面应用')
    expect(html).not.toContain('aria-label="插件列表"')
    expect(html).not.toContain('studio.')
    expect(html).not.toContain('proxy.provider')
    expect(html).not.toContain('verification.provider')
    expect(html).not.toContain('SIM8 接码')
  })

  it('disables host actions without offering fake installations', () => {
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>.*?检查更新<\/button>/s)
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>.*?商店设置<\/button>/s)
    expect(html).not.toMatch(/>安装<\/button>/)
    expect(html).not.toMatch(/>重新安装<\/button>/)
  })

  it('never claims a plugin is installed or running', () => {
    expect(html).not.toContain('已安装')
    expect(html).not.toContain('运行中')
    expect(html).not.toContain('启动中')
    expect(html).not.toContain('授权成功')
  })

  it('drops the demo placeholders and the manifest button label', () => {
    expect(html).not.toContain('演示占位')
    expect(html).not.toContain('待接入')
    expect(html).not.toContain('查看清单')
    expect(html).not.toContain('platform.adapter')
    expect(html).not.toContain('demo.')
  })

  it('keeps the page free of explanation copy', () => {
    expect(html).not.toContain('page-description')
    expect(html).not.toContain('能力需逐项授权')
    expect(html).not.toContain('不能安装或启用')
  })
})
