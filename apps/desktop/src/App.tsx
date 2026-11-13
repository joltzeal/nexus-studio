import { lazy, Suspense, useEffect } from 'react'
import { PreferencesProvider } from '@/app/preferences-provider'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { startAppUpdateNotifications } from '@/lib/platform/app-update-notifications'
import { startAgentDeepLinks } from '@/lib/platform/agent-deep-links'
import './App.css'

const salesAgentDemo =
  import.meta.env.DEV && window.location.pathname === '/__demo/sales-agent'
const SalesAgentDemo = lazy(() => import('@/features/sales-agent-demo/sales-agent-demo'))
const AppShell = lazy(() =>
  import('@/components/app-shell').then((module) => ({ default: module.AppShell })),
)

export default function App() {
  useEffect(() => {
    if (!salesAgentDemo) return startAppUpdateNotifications()
  }, [])
  useEffect(() => {
    if (!salesAgentDemo) return startAgentDeepLinks()
  }, [])

  if (salesAgentDemo) {
    return (
      <TooltipProvider delayDuration={250}>
        <Suspense
          fallback={
            <div className="shell-loading" role="status">
              正在打开交互预览…
            </div>
          }
        >
          <SalesAgentDemo />
        </Suspense>
        <Toaster />
      </TooltipProvider>
    )
  }

  return (
    <PreferencesProvider>
      <TooltipProvider delayDuration={250}>
        <Suspense
          fallback={
            <div className="shell-loading" role="status">
              正在打开工作区…
            </div>
          }
        >
          <AppShell />
        </Suspense>
        <Toaster />
      </TooltipProvider>
    </PreferencesProvider>
  )
}
