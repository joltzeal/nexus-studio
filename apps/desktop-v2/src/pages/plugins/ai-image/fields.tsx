import type { ComponentProps, ReactNode } from 'react'
import { Alert, Button, Input, Select, Textarea } from '@proxyshard/shardx-ui-kit'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'

export const RECOGNITION_LABELS: Record<string, string> = {
  title: '标题',
  description: '描述',
  product: '商品',
  material: '材质',
  observations: '观察结果',
  uncertainties: '待确认信息',
  reason: '场景推荐理由',
  prompt: '完整提示词',
  presetId: '场景标识',
  visibleDesign: '可见设计',
  confirmedWear: '已确认磨损',
  translatedRequirements: '英文商品要求',
}

export function AiInput(props: ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      inputSize="xsmall"
      className={`border border-stroke-soft-200 ${props.className ?? ''}`}
    />
  )
}

export function AiSelect(props: ComponentProps<typeof Select>) {
  return (
    <Select
      {...props}
      size="xsmall"
      className={`[&>[role=combobox]]:border [&>[role=combobox]]:border-stroke-soft-200 ${props.className ?? ''}`}
    />
  )
}

export function AiTextarea(props: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      {...props}
      className={`border border-stroke-soft-200 ${props.className ?? ''}`}
    />
  )
}

export function Failure({ error }: { error: string | null }) {
  return error ? (
    <Alert status="error" variant="lighter">
      {error}
    </Alert>
  ) : null
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="m-0 text-panel-title text-text-strong-950">{title}</h3>
      {children}
    </section>
  )
}

export function FullText({
  label,
  text,
}: {
  label: string
  text: string | null | undefined
}) {
  if (!text) return null
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-secondary text-text-sub-600">{label}</span>
        <Button
          size="xsmall"
          mode="ghost"
          variant="neutral"
          onClick={() =>
            void clip.write(text).then(
              () => toast.ok(`已复制${label}`),
              () => toast.err('复制失败'),
            )
          }
        >
          复制
        </Button>
      </div>
      <p className="m-0 whitespace-pre-wrap break-words text-body text-text-strong-950">
        {text}
      </p>
    </div>
  )
}
