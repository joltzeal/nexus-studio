import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { saveMapsKey } from './api'
import { message, type MapsConfig } from './types'

export interface AddressSettingsSheetProps {
  config: MapsConfig
  onOpenChange: (open: boolean) => void
  onSaved: (config: MapsConfig) => void
}

/** The sheet is mounted only while open, so state starts from the saved value. */
export function AddressSettingsSheet({
  config,
  onOpenChange,
  onSaved,
}: AddressSettingsSheetProps) {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    if (pending || trimmed === '') return
    setPending(true)
    setError(null)
    try {
      const saved = await saveMapsKey(trimmed)
      onSaved(saved)
      onOpenChange(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  async function clear() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const saved = await saveMapsKey(null)
      onSaved(saved)
      setValue('')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>地图 Key</SheetTitle>
          <SheetDescription>
            地图选点由 Google Maps JavaScript API 渲染，需要一个浏览器 Key。 没有 Key
            时公开地址生成仍然可用。
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={save}>
          <SheetBody>
            <Field>
              <FieldLabel htmlFor="address-maps-key">API Key</FieldLabel>
              <Input
                id="address-maps-key"
                type="password"
                autoComplete="off"
                maxLength={512}
                disabled={pending}
                placeholder={config.hasApiKey ? '已保存，输入新值可替换' : 'AIza…'}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>
                保存在插件私有目录的 secrets.json（明文，权限 0600），宿主不托管。
                这是浏览器 Key：请在 Google Cloud 控制台启用 Maps JavaScript API 与
                Geocoding API，并配置来源限制。
              </FieldDescription>
            </Field>
            <FieldDescription>
              {config.hasApiKey
                ? '当前已保存 Key。页面会把它交给 Maps SDK，因此它对本机进程可见。'
                : '当前没有保存 Key。'}
            </FieldDescription>
            {config.storageDurable ? null : (
              <FieldDescription>
                宿主没有提供私有目录，这次保存的 Key 只在内存中，重启后失效。
              </FieldDescription>
            )}
            {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending || !config.hasApiKey}
              onClick={() => void clear()}
            >
              清除 Key
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending || value.trim() === ''}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {pending ? '保存中…' : '保存'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
