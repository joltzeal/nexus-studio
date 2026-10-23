import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DEFAULT_PREFERENCES } from '@nexus/contracts'
import { PreferencesContext } from '@/app/preferences-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from './app-shell'

it('does not advertise plugin pages before an installed catalog is available', () => {
  const html = renderToStaticMarkup(
    createElement(
      PreferencesContext.Provider,
      {
        value: {
          preferences: DEFAULT_PREFERENCES,
          loading: true,
          loadError: null,
          saveError: null,
          saveStatus: 'idle',
          resolvedTheme: 'light',
          update: async () => false,
          reload: () => {},
          retrySave: async () => false,
        },
      },
      createElement(TooltipProvider, null, createElement(AppShell)),
    ),
  )
  expect(html).toContain('插件中心')
  expect(html).not.toContain('data-depth="sub"')
})
