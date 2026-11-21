/** Fields that only CloakBrowser's profile form edits. */
export type CloakProfileFields = {
  platform: 'Vinted' | 'Poshmark' | '其他'
  /** "__latest" while creating; an installed version, or the bound one, otherwise. */
  kernel: string
  geoip: boolean
  timezone: string
  locale: string
  viewport: 'default' | '1440x900' | '1920x1080'
  seed: string
  platformIdentity: '' | 'windows' | 'macos' | 'linux'
  gpuVendor: '' | 'nvidia' | 'intel'
  hardwareConcurrency: string
  deviceMemory: string
  screenWidth: string
  screenHeight: string
  platformVersion: string
  storageQuota: string
  taskbarHeight: string
  webrtcIp: string
  noiseOff: boolean
  allowThirdPartyCookies: boolean
  sapiVoicesOff: boolean
  maxTouchPoints: string
  searchEngine: string
  transparentProxy: boolean
  transparentProxyDns: string
  portableCookies: boolean
  nativeFingerprint: boolean
  startUrl: string
}

export type CloakProblems = Partial<Record<keyof CloakProfileFields, string>>

export const CLOAK_FORM_TABS = ['basics', 'proxy', 'fingerprint'] as const

export type CloakFormTab = (typeof CLOAK_FORM_TABS)[number]

const CLOAK_FINGERPRINT_FIELDS = [
  'viewport',
  'seed',
  'geoip',
  'timezone',
  'locale',
  'platformIdentity',
  'gpuVendor',
  'hardwareConcurrency',
  'deviceMemory',
  'screenWidth',
  'screenHeight',
  'platformVersion',
  'storageQuota',
  'taskbarHeight',
  'webrtcIp',
  'noiseOff',
  'allowThirdPartyCookies',
  'sapiVoicesOff',
  'maxTouchPoints',
  'searchEngine',
  'transparentProxy',
  'transparentProxyDns',
  'portableCookies',
  'nativeFingerprint',
] as const satisfies readonly (keyof CloakProfileFields)[]

const CLOAK_BASICS_FIELDS = [
  'kernel',
  'startUrl',
] as const satisfies readonly (keyof CloakProfileFields)[]

/** Why the CloakBrowser-only fields cannot be saved; empty when they can. */
export function cloakProblems(cloak: CloakProfileFields): CloakProblems {
  const out: CloakProblems = {}
  const integer = (
    field: keyof CloakProfileFields,
    value: string,
    low: number,
    high: number,
  ) => {
    if (!value.trim()) return
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < low || parsed > high)
      out[field] = `应为 ${low} 至 ${high} 的整数`
  }
  if (!cloak.kernel) out.kernel = '请选择内核版本'
  if (cloak.seed.trim() !== '') {
    const seed = Number(cloak.seed)
    if (!Number.isInteger(seed) || seed < 10_000 || seed > 99_999)
      out.seed = '应为 10000 至 99999 的整数'
  }
  integer('hardwareConcurrency', cloak.hardwareConcurrency, 1, 64)
  integer('deviceMemory', cloak.deviceMemory, 1, 64)
  integer('screenWidth', cloak.screenWidth, 800, 7680)
  integer('screenHeight', cloak.screenHeight, 600, 4320)
  integer('storageQuota', cloak.storageQuota, 1024, 1_048_576)
  integer('taskbarHeight', cloak.taskbarHeight, 0, 200)
  integer('maxTouchPoints', cloak.maxTouchPoints, 0, 10)
  if (cloak.platformVersion && !/^\d+(?:\.\d+)*$/.test(cloak.platformVersion))
    out.platformVersion = '应为数字和点，例如 10.0.0'
  if (
    cloak.webrtcIp &&
    cloak.webrtcIp !== 'auto' &&
    !/^[0-9a-f:.]+$/i.test(cloak.webrtcIp)
  )
    out.webrtcIp = '应为 auto 或 IP 地址'
  if (
    cloak.searchEngine &&
    !['google', 'bing', 'duckduckgo', 'none'].includes(cloak.searchEngine) &&
    !isHttpUrl(cloak.searchEngine)
  )
    out.searchEngine = '应为 google、bing、duckduckgo、none 或网址'
  if (
    cloak.transparentProxyDns &&
    cloak.transparentProxyDns !== 'local' &&
    !isHttpUrl(cloak.transparentProxyDns)
  )
    out.transparentProxyDns = '应为 local 或 DoH 网址'
  if (Array.from(cloak.timezone).length > 64) out.timezone = '最多 64 个字符'
  if (Array.from(cloak.locale).length > 35) out.locale = '最多 35 个字符'
  if (cloak.startUrl) {
    try {
      const url = new URL(cloak.startUrl)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      ) {
        out.startUrl = '须为不含账号密码的 http:// 或 https:// 网址'
      }
    } catch {
      out.startUrl = '不是有效网址'
    }
  }
  return out
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
  } catch {
    return false
  }
}

/** Whether provider-only fields differ between the draft and what it opened with. */
export function cloakChanged(
  draft: CloakProfileFields,
  opened: CloakProfileFields,
): boolean {
  return JSON.stringify(draft) !== JSON.stringify(opened)
}

