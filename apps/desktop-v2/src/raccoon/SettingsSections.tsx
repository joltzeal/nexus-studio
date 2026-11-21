import { useEffect, useState } from "react";
import { exit } from "@tauri-apps/plugin-process";
import { Button, Input, Switch } from "@proxyshard/shardx-ui-kit";
import { SettingRow, SettingsGroup } from "../pages/settings/SettingRow";
import { SelectField } from "../shared/ui/SelectField";
import { ColorRadios } from "../shared/ui/ColorRadios";
import { DetailsCard, DetailRow } from "../shared/ui/DetailsCard";
import { LANG_OPTIONS } from "../shared/i18n";
import { TIMEZONES, LOCALES } from "../shared/constants";
import { useKeyPrefs } from "../shared/model/keyPrefs";
import { confirmLeave } from "../shared/model/unsaved";
import { toast } from "../shared/model/toast";
import { HOST_OS } from "../shared/lib/utils";
import { useViews, viewNameTaken, builtinNames, type ProfileView } from "../entities/profile/lib/views";
import { useProfileUi } from "../entities/profile/lib/useProfileUi";
import { useTags, type Tag } from "../entities/tag";
import { nativeError } from "./api";
import { useWorkspace } from "./store";
import { nativeTagApi } from "./tag-api";
import { nativePreferenceKey } from "./runtime";
import { workbenchSettingsApi, type WorkbenchSettings, type NetworkSettings, type WorkbenchInfo } from "./settings-api";

export function NativeGeneral({ value, change }: { value: WorkbenchSettings; change: (value: WorkbenchSettings) => void }) {
  const singleKeys = useKeyPrefs((state) => state.singleKeys);
  async function quitApplication() {
    try {
      if (await confirmLeave()) await exit(0);
    } catch (detail) {
      toast.fail({ title: "无法退出应用", detail });
    }
  }
  return <SettingsGroup>
    <SettingRow id="native-language" title="界面语言" help="保存后应用于已接入的上游组件，Raccoon 专用文案目前使用中文。"
      control={({ labelId }) => <div className="w-[200px]"><SelectField aria-labelledby={labelId} value={value.language} options={LANG_OPTIONS}
        onChange={(language) => change({ ...value, language })} /></div>} />
    <SettingRow id="native-single-keys" title="单键快捷键" help="立即保存当前界面的快捷键偏好。"
      control={({ labelId }) => <Switch aria-labelledby={labelId} checked={singleKeys} onChange={(on) => useKeyPrefs.getState().setSingleKeys(on)} />} />
    <SettingRow id="native-start-minimized" title="启动时最小化" help="下次手动启动 Raccoon 时最小化主窗口。"
      control={({ labelId }) => <Switch aria-labelledby={labelId} checked={value.startMinimized} onChange={(startMinimized) => change({ ...value, startMinimized })} />} />
    {HOST_OS === "Linux" ? (
      <SettingRow id="native-close-behavior" title="关闭主窗口" help="最小化后可以从系统任务栏恢复应用。"
        control={({ labelId }) => <div className="w-[200px]"><SelectField aria-labelledby={labelId} value={value.closeBehavior}
          options={[{ value: "exit", label: "退出应用" }, { value: "minimize", label: "最小化" }]}
          onChange={(closeBehavior) => change({ ...value, closeBehavior })} /></div>} />
    ) : (
      <SettingRow
        id="native-exit-application"
        title="应用退出"
        help={HOST_OS === "macOS"
          ? "关闭主窗口后应用继续运行。点击 Dock 或菜单栏中的 Raccoon 图标可重新打开窗口。"
          : "关闭主窗口后应用继续运行。点击系统托盘中的 Raccoon 图标可重新打开窗口。"}
        control={({ helpId }) => (
          <Button size="xsmall" variant="neutral" mode="stroke" aria-describedby={helpId} onClick={() => void quitApplication()}>
            退出应用
          </Button>
        )}
      />
    )}
  </SettingsGroup>;
}

