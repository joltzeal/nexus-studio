import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Badge, cn, useLatched } from "@proxyshard/shardx-ui-kit";
import { loadOverviewRoom, overviewRoomHeight, saveOverviewRoom, setContinueByHand, useOverviewFolds, useProfileUi, viewFolds } from "../../entities/profile";
import type { PlanUsage, PsOrder } from "../../entities/proxyshard";
import { useSignalSources, useSignalState } from "../../entities/signals";
import { PsTopupModal } from "../../features/proxyshard";
import { useT } from "../../shared/i18n";
import { focusProfileRow } from "../../shared/lib/focusRow";
import { useDialogLife } from "../../shared/lib/useDialogLife";
import { FoldHeading } from "../../shared/ui/FoldHeading";
import { LIST_HEADER_HEIGHT, LIST_ROW_HEIGHT } from "../../shared/ui/listMetrics";
import { ContinueRow, CONTINUE_MAX, recentProfiles } from "./ContinueRow";
import { Fold } from "./Fold";
import { ProblemCard } from "./ProblemCard";
import { useProblemCards } from "./useProblemCards";

/** The longest the cards wait for their reads (the proxies' tests, the
 *  timezones they judge, the ProxyShard plans) before what is true so far
 *  shows; a later answer then moves in like any change. */
const SETTLE_CAP_MS = 1_000;
/** Below this many rows of list room, Continue shows folded (a short window). */
const SHORT_ROWS = 6;

/** The Continue row's columns: exactly 5, 3 or 1, by the list column's own
 *  width (a pushing Peek's room taken out), at the mock's 900 and 520 px:
 *  5 at 1280, 3 at 1024 and beside Peek. As many tiles as columns; with
 *  fewer, a tile keeps its column's width (review I1). */
const continueColumns = (width: number) => (width >= 900 ? 5 : width >= 520 ? 3 : 1);

/** A card's least width, with the grid's gap: 4 cards at 1280, fewer
 *  below and beside Peek. */
const CARD_MIN = 220;
// The grids use gap-2.5 (10 px at the 4 px spacing).
const GAP = 10;
const fit = (width: number, min: number, most: number) => Math.max(1, Math.min(most, Math.floor((width + GAP) / (min + GAP))));

