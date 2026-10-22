import { AlertCircle, CheckCircle2, LoaderCircle } from 'lucide-react'
import { usePreferences } from '@/hooks/use-preferences'
import { cn } from '@/lib/utils'

export function SaveFeedback() {
  const { saveStatus } = usePreferences()
  const Icon =
    saveStatus === 'saving'
      ? LoaderCircle
      : saveStatus === 'error'
        ? AlertCircle
        : CheckCircle2
  const message =
    saveStatus === 'saving'
      ? '正在保存这次调整…'
      : saveStatus === 'error'
        ? '尚未保存，请重试'
        : saveStatus === 'saved'
          ? '已保存你的偏好'
          : '偏好会自动保存'

  return (
    <div
      className="save-feedback"
      data-status={saveStatus}
      role="status"
      aria-live="polite"
    >
      <Icon
        aria-hidden="true"
        className={cn(saveStatus === 'saving' && 'animate-spin')}
      />
      <span>{message}</span>
    </div>
  )
}
