import type { PluginView } from '@/lib/platform/native-plugins'

export interface PluginNavigationState {
  page: string
  history: string[]
  visitedPages: string[]
  catalogLoaded: boolean
  plugins: PluginView[]
  catalogError: boolean
}

export type PluginNavigationAction =
  | { type: 'catalog'; plugins: PluginView[] }
  | { type: 'navigate'; page: string; awaitCatalog?: boolean }
  | { type: 'back' }
  | { type: 'error' }

export const initialPluginNavigation: PluginNavigationState = {
  page: 'spaces',
  history: [],
  visitedPages: ['spaces'],
  catalogLoaded: false,
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
      const page = accessiblePage(state.page, plugins)
      const history = state.history.filter(
        (value) => accessiblePage(value, plugins) === value,
      )
      while (history[history.length - 1] === page) history.pop()
      return {
        plugins,
        page,
        catalogLoaded: true,
        history,
        visitedPages: [
          ...new Set([
            ...state.visitedPages.filter(
              (value) => accessiblePage(value, plugins) === value,
            ),
            page,
          ]),
        ],
        catalogError: false,
      }
    }
    case 'navigate': {
      const page =
        action.awaitCatalog && !state.catalogLoaded && action.page.startsWith('plugin:')
          ? action.page
          : accessiblePage(action.page, state.plugins)
      if (page === state.page) return state
      return {
        ...state,
        page,
        history: [...state.history, state.page].slice(-50),
        visitedPages: [...new Set([...state.visitedPages, page])],
      }
    }
    case 'back': {
      const page = state.history[state.history.length - 1]
      if (!page) return state
      return { ...state, page, history: state.history.slice(0, -1) }
    }
    case 'error':
      // A failed refresh does not mean previously installed plugins disappeared.
      return { ...state, catalogError: true }
  }
}
