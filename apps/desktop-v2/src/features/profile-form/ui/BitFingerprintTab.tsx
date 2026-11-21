import { useId, type ReactNode } from 'react'
import { Input, Switch, Textarea } from '@proxyshard/shardx-ui-kit'
import { AUTO_LANG, AUTO_TZ, LOCALES, TIMEZONES } from '../../../shared/constants'
import { SelectField } from '../../../shared/ui/SelectField'
import {
  patchBit,
  problemsOf,
  useProfileForm,
  type ProfileFormDraft,
} from '../model/useProfileForm'

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
]

const osTypes = [
  { value: 'PC' as const, label: 'PC' },
  { value: 'Android' as const, label: 'Android' },
  { value: 'IOS' as const, label: 'iOS' },
]

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

const ratioOptions = [
  { value: '' as const, label: '跟随系统' },
  ...[1, 1.5, 2, 2.5, 3].map((value) => ({
    value: String(value) as '1' | '1.5' | '2' | '2.5' | '3',
    label: `${value}×`,
  })),
]

const defaultOnOff = [
  { value: '' as const, label: '默认' },
  { value: '1' as const, label: '开启' },
  { value: '0' as const, label: '关闭' },
]

const webRtcOptions = [
  { value: '' as const, label: '自动（按代理出口）' },
  { value: '0' as const, label: '替换' },
  { value: '1' as const, label: '允许' },
  { value: '2' as const, label: '禁止' },
  { value: '3' as const, label: '隐私' },
]

