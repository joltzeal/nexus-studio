import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LicenseSettingsPage } from './license-settings-page'

describe('CloakBrowser license settings', () => {
  it('does not offer a fake license form in browser preview', () => {
    const html = renderToStaticMarkup(createElement(LicenseSettingsPage))

    expect(html).toContain('请在 Nexus 桌面应用中管理 CloakBrowser 授权')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('校验并保存')
  })
})
