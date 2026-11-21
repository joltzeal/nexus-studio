import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SalesAgentPage } from './index'
import { agentDependencyPlugins, agentPlugin } from './test-data'
import { PluginNavigationIcon } from '../../../raccoon/plugins/PluginNavigationIcon'

vi.mock('../../../raccoon/runtime', () => ({ isNativeRaccoon: () => true }))
vi.mock('../../../widgets/PageHeader', async () => {
  const React = await import('react')
  return {
    PageHeader: ({ title, actions }: { title: string; actions: React.ReactNode }) =>
      React.createElement('header', null, title, actions),
    PageBody: ({ children }: { children: React.ReactNode }) =>
      React.createElement('main', null, children),
  }
})
vi.mock('../../../raccoon/plugins/catalog', async () => {
  const fixtures = await import('./test-data')
  const state = {
    plugins: [fixtures.agentPlugin(), ...fixtures.agentDependencyPlugins()],
    error: null,
  }
  return { usePluginCatalog: (select: (value: typeof state) => unknown) => select(state) }
})

describe('desktop-v2 Agent workspace', () => {
  it('keeps preparation, durable runs and review reachable inside the application card', () => {
    const markup = renderToStaticMarkup(
      <SalesAgentPage connectionId="local" onManage={vi.fn()} />,
    )
    for (const label of [
      'Ecom Agent',
      '模型与执行设置',
      '创建任务',
      '运行记录',
      '待处理与审查',
      '运行前检查',
      '商品',
      'Profile',
      '草稿',
    ])
      expect(markup.includes(label), label).toBe(true)
    expect(markup).toContain('data-plugin-card')
    expect(markup).not.toContain('尚未接入')
    expect(markup).not.toContain('legacy-pages')
    expect(markup).not.toContain('text-muted-foreground')
  })

  it('keeps history available without letting a missing Workspace select Profiles', () => {
    const markup = renderToStaticMarkup(
      <SalesAgentPage connectionId={null} onManage={vi.fn()} />,
    )
    expect(markup).toContain('请先选择已配置的 Workspace')
    expect(markup).toContain('运行记录')
    expect(markup).not.toContain('执行Profile')
  })

  it('renders declared paths with inherited ink and preserves the missing-icon fallback', () => {
    const icon = { viewBox: '0 0 24 24' as const, paths: ['M3 4h8v9z', 'M4 8h4'] }
    const markup = renderToStaticMarkup(
      <PluginNavigationIcon
        plugin={agentPlugin({
          ui: { protocolVersion: 1, navigation: { icon }, services: [] },
        })}
        className="size-3.5"
      />,
    )
    expect(markup).toContain('stroke="currentColor"')
    expect(markup).toContain('fill="none"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('d="M3 4h8v9z"')
    expect(markup).not.toContain('<image')
    const fallback = renderToStaticMarkup(
      <PluginNavigationIcon plugin={null} className="size-3.5" />,
    )
    expect(fallback).toContain('<svg')
    expect(fallback).not.toContain('M3 4h8v9z')
    expect(agentDependencyPlugins()).toHaveLength(2)
  })
})
