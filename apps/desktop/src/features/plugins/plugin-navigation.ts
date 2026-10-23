import type { PluginView } from '@/lib/platform/native-plugins'

export interface PluginNavigationState {
  page: string
  plugins: PluginView[]
  catalogError: boolean
}

export type PluginNavigationAction =
  | { type: 'catalog'; plugins: PluginView[] }
  | { type: 'navigate'; page: string }
  | { type: 'error' }

export const initialPluginNavigation: PluginNavigationState = {
  page: 'spaces',
  plugins: [],
  catalogError: false,
}

export function pluginPageValue(id: string): string {
  return `plugin:${id}`
}

function accessiblePage(page: string, plugins: PluginView[]): string {
  if (['spaces', 'groups', 'plugins', 'settings'].includes(page)) return page
  return plugins.some((plugin) => pluginPageValue(plugin.id) === page) ? page : 'plugins'
}

export function pluginNavigationReducer(
  state: PluginNavigationState,
  action: PluginNavigationAction,
): PluginNavigationState {
  switch (action.type) {
    case 'catalog': {
      const plugins = action.plugins
        .filter((plugin) => plugin.enabled && plugin.state !== 'available')
        .sort((left, right) => left.id.localeCompare(right.id))
      return {
        plugins,
        page: accessiblePage(state.page, plugins),
        catalogError: false,
      }
    }
    case 'navigate':
      return { ...state, page: accessiblePage(action.page, state.plugins) }
    case 'error':
      // A failed refresh does not mean previously installed plugins disappeared.
      return { ...state, catalogError: true }
  }
}
