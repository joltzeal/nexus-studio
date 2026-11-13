import { createConfigurationTransfer } from '@nexus/plugin-sdk/configuration'
import {
  AgentNotificationSchema,
  AgentSettingsSchema,
  AgentStepInputSchema,
  type AgentSettings,
} from '@nexus/plugin-sdk/agent'
import { z } from 'zod'
import { AgentFailure } from './errors.js'
import type { AgentHost } from './host.js'
import type { AgentDispatchContext } from './rpc/server.js'
import { createAgentModels } from './services/models.js'
import { sendAgentNotification } from './services/notifications.js'
import { VintedTools } from './platform/vinted.js'
import type { SettingsStore } from './store/settings.js'
import { runAgentStep } from './workflow/step.js'

export class SalesAgentService {
  private readonly secrets = new Set<string>()
  private readonly activeJobs = new Set<string>()
  constructor(private readonly store: SettingsStore) {}

  scrub(message: string): string {
    let result = message.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1[REDACTED]@')
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]')
    return result
  }

  private remember(...secrets: string[]): void {
    for (const secret of secrets) if (secret.length > 3) this.secrets.add(secret)
  }

  private rememberSettings(settings: AgentSettings): void {
    this.remember(
      settings.decision.apiKey,
      settings.generation.apiKey,
      settings.notifications.deviceKey,
    )
  }

  async call(context: AgentDispatchContext, host: AgentHost): Promise<unknown> {
    context.assertAlive()
    if (context.method.startsWith('configuration.'))
      return createConfigurationTransfer({
        schema: AgentSettingsSchema.nullable(),
        read: () => this.store.read(),
        apply: async (settings) => {
          if (settings === null) return this.store.clear(context.assertAlive)
          this.rememberSettings(settings)
          await this.store.save(settings, context.assertAlive)
        },
        invalid: (message) => new AgentFailure('INVALID_REQUEST', message),
      }).call(context)
    if (context.method === 'salesAgent.settings.get') {
      if (!z.strictObject({}).safeParse(context.payload).success)
        throw new AgentFailure('INVALID_REQUEST', '设置查询参数无效')
      const settings = await this.store.read()
      if (settings) this.rememberSettings(settings)
      return { settings }
    }
    if (context.method === 'salesAgent.settings.save') {
      const input = z
        .strictObject({ settings: AgentSettingsSchema })
        .safeParse(context.payload)
      if (!input.success)
        throw new AgentFailure('INVALID_REQUEST', '请完整填写决策模型和生成模型')
      this.rememberSettings(input.data.settings)
      return { settings: await this.store.save(input.data.settings, context.assertAlive) }
    }
    if (context.method === 'salesAgent.models.test') {
      const input = z
        .strictObject({ kind: z.enum(['decision', 'generation']) })
        .safeParse(context.payload)
      if (!input.success) throw new AgentFailure('INVALID_REQUEST', '请选择要测试的模型')
      const settings = await this.store.read()
      if (!settings) throw new AgentFailure('INVALID_REQUEST', '请先保存模型设置')
      this.rememberSettings(settings)
      return createAgentModels(settings).test(input.data.kind, context.signal)
    }
    if (context.method === 'salesAgent.notifications.send') {
      const input = AgentNotificationSchema.safeParse(context.payload)
      if (!input.success) throw new AgentFailure('INVALID_REQUEST', '批次通知参数无效')
      this.remember(input.data.settings.deviceKey)
      return sendAgentNotification(input.data, { signal: context.signal })
    }
    if (context.method !== 'salesAgent.jobs.step')
      throw new AgentFailure('INVALID_REQUEST', '插件不支持该方法')
    const input = AgentStepInputSchema.safeParse(context.payload)
    if (!input.success)
      throw new AgentFailure('INVALID_REQUEST', '任务快照、模型设置或租约无效')
    if (this.activeJobs.has(input.data.scope.jobId))
      throw new AgentFailure('CONFLICT', '同一窗口任务已有步骤正在执行')
    this.activeJobs.add(input.data.scope.jobId)
    const { scope, snapshot, settings } = input.data
    this.rememberSettings(settings)
    try {
      const tools = new VintedTools(
        (request) => {
          context.assertAlive()
          return host.call(scope, 'agent.browser.execute', request, context.signal)
        },
        snapshot.platformOrigin,
        snapshot.account.platformUserId,
      )
      const models = createAgentModels(settings, {
        acquire: (request) => {
          context.assertAlive()
          return host.call(scope, 'agent.model.acquire', request, context.signal)
        },
        complete: (receipt) =>
          host.call(scope, 'agent.model.complete', receipt, context.signal),
      })
      return await runAgentStep(
        input.data,
        host,
        {
          ...models,
          inspectAccount: () => tools.inspectAccount(),
          readBalance: () => tools.readBalance(),
          readAccountEvidence: () => tools.readAccountEvidence(),
          snapshot: () => tools.snapshot(),
          openListing: () => tools.openListing(),
          openConversation: (id) => tools.openConversation(id),
          executePlan: (plan, product, operationId) =>
            tools.executePlan(plan, product, operationId),
          readListingForm: () => tools.readListingForm(),
          readMessageForm: (conversationId) => tools.readMessageForm(conversationId),
          readListingBaseline: () => tools.readListingBaseline(),
          readMessageBaseline: (conversationId) =>
            tools.readMessageBaseline(conversationId),
          confirmListing: (product, baseline) => tools.confirmListing(product, baseline),
          confirmMessage: (conversationId, text, baseline) =>
            tools.confirmMessage(conversationId, text, baseline),
        },
        context.signal,
      )
    } finally {
      this.activeJobs.delete(scope.jobId)
    }
  }
}
