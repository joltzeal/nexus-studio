import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Button,
  IconButton,
  Input,
  Select,
  Textarea,
  Tooltip,
} from '@proxyshard/shardx-ui-kit'
import type { PluginUiAction, PluginUiView } from '@nexus/plugin-sdk/ui'
import {
  PeekBody,
  PeekSection,
  PropertyRow,
  PropertySheet,
  PropertyValue,
} from '../../shared/ui/peek'
import { CopyIcon, ExternalLinkIcon } from '../../shared/icons'
import { clip } from '../../shared/lib/clipboard'
import { toast } from '../../shared/model/toast'
import { confirmModal } from '../../shared/lib/confirm'
import { useUnsaved } from '../../shared/model/unsaved'
import { pluginUiRuntime } from '../../raccoon/plugins/ui-runtime'
import type { PluginUiTarget } from '../../raccoon/plugins/ui-session'

export function PluginViewRenderer({
  view,
  target,
  busy,
  dispatch,
  notice,
}: {
  view: PluginUiView
  target: PluginUiTarget
  busy: boolean
  notice?: ReactNode
  dispatch: (
    actionId: string,
    values: Record<string, string>,
  ) => Promise<PluginUiView | null>
}) {
  const initial = Object.fromEntries(
    view.sections.flatMap((section) =>
      section.fields.map((field) => [field.id, field.value]),
    ),
  )
  const [values, setValues] = useState(initial)
  const [localError, setLocalError] = useState<string | null>(null)
  const submitting = useRef(false)
  const allActions = [
    ...view.actions,
    ...view.sections.flatMap((section) => section.actions),
  ]
  const saveAction = allActions.find(
    (action) => (action.submit || view.pendingChanges) && action.tone === 'primary',
  )
  const dirty = Object.entries(values).some(([id, value]) => initial[id] !== value)
  const refreshState = useRef({ busy, dirty, view, target, dispatch })
  refreshState.current = { busy, dirty, view, target, dispatch }
  const refreshActionId = view.refresh?.actionId
  const refreshIntervalMs = view.refresh?.intervalMs
  useEffect(() => {
    if (!refreshActionId || !refreshIntervalMs) return
    const timer = setInterval(() => {
      const current = refreshState.current
      const action = [
        ...current.view.actions,
        ...current.view.sections.flatMap((section) => section.actions),
      ].find((action) => action.id === refreshActionId)
      if (
        current.busy ||
        current.dirty ||
        current.view.pendingChanges ||
        submitting.current ||
        !action ||
        action.disabled
      )
        return
      submitting.current = true
      pluginUiRuntime.cancel(current.target, action.cancelTasks)
      void current
        .dispatch(refreshActionId, {})
        .catch(() => setLocalError('插件内容刷新失败，请重试'))
        .finally(() => {
          submitting.current = false
        })
    }, refreshIntervalMs)
    return () => clearInterval(timer)
  }, [refreshActionId, refreshIntervalMs])
  async function run(action: PluginUiAction): Promise<boolean> {
    if (busy || submitting.current || action.disabled) return false
    if (
      !action.submit &&
      dirty &&
      saveAction &&
      !(await confirmModal({
        title: '放弃未保存的修改',
        message: '继续操作将离开当前表单。',
        confirmLabel: '放弃修改',
      }))
    )
      return false
    const missing =
      action.submit &&
      view.sections
        .flatMap((section) => section.fields)
        .find((field) => field.required && !values[field.id]?.trim())
    if (missing) {
      setLocalError(`请填写${missing.label}`)
      return false
    }
    submitting.current = true
    try {
      const confirmation = view.confirmation
      if (
        confirmation?.confirmActionId === action.id &&
        !(await confirmModal({
          title: confirmation.title,
          message: confirmation.message,
          confirmLabel: confirmation.confirmLabel,
          danger: action.tone === 'danger',
        }))
      )
        return false
      setLocalError(null)
      pluginUiRuntime.cancel(target, action.cancelTasks)
      const next = await dispatch(action.id, action.submit ? values : {})
      return next?.saved ?? false
    } finally {
      submitting.current = false
    }
  }
  useUnsaved(
    (dirty || view.pendingChanges) && saveAction
      ? {
          id: `plugin-form:${view.revision}`,
          label: view.title,
          save: () => run(saveAction),
          discard: () => setValues(initial),
        }
      : null,
  )
  const buttons = (actions: PluginUiAction[], header = false) =>
    actions.map((action) => (
      <Tooltip
        key={action.id}
        content={action.disabledReason}
        disabled={!action.disabled || !action.disabledReason}
      >
        <Button
          size={header ? '3xsmall' : 'xsmall'}
          className={header ? '-my-1 last:-mr-1.5' : undefined}
          mode={header ? 'ghost' : action.tone === 'primary' ? 'filled' : 'stroke'}
          variant={
            action.tone === 'danger'
              ? 'error'
              : action.tone === 'primary'
                ? 'primary'
                : 'neutral'
          }
          disabled={busy || action.disabled}
          data-plugin-action={action.id}
          onClick={() => {
            if (action.announce && !busy && !action.disabled) pluginUiRuntime.arm()
            void run(action)
          }}
        >
          {action.label}
        </Button>
      </Tooltip>
    ))
  const effect = (operation: Promise<unknown>) => {
    void operation.catch(() => toast.fail({ title: '操作失败，请重试' }))
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={busy}>
      <PeekBody>
        {notice}
        {view.tasks.length > 0 && (
          <div className="flex flex-col gap-1 px-inset pt-inset text-secondary text-text-sub-600">
            {view.tasks.map((task) => (
              <p key={task.id} role="status" className="m-0">
                {task.label}
              </p>
            ))}
          </div>
        )}
        {localError && (
          <p
            role="alert"
            className="m-0 px-inset pt-inset text-secondary text-error-text"
          >
            {localError}
          </p>
        )}
        <PropertySheet>
          {view.sections.map((section) => (
            <PeekSection
              key={section.id}
              id={`plugin-${section.id}`}
              title={section.title}
              action={
                section.actions.some((action) => action.placement === 'header') ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {buttons(
                      section.actions.filter((action) => action.placement === 'header'),
                      true,
                    )}
                  </div>
                ) : undefined
              }
            >
              {section.text && (
                <p className="m-0 whitespace-pre-wrap break-words px-1 text-secondary text-text-sub-600">
                  {section.text}
                </p>
              )}
              {section.properties.length > 0 && (
                <div className="flex flex-col gap-[2px]">
                  {section.properties.map((property, index) => (
                    <PropertyRow
                      key={index}
                      id={`${section.id}-${index}`}
                      label={property.label}
                    >
                      {(labelId) => (
                        <PropertyValue wrap>
                          <span
                            data-selectable
                            aria-labelledby={labelId}
                            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
                          >
                            {property.value}
                          </span>
                          <span className="flex shrink-0 items-center gap-0.5">
                            {property.copyable && (
                              <IconButton
                                size="3xsmall"
                                label={`复制${property.label}`}
                                icon={<CopyIcon className="size-3.5" />}
                                onClick={() => effect(clip.write(property.value))}
                              />
                            )}
                            {property.href && (
                              <IconButton
                                size="3xsmall"
                                label={`打开${property.label}`}
                                icon={<ExternalLinkIcon className="size-3.5" />}
                                onClick={() =>
                                  effect(
                                    invoke('external_url_open', { url: property.href }),
                                  )
                                }
                              />
                            )}
                          </span>
                        </PropertyValue>
                      )}
                    </PropertyRow>
                  ))}
                </div>
              )}
              {section.fields.length > 0 && (
                <div className="flex flex-col gap-stack-md">
                  {section.fields.map((field) =>
                    field.type === 'select' ? (
                      <Select
                        key={field.id}
                        size="xsmall"
                        label={field.label}
                        options={field.options}
                        value={values[field.id] ?? ''}
                        disabled={busy}
                        onChange={(value) =>
                          setValues((current) => ({ ...current, [field.id]: value }))
                        }
                      />
                    ) : field.type === 'textarea' ? (
                      <Textarea
                        key={field.id}
                        label={field.label}
                        maxLength={field.maxLength}
                        value={values[field.id] ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.id]: event.target.value,
                          }))
                        }
                      />
                    ) : (
                      <Input
                        key={field.id}
                        inputSize="xsmall"
                        label={field.label}
                        type={field.type}
                        secret={field.type === 'password'}
                        maxLength={field.maxLength}
                        required={field.required}
                        value={values[field.id] ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.id]: event.target.value,
                          }))
                        }
                      />
                    ),
                  )}
                </div>
              )}
              {section.actions.some((action) => action.placement === 'body') && (
                <div className="flex flex-wrap gap-2">
                  {buttons(
                    section.actions.filter((action) => action.placement === 'body'),
                  )}
                </div>
              )}
            </PeekSection>
          ))}
        </PropertySheet>
      </PeekBody>
      {view.actions.length > 0 && (
        <div
          data-plugin-footer
          className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-stroke-soft-200 p-inset"
        >
          {buttons(view.actions)}
        </div>
      )}
    </div>
  )
}
