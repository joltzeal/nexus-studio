import { memo, useMemo, useRef, useState } from "react";
import { cardClass, cn, IconButton, Tooltip } from "@proxyshard/shardx-ui-kit";
import { profileStatus, proxyMissing, useProfile, useProfileUi, useSaving, type ProfileMeta } from "../../entities/profile";
import { useLang, useT } from "../../shared/i18n";
import { fmtDurationShort } from "../../shared/lib/format";
import { stampMs } from "../../shared/lib/utils";
import { rowActionIcons } from "../../shared/ui/rowActionIcons";
import { StatusDot } from "../../shared/ui/StatusDot";

/** At most this many tiles, however wide the list is. */
export const CONTINUE_MAX = 5;

/// The profiles to continue with, in the order of their last use: a running
/// one is in use now, so it leads (the latest start first) and stays while
/// it runs; then the last run or failed start. None when fewer than two were
/// ever used: a row of one says nothing the list does not. The Overview then
/// keeps the Continue heading and says, in one line, where they will show up.
export function recentProfiles(
  profiles: ProfileMeta[], scopeIds: ReadonlySet<string>, running: Record<string, number>, startFailed: Record<string, number>,
): ProfileMeta[] {
  const lastUse = (p: ProfileMeta) => Math.max(stampMs(p.last_launched_at) ?? -Infinity, startFailed[p.id] ?? -Infinity);
  // Each date read once, not twice per comparison: 2,000 profiles change
  // with every row an Undo brings back.
  const at = new Map<string, number>();
  const used = profiles.filter((p) => {
    if (!scopeIds.has(p.id)) return false;
    const last = lastUse(p);
    at.set(p.id, last);
    return running[p.id] !== undefined || last > -Infinity;
  });
  if (used.length < 2) return [];
  const runs = used.filter((p) => running[p.id] !== undefined).sort((a, b) => (running[b.id] || 0) - (running[a.id] || 0));
  const rest = used.filter((p) => running[p.id] === undefined).sort((a, b) => at.get(b.id)! - at.get(a.id)!);
  return [...runs, ...rest];
}

/** A run's length as the tile says it: hours once past one, else minutes
 *  ("Running, 2 h"); fmtDuration's "2 h 14 min" is cut off in a tile. */
const runLength = (ms: number) => fmtDurationShort(ms);

const TONE: Partial<Record<string, string>> = { running: "text-success-text", failed: "text-error-text", warning: "text-warning-text" };

/// One recent profile: its name (whole in a tooltip
/// when cut), its status in words, and one Start or Stop. A click anywhere
/// but that button opens it in Peek; the keyboard reaches the name's button
/// (Enter opens Peek), then Start or Stop.
/// Memoized: Peek opening or closing draws the overview again (its room
/// changes), and a tile whose profile and minute did not change has nothing
/// new to draw.
const Tile = memo(function Tile({ profile: p, now }: { profile: ProfileMeta; now: number }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const runningSince = useProfile((s) => s.running[p.id]);
  const starting = useProfile((s) => s.startBusy.has(p.id));
  const cancelled = useProfile((s) => s.cancelled.has(p.id));
  const stopping = useProfile((s) => s.pending[p.id]?.kind === "stop");
  const failedAt = useProfile((s) => s.startFailed[p.id]);
  const proxies = useProfile((s) => s.proxies);
  const saving = useSaving((s) => s.ids.has(p.id));
  const status = profileStatus(p, { starting, cancelled, stopping, runningSince, failedAt, saving, now, lang, proxyMissing: proxyMissing(p, proxies) });
  const running = runningSince !== undefined;
  const words = status.tone === "running" && Number.isFinite(runningSince)
    ? t("overview.runningFor", { duration: runLength(now - runningSince!) })
    : status.label;
  return (
    <div
      data-continue-tile={p.id}
      // The name's button and the rest of the tile open Peek; Start or Stop keeps its own meaning.
      onClick={(e) => { if (!(e.target as HTMLElement).closest("[data-tile-action]")) useProfileUi.getState().openPeek(p.id); }}
      className={cn(cardClass({ interactive: true }), "continue-tile relative flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2")}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- the tile's keyboard stop holds its two lines; the kit Button's height and type role would replace them */}
      <button type="button" data-tile-main className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left focus-visible:outline-hidden">
        <span className="flex min-w-0 flex-col">
          <Tooltip content={p.name} whenTruncated warm={false}>
            <span className="truncate text-ui text-text-strong-950">{p.name}</span>
          </Tooltip>
          <span data-tile-status={status.tone} className={cn("flex min-w-0 items-center gap-1.5 text-secondary", TONE[status.tone] ?? "text-text-soft-400")}>
            {/* The only halo here: a running profile's dot (no breathe). */}
            {status.tone === "running" && <StatusDot tone="success" halo />}
            <span className="truncate">{words}</span>
          </span>
        </span>
      </button>
      <IconButton
        size="3xsmall"
        variant={running ? "error" : "neutral"}
        mode={running ? "lighter" : "stroke"}
        tooltipWarm={false}
        label={running ? t("sidebar.stopProfile", { name: p.name }) : t("sidebar.startProfile", { name: p.name })}
        icon={rowActionIcons[running ? "stop" : "start"]({ className: "size-3.5" })}
        isLoading={starting || stopping}
        data-tile-action=""
        className="shrink-0"
        // startStop says why it failed or was refused in its own toast.
        onClick={() => void useProfile.getState().startStop(p)}
      />
    </div>
  );
});

/// The Continue row: the recent profiles, as many as fit (`columns`). Its
/// order holds while the pointer or the keyboard is in it, so a tile never
/// moves under the hand that just started it; it catches up on leaving.
export function ContinueRow({ profiles, columns, now }: { profiles: ProfileMeta[]; columns: number; now: number }) {
  const [held, setHeld] = useState<string[] | null>(null);
  const inside = useRef({ pointer: false, focus: false });
  const shown = useMemo(() => {
    if (!held) return profiles.slice(0, columns);
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return held.flatMap((id) => byId.get(id) ?? []).slice(0, columns);
  }, [held, profiles, columns]);
  const enter = (how: "pointer" | "focus") => {
    inside.current[how] = true;
    setHeld((h) => h ?? profiles.slice(0, CONTINUE_MAX).map((p) => p.id));
  };
  const leave = (how: "pointer" | "focus") => {
    inside.current[how] = false;
    if (!inside.current.pointer && !inside.current.focus) setHeld(null);
  };
  return (
    <div
      role="list"
      className="grid gap-2.5"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      onPointerEnter={() => enter("pointer")}
      onPointerLeave={() => leave("pointer")}
      onFocus={() => enter("focus")}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave("focus"); }}
    >
      {shown.map((p) => <div role="listitem" key={p.id} className="flex min-w-0"><Tile profile={p} now={now} /></div>)}
    </div>
  );
}