export function NativeProfileDefaults({ value, change }: { value: WorkbenchSettings; change: (value: WorkbenchSettings) => void }) {
  const defaults = value.profileDefaults;
  const patch = (fields: Partial<WorkbenchSettings["profileDefaults"]>) => change({ ...value, profileDefaults: { ...defaults, ...fields } });
  return <SettingsGroup help="保存后用于下一次打开的新建 Profile 表单。表单内可以继续调整。">
    <SettingRow id="native-default-timezone" title="默认时区" control={({ labelId }) => <div className="w-[240px]">
      <SelectField aria-labelledby={labelId} isSearchable value={defaults.timezone} options={TIMEZONES.map((value) => ({ value, label: value === "auto" ? "随代理地区" : value }))} onChange={(timezone) => patch({ timezone })} />
    </div>} />
    <SettingRow id="native-default-language" title="默认浏览器语言" control={({ labelId }) => <div className="w-[240px]">
      <SelectField aria-labelledby={labelId} isSearchable value={defaults.language} options={LOCALES.map((row) => ({ value: row.code, label: row.code === "auto" ? "随代理地区" : row.label }))} onChange={(language) => patch({ language })} />
    </div>} />
    <SettingRow id="native-default-webrtc" title="WebRTC" control={({ labelId }) => <div className="w-[240px]">
      <SelectField aria-labelledby={labelId} value={defaults.webrtc} options={[{ value: "auto", label: "自动" }, { value: "tcp_only", label: "仅 TCP" }, { value: "block", label: "禁用" }]} onChange={(webrtc) => patch({ webrtc })} />
    </div>} />
    <SettingRow id="native-default-dnt" title="Do Not Track" control={({ labelId }) => <Switch aria-labelledby={labelId} checked={defaults.doNotTrack} onChange={(doNotTrack) => patch({ doNotTrack })} />} />
    <SettingRow id="native-default-maximized" title="浏览器启动时最大化" control={({ labelId }) => <Switch aria-labelledby={labelId} checked={defaults.maximized} onChange={(maximized) => patch({ maximized })} />} />
  </SettingsGroup>;
}

export function NativeNetwork({ value, change }: { value: NetworkSettings; change: (value: NetworkSettings) => void }) {
  return <SettingsGroup title="应用网络代理">
    <SettingRow id="native-network-mode" title="连接方式" help="应用请求和后续内核下载使用此设置。Profile 的浏览器代理在各自配置中维护。"
      control={({ labelId }) => <div className="w-[200px]"><SelectField aria-labelledby={labelId} value={value.mode}
        options={[{ value: "direct", label: "不代理" }, { value: "system", label: "系统代理" }, { value: "manual", label: "手动代理" }]}
        onChange={(mode) => change({ mode, url: mode === "manual" ? value.url ?? "" : null })} /></div>} />
    {value.mode === "manual" && <SettingRow id="native-network-url" title="代理地址" help="填写带端口的 HTTP、HTTPS 或 SOCKS5 地址，支持的地址形式不含用户名和密码。"
      below={<Input inputSize="xsmall" aria-label="应用代理地址" placeholder="socks5://127.0.0.1:7890" value={value.url ?? ""} onChange={(event) => change({ ...value, url: event.target.value })} />} />}
    {value.mode === "system" && <SettingRow id="native-system-network" title="系统代理" help="读取当前系统的静态代理设置。PAC 自动配置尚未支持，保存时会校验。" />}
  </SettingsGroup>;
}

