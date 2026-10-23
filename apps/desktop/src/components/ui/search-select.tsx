import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { cn } from 'cn'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface SearchSelectOption {
  value: string
  label: string
  /** Extra words the search matches on, when the label is not enough. */
  keywords?: string
}

/**
 * A select whose menu can be typed into.
 *
 * Radix `Select` has no search field, and a list of a hundred projects is not
 * usable as a plain menu: this keeps the closed trigger readable, then swaps
 * the menu for a filter box plus a list. Arrow keys and Enter work while the
 * box has focus, so it still behaves like a select from the keyboard.
 */
export function SearchSelect({
  id,
  ariaLabel,
  value,
  options,
  onValueChange,
  disabled = false,
  placeholder = '请选择',
  searchPlaceholder = '输入关键字筛选',
  emptyText = '没有匹配项。',
  className,
}: {
  id?: string
  ariaLabel: string
  value: string
  options: SearchSelectOption[]
  onValueChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  const selected = options.find((option) => option.value === value) ?? null

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options
    return options.filter((option) =>
      `${option.label} ${option.keywords ?? ''}`.toLowerCase().includes(needle),
    )
  }, [options, query])

  // The cursor has to stay inside the filtered list as it shrinks.
  const cursor = visible.length === 0 ? 0 : Math.min(active, visible.length - 1)

  // Opening on the current value is only useful if that row is on screen.
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, cursor])

  function change(next: boolean) {
    setOpen(next)
    if (!next) return
    setQuery('')
    const index = options.findIndex((option) => option.value === value)
    setActive(index < 0 ? 0 : index)
  }

  function pick(next: string) {
    onValueChange(next)
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(cursor + 1, visible.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(cursor - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = visible[cursor]
      if (target !== undefined) pick(target.value)
    }
  }

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled}
          className={cn('search-select-trigger', className)}
        >
          <span>{selected === null ? placeholder : selected.label}</span>
          <ChevronsUpDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="search-select-content">
        <div className="search-field">
          <Search aria-hidden="true" />
          <Input
            autoFocus
            aria-label={`${ariaLabel}筛选`}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="search-select-list" role="listbox" aria-label={ariaLabel}>
          {visible.length === 0 ? (
            <p className="search-select-empty">{emptyText}</p>
          ) : (
            visible.map((option, index) => (
              <button
                key={option.value}
                ref={index === cursor ? activeRef : null}
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-active={index === cursor ? 'true' : undefined}
                className="search-select-option"
                onClick={() => pick(option.value)}
                onMouseEnter={() => setActive(index)}
              >
                <span>{option.label}</span>
                {option.value === value ? <Check aria-hidden="true" /> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
