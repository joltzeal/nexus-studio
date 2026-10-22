import { useState } from 'react'
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
import { Switch } from '@/components/ui/switch'
import { setConfig } from './api'
import { ProxySelect } from './proxy-select'
import { addressOf, message, type ProxyConfig, type ProxyRow } from './types'

const NONE = 'none'

export interface ProxyConfigSheetProps {
  config: ProxyConfig
  rows: ProxyRow[]
  onOpenChange: (open: boolean) => void
  onSaved: (next: ProxyConfig) => void
}

export function ProxyConfigSheet({
  config,
  rows,
  onOpenChange,
  onSaved,
}: ProxyConfigSheetProps) {
  const [defaultId, setDefaultId] = useState(config.defaultEndpointId ?? NONE)
  const [riskEnabled, setRiskEnabled] = useState(config.risk.enabled)
  const [cacheSeconds, setCacheSeconds] = useState(String(config.risk.cacheSeconds))
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function save(patch: { riskApiKey?: string } = {}) {
    if (pending) return
    const cache = Number(cacheSeconds)
    if (!Number.isInteger(cache) || cache < 0 || cache > 86_400) {
      return setError('缓存时间需要是 0 到 86400 之间的整数秒。')
    }
    setPending(true)
    setError(null)
    try {
      const next = await setConfig({
        defaultEndpointId: defaultId === NONE ? null : defaultId,
        riskEnabled,
        riskCacheSeconds: cache,
        ...patch,
      })
      onSaved(next)
      setApiKey('')
      setNotice('配置已保存。')
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
          <SheetTitle>代理插件配置</SheetTitle>
          <SheetDescription>
            默认代理决定使用代理池的窗口如何联网；未选择时这类窗口会被阻断，不会回退直连。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Field>
            <FieldLabel htmlFor="config-default">默认代理</FieldLabel>
            <ProxySelect
              id="config-default"
              ariaLabel="默认代理"
              value={defaultId}
              disabled={pending}
              onValueChange={(value) => {
                setDefaultId(value)
                setNotice(null)
              }}
              options={[
                { value: NONE, label: '不指定（窗口启动会被阻断）' },
                ...rows.map((row) => ({
                  value: row.id,
                  label: `${row.name} · ${addressOf(row)}`,
                })),
              ]}
            />
            <FieldDescription>
              列表只包含当前筛选结果中的代理；需要更多候选时先清除筛选。
            </FieldDescription>
          </Field>
          <Field className="proxy-switch-field" orientation="horizontal">
            <FieldLabel htmlFor="config-risk">出口 IP 风险检测</FieldLabel>
            <Switch
              id="config-risk"
              checked={riskEnabled}
              disabled={pending}
              onCheckedChange={(checked) => {
                setRiskEnabled(checked)
                setNotice(null)
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="config-cache">风险结果缓存（秒）</FieldLabel>
            <Input
              id="config-cache"
              inputMode="numeric"
              disabled={pending}
              value={cacheSeconds}
              onChange={(event) => setCacheSeconds(event.target.value)}
            />
            <FieldDescription>
              风险查询走 proxycheck.io，缓存可以减少额度消耗；0 表示每次都查询。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="config-key">proxycheck.io 密钥</FieldLabel>
            <div className="proxy-key-row">
              <Input
                id="config-key"
                type="password"
                autoComplete="off"
                placeholder={config.risk.hasApiKey ? '已保存，留空则不修改' : '未保存'}
                disabled={pending}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button
                disabled={pending || apiKey === ''}
                onClick={() => void save({ riskApiKey: apiKey })}
              >
                保存
              </Button>
              {config.risk.hasApiKey ? (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void save({ riskApiKey: '' })}
                >
                  清除
                </Button>
              ) : null}
            </div>
            <FieldDescription>
              密钥与代理密码一起明文保存在插件私有目录的
              secrets.json，宿主不读取也不代为保管。
            </FieldDescription>
          </Field>
          {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          {notice === null ? null : (
            <p className="proxy-result" role="status">
              {notice}
            </p>
          )}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button disabled={pending} onClick={() => void save()}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            保存配置
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
