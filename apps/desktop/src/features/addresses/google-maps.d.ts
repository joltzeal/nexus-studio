/**
 * Minimal ambient types for the parts of the Google Maps JS API this page uses.
 *
 * The SDK is a remote script, so there is no module to import and this repo does
 * not depend on an npm type package. Only what the picker actually touches is
 * declared; anything else would be an unverified claim about the API surface.
 */
declare namespace google {
  namespace maps {
    interface LatLng {
      lat(): number
      lng(): number
    }

    interface LatLngLiteral {
      lat: number
      lng: number
    }

    interface MapOptions {
      center: LatLngLiteral
      zoom: number
      mapId?: string
      streetViewControl?: boolean
      fullscreenControl?: boolean
      mapTypeControl?: boolean
      clickableIcons?: boolean
    }

    interface MapMouseEvent {
      latLng: LatLng | null
    }

    interface MapsEventListener {
      remove(): void
    }

    class Map {
      constructor(element: HTMLElement, options: MapOptions)
      addListener(
        event: 'click',
        handler: (event: MapMouseEvent) => void,
      ): MapsEventListener
    }

    interface GeocoderAddressComponent {
      types: string[]
      long_name: string
      short_name: string
    }

    interface GeocoderResult {
      types: string[]
      place_id: string
      address_components: GeocoderAddressComponent[]
      geometry: { location: LatLng; location_type: string }
    }

    interface GeocoderResponse {
      results: GeocoderResult[]
    }

    class Geocoder {
      geocode(request: { location: LatLng }): Promise<GeocoderResponse>
    }

    namespace marker {
      interface AdvancedMarkerElementOptions {
        map?: Map | null
        position?: LatLngLiteral | null
      }

      class AdvancedMarkerElement {
        constructor(options?: AdvancedMarkerElementOptions)
        position: LatLngLiteral | null
        map: Map | null
      }
    }
  }
}
