import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Card, IconButton, ProgressBar, Select, cn } from "@proxyshard/shardx-ui-kit";
import { RefreshIcon } from "../../shared/icons";
import { appLocale, useT } from "../../shared/i18n";
import { fmtDay } from "../../shared/lib/utils";
import { NBSP, fmtBytes, fmtBytesParts, fmtCompact, fmtCount } from "../../shared/lib/format";
import { useNow } from "../../shared/lib/useNow";
import { LineChart, NoDataGhost, Sparkline, type ChartTick } from "../../shared/ui/charts";
import { StatValue, type TrendPolarity } from "../../shared/ui/Stat";
import {
  hasHistory, isLifetime, sumSeries, totalOf, trendOf, usePsPlans, usePsUsage,
  type PlanUsage, type PsOrder, type PsUsageRange, type PsUsageSeries,
} from "../../entities/proxyshard";

/// The ProxyShard page's Usage section (owner, "more air, clearer
/// hierarchy"). Row one: Traffic used with the big chart over two columns;
/// the third holds "Left on {plan}" and "Plan ends", stacked to the chart
/// card's height. Then Requests, Failed requests and a card per other plan.
/// Owner fix: no card stretches into empty space. Every card carries a
/// chart, a bar or the No data ghost, so a row's cards are one height by
/// their content; in row one the chart grows to the stacked pair's height.
/// And no card sits alone in a row (controller, after the first shots): the
/// lower cards take as many columns as there are cards, as many as fit at
/// 220 px (up to six on a wide window), and more split into even rows (5 as
/// 3 and 2 where four fit). From 640 px of room; from 400 two columns, where
/// an odd last card spans both; then one.
/// Never a number the app does not know (controller): a plan or order whose
/// usage is unknown shows what it sells (its IPs) or its days left; a card
/// with no number at all says when one will come, over the No data ghost.

const DAY = 86_400_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** Other plans past this many stay off: an account with thirty orders would
 *  otherwise get a wall of thirty cards. */
const MAX_OTHER_PLANS = 4;

/** A number with at most one decimal ("2.4", "800"), grouped as fmtCount does. */
const oneDecimal = (v: number) => fmtCount(Math.round(v * 10) / 10);

/** The x labels: every 6 hours, every day, or every week, each at the data
 *  point that opens it (the first bucket at or after the boundary), plus the
 *  range's opening label at its first point (its hour or day), which the
 *  chart shows only where it fits. */
function ticksOf(range: PsUsageRange, from: number, step: number, n: number): ChartTick[] {
  const end = from + step * (n - 1);
  const locale = appLocale();
  const hour = new Intl.DateTimeFormat(locale, { hour: "numeric" });
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const fmt = range === "24h" ? hour : day;
  const at = (ms: number) => Math.ceil((ms - from) / step - 1e-9);
  const out: ChartTick[] = [{ at: 0, label: fmt.format(new Date(from)), first: true }];
  const d = new Date(from);
  if (range === "24h") {
    d.setMinutes(0, 0, 0);
    while (d.getHours() % 6 !== 0 || d.getTime() <= from) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= end; d.setHours(d.getHours() + 6)) out.push({ at: at(d.getTime()), label: hour.format(d) });
  } else {
    d.setHours(0, 0, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    const every = range === "7d" ? 1 : 7;
    for (; d.getTime() <= end; d.setDate(d.getDate() + every)) out.push({ at: at(d.getTime()), label: day.format(d) });
  }
  // A boundary that lands on the first point is the opening label itself.
  return out.filter((t, i) => i === 0 || t.at > 0);
}

/** A range's words: its name, the period the trend compares with, and the
 *  span a chart's name gives. */
function rangeWords(t: ReturnType<typeof useT>, range: PsUsageRange) {
  if (range === "24h") return { label: t("psUsage.range24h"), compared: t("psUsage.compared24h"), span: t("psUsage.span24h") };
  if (range === "30d") return { label: t("psUsage.range30d"), compared: t("psUsage.compared30d"), span: t("psUsage.span30d") };
  return { label: t("psUsage.range7d"), compared: t("psUsage.compared7d"), span: t("psUsage.span7d") };
}

/** A residential plan's name when its order has none. */
function tierName(t: ReturnType<typeof useT>, p: PlanUsage): string {
  if (p.productName) return p.productName;
  return p.tier === "premium" ? t("psUsage.tierPremium") : p.tier === "unmetered" ? t("psUsage.tierUnmetered") : t("psUsage.tierStandard");
}

