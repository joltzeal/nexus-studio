import { useEffect, useState } from 'react'
import { agentError } from './api'

export interface QueryState<T> {
  key: string
  data: T | null
  error: string | null
}

/** The loader belongs to the key; a new key invalidates in-flight reads on cleanup. */
export function useAgentQuery<T>(key: string, load: () => Promise<T>, interval = 0) {
  const [result, setResult] = useState<QueryState<T>>({
    key: '',
    data: null,
    error: null,
  })
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      try {
        const data = await load()
        if (active) setResult({ key, data, error: null })
      } catch (cause) {
        if (active)
          setResult((previous) => ({
            key,
            data: previous.key === key ? previous.data : null,
            error: agentError(cause),
          }))
      } finally {
        if (active && interval > 0)
          timer = setTimeout(() => {
            void read()
          }, interval)
      }
    }
    void read()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
    // Callers encode every loader input in key, avoiding re-fetching on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interval])
  const current = result.key === key ? result : { key, data: null, error: null }
  return { ...current, loading: current.data === null && current.error === null }
}
