import { useEffect, useRef, useState } from 'react'
import { Loader2, MapPin, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'
import { normalizeGoogleAddress } from './google-geocode'
import { loadGoogleMaps, onMapsAuthFailure } from './google-maps-loader'
import { addressText, type AddressRecord, type CityOption, type Profile } from './types'

const MAP_ERRORS: Record<string, string> = {
  'map-key': '地图已经用另一个 Key 加载过，保存新 Key 后需要重启应用才能生效。',
  'map-auth':
    '地图授权失败，请检查 Key 是否启用了 Maps JavaScript API 与 Geocoding API，以及来源限制。',
  'map-load': '地图加载失败，请检查网络后重试。',
  'map-geocode': '地址解析失败，请检查 Geocoding API 是否已启用。',
  'map-empty': '选点附近没有当前国家的完整地址，请放大地图后点击建筑物。',
}

export interface AddressMapProps {
  apiKey: string
  city: CityOption
  /** True while the page is generating or saving; blocks adding a second pick. */
  busy: boolean
  onPrepare: (address: AddressRecord) => Promise<Profile | null>
  onAdd: (profile: Profile) => void
  onCopied: (ok: boolean) => void
}

export function AddressMap({
  apiKey,
  city,
  busy,
  onPrepare,
  onAdd,
  onCopied,
}: AddressMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [locating, setLocating] = useState(false)
  const [selected, setSelected] = useState<Profile | null>(null)
  const prepare = useRef(onPrepare)

  useEffect(() => {
    prepare.current = onPrepare
  }, [onPrepare])

  useEffect(() => {
    const element = container.current
    if (element === null) return
    let alive = true
    let authorized = true
    let sequence = 0
    let map: google.maps.Map | undefined
    let marker: google.maps.marker.AdvancedMarkerElement | undefined
    let click: google.maps.MapsEventListener | undefined
    setError(null)
    setLoading(true)
    setLocating(false)
    setSelected(null)

    const unsubscribe = onMapsAuthFailure(() => {
      authorized = false
      sequence++
      if (!alive) return
      setError('map-auth')
      setLoading(false)
      setLocating(false)
      setSelected(null)
    })

    void loadGoogleMaps(apiKey)
      .then(() => {
        if (!alive || !authorized) return
        map = new google.maps.Map(element, {
          center: { lat: city.latitude, lng: city.longitude },
          zoom: 15,
          // DEMO_MAP_ID is the documented placeholder for AdvancedMarker.
          mapId: 'DEMO_MAP_ID',
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: false,
        })
        marker = new google.maps.marker.AdvancedMarkerElement({ map })
        const geocoder = new google.maps.Geocoder()
        click = map.addListener('click', (event) => {
          const position = event.latLng
          if (position === null || !authorized || !alive) return
          const current = ++sequence
          setLocating(true)
          setSelected(null)
          setError(null)
          if (marker !== undefined) marker.position = null
          void (async () => {
            try {
              const response = await geocoder.geocode({ location: position })
              if (!alive || current !== sequence || !authorized) return
              const address = normalizeGoogleAddress(response.results, city.country)
              if (address === null) {
                setError('map-empty')
                return
              }
              const profile = await prepare.current(address)
              if (!alive || current !== sequence || !authorized) return
              if (profile === null) return
              setSelected(profile)
              if (marker !== undefined) {
                marker.position = { lat: address.latitude, lng: address.longitude }
              }
            } catch (cause) {
              if (!alive || current !== sequence || !authorized) return
              const code = cause instanceof Error ? cause.message : ''
              setError(code.includes('ZERO_RESULTS') ? 'map-empty' : 'map-geocode')
            } finally {
              if (alive && current === sequence) setLocating(false)
            }
          })()
        })
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!alive || !authorized) return
        setLoading(false)
        const code = cause instanceof Error ? cause.message : ''
        setError(code === 'map-key' ? 'map-key' : 'map-load')
      })

    return () => {
      alive = false
      sequence++
      unsubscribe()
      click?.remove()
      if (marker !== undefined) marker.map = null
      element.replaceChildren()
    }
  }, [apiKey, city.country, city.latitude, city.longitude, attempt])

  return (
    <div className="address-map">
      <div
        ref={container}
        role="region"
        aria-label="地图选点"
        className="address-map-canvas"
      />
      {loading || locating ? (
        <p className="address-hint" role="status">
          {loading ? '地图加载中…' : '正在解析选点地址…'}
        </p>
      ) : (
        <p className="address-hint">
          <MapPin aria-hidden="true" />
          点击建筑物上的位置，解析到门牌地址后可以添加到结果。
        </p>
      )}
      {error === null ? null : (
        <div className="address-map-error" role="alert">
          <span>{MAP_ERRORS[error] ?? '地图操作失败，请重试。'}</span>
          {error === 'map-load' || error === 'map-auth' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCcw data-icon="inline-start" />
              重试
            </Button>
          ) : null}
        </div>
      )}
      {selected === null ? null : (
        <div className="address-pick">
          <p className="address-pick-text">{addressText(selected)}</p>
          <p className="address-hint">
            {selected.approximate
              ? '近似位置：Google 返回插值或建筑中心坐标，未验证具体入口。'
              : '位置精度：建筑物。'}
          </p>
          <p className="address-pick-person">
            {selected.firstName} {selected.lastName} ·{' '}
            <span className="address-handle">{selected.username}</span>
          </p>
          <div className="address-pick-actions">
            <Button size="sm" disabled={busy || locating} onClick={() => onAdd(selected)}>
              添加选点地址
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyText(addressText(selected)).then(onCopied)}
            >
              复制地址
            </Button>
            {locating ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
