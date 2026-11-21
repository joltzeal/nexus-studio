import { create } from "zustand";
import { PS_PLAN, PS_PROXY_TYPE } from "../model/constants";
import type { PlanUsage } from "./planTier";
import { psOrders, psProfileTraffic } from "../model/api";
import type { PsOrder, ResiType } from "../model/types";
import { usePsAccount } from "./usePsAccount";

/// The residential plans behind the proxies profiles use, for the Proxy
/// balance card on Profiles (the owner's overview redesign): how much
/// traffic is left and when each plan ends. Read when the Profiles page
/// first opens, quietly (a failure shows nothing here; the ProxyShard page
/// says it), then again in place (`refresh`): right after a buy, a top-up or
/// a renewal made in the app, and when the window comes back after five
/// minutes or more, so a plan changed elsewhere does not stay wrong for days.

const TIER_NAME: Record<ResiType, RegExp> = { standart: /standar[dt]/i, premium: /premium/i, unmetered: /unmetered|unlimited/i };
const CYCLE_DAYS: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 90, semiannually: 182, annually: 365, yearly: 365 };
const DAY = 86_400_000;

/** The tier's order that ends last (a renewal replaces an older one). */
function orderOf(orders: PsOrder[], tier: ResiType): PsOrder | null {
  const mine = orders.filter((o) => /resi/i.test(o.product_name) && TIER_NAME[tier].test(o.product_name));
  const ends = (o: PsOrder) => (o.expires_at ? Date.parse(o.expires_at) : 0);
  return mine.reduce<PsOrder | null>((a, b) => (!a || ends(b) > ends(a) ? b : a), null);
}

/** Resolves once the saved key is read and checked: whether it works. */
async function keyWorks(): Promise<boolean> {
  const account = usePsAccount.getState();
  await account.init();
  const settled = (s: ReturnType<typeof usePsAccount.getState>) => s.keyLoaded && s.status !== "checking";
  if (!settled(usePsAccount.getState())) {
    await new Promise<void>((done) => {
      const stop = usePsAccount.subscribe((s) => { if (settled(s)) { stop(); done(); } });
    });
  }
  return usePsAccount.getState().status === "ok";
}

/** Reads the plans of these tiers and of every residential order; none
 *  when there is no working key. A first read takes what it can get (an
 *  order list or a traffic read that fails leaves that part out); a
 *  `strict` one throws instead, so a refresh never swaps what shows for
 *  less. */
async function readPlans(usedTiers: ResiType[], strict: boolean): Promise<{ plans: PlanUsage[]; orders: PsOrder[] }> {
  if (!(await keyWorks())) return { plans: [], orders: [] };
  const orNull = <T,>(p: Promise<T>): Promise<T | null> => (strict ? p : p.catch(() => null));
  const orders: PsOrder[] = (await orNull(psOrders({ status: "all", limit: 100 })))?.orders ?? [];
  const tiers = (Object.keys(PS_PLAN) as ResiType[]).filter((tier) => usedTiers.includes(tier) || orderOf(orders, tier));
  const plans = await Promise.all(tiers.map(async (tier): Promise<PlanUsage> => {
    const order = orderOf(orders, tier);
    const endsAt = order?.expires_at ? Date.parse(order.expires_at) : null;
    const cycle = CYCLE_DAYS[order?.cycle_name?.toLowerCase() ?? ""] ?? 30;
    let traffic: { data?: number; data_remain?: number; data_spent?: number } | null = null;
    if (tier !== "unmetered") traffic = await orNull(psProfileTraffic(PS_PROXY_TYPE[tier]));
    const total = traffic && Number(traffic.data) > 0 ? Number(traffic.data) : null;
    return {
      tier,
      orderId: order?.order_id ?? null,
      productName: order?.product_name ?? null,
      total,
      remain: total !== null ? Number(traffic?.data_remain ?? 0) : null,
      spent: total !== null ? Number(traffic?.data_spent ?? 0) : null,
      endsAt: endsAt !== null && Number.isFinite(endsAt) ? endsAt : null,
      startedAt: endsAt !== null && Number.isFinite(endsAt) ? endsAt - cycle * DAY : null,
    };
  }));
  return { plans, orders };
}

/** The tiers of the last read, for a refresh; null before the first. */
let lastTiers: ResiType[] | null = null;
let reading = false;
/** A refresh asked for while a read was on its way: that read may have begun
 *  before the change, so one more follows it. */
let again = false;

export const usePsPlans = create<{
  status: "idle" | "loading" | "done";
  plans: PlanUsage[];
  /** Every order of the same read (the Usage section's datacenter and ISP
   *  plans, and whether a plan renews); none without a working key. */
  orders: PsOrder[];
  /** When the plans were last read (ms since the epoch); 0 before. */
  readAt: number;
  /** Reads the plans of these tiers (the ones proxies use) and of every residential order. */
  load: (usedTiers: ResiType[]) => Promise<void>;
  /** Reads them again in place, for the tiers of the last read: what shows
   *  stays until the answer is in, and a failed read changes nothing, so
   *  the card changes in place and never empties first. With `staleMs`,
   *  only when the last read is at least that old. Nothing before the
   *  first read; asked for while one is in flight (without `staleMs`), it
   *  reads again once that one ends. */
  refresh: (staleMs?: number) => Promise<void>;
}>((set, get) => ({
  status: "idle",
  plans: [],
  orders: [],
  readAt: 0,
  load: async (usedTiers) => {
    lastTiers = usedTiers;
    reading = true;
    set({ status: "loading" });
    try {
      set({ status: "done", ...(await readPlans(usedTiers, false)), readAt: Date.now() });
    } catch {
      set({ status: "done", plans: [], orders: [], readAt: Date.now() });
    } finally {
      reading = false;
      if (again) { again = false; void get().refresh(); }
    }
  },
  refresh: async (staleMs) => {
    if (lastTiers === null) return;
    if (staleMs !== undefined && (reading || Date.now() - get().readAt < staleMs)) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      set({ ...(await readPlans(lastTiers, true)), readAt: Date.now() });
    } catch {
      /* quiet: the card keeps what it shows */
    } finally {
      reading = false;
      if (again) { again = false; void get().refresh(); }
    }
  },
}));
