import { PluginImageCache } from '@/lib/plugin-image-cache'
import { loadVintedImage } from './api'

export const vintedImageCache = new PluginImageCache((source, signal) => {
  const separator = source.indexOf('\n')
  return loadVintedImage(source.slice(0, separator), source.slice(separator + 1), signal)
})
