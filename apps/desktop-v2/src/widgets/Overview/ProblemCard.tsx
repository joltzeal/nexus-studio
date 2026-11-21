import { useId, useLayoutEffect, useRef, useState } from "react";
import { Badge, Button, cardClass, cn, DismissButton, Tooltip } from "@proxyshard/shardx-ui-kit";
import { useT } from "../../shared/i18n";
import type { CardAction, CardModel } from "./useProblemCards";

/** Runs a card's fix with its own busy state: a slow one (a retest, a save)
 *  shows its spinner and ignores a second press. */
function useRunner() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = (a: CardAction) => {
    if (running.current) return;
    const out = a.run();
    if (!(out instanceof Promise)) return;
    running.current = true;
    setBusy(true);
    void out.finally(() => { running.current = false; setBusy(false); });
  };
  return { busy, run };
}

/** When a card leaves (its own Hide or fix cleared it) while it held the
 *  keyboard, it says where it stood, so the keyboard moves on from there. */
function useLeaveHandoff(slot: number, onLeave: (slot: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ slot, onLeave });
  useLayoutEffect(() => { latest.current = { slot, onLeave }; });
  useLayoutEffect(() => {
    const el = ref.current;
    return () => { if (el?.contains(document.activeElement)) latest.current.onLeave(latest.current.slot); };
  }, []);
  return ref;
}

/// One problem card (the owner-approved mock): the title with its severity
/// pill, what is wrong in one plain sentence (two lines at most), why it
/// matters in one more, one detail line (whole in a tooltip when cut) or the
/// plan's usage bar, and the fix with a quiet count at the right. A click anywhere but the fix or Hide shows the profiles it
/// names; the keyboard reaches the title's button (Enter shows them), then
/// the fix. Hide comes with the pointer or the keyboard. A card is its
/// content's height, never a fixed one (owner rule: no empty stretch in
/// cards; merge point 12); the cards of one row stretch to the tallest of
/// them (the grid's own stretch), so a row reads as one.
/// `fresh`: a card that arrives after the page settled fades in.
export function ProblemCard({ model, fresh, slot, onLeave }: { model: CardModel; fresh: boolean; slot: number; onLeave: (slot: number) => void }) {
  const t = useT();
  const { busy, run } = useRunner();
  const ref = useLeaveHandoff(slot, onLeave);
  const whatId = useId();
  const whyId = useId();
  const detailId = useId();
  return (
    <div
      ref={ref}
      role="group"
      aria-label={model.label}
      data-problem-card={model.kind}
      data-focus-slot=""
      onClick={(e) => { if (!(e.target as HTMLElement).closest("[data-card-action]")) model.show(); }}
      className={cn(
        cardClass({ interactive: true }),
        // A card as wide as a row's share of 640 px or more puts its fix beside the text, not under it.
        "problem-card group/card @container/card relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] px-cell py-3",
        fresh && "starting:opacity-0",
      )}
    >
      <div className="col-start-1 row-start-1 flex h-[21px] min-w-0 items-center gap-2">
        {/* eslint-disable-next-line no-restricted-syntax -- the card's title is its keyboard stop; the kit Button's type role and padding would replace the card's label */}
        <button
          type="button"
          data-card-main
          aria-describedby={`${whatId} ${whyId} ${detailId}`}
          className="min-w-0 shrink cursor-pointer truncate text-left text-field-label text-text-sub-600 focus-visible:outline-hidden"
        >
          {model.label}
        </button>
        <Badge shape="pill" color={model.pill.color} className="shrink-0 tabular-nums">{model.pill.text}</Badge>
        <span className="min-w-0 flex-1" />
        {model.hide && (
          // At rest a card shows what needs you; Hide comes with the pointer or the keyboard.
          <span data-card-action="" className="flex opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
            <DismissButton label={t("overview.hide")} onClick={model.hide} />
          </span>
        )}
      </div>
      {/* The sentence, why it matters and the detail sit together between the
          title and the fix, the same 8 px from each; in a card stretched to
          its row's tallest they stay centered in the room, so neither gap is
          a stretch. */}
      <div className="col-start-1 row-start-2 flex min-h-0 flex-col justify-center py-2.5">
        <p id={whatId} className="m-0 line-clamp-2 text-ui text-text-strong-950 [text-wrap:pretty]">{model.what}</p>
        <p id={whyId} data-card-why className="m-0 mt-1 text-secondary text-text-sub-600 [text-wrap:pretty]">{model.why}</p>
        {model.usage ? (
          <div id={detailId} data-card-usage className="mt-1.5 flex flex-col gap-1">
            <div aria-hidden="true" className="h-[5px] overflow-hidden rounded-full bg-bg-on-tile forced-colors:outline forced-colors:outline-1 forced-colors:outline-[CanvasText]">
              <div className="h-full rounded-full bg-warning-base forced-colors:forced-color-adjust-none forced-colors:bg-[Highlight]" style={{ width: `${Math.round(model.usage.share * 100)}%` }} />
            </div>
            <div className="flex items-center justify-between gap-2 text-secondary tabular-nums text-text-soft-400">
              <span className="truncate">{model.usage.used}</span>
              {model.usage.ends && <span className="shrink-0">{model.usage.ends}</span>}
            </div>
          </div>
        ) : (
          <Tooltip content={model.detail} whenTruncated warm={false}>
            <p id={detailId} data-card-detail className="m-0 mt-1 truncate text-secondary text-text-soft-400">{model.detail}</p>
          </Tooltip>
        )}
      </div>
      <div className="col-span-2 row-start-3 flex items-center justify-between gap-2 @min-[640px]/card:col-span-1 @min-[640px]/card:col-start-2 @min-[640px]/card:row-span-3 @min-[640px]/card:row-start-1 @min-[640px]/card:ml-6 @min-[640px]/card:flex-row-reverse @min-[640px]/card:self-center">
        {model.fix ? (
          <Button data-card-action="" variant="neutral" mode="stroke" size="3xsmall" isLoading={busy} onClick={() => run(model.fix!)}>
            {model.fix.label}
          </Button>
        ) : <span />}
        {model.more && <span data-card-more className="truncate text-secondary tabular-nums text-text-soft-400">{model.more}</span>}
      </div>
    </div>
  );
}
