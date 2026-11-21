import { Alert, Modal } from '@proxyshard/shardx-ui-kit'
import type { AccountObservation } from '../../../raccoon/plugins/vinted-accounts/observation'
import { AgentHistoryAction } from '../../../raccoon/plugins/AgentHistoryAction'
import {
  balanceSummary,
  bankSummary,
  sessionSummary,
} from '../../../raccoon/plugins/vinted-accounts/financial'

export function ObservationDialog({
  name,
  observation,
  accountId,
  bindings = [],
  onClose,
}: {
  name: string
  observation: AccountObservation | undefined
  accountId: string
  bindings?: readonly { accountId: string; windowId: string; revision?: string }[]
  onClose: () => void
}) {
  const amounts = balanceSummary(observation)
  const bank = bankSummary(observation)
  const sessions = sessionSummary(accountId, observation, bindings)
  return (
    <Modal
      footer={<AgentHistoryAction kind="account" id={accountId} beforeOpen={onClose} />}
      open
      title={`账号观察 · ${name}`}
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div className="flex flex-col gap-4">
        <Alert status="information" variant="lighter">
          以下是插件已保存的观察记录，并非实时查询。切换浏览器、断线或读取失败不等于已退出登录。
        </Alert>
        {!observation ? (
          <p className="text-secondary text-text-soft-400">暂无观察记录</p>
        ) : (
          <>
            <section>
              <h2 className="m-0 text-panel-title text-text-strong-950">资料摘要</h2>
              <p className="text-secondary text-text-sub-600">
                {observation.summary || '暂无摘要'}
              </p>
              <p className="text-secondary text-text-soft-400">
                {observation.tags?.join(' / ') || '暂无标签'}
                {observation.rating !== undefined ? `；评分 ${observation.rating}/5` : ''}
              </p>
            </section>
            <section>
              <h2 className="m-0 text-panel-title text-text-strong-950">余额记录</h2>
              <dl className="flex flex-col gap-3">
                {amounts.map((amount) => (
                  <div key={amount.key}>
                    <div className="flex justify-between gap-3 text-secondary text-text-sub-600">
                      <dt>{amount.label}</dt>
                      <dd className="m-0 tabular-nums">{amount.value}</dd>
                    </div>
                    <p className="mb-0 mt-1 text-micro text-text-soft-400">
                      {amount.source ?? '尚无采集来源'}
                      {amount.observedAt
                        ? ` · ${new Date(amount.observedAt).toLocaleString()}`
                        : ''}
                    </p>
                    {amount.failed && (
                      <p className="mb-0 mt-1 text-micro text-text-soft-400">
                        {amount.retained
                          ? '最近读取失败，保留此前金额'
                          : '最近读取失败，金额未知'}
                      </p>
                    )}
                  </div>
                ))}
              </dl>
            </section>
            <section>
              <h2 className="m-0 text-panel-title text-text-strong-950">收款账户</h2>
              {observation.bankAccounts ? (
                <>
                  <p className="text-secondary text-text-soft-400">
                    官方接口 ·{' '}
                    {new Date(observation.bankAccounts.observedAt).toLocaleString()}
                  </p>
                  {!observation.bankAccounts.records.length && (
                    <p className="text-secondary text-text-sub-600">
                      已检查，未绑定收款账户。
                    </p>
                  )}
                  {bank.detail && (
                    <p className="text-secondary text-text-soft-400">{bank.detail}</p>
                  )}
                  {observation.bankAccounts.records.map((item) => (
                    <dl
                      key={item.id}
                      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-b border-stroke-soft-200 pb-3 text-secondary text-text-sub-600 last:border-0"
                    >
                      <dt className="text-text-soft-400">收款账户</dt>
                      <dd className="m-0 break-all font-mono">{item.account_number}</dd>
                      <dt className="text-text-soft-400">姓名</dt>
                      <dd className="m-0 break-all">
                        {item.hide_name ? '平台隐藏姓名' : item.name || '—'}
                      </dd>
                      <dt className="text-text-soft-400">Routing number</dt>
                      <dd className="m-0 font-mono">{item.routing_number}</dd>
                      <dt className="text-text-soft-400">原始类型</dt>
                      <dd className="m-0 break-all">{item.spending_type}</dd>
                      <dt className="text-text-soft-400">默认账户</dt>
                      <dd className="m-0">{item.is_default ? '是' : '否'}</dd>
                    </dl>
                  ))}
                </>
              ) : (
                <p className="text-secondary text-text-soft-400">尚未读取</p>
              )}
              {observation.checks.bankAccounts?.outcome === 'failed' && (
                <p className="text-secondary text-text-sub-600">
                  最近读取失败，已有记录保留。
                </p>
              )}
            </section>
            <section>
              <h2 className="m-0 text-panel-title text-text-strong-950">
                Profile 登录记录
              </h2>
              {sessions.map((session) => (
                <p
                  key={session.profileId}
                  className="break-all text-secondary text-text-sub-600"
                >
                  {session.profileId} · {session.label}
                  {session.observedAt
                    ? `（${new Date(session.observedAt).toLocaleString()}）`
                    : ''}
                  {session.failed && (
                    <span className="block text-micro text-text-soft-400">
                      最近检查失败{session.observedAt ? '，保留上次观察' : ''}
                    </span>
                  )}
                </p>
              ))}
              {!sessions.length && (
                <p className="text-secondary text-text-soft-400">暂无登录观察</p>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  )
}
