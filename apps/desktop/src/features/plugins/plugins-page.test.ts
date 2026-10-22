import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PluginsPage } from './plugins-page'

const html = renderToStaticMarkup(createElement(PluginsPage))

describe('plugin center without a host', () => {
  it('says the host only runs in the desktop app instead of faking a state', () => {
    expect(html).toContain('插件宿主只在 Nexus 桌面应用中运行')
    expect(html).toContain('不能安装或启用')
  })

  it('still shows the bundled package by its manifest declaration', () => {
    expect(html).toContain('随仓库提供')
    expect(html).toContain('代理池')
    expect(html).toContain('proxy.provider')
    expect(html).toContain('仅桌面应用')
  })

  it('never claims the plugin is installed, enabled or running', () => {
    expect(html).not.toContain('已安装')
    expect(html).not.toContain('已启用')
    expect(html).not.toContain('运行中')
    expect(html).not.toContain('授权成功')
  })

  it('keeps the remaining capability placeholders as demo entries', () => {
    expect(html).toContain('演示占位')
    expect(html).toContain('待接入')
    expect(html).toContain('platform.adapter')
    expect(html).toContain('verification.provider')
    expect(html).toContain('image.provider')
    expect(html).toContain('environment.configurator')
  })
})
