import { PluginImageCache } from '@/lib/plugin-image-cache'
import { loadSupplyImage } from './api'

export { PluginImageCache as SupplyImageCache } from '@/lib/plugin-image-cache'

export const supplyImageCache = new PluginImageCache(loadSupplyImage)
