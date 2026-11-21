import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEventHandler,
  type ReactNode,
} from 'react'
import { Button, Input, Popover } from '@proxyshard/shardx-ui-kit'
import { FilterIcon, SearchIcon } from '../../shared/icons'
import { setPageFilter } from '../../shared/lib/pageFilter'

export function PluginFilterRow({
  label,
  children,
  onSubmit,
}: {
  label: string
  children: ReactNode
  onSubmit?: FormEventHandler<HTMLFormElement>
}) {
  const className =
    '-my-1.5 flex w-full min-w-0 shrink-0 flex-nowrap items-end gap-2 overflow-x-auto scroll-px-1.5 p-1.5 whitespace-nowrap [&>*]:shrink-0'
  return onSubmit ? (
    <form aria-label={label} className={className} onSubmit={onSubmit}>
      {children}
    </form>
  ) : (
    <div role="group" aria-label={label} className={className}>
      {children}
    </div>
  )
}

export function PluginSearch({
  pageShortcut = false,
  onClear,
  wrapperClassName,
  ...props
}: ComponentProps<typeof Input> & { pageShortcut?: boolean; onClear?: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!pageShortcut) return
    const focus = () => {
      input.current?.focus()
      input.current?.select()
    }
    const unregister = setPageFilter(focus)
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'f' ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return
      event.preventDefault()
      focus()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      unregister()
      document.removeEventListener('keydown', onKey)
    }
  }, [pageShortcut])
  return (
    <Input
      {...props}
      ref={input}
      type="search"
      inputSize="xsmall"
      leftIcon={<SearchIcon className="size-3.5" />}
      wrapperClassName={`min-w-[144px] flex-1 ${wrapperClassName ?? ''}`}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (
          event.defaultPrevented ||
          event.key !== 'Escape' ||
          !event.currentTarget.value ||
          !onClear
        )
          return
        event.preventDefault()
        event.stopPropagation()
        onClear()
      }}
    />
  )
}

export function MorePluginFilters({
  label,
  count,
  disabled,
  children,
}: {
  label: string
  count: number
  disabled?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <Button
        ref={trigger}
        type="button"
        size="xsmall"
        mode="stroke"
        variant="neutral"
        leftIcon={<FilterIcon className="size-3.5" />}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        更多筛选{count > 0 ? ` · ${count}` : ''}
      </Button>
      <Popover
        aria-label={label}
        anchorRef={trigger}
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-[580px] max-w-[calc(100vw-2rem)] p-3"
      >
        {children}
      </Popover>
    </div>
  )
}
