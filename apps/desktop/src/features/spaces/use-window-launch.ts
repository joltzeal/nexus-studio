import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/components/ui/toast'
import {
  startBrowserWindow,
  stopBrowserWindow,
  type BrowserWindow,
} from '@/lib/platform/windows'
import { BrowserApiError } from '@/lib/platform/browser-api'
import { transferError } from '@/lib/platform/native-transfer'
import type { GateStage } from './proxy-gate'
import { toggleSelection, withDeadline } from './transfer-state'
import { launchAndConfirm, LaunchUnconfirmedError } from './window-launch'
import { checkWindowProxy, hasProxy, type ProxyCheckOutcome } from './window-proxy'

interface GateState {
  window: BrowserWindow
  view: { connectionId: string | null; revision: number }
  stage: GateStage
}

export function useWindowLaunch(
  readWindows: () => Promise<BrowserWindow[]>,
  onError: (error: string | null) => void,
  connectionId: string | null,
  connectionRevision: number,
) {
  const [operating, setOperating] = useState<Set<string>>(() => new Set())
  const [launching, setLaunching] = useState<Set<string>>(() => new Set())
  const [uncertainStarts, setUncertainStarts] = useState<Set<string>>(() => new Set())
  const [unconfirmedWindows, setUnconfirmed] = useState<Set<string>>(() => new Set())
  const [gate, setGate] = useState<GateState | null>(null)
  const pendingLaunches = useRef(new Set<string>())
  const pendingStops = useRef(new Set<string>())
  const gateBusy = useRef(false)
  const mounted = useRef(false)
  const currentView = useMemo(
    () => ({ connectionId, revision: connectionRevision }),
    [connectionId, connectionRevision],
  )
  const view = useRef<typeof currentView | null>(null)
  useEffect(() => {
    view.current = currentView
    return () => {
      if (view.current === currentView) view.current = null
    }
  }, [currentView])
  const visible = () => mounted.current && view.current === currentView
  const actionRequests = useRef(new Set<string>())

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
      readWindows(),
      10_000,
      '读取运行状态超时；原生操作结果仍未确认。',
    )
    if (mounted.current) {
      setUnconfirmed((current) =>
        toggleSelection(
          current,
          records
            .filter(
              (record) =>
                !pendingStops.current.has(record.id) &&
                (record.state === 'running' ||
                  (record.state === 'stopped' &&
                    !pendingLaunches.current.has(record.id))),
            )
            .map((record) => record.id),
          false,
        ),
      )
      setUncertainStarts((current) =>
        toggleSelection(
          current,
          records
            .filter(
              (record) =>
                record.state === 'running' ||
                (record.state === 'stopped' && !pendingLaunches.current.has(record.id)),
            )
            .map((record) => record.id),
          false,
        ),
      )
      setGate((current) =>
        current !== null &&
        records.some(
          (record) => record.id === current.window.id && record.state === 'running',
        )
          ? null
          : current,
      )
    }
    return records
  }

  async function withOperating(window: BrowserWindow, run: () => Promise<void>) {
    markOperating(window.id, true)
    try {
      await run()
    } finally {
      if (!pendingLaunches.current.has(window.id)) markOperating(window.id, false)
    }
  }

  async function launch(window: BrowserWindow) {
    const request = startBrowserWindow(window.id)
    markLaunching(window.id, true)
    pendingLaunches.current.add(window.id)
    let waiting = true
    const settled = () => {
      pendingLaunches.current.delete(window.id)
      if (!waiting && mounted.current) {
        markOperating(window.id, false)
        markLaunching(window.id, false)
        void readRecords().catch(() => undefined)
      }
    }
    void request.then(settled, settled)
    try {
      await launchAndConfirm(window.id, () => request, readRecords)
    } catch (cause) {
      const uncertain =
        cause instanceof LaunchUnconfirmedError ||
        (cause instanceof BrowserApiError && cause.code === 'operation_uncertain')
      if (uncertain && mounted.current) {
        setUnconfirmed((current) => toggleSelection(current, [window.id], true))
        setUncertainStarts((current) => toggleSelection(current, [window.id], true))
      }
      if (uncertain && cause instanceof Error)
        throw new LaunchUnconfirmedError(cause.message)
      throw cause
    } finally {
      waiting = false
      if (!pendingLaunches.current.has(window.id)) markLaunching(window.id, false)
    }
  }

  async function proceed(window: BrowserWindow, outcome: ProxyCheckOutcome) {
    setGate({ window, view: currentView, stage: { stage: 'launching', outcome } })
    try {
      await withOperating(window, () => launch(window))
      if (!visible()) return
      setGate(null)
      toast.success(`「${window.name}」已打开`)
    } catch (cause) {
      if (!visible()) return
      setGate({
        window,
        view: currentView,
        stage: {
          stage: cause instanceof LaunchUnconfirmedError ? 'unconfirmed' : 'failed',
          error: transferError(cause),
        },
      })
      void readRecords().catch(() => undefined)
    }
  }

  async function open(window: BrowserWindow) {
    if (
      !visible() ||
      window.state !== 'stopped' ||
      window.connectionId !== connectionId ||
      gateBusy.current ||
      pendingStops.current.has(window.id) ||
      pendingLaunches.current.has(window.id) ||
      actionRequests.current.has(window.id) ||
      operating.has(window.id) ||
      unconfirmedWindows.has(window.id)
    )
      return
    actionRequests.current.add(window.id)
    gateBusy.current = true
    onError(null)
    try {
      if (!hasProxy(window)) {
        try {
          await withOperating(window, () => launch(window))
        } catch (cause) {
          if (visible()) onError(transferError(cause))
          void readRecords().catch(() => undefined)
        }
        return
      }
      setGate({ window, view: currentView, stage: { stage: 'checking' } })
      const outcome = await checkWindowProxy(window)
      if (!visible()) return
      if (outcome.kind === 'checked' && outcome.result.ok) {
        await proceed(window, outcome)
      } else {
        setGate({ window, view: currentView, stage: { stage: 'blocked', outcome } })
      }
    } finally {
      actionRequests.current.delete(window.id)
      gateBusy.current = false
    }
  }

  async function stop(window: BrowserWindow) {
    if (
      !visible() ||
      window.state !== 'running' ||
      window.connectionId !== connectionId ||
      pendingStops.current.has(window.id) ||
      pendingLaunches.current.has(window.id) ||
      actionRequests.current.has(window.id) ||
      operating.has(window.id) ||
      unconfirmedWindows.has(window.id)
    )
      return
    actionRequests.current.add(window.id)
    onError(null)
    try {
      await withOperating(window, async () => {
        const request = stopBrowserWindow(window.id)
        pendingStops.current.add(window.id)
        let waiting = true
        const settled = () => {
          pendingStops.current.delete(window.id)
          if (!waiting && mounted.current) void readRecords().catch(() => undefined)
        }
        void request.then(settled, settled)
        try {
          await withDeadline(
            request,
            30_000,
            '等待停止窗口超时；结果尚未确认，请刷新运行状态。',
          )
          const records = await readRecords()
          if (
            mounted.current &&
            !records.some(
              (record) => record.id === window.id && record.state === 'stopped',
            )
          )
            setUnconfirmed((current) => toggleSelection(current, [window.id], true))
        } finally {
          waiting = false
        }
      })
    } catch (cause) {
      if (visible()) onError(transferError(cause))
      if (mounted.current)
        setUnconfirmed((current) => toggleSelection(current, [window.id], true))
      void readRecords().catch(() => undefined)
    } finally {
      actionRequests.current.delete(window.id)
    }
  }

  async function refreshGate(window: BrowserWindow) {
    if (gateBusy.current) return
    gateBusy.current = true
    setGate({
      window,
      view: currentView,
      stage: { stage: 'unconfirmed', error: '正在重新读取运行状态…', reading: true },
    })
    try {
      const records = await readRecords()
      if (!visible()) return
      const observed = records.find((record) => record.id === window.id)
      const running = records.some(
        (record) => record.id === window.id && record.state === 'running',
      )
      if (
        !pendingStops.current.has(window.id) &&
        (running ||
          (observed?.state === 'stopped' && !pendingLaunches.current.has(window.id)))
      ) {
        setUnconfirmed((current) => toggleSelection(current, [window.id], false))
      }
      if (running && !pendingStops.current.has(window.id)) {
        markOperating(window.id, false)
        setGate(null)
      } else {
        setGate({
          window,
          view: currentView,
          stage: {
            stage:
              observed?.state !== 'stopped' ||
              pendingLaunches.current.has(window.id) ||
              pendingStops.current.has(window.id)
                ? 'unconfirmed'
                : 'failed',
            error:
              observed?.state !== 'stopped' ||
              pendingLaunches.current.has(window.id) ||
              pendingStops.current.has(window.id)
                ? '浏览器状态仍待确认；请继续刷新或到官方浏览器核对，暂不重复启停。'
                : '窗口当前未运行，请重新检测代理后重试打开。',
          },
        })
      }
    } catch (cause) {
      if (visible())
        setGate({
          window,
          view: currentView,
          stage: { stage: 'unconfirmed', error: transferError(cause) },
        })
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
    gate:
      gate?.window.connectionId === connectionId && gate.view === currentView
        ? gate
        : null,
    operatingWindows: new Set([...operating, ...unconfirmedWindows]),
    startingWindows: new Set([
      ...launching,
      ...uncertainStarts,
      ...(gate?.stage.stage === 'checking' ? [gate.window.id] : []),
    ]),
    unconfirmedWindows,
    open,
    stop,
    refreshGate,
    closeGate,
  }
}
