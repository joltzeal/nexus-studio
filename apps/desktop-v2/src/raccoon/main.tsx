import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from '@proxyshard/shardx-ui-kit'
import '../app/fonts'
import '../app/styles/index.css'
import '../app/styles/app.css'
import { KitLabels } from '../app/KitLabels'
import { NativeThemeSync } from '../app/nativeTheme'
import { installWindowGuards } from '../app/guards'
import { installPinScrollFocus } from '../shared/lib/pinScrollFocus'
import { installScrollActivity } from '../shared/lib/scrollActivity'

installWindowGuards()
installPinScrollFocus()
installScrollActivity()

const panelParams = new URLSearchParams(window.location.hash.replace(/^#\/?\??/, ''))
const helperProfile = panelParams.get('helperPanel')
const panel = panelParams.has('fleet') || panelParams.has('helperPanel')
if (!panel) void import('./app-meta').then(({ loadAppVersion }) => loadAppVersion())
if (!panel)
  void import('./update').then(({ startAppUpdateChecks }) => startAppUpdateChecks())
async function loadScreen() {
  if (panel) {
    const { NativeAutomationPanel } = await import('./automation/connect')
    return (
      <NativeAutomationPanel
        connectionId={panelParams.get('connectionId')}
        helperProfile={helperProfile}
      />
    )
  }
  // The imported Profile stores register UI callbacks during evaluation.
  // Load their page entry before adapters so their existing cycles settle
  // in the same order as the upstream application.
  const { NativeApplication } = await import('./Application')
  const [
    { connectProfileTable },
    { workspace },
    { connectTrash },
    { connectGlobalProxyLibrary },
    { connectAutomation },
    { connectShardBrowserLibraries },
  ] = await Promise.all([
    import('./profile-adapter'),
    import('./store'),
    import('./trash-adapter'),
    import('./proxy-adapter'),
    import('./automation/connect'),
    import('./shardbrowser-library-adapter'),
  ])
  const disconnectProfiles = connectProfileTable(workspace)
  connectGlobalProxyLibrary()
  const disconnectTrash = connectTrash(workspace)
  const disconnectAutomation = connectAutomation(workspace)
  const disconnectShardBrowserLibraries = connectShardBrowserLibraries(workspace)
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      disconnectProfiles()
      disconnectTrash()
      disconnectAutomation()
      disconnectShardBrowserLibraries()
    })
  return <NativeApplication />
}
void loadScreen().then((screen) => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <NativeThemeSync />
        <KitLabels>{screen}</KitLabels>
      </ThemeProvider>
    </React.StrictMode>,
  )
})
