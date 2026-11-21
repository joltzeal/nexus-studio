import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { isAutomationEventCurrent } from "../../../raccoon/automation/context";
import { isNativeRaccoon } from "../../../raccoon/runtime";
import { captureAutomationScope } from "./scope";

export function useAutomationChanged(reload: () => Promise<void>) {
  const callback = useRef(reload);
  callback.current = reload;
  useEffect(() => {
    const scope = captureAutomationScope();
    let active = true;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void listen<unknown>("store-changed", ({ payload }) => {
      if (!active || !scope.current()) return;
      if (isNativeRaccoon()) {
        if (!payload || typeof payload !== "object" || !("connection_id" in payload)
          || typeof payload.connection_id !== "string" || !isAutomationEventCurrent({ connection_id: payload.connection_id })) return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (active && scope.current()) void callback.current();
      }, 200);
    }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    return () => { active = false; clearTimeout(timer); unlisten?.(); };
  }, []);
}
