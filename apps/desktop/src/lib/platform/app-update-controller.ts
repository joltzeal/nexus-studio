import {
  AppUpdateError,
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  type AvailableUpdate,
} from './app-updates'

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'installed'
  | 'error'

export interface AppUpdateSnapshot {
  phase: UpdatePhase
  version: string | null
  downloaded: number
  total: number | null
  error: AppUpdateError | null
}

const initialSnapshot: AppUpdateSnapshot = {
  phase: 'idle',
  version: null,
  downloaded: 0,
  total: null,
  error: null,
}

/** One owner for the native update and its verified bytes, independent of pages. */
export function createAppUpdateController() {
  let snapshot = initialSnapshot
  let prepared: AvailableUpdate | null = null
  let pending: Promise<void> | null = null
  let generation = 0
  const listeners = new Set<() => void>()

  function publish(next: AppUpdateSnapshot) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  async function prepareUpdate(session: number) {
    let candidate: AvailableUpdate | null = null
    publish({ ...initialSnapshot, phase: 'checking' })
    try {
      candidate = await checkAppUpdate()
      if (session !== generation) return
      if (!candidate) {
        publish({ ...initialSnapshot, phase: 'up-to-date' })
        return
      }
      publish({ ...initialSnapshot, phase: 'downloading', version: candidate.version })
      await downloadAppUpdate(candidate, (downloaded, total) => {
        if (session === generation) publish({ ...snapshot, downloaded, total })
      })
      if (session !== generation) return
      prepared = candidate
      candidate = null
      publish({ ...snapshot, phase: 'ready' })
    } catch (cause) {
      if (session !== generation) return
      const error =
        cause instanceof AppUpdateError ? cause : new AppUpdateError('check_failed')
      publish({ ...snapshot, phase: 'error', error })
      throw error
    } finally {
      await candidate?.close().catch(() => {})
    }
  }

  async function installPrepared(session: number, candidate: AvailableUpdate) {
    prepared = null
    publish({ ...snapshot, phase: 'installing', error: null })
    let retained = false
    try {
      await installAppUpdate(candidate)
      if (session === generation) publish({ ...snapshot, phase: 'installed' })
    } catch (cause) {
      if (session !== generation) return
      const error =
        cause instanceof AppUpdateError ? cause : new AppUpdateError('install_failed')
      if (error.code === 'relaunch_failed') {
        publish({ ...snapshot, phase: 'installed', error })
      } else if (error.code === 'signature') {
        publish({ ...snapshot, phase: 'error', error })
      } else {
        // A blocked or failed installation can retry the already verified package.
        prepared = candidate
        retained = true
        publish({ ...snapshot, phase: 'ready', error })
      }
      throw error
    } finally {
      if (!retained) await candidate.close().catch(() => {})
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    prepare(): Promise<void> {
      if (pending) return pending
      if (prepared || snapshot.phase === 'installed') return Promise.resolve()
      const session = generation
      pending = Promise.resolve()
        .then(() => {
          if (session === generation) return prepareUpdate(session)
        })
        .finally(() => {
          if (session === generation) pending = null
        })
      return pending
    },
    install(): Promise<void> {
      if (pending && snapshot.phase === 'installing') return pending
      if (!prepared || pending) {
        return Promise.reject(new AppUpdateError('not_downloaded'))
      }
      const session = generation
      const candidate = prepared
      // Set the phase before yielding so repeated clicks share the same operation.
      pending = Promise.resolve()
        .then(() => {
          if (session === generation) return installPrepared(session, candidate)
        })
        .finally(() => {
          if (session === generation) pending = null
        })
      publish({ ...snapshot, phase: 'installing', error: null })
      return pending
    },
    dispose() {
      generation += 1
      const previous = prepared
      prepared = null
      pending = null
      publish(initialSnapshot)
      void previous?.close().catch(() => {})
    },
  }
}

export type AppUpdateController = ReturnType<typeof createAppUpdateController>
export const appUpdateController = createAppUpdateController()
