import * as React from 'react'
import { cn } from 'cn'
import { Dialog as SheetPrimitive } from 'radix-ui'
import { XIcon } from 'lucide-react'

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A right-hand panel that keeps the list visible behind it. The content column
 * is a flex column so a long form scrolls while the footer stays reachable.
 */
function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'right' | 'left'
  showCloseButton?: boolean
}) {
  return (
    <SheetPrimitive.Portal data-slot="sheet-portal">
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed inset-y-0 z-50 flex w-full flex-col gap-0 bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none data-open:animate-in data-closed:animate-out',
          side === 'right'
            ? 'right-0 max-w-[calc(100%-1rem)] border-l data-open:slide-in-from-right data-closed:slide-out-to-right sm:max-w-md'
            : 'left-0 max-w-[calc(100%-1rem)] border-r data-open:slide-in-from-left data-closed:slide-out-to-left sm:max-w-md',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close asChild>
            <button
              type="button"
              data-slot="sheet-close-button"
              className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <XIcon className="size-4" />
              <span className="sr-only">关闭</span>
            </button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 border-b px-4 py-3.5 pr-12', className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'mt-auto flex flex-col-reverse gap-2 border-t bg-muted/40 px-4 py-3 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-heading text-sm leading-none font-semibold', className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-xs leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  )
}

/** Scrollable body; keeps the header and footer fixed. */
function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4',
        className,
      )}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
  SheetTrigger,
}
