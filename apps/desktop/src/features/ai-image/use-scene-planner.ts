import { useLayoutEffect, useMemo, useState } from 'react'
import { createScenePlan, getScenePlan } from './api'
import {
  sceneContextKey,
  sceneDraft,
  sceneDraftProblem,
  supportsScenePlans,
  SCENE_PLAN_STALE_HINT,
  SCENE_PLAN_UPDATE_HINT,
  type ScenePlanContext,
  type ScenePlanDraft,
} from './scene-plan'
import { ScenePlanSession, type ScenePlanState } from './scene-plan-session'
import { message } from './types'

export function useScenePlanner(
  context: ScenePlanContext,
  methods: readonly string[] | undefined,
  onCompleted: (draft: ScenePlanDraft) => void,
  onAccepted: () => Promise<void>,
) {
  const [session] = useState(
    () => new ScenePlanSession({ create: createScenePlan, get: getScenePlan }),
  )
  const [smart, setSmart] = useState(false)
  const [draft, setDraft] = useState<ScenePlanDraft | null>(null)
  const key = sceneContextKey(context)
  const supported = supportsScenePlans(methods)
  // Identity changes even when the user switches away and back to the same inputs.
  const token = useMemo(() => ({ key, supported }), [key, supported])
  const [result, setResult] = useState<{
    token: typeof token
    state: ScenePlanState
    presetRevision: number
  } | null>(null)
  const current = result?.token === token ? result.state : null
  const pending =
    smart && (current?.status === 'creating' || current?.status === 'running')

  // Cancel at commit, before a late response can overwrite an edited draft.
  useLayoutEffect(() => () => session.cancel(), [session, token])

  function notify(state: ScenePlanState, presetRevision: number) {
    if (state.status === 'success' && state.plan) {
      try {
        const next = sceneDraft(state.plan, context, presetRevision)
        setDraft(next)
        onCompleted(next)
      } catch (cause) {
        setResult({
          token,
          presetRevision,
          state: { ...state, status: 'failed', error: message(cause) },
        })
        return
      }
    }
    setResult({ token, state, presetRevision })
  }

  async function start(presetRevision: number) {
    if (pending) return
    setSmart(true)
    if (!supported) {
      setResult({
        token,
        presetRevision,
        state: { status: 'failed', plan: null, error: SCENE_PLAN_UPDATE_HINT },
      })
      return
    }
    try {
      await session.start(
        {
          providerId: context.providerId,
          model: context.model,
          inputFileId: context.inputFileId,
          requirements: context.requirements,
          count: context.count,
        },
        (state) => notify(state, presetRevision),
        () => void onAccepted().catch(() => undefined),
      )
    } catch (cause) {
      setResult({
        token,
        presetRevision,
        state: { status: 'failed', plan: null, error: message(cause) },
      })
    }
  }

  function resume() {
    if (current?.plan && current.status === 'read-error' && result)
      session.resume(current.plan, (state) => notify(state, result.presetRevision))
  }

  const stale = result !== null && result.token !== token
  const problem = stale ? SCENE_PLAN_STALE_HINT : sceneDraftProblem(draft, context)
  const ready = supported && current?.status === 'success' && problem === null
  return {
    smart,
    draft,
    setDraft,
    current,
    pending,
    supported,
    ready,
    problem,
    stale,
    start,
    resume,
    useExisting: () => {
      if (ready) setSmart(true)
    },
    manual: () => {
      session.cancel()
      setSmart(false)
    },
    cancel: () => session.cancel(),
  }
}
