import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Cable,
  Image,
  KeyRound,
  MapPinned,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Store,
  Trash2,
} from 'lucide-react'
import { PLUGIN_CATALOG } from '@/demo/model'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import {
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  pluginHostAvailable,
  restartPlugin,
  uninstallPlugin,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { BUNDLED_PLUGINS } from './bundled-plugins'

const capabilityIcons = {
  'proxy.provider': Cable,
  'address.generator': MapPinned,
  'platform.adapter': Store,
  'verification.provider': KeyRound,
  'image.provider': Image,
  'environment.configurator': SlidersHorizontal,
}

function iconFor(capability: string) {
  return capabilityIcons[capability as keyof typeof capabilityIcons] ?? Cable
}

function stateLabel(plugin: PluginView): string {
  if (plugin.state === 'available') return '可安装'
  if (plugin.state === 'running') return '运行中'
  if (plugin.state === 'failed') return '进程失败'
  return '已安装未启用'
}

function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

export function PluginsPage() {
  const native = pluginHostAvailable()
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [granting, setGranting] = useState<string | null>(null)
  const [granted, setGranted] = useState<string[]>([])

  const load = useCallback(async () => {
    const catalog = await listPlugins()
    setPlugins(catalog)
  }, [])

  useEffect(() => {
    if (!native) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) setPlugins(catalog)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [native])

  const inspected = plugins.find((plugin) => plugin.id === inspecting) ?? null
  const grantingPlugin = plugins.find((plugin) => plugin.id === granting) ?? null

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    setError(null)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="plugins-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="plugins-heading">
            插件中心
          </h1>
          <p className="page-description">
            安装、授权并运行插件；能力范围以插件清单为准。
          </p>
        </div>
        {native ? (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              void run('refresh', async () => undefined)
            }}
          >
            <RefreshCw data-icon="inline-start" />
            刷新
          </Button>
        ) : null}
      </div>

      {!native ? (
        <p className="native-profiles-hint" role="status">
          插件宿主只在 Nexus
          桌面应用中运行；这里显示仓库内插件包的清单声明，不能安装或启用。
        </p>
      ) : null}

      {error ? <FieldError role="alert">{error}</FieldError> : null}

      {native ? (
        <section className="plugin-group" aria-labelledby="plugins-installed-heading">
          <div className="plugin-group-heading">
            <h2 id="plugins-installed-heading">插件宿主</h2>
            <p>每个已启用插件运行在独立 Node.js 进程中，能力需逐项授权。</p>
          </div>
          {plugins.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有可用的插件包</EmptyTitle>
                <EmptyDescription>
                  把插件包放到仓库的 plugins 目录，或在开发环境设置
                  NEXUS_PLUGIN_DEV_ROOTS。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="plugin-grid">
              {plugins.map((plugin, index) => {
                const Icon = iconFor(plugin.capabilities[0] ?? '')
                return (
                  <Card
                    key={plugin.id}
                    className="plugin-card"
                    data-tone={
                      index % 3 === 0 ? 'blue' : index % 3 === 1 ? 'peach' : 'cream'
                    }
                  >
                    <CardHeader>
                      <div className="plugin-card-top">
                        <span className="plugin-icon">
                          <Icon />
                        </span>
                        <Badge
                          variant={plugin.state === 'failed' ? 'destructive' : 'outline'}
                        >
                          {stateLabel(plugin)}
                        </Badge>
                      </div>
                      <CardTitle>{plugin.name}</CardTitle>
                      <CardDescription>
                        {plugin.capabilities.join(' · ')} · v{plugin.version}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <code className="capability-name">{plugin.id}</code>
                      {plugin.lastError ? (
                        <p className="plugin-error">{plugin.lastError}</p>
                      ) : null}
                    </CardContent>
                    <CardFooter className="plugin-card-actions">
                      {plugin.state === 'available' ? (
                        <Button
                          disabled={busy !== null}
                          onClick={() => {
                            void run(`install-${plugin.id}`, async () => {
                              await installPlugin(plugin.sourceDirectory ?? '')
                            })
                          }}
                        >
                          安装
                        </Button>
                      ) : null}
                      {plugin.enabled ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => {
                              void run(`disable-${plugin.id}`, async () => {
                                await disablePlugin(plugin.id)
                              })
                            }}
                          >
                            <Square data-icon="inline-start" />
                            停用
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => {
                              void run(`restart-${plugin.id}`, async () => {
                                await restartPlugin(plugin.id)
                              })
                            }}
                          >
                            <RefreshCw data-icon="inline-start" />
                            重启
                          </Button>
                        </>
                      ) : plugin.state !== 'available' ? (
                        <Button
                          disabled={busy !== null}
                          onClick={() => {
                            setGranting(plugin.id)
                            setGranted(plugin.capabilities)
                          }}
                        >
                          <Play data-icon="inline-start" />
                          启用
                        </Button>
                      ) : null}
                      <Button variant="ghost" onClick={() => setInspecting(plugin.id)}>
                        查看清单
                        <ArrowUpRight data-icon="inline-end" />
                      </Button>
                      {plugin.state !== 'available' ? (
                        <Button
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => {
                            void run(`uninstall-${plugin.id}`, async () => {
                              await uninstallPlugin(plugin.id)
                            })
                          }}
                        >
                          <Trash2 data-icon="inline-start" />
                          卸载
                        </Button>
                      ) : null}
                    </CardFooter>
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      ) : (
        <section className="plugin-group" aria-labelledby="plugins-bundled-heading">
          <div className="plugin-group-heading">
            <h2 id="plugins-bundled-heading">随仓库提供</h2>
            <p>已构建的插件包，需要桌面应用才能安装。</p>
          </div>
          <div className="plugin-grid">
            {BUNDLED_PLUGINS.map((plugin, index) => {
              const Icon = iconFor(plugin.manifest.capabilities[0] ?? '')
              return (
                <Card
                  key={plugin.manifest.id}
                  className="plugin-card"
                  data-tone={
                    index % 3 === 0 ? 'blue' : index % 3 === 1 ? 'peach' : 'cream'
                  }
                >
                  <CardHeader>
                    <div className="plugin-card-top">
                      <span className="plugin-icon">
                        <Icon />
                      </span>
                      <Badge variant="outline">仅桌面应用</Badge>
                    </div>
                    <CardTitle>{plugin.manifest.name}</CardTitle>
                    <CardDescription>{plugin.summary}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <code className="capability-name">
                      {plugin.manifest.capabilities.join(' · ')}
                    </code>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
      )}

      <section className="plugin-group" aria-labelledby="plugins-demo-heading">
        <div className="plugin-group-heading">
          <h2 id="plugins-demo-heading">演示占位</h2>
          <p>只展示能力入口，不包含执行模块。</p>
        </div>
        <div className="plugin-grid">
          {PLUGIN_CATALOG.map((plugin, index) => {
            const Icon = iconFor(plugin.capability)
            return (
              <Card
                key={plugin.id}
                className="plugin-card"
                data-tone={index % 3 === 0 ? 'blue' : index % 3 === 1 ? 'peach' : 'cream'}
              >
                <CardHeader>
                  <div className="plugin-card-top">
                    <span className="plugin-icon">
                      <Icon />
                    </span>
                    <Badge variant="outline">待接入</Badge>
                  </div>
                  <CardTitle>{plugin.name}</CardTitle>
                  <CardDescription>{plugin.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <code className="capability-name">{plugin.capability}</code>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      <p className="demo-footnote">
        插件由宿主进程托管：清单在安装时校验，能力在启用时授权；密码由插件保存在私有目录。
        演示占位仍未接入执行模块，也不代表能力已授权。
      </p>

      <Dialog
        open={grantingPlugin !== null}
        onOpenChange={(open) => {
          if (!open) setGranting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>授权并启用 {grantingPlugin?.name}</DialogTitle>
            <DialogDescription>
              只勾选需要的声明能力；未授权的能力在调用时会被宿主拒绝。
            </DialogDescription>
          </DialogHeader>
          <div className="plugin-grant">
            {grantingPlugin?.capabilities.map((capability) => (
              <label key={capability} className="plugin-grant-row">
                <input
                  type="checkbox"
                  checked={granted.includes(capability)}
                  onChange={(event) => {
                    setGranted((current) =>
                      event.target.checked
                        ? [...current, capability]
                        : current.filter((entry) => entry !== capability),
                    )
                  }}
                />
                <code>{capability}</code>
              </label>
            ))}
          </div>
          <dl className="about-details">
            <div className="about-row">
              <dt>网络域名</dt>
              <dd>{grantingPlugin?.permissions.networkDomains.join('、') || '未申请'}</dd>
            </div>
            <div className="about-row">
              <dt>密钥槽</dt>
              <dd>{grantingPlugin?.permissions.secrets.join('、') || '未申请'}</dd>
            </div>
            <div className="about-row">
              <dt>插件存储</dt>
              <dd>
                {grantingPlugin?.permissions.storage === 'private'
                  ? '插件私有命名空间'
                  : '不使用存储'}
              </dd>
            </div>
          </dl>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGranting(null)}>
              取消
            </Button>
            <Button
              disabled={busy !== null || granted.length === 0}
              onClick={() => {
                const target = grantingPlugin
                if (target === null) return
                void run(`enable-${target.id}`, async () => {
                  await enablePlugin(target.id, granted)
                  setGranting(null)
                })
              }}
            >
              启用并授权
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={inspected !== null}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{inspected?.name}</DialogTitle>
            <DialogDescription>
              {inspected?.state === 'available'
                ? '这是插件包声明的范围，安装后才会启动进程。'
                : '以下是宿主校验过的清单与实际运行状态。'}
            </DialogDescription>
          </DialogHeader>
          <dl className="about-details">
            <div className="about-row">
              <dt>插件标识</dt>
              <dd>
                <code>{inspected?.id}</code>
              </dd>
            </div>
            <div className="about-row">
              <dt>版本</dt>
              <dd>
                {inspected?.version} · API {inspected?.apiVersion} · 最低核心{' '}
                {inspected?.minCoreVersion}
              </dd>
            </div>
            <div className="about-row">
              <dt>声明能力</dt>
              <dd>
                <code>{inspected?.capabilities.join(' · ')}</code>
              </dd>
            </div>
            <div className="about-row">
              <dt>已授权</dt>
              <dd>
                {inspected && inspected.granted.length > 0
                  ? inspected.granted.join(' · ')
                  : '无'}
              </dd>
            </div>
            <div className="about-row">
              <dt>网络域名</dt>
              <dd>{inspected?.permissions.networkDomains.join('、') || '未申请'}</dd>
            </div>
            <div className="about-row">
              <dt>运行状态</dt>
              <dd>
                {inspected ? stateLabel(inspected) : ''}
                {inspected?.status ? ' · 进程已上报状态' : ''}
              </dd>
            </div>
            <div className="about-row">
              <dt>已声明方法</dt>
              <dd>{inspected?.methods.length ?? 0} 个</dd>
            </div>
          </dl>
          {inspected && inspected.secretSlots.length > 0 ? (
            <div className="plugin-secrets">
              <h3>声明的密钥槽</h3>
              <p className="plugin-note">
                密码由插件保存在自己的私有目录，宿主不读取也不代为保管；在代理池页面填写。
              </p>
              <div className="plugin-secret-row">
                {inspected.secretSlots.map((slot) => (
                  <code key={slot}>{slot}</code>
                ))}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setInspecting(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
