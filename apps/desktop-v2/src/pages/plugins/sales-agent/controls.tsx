import {
  Children,
  createContext,
  isValidElement,
  use,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  Alert as KitAlert,
  Badge as KitBadge,
  Button as KitButton,
  IconButton,
  Modal,
  SegmentControl,
  Select,
  Switch as KitSwitch,
  Tooltip,
  cn,
  type ButtonProps,
  type SwitchProps,
} from '@proxyshard/shardx-ui-kit'
import { toast as appToast } from '../../../shared/model/toast'

export const toast = { success: appToast.ok, error: appToast.err }

export function Button({
  variant,
  size,
  children,
  hint,
  ...props
}: Omit<ButtonProps, 'variant' | 'size'> & {
  hint?: string
  variant?: 'outline' | 'ghost' | 'link' | 'destructive' | 'secondary'
  size?: 'sm' | 'icon'
}) {
  const label = props['aria-label']
  if (size === 'icon' && label)
    return (
      <IconButton
        {...props}
        label={label}
        icon={children}
        size="3xsmall"
        variant={variant === 'destructive' ? 'error' : 'neutral'}
        mode={variant === 'ghost' ? 'ghost' : 'stroke'}
      />
    )
  const content = Children.toArray(children)
  const leadingIcon = content.find(
    (item) =>
      isValidElement<{ 'data-icon'?: string }>(item) &&
      item.props['data-icon'] === 'inline-start',
  )
  const control = (
    <KitButton
      {...props}
      leftIcon={props.leftIcon ?? leadingIcon}
      size="xsmall"
      onlyIcon={size === 'icon'}
      variant={variant === 'destructive' ? 'error' : variant ? 'neutral' : 'primary'}
      mode={
        variant === 'outline'
          ? 'stroke'
          : variant === 'secondary'
            ? 'lighter'
            : variant === 'ghost' || variant === 'link'
              ? variant
              : 'filled'
      }
    >
      {leadingIcon ? content.filter((item) => item !== leadingIcon) : children}
    </KitButton>
  )
  return hint ? (
    <Tooltip content={hint}>
      <span className="inline-flex">{control}</span>
    </Tooltip>
  ) : (
    control
  )
}

export function Alert({
  variant,
  children,
  ...props
}: Omit<ComponentProps<typeof KitAlert>, 'variant'> & {
  variant?: 'destructive'
}) {
  const items = Children.toArray(children)
  const title = items.find((item) => isElement(item, AlertTitle))
  return (
    <KitAlert
      {...props}
      variant="lighter"
      status={variant ? 'error' : 'information'}
      title={isElement(title, AlertTitle) ? title.props.children : undefined}
    >
      {items.filter((item) => item !== title)}
    </KitAlert>
  )
}

export function AlertTitle({ children }: { children: ReactNode }) {
  return children
}
export function AlertDescription({ children }: { children: ReactNode }) {
  return <div className="min-w-0 wrap-anywhere">{children}</div>
}
export function Badge({
  variant,
  hint,
  ...props
}: Omit<ComponentProps<typeof KitBadge>, 'variant'> & {
  hint?: string
  variant?: 'outline' | 'destructive' | 'secondary' | 'default'
}) {
  const badge = (
    <KitBadge
      {...props}
      shape="chip"
      size="small"
      variant={variant === 'outline' ? 'stroke' : 'soft'}
      color={
        variant === 'destructive'
          ? 'error'
          : variant === 'default'
            ? 'information'
            : 'gray'
      }
    />
  )
  return hint ? <Tooltip content={hint}>{badge}</Tooltip> : badge
}

export function Switch({
  onCheckedChange,
  ...props
}: SwitchProps & {
  onCheckedChange: (checked: boolean) => void
}) {
  return <KitSwitch {...props} onChange={onCheckedChange} />
}

export function LabeledSelect({
  ariaLabel,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof Select>, 'onChange'> & {
  ariaLabel: string
  onValueChange: (value: string) => void
}) {
  return (
    <Select {...props} size="xsmall" aria-label={ariaLabel} onChange={onValueChange} />
  )
}

export function Field({
  orientation,
  className,
  ...props
}: ComponentProps<'div'> & { orientation?: 'horizontal' }) {
  return (
    <div
      {...props}
      className={cn(
        'flex min-w-0 gap-1.5',
        orientation === 'horizontal' ? 'items-center gap-2' : 'flex-col',
        className,
      )}
    />
  )
}
export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('flex min-w-0 flex-col gap-3', className)} />
}
export function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return <label {...props} className={cn('text-ui font-medium', className)} />
}
export function FieldSet({ className, ...props }: ComponentProps<'fieldset'>) {
  return (
    <fieldset
      {...props}
      className={cn(
        'min-w-0 rounded-control border border-stroke-soft-200 p-3',
        className,
      )}
    />
  )
}
export function FieldLegend({ className, ...props }: ComponentProps<'legend'>) {
  return <legend {...props} className={cn('px-1 text-ui font-semibold', className)} />
}
export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p {...props} className={cn('text-help text-text-sub-600', className)} />
}
export function FieldError({
  children,
  errors,
}: {
  children?: ReactNode
  errors?: { message?: string }[]
}) {
  const content =
    children ??
    errors
      ?.map((item) => item.message)
      .filter(Boolean)
      .join(' · ')
  return content ? (
    <p role="alert" className="text-help text-error-text">
      {content}
    </p>
  ) : null
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-20 items-center justify-center p-3 text-center">
      {children}
    </div>
  )
}
export function EmptyHeader({ children }: { children: ReactNode }) {
  return <div className="space-y-1">{children}</div>
}
export function EmptyTitle({ children }: { children: ReactNode }) {
  return <p className="text-ui font-medium">{children}</p>
}
export function EmptyDescription({ children }: { children: ReactNode }) {
  return <p className="text-help text-text-sub-600">{children}</p>
}
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('rounded-control bg-bg-weak-50 motion-safe:animate-pulse', className)}
    />
  )
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-control border border-stroke-soft-200">
      <table
        {...props}
        className={cn('w-full border-collapse text-left text-ui', className)}
      />
    </div>
  )
}
export function TableHeader(props: ComponentProps<'thead'>) {
  return <thead {...props} className="bg-bg-weak-50 text-text-sub-600" />
}
export function TableBody(props: ComponentProps<'tbody'>) {
  return <tbody {...props} />
}
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      {...props}
      className={cn(
        'border-b border-stroke-soft-200 last:border-b-0 data-[state=selected]:bg-bg-weak-50',
        className,
      )}
    />
  )
}
export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      {...props}
      className={cn('whitespace-nowrap px-3 py-2 font-medium', className)}
    />
  )
}
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td {...props} className={cn('px-3 py-2 align-top', className)} />
}

