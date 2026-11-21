import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BIT_FORM_TABS,
  bitChangedTabs,
  bitProblems,
  CLOAK_FORM_TABS,
  cloakChanged,
  cloakChangedTabs,
  cloakProblems,
  type BitProfileFields,
  type CloakProfileFields,
} from './profile-form-rules.ts'

const cloak = (changes: Partial<CloakProfileFields> = {}): CloakProfileFields => ({
  platform: '其他',
  kernel: '__latest',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  seed: '',
  platformIdentity: '',
  gpuVendor: '',
  hardwareConcurrency: '',
  deviceMemory: '',
  screenWidth: '',
  screenHeight: '',
  platformVersion: '',
  storageQuota: '',
  taskbarHeight: '',
  webrtcIp: '',
  noiseOff: false,
  allowThirdPartyCookies: false,
  sapiVoicesOff: false,
  maxTouchPoints: '',
  searchEngine: '',
  transparentProxy: false,
  transparentProxyDns: '',
  portableCookies: false,
  nativeFingerprint: false,
  startUrl: '',
  ...changes,
})

test('CloakBrowser has Basics, Proxy and Fingerprint tabs', () => {
  assert.deepEqual(CLOAK_FORM_TABS, ['basics', 'proxy', 'fingerprint'])
})

test('CloakBrowser validation covers the provider fields', () => {
  assert.equal(cloakProblems(cloak({ kernel: '' })).kernel, '请选择内核版本')
  for (const seed of ['9999', '100000', '1.5', 'abc']) {
    assert.ok(cloakProblems(cloak({ seed })).seed, seed)
  }
  assert.ok(cloakProblems(cloak({ startUrl: 'ftp://example.com' })).startUrl)
  assert.ok(cloakProblems(cloak({ startUrl: 'https://user:pass@example.com' })).startUrl)
  assert.deepEqual(
    cloakProblems(cloak({ seed: '10000', startUrl: 'https://example.com' })),
    {},
  )
})

test('CloakBrowser validates explicit fingerprint overrides', () => {
  assert.ok(cloakProblems(cloak({ hardwareConcurrency: '0' })).hardwareConcurrency)
  assert.ok(cloakProblems(cloak({ screenWidth: '799' })).screenWidth)
  assert.ok(cloakProblems(cloak({ screenHeight: '4321' })).screenHeight)
  assert.ok(cloakProblems(cloak({ platformVersion: '10..0' })).platformVersion)
  assert.ok(cloakProblems(cloak({ webrtcIp: 'not-an-ip' })).webrtcIp)
  assert.ok(cloakProblems(cloak({ searchEngine: 'ftp://example.com' })).searchEngine)
  assert.ok(cloakProblems(cloak({ transparentProxyDns: 'dns' })).transparentProxyDns)
  assert.deepEqual(
    cloakProblems(
      cloak({
        hardwareConcurrency: '12',
        screenWidth: '2560',
        screenHeight: '1440',
        platformVersion: '15.0.0',
        webrtcIp: 'auto',
        searchEngine: 'https://search.example/?q=%s',
        transparentProxyDns: 'local',
      }),
    ),
    {},
  )
})

test('CloakBrowser comparisons see provider-only changes', () => {
  const opened = cloak()
  assert.equal(cloakChanged(opened, opened), false)
  assert.equal(cloakChanged(cloak({ seed: '42069' }), opened), true)
  assert.equal(cloakChanged(cloak({ geoip: false }), opened), true)
  assert.equal(cloakChanged(cloak({ kernel: '155.0.8059.39.2' }), opened), true)
})