/** Cards into rows of at most `max`, as even as they go: 5 as 3 and 2, 7 as 4 and 3. */
function evenRows<T>(items: T[], max: number): T[][] {
  const rows: T[][] = [];
  const count = Math.ceil(items.length / max);
  for (let r = 0, i = 0; r < count; r++) {
    const k = Math.ceil((items.length - i) / (count - r));
    rows.push(items.slice(i, i + k));
    i += k;
  }
  return rows;
}

/** The metered plan with the most traffic, else the first: the one "Left on" names. */
function mainPlan(plans: PlanUsage[]): PlanUsage | null {
  const metered = plans.filter((p) => p.total !== null);
  return metered.reduce<PlanUsage | null>((a, b) => (!a || (b.total ?? 0) > (a.total ?? 0) ? b : a), null) ?? plans[0] ?? null;
}

/** Row two's cards per row: as many as give each at least 220 px (6 at most,
 *  2 at least), from the section's own unzoomed width; read before the first
 *  paint, so the cards never land in rows of 4 first. */
function useRowMax() {
  const ref = useRef<HTMLElement>(null);
  const [max, setMax] = useState(4);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setMax(Math.max(2, Math.min(6, Math.floor((el.offsetWidth + 12) / (220 + 12)))));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, max] as const;
}

