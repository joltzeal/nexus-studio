import { useEffect } from 'react'
import { PreferencesProvider } from '@/app/preferences-provider'
import { AppShell } from '@/components/app-shell'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { startAppUpdateNotifications } from '@/lib/platform/app-update-notifications'
import './App.css'

export default function App() {
  useEffect(() => startAppUpdateNotifications(), [])

  return (
    <PreferencesProvider>
      <TooltipProvider delayDuration={250}>
        <AppShell />
        <Toaster />
      </TooltipProvider>
    </PreferencesProvider>
  )
}
