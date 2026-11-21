import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, DialogModal, Input, ProgressBar, Switch } from "@proxyshard/shardx-ui-kit";
import type { BrowserConnection, BrowserConnectionProbe } from "@nexus/contracts/browser";
import { SettingRow, SettingsGroup } from "../pages/settings/SettingRow";
import { isKernelVersion, nativeError, type CloakKernelPhase, type CloakKernelRelease, type CloakKernelStatus } from "./api";
import { cloakKernelApi, cloakLicenseApi, type CloakLicenseStatus } from "./cloakbrowser-api";
import { showCloakSessionDiagnostics } from "./cloakbrowser-diagnostics";
import { workspace } from "./store";
import { confirmModal } from "../shared/lib/confirm";

const phases: Record<CloakKernelPhase, string> = {
  idle: "暂无下载任务",
  preparing: "正在准备",
  downloading: "正在下载",
  verifying: "正在校验",
  extracting: "正在解压",
  retrying: "正在重试",
  ready: "内核已就绪",
  failed: "下载失败",
};
const active = (phase: CloakKernelPhase | undefined) =>
  phase === "preparing" || phase === "downloading" || phase === "verifying" || phase === "extracting" || phase === "retrying";

export function CloakBrowserLab({
  connection,
  savedEnabled,
  enabled,
  saving,
  probe,
  onToggle,
  onBlockChange,
}: {
  connection: BrowserConnection | undefined;
  savedEnabled: boolean;
  enabled: boolean;
  saving: boolean;
  probe: BrowserConnectionProbe | null;
  onToggle: (value: boolean) => void;
  onBlockChange: (blocked: boolean) => void;
}) {
  const api = useRef(cloakKernelApi());
  const license = useRef(cloakLicenseApi());
  const [status, setStatus] = useState<CloakKernelStatus | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<CloakLicenseStatus | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"refresh" | "check" | "download" | "delete" | "license" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [release, setRelease] = useState<CloakKernelRelease | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [deleteVersion, setDeleteVersion] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<string | null | undefined>();
  const [completed, setCompleted] = useState<string | null>(null);
  const lock = useRef(false);
  const download = status?.download;
  const downloading = active(download?.phase);
  const downloadRunning = action === "download";
  const activation = licenseStatus?.configured ?? status?.activationConfigured ?? false;
  const busy = loading || lock.current || downloading;
  const jobError = download?.phase === "failed" ? download.error?.message ?? null : null;
  const currentError = error ?? jobError;

  useEffect(() => {
    onBlockChange(action === "delete");
    return () => onBlockChange(false);
  }, [action, onBlockChange]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setLicenseStatus(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const read = async () => {
      try {
        const [kernels, saved] = await Promise.all([api.current.status(), license.current.get()]);
        if (!live) return;
        setStatus(kernels);
        setLicenseStatus(saved);
        setKey(saved.key ?? "");
        setError(null);
      } catch (cause) {
        if (live) setError(nativeError(cause).message);
      } finally {
        if (live) {
          setLoading(false);
          if (active((status?.download.phase))) timer = setTimeout(read, 900);
        }
      }
    };
    void read();
    return () => { live = false; clearTimeout(timer); };
    // `status` is intentionally absent: the loop owns its cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, connection?.id]);

  useEffect(() => {
    if (!enabled || (!downloadRunning && !active(download?.phase))) return;
    const keepPolling = downloadRunning || active(download?.phase);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api.current.status();
        if (!live) return;
        setStatus(next);
        if (downloadRunning || active(next.download.phase)) timer = setTimeout(() => void poll(), 900);
      } catch (cause) {
        if (!live) return;
        setError(nativeError(cause).message);
        if (keepPolling) timer = setTimeout(() => void poll(), 900);
      }
    };
    timer = setTimeout(() => void poll(), 900);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, connection?.id, downloadRunning, download?.phase]);

  const run = async (kind: NonNullable<typeof action>, body: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setAction(kind);
    if (kind !== "license" && kind !== "remove") setError(null);
    try { await body(); }
    catch (cause) { setError(nativeError(cause).message); }
    finally {
      try { setStatus(await api.current.status()); }
      catch (cause) { setError(nativeError(cause).message); }
      lock.current = false;
      setAction(null);
    }
  };

  const saveLicense = async (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value) { setLicenseError("请输入激活码。"); return; }
    setLicenseError(null);
    await run("license", async () => {
      try {
        const next = await license.current.save(value);
        setLicenseStatus(next);
        setKey(next.key ?? value);
        void workspace.refresh().catch(() => {});
      } catch (cause) {
        setLicenseError(nativeError(cause).message);
        throw cause;
      }
    });
  };

  const removeLicense = async () => {
    if (!await confirmModal({
      title: "移除 CloakBrowser 激活码",
      message: "下载、创建和启动将需要重新校验激活码；已运行窗口不会被停止。",
      confirmLabel: "移除",
      danger: true,
    })) return;
    await run("remove", async () => {
      try {
        await license.current.remove();
        setLicenseStatus({ configured: false, key: null, plan: null, expires: null });
        setKey("");
        void workspace.refresh().catch(() => {});
      } catch (cause) {
        setLicenseError(nativeError(cause).message);
        throw cause;
      }
    });
  };

  const check = () => run("check", async () => {
    setCheckError(null);
    try { setRelease(await api.current.checkLatest()); }
    catch (cause) { setCheckError(nativeError(cause).message); }
  });

  const downloadVersion = (requested: string | null) => {
    if (requested !== null && !isKernelVersion(requested)) {
      setTargetError("请输入由 4–5 段数字组成的完整包版本，最多 48 个字符。");
      return;
    }
    setTargetError(null);
    setCompleted(null);
    setRetryTarget(requested);
    void run("download", async () => {
      const installed = await api.current.download(requested);
      setCompleted(requested === null ? `内核 ${installed} 已下载。` : `内核包 ${requested} 已下载（Chrome ${installed}）。`);
      setRetryTarget(undefined);
    });
  };

  const removeKernel = () => {
    if (!deleteVersion) return;
    setDeleteError(null);
    void run("delete", async () => {
      try {
        await api.current.remove(deleteVersion);
        setDeleteVersion(null);
      } catch (cause) {
        setDeleteError(nativeError(cause).message);
        throw cause;
      }
    });
  };

  const retry = download?.phase === "failed" ? (download.requestedVersion ?? null) : retryTarget;
  const phase = jobError ? "下载失败" : downloading ? phases[download?.phase ?? "preparing"] : download ? phases[download.phase] : null;

  return <>
    <SettingsGroup title="CloakBrowser">
      <SettingRow
        id="native-cloakbrowser-enable"
        title="启用 CloakBrowser"
        help="保存后更新 Workspace 列表。关闭前须停止并确认全部 CloakBrowser Profile。"
        control={({ labelId, helpId }) => (
          <Switch aria-labelledby={labelId} aria-describedby={helpId} checked={enabled} disabled={saving}
            onChange={(value) => { onToggle(value); setError(null); }} />
        )}
      />
      <SettingRow
        id="native-cloakbrowser-status"
        title="已保存的接入状态"
        help={!connection ? "尚未创建接入" : savedEnabled ? "已启用" : "未启用"}
        below={enabled && probe ? (
          <p role="status" className={probe.connected ? "m-0 text-help text-text-sub-600" : "m-0 text-help text-error-text"}>
            {probe.connected ? "运行组件和激活码可用" : probe.message || "接入暂不可用"}
          </p>
        ) : undefined}
      />
    </SettingsGroup>

    {enabled && <>
      <SettingsGroup title="激活码">
        <SettingRow
          id="native-cloakbrowser-license"
          title={licenseStatus?.configured ? "已保存激活码" : "未填写激活码"}
          help={licenseStatus?.configured
            ? `${licenseStatus.plan ? `方案 ${licenseStatus.plan}` : "已保存"}${licenseStatus.expires ? ` · 到期 ${licenseStatus.expires}` : ""}`
            : "激活码以明文保存在本机 SQLite，下载内核、创建和启动 CloakBrowser 均需要。"}
          below={<form onSubmit={(event) => void saveLicense(event)} className="flex max-w-xl gap-2">
            <Input
              aria-label="CloakBrowser 激活码"
              inputSize="xsmall"
              wrapperClassName="min-w-0 flex-1"
              technical
              value={key}
              autoComplete="off"
              disabled={busy || saving}
              onChange={(event) => { setKey(event.target.value); setLicenseError(null); }}
            />
            <Button type="submit" size="xsmall" isLoading={action === "license"} disabled={busy || saving || !key.trim()}>校验并保存</Button>
            {licenseStatus?.configured && <Button type="button" size="xsmall" mode="stroke" variant="neutral" isLoading={action === "remove"} disabled={busy || saving} onClick={() => void removeLicense()}>移除</Button>}
          </form>}
        />
        {licenseError && <p role="alert" className="m-0 px-padding text-help text-error-text">{licenseError}</p>}
        <SettingRow id="native-cloakbrowser-seats" title="授权席位"
          control={() => <Button size="xsmall" variant="neutral" mode="stroke" disabled={!activation}
            onClick={() => void showCloakSessionDiagnostics()}>检查授权席位</Button>} />
      </SettingsGroup>

      <SettingsGroup title="本地内核">
        <SettingRow
          id="native-cloakbrowser-release"
          title="官方最新版本"
          help={checkError ?? (release ? `检查于 ${new Date(release.checkedAt).toLocaleString()}，平台 ${release.platform}` : "检查当前平台的最新稳定版本，不下载内核。")}
          control={() => <Button size="xsmall" variant="neutral" mode="stroke" isLoading={action === "check"} disabled={busy || saving} onClick={() => void check()}>
            {release ? "重新检查" : "检查更新"}
          </Button>}
          below={release ? <div className="flex items-center gap-2">
            <code className="text-text-strong-950">{release.version}</code>
            <Button size="3xsmall" disabled={busy || saving || !activation} onClick={() => downloadVersion(release.version)}>下载此版本</Button>
          </div> : undefined}
        />
        <SettingRow
          id="native-cloakbrowser-download"
          title="下载最新内核"
          help={activation ? "下载完成后刷新本地清单。最新内核不可用时保留本机原有版本。" : "先保存并通过激活校验后可下载。"}
          control={() => <Button size="xsmall" isLoading={action === "download"} disabled={busy || saving || !activation} onClick={() => downloadVersion(null)}>
            {downloadRunning || downloading ? "正在下载" : "下载内核"}
          </Button>}
          below={<div className="flex flex-col gap-2">
            <div className="flex max-w-xl gap-2">
              <Input aria-label="指定内核完整包版本" placeholder="指定版本，例如 155.0.8059.39.2"
                inputSize="xsmall" wrapperClassName="min-w-0 flex-1" technical
                value={target} disabled={busy || saving} onChange={(event) => { setTarget(event.target.value.trim()); setTargetError(null); }} />
              <Button size="xsmall" mode="stroke" variant="neutral" disabled={busy || saving || !activation || !target} onClick={() => downloadVersion(target)}>下载指定版本</Button>
            </div>
            {targetError && <p role="alert" className="m-0 text-help text-error-text">{targetError}</p>}
            {status && <p className="m-0 text-help text-text-sub-600">平台 {status.platform} · {status.installed.length} 个本机版本</p>}
          </div>}
        />
        <SettingRow
          id="native-cloakbrowser-kernel-state"
          title="下载状态"
          help={loading ? "正在读取本地清单" : phase ?? "暂无下载任务"}
          control={() => <Button size="xsmall" mode="stroke" variant="neutral" isLoading={action === "refresh"} disabled={busy || saving}
            onClick={() => void run("refresh", async () => { setStatus(await api.current.status(true)); })}>刷新</Button>}
          below={<div className="flex flex-col gap-2" aria-live="polite">
            {downloading && (download?.phase === "downloading" && download.percent !== null
              ? <ProgressBar aria-label="CloakBrowser 内核下载进度" value={download.percent} showValue />
              : <progress aria-label="CloakBrowser 内核准备进度" className="h-1.5 w-full accent-primary-base" />)}
            {downloading && download?.phase === "downloading" && <p className="m-0 text-help tabular-nums text-text-sub-600">
              {download.downloadedMb === null ? "已接收" : `${download.downloadedMb.toFixed(1)} MB`}
              {download.totalMb !== null ? ` / ${download.totalMb.toFixed(1)} MB` : " · 总大小未知"}
              {download.attempt !== null ? ` · 第 ${download.attempt} 次尝试` : ""}
            </p>}
            {currentError && <p role="alert" className="m-0 text-help text-error-text">{currentError}</p>}
            {completed && <p role="status" className="m-0 text-help text-text-sub-600">{completed}</p>}
            {download?.phase === "failed" && <Button size="3xsmall" mode="stroke" variant="neutral" disabled={busy || saving}
              onClick={() => downloadVersion(retry ?? null)}>重试{retry ? ` ${retry}` : "最新版本"}</Button>}
          </div>}
        />
        {status?.installed.map((kernel) => <SettingRow key={kernel.version} id={`native-cloak-kernel-${kernel.version}`} title={kernel.version} help="已安装"
          control={() => <Button size="xsmall" variant="error" mode="ghost" disabled={busy || saving}
            onClick={() => { setDeleteError(null); setDeleteVersion(kernel.version); }}>删除</Button>} />)}
        {status && status.installed.length === 0 && <SettingRow id="native-cloak-kernels-empty" title="尚未安装内核" help="下载完成后可在此查看已安装版本。" />}
      </SettingsGroup>
    </>}

    <DialogModal
      open={deleteVersion !== null}
      onClose={() => { if (!lock.current) { setDeleteVersion(null); setDeleteError(null); } }}
      title="删除 CloakBrowser 内核"
      subtitle={`确认删除版本 ${deleteVersion ?? ""}？仍被 Profile 绑定的版本会由原生服务拒绝删除。`}
      confirmLabel="删除内核"
      confirmVariant="error"
      cancelLabel="取消"
      onCancel={() => setDeleteVersion(null)}
      isLoading={action === "delete"}
      isDisabled={busy || saving}
      onConfirm={removeKernel}
      footerNote={deleteError ? <span role="alert" className="text-error-text">{deleteError}</span> : undefined}
    />
  </>;
}