export function PsUsage() {
  const [sectionRef, rowMax] = useRowMax();
  const t = useT();
  const titleId = useId();
  const range = usePsUsage((s) => s.range);
  const status = usePsUsage((s) => s.status);
  const data = usePsUsage((s) => s.data);
  const plans = usePsPlans((s) => s.plans);
  const orders = usePsPlans((s) => s.orders);
  const now = useNow();
  useEffect(() => {
    // The plans come from the read the Profiles page makes; opened here
    // first, this page makes it. The history is read again on each visit,
    // in place.
    if (usePsPlans.getState().status === "idle") void usePsPlans.getState().load([]);
    void usePsUsage.getState().load();
  }, []);

  const loading = status !== "done";
  const { label: rangeLabel, compared, span } = rangeWords(t, range);

  // Row one.
  const main = mainPlan(plans);
  const mainOrder = main ? orders.find((o) => o.order_id === main.orderId) ?? null : null;
  const traffic = data ? sumSeries(Object.values(data.traffic)) : null;
  const left = main && main.total !== null && main.remain !== null && main.spent !== null ? leftOnFacts(t, main, tierName(t, main), now) : null;
  const ends = main && main.endsAt !== null ? planEndsFacts(t, main, mainOrder, now) : null;
  // Both: stacked beside the chart. One alone would sit shorter than the
  // chart, so it joins the lower cards instead, drawn as they are (its
  // plan's traffic as its small chart).
  const stacked = !!left && !!ends;

  // Row two: the other residential plans. Datacenter and ISP orders have no
  // traffic limit, so they have no usage to show and no card here. Without
  // history a plan shows what its plan data says it used this period, or
  // else its days left; never a made-up amount.
  const daysTo = (ms: number) => Math.max(0, Math.ceil((ms - now) / DAY));
  const others: { key: string; name: string; series: PsUsageSeries | null; known: { value: string; unit: string } | null; sub: string }[] = plans
    .filter((p) => p !== main)
    .map((p) => ({
      key: p.tier,
      name: tierName(t, p),
      series: data?.traffic[p.tier] ?? null,
      known: p.spent !== null ? fmtBytesParts(p.spent) : p.endsAt !== null ? daysParts(t, daysTo(p.endsAt)) : null,
      sub: p.total !== null && p.remain !== null ? t("psUsage.leftOf", { left: fmtBytes(p.remain), total: fmtBytes(p.total) }) : t("psUsage.unmetered"),
    }))
    .slice(0, MAX_OTHER_PLANS);

  const requests = hasHistory(data?.requests) ? data!.requests : null;
  const failed = hasHistory(data?.failed) ? data!.failed : null;
  const reqTotal = requests ? totalOf(requests) : null;
  const failTotal = failed ? totalOf(failed) : null;
  const rate = reqTotal && failTotal !== null ? (failTotal / reqTotal) * 100 : null;
  const prevRate = requests?.previous && failed?.previous !== null && failed?.previous !== undefined ? (failed.previous / requests.previous) * 100 : null;
  const reqTrend = requests && reqTotal !== null ? trendOf(reqTotal, requests.previous) : null;
  const rateTrend = rate !== null ? trendOf(rate, prevRate) : null;

  // The lower cards: a lone side card first, then Requests, Failed requests
  // and the other plans.
  const mainSeries = main ? data?.traffic[main.tier] ?? null : null;
  const lone = stacked ? null : left ?? ends;
  const lower: SparkProps[] = [
    ...(lone ? [{ id: lone === left ? "left" : "ends", label: lone.label, value: lone.value, unit: lone.unit, sub: lone.sub, series: mainSeries, trend: null, polarity: "neutral" as const, pending: false }] : []),
    { id: "requests", label: t("psUsage.requests"), series: requests, value: reqTotal !== null ? fmtCompact(reqTotal) : null, trend: reqTrend, polarity: "neutral", sub: rangeLabel, pending: loading },
    {
      id: "failed", label: t("psUsage.failed"), series: rate !== null ? failed : null, value: rate !== null ? oneDecimal(rate) : null, unit: "%", trend: rateTrend, polarity: "downGood",
      sub: rate !== null ? t("psUsage.failedOf", { failed: fmtCompact(failTotal!), total: fmtCompact(reqTotal!) }) : rangeLabel,
      pending: loading,
    },
    ...others.map((o): SparkProps => {
      const total = hasHistory(o.series) ? totalOf(o.series) : null;
      const shown = total !== null ? fmtBytesParts(total) : o.known;
      return {
        id: o.key, label: o.name, series: o.series, sub: o.sub, polarity: "neutral",
        value: shown?.value ?? null, unit: shown?.unit,
        trend: hasHistory(o.series) && total !== null ? trendOf(total, o.series.previous) : null,
        pending: loading,
      };
    }),
  ];

  const trafficTotal = traffic ? totalOf(traffic) : null;
  // Without history: what the plans report used this period, if any does.
  const planUsed = plans.filter((p) => p.spent !== null);
  const planSum = planUsed.length > 0 ? planUsed.reduce((a, p) => a + (p.spent ?? 0), 0) : null;
  const trafficTrend = traffic && trafficTotal !== null ? trendOf(trafficTotal, traffic.previous) : null;
  const peak = traffic ? Math.max(0, ...traffic.points) : 0;
  const chartUnit = peak >= GB ? { div: GB, unit: "GB" } : { div: MB, unit: "MB" };

  return (
    <section ref={sectionRef} data-ps-usage aria-labelledby={titleId} className="@container flex flex-col gap-[12px]">
      <div className="flex min-h-[30px] items-center justify-between gap-3">
        <h2 id={titleId} className="m-0 text-section-title text-text-strong-950">{t("psUsage.title")}</h2>
        <div className="flex items-center gap-2">
          <div className="w-[140px]">
            <Select
              size="xsmall"
              aria-label={t("psUsage.rangeLabel")}
              value={range}
              onChange={(v) => usePsUsage.getState().setRange(v as PsUsageRange)}
              options={(["24h", "7d", "30d"] as const).map((r) => ({ value: r, label: rangeWords(t, r).label }))}
            />
          </div>
          <IconButton
            variant="neutral" mode="stroke" size="2xsmall"
            icon={<RefreshIcon className="size-3.5" />}
            label={t("psUsage.refresh")}
            onClick={() => { void usePsUsage.getState().load(); void usePsPlans.getState().refresh(); }}
          />
        </div>
      </div>
      <div data-usage-grid aria-busy={loading || undefined} className="grid grid-cols-1 gap-[12px] @min-[400px]:grid-cols-2 @min-[640px]:grid-cols-3">
        <UsageCard id="traffic" label={t("psUsage.trafficUsed")} className={cn("@min-[400px]:col-span-2", !stacked && "@min-[640px]:col-span-3")}>
          {loading ? <><StatSlot /><Sub>{rangeLabel}</Sub></> : trafficTotal !== null || planSum !== null ? (
            <>
              <StatValue
                value={fmtBytesParts(trafficTotal ?? planSum!).value}
                unit={fmtBytesParts(trafficTotal ?? planSum!).unit}
                trend={trafficTrend}
                polarity="neutral"
              />
              <Sub>{trafficTotal === null ? t("psUsage.planPeriodUsed") : trafficTrend !== null ? compared : rangeLabel}</Sub>
            </>
          ) : <p data-not-reported className="m-0 text-secondary text-pretty text-text-soft-400">{t("psUsage.notReported")}</p>}
          <div className="mt-[10px] flex flex-1 flex-col">
            {traffic && data ? (
              <LineChart
                className="flex-1"
                points={traffic.points.map((v) => v / chartUnit.div)}
                ticks={ticksOf(range, data.from, data.step, traffic.points.length)}
                formatValue={(v) => `${oneDecimal(v)}${NBSP}${chartUnit.unit}`}
                label={t("psUsage.chartLabel", { span, peak: fmtBytes(peak) })}
              />
            ) : loading ? <div className="min-h-[140px] flex-1" /> : <NoDataGhost tall label={t("psUsage.noData")} />}
          </div>
        </UsageCard>
        {stacked && (
          // Each card its own content's height, from the column's top: a card
          // never stretches into empty space (owner). The chart card takes the
          // stack's height, so the two columns end together.
          <div className="contents @min-[640px]:grid @min-[640px]:grid-rows-[auto_auto] @min-[640px]:content-start @min-[640px]:gap-[12px]">
            <LeftOnCard facts={left!} />
            <PlanEndsCard facts={ends!} />
          </div>
        )}
      </div>
      {lower.length > 0 && (
        <div data-usage-rows aria-busy={loading || undefined} className="grid grid-cols-1 gap-[12px] @min-[400px]:grid-cols-2 @min-[640px]:flex @min-[640px]:flex-col">
          {evenRows(lower, rowMax).map((row, r) => (
            <div
              key={r}
              data-usage-row
              className="contents @min-[640px]:grid @min-[640px]:gap-[12px]"
              style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
            >
              {row.map((c) => (
                <SparkCard
                  key={c.id}
                  {...c}
                  span={span}
                  // Two columns: an odd last card spans both, never beside an empty cell.
                  className={lower.length % 2 === 1 && c === lower.at(-1) ? "@min-[400px]:col-span-2 @min-[640px]:col-span-1" : undefined}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** One card: 20 px of air, the soft label on top. */
function UsageCard({ id, label, className, children }: { id: string; label: string; className?: string; children: ReactNode }) {
  return (
    <Card data-usage-card={id} padding="none" className={cn("flex min-w-0 flex-col gap-[4px] p-[20px]", className)}>
      <div className="truncate text-secondary text-text-soft-400">{label}</div>
      {children}
    </Card>
  );
}

/** A secondary fact under a number: one soft line, cut rather than wrapped,
 *  so a row's cards keep one height. */
function Sub({ tone, children }: { tone?: "warning"; children: ReactNode }) {
  return <div className={cn("truncate text-secondary tabular-nums", tone === "warning" ? "text-warning-text" : "text-text-soft-400")}>{children}</div>;
}

type SparkProps = {
  id: string;
  label: string;
  series: PsUsageSeries | null | undefined;
  value: string | null;
  unit?: string;
  trend: number | null;
  polarity: TrendPolarity;
  sub: string;
  /** Its number is still being read: its place is held. */
  pending: boolean;
};

/** A small card: its number, one line under it and its small chart. With
 *  no number at all (`value` null) it says when one will come, and the No
 *  data ghost takes the rest of the card, so it matches its row's height. */
function SparkCard({ id, label, series, span, value, unit, trend, polarity, sub, pending, className }: SparkProps & {
  span: string;
  className?: string;
}) {
  const t = useT();
  if (!pending && value === null) {
    return (
      <UsageCard id={id} label={label} className={cn("overflow-hidden", className)}>
        {/* Its one line may take two in a narrow card: cut, it would not say when. */}
        <p data-not-reported className="m-0 text-secondary text-pretty text-text-soft-400">{t("psUsage.notReported")}</p>
        {/* Edge to edge and flush on the card's foot (owner): the card's 20 px of padding is cancelled. */}
        <div className="-mx-[20px] -mb-[20px] mt-[10px] flex min-h-[84px] flex-1 flex-col"><NoDataGhost fill label={t("psUsage.noData")} /></div>
      </UsageCard>
    );
  }
  return (
    <UsageCard id={id} label={label} className={cn("overflow-hidden", className)}>
      {pending ? <StatSlot /> : <StatValue value={value} unit={unit} trend={trend} polarity={polarity} />}
      <Sub>{sub}</Sub>
      <div className="-mx-[20px] -mb-[20px] mt-[10px]">
        {hasHistory(series)
          ? <Sparkline bleed points={series.points} label={t("psUsage.sparkLabel", { name: label, span })} />
          : pending ? <div className="h-[84px]" /> : <NoDataGhost label={t("psUsage.noData")} />}
      </div>
    </UsageCard>
  );
}

/** The number's place while it is read: its height, nothing drawn. */
function StatSlot() {
  return <div aria-hidden className="h-[32px]" />;
}

/** Days as a stat: "27" days, "1" day. */
function daysParts(t: ReturnType<typeof useT>, n: number): { value: string; unit: string } {
  return { value: fmtCount(n), unit: n === 1 ? t("psUsage.day") : t("psUsage.days") };
}

/** A side card's facts; `bar` only for "Left on" (the plan's traffic). */
type SideFacts = { label: string; value: string; unit: string; sub: string; bar?: { value: number; label: string; color: "gray" | "warning" | "error" }; line: string; warning: boolean };

/** "Left on {plan}": what is left, the bar of what is used, and the burn
 *  line: when the traffic runs out at the rate so far, if before the plan
 *  ends; otherwise the rate itself. */
function leftOnFacts(t: ReturnType<typeof useT>, plan: PlanUsage, name: string, now: number): SideFacts {
  const total = plan.total!;
  const remain = plan.remain!;
  const spent = plan.spent!;
  const pct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 0;
  const daysIn = plan.startedAt !== null ? (now - plan.startedAt) / DAY : 0;
  const perDay = daysIn >= 1 && spent > 0 ? spent / daysIn : null;
  const runsOutIn = perDay ? Math.floor(remain / perDay) : null;
  const endsIn = plan.endsAt !== null ? Math.ceil((plan.endsAt - now) / DAY) : null;
  const short = runsOutIn !== null && (endsIn === null || runsOutIn < endsIn);
  const parts = fmtBytesParts(remain);
  return {
    label: t("psUsage.leftOn", { plan: name }),
    ...parts,
    sub: t("psUsage.usedOf", { used: fmtBytes(spent), total: fmtBytes(total) }),
    bar: { value: pct, label: t("psUsage.trafficBar"), color: pct > 90 ? "error" : pct > 70 ? "warning" : "gray" },
    line: short
      ? (runsOutIn! <= 1 ? t("psUsage.runsOutDay") : t("psUsage.runsOut", { n: runsOutIn! }))
      : perDay ? t("psUsage.perDay", { amount: fmtBytes(perDay) }) : t("psUsage.nothingUsed"),
    warning: short,
  };
}

/** "Plan ends": the days left, the date, and whether it renews. No bar: one
 *  beside the traffic bar read as a second traffic bar (owner). A plan with
 *  no end says "Lifetime" and nothing of days, a date or renewal (owner): the
 *  date the API gives it (2125) is no end. */
function planEndsFacts(t: ReturnType<typeof useT>, plan: PlanUsage, order: PsOrder | null, now: number): SideFacts {
  if (isLifetime(plan, now)) {
    return { label: t("psUsage.plan"), value: t("psUsage.lifetime"), unit: "", sub: t("psUsage.lifetimeSub"), line: "", warning: false };
  }
  const endsAt = plan.endsAt!;
  const days = Math.max(0, Math.ceil((endsAt - now) / DAY));
  const date = fmtDay(new Date(endsAt).toISOString());
  return {
    label: t("psUsage.planEnds"),
    value: fmtCount(days),
    unit: days === 1 ? t("psUsage.day") : t("psUsage.days"),
    sub: endsAt > now ? t("psUsage.endsOn", { date }) : t("psUsage.endedOn", { date }),
    line: order?.auto_renewal === true ? t("psUsage.renews")
      : order?.auto_renewal === false ? t("psUsage.noRenew")
      : plan.startedAt !== null ? t("psUsage.started", { date: fmtDay(new Date(plan.startedAt).toISOString()) })
      : t("psUsage.noRenewInfo"),
    warning: false,
  };
}

/** A stacked side card: its number, its fact, a bar where it has one, and
 *  one more line, which keeps to the card's foot so the content reaches it
 *  when the column gives the card more height than its own. */
function SideCard({ id, facts: f }: { id: string; facts: SideFacts }) {
  return (
    <UsageCard id={id} label={f.label}>
      <StatValue value={f.value} unit={f.unit} />
      <Sub>{f.sub}</Sub>
      {f.bar && <ProgressBar className="mt-[10px]" aria-label={f.bar.label} value={f.bar.value} color={f.bar.color} />}
      <div className="mt-auto pt-[8px]"><Sub tone={f.warning ? "warning" : undefined}>{f.line}</Sub></div>
    </UsageCard>
  );
}

const LeftOnCard = ({ facts }: { facts: SideFacts }) => <SideCard id="left" facts={facts} />;
const PlanEndsCard = ({ facts }: { facts: SideFacts }) => <SideCard id="ends" facts={facts} />;
