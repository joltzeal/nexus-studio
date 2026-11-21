import { NavExtensionsIcon } from '../../shared/icons'
import type { PluginView } from './types'

export function PluginNavigationIcon({
  plugin,
  className,
}: {
  plugin?: Pick<PluginView, 'ui'> | null
  className: string
}) {
  const icon = plugin?.ui?.navigation?.icon
  if (!icon) return <NavExtensionsIcon className={className} aria-hidden="true" />
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox={icon.viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icon.paths.map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  )
}
