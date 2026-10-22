import { useState, type FormEvent } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { PreferencesSchema } from '@nexus/contracts'
import { usePreferences } from '@/hooks/use-preferences'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export function WorkspacePage() {
  const { preferences, update, saveStatus } = usePreferences()
  const [name, setName] = useState(preferences.workspaceName)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const dirty = name.trim() !== preferences.workspaceName

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = PreferencesSchema.shape.workspaceName.safeParse(name)
    if (!parsed.success) {
      setError('名称需要包含 1 至 60 个字符。')
      return
    }
    setError(null)
    const success = await update({ workspaceName: parsed.data })
    setSaved(success)
    if (success) setName(parsed.data)
  }

  return (
    <section className="settings-page page-reveal" aria-labelledby="workspace-heading">
      <h1 className="page-heading" id="workspace-heading">
        工作区设置
      </h1>
      <p className="page-description">管理本地工作区的基础信息。</p>
      <Card>
        <CardHeader>
          <CardTitle>工作区信息</CardTitle>
          <CardDescription>名称保存在当前浏览器或 WebView。</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="workspace-form" onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor="workspace-name">工作区名称</FieldLabel>
                <Input
                  id="workspace-name"
                  value={name}
                  maxLength={60}
                  autoComplete="off"
                  aria-invalid={!!error}
                  aria-describedby={
                    error ? 'workspace-name-error' : 'workspace-name-description'
                  }
                  onChange={(event) => {
                    setName(event.target.value)
                    setError(null)
                    setSaved(false)
                  }}
                />
                {error ? (
                  <FieldError id="workspace-name-error">{error}</FieldError>
                ) : (
                  <FieldDescription id="workspace-name-description">
                    比如「周末的小店」或「我的工作室」。
                  </FieldDescription>
                )}
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="justify-between gap-4">
          <span className="save-feedback" role="status">
            {saved ? (
              <>
                <Check aria-hidden="true" />
                已保存工作区名称
              </>
            ) : null}
          </span>
          <Button
            type="submit"
            form="workspace-form"
            disabled={!dirty || saveStatus === 'saving'}
          >
            {saveStatus === 'saving' ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            保存名称
          </Button>
        </CardFooter>
      </Card>
    </section>
  )
}
