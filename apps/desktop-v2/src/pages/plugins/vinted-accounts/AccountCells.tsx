import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Tooltip, type DataListColumn } from '@proxyshard/shardx-ui-kit'
import {
  CopyIcon,
  DeleteIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  NavBrowsersIcon,
  ReadMailIcon,
  ReplaceLinkIcon,
} from '../../../shared/icons'
import {
  ACCOUNT_STATUS_LABELS,
  LOGIN_LABELS,
  type Account,
} from '../../../raccoon/plugins/vinted-accounts/model'
import {
  balanceSummary,
  bankSummary,
} from '../../../raccoon/plugins/vinted-accounts/financial'
import {
  formatAccountCreatedAt,
  type LinkedProfile,
} from '../../../raccoon/plugins/vinted-accounts/table'
import { PluginRowAction } from '../PluginRowAction'
import {
  AccountOtpCell,
  type AccountOtpCache,
  type AccountOtpResult,
} from './AccountOtpCell'

const stack = 'flex min-w-0 flex-col items-start gap-1 text-secondary'
const actions = 'flex shrink-0 items-center gap-1'
const statusColors = {
  unknown: 'gray',
  active: 'success',
  pending: 'warning',
  limited: 'information',
  blocked: 'error',
} as const

function CellText({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <Tooltip content={text} whenTruncated>
      <span
        className={`block min-w-0 max-w-full truncate text-secondary ${muted ? 'text-text-sub-600' : 'text-text-strong-950'}`}
      >
        {text}
      </span>
    </Tooltip>
  )
}

function AccountIdentity({
  account,
  copy,
}: {
  account: Account
  copy: ColumnOptions['copy']
}) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (!revealed) return
    const hide = () => setRevealed(false)
    window.addEventListener('blur', hide)
    return () => window.removeEventListener('blur', hide)
  }, [revealed])
  return (
    <div
      className={stack}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setRevealed(false)
      }}
    >
      <div className="flex w-full min-w-0 items-center gap-1">
        <CellText text={account.account} />
        <PluginRowAction
          label="复制登录账号"
          icon={<CopyIcon className="size-3.5" />}
          onClick={() => copy(account.account, '账号')}
        />
      </div>
      <div className="flex w-full min-w-0 items-center gap-1">
        <span className="shrink-0 text-text-sub-600">密码</span>
        <span
          className={`min-w-0 font-mono ${revealed ? 'overflow-x-auto whitespace-pre' : 'truncate'}`}
          tabIndex={revealed ? 0 : undefined}
          translate="no"
        >
          {account.password ? (revealed ? account.password : '••••••••') : '未设置'}
        </span>
        {account.password && (
          <PluginRowAction
            label={revealed ? '隐藏密码' : '显示密码'}
            aria-pressed={revealed}
            icon={
              revealed ? (
                <EyeOffIcon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )
            }
            onClick={() => setRevealed((current) => !current)}
          />
        )}
      </div>
    </div>
  )
}

function ObservationCell({
  label,
  onOpen,
  children,
}: {
  label: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <Button
      size="3xsmall"
      mode="ghost"
      variant="neutral"
      aria-label={label}
      className="h-auto! max-w-full justify-start! px-0! py-1! text-left!"
      onClick={onOpen}
    >
      <span className={stack}>{children}</span>
    </Button>
  )
}

type ColumnOptions = {
  busy: boolean
  canMailbox: boolean
  canReadMailbox: boolean
  canSelectPhone: boolean
  canSelectAddress: boolean
  canUnlinkAddress: boolean
  now: number
  codes: AccountOtpCache
  profiles: ReadonlyMap<string, readonly LinkedProfile[]>
  copy: (value: string, label: string, secret?: boolean) => void
  observe: (account: Account) => void
  readMailbox: (account: Account) => void
  mailbox: (account: Account) => void
  selectPhone: (account: Account) => void
  unlinkPhone: (account: Account) => void
  readOtp: (account: Account, channel: 'email' | 'sms') => void
  viewOtp: (account: Account, result: AccountOtpResult) => void
  address: (account: Account) => void
  selectAddress: (account: Account) => void
  unlinkAddress: (account: Account) => void
  manageProfiles: (account: Account) => void
  edit: (account: Account) => void
  remove: (account: Account) => void
}

