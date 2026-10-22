import * as React from 'react'
import { cn } from 'cn'
import { Popover as PopoverPrimitive } from 'radix-ui'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 flex w-72 flex-col gap-2 rounded-lg bg-popover p-3 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-header"
      className={cn('flex flex-col gap-1', className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="popover-title"
      className={cn(
        'text-xs font-semibold tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger }
