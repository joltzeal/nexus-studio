const CALLBACK_NAME = '__nexusMapsReady'
const SCRIPT_ID = 'nexus-google-maps'

type MapsWindow = Window & {
  [CALLBACK_NAME]?: () => void
  gm_authFailure?: () => void
}

const authListeners = new Set<() => void>()
let state: { key: string; promise: Promise<void> } | null = null

/** Google calls `gm_authFailure` when the key is rejected; the page must say so. */
export function onMapsAuthFailure(listener: () => void): () => void {
  authListeners.add(listener)
  return () => {
    authListeners.delete(listener)
  }
}

function notifyAuthFailure(): void {
  for (const listener of authListeners) listener()
}

/**
 * The Maps JS API can only be bootstrapped once per document, and the key is
 * baked into that request. Asking for a different key after the fact is a real
 * conflict, so it is reported instead of silently keeping the old key.
 */
export function loadGoogleMaps(apiKey: string): Promise<void> {
  if (state !== null) {
    return state.key === apiKey ? state.promise : Promise.reject(new Error('map-key'))
  }
  const target = window as MapsWindow
  if (target.gm_authFailure === undefined) {
    target.gm_authFailure = () => notifyAuthFailure()
  }
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.async = true
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('map-load'))
    }, 25_000)
    target[CALLBACK_NAME] = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    script.addEventListener('error', () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(new Error('map-load'))
    })
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      libraries: 'geocoding,marker',
      loading: 'async',
      auth_referrer_policy: 'origin',
      callback: CALLBACK_NAME,
    })
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`
    document.head.appendChild(script)
  })
  state = { key: apiKey, promise }
  // A failed bootstrap must be retryable, so drop the memoised attempt.
  void promise.catch(() => {
    state = null
    document.getElementById(SCRIPT_ID)?.remove()
  })
  return promise
}

/** Test seam: forget the bootstrap so a fresh attempt can be observed. */
export function resetGoogleMapsLoader(): void {
  state = null
  document.getElementById(SCRIPT_ID)?.remove()
}