/// The top of All profiles (the owner's redesign, 2026-10-01; shown only
/// there, 2026-10-08): Continue, the profiles used last, each with its status
/// and one Start or Stop (with fewer than two started, one quiet line says
/// where they will show up); then Problems to fix, a card for each problem
/// that can cost an account or money or broke work, only while it is true,
/// each saying what is wrong, why it matters and the one fix. Each section
/// folds under its heading as the sidebar's groups do (saved with the list's
/// layout); a folded Problems to fix says how many and, when an account is at
/// risk, which. With no problem its heading is not there at all.
///
/// No jump after the first paint: Continue comes from the list itself, and
/// the problem cards the list already proves are drawn unseen from the first
/// paint, so the room is theirs; the ones that need reads (the proxies'
/// tests, the timezones, the plans) join the same row, and everything fades
/// in once the reads are in (or after a second). Until the list is in, the
/// block keeps the room it had last time. After that each part opens and
/// closes on the spring, so the list slides.
///
/// It sits in the list's column, so Peek starts under the page header. It is
/// as wide as the list's whole row less `peekSpace`, the room a pushing Peek
/// takes; that room moves on Peek's own path (app.css `.overview`), and the
/// tiles and cards that no longer fit fold away at once.
export function Overview({ enabled, waiting, row, peekSpace }: {
  /** The list is in and has profiles. */
  enabled: boolean;
  /** The list is still loading: the room is kept meanwhile. */
  waiting: boolean;
  /** The list's row (its column and Peek). */
  row: RefObject<HTMLElement | null>;
  peekSpace: number;
}) {
  const t = useT();
  const { signals, scopeKey, input } = useSignalState();
  const folds = useOverviewFolds();

  // Top up: the ProxyShard dialog, on the plan's order; it stays through its exit.
  const [topUp, setTopUp] = useState<PsOrder | null>(null);
  const topUpLife = useDialogLife(topUp !== null);
  const topUpShown = useLatched(topUp);
  const openTopUp = useCallback((plan: PlanUsage) => {
    if (plan.orderId === null) return;
    setTopUp({ order_id: plan.orderId, product_name: plan.productName ?? "", cycle_name: "", expires_at: null, auto_renewal: null, tag: null });
  }, []);
  const cards = useProblemCards(signals, input, scopeKey, openTopUp);
  const recent = useMemo(
    () => (enabled ? recentProfiles(input.profiles, input.scopeIds, input.running, input.startFailed) : []),
    [enabled, input.profiles, input.scopeIds, input.running, input.startFailed],
  );

  // Settled: the list is in, and the cards' reads are too, or the cap passed.
  const sources = useSignalSources();
  const readsIn = sources.tests === "done" && sources.locales === "done" && sources.plans === "done";
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => setCapped(true), SETTLE_CAP_MS);
    return () => clearTimeout(timer);
  }, [enabled]);
  const [ready, setReady] = useState(false);
  if (!ready && enabled && (readsIn || capped)) setReady(true);
  // A frame after the list is first in, changes move; before, they are the first paint.
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!enabled || moving) return;
    const frame = requestAnimationFrame(() => setMoving(true));
    return () => cancelAnimationFrame(frame);
  }, [enabled, moving]);

  // The section is always there once the list is; with fewer than two
  // started profiles it holds a hint in place of the tiles.
  const hasContinue = enabled;
  const hasTiles = recent.length >= 2;
  const hasNeeds = enabled && cards.length > 0;
  const holding = !ready && (waiting || enabled);
  // The room it took when it last settled, folded as it is now: the engine
  // gate's frame holds the same, so the list's rows land where its
  // placeholder rows were.
  const [kept] = useState(loadOverviewRoom);
  const reserved = overviewRoomHeight(kept, viewFolds(folds));

  // The widths: the block's own, and the row's less Peek's room once that
  // has moved; the fewer of the two fit, so nothing is drawn under its least.
  const section = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = section.current;
    // The row's ref is set after this effect on the first commit (a parent's
    // ref comes after its children's effects): find the row itself then.
    const box = row.current ?? el?.closest<HTMLElement>("[data-list-row]") ?? null;
    if (!box || !el) return;
    const read = () => {
      el.style.setProperty("--row-w", `${box.offsetWidth}px`);
      setRowWidth(box.offsetWidth);
      setRowHeight(box.offsetHeight);
      setWidth(el.offsetWidth);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(box);
    observer.observe(el);
    return () => observer.disconnect();
  }, [row]);
  const room = Math.min(width ?? Infinity, rowWidth === null ? Infinity : rowWidth - peekSpace);
  const tiles = Number.isFinite(room) ? continueColumns(room) : CONTINUE_MAX;
  const cols = Number.isFinite(room) ? fit(room, CARD_MIN, 4) : 4;

  // The room kept for next time, once settled: each section's body (laid
  // out while folded too), or none for a section that is not there.
  const continueBody = useRef<HTMLDivElement>(null);
  const needsBody = useRef<HTMLDivElement>(null);
  const [bodies, setBodies] = useState<string | null>(null);
  useLayoutEffect(() => {
    const els = [continueBody.current, needsBody.current];
    if (!els[0] || !els[1] || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBodies(els.map((el) => el!.offsetHeight).join(":")));
    for (const el of els) observer.observe(el!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!ready || bodies === null) return;
    const [c, n] = bodies.split(":").map(Number);
    saveOverviewRoom({ continue: hasContinue ? c : null, needs: hasNeeds ? n : null });
  }, [ready, bodies, hasContinue, hasNeeds]);

  // A short window: with Continue open, the list would keep less than
  // SHORT_ROWS rows. Measured from fixed things only (the row's height, the
  // sections' bodies as they lay out, Problems to fix as the user left it), never
  // from what is drawn now, so folding Continue cannot flip the verdict back.
  const [continueBodyH, needsBodyH] = bodies === null ? [kept.continue, kept.needs] : bodies.split(":").map(Number);
  const short = rowHeight !== null && (hasContinue ? continueBodyH !== null : false) && rowHeight
    - overviewRoomHeight({ continue: hasContinue ? continueBodyH : null, needs: hasNeeds ? needsBodyH : null }, { continue: false, needs: folds.needs })
    - LIST_HEADER_HEIGHT < SHORT_ROWS * LIST_ROW_HEIGHT;
  // The saved fold is not touched: a short window only draws Continue folded.
  // The verdict lives in the store (and is kept), so the palette and the
  // first paint read the same rule.
  useLayoutEffect(() => { if (rowHeight !== null) useOverviewFolds.getState().setShort(short); }, [short, rowHeight]);
  const continueFolded = viewFolds(folds).continue;
  const toggleContinue = () => setContinueByHand(!continueFolded);

  // The keyboard never falls to the page: a card that leaves while it holds
  // it hands it to the card now in its place (or the one before); a section
  // that closes around it hands it to its heading, and one that goes, to
  // the list.
  const lostAt = useRef<number | null>(null);
  const onLeave = useCallback((slot: number) => { lostAt.current = slot; }, []);
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    const el = section.current;
    const at = lostAt.current;
    lostAt.current = null;
    if (!el || !hadFocus.current) return;
    const now = document.activeElement;
    if (now && now !== document.body && el.contains(now) && !now.closest("[inert]")) return;
    if (now && now !== document.body && !el.contains(now)) { hadFocus.current = false; return; }
    const slots = [...el.querySelectorAll<HTMLElement>("[data-focus-slot]")].filter((s) => !s.closest("[inert]"));
    const target = (at !== null ? slots[Math.min(at, slots.length - 1)]?.querySelector<HTMLElement>("[data-card-main]") : null)
      ?? [...el.querySelectorAll<HTMLElement>("[aria-expanded]")].find((h) => !h.closest("[inert]"));
    if (target) target.focus();
    else { hadFocus.current = false; focusProfileRow(useProfileUi.getState().activeId, { orTabbable: true }); }
  });

  const continueId = useId();
  const needsId = useId();
  const needsLabel = useId();
  const risk = cards.find((c) => c.risk);
  const instant = !moving;
  return (
    <div
      ref={section}
      data-overview=""
      data-hold={holding || undefined}
      data-peek-open={peekSpace > 0 || undefined}
      style={{ minHeight: holding ? reserved : 0, "--peek-space": `${peekSpace}px` } as CSSProperties}
      onFocus={() => { hadFocus.current = true; }}
      // Only a move to somewhere else lets go; a blur to nothing (the focused
      // card left) keeps it for the hand-off.
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) hadFocus.current = false; }}
      className="overview flex shrink-0 flex-col"
    >
      <Fold open={hasContinue} instant={instant}>
        {/* Folded, the heading keeps the gap its section left above what follows. */}
        <div role="group" aria-labelledby={`${continueId}-label`} data-overview-section="continue" className={cn("flex h-[24px] items-center box-content", continueFolded && "pb-2")}>
          <FoldHeading
            label={t("overview.continue")}
            labelId={`${continueId}-label`}
            open={!continueFolded}
            controls={continueId}
            onToggle={toggleContinue}
          />
        </div>
      </Fold>
      <Fold id={continueId} open={hasContinue && !continueFolded} instant={instant}>
        <div ref={continueBody} className="pt-1 pb-2">
          {hasTiles
            ? <ContinueRow profiles={recent} columns={tiles} now={input.now} />
            : <p data-continue-hint className="m-0 text-secondary text-text-soft-400">{t("overview.continueEmpty")}</p>}
        </div>
      </Fold>
      <Fold open={hasNeeds} hold={!ready} instant={instant}>
        <div role="group" aria-labelledby={needsLabel} data-overview-section="needs" data-tour={hasNeeds ? "problems" : undefined} className={cn("flex h-[24px] items-center box-content", folds.needs && "pb-2")}>
          <FoldHeading
            label={t("overview.needsYou")}
            labelId={needsLabel}
            open={!folds.needs}
            controls={needsId}
            onToggle={() => folds.toggle("needs")}
            after={folds.needs ? (
              <>
                {/* The spaces keep the words apart for a screen reader; flex drops them on screen. */}
                {" "}<span data-needs-count className="tabular-nums">{cards.length}</span>
                {/* The most severe tone, only for an account at risk; its word, never the color alone. */}
                {risk && <>{" "}<Badge shape="pill" size="small" color="error" className="normal-case">{risk.label}</Badge></>}
              </>
            ) : undefined}
          />
        </div>
      </Fold>
      <Fold id={needsId} open={hasNeeds && !folds.needs} hold={!ready} instant={instant}>
        {/* Fewer cards than columns share the row: no empty band beside them. */}
        <div ref={needsBody} className="grid pt-1 pb-2 gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(cols, cards.length))}, minmax(0, 1fr))` }}>
          {cards.map((m, i) => <ProblemCard key={m.kind} model={m} fresh={ready && moving} slot={i} onLeave={onLeave} />)}
        </div>
      </Fold>
      {topUpLife.mounted && topUpShown && (
        <PsTopupModal key={topUpLife.session} open={topUp !== null} order={topUpShown} onClose={() => setTopUp(null)} onDone={() => setTopUp(null)} />
      )}
    </div>
  );
}
