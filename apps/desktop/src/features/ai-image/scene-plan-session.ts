import { message, type ScenePlan } from './types'
import { validateScenePlanInput, type ScenePlanInput } from './scene-plan'

export interface ScenePlanState {
  status: 'creating' | 'running' | 'success' | 'failed' | 'read-error'
  plan: ScenePlan | null
  error: string | null
}

interface PlanApi {
  create: (input: ScenePlanInput) => Promise<ScenePlan>
  get: (id: string) => Promise<ScenePlan>
}

/** Paid creation only happens in start(); resume() reads the existing job. */
export class ScenePlanSession {
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly api: PlanApi) {}

  cancel() {
    this.revision += 1
    clearTimeout(this.timer)
    this.timer = undefined
  }

  async start(
    input: ScenePlanInput,
    notify: (state: ScenePlanState) => void,
  ): Promise<void> {
    validateScenePlanInput(input)
    this.cancel()
    const revision = this.revision
    notify({ status: 'creating', plan: null, error: null })
    try {
      const plan = await this.api.create(input)
      if (revision === this.revision) this.accept(plan, revision, notify)
    } catch (cause) {
      if (revision === this.revision)
        notify({ status: 'failed', plan: null, error: message(cause) })
    }
  }

  resume(plan: ScenePlan, notify: (state: ScenePlanState) => void) {
    this.cancel()
    const revision = this.revision
    notify({ status: 'running', plan, error: null })
    void this.read(plan, revision, notify)
  }

  private accept(
    plan: ScenePlan,
    revision: number,
    notify: (state: ScenePlanState) => void,
  ) {
    notify({
      status: plan.status,
      plan,
      error:
        plan.status === 'failed'
          ? plan.error || '智能识图失败，请检查模型配置后手动重试。'
          : null,
    })
    if (revision === this.revision && plan.status === 'running') {
      this.timer = setTimeout(() => {
        void this.read(plan, revision, notify)
      }, 1500)
    }
  }

  private async read(
    plan: ScenePlan,
    revision: number,
    notify: (state: ScenePlanState) => void,
  ) {
    if (revision !== this.revision) return
    try {
      const next = await this.api.get(plan.id)
      if (revision !== this.revision) return
      if (next.id !== plan.id) throw new Error('读取到其他场景方案，请重新读取。')
      this.accept(next, revision, notify)
    } catch (cause) {
      if (revision === this.revision)
        notify({ status: 'read-error', plan, error: message(cause) })
    }
  }
}
