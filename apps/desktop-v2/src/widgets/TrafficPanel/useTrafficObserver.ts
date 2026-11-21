import { isAutomationEventCurrent } from "../../raccoon/automation/context";
import { useAutomationEffectScope } from "../../entities/automation/lib/scope";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { trafficObserve } from "../../entities/automation";
import { toast } from "../../shared/model/toast";
import { t } from "../../shared/i18n";
import type { Observed } from "./rules";

export type TrafficObserver = {
  observing: boolean;
  observed: Observed[];
  toggle: () => Promise<void>;
  clear: () => void;
};

/// The requests a profile's page makes, while Observe is on. Held by the
/// editor, not the Requests tab: hiding the browser column, or switching its
/// tab, must not throw away what was seen (the core keeps observing).
export function useTrafficObserver(profileId: string | null): TrafficObserver {
  const captureScope = useAutomationEffectScope(profileId);
  const [observing, setObserving] = useState(false);
  const [observed, setObserved] = useState<Observed[]>([]);

  useEffect(() => {
    const scope = captureScope();
    setObserving(false);
    setObserved([]);
    let un: (() => void) | null = null;
    let alive = true;
    listen<{ connection_id?: string; profile_id: string; params: { request: string } }>(
      "automation:traffic-observed",
      (e) => {
        if (!alive || !scope.current() || !isAutomationEventCurrent(e.payload) || !profileId || e.payload.profile_id !== profileId) return;
        // The core's event, parsed as it comes.
        let ev: any;
        try { ev = JSON.parse(e.payload.params.request); } catch { return; }
        const id: string = ev.id ?? "";
        setObserved((prev) => {
          const i = prev.findIndex((r) => r.id === id);
          if (ev.phase === "response") {
            if (i < 0) return prev;
            const next = prev.slice();
            next[i] = { ...prev[i], status: ev.status, requestHeaders: ev.requestHeaders,
              requestBody: ev.requestBody, responseHeaders: ev.responseHeaders,
              responseBody: ev.responseBody, responseBodyTruncated: ev.responseBodyTruncated };
            return next;
          }
          if (i >= 0) return prev;
          return [{ id, url: ev.url, method: ev.method, resource: ev.resource, capture: ev.capture }, ...prev].slice(0, 300);
        });
      },
    ).then((u) => { if (alive) un = u; else u(); }).catch(() => {});
    return () => { alive = false; un?.(); };
  }, [profileId, captureScope]);

  const toggle = async () => {
    if (!profileId) return;
    const scope = captureScope();
    const next = !observing;
    try {
      await trafficObserve(profileId, next);
      if (!scope.current()) return;
      setObserving(next);
      if (!next) setObserved([]);
    } catch (e) { if (scope.current()) toast.fail({ title: next ? t("trafficPanel.watchFailed") : t("trafficPanel.unwatchFailed"), detail: e }); }
  };

  return { observing, observed, toggle, clear: () => setObserved([]) };
}