function NativeTagRow({ tag }: { tag: Tag }) {
  const state = useWorkspace();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const count = Object.values(useTags((state) => state.byProfile)).filter((ids) => ids.includes(tag.id)).length;
  async function save(remove: boolean) {
    if (working || !state.connectionId) return;
    setWorking(true); setError(null);
    try {
      if (remove) await nativeTagApi.remove(tag.id, state.connectionId);
      else await nativeTagApi.save({ ...tag, name, color }, undefined, state.connectionId);
      await useTags.getState().reload();
      setConfirmDelete(false);
    } catch (cause) { setError(nativeError(cause).message); await useTags.getState().reload(); }
    finally { setWorking(false); }
  }
  return <div className="row-line flex flex-col gap-2 py-3">
    <div className="flex flex-wrap items-center gap-4">
      <Input inputSize="xsmall" aria-label={`标签 ${tag.name}`} className="w-[200px]" maxLength={32} disabled={working} value={name} onChange={(event) => setName(event.target.value)} />
      <fieldset className="m-0 border-0 p-0" disabled={working}><ColorRadios label={`标签 ${tag.name} 的颜色`} value={color} onChange={(value) => { if (value) setColor(value); }} /></fieldset>
      <span className="ml-auto text-help text-text-sub-600">{count} 个 Profile</span>
      <Button size="xsmall" variant="neutral" mode="stroke" disabled={working || !name.trim() || (name === tag.name && color === tag.color)} onClick={() => void save(false)}>保存标签</Button>
      <Button size="xsmall" variant="error" mode="ghost" disabled={working} onClick={() => setConfirmDelete(true)}>删除</Button>
    </div>
    {confirmDelete && <div className="flex flex-wrap items-center gap-2 text-help"><span>确认从关联 Profile 中删除此标签？</span><Button size="3xsmall" variant="error" disabled={working} onClick={() => void save(true)}>确认删除</Button><Button size="3xsmall" variant="neutral" mode="ghost" disabled={working} onClick={() => setConfirmDelete(false)}>取消</Button></div>}
    {error && <p role="alert" className="m-0 text-help text-error-text">{error}</p>}
  </div>;
}
export function NativeTags() {
  const tags = useTags((state) => state.tags);
  return <SettingsGroup title="当前 Workspace 的标签" help="逐项保存标签名称和颜色，删除会移除当前 Workspace 中的关联。">
    {tags.map((tag) => <NativeTagRow key={`${tag.id}:${tag.name}:${tag.color}`} tag={tag} />)}
    {tags.length === 0 && <p className="py-6 text-center text-body text-text-sub-600">暂无标签，可在 Profile 表单中添加。</p>}
  </SettingsGroup>;
}

function NativeViewRow({ view }: { view: ProfileView }) {
  const [name, setName] = useState(view.name);
  const [pinned, setPinned] = useState(view.pinned);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const commit = (change: () => void) => {
    const before = useViews.getState().views;
    try {
      change();
      const expected = useViews.getState().views.map(({ id, name, pinned, query }) => ({ id, name, pinned, query }));
      const raw = JSON.parse(localStorage.getItem(nativePreferenceKey("shardx.views")) ?? "null") as { views?: unknown } | null;
      if (JSON.stringify(raw?.views) !== JSON.stringify(expected)) throw new Error("视图保存失败，请检查本地存储");
      setError(null);
      return true;
    } catch (cause) {
      useViews.setState({ views: before });
      setError(nativeError(cause).message);
      return false;
    }
  };
  const save = () => {
    if (!name.trim() || viewNameTaken(name, useViews.getState().views, builtinNames(), view.id)) { setError("视图名称为空或已被使用"); return; }
    commit(() => { useViews.getState().rename(view.id, name); useViews.getState().setPinned(view.id, pinned); });
  };
  return <div className="row-line flex flex-col gap-2 py-3">
    <div className="flex flex-wrap items-center gap-4">
      <Input inputSize="xsmall" aria-label={`视图 ${view.name}`} className="w-[240px]" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      <Switch label="显示在侧栏" checked={pinned} onChange={setPinned} />
      <Button size="xsmall" variant="neutral" mode="stroke" disabled={name === view.name && pinned === view.pinned} onClick={save}>保存视图</Button>
      <Button size="xsmall" variant="error" mode="ghost" onClick={() => setConfirmDelete(true)}>删除</Button>
    </div>
    {confirmDelete && <div className="flex items-center gap-2 text-help"><span>确认删除此视图？</span><Button size="3xsmall" variant="error" onClick={() => { if (commit(() => useViews.getState().remove(view.id)) && useProfileUi.getState().viewId === view.id) useProfileUi.setState({ viewId: null, base: null }); }}>确认删除</Button><Button size="3xsmall" variant="neutral" mode="ghost" onClick={() => setConfirmDelete(false)}>取消</Button></div>}
    {error && <p role="alert" className="m-0 text-help text-error-text">{error}</p>}
  </div>;
}
export function NativeViews() {
  const views = useViews((state) => state.views);
  return <SettingsGroup title="当前 Workspace 的视图" help="视图是当前界面的本地偏好，按接入实例保存。可从 Profile 列表保存筛选条件为视图。">
    {views.map((view) => <NativeViewRow key={`${view.id}:${view.name}:${view.pinned}`} view={view} />)}
    {views.length === 0 && <p className="py-6 text-center text-body text-text-sub-600">暂无自定义视图</p>}
  </SettingsGroup>;
}

