import { useEffect, useRef, useState } from 'react'
import { Alert, Button, useTheme } from '@proxyshard/shardx-ui-kit'
import {
  loadGoogleMaps,
  onMapsAuthFailure,
} from '../../../raccoon/plugins/address-generator/google-maps'
import { normalizeGoogleAddress } from '../../../raccoon/plugins/address-generator/google-geocode'
import {
  createPickerSession,
  type PickState,
} from '../../../raccoon/plugins/address-generator/picker-session'
import type {
  Address,
  City,
  Profile,
} from '../../../raccoon/plugins/address-generator/model'

const errors: Record<string, string> = {
  'map-key': '地图已使用另一个构建配置加载，请重启应用后使用当前版本',
  'map-auth': '地图授权失败，请联系应用维护者检查地图服务配置、API 授权和来源限制',
  'map-load': '地图加载失败，请检查网络后重试',
}
export function MapCanvas({
  apiKey,
  city,
  busy,
  prepare,
  onPick,
}: {
  apiKey: string
  city: City
  busy: boolean
  prepare: (address: Address) => Promise<Profile>
  onPick: (state: PickState | null) => void
}) {
  const { resolvedTheme } = useTheme()
  const container = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ busy, prepare, onPick })
  callbacks.current = { busy, prepare, onPick }
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    let alive = true
    let cleanup = () => {}
    setLoading(true)
    setError(null)
    callbacks.current.onPick(null)
    const session = createPickerSession(
      (address) => callbacks.current.prepare(address),
      (state) => {
        if (alive) callbacks.current.onPick(state)
      },
    )
    const offAuth = onMapsAuthFailure(() => {
      session.dispose()
      if (!alive) return
      setLoading(false)
      setError(errors['map-auth']!)
      callbacks.current.onPick(null)
    })
    void loadGoogleMaps(apiKey)
      .then((maps) => {
        if (!alive) return
        const map = new maps.Map(element, {
          center: { lat: city.latitude, lng: city.longitude },
          zoom: 16,
          colorScheme: resolvedTheme === 'dark' ? 'DARK' : 'LIGHT',
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: false,
          clickableIcons: false,
        })
        const geocoder = new maps.Geocoder()
        let position: InstanceType<typeof maps.LatLng> | null = null
        const pin = document.createElement('div')
        pin.className =
          'absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-white-0 bg-primary-base shadow-(--shadow-sm) pointer-events-none'
        const overlay = new maps.OverlayView()
        overlay.onAdd = () => {
          overlay.getPanes()?.overlayLayer.appendChild(pin)
        }
        overlay.draw = () => {
          if (!position) {
            pin.hidden = true
            return
          }
          const point = overlay.getProjection().fromLatLngToDivPixel(position)
          pin.hidden = point === null
          if (point) {
            pin.style.left = `${point.x}px`
            pin.style.top = `${point.y}px`
          }
        }
        overlay.onRemove = () => pin.remove()
        overlay.setMap(map)
        const click = map.addListener('click', (event) => {
          if (!event.latLng || callbacks.current.busy) return
          const location = event.latLng
          position = location
          overlay.draw()
          void session.select(async () => {
            try {
              const response = await geocoder.geocode({ location })
              return normalizeGoogleAddress(response.results, city.country)
            } catch (cause) {
              const code = cause instanceof Error ? cause.message : String(cause)
              throw new Error(
                code.includes('ZERO_RESULTS')
                  ? '这里没有完整门牌地址，请放大后选择建筑物'
                  : '地址解析失败，请检查 Geocoding API、配额和网络后重试',
              )
            }
          })
        })
        cleanup = () => {
          click.remove()
          overlay.setMap(null)
          maps.event.clearInstanceListeners(map)
          map.unbindAll()
        }
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setLoading(false)
        setError(
          errors[cause instanceof Error ? cause.message : ''] ?? errors['map-load']!,
        )
      })
    return () => {
      alive = false
      session.dispose()
      offAuth()
      cleanup()
      element.replaceChildren()
    }
  }, [
    apiKey,
    city.id,
    city.country,
    city.latitude,
    city.longitude,
    resolvedTheme,
    attempt,
  ])
  return (
    <div className="relative flex min-h-[360px] min-w-0 flex-1 overflow-hidden rounded-panel bg-bg-weak-50">
      <div
        ref={container}
        className="absolute inset-0"
        role="region"
        aria-label="地图选点"
      />
      {loading && (
        <div
          className="absolute inset-0 grid place-items-center text-body text-text-sub-600"
          role="status"
        >
          正在加载地图…
        </div>
      )}
      {error && (
        <div className="absolute inset-x-4 top-4">
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
          <Button
            className="mt-2"
            size="xsmall"
            variant="neutral"
            mode="stroke"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试地图
          </Button>
        </div>
      )}
    </div>
  )
}
