import { isNativeRaccoon } from "../../../raccoon/runtime.ts";
import { useCallback, useLayoutEffect, useMemo } from "react";
import {
  automationConnection,
  automationScope,
  isAutomationScopeCurrent,
} from "../../../raccoon/automation/context.ts";

let previewScope = 0;

export function advanceAutomationPreviewScope() {
  previewScope++;
}

/** Capture before the first await. Check before continuing a write sequence
 * and before publishing its result into the current Workspace. */
export function captureAutomationScope() {
  const native = isNativeRaccoon();
  const scope = native ? automationScope() : previewScope;
  const connectionId = native ? automationConnection() : null;
  return {
    key: `${native ? connectionId : "preview"}:${scope}`,
    connectionId,
    current: () => native ? isAutomationScopeCurrent(scope) : previewScope === scope,
  };
}

/** Async component callbacks also expire on unmount or target changes. */
export function useAutomationEffectScope(identity?: string | null) {
  const lifetime = useMemo(() => ({ active: true, generation: 0 }), [identity]);
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => { lifetime.active = false; lifetime.generation++; };
  }, [lifetime]);
  return useCallback(() => {
    const scope = captureAutomationScope();
    const generation = lifetime.generation;
    return { ...scope, current: () => lifetime.active && generation === lifetime.generation && scope.current() };
  }, [lifetime]);
}
