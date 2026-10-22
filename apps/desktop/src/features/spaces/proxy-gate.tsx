import { CheckCircle2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ProxyCheckSummary } from '@/features/proxy/proxy-check-summary'
import type { ProxyCheckOutcome } from './window-proxy'

export type GateStage =
  | { stage: 'checking' }
  | { stage: 'blocked'; outcome: ProxyCheckOutcome }
  | { stage: 'launching'; outcome: ProxyCheckOutcome | null }
  | { stage: 'launched'; outcome: ProxyCheckOutcome | null }
  | { stage: 'failed'; error: string }

/**
 * Blocking gate in front of a launch. While it is open the rest of the page is
 * inert: the user is waiting on one decision, not browsing a table.
 *
 * The last stage keeps the measurement on screen after the window is up, so
 * "which exit IP did this window use" is answered without another click.
 */
export function ProxyGateDialog({
  name,
  stage,
  onCancel,
  onProceed,
}: {
  name: string
  stage: GateStage
  onCancel: () => void
  onProceed: () => void
}) {
  const busy = stage.stage === 'checking' || stage.stage === 'launching'

  return (
    <DialogContent
      className="proxy-gate"
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        // Esc must not dismiss a dialog the page cannot cancel.
        event.preventDefault()
      }}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle className="proxy-gate-title">
          <StageIcon stage={stage} />
          {titleOf(stage)}
        </DialogTitle>
        <DialogDescription>{descriptionOf(stage, name)}</DialogDescription>
      </DialogHeader>

      <div className="proxy-gate-body">
        {stage.stage === 'checking' ? (
          <p className="proxy-gate-note" role="status">
            正在连接出口检测服务…
          </p>
        ) : null}

        {stage.stage === 'blocked' ? (
          stage.outcome.kind === 'checked' ? (
            <ProxyCheckSummary result={stage.outcome.result} />
          ) : (
            <p className="proxy-gate-note" role="status">
              无法检测代理：{stage.outcome.reason}
            </p>
          )
        ) : null}

        {stage.stage === 'launching' && stage.outcome?.kind === 'checked' ? (
          <ProxyCheckSummary result={stage.outcome.result} />
        ) : null}

        {stage.stage === 'launched' && stage.outcome?.kind === 'checked' ? (
          <ProxyCheckSummary result={stage.outcome.result} />
        ) : null}

        {stage.stage === 'blocked' &&
        stage.outcome.kind === 'checked' &&
        !stage.outcome.result.ok ? (
          <p className="proxy-gate-warning">
            这个代理当前不可用。继续打开会让窗口在没有可用出口的情况下启动。
          </p>
        ) : null}

        {stage.stage === 'blocked' && stage.outcome.kind === 'unsupported' ? (
          <p className="proxy-gate-warning">
            没有代理池插件时无法预先检测。你可以继续打开，或先到「插件中心 →
            代理池」启用插件。
          </p>
        ) : null}

        {stage.stage === 'failed' ? (
          <p className="proxy-gate-warning" role="alert">
            {stage.error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        {busy ? (
          <p className="proxy-gate-note" role="status">
            请稍候…
          </p>
        ) : stage.stage === 'blocked' ? (
          <>
            <Button variant="outline" onClick={onCancel}>
              关闭
            </Button>
            <Button variant="destructive" onClick={onProceed}>
              仍然打开
            </Button>
          </>
        ) : stage.stage === 'launched' ? (
          <Button onClick={onCancel}>关闭</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onCancel}>
              关闭
            </Button>
            <Button onClick={onProceed}>重试打开</Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

function StageIcon({ stage }: { stage: GateStage }) {
  if (stage.stage === 'checking' || stage.stage === 'launching') {
    return <Loader2 className="animate-spin" aria-hidden="true" />
  }
  if (stage.stage === 'launched') return <CheckCircle2 aria-hidden="true" />
  if (stage.stage === 'failed') return <ShieldAlert aria-hidden="true" />
  if (stage.outcome.kind === 'checked' && stage.outcome.result.ok) {
    return <ShieldCheck aria-hidden="true" />
  }
  return <ShieldAlert aria-hidden="true" />
}

function titleOf(stage: GateStage): string {
  if (stage.stage === 'checking') return '正在检测代理'
  if (stage.stage === 'launching') return '正在打开窗口'
  if (stage.stage === 'launched') return '窗口已打开'
  if (stage.stage === 'failed') return '窗口打开失败'
  if (stage.outcome.kind === 'unsupported') return '无法检测代理'
  return stage.outcome.result.ok ? '代理可用' : '代理不可用'
}

function descriptionOf(stage: GateStage, name: string): string {
  if (stage.stage === 'checking') {
    return `正在检测「${name}」使用的代理，检测期间无法进行其他操作。`
  }
  if (stage.stage === 'launching') return '代理检测通过，正在准备浏览器内核并打开窗口。'
  if (stage.stage === 'launched') {
    return `「${name}」已使用检测通过的代理打开。`
  }
  if (stage.stage === 'failed') return `「${name}」没能打开。`
  return `「${name}」的代理检测结果如下。`
}
