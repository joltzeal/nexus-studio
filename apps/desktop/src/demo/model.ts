export type DemoTone = 'blue' | 'peach' | 'cream'

export interface DemoGroup {
  id: string
  name: string
  tone: DemoTone
}

export interface WindowConfig {
  proxy: { protocol: 'direct' | 'http' | 'socks5'; server: string }
  geoip: boolean
  timezone: string
  locale: string
  viewport: 'default' | '1440x900' | '1920x1080'
  fingerprintSeed: number | null
  startUrl: string
}

export interface DemoSpace {
  id: string
  name: string
  platform: 'Vinted' | 'Poshmark' | '其他'
  groupId: string | null
  note: string
  tone: DemoTone
  config: WindowConfig
}

/** Local records only; runtime profile ownership is introduced with the native backend. */
export interface DemoState {
  schemaVersion: 2
  groups: DemoGroup[]
  spaces: DemoSpace[]
  enabledPlugins: string[]
}

export const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  proxy: { protocol: 'direct', server: '' },
  geoip: false,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: null,
  startUrl: '',
}

export const PLUGIN_CATALOG = [
  {
    id: 'demo.platform-tools',
    name: '平台账号',
    description: '平台账号能力入口，尚未连接平台。',
    capability: 'platform.adapter',
  },
  {
    id: 'demo.verification-helper',
    name: '接码服务',
    description: '接码能力入口，尚未连接服务。',
    capability: 'verification.provider',
  },
  {
    id: 'demo.environment-palette',
    name: '环境配置',
    description: '浏览器环境扩展入口，尚未接入配置插件。',
    capability: 'environment.configurator',
  },
] as const

/**
 * Placeholder ids that earlier local states may still reference. They stay
 * valid on read so an existing record is not rejected, but the page no longer
 * renders them: the proxy and image slots are now covered by real plugin
 * packages.
 */
export const RETIRED_PLUGIN_IDS = ['demo.connection-notes', 'demo.image-helper'] as const

export const DEMO_INITIAL_STATE: DemoState = {
  schemaVersion: 2,
  groups: [],
  spaces: [],
  enabledPlugins: [],
}

const oldNotes = new Set([
  '仅用于界面演示，不连接平台或真实账号。',
  '可试着修改名称、备注或分组，不包含真人资料与凭据。',
  '这是未分组的演示空间，所有改动仅保存在本机。',
])

function withoutOldCopy(value: string): string {
  return value.replace(/^(示例|演示|本地演示)\s*·\s*/, '')
}

function invalid(reason: string): never {
  throw new Error(`本地数据无效：${reason}。`)
}

function record(
  input: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    invalid(`${label}需要是对象`)
  const keys = Object.keys(input)
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    invalid(`${label}包含未知字段或缺少必要字段`)
  }
  return input as Record<string, unknown>
}

function text(input: unknown, label: string, maxLength: number): string {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > maxLength) {
    invalid(`${label}需要包含 1 至 ${maxLength} 个字符`)
  }
  return input.trim()
}

function optionalText(input: unknown, label: string, maxLength: number): string {
  if (typeof input !== 'string' || input.length > maxLength) {
    invalid(`${label}需要是最多 ${maxLength} 个字符的文本`)
  }
  return input.trim()
}

function tone(input: unknown): DemoTone {
  if (input !== 'blue' && input !== 'peach' && input !== 'cream') invalid('配色不受支持')
  return input
}

function uniqueIds(items: { id: string }[], label: string): Set<string> {
  const ids = new Set(items.map((item) => item.id))
  if (ids.size !== items.length) invalid(`${label}的标识不能重复`)
  return ids
}

