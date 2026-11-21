import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserWindow } from '@nexus/contracts/browser'
import {
  Alert,
  AlertModal,
  Button,
  DataList,
  EmptyState,
  Modal,
  Textarea,
} from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../../widgets/PageHeader/PageHeader'
import { PluginWorkspace } from '../PluginWorkspace'
import { ListColumn } from '../../../shared/ui/ListColumn'
import { AddIcon, RefreshIcon } from '../../../shared/icons'
import { clip, copySecret } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import {
  ACCOUNT_PLUGIN_ID,
  LOGIN_LABELS,
  type Account,
  type Binding,
} from '../../../raccoon/plugins/vinted-accounts/model'
import {
  EMPTY_ACCOUNT_FILTERS,
  filterAccounts,
  indexAccountProfiles,
  paginateAccounts,
  retainAccountSelection,
  type AccountFilters,
  type AccountPageSize,
} from '../../../raccoon/plugins/vinted-accounts/table'
import {
  accountsApi,
  supportsAccountBase,
  supportsAccountOptional,
} from '../../../raccoon/plugins/vinted-accounts/api'
import { WorkspaceScope } from '../../../raccoon/plugins/vinted-accounts/workspace-scope'
import type { AccountDraft } from './AccountForm'
import { AccountForm } from './AccountForm'
import { ImportDialog } from './ImportDialog'
import { OrderWatch } from './OrderWatch'
import { MailboxRelationDialog } from './MailboxRelationDialog'
import { ProfileBindings } from './ProfileBindings'
import { MailReader } from '../email/MailReader'
import { emailApi } from '../../../raccoon/plugins/email/api'
import type { MailboxView } from '../../../raccoon/plugins/email/model'
import {
  createMailboxRelations,
  duplicateMailboxPreview,
} from '../../../raccoon/plugins/vinted-accounts/mailbox-relations'
import { usePluginTask } from '../usePluginTask'
import { useWorkspace, workspace } from '../../../raccoon/store'
import { nativeApi } from '../../../raccoon/api'
import { supportsEmailReader } from '../../../raccoon/plugins/email/api'
import { ObservationDialog } from './ObservationDialog'
import { accountColumns } from './AccountCells'
import { AccountFilters as AccountFilterBar } from './AccountFilters'
import { AddressDialog } from './AddressDialog'
import type { AccountOtpCache, AccountOtpResult } from './AccountOtpCell'
import { AccountAddressPicker } from './AccountAddressPicker'
import { Sim8NumberPicker } from './Sim8NumberPicker'
import { sim8Api } from '../../../raccoon/plugins/sim8/api'
import { SIM8_CAPABILITY, SIM8_PLUGIN_ID } from '../../../raccoon/plugins/sim8/methods'
import { pluginUiIdentity } from '../../../raccoon/plugins/ui-session'
import { ADDRESS_PLUGIN_ID } from '../../../raccoon/plugins/address-generator/model'
import { supportsAddressFeature } from '../../../raccoon/plugins/address-generator/page-contract'
import { useNow } from '../../../shared/lib/useNow'
import {
  ProfileBatchDialog,
  MAX_BATCH_PROFILES,
  type ProfileBatchTarget,
} from '../../../raccoon/profile-batch'
import { bindCreatedProfile } from '../../../raccoon/plugins/vinted-accounts/profile-batch-binding'
import type { ScopeToken } from '../../../raccoon/plugins/vinted-accounts/workspace-scope'
import { AccountPager } from './AccountPager'
import { useDetailNavigation } from '../../../raccoon/plugins/detail-navigation'

