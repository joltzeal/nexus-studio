import { useEffect, useRef } from "react";
import { Button, cn, IconSwap, Tooltip } from "@proxyshard/shardx-ui-kit";
import { CheckCircleIcon } from "../../shared/icons";
import { useT } from "../../shared/i18n";
import { stampMs } from "../../shared/lib/utils";
import { pageStart, refocusIfLost, useFocusHandOff } from "../../shared/lib/focus";
import { useNav } from "../../shared/model/navigation";
import { useProfile } from "../../entities/profile";
import { useProxy } from "../../entities/proxy";
import { ImportProfilesButton, NewProfileButton } from "../../features/manage-profiles";
import { useOnboarding, useSetupSteps, type SetupStepId } from "../../features/onboarding";
import { startProfileTour } from "../../features/tour";

/// Get started: add a proxy, create a profile, start it. Full as the Profiles
/// empty state on a fresh install; compact above the list once profiles
/// exist, with Hide. Each step ticks itself from the data.
export function SetupChecklist({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { steps, stepProxy } = useSetupSteps();
  const finish = useOnboarding((s) => s.finish);
  const done = steps.filter((s) => s.done).length;
  // One step at a time: only the first not done fills its button (CRAFT-20).
  const current = steps.find((s) => !s.done)?.id;
  const title: Record<SetupStepId, string> = {
    proxy: t("setup.proxyTitle"), profile: t("setup.profileTitle"), start: t("setup.startTitle"),
  };
  const hint: Record<SetupStepId, string> = {
    proxy: t("setup.proxyHint"),
    profile: stepProxy
      ? t("setup.profileHintProxy", { name: stepProxy.name || `${stepProxy.host}:${stepProxy.port}` })
      : t("setup.profileHint"),
    start: t("setup.startHint"),
  };
  const listRef = useRef<HTMLOListElement>(null);
  // Put away (Hide, or the last step done by its Start) while it has the
  // keyboard: the list's row, else the page title, takes it (PC-117).
  const sectionRef = useRef<HTMLElement>(null);
  useFocusHandOff(sectionRef, () => pageStart("profiles"));
  // Back from the proxy importer: the keyboard goes to the next step's button.
  const focusNext = useOnboarding((s) => s.focusNext);
  useEffect(() => {
    if (!focusNext) return;
    useOnboarding.getState().focusedNext();
    listRef.current?.querySelector<HTMLButtonElement>("[data-step]:not([data-done]) button:not([disabled]):not([aria-disabled=\"true\"])")?.focus();
  }, [focusNext]);

  const header = (
    <div className="flex items-baseline gap-2">
      <h2 className="m-0 text-panel-title text-text-strong-950">{t("setup.title")}</h2>
      <span className="text-secondary tabular-nums text-text-soft-400">{t("setup.progress", { n: done })}</span>
      {compact && (
        <Button variant="neutral" mode="ghost" size="3xsmall" className="ml-auto" onClick={finish}>
          {t("setup.hide")}
        </Button>
      )}
    </div>
  );

  return (
    <section
      ref={sectionRef}
      aria-label={t("setup.title")}
      className={cn(
        "rounded-surface border border-stroke-soft-200 bg-bg-white-0",
        compact ? "flex shrink-0 flex-col gap-2 px-4 py-3" : "m-auto flex w-full max-w-[520px] shrink-0 flex-col gap-3 p-5",
      )}
    >
      {header}
      <ol ref={listRef} className={cn("m-0 list-none p-0", compact ? "grid grid-cols-3 gap-3" : "flex flex-col divide-y divide-stroke-soft-200")}>
        {steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            data-done={step.done ? "" : undefined}
            className={cn("flex items-center gap-3", !compact && "py-3")}
          >
            {/* A step that gets done ticks over with a cross-fade, not a cut (FEEL-39). */}
            <IconSwap
              className="size-3.5 shrink-0"
              on={step.done}
              onIcon={<CheckCircleIcon className="size-3.5 text-success-base" />}
              offIcon={<span className="size-3.5 rounded-full border-[1.5px] border-stroke-sub-300" />}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn("text-ui", step.done ? "text-text-soft-400" : "text-text-strong-950")}>
                {title[step.id]}
                {step.done && <span className="sr-only"> ({t("setup.done")})</span>}
              </span>
              {!compact && <span className="text-secondary text-text-soft-400">{hint[step.id]}</span>}
            </div>
            {!step.done && <StepAction id={step.id} current={step.id === current} proxyId={stepProxy?.id ?? null} />}
          </li>
        ))}
      </ol>
      {!compact && (
        <div className="flex items-center justify-center gap-2 pt-1 text-secondary text-text-soft-400">
          {t("setup.orImport")}
          <ImportProfilesButton />
        </div>
      )}
    </section>
  );
}

/** The first step not done yet: its button, where the keyboard goes when a step's buttons leave. */
function nextStepButton(list: Element | null): HTMLElement | null {
  return list?.querySelector<HTMLElement>("[data-step]:not([data-done]) button:not([disabled]):not([aria-disabled=\"true\"])") ?? null;
}

function StepAction({ id, current, proxyId }: { id: SetupStepId; current: boolean; proxyId: string | null }) {
  const t = useT();
  const profiles = useProfile((s) => s.profiles);
  const skipProxy = useOnboarding((s) => s.skipProxy);
  // Every step's button is one size; the current one is filled, the rest stroke.
  const mode = current ? "filled" : "stroke";
  const look = { size: "3xsmall", mode, variant: current ? "primary" : "neutral", "data-mode": mode } as const;
  if (id === "proxy") {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="neutral"
          mode="ghost"
          size="3xsmall"
          onClick={(e) => {
            const list = e.currentTarget.closest("ol");
            skipProxy();
            // The step's buttons go with it: the next step's button takes the keyboard (PC-117).
            refocusIfLost(() => nextStepButton(list));
          }}
        >
          {t("setup.skip")}
        </Button>
        <Button
          {...look}
          onClick={async () => {
            // Nothing starts when the person stays (unsaved changes, Cancel).
            if (!(await useNav.getState().setSection("proxies"))) return;
            useOnboarding.getState().startProxyStep();
            useProxy.getState().setBulkOpen(true);
          }}
        >
          {t("setup.proxyAction")}
        </Button>
      </div>
    );
  }
  if (id === "profile") {
    return (
      <div className="flex shrink-0 items-center gap-1">
        {/* New profile first: it is the step's button, where the keyboard goes
            when the step before is done. Show me how walks the same form. */}
        <NewProfileButton proxyId={proxyId} size="3xsmall" mode={mode} />
        <Button variant="neutral" mode="ghost" size="3xsmall" onClick={() => void startProfileTour({ proxyId })}>
          {t("setup.showMe")}
        </Button>
      </div>
    );
  }
  // The newest profile: the one this checklist just made, most likely. A tie
  // in the creation second goes to the later one in the list (PC-116).
  const newest = profiles.reduce<(typeof profiles)[number] | undefined>(
    (best, p) => (!best || (stampMs(p.created_at) ?? 0) >= (stampMs(best.created_at) ?? 0) ? p : best),
    undefined,
  );
  const label = newest ? t("setup.startNamed", { name: newest.name }) : t("setup.start");
  return (
    // A long name ends in an ellipsis; the button's name keeps all of it,
    // and a tooltip shows it whole when it is cut (MP4 review, M14).
    <Tooltip content={label} whenTruncated>
      <Button
        {...look}
        contentAlign="start"
        className="max-w-[240px]"
        disabled={!newest}
        onClick={() => { if (newest) void useProfile.getState().startStop(newest); }}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
