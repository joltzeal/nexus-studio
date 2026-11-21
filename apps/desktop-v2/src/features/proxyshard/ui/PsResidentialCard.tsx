import { useEffect, useRef, useState } from "react";
import { Button, Card, IconButton, Menu, Tooltip, cn, useLatched } from "@proxyshard/shardx-ui-kit";
import { ChevronDownIcon, RegenerateIcon } from "../../../shared/icons";
import { StatValue } from "../../../shared/ui/Stat";
import { useT } from "../../../shared/i18n";
import { toast } from "../../../shared/model/toast";
import { fmtDay } from "../../../shared/lib/utils";
import { fmtBytes } from "../../../shared/lib/format";
import { useDialogLife } from "../../../shared/lib/useDialogLife";
import { storeBus } from "../../../shared/lib/storeBus";
import type { PsOrder, ResiType } from "../../../entities/proxyshard";
import { psProfileTraffic, psOrders, psRenew, refreshAfterPurchase } from "../../../entities/proxyshard";
import { PsTopupModal } from "./PsTopupModal";
import { PsResiGenerator } from "./PsResiGenerator";

const TYPE_KEY = "shardx.psResiPlan";
function readType(): ResiType {
  try {
    const v = localStorage.getItem(TYPE_KEY);
    if (v === "standart" || v === "premium" || v === "unmetered") return v;
  } catch { /* storage blocked */ }
  return "standart";
}

