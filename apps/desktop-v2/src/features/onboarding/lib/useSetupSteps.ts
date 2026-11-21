import { useEffect } from "react";
import { useProfile } from "../../../entities/profile";
import type { ProxyEntry } from "../../../entities/proxy";
import { trashList } from "../../../entities/trash";
import { useOnboarding } from "../model/onboarding";
import { isNativeRaccoon } from "../../../raccoon/runtime";

export type SetupStepId = "proxy" | "profile" | "start";

/// The checklist's three steps, read from the data: each ticks as soon as it
/// is true, whichever way it got there (this card, the Proxies page, an
/// import, the palette). The first loaded list decides whether it shows at
/// all; all three done puts it away for good. `deciding` while an empty list
/// waits for the Trash to say whether this is a fresh install (PC-115), so
/// the page shows neither the empty list nor the checklist yet (PC-118).
export function useSetupSteps(): {
  steps: { id: SetupStepId; done: boolean }[];
  active: boolean;
  deciding: boolean;
  stepProxy: ProxyEntry | null;
} {
  const status = useProfile((s) => s.status);
  const profiles = useProfile((s) => s.profiles);
  const proxies = useProfile((s) => s.proxies);
  const state = useOnboarding((s) => s.state);
  const proxySkipped = useOnboarding((s) => s.proxySkipped);
  // A start counts once it is confirmed: "running" is set before the launch
  // call, and a launch that fails rolls it back. A boolean, so the 2 s poll
  // does not re-render the page (PERF-01).
  const started = useProfile((s) => s.profiles.some((p) => !!p.last_launched_at || (!!s.running[p.id] && s.pending[p.id]?.kind !== "start")));

  const steps: { id: SetupStepId; done: boolean }[] = [
    { id: "proxy", done: proxySkipped || proxies.length > 0 },
    { id: "profile", done: profiles.length > 0 },
    { id: "start", done: started },
  ];
  const allDone = steps.every((s) => s.done);

  useEffect(() => {
    if (isNativeRaccoon()) return;
    if (status !== "ready" || useOnboarding.getState().state !== "unknown") return;
    if (profiles.length > 0) { useOnboarding.getState().decide(true); return; }
    // Profiles that are all in the Trash still mean the user has been here (PC-115).
    trashList().then((l) => useOnboarding.getState().decide(l.length > 0), () => useOnboarding.getState().decide(false));
  }, [status, profiles.length]);
  useEffect(() => {
    if (state === "active" && allDone) useOnboarding.getState().finish();
  }, [state, allDone]);

  // The proxy step 2 uses: the newest one no profile is on (the one step 1 added).
  const stepProxy = [...proxies].reverse().find((px) => !profiles.some((p) => p.proxy_id === px.id)) ?? null;

  return {
    steps,
    active: !isNativeRaccoon() && state === "active" && !allDone,
    deciding: !isNativeRaccoon() && state === "unknown" && status === "ready" && profiles.length === 0,
    stepProxy,
  };
}
