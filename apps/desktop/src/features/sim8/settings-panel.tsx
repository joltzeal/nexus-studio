import { useState, type FormEvent } from 'react'
import { RefreshCw, Save, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toast'
import { fetchProfile, saveConfig } from './api'
import { formatMoney, message, shortTime, type Sim8Config } from './types'

/**
 * The token is the only credential, and it never comes back out of the plugin:
 * the field starts empty and a save without it keeps the stored one.
 */
export function SettingsPanel({
  config,
  onSaved,
}: {
  config: Sim8Config
  onSaved: (config: Sim8Config) => void
}) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | 'profile' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy('save')
    setError(null)
    try {
      const trimmed = token.trim()
      const next = await saveConfig({
        baseUrl,
        ...(trimmed === '' ? {} : { token: trimmed }),
      })
      onSaved(next)
      setToken('')
      toast.success(trimmed === '' ? '接口地址已保存' : 'Token 已验证并保存')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function clear() {
    setBusy('clear')
    setError(null)
    try {
      const next = await saveConfig({ token: null })
      onSaved(next)
      toast.success('Token 已清除')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function refreshProfile() {
    setBusy('profile')
    setError(null)
    try {
      const result = await fetchProfile()
      onSaved({ ...config, profile: result.profile, profileAt: result.profileAt })
      toast.success('余额已刷新')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sim8-settings">
      <Card>
        <CardHeader>
          <CardTitle>账号状态</CardTitle>
          <CardDescription>余额来自 SIM8 的 profile/info 接口。</CardDescription>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null || !config.hasToken}
            onClick={() => void refreshProfile()}
          >
            <RefreshCw
              data-icon="inline-start"
              className={busy === 'profile' ? 'animate-spin' : undefined}
            />
            刷新
          </Button>
        </CardHeader>
        <CardContent>
          {config.hasToken ? (
            <dl className="sim8-facts">
              <div>
                <dt>账号</dt>
                <dd>{config.profile?.nickname || config.profile?.username || '—'}</dd>
              </div>
              <div>
                <dt>余额</dt>
                <dd>
                  <strong>{formatMoney(config.profile?.money ?? 0)}</strong>
                </dd>
              </div>
              <div>
                <dt>更新于</dt>
                <dd>
                  {config.profileAt === null
                    ? '—'
                    : shortTime(config.profileAt.slice(0, 16))}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="sim8-muted">还没有填写接口 Token。</p>
          )}
          {config.storageDurable ? null : (
            <p className="sim8-hint">
              宿主没有提供私有存储目录，本次运行的号码不会持久化。
            </p>
          )}
        </CardContent>
      </Card>

      <form className="sim8-form" onSubmit={(event) => void save(event)}>
        <Field>
          <FieldLabel htmlFor="sim8-base">接口地址</FieldLabel>
          <Input
            id="sim8-base"
            placeholder="https://api.cc"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <FieldDescription>
            默认 https://api.cc。服务端给了专属域名时填它，保存后立即生效。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="sim8-token">接口 Token</FieldLabel>
          <Input
            id="sim8-token"
            type="password"
            autoComplete="off"
            placeholder={
              config.hasToken ? '已保存，留空则不修改' : '粘贴后台的 API Token'
            }
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <FieldDescription>
            保存前会先调用 profile/info 验证一次，验证失败不会覆盖已保存的 Token。
          </FieldDescription>
        </Field>

        {error === null ? null : <FieldError role="alert">{error}</FieldError>}

        <div className="sim8-actions">
          {config.hasToken ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void clear()}
            >
              <Trash2 data-icon="inline-start" />
              清除 Token
            </Button>
          ) : null}
          <Button type="submit" disabled={busy !== null}>
            <Save data-icon="inline-start" />
            {busy === 'save' ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>接口覆盖</CardTitle>
          <Badge variant="outline">全部已接入</Badge>
        </CardHeader>
        <CardContent>
          <p className="sim8-muted">
            个人信息、项目分类、项目列表、号码前缀、购买、后分配、订单列表、订单号码、
            单条号码、更换接码链接、批量续费（文本 / ID）、筛选项目、创建筛选、筛选详情，
            以及接码链接取码，都可以在这个页面里用。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