export function VintedAccountsPage({
  connectionId,
  onManage,
}: {
  connectionId: string | null
  onManage: () => void
}) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === ACCOUNT_PLUGIN_ID),
  )
  const emailPlugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.email'),
  )
  const addressHelper = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === ADDRESS_PLUGIN_ID),
  )
  const sim8Plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === SIM8_PLUGIN_ID),
  )
  const canSelectPhone = Boolean(
    sim8Plugin?.enabled &&
    sim8Plugin.state === 'running' &&
    sim8Plugin.capabilities.includes(SIM8_CAPABILITY) &&
    sim8Plugin.granted.includes(SIM8_CAPABILITY) &&
    sim8Plugin.methods.includes('sim8.records.list'),
  )
  const canChangeAddress = supportsAccountOptional(plugin, 'address')
  const canSelectAddress =
    canChangeAddress && supportsAddressFeature(addressHelper, 'saved')
  const compatible = supportsAccountBase(plugin) && isNativeRaccoon()
  const pluginIdentity = JSON.stringify([
    plugin?.installation,
    plugin?.runtimeGeneration,
    plugin?.version,
    plugin?.enabled,
    plugin?.state,
  ])
  const canMailbox = supportsAccountOptional(plugin, 'mailbox')
  const canMailboxImport =
    supportsAccountOptional(plugin, 'mailboxImport') &&
    !!emailPlugin &&
    emailPlugin.state === 'running' &&
    emailPlugin.enabled &&
    emailPlugin.capabilities.includes('email.provider') &&
    emailPlugin.granted.includes('email.provider') &&
    ['email.accounts.get', 'email.accounts.targets'].every((method) =>
      emailPlugin.methods.includes(method),
    )
  const canOrders = supportsAccountOptional(plugin, 'orderWatch')
  const canEmailTargets =
    !!emailPlugin &&
    emailPlugin.enabled &&
    emailPlugin.state === 'running' &&
    emailPlugin.capabilities.includes('email.provider') &&
    emailPlugin.granted.includes('email.provider') &&
    emailPlugin.methods.includes('email.accounts.targets')
  const canReadMailbox = supportsEmailReader(emailPlugin)
  const scopeRef = useRef(new WorkspaceScope(connectionId))
  const scope = scopeRef.current
  const task = usePluginTask()
  const workspaceState = useWorkspace()
  const now = useNow()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [bindings, setBindings] = useState<Binding[]>([])
  const [otherProfiles, setOtherProfiles] = useState<
    Pick<BrowserWindow, 'id' | 'name' | 'connectionId'>[]
  >([])
  const [filters, setFilters] = useState<AccountFilters>({ ...EMPTY_ACCOUNT_FILTERS })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pageSize, setPageSize] = useState<AccountPageSize>(20)
  const [batch, setBatch] = useState<{
    targets: ProfileBatchTarget[]
    token: ScopeToken
    identity: string
    approved: Record<string, string[]>
  } | null>(null)
  const [batchConfirmation, setBatchConfirmation] = useState<{
    accountId: string
    name: string
    profileIds: string[]
  } | null>(null)
  const batchApproval = useRef<((approved: boolean) => void) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [durable, setDurable] = useState(true)
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)
  useDetailNavigation('account', (request) => {
    const token = scope.begin()
    void accountsApi
      .listAccounts()
      .then((result) => {
        if (!scope.current(token)) return
        const account = result.items.find((item) => item.id === request.id)
        if (!account) throw new Error('关联账号不可见，请重新核对。')
        setEditing(account)
      })
      .catch((cause) => {
        if (scope.current(token))
          setError(cause instanceof Error ? cause.message : '关联账号读取失败')
      })
  })
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState<Account | null>(null)
  const [otp, setOtp] = useState<(AccountOtpResult & { email: string }) | null>(null)
  const [codes, setCodes] = useState<AccountOtpCache>({})
  const [mailboxAccount, setMailboxAccount] = useState<Account | null>(null)
  const [mailboxes, setMailboxes] = useState<
    { id: string; email: string; enabled: boolean }[]
  >([])
  const [profileAccount, setProfileAccount] = useState<Account | null>(null)
  const [addressAccount, setAddressAccount] = useState<Account | null>(null)
  const [choosingAddress, setChoosingAddress] = useState<Account | null>(null)
  const [choosingPhone, setChoosingPhone] = useState<Account | null>(null)
  const [reader, setReader] = useState<MailboxView | null>(null)
  const [observing, setObserving] = useState<Pick<
    Account,
    'id' | 'account' | 'observation'
  > | null>(null)
  const [page, setPage] = useState(1)
  const [orderWatch, setOrderWatch] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    title: string
    detail: string
    label: string
    action: () => Promise<void>
    items?: string[]
  } | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(
    async (propagate = false) => {
      if (!compatible) return
      const token = scope.begin()
      const seq = ++generation.current
      setBusy(true)
      setError(null)
      try {
        const result = await accountsApi.listAccounts()
        if (!scope.current(token) || seq !== generation.current) return
        setAccounts(result.items)
        setBindings(result.bindings)
        setSelected((current) => retainAccountSelection(current, result.items))
        setDurable(result.storageDurable)
      } catch (cause) {
        if (scope.current(token) && seq === generation.current)
          setError(cause instanceof Error ? cause.message : '账号列表读取失败')
        if (propagate) throw cause
      } finally {
        if (scope.current(token) && seq === generation.current) setBusy(false)
      }
    },
    [compatible, connectionId, pluginIdentity],
  )
  useEffect(() => {
    scope.switchTo(connectionId)
    generation.current++
    setAccounts([])
    setBindings([])
    setOtherProfiles([])
    setEditing(undefined)
    setMailboxAccount(null)
    setOtp(null)
    setCodes({})
    setOrderWatch(false)
    setSelected(new Set())
    setFilters({ ...EMPTY_ACCOUNT_FILTERS })
    setProfileAccount(null)
    setAddressAccount(null)
    setChoosingAddress(null)
    setChoosingPhone(null)
    setObserving(null)
    setReader(null)
    setConfirmation(null)
    setImporting(false)
    setRemoving(null)
    setBatch(null)
    setBatchConfirmation(null)
    batchApproval.current?.(false)
    batchApproval.current = null
    void refresh()
    return () => {
      scope.invalidate()
      generation.current++
      batchApproval.current?.(false)
      batchApproval.current = null
    }
  }, [connectionId, refresh])
  useEffect(() => {
    setPage(1)
  }, [filters, pageSize])
  useEffect(() => {
    if (!canEmailTargets) {
      setMailboxes([])
      return
    }
    let alive = true
    void accountsApi.emailTargetsAll().then(
      (rows) => {
        if (alive) setMailboxes(rows)
      },
      () => {
        if (alive) setMailboxes([])
      },
    )
    return () => {
      alive = false
    }
  }, [canEmailTargets])
  const rows = useMemo(
    () => filterAccounts(accounts, bindings, filters),
    [accounts, bindings, filters],
  )
  const pagination = paginateAccounts(rows, page, pageSize)
  const hasOtherProfiles = useMemo(() => {
    const localIds = new Set(workspaceState.profiles.map((profile) => profile.id))
    return bindings.some((binding) => !localIds.has(binding.windowId))
  }, [bindings, workspaceState.profiles])
  useEffect(() => {
    if (!compatible || !hasOtherProfiles) return
    let active = true
    void nativeApi.call('browser_window_list').then(
      (result) => {
        if (!active) return
        const ids = new Set(bindings.map((binding) => binding.windowId))
        setOtherProfiles(
          (result as BrowserWindow[])
            .filter((profile) => ids.has(profile.id))
            .map(({ id, name, connectionId }) => ({ id, name, connectionId })),
        )
      },
      () => {
        if (active) setOtherProfiles([])
      },
    )
    return () => {
      active = false
    }
  }, [compatible, connectionId, bindings, hasOtherProfiles])
  const linkedProfiles = useMemo(
    () => indexAccountProfiles(bindings, [...otherProfiles, ...workspaceState.profiles]),
    [bindings, otherProfiles, workspaceState.profiles],
  )
  const visibleAccountIds = new Set(rows.map((account) => account.id))
  const hiddenSelectedCount = [...selected].filter(
    (id) => !visibleAccountIds.has(id),
  ).length
  const bindingCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const binding of bindings) {
      counts.set(binding.accountId, (counts.get(binding.accountId) ?? 0) + 1)
    }
    return counts
  }, [bindings])
  function copy(value: string, label: string, secret = false) {
    void (secret ? copySecret(value) : clip.write(value)).then(
      () => toast.ok(`${label}已复制`),
      (cause) => toast.fail({ title: `${label}复制失败`, detail: cause }),
    )
  }
  function currentBatch() {
    const current = usePluginCatalog
      .getState()
      .plugins.find((item) => item.id === ACCOUNT_PLUGIN_ID)
    return (
      !!batch &&
      scope.current(batch.token) &&
      supportsAccountBase(current) &&
      JSON.stringify([
        current?.installation,
        current?.runtimeGeneration,
        current?.version,
        current?.enabled,
        current?.state,
      ]) === batch.identity
    )
  }
  async function bindBatchAccount(accountId: string, profileId: string) {
    await bindCreatedProfile(
      accountsApi,
      accountId,
      profileId,
      (profileIds) => {
        if (JSON.stringify(batch?.approved[accountId]) === JSON.stringify(profileIds))
          return Promise.resolve(true)
        return new Promise<boolean>((resolve) => {
          if (!currentBatch()) {
            resolve(false)
            return
          }
          batchApproval.current = resolve
          setBatchConfirmation({
            accountId,
            name:
              batch?.targets.find((target) => target.id === accountId)?.name ?? accountId,
            profileIds,
          })
        })
      },
      currentBatch,
    )
  }
  function finishBatchApproval(approved: boolean) {
    const resolve = batchApproval.current
    batchApproval.current = null
    if (approved && batchConfirmation)
      setBatch((current) =>
        current
          ? {
              ...current,
              approved: {
                ...current.approved,
                [batchConfirmation.accountId]: batchConfirmation.profileIds,
              },
            }
          : current,
      )
    setBatchConfirmation(null)
    resolve?.(approved)
  }
  function beginBatch() {
    const targets = accounts
      .filter((account) => selected.has(account.id))
      .map((account) => ({ id: account.id, name: account.account }))
    const approved = Object.fromEntries(
      targets.map((target) => [
        target.id,
        bindings
          .filter((binding) => binding.accountId === target.id)
          .map((binding) => binding.windowId)
          .sort(),
      ]),
    )
    const pending = { targets, approved, token: scope.begin(), identity: pluginIdentity }
    const launch = async () => {
      if (!scope.current(pending.token)) return
      setConfirmation(null)
      setBatch(pending)
    }
    const duplicates = targets.filter((target) => approved[target.id]!.length > 0)
    if (duplicates.length)
      confirm(
        '为已有关联的账号创建 Profile',
        `所选账号中有 ${duplicates.length} 个已关联 Profile。继续后，每个账号将再创建并关联一个 Profile。`,
        '继续选择创建配置',
        launch,
        duplicates.map(
          (target) => `${target.name} · 已关联 ${approved[target.id]!.length} 个`,
        ),
      )
    else void launch()
  }

  function confirm(
    title: string,
    detail: string,
    label: string,
    action: () => Promise<void>,
    items?: string[],
  ) {
    setConfirmation({ title, detail, label, action, items })
  }
  async function saveAccount(input: AccountDraft) {
    if (!task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    setError(null)
    try {
      const result = await accountsApi.saveAccount(input)
      if (!scope.current(token)) return
      toast.saved(result.created ? 'Vinted 账号已添加' : 'Vinted 账号已更新')
      setEditing(undefined)
      await refresh()
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '账号保存失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }
  async function deleteAccount(account: Account) {
    if (!task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    setError(null)
    try {
      const latest = await accountsApi.listAccounts()
      if (!scope.current(token)) return
      const current = latest.items.find((item) => item.id === account.id)
      const linkedIds = (items: readonly { accountId: string; windowId: string }[]) =>
        items
          .filter((binding) => binding.accountId === account.id)
          .map((binding) => binding.windowId)
          .sort()
          .join('|')
      if (
        !current ||
        current.updatedAt !== account.updatedAt ||
        linkedIds(latest.bindings) !== linkedIds(bindings)
      )
        throw new Error('账号资料或 Profile 关联已变化，请取消并刷新后重新确认')
      await accountsApi.removeAccount(account.id)
      if (!scope.current(token)) return
      setRemoving(null)
      generation.current++
      setAccounts((current) => current.filter((item) => item.id !== account.id))
      setBindings((current) =>
        current.filter((binding) => binding.accountId !== account.id),
      )
      setSelected((current) => {
        const next = new Set(current)
        next.delete(account.id)
        return next
      })
      setCodes((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.startsWith(`${account.id}:`)),
        ),
      )
      toast.ok('账号已删除，Profile 关联已解除')
      await refresh()
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '账号删除失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }
  async function changePhone(
    account: Account,
    number: { tel: string; api: string } | null,
    sim8Identity?: string,
  ) {
    if (!task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    setError(null)
    try {
      if (number) {
        const currentSim8 = () =>
          usePluginCatalog
            .getState()
            .plugins.find(
              (item) =>
                item.id === SIM8_PLUGIN_ID && item.enabled && item.state === 'running',
            )
        const assertSim8 = () => {
          const source = currentSim8()
          if (!source || pluginUiIdentity(source) !== sim8Identity)
            throw new Error('SIM8 插件已变化，请重新选择号码')
        }
        assertSim8()
        const latest = await sim8Api.records()
        if (!scope.current(token)) return
        assertSim8()
        if (
          !latest.items.some((item) => item.tel === number.tel && item.api === number.api)
        )
          throw new Error('SIM8 号码或接码链接已变化，请重新选择')
      }
      const result = await accountsApi.saveAccount({
        ...account,
        expectedUpdatedAt: account.updatedAt,
        phone: number?.tel ?? '',
        smsOtpUrl: number?.api ?? '',
      })
      if (!scope.current(token)) return
      generation.current++
      setAccounts((current) =>
        current.map((item) => (item.id === result.item.id ? result.item : item)),
      )
      setConfirmation(null)
      toast.saved(number ? 'SIM8 号码已关联' : '手机号已解除')
      await refresh()
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '手机号关联更新失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }
  async function loadOtp(account: Account, channel: 'email' | 'sms') {
    if (!task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    setError(null)
    try {
      const result = await accountsApi.readOtp(account.id, channel, account.updatedAt)
      if (!scope.current(token)) return
      setCodes((current) => ({
        ...current,
        [`${account.id}:${channel}`]: { revision: account.updatedAt, result },
      }))
      setOtp({
        email: account.account,
        ...result,
      })
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '验证码读取失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }
  async function readMailbox(account: Account) {
    if (!account.mailbox || !task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    try {
      const current = await emailApi.getMailbox(account.mailbox.mailboxId)
      if (!scope.current(token)) return
      if (
        current.email.toLowerCase() !== account.mailbox.email.toLowerCase() ||
        !current.enabled
      )
        throw new Error('关联邮箱已变化或暂停，请重新关联。')
      setReader(current)
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '关联邮箱读取失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }
  async function importMailboxRows(
    input: Parameters<typeof accountsApi.mailboxImport>[0],
  ) {
    if (!task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    try {
      const snapshot = await accountsApi.listAccounts()
      if (!scope.current(token)) return
      const { expectedDuplicateIds, skipped } = duplicateMailboxPreview(
        input.mailboxes,
        snapshot.items,
      )
      confirm(
        '确认从邮箱导入',
        `新增 ${input.mailboxes.length - skipped} 个账号，跳过 ${skipped} 个重复邮箱。重复账号不会被覆盖。`,
        '确认导入',
        async () => {
          if (!scope.current(token) || !task.acquire()) return
          setBusy(true)
          setError(null)
          try {
            const result = await createMailboxRelations(accountsApi, emailApi).import(
              {
                ...input,
                expectedDuplicateIds,
              },
              () => scope.current(token),
            )
            if (!scope.current(token)) return
            const report = result as { inserted: number; skipped: number }
            toast.ok(`新增 ${report.inserted} 个，跳过 ${report.skipped} 个`)
            setConfirmation(null)
            setImporting(false)
            await refresh()
          } catch (cause) {
            if (scope.current(token))
              setError(cause instanceof Error ? cause.message : '邮箱导入失败')
          } finally {
            task.release()
            if (scope.current(token)) setBusy(false)
          }
        },
        snapshot.items
          .filter((account) => expectedDuplicateIds.includes(account.id))
          .map((account) => `${account.account} · ${LOGIN_LABELS[account.loginMethod]}`),
      )
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '重复邮箱核对失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }
  async function importText(
    filename: string,
    content: { text: string } | { base64: string },
  ) {
    if (!task.acquire()) return
    const token = scope.begin()
    setBusy(true)
    try {
      const result = await accountsApi.importAccounts(filename, content)
      if (!scope.current(token)) return
      toast.ok(
        `处理 ${result.total} 行：新增 ${result.inserted}，更新 ${result.updated}，跳过 ${result.skipped}`,
      )
      setImporting(false)
      await refresh()
      if (result.errors.length)
        setError(
          result.errors.map((entry) => `第 ${entry.row} 行：${entry.message}`).join('；'),
        )
    } catch (cause) {
      if (scope.current(token))
        setError(cause instanceof Error ? cause.message : '账号导入失败')
    } finally {
      task.release()
      if (scope.current(token)) setBusy(false)
    }
  }

  const columns = accountColumns({
    busy,
    canMailbox,
    canReadMailbox,
    canSelectPhone,
    canSelectAddress,
    canUnlinkAddress: canChangeAddress,
    codes,
    now,
    profiles: linkedProfiles,
    copy,
    observe: setObserving,
    readMailbox: (row) => void readMailbox(row),
    mailbox: setMailboxAccount,
    selectPhone: setChoosingPhone,
    unlinkPhone: (row) =>
      confirm(
        '解除手机号',
        `清空账号「${row.account}」的手机号和短信接码链接，将影响其全部 ${bindingCounts.get(row.id) ?? 0} 个关联 Profile。`,
        '确认解除',
        () => changePhone(row, null),
      ),
    readOtp: (row, channel) => void loadOtp(row, channel),
    viewOtp: (row, result) => setOtp({ email: row.account, ...result }),
    address: setAddressAccount,
    selectAddress: setChoosingAddress,
    unlinkAddress: (row) =>
      confirm(
        '解除地址关系',
        `解除 ${row.account} 的地址关系？地址资料将保留。`,
        '确认解除',
        async () => {
          if (!task.acquire()) return
          const token = scope.begin()
          setBusy(true)
          try {
            await accountsApi.saveAddress(row.id, null, row.address?.id ?? null)
            if (scope.current(token)) {
              setConfirmation(null)
              await refresh()
            }
          } catch (cause) {
            if (scope.current(token))
              setError(cause instanceof Error ? cause.message : '地址解除失败')
          } finally {
            task.release()
            if (scope.current(token)) setBusy(false)
          }
        },
      ),
    manageProfiles: setProfileAccount,
    edit: setEditing,
    remove: setRemoving,
  })

  if (!compatible)
    return (
      <>
        <PageHeader
          title="Vinted 账号池"
          actions={
            <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
              管理插件
            </Button>
          }
        />
        <PluginWorkspace>
          <EmptyState
            title={
              !isNativeRaccoon()
                ? '桌面应用中使用账号池'
                : plugin?.state === 'unlicensed'
                  ? '账号池插件需要激活'
                  : '账号池插件尚未就绪'
            }
            hint="检查安装、授权、运行状态和 account.pool 方法版本"
            action={{ label: '前往插件中心', onClick: onManage }}
          />
        </PluginWorkspace>
      </>
    )
  return (
    <>
      <PageHeader
        title="Vinted 账号池"
        count={{ shown: rows.length, total: accounts.length }}
        actions={
          <>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              leftIcon={<RefreshIcon className="size-3.5" />}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setImporting(true)}
            >
              导入
            </Button>
            {canOrders && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                onClick={() => setOrderWatch(true)}
              >
                商品监控
              </Button>
            )}
            <Button
              size="xsmall"
              leftIcon={<AddIcon className="size-3.5" />}
              onClick={() => setEditing(null)}
            >
              添加账号
            </Button>
          </>
        }
      />
      <PluginWorkspace>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <AccountFilterBar value={filters} onChange={setFilters} />
          {selected.size > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stroke-soft-200 pb-3">
              <span className="mr-auto text-secondary text-text-sub-600">
                已选 {selected.size} 个账号
                {hiddenSelectedCount ? '（包含筛选外账号）' : ''}
              </span>
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                取消选择
              </Button>
              <Button
                size="xsmall"
                disabled={busy || selected.size > MAX_BATCH_PROFILES}
                onClick={beginBatch}
              >
                批量创建 Profile
              </Button>
              {selected.size > MAX_BATCH_PROFILES && (
                <span className="text-micro text-text-soft-400">
                  每批最多 {MAX_BATCH_PROFILES} 个账号
                </span>
              )}
            </div>
          )}
          {error && (
            <Alert status="error" variant="lighter" onClose={() => setError(null)}>
              {error}
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                onClick={() => void refresh()}
              >
                重试
              </Button>
            </Alert>
          )}
          {!durable && (
            <Alert status="warning" variant="lighter">
              账号池插件存储当前未持久化。
            </Alert>
          )}
          {!canMailbox && (
            <p className="m-0 text-secondary text-text-soft-400">
              账号池邮箱关系接口未就绪；账号本身可独立使用。
            </p>
          )}
          <ListColumn className="[&_[role=treegrid]]:min-w-[78rem]">
            <DataList<Account>
              aria-label="Vinted 账号列表"
              items={pagination.items}
              columns={columns}
              rowHeight={64}
              getId={(row) => row.id}
              getName={(row) => row.account}
              selected={selected}
              onSelectedChange={setSelected}
              labels={{
                selectAll: '选择全部账号',
                select: (name) => `选择 ${name}`,
                more: '更多账号操作',
                actions: '操作',
              }}
              status={busy ? 'loading' : 'ready'}
              empty={
                <EmptyState
                  title={accounts.length ? '没有匹配账号' : '账号池为空'}
                  hint={
                    accounts.length
                      ? '调整搜索词或筛选条件。'
                      : '添加账号、导入 CSV/XLSX，或从邮箱管理导入。'
                  }
                />
              }
            />
          </ListColumn>
          <AccountPager
            page={pagination.page}
            pageSize={pageSize}
            total={pagination.total}
            busy={busy}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        </div>
      </PluginWorkspace>
      {editing !== undefined && (
        <AccountForm
          account={editing}
          busy={busy}
          error={error}
          onClose={() => setEditing(undefined)}
          onSave={saveAccount}
        />
      )}
      {importing && (
        <ImportDialog
          busy={busy}
          error={error}
          mailboxTargets={
            canMailboxImport ? mailboxes.filter((item) => item.enabled) : null
          }
          existingAccounts={accounts}
          onClose={() => setImporting(false)}
          onImportMailboxes={(input) => void importMailboxRows(input)}
          onFileImport={importText}
        />
      )}
      <AlertModal
        open={removing !== null}
        status="error"
        title="删除 Vinted 账号"
        description={
          removing
            ? `删除账号「${removing.account}」及其资料，并解除全部 ${bindingCounts.get(removing.id) ?? 0} 个 Profile 关联和邮箱、地址关系。${error ? `\n${error}` : ''}`
            : ''
        }
        confirmLabel="删除账号"
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
        onConfirm={() => {
          if (removing) void deleteAccount(removing)
        }}
      />
      {mailboxAccount && canMailbox && (
        <MailboxRelationDialog
          account={{
            id: mailboxAccount.id,
            account: mailboxAccount.account,
            status: mailboxAccount.status,
            mailbox: mailboxAccount.mailbox,
          }}
          onClose={() => setMailboxAccount(null)}
          onSaved={() => {
            setMailboxAccount(null)
            toast.saved('邮箱关系已保存')
            void refresh()
          }}
        />
      )}
      {profileAccount && (
        <ProfileBindings
          account={{ id: profileAccount.id, account: profileAccount.account }}
          connectionId={connectionId}
          bindings={bindings}
          linkedProfiles={linkedProfiles.get(profileAccount.id) ?? []}
          onClose={() => setProfileAccount(null)}
          onSaved={() => {
            setProfileAccount(null)
            toast.saved('Profile 关系已保存')
            void refresh()
          }}
        />
      )}
      {batch && (
        <ProfileBatchDialog
          open
          targets={batch.targets}
          defaultConnectionId={connectionId}
          settings={{ platform: 'Vinted' }}
          onOpenChange={(open) => {
            if (!open) {
              finishBatchApproval(false)
              setBatch(null)
            }
          }}
          onBind={bindBatchAccount}
          onResults={async (items) => {
            if (!currentBatch()) return
            const completed = items
              .filter((item) => item.status === 'complete')
              .map((item) => item.targetId)
            setSelected((current) => retainAccountSelection(current, accounts, completed))
            await Promise.all([refresh(true), workspace.refresh()])
          }}
        />
      )}
      <AlertModal
        open={batchConfirmation !== null}
        status="warning"
        title="确认账号关联多个 Profile"
        description={
          batchConfirmation
            ? `账号「${batchConfirmation.name}」已关联 ${batchConfirmation.profileIds.length} 个 Profile。继续将同时关联本次新建的 Profile，保留已有关系。`
            : undefined
        }
        confirmLabel="确认继续关联"
        onOpenChange={(open) => {
          if (!open) finishBatchApproval(false)
        }}
        onConfirm={() => finishBatchApproval(true)}
      />
      {reader && canReadMailbox && (
        <MailReader mailbox={reader} onClose={() => setReader(null)} />
      )}
      {addressAccount?.address && (
        <AddressDialog
          name={addressAccount.account}
          address={addressAccount.address}
          onClose={() => setAddressAccount(null)}
        />
      )}
      {choosingAddress && canSelectAddress && addressHelper && (
        <AccountAddressPicker
          key={pluginUiIdentity(addressHelper)}
          account={choosingAddress}
          sourceIdentity={pluginUiIdentity(addressHelper)}
          onClose={() => setChoosingAddress(null)}
          onSaved={(storageDurable) => {
            setChoosingAddress(null)
            if (storageDurable) toast.saved('地址已关联')
            else toast.warn({ title: '地址已关联，退出应用后将失效' })
            void refresh()
          }}
        />
      )}
      {choosingPhone && (
        <Sim8NumberPicker
          disabled={busy}
          currentAccountId={choosingPhone.id}
          onClose={() => setChoosingPhone(null)}
          onPick={(number, identity) => {
            const account = choosingPhone
            if (account.phone === number.tel && account.smsOtpUrl === number.api) return
            confirm(
              account.phone ? '更换 SIM8 号码' : '关联 SIM8 号码',
              `将账号「${account.account}」${account.phone ? `的手机号从 ${account.phone} 更换为` : '关联到'} ${number.tel}，并同步短信接码链接。此操作影响 ${bindingCounts.get(account.id) ?? 0} 个关联 Profile。`,
              '确认关联',
              () => changePhone(account, number, identity),
            )
          }}
        />
      )}
      {observing && (
        <ObservationDialog
          accountId={observing.id}
          name={observing.account}
          observation={observing.observation}
          bindings={bindings}
          onClose={() => setObserving(null)}
        />
      )}
      {otp && (
        <Modal
          open
          title={`${otp.email} · ${otp.channel === 'sms' ? 'SMS' : 'Email'} 验证码`}
          onOpenChange={(open) => {
            if (!open) setOtp(null)
          }}
          footer={
            <div className="flex gap-2">
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={!otp.code}
                onClick={() => {
                  if (otp.code)
                    void clip.write(otp.code).then(() => toast.ok('验证码已复制'))
                }}
              >
                复制验证码
              </Button>
              <Button size="xsmall" onClick={() => setOtp(null)}>
                关闭
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="m-0 text-micro text-text-soft-400">
              读取于 {new Date(otp.fetchedAt).toLocaleString()}
            </p>
            <strong className="text-page-title text-text-strong-950">
              {otp.code ?? '尚未提取到验证码'}
            </strong>
            <Textarea
              label="验证码原文"
              rows={8}
              readOnly
              value={otp.body}
              hint={otp.truncated ? '内容已截断' : undefined}
            />
          </div>
        </Modal>
      )}
      {orderWatch && canOrders && (
        <OrderWatch
          accounts={accounts.map(({ id, account }) => ({ id, account }))}
          onClose={() => setOrderWatch(false)}
        />
      )}
      <AlertModal
        open={confirmation !== null}
        status="warning"
        title={confirmation?.title ?? '确认操作'}
        description={
          confirmation ? (
            <span className="flex flex-col gap-3">
              <span>{confirmation.detail}</span>
              {confirmation.items?.length ? (
                <span className="flex max-h-48 flex-col gap-1 overflow-y-auto text-left">
                  {confirmation.items.map((item, index) => (
                    <span key={index} className="break-all">
                      {item}
                    </span>
                  ))}
                </span>
              ) : null}
              {error && (
                <span className="text-error-text" role="alert">
                  {error}
                </span>
              )}
            </span>
          ) : undefined
        }
        confirmLabel={confirmation?.label ?? '确认'}
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
        onConfirm={() => {
          const action = confirmation?.action
          if (action) void action()
        }}
      />
    </>
  )
}
