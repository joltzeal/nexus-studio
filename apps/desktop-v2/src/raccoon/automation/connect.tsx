import { useEffect, useState } from "react";
import { EmptyState } from "@proxyshard/shardx-ui-kit";
import type { NativeWorkspace } from "../controller";
import { setAutomationConnection } from "./context";
import { resetAutomation } from "../../entities/automation/lib/useAutomation";
import { automationScope } from "./context";
import { FloatingPanel } from "../../shared/ui/FloatingPanel";
import { FleetMonitor } from "../../widgets/FleetMonitor";
import { ToastHost } from "../../widgets/ToastHost/ToastHost";
import { nativeApi } from "../api";
import type { BrowserConnection } from "@nexus/contracts/browser";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HelperPanel, type HelperPanelApi } from "../../widgets/HelperPanel/HelperPanel";
import type { HelperField, HelperReport } from "../../entities/profile/model/api";
import { automationConnection, isAutomationScopeCurrent } from "./context";
import { setNativePreferenceConnection } from "../runtime";
import { releaseNativeAutomationPreviews } from "../../entities/automation/lib/nativePreview";
import "./api";
import { captureAutomationScope } from "../../entities/automation/lib/scope";

/** The helper bus is polled by the main window, independently of its panel. */
export function NativeHelperWatcher({ connectionId }: { connectionId: string | null }) {
  useEffect(() => {
    if (!connectionId) return;
    const scope = captureAutomationScope();
    let active = true;
    let shownFor: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => nativeApi.call("browser_automation_helper_close", { connectionId });
    const tick = async () => {
      try {
        const profiles = await nativeApi.call("browser_automation_helper_profiles", { connectionId });
        if (!active || !scope.current()) return;
        if (!Array.isArray(profiles) || profiles.some((id) => typeof id !== "string")) throw new Error("浏览器助手 Profile 列表格式无效");
        const next = profiles[0] ?? null;
        if (next !== shownFor) {
          if (next) await nativeApi.call("browser_automation_helper_show", { connectionId, profile: next });
          else await close();
          if (!active || !scope.current()) {
            await close().catch(() => {});
            return;
          }
          shownFor = next;
        }
      } catch { /* A disconnected helper bus is polled again. */ }
      finally {
        if (active && scope.current()) timer = setTimeout(() => { void tick(); }, 1500);
      }
    };
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
      void close().catch(() => {});
    };
  }, [connectionId]);
  return null;
}

export function connectAutomation(workspace: NativeWorkspace) {
  let connectionId: string | null | undefined;
  const sync = () => {
    const next = workspace.state.connectionId;
    if (connectionId === next) return;
    // Start cleanup using captured clients before changing the active context.
    releaseNativeAutomationPreviews(connectionId);
    connectionId = next;
    setAutomationConnection(next);
    resetAutomation();
  };
  sync();
  return workspace.subscribe(sync);
}

/** Panels have an immutable connection from the native window URL. They do
 * not initialize the full workbench or select a localStorage Workspace. */
export function NativeAutomationPanel({ connectionId, helperProfile }: { connectionId: string | null; helperProfile: string | null }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [helperApi, setHelperApi] = useState<HelperPanelApi | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!connectionId) throw new Error("辅助窗口缺少 connectionId，请从当前 Workspace 重新打开");
      const rows = await nativeApi.call("browser_connection_list") as BrowserConnection[];
      if (!rows.some((row) => row.id === connectionId && row.enabled)) throw new Error("此辅助窗口所属的浏览器接入不可用");
      if (!active) return;
      setAutomationConnection(connectionId);
      setNativePreferenceConnection(connectionId);
      const scope = automationScope();
      const current = () => isAutomationScopeCurrent(scope) && automationConnection() === connectionId;
      setHelperApi({
        fields: async (profile) => {
          if (!current()) throw new Error("辅助窗口所属 Workspace 已失效");
          const value = await nativeApi.call("browser_automation_helper_fields", { connectionId, profile });
          if (!current()) throw new Error("辅助窗口所属 Workspace 已失效");
          if (value === null) return null;
          if (!value || typeof value !== "object" || !("fields" in value) || !Array.isArray(value.fields)) throw new Error("表单助手返回格式无效");
          const fields: HelperField[] = value.fields.map((field: unknown) => {
            if (!field || typeof field !== "object") throw new Error("表单助手字段格式无效");
            const row = field as Record<string, unknown>;
            if (typeof row.kind !== "string" || typeof row.select !== "boolean"
              || typeof row.x !== "number" || !Number.isFinite(row.x) || typeof row.y !== "number" || !Number.isFinite(row.y)) throw new Error("表单助手字段格式无效");
            return { kind: row.kind, select: row.select, x: row.x, y: row.y };
          });
          return { fields } satisfies NonNullable<HelperReport>;
        },
        fill: async (profile) => {
          if (!current()) throw new Error("辅助窗口所属 Workspace 已失效");
          const count = await nativeApi.call("browser_automation_helper_fill", { connectionId, profile });
          if (!current()) throw new Error("辅助窗口所属 Workspace 已失效");
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("表单助手填充结果无效");
          return count;
        },
        close: () => getCurrentWindow().close(),
        dismiss: async (profile) => {
          if (!current()) throw new Error("辅助窗口所属 Workspace 已失效");
          await nativeApi.call("browser_automation_helper_dismiss", { connectionId, profile });
          if (current()) await getCurrentWindow().close();
        },
      });
      setState("ready");
    })().catch((cause) => {
      if (!active) return;
      setError(String(cause instanceof Error ? cause.message : cause));
      setState("error");
    });
    return () => { active = false; };
  }, [connectionId]);
  if (state === "loading") return null;
  if (state === "error") return <FloatingPanel title="Raccoon"><EmptyState title={error} /></FloatingPanel>;
  if (helperProfile && helperApi) return <HelperPanel profile={helperProfile} api={helperApi} />;
  return <><FleetMonitor key={`${connectionId}:${automationScope()}`} /><ToastHost /></>;
}