/** The Cloak form tabs holding provider-only changes. */
export function cloakChangedTabs(
  draft: CloakProfileFields,
  opened: CloakProfileFields,
): Set<CloakFormTab> {
  const out = new Set<CloakFormTab>()
  if (CLOAK_BASICS_FIELDS.some((key) => draft[key] !== opened[key])) out.add('basics')
  if (CLOAK_FINGERPRINT_FIELDS.some((key) => draft[key] !== opened[key]))
    out.add('fingerprint')
  return out
}

/** Provider-only problems that belong to a tab. */
export function cloakTabProblems(problems: CloakProblems, tab: CloakFormTab): boolean {
  const fields: readonly (keyof CloakProfileFields)[] =
    tab === 'fingerprint'
      ? CLOAK_FINGERPRINT_FIELDS
      : tab === 'basics'
        ? CLOAK_BASICS_FIELDS
        : []
  return fields.some((key) => !!problems[key])
}

/** Fingerprint fields BitBrowser forwards to its own kernel. */
export type BitProfileFields = {
  kernel: string
  geoip: boolean
  timezone: string
  locale: string
  viewport: 'default' | '1440x900' | '1920x1080'
  startUrl: string
  coreProduct: '' | 'chrome' | 'firefox'
  version: string
  userAgent: string
  ostype: '' | 'PC' | 'Android' | 'IOS'
  os: string
  osVersion: string
  gpuVendor: string
  gpuRenderer: string
  hardwareConcurrency: string
  deviceMemory: string
  screenWidth: string
  screenHeight: string
  devicePixelRatio: '' | '1' | '1.5' | '2' | '2.5' | '3'
  resolutionType: '' | '0' | '1'
  windowSizeLimit: '' | '0' | '1'
  canvas: '0' | '1'
  webgl: '0' | '1'
  audioContext: '0' | '1'
  mediaDevice: '0' | '1'
  speechVoices: '0' | '1'
  webRtc: '' | '0' | '1' | '2' | '3'
  ignoreHttpsErrors: '' | '0' | '1'
  position: '' | '0' | '1' | '2'
  isIpCreatePosition: '' | '0' | '1'
  lat: string
  lng: string
  precisionData: string
  isIpCreateDisplayLanguage: '' | '0' | '1'
  displayLanguages: string
  fontType: '' | '0' | '2'
  doNotTrack: '' | '0' | '1'
  clientRectNoiseEnabled: '' | '0' | '1'
  portScanProtect: '' | '0' | '1'
  portWhiteList: string
  deviceInfoEnabled: '' | '0' | '1'
  computerName: string
  macAddr: string
  hostIp: string
  disableSslCipherSuitesFlag: '' | '0' | '1'
  disableSslCipherSuites: string
  enablePlugins: '' | '0' | '1'
  plugins: string
  launchArgs: string
  randomFingerprint: boolean
}

export type BitProblems = Partial<Record<keyof BitProfileFields, string>>

export const BIT_FORM_TABS = ['basics', 'proxy', 'fingerprint'] as const
export type BitFormTab = (typeof BIT_FORM_TABS)[number]

const BIT_BASICS_FIELDS = [
  'kernel',
  'startUrl',
] as const satisfies readonly (keyof BitProfileFields)[]
const BIT_FINGERPRINT_FIELDS = [
  'viewport',
  'geoip',
  'timezone',
  'locale',
  'coreProduct',
  'version',
  'userAgent',
  'ostype',
  'os',
  'osVersion',
  'gpuVendor',
  'gpuRenderer',
  'hardwareConcurrency',
  'deviceMemory',
  'screenWidth',
  'screenHeight',
  'devicePixelRatio',
  'resolutionType',
  'windowSizeLimit',
  'canvas',
  'webgl',
  'audioContext',
  'mediaDevice',
  'speechVoices',
  'webRtc',
  'ignoreHttpsErrors',
  'position',
  'isIpCreatePosition',
  'lat',
  'lng',
  'precisionData',
  'isIpCreateDisplayLanguage',
  'displayLanguages',
  'fontType',
  'doNotTrack',
  'clientRectNoiseEnabled',
  'portScanProtect',
  'portWhiteList',
  'deviceInfoEnabled',
  'computerName',
  'macAddr',
  'hostIp',
  'disableSslCipherSuitesFlag',
  'disableSslCipherSuites',
  'enablePlugins',
  'plugins',
  'launchArgs',
  'randomFingerprint',
] as const satisfies readonly (keyof BitProfileFields)[]

