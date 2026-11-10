import { useEffect, useState } from 'react'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import {
  EMPTY_EXPIRY_STATE,
  NumberExpiryMonitor,
  type ExpiryAvailability,
} from './expiry-monitor'
import { SIM8_PLUGIN_ID } from './types'

const EXPIRY_METHODS = ['sim8.expiry.list', 'sim8.expiry.refresh', 'sim8.expiry.dismiss']

export function useNumberExpiry(refreshKey: number) {
  const [state, setState] = useState(EMPTY_EXPIRY_STATE)
  const [monitor] = useState(() => new NumberExpiryMonitor(setState))

  useEffect(() => {
    const unsubscribe = watchPluginCatalog(
      (plugins) => {
        const plugin = plugins.find(
          (item) =>
            item.id === SIM8_PLUGIN_ID && item.enabled && item.state !== 'available',
        )
        const availability: ExpiryAvailability = !plugin
          ? 'hidden'
          : plugin.state !== 'running'
            ? 'unavailable'
            : EXPIRY_METHODS.every((method) => plugin.methods.includes(method))
              ? 'ready'
              : 'upgrade'
        monitor.setAvailability(
          availability,
          `${availability}:${plugin?.version ?? ''}:${String(plugin?.status?.['pid'] ?? '')}`,
        )
      },
      () => monitor.setAvailability('unavailable'),
    )
    const timer = setInterval(() => void monitor.refresh(), 60_000)
    return () => {
      unsubscribe()
      clearInterval(timer)
      monitor.stop()
    }
  }, [monitor])

  useEffect(() => {
    void monitor.refresh()
  }, [monitor, refreshKey])
  return {
    ...state,
    refresh: () => void monitor.refresh(),
    dismiss: monitor.dismiss.bind(monitor),
  }
}
