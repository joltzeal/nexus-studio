import { useId, type ReactNode } from 'react'
import { Input, Switch } from '@proxyshard/shardx-ui-kit'
import { AUTO_LANG, AUTO_TZ, LOCALES, TIMEZONES } from '../../../shared/constants'
import { SelectField } from '../../../shared/ui/SelectField'
import {
  patchCloak,
  problemsOf,
  useProfileForm,
  type ProfileFormDraft,
} from '../model/useProfileForm'

/** A titled group of fields, exactly as ShardBrowser's Fingerprint tab. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="m-0 text-section-label text-text-soft-400">
        {title}
      </h3>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

const viewports = [
  { value: 'default' as const, label: '浏览器默认' },
  { value: '1440x900' as const, label: '1440 × 900' },
  { value: '1920x1080' as const, label: '1920 × 1080' },
] as const

const platformIdentities = [
  { value: '' as const, label: '跟随内核默认' },
  { value: 'windows' as const, label: 'Windows' },
  { value: 'macos' as const, label: 'macOS' },
  { value: 'linux' as const, label: 'Linux' },
] as const

const gpuVendors = [
  { value: '' as const, label: '随种子生成' },
  { value: 'nvidia' as const, label: 'NVIDIA' },
  { value: 'intel' as const, label: 'Intel' },
] as const

const timezoneOptions = TIMEZONES.map((timezone) =>
  timezone === AUTO_TZ
    ? { value: '', label: '自动（根据代理出口）' }
    : { value: timezone, label: timezone },
)

const localeOptions = LOCALES.map((locale) =>
  locale.code === AUTO_LANG
    ? { value: '', label: '自动（根据代理出口）' }
    : { value: locale.code, label: locale.label },
)

/// CloakBrowser's fingerprint: the same groups, field grid and help lines as
/// ShardBrowser's Fingerprint tab. Empty values are not forwarded, so the
/// kernel keeps its seed-derived value; explicit values override the seed.
export function CloakFingerprintTab({ draft }: { draft: ProfileFormDraft }) {
  const tried = useProfileForm((s) => s.tried)
  const mode = useProfileForm((s) => s.mode)
  const problems = problemsOf(draft).cloak ?? {}
  const cloak = draft.cloak!
  const timezones = timezoneOptions.some((option) => option.value === cloak.timezone)
    ? timezoneOptions
    : [{ value: cloak.timezone, label: cloak.timezone }, ...timezoneOptions]
  const locales = localeOptions.some((option) => option.value === cloak.locale)
    ? localeOptions
    : [{ value: cloak.locale, label: cloak.locale }, ...localeOptions]

  return (
    <div className="flex flex-col gap-6">
      <Group title="身份">
        <Switch
          label="使用本机真实指纹"
          checked={cloak.nativeFingerprint}
          onChange={(nativeFingerprint) => patchCloak({ nativeFingerprint })}
        />
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="平台身份（系统、UA、GPU 池）"
            value={cloak.platformIdentity}
            options={[...platformIdentities]}
            onChange={(platformIdentity) => patchCloak({ platformIdentity })}
          />
          <SelectField
            label="GPU 厂商（留空随种子）"
            value={cloak.gpuVendor}
            options={[...gpuVendors]}
            onChange={(gpuVendor) => patchCloak({ gpuVendor })}
          />
          <Input
            label="平台版本"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            maxLength={32}
            placeholder="例如 10.0.0"
            aria-invalid={!!problems.platformVersion || undefined}
            value={cloak.platformVersion}
            error={tried ? problems.platformVersion : undefined}
            onChange={(event) => patchCloak({ platformVersion: event.target.value })}
          />
        </div>
      </Group>
      <Group title="硬件与屏幕">
        <div className="grid grid-cols-2 gap-[12px]">
          <Input
            label="指纹种子"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            maxLength={5}
            placeholder={mode === 'create' ? '留空自动生成' : undefined}
            disabled={mode === 'edit' || cloak.nativeFingerprint}
            aria-invalid={!!problems.seed || undefined}
            value={cloak.seed}
            error={tried ? problems.seed : undefined}
            onChange={(event) => patchCloak({ seed: event.target.value })}
          />
          <SelectField
            label="窗口尺寸"
            value={cloak.viewport}
            options={[...viewports]}
            onChange={(viewport) => patchCloak({ viewport })}
          />
          <Input
            label="CPU 线程数"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="1–64"
            aria-invalid={!!problems.hardwareConcurrency || undefined}
            value={cloak.hardwareConcurrency}
            error={tried ? problems.hardwareConcurrency : undefined}
            onChange={(event) => patchCloak({ hardwareConcurrency: event.target.value })}
          />
          <Input
            label="设备内存 GB"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="1–64"
            aria-invalid={!!problems.deviceMemory || undefined}
            value={cloak.deviceMemory}
            error={tried ? problems.deviceMemory : undefined}
            onChange={(event) => patchCloak({ deviceMemory: event.target.value })}
          />
          <Input
            label="屏幕宽"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="800–7680"
            aria-invalid={!!problems.screenWidth || undefined}
            value={cloak.screenWidth}
            error={tried ? problems.screenWidth : undefined}
            onChange={(event) => patchCloak({ screenWidth: event.target.value })}
          />
          <Input
            label="屏幕高"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="600–4320"
            aria-invalid={!!problems.screenHeight || undefined}
            value={cloak.screenHeight}
            error={tried ? problems.screenHeight : undefined}
            onChange={(event) => patchCloak({ screenHeight: event.target.value })}
          />
          <Input
            label="任务栏高度"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="0–200"
            aria-invalid={!!problems.taskbarHeight || undefined}
            value={cloak.taskbarHeight}
            error={tried ? problems.taskbarHeight : undefined}
            onChange={(event) => patchCloak({ taskbarHeight: event.target.value })}
          />
          <Input
            label="触摸点数"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="0–10"
            aria-invalid={!!problems.maxTouchPoints || undefined}
            value={cloak.maxTouchPoints}
            error={tried ? problems.maxTouchPoints : undefined}
            onChange={(event) => patchCloak({ maxTouchPoints: event.target.value })}
          />
        </div>
      </Group>
      <Group title="区域与出口">
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="时区"
            value={cloak.timezone}
            options={timezones}
            onChange={(timezone) => patchCloak({ timezone })}
          />
          <SelectField
            label="语言"
            value={cloak.locale}
            options={locales}
            onChange={(locale) => patchCloak({ locale })}
          />
          <Input
            label="WebRTC IP"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            maxLength={45}
            placeholder="auto 或明确 IP"
            aria-invalid={!!problems.webrtcIp || undefined}
            value={cloak.webrtcIp}
            error={tried ? problems.webrtcIp : undefined}
            onChange={(event) => patchCloak({ webrtcIp: event.target.value })}
          />
        </div>
        {tried && (problems.timezone || problems.locale) && (
          <p className="m-0 text-help text-error-text">
            {problems.timezone ?? problems.locale}
          </p>
        )}
        <Switch
          label="根据代理出口匹配时区、语言和 WebRTC IP"
          checked={cloak.geoip}
          onChange={(geoip) => patchCloak({ geoip })}
        />
      </Group>
      <Group title="噪声与兼容">
        <div className="grid grid-cols-2 gap-[12px]">
          <Switch
            label="关闭画布 / WebGL / 音频噪声"
            checked={cloak.noiseOff}
            onChange={(noiseOff) => patchCloak({ noiseOff })}
          />
          <Switch
            label="允许第三方 Cookie"
            checked={cloak.allowThirdPartyCookies}
            onChange={(allowThirdPartyCookies) => patchCloak({ allowThirdPartyCookies })}
          />
          <Switch
            label="关闭 Windows 语音列表"
            checked={cloak.sapiVoicesOff}
            onChange={(sapiVoicesOff) => patchCloak({ sapiVoicesOff })}
          />
          <Switch
            label="可移植 Cookie"
            checked={cloak.portableCookies}
            onChange={(portableCookies) => patchCloak({ portableCookies })}
          />
        </div>
      </Group>
      <Group title="存储与代理兼容">
        <div className="grid grid-cols-2 gap-[12px]">
          <Input
            label="存储配额 MB"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="1024–1048576"
            aria-invalid={!!problems.storageQuota || undefined}
            value={cloak.storageQuota}
            error={tried ? problems.storageQuota : undefined}
            onChange={(event) => patchCloak({ storageQuota: event.target.value })}
          />
          <Input
            label="默认搜索引擎"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            maxLength={512}
            placeholder="google、bing、duckduckgo、none 或网址"
            aria-invalid={!!problems.searchEngine || undefined}
            value={cloak.searchEngine}
            error={tried ? problems.searchEngine : undefined}
            onChange={(event) => patchCloak({ searchEngine: event.target.value })}
          />
        </div>
        <Switch
          label="增强透明代理兼容"
          checked={cloak.transparentProxy}
          onChange={(transparentProxy) => patchCloak({ transparentProxy })}
        />
        <Input
          label="透明代理 DNS"
          inputSize="xsmall"
          wrapperClassName="gap-[6px]"
          maxLength={512}
          placeholder="local 或 DoH 网址"
          disabled={!cloak.transparentProxy}
          aria-invalid={!!problems.transparentProxyDns || undefined}
          value={cloak.transparentProxyDns}
          error={tried ? problems.transparentProxyDns : undefined}
          onChange={(event) => patchCloak({ transparentProxyDns: event.target.value })}
        />
      </Group>
    </div>
  )
}
