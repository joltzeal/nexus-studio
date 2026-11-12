import { useEffect, useState, useSyncExternalStore } from 'react'
import { EmailAction } from './action-state'
import type { EmailReaderStore, EmailResource } from './async-state'

export function useEmailResource<P, T>(resource: EmailResource<P, T>, pollMs?: number) {
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  )
  useEffect(() => {
    resource.start(pollMs)
    return () => resource.dispose()
  }, [resource, pollMs])
  return snapshot
}

export function useEmailAction(failure: string) {
  const [action] = useState(() => new EmailAction(failure))
  const snapshot = useSyncExternalStore(
    action.subscribe,
    action.getSnapshot,
    action.getSnapshot,
  )
  useEffect(() => {
    action.start()
    return () => action.dispose()
  }, [action])
  return { action, ...snapshot }
}

export function useEmailReader(store: EmailReaderStore, onChanged?: () => void) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  useEffect(() => {
    store.setOnChanged(onChanged)
  }, [store, onChanged])
  useEffect(() => {
    store.start()
    return () => store.dispose()
  }, [store])
  return snapshot
}
