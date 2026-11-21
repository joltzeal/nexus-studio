import { create } from "zustand";
import { SIGNAL_KINDS, type Signal, type SignalKind } from "./signals";

/// Action cards the user hid on purpose (spec 5.4), like running Sandbox
/// direct: per card and per scope (a Folder or a View: a hide in one never
/// hides or unhides another), each with the subjects it was about. Kept on
/// this computer, as the list's own layout is.
const KEY = "shardx.signals.hidden";

/** kind -> scope ("folder:<name>", "view:<id>") -> the hidden subjects. */
export type HiddenSignals = Partial<Record<SignalKind, Record<string, string[]>>>;

/** What is stored; a missing, broken or odd value hides nothing. */
function load(): HiddenSignals {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return {};
    const out: HiddenSignals = {};
    for (const kind of SIGNAL_KINDS) {
      const scopes = raw[kind];
      if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) continue;
      const kept: Record<string, string[]> = {};
      for (const [scope, subjects] of Object.entries(scopes)) {
        if (Array.isArray(subjects) && subjects.every((x) => typeof x === "string")) kept[scope] = subjects;
      }
      out[kind] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export const useHiddenSignals = create<{ hidden: HiddenSignals }>(() => ({ hidden: load() }));

function store(hidden: HiddenSignals) {
  try { localStorage.setItem(KEY, JSON.stringify(hidden)); } catch { /* private mode: until reload */ }
  useHiddenSignals.setState({ hidden });
}

/** Hides a card in one scope for what it is about now, joined to what was
 *  hidden there before (never replacing it). */
export function hideSignal(signal: Pick<Signal, "kind" | "subjects">, scope: string): void {
  const all = useHiddenSignals.getState().hidden;
  const had = all[signal.kind]?.[scope] ?? [];
  store({ ...all, [signal.kind]: { ...all[signal.kind], [scope]: [...new Set([...had, ...signal.subjects])] } });
}

/** Forgets the hides the world has moved past (L3 review, N3), in one write,
 *  and only when one goes:
 *  - in `scope`, a card whose reads are in (`settled`) and that is not true
 *    now: what it was hidden for has cleared, so it comes back the next time
 *    it holds (Sandbox given a proxy, then run direct again; a proxy that
 *    passed, then failed again);
 *  - every scope `exists` no longer knows: a Folder or View deleted or
 *    renamed (a new one of the old name starts with nothing hidden). */
export function pruneHidden(scope: string, settled: ReadonlySet<SignalKind>, trueNow: ReadonlySet<SignalKind>, exists: (scope: string) => boolean): void {
  const all = useHiddenSignals.getState().hidden;
  const next: HiddenSignals = {};
  let dropped = false;
  for (const kind of SIGNAL_KINDS) {
    const scopes = all[kind];
    if (!scopes) continue;
    const kept: Record<string, string[]> = {};
    for (const [at, subjects] of Object.entries(scopes)) {
      const cleared = at === scope && settled.has(kind) && !trueNow.has(kind);
      if (cleared || !exists(at)) dropped = true;
      else kept[at] = subjects;
    }
    if (Object.keys(kept).length > 0) next[kind] = kept;
  }
  if (dropped) store(next);
}

/** Hidden in this scope while every subject it is about was hidden there:
 *  fewer stay hidden, a new one brings the card back. */
export function isHidden(signal: Pick<Signal, "kind" | "subjects">, scope: string, hidden: HiddenSignals = useHiddenSignals.getState().hidden): boolean {
  const stored = hidden[signal.kind]?.[scope];
  if (!stored || stored.length === 0) return false;
  const set = new Set(stored);
  return signal.subjects.every((x) => set.has(x));
}
