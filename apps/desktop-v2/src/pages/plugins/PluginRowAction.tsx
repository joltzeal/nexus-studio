import { IconButton, type IconButtonProps } from '@proxyshard/shardx-ui-kit'

export function PluginRowAction({ onClick, ...props }: IconButtonProps) {
  return (
    <IconButton
      type="button"
      size="3xsmall"
      tooltipWarm={false}
      {...props}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
    />
  )
}
