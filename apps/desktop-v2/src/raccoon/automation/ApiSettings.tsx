import { useCallback, useEffect, useRef, useState } from "react";
import { ApiSection } from "../../pages/settings/sections/Api";
import { SaveBar } from "../../pages/settings/SaveBar";
import { useUnsaved } from "../../shared/model/unsaved";
import type { ApiInfo, Settings } from "../../entities/settings";
import { nativeApi, nativeError } from "../api";

type HttpStatus = { running: boolean; host: "127.0.0.1"; port: number | null; configuredPort: number };
function status(value: unknown): HttpStatus {
  if (!value || typeof value !== "object") throw new Error("自动化 API 状态格式无效");
  const row = value as Record<string, unknown>;
  if (typeof row.running !== "boolean" || row.host !== "127.0.0.1"
    || typeof row.configuredPort !== "number" || !Number.isInteger(row.configuredPort) || row.configuredPort < 0 || row.configuredPort > 65535
    || (row.port !== null && (typeof row.port !== "number" || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535))
    || row.running !== (row.port !== null)) throw new Error("自动化 API 状态格式无效");
  return row as HttpStatus;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("自动化 API 令牌格式无效");
  return value;
}

export function NativeAutomationApiSettings() {
  const [saved, setSaved] = useState<Settings>({ browser_path: null, theme: "system", api_enabled: false, api_port: 40325 });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [api, setApi] = useState<ApiInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invalidPort, setInvalidPort] = useState(false);
  const active = useRef(false);
  const gate = useRef(false);
  const readGeneration = useRef(0);

  const read = useCallback(async () => {
    const generation = ++readGeneration.current;
    const [value, secret] = await Promise.all([
      nativeApi.call("browser_automation_http_status").then(status),
      nativeApi.call("browser_automation_http_token").then(token),
    ]);
    if (!active.current || generation !== readGeneration.current) return;
    const port = (value.port ?? value.configuredPort) || 40325;
    setSaved({ browser_path: null, theme: "system", api_enabled: value.running, api_port: port });
    setApi({ enabled: value.running, port, base_url: `http://127.0.0.1:${port}`, token: secret });
    setError(null);
  }, []);
  useEffect(() => {
    active.current = true;
    void read().catch((cause) => { if (active.current) setError(nativeError(cause).message); });
    return () => { active.current = false; readGeneration.current++; };
  }, [read]);

  const save = async () => {
    if (gate.current || invalidPort || !draft) return !draft;
    gate.current = true; setSaving(true); setError(null);
    try {
      const value = status(await nativeApi.call(draft.api_enabled ? "browser_automation_http_start" : "browser_automation_http_stop",
        draft.api_enabled ? { port: draft.api_port } : undefined));
      if (!active.current) return true;
      const port = value.port ?? draft.api_port ?? 40325;
      setSaved({ ...draft, api_enabled: value.running, api_port: port });
      setDraft(null);
      setApi((current) => current && { ...current, enabled: value.running, port, base_url: `http://127.0.0.1:${port}` });
      return true;
    } catch (cause) {
      if (active.current) setError(nativeError(cause).message);
      return false;
    } finally { gate.current = false; if (active.current) setSaving(false); }
  };
  const discard = () => { if (!gate.current) { setDraft(null); setInvalidPort(false); setError(null); } };
  const dirty = !!draft && (draft.api_enabled !== saved.api_enabled || draft.api_port !== saved.api_port);
  useUnsaved(dirty ? { id: "native-automation-api", label: "自动化 API", save, discard } : null);
  return <>
    <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
      <ApiSection s={draft ?? saved} saved={saved} setS={setDraft} api={api} setApi={setApi} apiError={error}
        retryApi={() => { void read().catch((cause) => setError(nativeError(cause).message)); }}
        actions={{ running: api ? { enabled: api.enabled, port: api.port } : null,
          apiHelp: "保存后立即启动或停止本机服务，仅监听 127.0.0.1。应用重启后需重新启用。自动化请求需携带 connectionId 和下方访问令牌。",
          mcpHelp: "导出 Raccoon 自动化 MCP 源码，在导出目录安装依赖后按 README 配置客户端。工具通过当前本机 API 调用工作台内的自动化项目。",
          onInvalidPort: setInvalidPort,
          regenerate: async () => {
            const secret = token(await nativeApi.call("browser_automation_http_rotate_token"));
            if (!api) throw new Error("请先读取自动化 API 状态");
            return { ...api, token: secret };
          },
          downloadMcp: async (dir) => token(await nativeApi.call("browser_automation_mcp_download", { dir })),
        }} />
    </fieldset>
    <SaveBar dirty={dirty} saving={saving} error={error} held={invalidPort ? "端口需在 1024–65535 之间" : null}
      onSave={() => { void save(); }} onDiscard={discard} />
  </>;
}
