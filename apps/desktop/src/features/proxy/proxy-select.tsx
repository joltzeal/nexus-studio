/**
 * Proxy-facing name for the shared labeled select. Kept as a re-export so the
 * proxy pages did not have to change when the component moved to `ui/`.
 */
export {
  LabeledSelect as ProxySelect,
  type LabeledSelectOption as ProxySelectOption,
} from '@/components/ui/labeled-select'
