type Binding = { accountId: string; windowId: string }
type Ports = {
  bindings(): Promise<{ items: Binding[] }>
  bindAccount(
    accountId: string,
    profileId: string,
    confirmDuplicates: boolean,
    expected?: { windowAccountId: string | null; duplicateWindowIds: string[] },
  ): Promise<{ bound: boolean }>
}

export async function bindCreatedProfile(
  api: Ports,
  accountId: string,
  profileId: string,
  approveDuplicates: (profileIds: string[]) => Promise<boolean>,
  current: () => boolean,
) {
  const checkSession = () => {
    if (!current()) throw new Error('账号池会话已变化，Profile 已保留，请重新关联')
  }
  const checkBindings = (bindings: Binding[]) => {
    const assigned = bindings.find((binding) => binding.windowId === profileId)
    if (assigned && assigned.accountId !== accountId)
      throw new Error('新建 Profile 已关联其他账号，请核对后手动处理')
    return assigned?.accountId === accountId
  }
  checkSession()
  const first = await api.bindings()
  checkSession()
  if (checkBindings(first.items)) return
  const duplicates = first.items
    .filter((binding) => binding.accountId === accountId)
    .map((binding) => binding.windowId)
    .sort()
  if (duplicates.length) {
    if (!(await approveDuplicates(duplicates)))
      throw new Error('已取消关联，Profile 已保留')
    checkSession()
    const latest = await api.bindings()
    checkSession()
    if (checkBindings(latest.items)) return
    const currentIds = latest.items
      .filter((binding) => binding.accountId === accountId)
      .map((binding) => binding.windowId)
      .sort()
    if (JSON.stringify(currentIds) !== JSON.stringify(duplicates))
      throw new Error('账号关联已变化，请重试并重新确认')
  }
  checkSession()
  const result = await api.bindAccount(accountId, profileId, duplicates.length > 0, {
    windowAccountId: null,
    duplicateWindowIds: duplicates,
  })
  checkSession()
  if (!result.bound) throw new Error('账号新增了其他 Profile 关联，请重试并确认')
}