type TabState = { value: string; change: (value: string) => void }
const TabContext = createContext<TabState>({ value: '', change: () => {} })
export function Tabs({
  value,
  defaultValue = '',
  onValueChange,
  children,
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children: ReactNode
}) {
  const [local, setLocal] = useState(defaultValue)
  return (
    <TabContext value={{ value: value ?? local, change: onValueChange ?? setLocal }}>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </TabContext>
  )
}
export function TabsTrigger({ children }: { value: string; children: string }) {
  return children
}
export function TabsList({ children }: { children: ReactNode }) {
  const { value, change } = use(TabContext)
  const items = Children.toArray(children).flatMap((item) =>
    isElement(item, TabsTrigger)
      ? [{ value: item.props.value, label: item.props.children }]
      : [],
  )
  return (
    <SegmentControl
      items={items}
      value={value}
      onChange={change}
      semantics="tabs"
      size="xsmall"
      fit
      className="self-start"
    />
  )
}
export function TabsContent({
  value,
  forceMount,
  children,
  className,
  hidden,
}: {
  value: string
  forceMount?: boolean
  hidden?: boolean
  children: ReactNode
  className?: string
}) {
  const active = use(TabContext).value === value
  return active || forceMount ? (
    <section
      role="tabpanel"
      className={cn(className, (!active || hidden) && 'hidden!')}
      hidden={!active || hidden}
    >
      {children}
    </section>
  ) : null
}

function isElement<Props>(
  child: ReactNode,
  type: (props: Props) => ReactNode,
): child is ReactElement<Props> {
  return isValidElement(child) && child.type === type
}

type DialogState = {
  open: boolean
  onOpenChange: (open: boolean) => void
  alert?: boolean
}
const DialogContext = createContext<DialogState>({ open: false, onOpenChange: () => {} })
type DialogProps = Omit<DialogState, 'alert'> & { children: ReactNode }
export function Dialog({ children, ...props }: DialogProps) {
  return <DialogContext value={props}>{children}</DialogContext>
}
export function AlertDialog({ children, ...props }: DialogProps) {
  return <DialogContext value={{ ...props, alert: true }}>{children}</DialogContext>
}
type DialogPart = { children: ReactNode }
export function DialogHeader({ children }: DialogPart) {
  return children
}
export function DialogFooter({ children }: DialogPart) {
  return children
}
export function DialogTitle({ children }: DialogPart) {
  return children
}
export function DialogDescription({ children }: DialogPart) {
  return children
}
export function DialogContent({
  children,
  className,
  showCloseButton = true,
}: DialogPart & {
  className?: string
  showCloseButton?: boolean
}) {
  const { open, onOpenChange, alert } = use(DialogContext)
  const items = Children.toArray(children)
  const header = items.find((item) => isElement(item, DialogHeader))
  const footer = items.find((item) => isElement(item, DialogFooter))
  const headings = isElement(header, DialogHeader)
    ? Children.toArray(header.props.children)
    : []
  const title = headings.find((item) => isElement(item, DialogTitle))
  const description = headings.find((item) => isElement(item, DialogDescription))
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      role={alert ? 'alertdialog' : 'dialog'}
      size={alert ? 'sm' : 'lg'}
      maxWidthClassName={className === 'sales-agent-dialog' ? 'max-w-[800px]' : undefined}
      showClose={!alert && showCloseButton}
      title={isElement(title, DialogTitle) ? title.props.children : undefined}
      description={
        isElement(description, DialogDescription) ? description.props.children : undefined
      }
      footer={
        isElement(footer, DialogFooter) ? (
          <div className="flex flex-wrap justify-end gap-2">{footer.props.children}</div>
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {headings.filter((item) => item !== title && item !== description)}
        {items.filter((item) => item !== header && item !== footer)}
      </div>
    </Modal>
  )
}
export {
  DialogContent as AlertDialogContent,
  DialogHeader as AlertDialogHeader,
  DialogFooter as AlertDialogFooter,
  DialogTitle as AlertDialogTitle,
  DialogDescription as AlertDialogDescription,
}
export function AlertDialogCancel(props: ComponentProps<typeof Button>) {
  const { onOpenChange } = use(DialogContext)
  return <Button variant="outline" {...props} onClick={() => onOpenChange(false)} />
}
export function AlertDialogAction(props: ComponentProps<typeof Button>) {
  const { onOpenChange } = use(DialogContext)
  return (
    <Button
      variant="destructive"
      {...props}
      onClick={(event) => {
        props.onClick?.(event)
        if (!event.defaultPrevented) onOpenChange(false)
      }}
    />
  )
}
