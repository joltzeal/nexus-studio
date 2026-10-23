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
  | { stage: 'unconfirmed'; error: string; reading?: boolean }
  | { stage: 'failed'; error: string }

/**
 * Blocking gate in front of a launch. While it is open the rest of the page is
 * inert: the user is waiting on one decision, not browsing a table.
 *
 * The last stage keeps the preflight measurement visible, without claiming it
 * proves the running browser's exit IP.
 */
export function ProxyGateDialog({
  name,
  stage,
  onCancel,
  onProceed,
  onRefresh,
}: {
  name: string
  stage: GateStage
  onCancel: () => void
  onProceed: () => void
  onRefresh: () => void
}) {
  const busy =
    stage.stage === 'checking' ||
    stage.stage === 'launching' ||
    (stage.stage === 'unconfirmed' && stage.reading === true)

  return (
    <DialogContent
      className="proxy-gate"
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault()
      }}
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
            代理检测未通过，窗口尚未启动。请检查代理地址、认证和网络后重新检测。
          </p>
        ) : null}

        {stage.stage === 'blocked' && stage.outcome.kind === 'unsupported' ? (
          <p className="proxy-gate-warning">
            代理是否可用尚未确认，窗口尚未启动。请先到「插件中心 →
            代理池」检查插件和代理，再重试检测。
          </p>
        ) : null}

        {stage.stage === 'failed' || stage.stage === 'unconfirmed' ? (
          <p className="proxy-gate-warning" role="alert">
            {stage.error}
          </p>
        ) : null}
        {stage.stage === 'launched' && stage.outcome?.kind === 'checked' ? (
          <p className="proxy-gate-note">
            上方为启动前的代理检测结果；浏览器内的实际出口仍需通过真实请求验证。
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
            <Button onClick={onProceed}>重新检测</Button>
          </>
        ) : stage.stage === 'launched' ? (
          <Button onClick={onCancel}>关闭</Button>
        ) : stage.stage === 'unconfirmed' ? (
          <>
            <Button variant="outline" onClick={onCancel}>
              收起
            </Button>
            <Button onClick={onRefresh}>重新读取状态</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onCancel}>
              关闭
            </Button>
            <Button onClick={onProceed}>重新检测并打开</Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

function StageIcon({ stage }: { stage: GateStage }) {
  if (
    stage.stage === 'checking' ||
    stage.stage === 'launching' ||
    (stage.stage === 'unconfirmed' && stage.reading)
  ) {
    return <Loader2 className="animate-spin" aria-hidden="true" />
  }
  if (stage.stage === 'launched') return <CheckCircle2 aria-hidden="true" />
  if (stage.stage === 'failed' || stage.stage === 'unconfirmed')
    return <ShieldAlert aria-hidden="true" />
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
  if (stage.stage === 'unconfirmed') return '窗口运行状态尚未确认'
  if (stage.outcome.kind === 'unsupported') return '无法检测代理'
  return stage.outcome.result.ok ? '代理可用' : '代理不可用'
}

function descriptionOf(stage: GateStage, name: string): string {
  if (stage.stage === 'checking') {
    return `正在检测「${name}」使用的代理，检测期间无法进行其他操作。`
  }
  if (stage.stage === 'launching')
    return '启动前代理检测通过，正在等待宿主准备内核并确认运行状态，最长等待 120 秒。'
  if (stage.stage === 'launched') {
    return `宿主已确认「${name}」的浏览器进程正在运行。`
  }
  if (stage.stage === 'failed') return `「${name}」没能打开。`
  if (stage.stage === 'unconfirmed')
    return '等待已结束，后台请求仍可能继续。重新读取状态不会再次发起启动。'
  return `「${name}」的代理检测结果如下。`
}
