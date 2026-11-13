import type { AgentSettings } from '@nexus/plugin-sdk/agent'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export function NumberSetting({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  nullable = false,
  onChange,
}: {
  id: string
  label: string
  value: number | null
  min: number
  max: number
  step?: number
  nullable?: boolean
  onChange: (value: number | null) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value === null || !Number.isFinite(value) ? '' : value}
        placeholder={nullable ? '未设置' : undefined}
        onChange={(event) =>
          onChange(
            nullable && event.target.value === '' ? null : event.target.valueAsNumber,
          )
        }
      />
    </Field>
  )
}

export function ExecutionSettings({
  draft,
  onChange,
  disabled,
}: {
  draft: AgentSettings
  onChange: (value: AgentSettings) => void
  disabled: boolean
}) {
  const execution = draft.execution
  function set(key: keyof AgentSettings['execution'], value: number | null) {
    onChange({ ...draft, execution: { ...execution, [key]: value } })
  }
  return (
    <>
      <FieldSet disabled={disabled}>
        <FieldLegend>并发与速率</FieldLegend>
        <FieldGroup className="sales-agent-form-grid">
          <NumberSetting
            id="agent-model-concurrency"
            label="同时使用模型数"
            value={execution.modelConcurrency}
            min={1}
            max={10}
            onChange={(value) => set('modelConcurrency', value)}
          />
          <NumberSetting
            id="agent-model-rate"
            label="模型请求上限（次 / 分钟）"
            value={execution.modelRequestsPerMinute}
            min={1}
            max={600}
            onChange={(value) => set('modelRequestsPerMinute', value)}
          />
          {(['cloakbrowser', 'adspower', 'bitbrowser'] as const).map((provider) => (
            <NumberSetting
              key={provider}
              id={`agent-provider-${provider}`}
              label={`${provider === 'cloakbrowser' ? '内置浏览器' : provider === 'adspower' ? 'AdsPower' : '比特浏览器'}同时执行窗口数`}
              value={execution.providerConcurrency[provider]}
              min={1}
              max={10}
              onChange={(value) =>
                onChange({
                  ...draft,
                  execution: {
                    ...execution,
                    providerConcurrency: {
                      ...execution.providerConcurrency,
                      [provider]: value,
                    },
                  },
                })
              }
            />
          ))}
        </FieldGroup>
        <FieldDescription>
          使用自行配置的上限，不代表服务商许可证或实际可用容量。
        </FieldDescription>
      </FieldSet>
      <FieldSet disabled={disabled}>
        <FieldLegend>重试与冷却</FieldLegend>
        <FieldGroup className="sales-agent-form-grid">
          <NumberSetting
            id="agent-read-retries"
            label="读取最多重试次数"
            value={execution.maxReadRetries}
            min={0}
            max={5}
            onChange={(value) => set('maxReadRetries', value)}
          />
          <NumberSetting
            id="agent-retry-wait"
            label="重试基础等待（秒）"
            value={execution.retryBaseMs / 1000}
            min={0.5}
            max={30}
            step={0.5}
            onChange={(value) => set('retryBaseMs', (value ?? NaN) * 1000)}
          />
          <NumberSetting
            id="agent-cooldown"
            label="平台限流与账号冷却（秒）"
            value={execution.platformCooldownMs / 1000}
            min={1}
            max={300}
            onChange={(value) => set('platformCooldownMs', (value ?? NaN) * 1000)}
          />
        </FieldGroup>
        <FieldDescription>
          只对允许重试的读取和模型失败恢复等待；已提交或结果未知的写操作不会自动重放。
        </FieldDescription>
      </FieldSet>
      <FieldSet disabled={disabled}>
        <FieldLegend>模型价格与批次预算</FieldLegend>
        <FieldGroup className="sales-agent-form-grid">
          {(['decision', 'generation'] as const).flatMap((kind) =>
            (['inputPerMillionUsd', 'outputPerMillionUsd'] as const).map((key) => (
              <NumberSetting
                key={`${kind}-${key}`}
                id={`agent-price-${kind}-${key}`}
                label={`${kind === 'decision' ? '判断' : '生成 / 识图'} · ${key === 'inputPerMillionUsd' ? '输入' : '输出'}价格（USD / 百万 Token）`}
                value={draft.pricing[kind][key]}
                min={0}
                max={100000}
                step={0.01}
                nullable
                onChange={(value) =>
                  onChange({
                    ...draft,
                    pricing: {
                      ...draft.pricing,
                      [kind]: { ...draft.pricing[kind], [key]: value },
                    },
                  })
                }
              />
            )),
          )}
          <NumberSetting
            id="agent-request-budget"
            label="每批模型请求上限"
            value={execution.maxBatchModelRequests}
            min={1}
            max={100000}
            onChange={(value) => set('maxBatchModelRequests', value)}
          />
          <NumberSetting
            id="agent-cost-budget"
            label="每批费用预算（USD，选填）"
            value={execution.maxBatchCostUsd}
            min={0.0001}
            max={1000000}
            step={0.01}
            nullable
            onChange={(value) => set('maxBatchCostUsd', value)}
          />
        </FieldGroup>
        <FieldDescription>
          价格留空表示未知。费用预算须完整配置两种模型的输入与输出价格；未知 Token
          用量单独标记，已消费费用无法撤回。
        </FieldDescription>
      </FieldSet>
    </>
  )
}