export function parseWindowConfig(input: unknown): WindowConfig {
  const config = record(
    input,
    ['proxy', 'geoip', 'timezone', 'locale', 'viewport', 'fingerprintSeed', 'startUrl'],
    '窗口配置',
  )
  const proxy = record(config.proxy, ['protocol', 'server'], '代理配置')
  const protocol = proxy.protocol
  if (protocol !== 'direct' && protocol !== 'http' && protocol !== 'socks5')
    invalid('代理协议不受支持')
  const server = optionalText(proxy.server, '代理地址', 200)
  if (protocol === 'direct' && server) invalid('直连模式不能填写代理地址')
  if (protocol !== 'direct') {
    try {
      const url = new URL(server)
      const port = Number(server.match(/:(\d{1,5})$/)?.[1])
      if (
        url.protocol !== `${protocol}:` ||
        !url.hostname ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        url.username ||
        url.password ||
        (url.pathname && url.pathname !== '/') ||
        url.search ||
        url.hash
      ) {
        invalid('代理地址应为协议://主机:端口，且不能包含凭据')
      }
    } catch {
      invalid('代理地址应为协议://主机:端口，且不能包含凭据')
    }
  }
  if (typeof config.geoip !== 'boolean' || (config.geoip && protocol === 'direct'))
    invalid('GeoIP 自动匹配需要代理')
  const timezone = optionalText(config.timezone, '时区', 64)
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    } catch {
      invalid('时区需要使用有效的 IANA 标识')
    }
  }
  const locale = optionalText(config.locale, '语言', 35)
  if (locale) {
    try {
      if (!Intl.getCanonicalLocales(locale).length) invalid('语言标识无效')
    } catch {
      invalid('语言需要使用有效的 BCP 47 标识')
    }
  }
  const viewport = config.viewport
  if (viewport !== 'default' && viewport !== '1440x900' && viewport !== '1920x1080')
    invalid('窗口尺寸不受支持')
  const fingerprintSeed = config.fingerprintSeed
  if (
    fingerprintSeed !== null &&
    (typeof fingerprintSeed !== 'number' ||
      !Number.isSafeInteger(fingerprintSeed) ||
      fingerprintSeed < 1 ||
      fingerprintSeed > 2147483647)
  ) {
    invalid('指纹种子需要是 1 至 2147483647 的整数')
  }
  const startUrl = optionalText(config.startUrl, '起始地址', 2048)
  if (startUrl) {
    try {
      const url = new URL(startUrl)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        invalid('起始地址需要是无凭据的 HTTP 或 HTTPS 地址')
    } catch {
      invalid('起始地址需要是无凭据的 HTTP 或 HTTPS 地址')
    }
  }
  return {
    proxy: { protocol, server },
    geoip: config.geoip,
    timezone,
    locale,
    viewport,
    fingerprintSeed,
    startUrl,
  }
}

/** Accepts the previous on-disk shape and adds configuration without overwriting it. */
export function parseDemoState(input: unknown): DemoState {
  const state = record(
    input,
    ['schemaVersion', 'groups', 'spaces', 'enabledPlugins'],
    '工作区',
  )
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2) invalid('不支持此数据版本')
  if (!Array.isArray(state.groups)) invalid('分组需要是列表')
  if (!Array.isArray(state.spaces)) invalid('窗口需要是列表')
  if (!Array.isArray(state.enabledPlugins)) invalid('插件开关需要是列表')
  const groups = Array.from(state.groups, (input: unknown): DemoGroup => {
    const group = record(input, ['id', 'name', 'tone'], '分组')
    return {
      id: text(group.id, '分组标识', 120),
      name: text(withoutOldCopy(text(group.name, '分组名称', 40)), '分组名称', 40),
      tone: tone(group.tone),
    }
  })
  const groupIds = uniqueIds(groups, '分组')
  const spaces = Array.from(state.spaces, (input: unknown): DemoSpace => {
    const legacy = state.schemaVersion === 1
    const space = record(
      input,
      legacy
        ? ['id', 'name', 'platform', 'groupId', 'note', 'tone']
        : ['id', 'name', 'platform', 'groupId', 'note', 'tone', 'config'],
      '窗口',
    )
    const platform = space.platform
    if (platform !== 'Vinted' && platform !== 'Poshmark' && platform !== '其他')
      invalid('平台不受支持')
    const groupId =
      space.groupId === null ? null : text(space.groupId, '窗口所属分组', 120)
    if (groupId !== null && !groupIds.has(groupId)) invalid('窗口引用了不存在的分组')
    return {
      id: text(space.id, '窗口标识', 120),
      name: text(withoutOldCopy(text(space.name, '窗口名称', 40)), '窗口名称', 40),
      platform,
      groupId,
      note: oldNotes.has(space.note as string)
        ? ''
        : withoutOldCopy(optionalText(space.note, '备注', 120)),
      tone: tone(space.tone),
      config: parseWindowConfig(legacy ? DEFAULT_WINDOW_CONFIG : space.config),
    }
  })
  uniqueIds(spaces, '窗口')
  const knownPlugins = new Set<string>([
    ...PLUGIN_CATALOG.map((plugin) => plugin.id),
    ...RETIRED_PLUGIN_IDS,
  ])
  const enabledPlugins = Array.from(state.enabledPlugins, (id: unknown) => {
    if (typeof id !== 'string' || !knownPlugins.has(id)) invalid('插件开关引用了未知插件')
    return id
  })
  if (new Set(enabledPlugins).size !== enabledPlugins.length) invalid('插件开关不能重复')
  return { schemaVersion: 2, groups, spaces, enabledPlugins }
}
