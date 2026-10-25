import { useEffect, useState, type FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  getLicenseStatus,
  nativeLicenseAvailable,
  removeLicenseKey,
  setLicenseKey,
  type LicenseStatus,
} from '@/lib/platform/native-license'

function errorMessage(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '激活码操作失败，请重试。'
}

export function LicenseSettingsPage() {
  const native = nativeLicenseAvailable()
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [key, setKey] = useState('')
  const [loading, setLoading] = useState(native)
  const [statusLoadFailed, setStatusLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!native) return
    let active = true
    void getLicenseStatus()
      .then(
        (result) => {
          if (active) setStatus(result)
        },
        (cause: unknown) => {
          if (active) {
            setError(errorMessage(cause))
            setStatusLoadFailed(true)
          }
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [native])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!key.trim()) {
      setError('请输入激活码。')
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await setLicenseKey(key.trim())
      setStatus(next)
      setKey('')
      setSaved(true)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setRemoving(true)
    setError(null)
    setSaved(false)
    try {
      await removeLicenseKey()
      setStatus({ configured: false, plan: null, expires: null })
      setKey('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className="settings-page page-reveal" aria-labelledby="license-heading">
      <h1 className="page-heading" id="license-heading">
        激活码
      </h1>
      <p className="page-description">保存激活码后即可下载内核、创建和打开窗口。</p>
      {!native ? (
        <Alert>
          <AlertTitle>桌面应用专属</AlertTitle>
          <AlertDescription>请在桌面应用中输入激活码。</AlertDescription>
        </Alert>
      ) : (
        <div className="license-settings-layout">
          <Card>
            <CardHeader>
              <CardTitle>
                {status?.configured ? '已保存激活码' : '未填写激活码'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <p role="status">正在读取状态…</p> : null}
              {statusLoadFailed ? (
                <p className="text-sm text-muted-foreground">暂时无法读取状态。</p>
              ) : null}
              {!loading && !status?.configured && !statusLoadFailed ? (
                <p className="mb-3 text-sm text-muted-foreground">请先填写激活码。</p>
              ) : null}
              <form
                id="cloakbrowser-license-form"
                onSubmit={(event) => void submit(event)}
              >
                <Field data-invalid={!!error}>
                  <FieldLabel htmlFor="cloakbrowser-license-key">激活码</FieldLabel>
                  <Input
                    id="cloakbrowser-license-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={loading || saving || removing}
                    value={key}
                    aria-invalid={!!error}
                    onChange={(event) => {
                      setKey(event.target.value)
                      setError(null)
                      setSaved(false)
                    }}
                  />
                  {error ? <FieldError>{error}</FieldError> : null}
                </Field>
              </form>
              {saved ? (
                <p className="license-saved" role="status">
                  激活码校验通过并已保存。
                </p>
              ) : null}
            </CardContent>
            <div className="license-actions">
              <Button
                type="submit"
                form="cloakbrowser-license-form"
                disabled={loading || saving || removing || !key.trim()}
              >
                {saving ? (
                  <LoaderCircle data-icon="inline-start" className="animate-spin" />
                ) : null}
                {saving ? '正在校验…' : '校验并保存'}
              </Button>
              {status?.configured ? (
                <Button
                  variant="outline"
                  disabled={saving || removing}
                  onClick={() => void remove()}
                >
                  {removing ? '正在移除…' : '移除激活码'}
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      )}
    </section>
  )
}
