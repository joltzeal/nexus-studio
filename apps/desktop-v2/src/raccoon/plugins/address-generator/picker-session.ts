import type { Address, Profile } from './model.ts'

export type PickState = {
  status: 'loading' | 'ready' | 'error'
  profile: Profile | null
  error: string | null
}
export function createPickerSession(
  prepare: (address: Address) => Promise<Profile>,
  onChange: (state: PickState) => void,
) {
  let sequence = 0
  let alive = true
  return {
    async select(lookup: () => Promise<Address | null>) {
      if (!alive) return
      const current = ++sequence
      const active = () => alive && current === sequence
      onChange({ status: 'loading', profile: null, error: null })
      try {
        const address = await lookup()
        if (!active()) return
        if (!address)
          throw new Error('这里没有当前国家的完整门牌地址，请放大后选择建筑物')
        const profile = await prepare(address)
        if (active()) onChange({ status: 'ready', profile, error: null })
      } catch (cause) {
        if (active())
          onChange({
            status: 'error',
            profile: null,
            error: cause instanceof Error ? cause.message : '选点解析失败，请重试',
          })
      }
    },
    dispose() {
      alive = false
      sequence++
    },
  }
}