export function NotificationRetentionSettings({
  draft,
  onChange,
  disabled,
}: {
  draft: AgentSettings
  onChange: (value: AgentSettings) => void
  disabled: boolean
}) {
  return (
    <>
      <FieldSet disabled={disabled}>
        <FieldLegend>Bark 通知</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch
              id="agent-notify-enabled"
              checked={draft.notifications.enabled}
              onCheckedChange={(enabled) =>
                onChange({ ...draft, notifications: { ...draft.notifications, enabled } })
              }
            />
            <FieldLabel htmlFor="agent-notify-enabled">启用批次通知</FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-bark-url">Bark 服务地址</FieldLabel>
            <Input
              id="agent-bark-url"
              type="url"
              value={draft.notifications.baseUrl}
              maxLength={2048}
              autoComplete="off"
              onChange={(event) =>
                onChange({
                  ...draft,
                  notifications: { ...draft.notifications, baseUrl: event.target.value },
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-bark-key">Bark 设备 Key</FieldLabel>
            <Input
              id="agent-bark-key"
              type="password"
              value={draft.notifications.deviceKey}
              maxLength={4096}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(event) =>
                onChange({
                  ...draft,
                  notifications: {
                    ...draft.notifications,
                    deviceKey: event.target.value,
                  },
                })
              }
            />
          </Field>
          {(['onCompleted', 'onAttention'] as const).map((key) => (
            <Field key={key} orientation="horizontal">
              <Switch
                id={`agent-notify-${key}`}
                checked={draft.notifications[key]}
                onCheckedChange={(enabled) =>
                  onChange({
                    ...draft,
                    notifications: { ...draft.notifications, [key]: enabled },
                  })
                }
              />
              <FieldLabel htmlFor={`agent-notify-${key}`}>
                {key === 'onCompleted' ? '批次结束时通知' : '需要人工处理时通知'}
              </FieldLabel>
            </Field>
          ))}
        </FieldGroup>
        <FieldDescription>
          默认关闭；保存后生效。普通执行步骤不发送通知，失败只作有限重试。
        </FieldDescription>
      </FieldSet>
      <FieldSet disabled={disabled}>
        <FieldLegend>已结束任务保留</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch
              id="agent-retention-enabled"
              checked={draft.retention.enabled}
              onCheckedChange={(enabled) =>
                onChange({ ...draft, retention: { ...draft.retention, enabled } })
              }
            />
            <FieldLabel htmlFor="agent-retention-enabled">
              自动清理符合条件的已结束任务
            </FieldLabel>
          </Field>
          <NumberSetting
            id="agent-retention-days"
            label="保留天数"
            value={draft.retention.days}
            min={1}
            max={3650}
            onChange={(value) =>
              onChange({
                ...draft,
                retention: { ...draft.retention, days: value ?? NaN },
              })
            }
          />
        </FieldGroup>
        <FieldDescription>
          默认关闭。未知动作、待同步、资源占用和商品发布事实受保护；手动清理仍须先预览并确认。
        </FieldDescription>
      </FieldSet>
    </>
  )
}