export function bitProblems(bit: BitProfileFields): BitProblems {
  const out: BitProblems = {}
  const integer = (
    field: keyof BitProfileFields,
    value: string,
    low: number,
    high: number,
  ) => {
    if (!value.trim()) return
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < low || parsed > high)
      out[field] = `应为 ${low} 至 ${high} 的整数`
  }
  if (!bit.kernel) out.kernel = '请选择内核版本'
  else if (!/^\d+(?:\.\d+)*$/.test(bit.kernel) || bit.kernel.length > 12)
    out.kernel = '应为数字版本号，例如 130'
  if (bit.os && !/^[A-Za-z0-9 _.-]+$/.test(bit.os))
    out.os = '只能包含字母、数字、空格和 _ . -'
  if (bit.osVersion && !/^[\d., ]+$/.test(bit.osVersion))
    out.osVersion = '应为版本号，多个用逗号分隔'
  if (bit.version && (!/^\d+(?:\.\d+)*$/.test(bit.version) || bit.version.length > 32))
    out.version = '应为数字版本号，例如 130.0.6723.58'
  if (bit.userAgent && bit.userAgent.length > 512) out.userAgent = '最多 512 个字符'
  if (bit.gpuVendor && Array.from(bit.gpuVendor).length > 128)
    out.gpuVendor = '最多 128 个字符'
  if (bit.gpuRenderer && Array.from(bit.gpuRenderer).length > 256)
    out.gpuRenderer = '最多 256 个字符'
  integer('hardwareConcurrency', bit.hardwareConcurrency, 1, 64)
  integer('deviceMemory', bit.deviceMemory, 1, 8)
  integer('screenWidth', bit.screenWidth, 800, 7680)
  integer('screenHeight', bit.screenHeight, 600, 4320)
  if (!!bit.screenWidth.trim() !== !!bit.screenHeight.trim()) {
    if (!bit.screenWidth.trim()) out.screenWidth = '请同时填写屏幕高'
    if (!bit.screenHeight.trim()) out.screenHeight = '请同时填写屏幕宽'
  }
  if (bit.resolutionType === '1' && !bit.screenWidth.trim())
    out.screenWidth = '自定义分辨率时请填写屏幕宽'
  const decimal = (value: string) => value.trim() !== '' && Number.isFinite(Number(value))
  if (bit.lat && (!decimal(bit.lat) || Number(bit.lat) < -90 || Number(bit.lat) > 90))
    out.lat = '应为 -90 至 90 的数字'
  if (bit.lng && (!decimal(bit.lng) || Number(bit.lng) < -180 || Number(bit.lng) > 180))
    out.lng = '应为 -180 至 180 的数字'
  if (!!bit.lat.trim() !== !!bit.lng.trim()) {
    if (!bit.lat.trim()) out.lat = '请同时填写经度'
    if (!bit.lng.trim()) out.lng = '请同时填写纬度'
  }
  if (
    bit.precisionData &&
    (!decimal(bit.precisionData) ||
      Number(bit.precisionData) < 0 ||
      Number(bit.precisionData) > 1_000_000)
  )
    out.precisionData = '应为非负数字'
  if (bit.displayLanguages && bit.displayLanguages.length > 256)
    out.displayLanguages = '最多 256 个字符'
  if (
    bit.portWhiteList &&
    bit.portWhiteList
      .split(',')
      .some((part) => !/^\d+$/.test(part.trim()) || Number(part.trim()) > 65535)
  )
    out.portWhiteList = '应为逗号分隔的端口号'
  if (bit.computerName && bit.computerName.length > 64)
    out.computerName = '最多 64 个字符'
  if (bit.macAddr && bit.macAddr.length > 64) out.macAddr = '最多 64 个字符'
  if (bit.hostIp) {
    const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bit.hostIp)
      ? bit.hostIp.split('.').every((part) => Number(part) <= 255)
      : false
    if (!ipv4 && !(bit.hostIp.includes(':') && /^[0-9a-fA-F:]+$/.test(bit.hostIp)))
      out.hostIp = '应为 IPv4 或 IPv6 地址'
  }
  if (bit.disableSslCipherSuites && bit.disableSslCipherSuites.length > 1024)
    out.disableSslCipherSuites = '最多 1024 个字符'
  if (bit.plugins && bit.plugins.length > 8192) out.plugins = '最多 8192 个字符'
  if (bit.launchArgs && Array.from(bit.launchArgs).length > 1024)
    out.launchArgs = '最多 1024 个字符'
  if (bit.startUrl) {
    try {
      const url = new URL(bit.startUrl)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        out.startUrl = '须为不含账号密码的 http:// 或 https:// 网址'
    } catch {
      out.startUrl = '不是有效网址'
    }
  }
  return out
}

export function bitChangedTabs(
  draft: BitProfileFields,
  opened: BitProfileFields,
): Set<BitFormTab> {
  const out = new Set<BitFormTab>()
  if (BIT_BASICS_FIELDS.some((key) => draft[key] !== opened[key])) out.add('basics')
  if (BIT_FINGERPRINT_FIELDS.some((key) => draft[key] !== opened[key]))
    out.add('fingerprint')
  return out
}

export function bitTabProblems(problems: BitProblems, tab: BitFormTab): boolean {
  const fields: readonly (keyof BitProfileFields)[] =
    tab === 'fingerprint'
      ? BIT_FINGERPRINT_FIELDS
      : tab === 'basics'
        ? BIT_BASICS_FIELDS
        : []
  return fields.some((key) => !!problems[key])
}
