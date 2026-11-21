import { useEffect, useRef } from 'react'

export function usePluginTask() {
  const session = useRef({ generation: 0, mounted: false, locked: false })
  useEffect(() => {
    session.current.mounted = true
    return () => {
      session.current.mounted = false
      session.current.generation++
    }
  }, [])
  const begin = () => session.current.generation
  const current = (token: number) =>
    session.current.mounted && token === session.current.generation
  const acquire = () => {
    if (session.current.locked || !session.current.mounted) return false
    session.current.locked = true
    return true
  }
  const release = () => {
    session.current.locked = false
  }
  return { begin, current, acquire, release }
}
