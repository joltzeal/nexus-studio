import { create } from "zustand";
import { psUsage } from "../model/api";
import type { PsUsage, PsUsageRange, PsUsageSeries } from "../model/types";

/// The ProxyShard page's Usage section: the range a person picked (kept, so
/// it comes back after a restart) and the history the backend has for it
/// (B40). A failed read is no history, not an error: until the backend has
/// `ps_usage` every call fails, and each card shows the No data ghost. A
/// refresh keeps what shows until the new answer is in.

const RANGE_KEY = "shardx.psUsage.range";
const RANGES: readonly PsUsageRange[] = ["24h", "7d", "30d"];

function savedRange(): PsUsageRange {
  try {
    const v = localStorage.getItem(RANGE_KEY) as PsUsageRange | null;
    return v && RANGES.includes(v) ? v : "7d";
  } catch {
    return "7d";
  }
}

/** The last read wins: an answer for a range the person already left never lands. */
let latest = 0;

export const usePsUsage = create<{
  range: PsUsageRange;
  /** loading: before the first answer for this range; done: `data` is the answer (null: no history). */
  status: "idle" | "loading" | "done";
  data: PsUsage | null;
  setRange: (range: PsUsageRange) => void;
  load: () => Promise<void>;
}>((set, get) => ({
  range: savedRange(),
  status: "idle",
  data: null,
  setRange: (range) => {
    try { localStorage.setItem(RANGE_KEY, range); } catch { /* private mode: until reload */ }
    set({ range, status: "loading", data: null });
    void get().load();
  },
  load: async () => {
    const mine = ++latest;
    const { range, status } = get();
    if (status === "idle") set({ status: "loading" });
    let data: PsUsage | null = null;
    try { data = await psUsage(range); } catch { /* no history yet (B40) */ }
    if (mine === latest) set({ status: "done", data });
  },
}));

/** A series with at least one bucket. */
export const hasHistory = (s: PsUsageSeries | null | undefined): s is PsUsageSeries => !!s && s.points.length > 0;

export const totalOf = (s: PsUsageSeries) => s.points.reduce((a, b) => a + b, 0);

/** Several series as one, bucket by bucket; null when none has history. The
 *  period before is known only when every part knows it. */
export function sumSeries(parts: (PsUsageSeries | null | undefined)[]): PsUsageSeries | null {
  const known = parts.filter(hasHistory);
  if (known.length === 0) return null;
  const n = Math.max(...known.map((s) => s.points.length));
  const points = Array.from({ length: n }, (_, i) => known.reduce((a, s) => a + (s.points[i] ?? 0), 0));
  const previous = known.every((s) => s.previous !== null) ? known.reduce((a, s) => a + (s.previous ?? 0), 0) : null;
  return { points, previous };
}

/** The change against the period before, in whole percent; null unless both
 *  periods have data (and the earlier one is not zero). */
export function trendOf(now: number, before: number | null): number | null {
  if (before === null || !(before > 0) || !Number.isFinite(now)) return null;
  return Math.round(((now - before) / before) * 100);
}
