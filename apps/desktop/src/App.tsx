import { PreferencesProvider } from '@/app/preferences-provider'
import { AppShell } from '@/components/app-shell'
import { TooltipProvider } from '@/components/ui/tooltip'
import './App.css'

export default function App() {
  return (
    <PreferencesProvider>
      <TooltipProvider delayDuration={250}>
        <AppShell />
      </TooltipProvider>
    </PreferencesProvider>
  )
}
