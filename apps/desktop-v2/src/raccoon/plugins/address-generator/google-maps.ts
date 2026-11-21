import type { GeocodedAddress } from './google-geocode.ts'

export interface LatLng {
  lat(): number
  lng(): number
}
export interface MapInstance {
  addListener(
    event: 'click',
    handler: (event: { latLng: LatLng | null }) => void,
  ): { remove(): void }
  unbindAll(): void
}
export interface MapOverlay {
  onAdd(): void
  draw(): void
  onRemove(): void
  setMap(map: MapInstance | null): void
  getPanes(): { overlayLayer: HTMLElement } | null
  getProjection(): {
    fromLatLngToDivPixel(position: LatLng): { x: number; y: number } | null
  }
}
export interface MapsSdk {
  Map: new (
    element: HTMLElement,
    options: {
      center: { lat: number; lng: number }
      zoom: number
      colorScheme: 'DARK' | 'LIGHT'
      streetViewControl: boolean
      fullscreenControl: boolean
      mapTypeControl: boolean
      clickableIcons: boolean
    },
  ) => MapInstance
  LatLng: new (latitude: number, longitude: number) => LatLng
  OverlayView: new () => MapOverlay
  Geocoder: new () => {
    geocode(request: { location: LatLng }): Promise<{ results: GeocodedAddress[] }>
  }
  event: { clearInstanceListeners(instance: MapInstance): void }
}
type MapsWindow = Window & {
  google?: { maps: MapsSdk }
  gm_authFailure?: () => void
  [key: `__raccoonMapsReady${number}`]: (() => void) | undefined
}
const listeners = new Set<() => void>()
let state: { key: string; promise: Promise<MapsSdk>; failedAuth: boolean } | null = null
let attempt = 0
let installedAuth = false

export function onMapsAuthFailure(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function loadGoogleMaps(apiKey: string): Promise<MapsSdk> {
  if (state) {
    if (state.key !== apiKey) return Promise.reject(new Error('map-key'))
    if (state.failedAuth) return Promise.reject(new Error('map-auth'))
    return state.promise
  }
  const target = window as unknown as MapsWindow
  if (!installedAuth) {
    const previous = target.gm_authFailure
    target.gm_authFailure = () => {
      if (state) state.failedAuth = true
      for (const listener of listeners) listener()
      previous?.()
    }
    installedAuth = true
  }
  const callback = `__raccoonMapsReady${++attempt}` as const
  const script = document.createElement('script')
  script.async = true
  script.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? ''
  let resolve!: (sdk: MapsSdk) => void
  let reject!: (error: Error) => void
  const promise = new Promise<MapsSdk>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  const pending = { key: apiKey, promise, failedAuth: false }
  state = pending
  let settled = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    window.clearTimeout(timer)
    target[callback] = () => {}
    const failure = error ?? (target.google?.maps ? undefined : new Error('map-load'))
    if (failure) {
      if (state === pending && !pending.failedAuth) state = null
      script.remove()
      reject(failure)
    } else resolve(target.google!.maps)
  }
  const timer = window.setTimeout(() => finish(new Error('map-load')), 25_000)
  target[callback] = () => finish(pending.failedAuth ? new Error('map-auth') : undefined)
  script.addEventListener('error', () => finish(new Error('map-load')), { once: true })
  const params = new URLSearchParams({
    key: apiKey,
    v: 'weekly',
    libraries: 'geocoding',
    loading: 'async',
    auth_referrer_policy: 'origin',
    callback,
  })
  script.src = `https://maps.googleapis.com/maps/api/js?${params}`
  document.head.appendChild(script)
  return pending.promise
}
