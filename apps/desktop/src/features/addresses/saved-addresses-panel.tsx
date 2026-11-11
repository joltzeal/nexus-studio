import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { toast } from '@/components/ui/toast'
import { AddressCard } from './address-card'
import { listSavedAddresses, removeSavedAddress } from './api'
import { message, type Profile, type SavedAddressList } from './types'

export function SavedAddressesPanel({
  refreshToken,
  onCopy,
  onLink,
  onRemoved,
}: {
  refreshToken: number
  onCopy: (text: string) => void
  onLink: (profile: Profile) => void
  onRemoved: (profile: Profile) => void
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<SavedAddressList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<Profile | null>(null)
  const [revision, setRevision] = useState(0)
  const requestKey = JSON.stringify([query, page, revision, refreshToken])
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void listSavedAddresses({ query, page, pageSize: 20 }).then(
        (result) => {
          if (!active) return
          setData(result)
          setLoadedKey(requestKey)
          setError(null)
        },
        (cause: unknown) => {
          if (!active) return
          setError(message(cause))
          setLoadedKey(requestKey)
        },
      )
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, page, revision, refreshToken, requestKey])

  async function remove(id: string) {
    if (removing !== null) return
    setRemoving(id)
    setError(null)
    try {
      await removeSavedAddress(id)
      const profile = data?.items.find((item) => item.id === id)
      if (profile) onRemoved(profile)
      toast.success('已从保存列表移除，账号中的地址仍保留')
      setPendingRemoval(null)
      setRevision((value) => value + 1)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setRemoving(null)
    }
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="已保存地址"
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          aria-label="搜索已保存地址"
          placeholder="搜索姓名、城市、街道或邮编"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
        {data ? (
          <span className="text-xs text-muted-foreground">共 {data.total} 条</span>
        ) : null}
      </div>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      {data && !data.storageDurable ? (
        <p role="status" className="text-sm text-muted-foreground">
          当前仅使用内存存储，重启后不会保留。
        </p>
      ) : null}
      {loading && data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取已保存地址…
        </p>
      ) : null}
      {data && data.items.length > 0 ? (
        <div className="address-grid">
          {data.items.map((profile) => (
            <AddressCard
              key={profile.id}
              profile={profile}
              busy={loading || removing !== null}
              saved
              deleteLabel="从保存列表移除此地址"
              onCopy={onCopy}
              onDelete={() => setPendingRemoval(profile)}
              onLink={onLink}
            />
          ))}
        </div>
      ) : !loading && error === null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {query.trim() === '' ? '还没有已保存地址' : '没有匹配的地址'}
            </EmptyTitle>
            <EmptyDescription>
              {query.trim() === ''
                ? '生成地址后点击「保存地址」，地图添加或关联账号时也会自动保存。'
                : '请尝试其他姓名、城市、街道或邮编。'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            第 {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || data.page <= 1}
              onClick={() => setPage(data.page - 1)}
            >
              <ChevronLeft data-icon="inline-start" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || data.page * data.pageSize >= data.total}
              onClick={() => setPage(data.page + 1)}
            >
              下一页
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      ) : null}
      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && removing === null) setPendingRemoval(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除已保存地址？</AlertDialogTitle>
            <AlertDialogDescription>
              此地址将从保存列表移除，已经关联到账号的地址资料仍会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error !== null && pendingRemoval ? (
            <FieldError role="alert">{error}</FieldError>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removing !== null}
              onClick={(event) => {
                event.preventDefault()
                if (pendingRemoval) void remove(pendingRemoval.id)
              }}
            >
              {removing === null ? '移除地址' : '正在移除…'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
