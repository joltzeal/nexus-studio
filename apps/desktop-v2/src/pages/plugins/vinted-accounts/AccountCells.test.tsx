import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { accountColumns } from './AccountCells'
import type { Account } from '../../../raccoon/plugins/vinted-accounts/model'

const account: Account = {
  id: 'account-1',
  account: 'login@example.test',
  password: 'fixture-password',
  loginMethod: 'email',
  phone: '+12025550112',
  emailOtpUrl: '',
  smsOtpUrl: '',
  status: 'active',
  note: '',
  homepageUrl: '',
  mailbox: {
    pluginId: 'studio.email',
    mailboxId: 'mailbox-1',
    email: 'inbox@example.test',
    linkedAt: '2026-11-20T10:00:00Z',
  },
  address: null,
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
}

it('renders ordered business columns and routes each relation action to the displayed account', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const actions = {
    copy: vi.fn(),
    observe: vi.fn(),
    readMailbox: vi.fn(),
    mailbox: vi.fn(),
    selectPhone: vi.fn(),
    unlinkPhone: vi.fn(),
    readOtp: vi.fn(),
    viewOtp: vi.fn(),
    address: vi.fn(),
    selectAddress: vi.fn(),
    unlinkAddress: vi.fn(),
    manageProfiles: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(),
  }
  const columns = accountColumns({
    busy: false,
    canMailbox: true,
    canReadMailbox: true,
    canSelectPhone: true,
    canSelectAddress: true,
    canUnlinkAddress: true,
    codes: {},
    now: Date.parse('2026-11-20T12:00:00Z'),
    profiles: new Map([
      [
        account.id,
        [{ id: 'profile-1', name: 'Shop Profile', connectionId: 'workspace-1' }],
      ],
    ]),
    ...actions,
  })
  function click(label: string) {
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )
    expect(button).not.toBeNull()
    button!.click()
  }
  try {
    expect(columns.map((column) => column.header)).toEqual([
      '账号',
      '登录方式',
      '邮箱',
      '手机',
      '地址',
      '状态',
      '余额',
      '收款账户',
      '关联配置',
      '创建时间',
      '操作',
    ])
    await act(async () =>
      root.render(
        <>
          {columns.map((column) => (
            <div key={column.id}>{column.cell(account)}</div>
          ))}
        </>,
      ),
    )
    expect(container.textContent).toContain('login@example.test')
    expect(container.textContent).toContain('inbox@example.test')
    expect(container.textContent).toContain('Shop Profile')
    expect(container.querySelector('time')?.dateTime).toBe(account.createdAt)
    expect(container.textContent).toContain('2小时前')
    expect(container.textContent).not.toContain(account.password)
    await act(async () => click('显示密码'))
    expect(container.textContent).toContain(account.password)
    await act(async () => click('隐藏密码'))
    expect(container.textContent).not.toContain(account.password)
    await act(async () => click('显示密码'))
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(container.textContent).not.toContain(account.password)
    await act(async () => click('查看关联邮箱的邮件'))
    await act(async () => click('从 SIM8 选择号码'))
    await act(async () => click('从 VInted helper 关联地址'))
    await act(async () => click('查看关联配置'))
    expect(actions.readMailbox).toHaveBeenCalledWith(account)
    expect(actions.selectPhone).toHaveBeenCalledWith(account)
    expect(actions.selectAddress).toHaveBeenCalledWith(account)
    expect(actions.manageProfiles).toHaveBeenCalledWith(account)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
