import { useEffect, useRef, useState } from 'react'
import { toast } from '@/components/ui/toast'
import {
  listNativeProfiles,
  operateNativeProfile,
  type NativeProfile,
} from '@/lib/platform/native-profiles'
import { transferError } from '@/lib/platform/native-transfer'
import type { GateStage } from './proxy-gate'
import { toggleSelection, withDeadline } from './transfer-state'
import { launchAndConfirm, LaunchUnconfirmedError } from './window-launch'
import { checkWindowProxy, hasProxy, type ProxyCheckOutcome } from './window-proxy'

interface GateState {
  window: NativeProfile
  stage: GateStage
}

export function useWindowLaunch(
  onRecords: (records: NativeProfile[]) => void,
  onError: (error: string | null) => void,
) {
  const [operating, setOperating] = useState<Set<string>>(() => new Set())
  const [launching, setLaunching] = useState<Set<string>>(() => new Set())
  const [unconfirmedWindows, setUnconfirmed] = useState<Set<string>>(() => new Set())
  const [gate, setGate] = useState<GateState | null>(null)
  const pendingLaunches = useRef(new Set<string>())
  const gateBusy = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  function markOperating(id: string, busy: boolean) {
    if (mounted.current) setOperating((current) => toggleSelection(current, [id], busy))
  }

  function markLaunching(id: string, busy: boolean) {
    if (mounted.current) setLaunching((current) => toggleSelection(current, [id], busy))
  }

  async function readRecords() {
    const records = await withDeadline(
      listNativeProfiles(),
      10_000,
      '读取运行状态超时；原生操作结果仍未确认。',
    )
    if (mounted.current) {
      onRecords(records)
      setUnconfirmed((current) =>
        toggleSelection(
          current,
          records.filter((record) => record.running).map((record) => record.id),
          false,
        ),
      )
      setGate((current) =>
        current !== null &&
        records.some((record) => record.id === current.window.id && record.running)
          ? null
          : current,
      )
    }
    return records
  }

  async function withOperating(window: NativeProfile, run: () => Promise<void>) {
    markOperating(window.id, true)
    try {
      await run()
    } finally {
      if (!pendingLaunches.current.has(window.id)) markOperating(window.id, false)
    }
  }

  async function launch(window: NativeProfile) {
    const request = operateNativeProfile(window.id, false)
    markLaunching(window.id, true)
    pendingLaunches.current.add(window.id)
    let waiting = true
    const settled = () => {
      pendingLaunches.current.delete(window.id)
      if (!waiting && mounted.current) {
        markOperating(window.id, false)
        markLaunching(window.id, false)
        void readRecords().then(
          () => {
            if (mounted.current)
              setUnconfirmed((current) => toggleSelection(current, [window.id], false))
          },
          () => undefined,
        )
      }
    }
    void request.then(settled, settled)
    try {
      const records = await launchAndConfirm(window.id, () => request, listNativeProfiles)
      if (mounted.current) onRecords(records)
    } catch (cause) {
      if (cause instanceof LaunchUnconfirmedError && mounted.current) {
        setUnconfirmed((current) => toggleSelection(current, [window.id], true))
      }
      throw cause
    } finally {
      waiting = false
      if (!pendingLaunches.current.has(window.id)) markLaunching(window.id, false)
    }
  }

  async function proceed(window: NativeProfile, outcome: ProxyCheckOutcome) {
    setGate({ window, stage: { stage: 'launching', outcome } })
    try {
      await withOperating(window, () => launch(window))
      if (!mounted.current) return
      setGate(null)
      toast.success(`「${window.name}」已打开`)
    } catch (cause) {
      if (!mounted.current) return
      setGate({
        window,
        stage: {
          stage: cause instanceof LaunchUnconfirmedError ? 'unconfirmed' : 'failed',
          error: transferError(cause),
        },
      })
      void readRecords().catch(() => undefined)
    }
  }

  async function open(window: NativeProfile) {
    if (gateBusy.current || pendingLaunches.current.has(window.id)) return
    gateBusy.current = true
    onError(null)
    try {
      if (!hasProxy(window)) {
        try {
          await withOperating(window, () => launch(window))
        } catch (cause) {
          if (mounted.current) onError(transferError(cause))
          void readRecords().catch(() => undefined)
        }
        return
      }
      setGate({ window, stage: { stage: 'checking' } })
      const outcome = await checkWindowProxy(window)
      if (!mounted.current) return
      if (outcome.kind === 'checked' && outcome.result.ok) {
        await proceed(window, outcome)
      } else {
        setGate({ window, stage: { stage: 'blocked', outcome } })
      }
    } finally {
      gateBusy.current = false
    }
  }

  async function stop(window: NativeProfile) {
    if (operating.has(window.id) || unconfirmedWindows.has(window.id)) return
    onError(null)
    try {
      await withOperating(window, async () => {
        await withDeadline(
          operateNativeProfile(window.id, true),
          30_000,
          '等待停止窗口超时；结果尚未确认，请刷新运行状态。',
        )
        await readRecords()
      })
    } catch (cause) {
      if (mounted.current) onError(transferError(cause))
      void readRecords().catch(() => undefined)
    }
  }

  async function refreshGate(window: NativeProfile) {
    if (gateBusy.current) return
    gateBusy.current = true
    setGate({
      window,
      stage: { stage: 'unconfirmed', error: '正在重新读取运行状态…', reading: true },
    })
    try {
      const records = await readRecords()
      if (!mounted.current) return
      const running = records.some((record) => record.id === window.id && record.running)
      if (running || !pendingLaunches.current.has(window.id)) {
        setUnconfirmed((current) => toggleSelection(current, [window.id], false))
      }
      if (running) {
        markOperating(window.id, false)
        setGate(null)
      } else {
        setGate({
          window,
          stage: {
            stage: pendingLaunches.current.has(window.id) ? 'unconfirmed' : 'failed',
            error: pendingLaunches.current.has(window.id)
              ? '原生启动请求仍未结束，目前尚未确认运行。可以收起弹窗后继续刷新状态。'
              : '窗口当前未运行，请重新检测代理后重试打开。',
          },
        })
      }
    } catch (cause) {
      if (mounted.current)
        setGate({ window, stage: { stage: 'unconfirmed', error: transferError(cause) } })
    } finally {
      gateBusy.current = false
    }
  }

  function closeGate() {
    if (
      gate?.stage.stage !== 'checking' &&
      gate?.stage.stage !== 'launching' &&
      !(gate?.stage.stage === 'unconfirmed' && gate.stage.reading)
    )
      setGate(null)
  }

  return {
    gate,
    operatingWindows: new Set([...operating, ...unconfirmedWindows]),
    startingWindows: new Set([
      ...launching,
      ...unconfirmedWindows,
      ...(gate?.stage.stage === 'checking' ? [gate.window.id] : []),
    ]),
    unconfirmedWindows,
    open,
    stop,
    refreshGate,
    closeGate,
  }
}
