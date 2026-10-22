import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface LabeledSelectOption {
  value: string
  label: string
}

/**
 * Radix only learns an item's text once the menu has been opened, so a bare
 * `<SelectValue />` renders an empty trigger on first paint. Passing the label
 * explicitly keeps the closed trigger readable — which is what a filter bar or
 * a form field is.
 */
export function LabeledSelect({
  id,
  ariaLabel,
  value,
  options,
  onValueChange,
  disabled,
  className,
}: {
  id?: string
  ariaLabel: string
  value: string
  options: LabeledSelectOption[]
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const label = options.find((option) => option.value === value)?.label ?? ''
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