export function BitFingerprintTab({ draft }: { draft: ProfileFormDraft }) {
  const tried = useProfileForm((s) => s.tried)
  const problems = problemsOf(draft).bit ?? {}
  const bit = draft.bit!
  const timezones = timezoneOptions.some((option) => option.value === bit.timezone)
    ? timezoneOptions
    : [{ value: bit.timezone, label: bit.timezone }, ...timezoneOptions]
  const locales = localeOptions.some((option) => option.value === bit.locale)
    ? localeOptions
    : [{ value: bit.locale, label: bit.locale }, ...localeOptions]
  return (
    <div className="flex flex-col gap-6">
      <Group title="身份">
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="内核类型"
            value={bit.coreProduct}
            options={[
              { value: 'chrome', label: 'Chrome' },
              { value: 'firefox', label: 'Firefox' },
            ]}
            onChange={(coreProduct) => patchBit({ coreProduct })}
          />
          <SelectField
            label="平台身份（PC / Android / iOS）"
            value={bit.ostype || 'PC'}
            options={osTypes}
            onChange={(ostype) => patchBit({ ostype })}
          />
          <SelectField
            label="操作系统"
            value={bit.os}
            options={[
              { value: '', label: '随平台自动' },
              { value: 'Win32', label: 'Windows（Win32）' },
              { value: 'MacIntel', label: 'macOS（MacIntel）' },
              { value: 'Linux x86_64', label: 'Linux（Linux x86_64）' },
              { value: 'Linux armv81', label: 'Android（Linux armv81）' },
              { value: 'iPhone', label: 'iOS（iPhone）' },
            ]}
            onChange={(os) => patchBit({ os })}
          />
          <Input
            label="系统版本"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="例如 11,10"
            aria-invalid={!!problems.osVersion || undefined}
            value={bit.osVersion}
            error={tried ? problems.osVersion : undefined}
            onChange={(event) => patchBit({ osVersion: event.target.value })}
          />
          <Input
            label="浏览器版本（留空随机）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="例如 130.0.6723.58"
            aria-invalid={!!problems.version || undefined}
            value={bit.version}
            error={tried ? problems.version : undefined}
            onChange={(event) => patchBit({ version: event.target.value })}
          />
          <Input
            label="User Agent（留空自动生成）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="留空自动生成"
            aria-invalid={!!problems.userAgent || undefined}
            value={bit.userAgent}
            error={tried ? problems.userAgent : undefined}
            onChange={(event) => patchBit({ userAgent: event.target.value })}
          />
        </div>
      </Group>
      <Group title="硬件与屏幕">
        <div className="grid grid-cols-2 gap-[12px]">
          <Input
            label="GPU 厂商（留空随机）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="留空随机"
            value={bit.gpuVendor}
            error={tried ? problems.gpuVendor : undefined}
            onChange={(event) => patchBit({ gpuVendor: event.target.value })}
          />
          <Input
            label="GPU 渲染器（留空随机）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="留空随机"
            value={bit.gpuRenderer}
            error={tried ? problems.gpuRenderer : undefined}
            onChange={(event) => patchBit({ gpuRenderer: event.target.value })}
          />
          <Input
            label="CPU 线程数"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="1–64"
            aria-invalid={!!problems.hardwareConcurrency || undefined}
            value={bit.hardwareConcurrency}
            error={tried ? problems.hardwareConcurrency : undefined}
            onChange={(event) => patchBit({ hardwareConcurrency: event.target.value })}
          />
          <Input
            label="设备内存 GB"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="1–8"
            aria-invalid={!!problems.deviceMemory || undefined}
            value={bit.deviceMemory}
            error={tried ? problems.deviceMemory : undefined}
            onChange={(event) => patchBit({ deviceMemory: event.target.value })}
          />
          <SelectField
            label="分辨率来源"
            value={bit.resolutionType}
            options={[
              { value: '', label: '默认' },
              { value: '0', label: '跟随电脑' },
              { value: '1', label: '自定义' },
            ]}
            onChange={(resolutionType) => patchBit({ resolutionType })}
          />
          <SelectField
            label="窗口尺寸上限"
            value={bit.windowSizeLimit}
            options={[
              { value: '', label: '默认' },
              { value: '1', label: '不超过分辨率' },
              { value: '0', label: '不限制' },
            ]}
            onChange={(windowSizeLimit) => patchBit({ windowSizeLimit })}
          />
          <Input
            label="屏幕宽"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="留空跟随电脑"
            aria-invalid={!!problems.screenWidth || undefined}
            value={bit.screenWidth}
            error={tried ? problems.screenWidth : undefined}
            onChange={(event) =>
              patchBit({
                screenWidth: event.target.value,
                resolutionType: bit.resolutionType || '1',
              })
            }
          />
          <Input
            label="屏幕高"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="numeric"
            placeholder="留空跟随电脑"
            aria-invalid={!!problems.screenHeight || undefined}
            value={bit.screenHeight}
            error={tried ? problems.screenHeight : undefined}
            onChange={(event) =>
              patchBit({
                screenHeight: event.target.value,
                resolutionType: bit.resolutionType || '1',
              })
            }
          />
          <SelectField
            label="显示缩放"
            value={bit.devicePixelRatio}
            options={ratioOptions}
            onChange={(devicePixelRatio) => patchBit({ devicePixelRatio })}
          />
          <SelectField
            label="窗口尺寸"
            value={bit.viewport}
            options={viewports}
            onChange={(viewport) => patchBit({ viewport })}
          />
        </div>
      </Group>
      <Group title="区域与出口">
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="时区"
            value={bit.timezone}
            options={timezones}
            onChange={(timezone) => patchBit({ timezone })}
          />
          <SelectField
            label="语言"
            value={bit.locale}
            options={locales}
            onChange={(locale) => patchBit({ locale })}
          />
          <SelectField
            label="界面语言"
            value={bit.isIpCreateDisplayLanguage}
            options={[
              { value: '', label: '跟随系统' },
              { value: '1', label: '按代理出口' },
              { value: '0', label: '自定义' },
            ]}
            onChange={(isIpCreateDisplayLanguage) =>
              patchBit({ isIpCreateDisplayLanguage })
            }
          />
          <Input
            label="界面语言值"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="例如 zh-CN,en-US"
            value={bit.displayLanguages}
            aria-invalid={!!problems.displayLanguages || undefined}
            error={tried ? problems.displayLanguages : undefined}
            onChange={(event) =>
              patchBit({
                displayLanguages: event.target.value,
                isIpCreateDisplayLanguage: bit.isIpCreateDisplayLanguage || '0',
              })
            }
          />
          <SelectField
            label="WebRTC"
            value={bit.webRtc}
            options={webRtcOptions}
            onChange={(webRtc) => patchBit({ webRtc })}
          />
          <SelectField
            label="地理位置权限"
            value={bit.position}
            options={[
              { value: '', label: '自动' },
              { value: '0', label: '询问' },
              { value: '1', label: '允许' },
              { value: '2', label: '禁止' },
            ]}
            onChange={(position) => patchBit({ position })}
          />
          <SelectField
            label="地理位置来源"
            value={bit.isIpCreatePosition}
            options={[
              { value: '', label: '默认' },
              { value: '1', label: '按代理出口 IP' },
              { value: '0', label: '自定义坐标' },
            ]}
            onChange={(isIpCreatePosition) => patchBit({ isIpCreatePosition })}
          />
          <Input
            label="纬度"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="decimal"
            placeholder="例如 51.5269"
            value={bit.lat}
            aria-invalid={!!problems.lat || undefined}
            error={tried ? problems.lat : undefined}
            onChange={(event) =>
              patchBit({
                lat: event.target.value,
                isIpCreatePosition: bit.isIpCreatePosition || '0',
              })
            }
          />
          <Input
            label="经度"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="decimal"
            placeholder="例如 -0.0991"
            value={bit.lng}
            aria-invalid={!!problems.lng || undefined}
            error={tried ? problems.lng : undefined}
            onChange={(event) =>
              patchBit({
                lng: event.target.value,
                isIpCreatePosition: bit.isIpCreatePosition || '0',
              })
            }
          />
          <Input
            label="精度（米）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            inputMode="decimal"
            placeholder="例如 50"
            value={bit.precisionData}
            aria-invalid={!!problems.precisionData || undefined}
            error={tried ? problems.precisionData : undefined}
            onChange={(event) =>
              patchBit({
                precisionData: event.target.value,
                isIpCreatePosition: bit.isIpCreatePosition || '0',
              })
            }
          />
          <SelectField
            label="HTTPS 证书错误"
            value={bit.ignoreHttpsErrors}
            options={[
              { value: '', label: '默认' },
              { value: '1', label: '忽略' },
              { value: '0', label: '不忽略' },
            ]}
            onChange={(ignoreHttpsErrors) => patchBit({ ignoreHttpsErrors })}
          />
        </div>
        {(problems.timezone || problems.locale) && tried && (
          <p className="m-0 text-help text-error-text">
            {problems.timezone ?? problems.locale}
          </p>
        )}
        <Switch
          label="根据代理出口匹配时区、语言和位置"
          checked={bit.geoip}
          onChange={(geoip) => patchBit({ geoip })}
        />
      </Group>
      <Group title="噪声与启动">
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="Canvas"
            value={bit.canvas}
            options={[
              { value: '0', label: '随机' },
              { value: '1', label: '关闭' },
            ]}
            onChange={(canvas) => patchBit({ canvas })}
          />
          <SelectField
            label="WebGL"
            value={bit.webgl}
            options={[
              { value: '0', label: '随机' },
              { value: '1', label: '关闭' },
            ]}
            onChange={(webgl) => patchBit({ webgl })}
          />
          <SelectField
            label="音频"
            value={bit.audioContext}
            options={[
              { value: '0', label: '随机' },
              { value: '1', label: '关闭' },
            ]}
            onChange={(audioContext) => patchBit({ audioContext })}
          />
          <SelectField
            label="媒体设备"
            value={bit.mediaDevice}
            options={[
              { value: '0', label: '随机' },
              { value: '1', label: '关闭' },
            ]}
            onChange={(mediaDevice) => patchBit({ mediaDevice })}
          />
          <SelectField
            label="语音列表"
            value={bit.speechVoices}
            options={[
              { value: '0', label: '随机' },
              { value: '1', label: '关闭' },
            ]}
            onChange={(speechVoices) => patchBit({ speechVoices })}
          />
          <SelectField
            label="字体"
            value={bit.fontType}
            options={[
              { value: '', label: '默认' },
              { value: '0', label: '系统默认' },
              { value: '2', label: '随机' },
            ]}
            onChange={(fontType) => patchBit({ fontType })}
          />
          <SelectField
            label="Do Not Track"
            value={bit.doNotTrack}
            options={[
              { value: '', label: '默认' },
              { value: '1', label: '开启' },
              { value: '0', label: '关闭' },
            ]}
            onChange={(doNotTrack) => patchBit({ doNotTrack })}
          />
          <SelectField
            label="ClientRects"
            value={bit.clientRectNoiseEnabled}
            options={[
              { value: '', label: '默认' },
              { value: '1', label: '使用匹配值' },
              { value: '0', label: '使用本机值' },
            ]}
            onChange={(clientRectNoiseEnabled) => patchBit({ clientRectNoiseEnabled })}
          />
          <SelectField
            label="本地端口扫描保护"
            value={bit.portScanProtect}
            options={[
              { value: '', label: '默认' },
              { value: '0', label: '开启' },
              { value: '1', label: '关闭' },
            ]}
            onChange={(portScanProtect) => patchBit({ portScanProtect })}
          />
          <Switch
            label="每次启动随机指纹"
            checked={bit.randomFingerprint}
            onChange={(randomFingerprint) => patchBit({ randomFingerprint })}
          />
        </div>
        <Input
          label="端口白名单（逗号分隔）"
          inputSize="xsmall"
          wrapperClassName="gap-[6px]"
          placeholder="例如 9222,3000"
          value={bit.portWhiteList}
          aria-invalid={!!problems.portWhiteList || undefined}
          error={tried ? problems.portWhiteList : undefined}
          onChange={(event) =>
            patchBit({
              portWhiteList: event.target.value,
              portScanProtect: bit.portScanProtect || '0',
            })
          }
        />
        <Input
          label="启动参数"
          inputSize="xsmall"
          wrapperClassName="gap-[6px]"
          placeholder="例如 --incognito，多个用逗号分隔"
          value={bit.launchArgs}
          error={tried ? problems.launchArgs : undefined}
          onChange={(event) => patchBit({ launchArgs: event.target.value })}
        />
      </Group>
      <Group title="设备信息">
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="设备信息"
            value={bit.deviceInfoEnabled}
            options={[
              { value: '', label: '默认' },
              { value: '1', label: '自定义' },
              { value: '0', label: '使用本机' },
            ]}
            onChange={(deviceInfoEnabled) => patchBit({ deviceInfoEnabled })}
          />
          <Input
            label="计算机名（留空自动生成）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="留空自动生成"
            value={bit.computerName}
            aria-invalid={!!problems.computerName || undefined}
            error={tried ? problems.computerName : undefined}
            onChange={(event) =>
              patchBit({
                computerName: event.target.value,
                deviceInfoEnabled: bit.deviceInfoEnabled || '1',
              })
            }
          />
          <Input
            label="MAC 地址（留空自动生成）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="留空自动生成"
            value={bit.macAddr}
            aria-invalid={!!problems.macAddr || undefined}
            error={tried ? problems.macAddr : undefined}
            onChange={(event) =>
              patchBit({
                macAddr: event.target.value,
                deviceInfoEnabled: bit.deviceInfoEnabled || '1',
              })
            }
          />
          <Input
            label="Host IP（留空自动生成）"
            inputSize="xsmall"
            wrapperClassName="gap-[6px]"
            placeholder="例如 192.168.1.20"
            value={bit.hostIp}
            aria-invalid={!!problems.hostIp || undefined}
            error={tried ? problems.hostIp : undefined}
            onChange={(event) =>
              patchBit({
                hostIp: event.target.value,
                deviceInfoEnabled: bit.deviceInfoEnabled || '1',
              })
            }
          />
        </div>
      </Group>
      <Group title="TLS 与插件">
        <div className="grid grid-cols-2 gap-[12px]">
          <SelectField
            label="SSL 特性禁用"
            value={bit.disableSslCipherSuitesFlag}
            options={defaultOnOff}
            onChange={(disableSslCipherSuitesFlag) =>
              patchBit({ disableSslCipherSuitesFlag })
            }
          />
          <SelectField
            label="插件指纹"
            value={bit.enablePlugins}
            options={defaultOnOff}
            onChange={(enablePlugins) => patchBit({ enablePlugins })}
          />
        </div>
        <Textarea
          label="SSL 特性值"
          technical
          maxLength={1024}
          value={bit.disableSslCipherSuites}
          error={tried ? problems.disableSslCipherSuites : undefined}
          onChange={(event) =>
            patchBit({
              disableSslCipherSuites: event.target.value,
              disableSslCipherSuitesFlag: bit.disableSslCipherSuitesFlag || '1',
            })
          }
        />
        <Textarea
          label="插件列表"
          technical
          maxLength={8192}
          value={bit.plugins}
          error={tried ? problems.plugins : undefined}
          onChange={(event) =>
            patchBit({
              plugins: event.target.value,
              enablePlugins: bit.enablePlugins || '1',
            })
          }
        />
      </Group>
    </div>
  )
}