test('CloakBrowser changes belong to the tab that shows them', () => {
  const opened = cloak()
  assert.deepEqual(
    cloakChangedTabs(cloak({ seed: '42069' }), opened),
    new Set(['fingerprint']),
  )
  assert.deepEqual(
    cloakChangedTabs(cloak({ geoip: false }), opened),
    new Set(['fingerprint']),
  )
  assert.deepEqual(
    cloakChangedTabs(cloak({ timezone: 'Asia/Tokyo' }), opened),
    new Set(['fingerprint']),
  )
  assert.deepEqual(
    cloakChangedTabs(cloak({ kernel: '155.0.8059.39.2' }), opened),
    new Set(['basics']),
  )
  assert.deepEqual(
    cloakChangedTabs(cloak({ startUrl: 'https://example.com' }), opened),
    new Set(['basics']),
  )
  assert.equal(cloakChangedTabs(cloak({ platform: 'Vinted' }), opened).size, 0)
  assert.equal(cloakChangedTabs(opened, opened).size, 0)
})

const bit = (changes: Partial<BitProfileFields> = {}): BitProfileFields => ({
  kernel: '130',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  startUrl: '',
  coreProduct: 'chrome',
  version: '',
  userAgent: '',
  ostype: 'PC',
  os: '',
  osVersion: '',
  gpuVendor: '',
  gpuRenderer: '',
  hardwareConcurrency: '',
  deviceMemory: '',
  screenWidth: '',
  screenHeight: '',
  devicePixelRatio: '',
  resolutionType: '',
  windowSizeLimit: '',
  canvas: '0',
  webgl: '0',
  audioContext: '0',
  mediaDevice: '0',
  speechVoices: '0',
  webRtc: '',
  ignoreHttpsErrors: '',
  position: '',
  isIpCreatePosition: '',
  lat: '',
  lng: '',
  precisionData: '',
  isIpCreateDisplayLanguage: '',
  displayLanguages: '',
  fontType: '',
  doNotTrack: '',
  clientRectNoiseEnabled: '',
  portScanProtect: '',
  portWhiteList: '',
  deviceInfoEnabled: '',
  computerName: '',
  macAddr: '',
  hostIp: '',
  disableSslCipherSuitesFlag: '',
  disableSslCipherSuites: '',
  enablePlugins: '',
  plugins: '',
  launchArgs: '',
  randomFingerprint: false,
  ...changes,
})

test('BitBrowser has Basics, Proxy and Fingerprint tabs', () => {
  assert.deepEqual(BIT_FORM_TABS, ['basics', 'proxy', 'fingerprint'])
})

test('BitBrowser validation keeps kernel and screen pairs bounded', () => {
  assert.equal(bitProblems(bit({ kernel: '' })).kernel, '请选择内核版本')
  assert.ok(bitProblems(bit({ kernel: 'latest' })).kernel)
  assert.ok(bitProblems(bit({ screenWidth: '1920' })).screenHeight)
  assert.ok(bitProblems(bit({ screenHeight: '1080' })).screenWidth)
  assert.ok(bitProblems(bit({ resolutionType: '1' })).screenWidth)
  assert.ok(bitProblems(bit({ lat: '51.5' })).lng)
  assert.ok(bitProblems(bit({ lng: '-0.1' })).lat)
  assert.ok(bitProblems(bit({ lat: '91', lng: '0' })).lat)
  assert.ok(bitProblems(bit({ hostIp: '300.1.1.1' })).hostIp)
  assert.ok(bitProblems(bit({ portWhiteList: '9222,abc' })).portWhiteList)
  assert.ok(bitProblems(bit({ deviceMemory: '16' })).deviceMemory)
  assert.deepEqual(
    bitProblems(
      bit({
        screenWidth: '1920',
        screenHeight: '1080',
        resolutionType: '1',
        deviceMemory: '8',
        lat: '51.5269',
        lng: '-0.0991',
        hostIp: '192.168.1.20',
        portWhiteList: '9222,3000',
        startUrl: 'https://example.com',
      }),
    ),
    {},
  )
})

test('BitBrowser fingerprint changes stay on the Fingerprint tab', () => {
  const opened = bit()
  assert.deepEqual(
    bitChangedTabs(bit({ gpuVendor: 'Google Inc.' }), opened),
    new Set(['fingerprint']),
  )
  assert.deepEqual(bitChangedTabs(bit({ kernel: '128' }), opened), new Set(['basics']))
  assert.equal(bitChangedTabs(opened, opened).size, 0)
})