export function NativeInfo({ storage }: { storage: boolean }) {
  const [info, setInfo] = useState<WorkbenchInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const read = async () => {
    setReading(true);
    try { setInfo(await workbenchSettingsApi.info()); setError(null); }
    catch (cause) { setError(nativeError(cause).message); }
    finally { setReading(false); }
  };
  useEffect(() => { void workbenchSettingsApi.info().then(setInfo, (cause) => setError(nativeError(cause).message)); }, []);
  return <>
    <DetailsCard id="native-info" title={storage ? "本机工作台数据" : "Raccoon"}>
      {info && <>
        <DetailRow id="version" label="应用版本" copy={{ value: info.version }}>{info.version}{info.debug ? " · 开发运行" : ""}</DetailRow>
        <DetailRow id="platform" label="平台">{info.platform}</DetailRow>
        {storage && <>
          <DetailRow id="data-path" label="数据目录" copy={{ value: info.dataPath }}>{info.dataPath}</DetailRow>
          <DetailRow id="database-size" label="数据库大小">{(info.databaseBytes / 1024 / 1024).toFixed(2)} MiB</DetailRow>
          <DetailRow id="profile-count" label="Profile">{info.profiles}</DetailRow>
          <DetailRow id="folder-count" label="Folder">{info.folders}</DetailRow>
          <DetailRow id="proxy-count" label="代理">{info.proxies}</DetailRow>
        </>}
      </>}
    </DetailsCard>
    <div className="flex gap-2"><Button size="xsmall" variant="neutral" mode="stroke" disabled={reading} onClick={() => void read()}>刷新信息</Button>
      {storage && <Button size="xsmall" variant="neutral" mode="stroke" onClick={() => void workbenchSettingsApi.revealStorage().catch((cause) => setError(nativeError(cause).message))}>打开数据目录</Button>}
    </div>
    {!storage && <SettingsGroup><SettingRow id="native-about-licenses" title="开源组件" help="工作台界面复用 MIT 许可的 ShardBrowser Launcher 与 ShardX UI Kit。源码目录保留上游许可证。" /><SettingRow id="native-about-update" title="应用更新" help="当前 0.2 开发入口的正式更新源与发行渠道仍待验收。" /></SettingsGroup>}
    {storage && <SettingsGroup><SettingRow id="native-storage-boundary" title="存储范围" help="显示 0.2 独立工作台目录及数据库统计。Profile 数据、连接和设置由 Rust 管理，应用代理等敏感设置按当前约定明文保存。" /></SettingsGroup>}
    {error && <p role="alert" className="m-0 text-help text-error-text">{error}</p>}
  </>;
}