/// Residential tile (the third top tile): tier toggle (Standard / Premium / Unmetered), metered
/// traffic for Standard/Premium as one line over the bar (CRAFT-22), in-place
/// top-up (the Buy traffic button, which says what it does), and the relay
/// proxy generator. Unmetered is a flat plan, so it skips the GB meter. It
/// reads its own traffic and orders, and again when the account changes
/// (a buy, a top-up or a renewal elsewhere: the "proxyshard" event).
export function PsResidentialTile() {
  const t = useT();
  const [type, setType] = useState<ResiType>(readType);
  const planRef = useRef<HTMLButtonElement>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const pickType = (v: ResiType) => {
    setType(v);
    try { localStorage.setItem(TYPE_KEY, v); } catch { /* private mode: until reload */ }
  };
  const [data, setData] = useState<{ data: number; data_remain: number; data_spent: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [orders, setOrders] = useState<PsOrder[]>([]);
  const [topup, setTopup] = useState<PsOrder | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  // Each stays mounted through its exit (FEEL-01); Top up keeps the order it opened on.
  const topupLife = useDialogLife(topup != null);
  const topupShown = useLatched(topup);
  const genLife = useDialogLife(genOpen);
  const [renewing, setRenewing] = useState(false);

  // The last read wins: an answer for a tier already left never lands. A
  // `quiet` one (the account changed) keeps what shows until the answer is in.
  const trafficRead = useRef(0);
  const loadTraffic = async (t: ResiType, quiet = false) => {
    const mine = ++trafficRead.current;
    if (!quiet) {
      setData(null);
      setErr("");
    }
    if (t === "unmetered") { setLoading(false); return; } // flat plan — no GB meter
    if (!quiet) setLoading(true);
    try {
      const r = await psProfileTraffic(t);
      if (mine !== trafficRead.current) return;
      setData({ data: r.data ?? 0, data_remain: r.data_remain ?? 0, data_spent: r.data_spent ?? 0 });
      setErr("");
    } catch (e) { if (mine === trafficRead.current && !quiet) setErr(String(e)); }
    finally { if (mine === trafficRead.current) setLoading(false); }
  };
  useEffect(() => { loadTraffic(type); }, [type]);
  // Orders back the top-up / renew targets (need an order id).
  const loadOrders = () =>
    psOrders({ status: "all", limit: 100 })
      .then((r) => setOrders(r.orders ?? []))
      .catch(() => {});
  useEffect(() => { loadOrders(); }, []);
  // The account changed (a buy, a top-up, a renewal): both read again, in place.
  const typeNow = useRef(type);
  typeNow.current = type;
  useEffect(() => {
    const off = storeBus.on("proxyshard", () => { void loadOrders(); void loadTraffic(typeNow.current, true); });
    return () => { off(); };
  }, []);

  // The word order of the product name is not fixed ("Residential Premium" in the shop, "Standart Residential" seen
  // elsewhere), so a name is matched by its tier word and "resi", either way round (as the plans store does).
  const tierWord = { standart: /standar[dt]/i, premium: /premium/i, unmetered: /unmetered|unlimited/i }[type];
  const order = orders.find((o) => /resi/i.test(o.product_name) && tierWord.test(o.product_name)) ?? null;

  const renew = async () => {
    if (!order) return;
    setRenewing(true);
    try {
      await psRenew(order.order_id);
      toast.ok(t("psResidentialCard.renewedOrder", { id: order.order_id }));
      // The balance, the plans (and the Proxy balance card on Profiles) and this tile read again.
      void refreshAfterPurchase();
    } catch (e) { toast.fail({ title: t("psOrdersCard.renewFailed", { id: order.order_id }), detail: e }); }
    finally { setRenewing(false); }
  };
  const pct = data && data.data > 0 ? Math.min(100, Math.round((data.data_spent / data.data) * 100)) : 0;

  const tierItems: { value: ResiType; label: string }[] = [
    { value: "standart", label: t("psResidentialCard.tierStandard") },
    { value: "premium", label: t("psResidentialCard.tierPremium") },
    { value: "unmetered", label: t("psResidentialCard.tierUnmetered") },
  ];
  const tierName = tierItems.find((i) => i.value === type)!.label;
  // Buying traffic is the tile's main way to spend money: a secondary button with its
  // word, not a bare "+" (owner, 2026-10-07: too easy to miss).
  const addTraffic = type !== "unmetered"
    ? <Button variant="neutral" mode="stroke" size="2xsmall" data-tour="buy-traffic" disabled={!order} onClick={() => order && setTopup(order)}>{t("psResidentialCard.buyTraffic")}</Button>
    : <Button variant="neutral" mode="ghost" size="2xsmall" data-tour="buy-traffic" disabled={!order || renewing} isLoading={renewing} onClick={renew}>
        {renewing ? t("psResidentialCard.renewing") : t("psResidentialCard.renew")}
      </Button>;
  const addHint = order ? undefined : type !== "unmetered" ? t("psResidentialCard.noResiOrderHint") : t("psResidentialCard.noUnmeteredOrderHint");

  return (
    <Card data-ps-card="residential" data-ps-tile="residential" padding="none" className="@container/tile relative flex min-w-0 flex-col gap-[4px] overflow-hidden p-[16px]">
      <div className="flex h-[24px] items-center justify-between gap-[6px]">
        <div className="flex min-w-0 items-center gap-[2px]">
          <span className="truncate text-secondary text-text-soft-400">{t("psResidentialCard.title")}</span>
          <Button
            ref={planRef}
            variant="neutral"
            mode="ghost"
            size="2xsmall"
            aria-label={t("psResidentialCard.tierLabel")}
            aria-haspopup="menu"
            aria-expanded={planOpen}
            rightIcon={<ChevronDownIcon className="size-3.5" />}
            onClick={() => setPlanOpen((o) => !o)}
          >
            {tierName}
          </Button>
          <Menu
            open={planOpen}
            onOpenChange={setPlanOpen}
            anchor={planRef}
            aria-label={t("psResidentialCard.tierLabel")}
            items={tierItems.map((i) => ({ type: "radio" as const, label: i.label, checked: i.value === type, onSelect: () => pickType(i.value) }))}
          />
        </div>
        <div className="flex shrink-0 items-center gap-[2px]">
          {addHint ? <Tooltip content={addHint}><span className="inline-flex">{addTraffic}</span></Tooltip> : addTraffic}
          {/* Too narrow for the word (it shares the row with Buy traffic): the icon alone, still named and with a tooltip. */}
          <span className="hidden @min-[400px]/tile:inline-flex">
            <Button variant="primary" mode="filled" size="2xsmall" onClick={() => setGenOpen(true)}>
              {t("psResidentialCard.generateProxies")}
            </Button>
          </span>
          <span className="inline-flex @min-[400px]/tile:hidden">
            <IconButton variant="primary" mode="filled" icon={<RegenerateIcon className="size-3.5" />} label={t("psResidentialCard.generateProxies")} size="2xsmall" onClick={() => setGenOpen(true)} />
          </span>
        </div>
      </div>

      <div data-ps-traffic className="min-h-[26px]">
        {type === "unmetered" ? (
          <StatValue size="sm" value={t("psResidentialCard.unlimited")} unit={order?.expires_at ? t("psResidentialCard.unlimitedExpires", { date: fmtDay(order.expires_at) }) : undefined} />
        ) : data && !loading ? (
          <StatValue size="sm" value={fmtBytes(data.data_spent)} unit={t("psResidentialCard.usedOf", { total: fmtBytes(data.data) })} />
        ) : (
          <p className="m-0 truncate pt-[3px] text-secondary text-text-soft-400">{loading ? t("psResidentialCard.loading") : err}</p>
        )}
      </div>

      {type !== "unmetered" && data && !loading && (
        <div
          role="progressbar"
          aria-label={t("psResidentialCard.trafficBar")}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          data-ps-bar
          className="absolute inset-x-0 bottom-0 h-[4px] bg-bg-sunken forced-colors:border-t forced-colors:border-[CanvasText]"
        >
          {/* Forced colors paint both Canvas: the fill keeps the system's Highlight. */}
          <div className={cn("h-full forced-colors:forced-color-adjust-none forced-colors:bg-[Highlight]", pct > 90 ? "bg-error-base" : pct > 70 ? "bg-warning-base" : "bg-primary-base")} style={{ width: `${pct}%` }} />
        </div>
      )}

      {topupLife.mounted && topupShown && (
        <PsTopupModal key={topupLife.session} open={topup != null} order={topupShown} onClose={() => setTopup(null)} onDone={() => setTopup(null)} />
      )}
      {genLife.mounted && <PsResiGenerator key={genLife.session} open={genOpen} type={type} onClose={() => setGenOpen(false)} />}
    </Card>
  );
}
