import { useCallback, useState } from 'react'
import type { DemoState } from './model'
import { getDemoRepository } from './repository'

interface DemoSnapshot {
  state: DemoState | null
  error: string | null
}

export interface DemoWorkspace extends DemoSnapshot {
  save(next: DemoState): boolean
  reload(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : '暂时无法读写本地数据，请检查本机存储权限后重试。'
}

function loadSnapshot(): DemoSnapshot {
  try {
    return { state: getDemoRepository().load(), error: null }
  } catch (error) {
    return { state: null, error: errorMessage(error) }
  }
}

export function useDemoWorkspace(): DemoWorkspace {
  const [snapshot, setSnapshot] = useState<DemoSnapshot>(loadSnapshot)

  const save = useCallback((next: DemoState): boolean => {
    try {
      const state = getDemoRepository().save(next)
      setSnapshot({ state, error: null })
      return true
    } catch (error) {
      const message = errorMessage(error)
      setSnapshot((current) => ({ state: current.state, error: message }))
      return false
    }
  }, [])

  const reload = useCallback((): void => {
    setSnapshot(loadSnapshot())
  }, [])

  return { ...snapshot, save, reload }
}
