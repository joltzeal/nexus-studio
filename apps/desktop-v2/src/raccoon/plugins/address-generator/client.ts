import { callPlugin } from '../call'
import { createAddressApi } from './api'
import { mapsBuildKey } from './build-config'
export const addressApi = createAddressApi(callPlugin)
export const googleMapsKey = mapsBuildKey(import.meta.env.VITE_GOOGLE_MAPS_API_KEY)
