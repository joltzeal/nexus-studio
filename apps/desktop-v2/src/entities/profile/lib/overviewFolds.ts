import { create } from "zustand";
import { loadOverviewFolds, persistOverviewFolds, type OverviewFolds, type OverviewSection } from "./columns";

/// The folded state of Continue and Problems to fix on top of the Profiles list
/// (owner, 2026-10-01: they fold like the sidebar's groups, never go away).
/// Saved with the list's layout.
export const useOverviewFolds = create<OverviewFolds & {
  /** A short window (the list would keep under six rows with Continue open):
   *  the view draws Continue folded, the saved fold untouched. Not saved,
   *  except the last verdict, so the first paint holds the right room. */
  short: boolean;
  /** Continue unfolded by hand while short; holds until the window grows. */
  byHand: boolean;
  setShort: (short: boolean) => void;
  setFolded: (section: OverviewSection, folded: boolean) => void;
  toggle: (section: OverviewSection) => void;
}>((set, get) => ({
  ...loadOverviewFolds(),
  short: loadShort(),
  byHand: false,
  setShort: (short) => {
    if (get().short === short) return;
    set({ short, ...(short ? {} : { byHand: false }) });
    try { localStorage.setItem(SHORT_KEY, short ? "1" : "0"); } catch { /* private mode */ }
  },
  setFolded: (section, folded) => {
    if (get()[section] === folded) return;
    set({ [section]: folded } as Partial<OverviewFolds>);
    persistOverviewFolds({ continue: get().continue, needs: get().needs });
  },
  toggle: (section) => get().setFolded(section, !get()[section]),
}));

const SHORT_KEY = "shardx.overview.short";
function loadShort(): boolean {
  try { return localStorage.getItem(SHORT_KEY) === "1"; } catch { return false; }
}

/** The folds the view draws: the saved ones, and Continue folded too in a
 *  short window unless it was opened by hand. */
export function viewFolds(s: OverviewFolds & { short: boolean; byHand: boolean }): OverviewFolds {
  return { continue: s.continue || (s.short && !s.byHand), needs: s.needs };
}

/** Fold or unfold Continue as a person means it: unfolding in a short window
 *  is by hand (it holds until the window grows); the saved fold follows. */
export function setContinueByHand(folded: boolean): void {
  const st = useOverviewFolds.getState();
  if (folded) { useOverviewFolds.setState({ byHand: false }); st.setFolded("continue", true); return; }
  if (st.short) useOverviewFolds.setState({ byHand: true });
  st.setFolded("continue", false);
}

/// The room the block takes, kept from the last time it settled, so the next
/// start holds it from its first frame (the engine gate's frame, then the
/// page while the cards' reads come in) and the list does not move when the
/// block appears (FEEL-40; L3 review, I3). What is kept is each section's
/// body (null: the section was not there); a section's heading is added per
/// the fold state now, so a fold changed since still holds the right room.
export type OverviewRoom = Record<OverviewSection, number | null>;
const ROOM_KEY = "shardx.overview.room";

/** A section's heading row (Overview's `h-[24px]`), and the gap a folded
 *  heading keeps under it (its `pb-3`: the app's spacing step is 3.33 px, so 10). */
const HEADING = 24;
const FOLDED_GAP = 6;

export function loadOverviewRoom(): OverviewRoom {
  const none: OverviewRoom = { continue: null, needs: null };
  try {
    const raw = JSON.parse(localStorage.getItem(ROOM_KEY) ?? "null") as Partial<Record<OverviewSection, unknown>> | null;
    if (!raw || typeof raw !== "object") return none;
    const body = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    return { continue: body(raw.continue), needs: body(raw.needs) };
  } catch {
    return none;
  }
}

export function saveOverviewRoom(room: OverviewRoom): void {
  try { localStorage.setItem(ROOM_KEY, JSON.stringify(room)); } catch { /* private mode: no room kept */ }
}

/** The block's height with these folds: each section there last time, its
 *  heading, and its body unless it is folded. */
export function overviewRoomHeight(room: OverviewRoom, folds: OverviewFolds): number {
  let h = 0;
  for (const s of ["continue", "needs"] as const) {
    const body = room[s];
    if (body !== null) h += HEADING + (folds[s] ? FOLDED_GAP : body);
  }
  return h;
}
