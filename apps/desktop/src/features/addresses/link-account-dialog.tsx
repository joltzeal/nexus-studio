import { useEffect, useState, type FormEvent } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import { assignAccountAddress, listAccountAddressTargets } from '@/features/accounts/api'
import { STATUS_LABELS, type AccountAddressTarget } from '@/features/accounts/types'
import { saveAddress } from './api'
import { addressText, message, profileData, type Profile } from './types'

export function LinkAddressAccountDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile
  onClose: () => void
  onSaved: (profile: Profile) => void
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [targets, setTargets] = useState<AccountAddressTarget[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<AccountAddressTarget | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestKey = JSON.stringify([query, page])
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void listAccountAddressTargets({ query, page, pageSize: 10 }).then(
        (result) => {
          if (!active) return
          setTargets(result.items)
          setTotal(result.total)
          setSelected(null)
          setLoadedKey(requestKey)
          setError(null)
        },
        (cause: unknown) => {
          if (!active) return
          setTargets([])
          setTotal(0)
          setLoadedKey(requestKey)
          setError(`无法读取账号池：${message(cause)}。请确认账号池插件已启用并更新。`)
        },
      )
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, page, requestKey])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || loading || selected === null) return
    setBusy(true)
    setError(null)
    try {
      const saved = await saveAddress(profile)
      onSaved(profileData(saved.item))
      const result = await assignAccountAddress(
        selected.id,
        profileData(saved.item),
        selected.address?.id ?? null,
      )
      toast.success(
        result.storageDurable && saved.storageDurable
          ? '地址已保存并关联到账号'
          : '地址已关联，部分资料仅在内存中保存，重启后可能丢失',
      )
      onClose()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogContent
      showCloseButton={!busy}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>关联地址到账号</DialogTitle>
        <DialogDescription>
          为账号保存完整地址资料；该账号已有地址时将替换原地址。
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => void submit(event)}
      >
        <p className="whitespace-pre-line text-sm">{addressText(profile)}</p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="address-account-search">搜索账号</FieldLabel>
            <Input
              id="address-account-search"
              placeholder="账号、备注或地址"
              value={query}
              disabled={busy}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
                setSelected(null)
                setError(null)
              }}
            />
          </Field>
          <Field>
            <FieldLabel>选择账号</FieldLabel>
            {loading ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取账号…
              </p>
            ) : (
              <LabeledSelect
                ariaLabel="选择关联地址的账号"
                value={selected?.id ?? ''}
                disabled={busy}
                onValueChange={(id) =>
                  setSelected(targets.find((target) => target.id === id) ?? null)
                }
                options={targets.map((target) => ({
                  value: target.id,
                  label: `${target.account} · ${STATUS_LABELS[target.status]} · ${target.address ? `已有地址：${target.address.city}` : '未关联地址'}`,
                }))}
              />
            )}
            {!loading && targets.length === 0 && error === null ? (
              <FieldDescription>没有匹配的账号，请先在账号池添加账号。</FieldDescription>
            ) : null}
            {selected?.address ? (
              <FieldDescription className="whitespace-pre-line">
                当前地址：{addressText(selected.address)}。保存后将替换该账号当前的地址。
              </FieldDescription>
            ) : null}
          </Field>
        </FieldGroup>
        {total > 10 ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              共 {total} 个账号 · 第 {page} 页
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || loading || page <= 1}
                onClick={() => {
                  setPage((value) => value - 1)
                  setSelected(null)
                  setError(null)
                }}
              >
                上一页
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || loading || page * 10 >= total}
                onClick={() => {
                  setPage((value) => value + 1)
                  setSelected(null)
                  setError(null)
                }}
              >
                下一页
              </Button>
            </div>
          </div>
        ) : null}
        {error === null ? null : <FieldError role="alert">{error}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy || loading || selected === null}>
            {busy ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Link2 data-icon="inline-start" />
            )}
            {busy ? '正在关联…' : '保存并关联'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
