import { DragDropVerticalIcon, ImageNotFound01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type { ComponentProps } from 'react'

export {
  BackIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  RefreshIcon as RefreshCw,
  AddIcon as Plus,
  CloseIcon as X,
} from '../../../shared/icons'

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, 'icon'>
export function GripVertical(props: IconProps) {
  return <HugeiconsIcon {...props} icon={DragDropVerticalIcon} strokeWidth={1.75} />
}
export function ImageOff(props: IconProps) {
  return <HugeiconsIcon {...props} icon={ImageNotFound01Icon} strokeWidth={1.75} />
}