export function accountColumns(options: ColumnOptions): DataListColumn<Account>[] {
  const { busy, copy, observe } = options
  const otp = (account: Account, channel: 'email' | 'sms') => (
    <AccountOtpCell
      account={account}
      channel={channel}
      codes={options.codes}
      busy={busy}
      onRead={() => options.readOtp(account, channel)}
      onView={(result) => options.viewOtp(account, result)}
    />
  )
  return [
    {
      id: 'account',
      header: '账号',
      width: 'minmax(0, 2fr)',
      cell: (row) => (
        <AccountIdentity
          key={JSON.stringify([row.id, row.updatedAt])}
          account={row}
          copy={copy}
        />
      ),
    },
    {
      id: 'login',
      header: '登录方式',
      width: 'minmax(4em, 0.65fr)',
      cell: (row) => <CellText text={LOGIN_LABELS[row.loginMethod]} />,
    },
    {
      id: 'mailbox',
      header: '邮箱',
      width: 'minmax(8.5rem, 1.55fr)',
      cell: (row) => (
        <div className={stack}>
          <CellText text={row.mailbox?.email ?? '未关联'} muted={!row.mailbox} />
          <div className={actions}>
            {row.mailbox && (
              <PluginRowAction
                label="查看关联邮箱的邮件"
                icon={<ReadMailIcon className="size-3.5" />}
                disabled={busy || !options.canReadMailbox}
                onClick={() => options.readMailbox(row)}
              />
            )}
            <PluginRowAction
              label={row.mailbox ? '管理邮箱关联' : '关联邮箱'}
              icon={<ReplaceLinkIcon className="size-3.5" />}
              disabled={busy || !options.canMailbox}
              onClick={() => options.mailbox(row)}
            />
            {row.mailbox && (
              <PluginRowAction
                label="复制关联邮箱"
                icon={<CopyIcon className="size-3.5" />}
                onClick={() => copy(row.mailbox!.email, '邮箱')}
              />
            )}
            {otp(row, 'email')}
          </div>
        </div>
      ),
    },
    {
      id: 'phone',
      header: '手机',
      width: 'minmax(8.5rem, 1.55fr)',
      cell: (row) => (
        <div className={stack}>
          <CellText text={row.phone || '未关联'} muted={!row.phone} />
          <div className={actions}>
            <PluginRowAction
              label="从 SIM8 选择号码"
              icon={<ReplaceLinkIcon className="size-3.5" />}
              disabled={busy || !options.canSelectPhone}
              onClick={() => options.selectPhone(row)}
            />
            {row.phone && (
              <PluginRowAction
                label="复制手机号"
                icon={<CopyIcon className="size-3.5" />}
                onClick={() => copy(row.phone, '手机号')}
              />
            )}
            {row.phone && (
              <PluginRowAction
                label="解除手机号关联"
                icon={<DeleteIcon className="size-3.5" />}
                variant="error"
                disabled={busy}
                onClick={() => options.unlinkPhone(row)}
              />
            )}
            {otp(row, 'sms')}
          </div>
        </div>
      ),
    },
    {
      id: 'address',
      header: '地址',
      width: 'minmax(5rem, 1.5fr)',
      cell: (row) => (
        <div className={stack}>
          <CellText
            text={
              row.address
                ? `${row.address.houseNumber} ${row.address.street} · ${row.address.city}`
                : '未关联'
            }
            muted={!row.address}
          />
          <div className={actions}>
            {row.address && (
              <PluginRowAction
                label="查看关联地址"
                icon={<GlobeIcon className="size-3.5" />}
                onClick={() => options.address(row)}
              />
            )}
            <PluginRowAction
              label={
                row.address ? '从 VInted helper 更换地址' : '从 VInted helper 关联地址'
              }
              icon={<ReplaceLinkIcon className="size-3.5" />}
              disabled={busy || !options.canSelectAddress}
              onClick={() => options.selectAddress(row)}
            />
            {row.address && (
              <PluginRowAction
                label="解除地址关联"
                icon={<DeleteIcon className="size-3.5" />}
                variant="error"
                disabled={busy || !options.canUnlinkAddress}
                onClick={() => options.unlinkAddress(row)}
              />
            )}
          </div>
        </div>
      ),
    },
    {
      id: 'status',
      header: '状态',
      width: 'minmax(4em, 0.6fr)',
      cell: (row) => (
        <Badge color={statusColors[row.status]} size="small">
          {ACCOUNT_STATUS_LABELS[row.status]}
        </Badge>
      ),
    },
    {
      id: 'balance',
      header: '余额',
      width: 'minmax(0, 1fr)',
      cell: (row) => (
        <ObservationCell label="查看余额记录" onOpen={() => observe(row)}>
          {balanceSummary(row.observation).map((amount) => (
            <CellText
              key={amount.key}
              text={`${amount.label} ${amount.value}${amount.failed ? ' · 读取失败' : ''}`}
            />
          ))}
        </ObservationCell>
      ),
    },
    {
      id: 'bank',
      header: '收款账户',
      width: 'minmax(0, 1fr)',
      cell: (row) => {
        const bank = bankSummary(row.observation)
        return (
          <ObservationCell label="查看收款账户" onOpen={() => observe(row)}>
            <CellText text={bank.label} />
            {(bank.detail || bank.failed) && (
              <CellText
                text={
                  bank.detail
                    ? `${bank.detail}${bank.failed ? ' · 读取失败' : ''}`
                    : '最近读取失败'
                }
                muted
              />
            )}
          </ObservationCell>
        )
      },
    },
    {
      id: 'profiles',
      header: '关联配置',
      width: 'minmax(0, 1.2fr)',
      cell: (row) => {
        const linked = options.profiles.get(row.id) ?? []
        const named = linked.find((profile) => profile.name)
        const otherCount = linked.length - (named ? 1 : 0)
        return (
          <div className={stack}>
            <CellText
              text={named?.name ?? (linked.length ? `${linked.length} 个配置` : '未关联')}
              muted={!named}
            />
            <div className={actions}>
              <PluginRowAction
                label={linked.length ? '查看关联配置' : '关联配置'}
                icon={<NavBrowsersIcon className="size-3.5" />}
                disabled={busy}
                onClick={() => options.manageProfiles(row)}
              />
              {named && otherCount > 0 && (
                <span className="text-help text-text-sub-600">+{otherCount}</span>
              )}
            </div>
          </div>
        )
      },
    },
    {
      id: 'created',
      header: '创建时间',
      width: 'minmax(8.5rem, 1.5fr)',
      cell: (row) => {
        const { absolute, relative } = formatAccountCreatedAt(row.createdAt, options.now)
        return (
          <time
            dateTime={relative ? row.createdAt : undefined}
            className={`${stack} tabular-nums`}
          >
            <CellText text={absolute} />
            {relative && <CellText text={relative} muted />}
          </time>
        )
      },
    },
    {
      id: 'operations',
      header: '操作',
      width: 'minmax(6.5rem, 0.8fr)',
      cell: (row) => (
        <div className={actions}>
          <PluginRowAction
            label="查看账号观察"
            icon={<EyeIcon className="size-3.5" />}
            onClick={() => observe(row)}
          />
          <PluginRowAction
            label="编辑账号"
            icon={<EditIcon className="size-3.5" />}
            onClick={() => options.edit(row)}
          />
          <PluginRowAction
            label="复制密码"
            icon={<CopyIcon className="size-3.5" />}
            disabled={!row.password}
            onClick={() => copy(row.password, '密码', true)}
          />
          <PluginRowAction
            label="删除账号"
            icon={<DeleteIcon className="size-3.5" />}
            variant="error"
            onClick={() => options.remove(row)}
          />
        </div>
      ),
    },
  ]
}
