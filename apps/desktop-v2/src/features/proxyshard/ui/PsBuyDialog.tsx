import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, DialogModal, cn } from "@proxyshard/shardx-ui-kit";
import { SelectField } from "../../../shared/ui/SelectField";
import { NumField } from "../../../shared/ui/NumField";
import { Field } from "../../../shared/ui/Field";
import { toast } from "../../../shared/model/toast";
import { LoadError } from "../../../shared/ui/ListStates";
import { confirmModal } from "../../../shared/model/confirm";
import { explainError } from "../../../shared/lib/errors";
import { fmtMoney } from "../../../shared/lib/format";
import { isDcIsp, availCode } from "../../../shared/lib/utils";
import { useT } from "../../../shared/i18n";
import type { PsOrder, PsProduct, PsCalc, PsBuyOption } from "../../../entities/proxyshard";
import { psProducts, psOrders, psAvailableCount, psCalculate, psPurchase, refreshAfterPurchase } from "../../../entities/proxyshard";

/** Typed fields (quantity, promo code) ask for a new price this long after the last key. */
const PRICE_DEBOUNCE_MS = 300;

/** The shop's reason for a refusal as one short sentence part: its own words,
 *  without a status prefix, markup or a closing stop; nothing when no word is
 *  left (a bare "502"). */
function shopReason(e: unknown): string | undefined {
  let line = explainError(e);
  if (!line) return undefined;
  // A JSON body that did not come with a plain message.
  if (line.startsWith("{")) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const m = [o.message, o.error, o.detail].find((v) => typeof v === "string" && v.trim());
      if (typeof m === "string") line = m;
    } catch { /* not JSON: shown as written */ }
  }
  line = line
    .replace(/<[^>]*>/g, " ")
    .replace(/^(?:error:\s*)?(?:\d{3}\s+[A-Za-z ]{2,30}:\s*)?/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,\s]+$/, "")
    .trim();
  if (!/\p{L}/u.test(line)) return undefined;
  // A long body is cut at a word; the full text would only be a wall under a field.
  if (line.length > 140) line = line.slice(0, 140).replace(/\s+\S*$/, "");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/// Buy a new order, in a dialog (craft target: no permanent buy form). DC/ISP
/// can be bought repeatedly (quantity + country); residential products can
/// only be owned once, so any already-owned tier is hidden here (top it up
/// from the Residential card instead). The products load when it opens (the
/// parent mounts it per opening). Nothing moves while it loads, fails or
/// prices (LAYOUT-18): the form keeps its room behind a state, the fields
/// flow in one grid, and Pay ends the footer. The price follows the form by
/// itself (owner, 2026-10-07: no Calculate button): any field changing asks
/// for it again, typed fields after a pause. The old price stays, marked
/// "Updating", and Pay waits for the new one, so no one pays an amount that
/// is not the form's. Only the newest answer counts. Whether a price is the
/// form's is read from the render (the price carries the form it answered),
/// never from a flag set after it: a field changed in the same task as
/// Enter leaves no moment when the old price still counts. After any
/// purchase answer, an error too (the shop may have charged), the account is
/// read again, and Pay waits for it.
export function PsBuyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [options, setOptions] = useState<PsBuyOption[]>([]);
  const [avail, setAvail] = useState<Record<string, number>>({});
  const [productName, setProductName] = useState("");
  const [cycle, setCycle] = useState("");
  const [country, setCountry] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [promo, setPromo] = useState("");
  const [autoRenew, setAutoRenew] = useState(false);
  const [buyP0f, setBuyP0f] = useState(false);
  // The price as last answered, with the form it answered for (`formKey`); kept
  // while the next is asked for, but it is the form's only while the keys match.
  // `promoRejected` marks a price asked for again without the promo code, because
  // the shop refused the form with it: the price is for the form minus the code.
  const [priced, setPriced] = useState<{ key: string; calc: PsCalc; promoRejected?: { reason?: string } } | null>(null);
  // The form an answer failed for, and the shop's reason, when it gave one.
  const [failed, setFailed] = useState<{ key: string; reason?: string } | null>(null);
  const [priceTry, setPriceTry] = useState(0);
  // The quantity field shows text that is not a number in range: the quantity
  // held here is then not what the field shows, and no price answers for it.
  const [qtyBad, setQtyBad] = useState(false);
  // Buying, and then reading the account again whatever the shop answered.
  const [buying, setBuying] = useState(false);
  const [buyFailed, setBuyFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    (async () => {
      setLoadError(null);
      try {
        const [prodRes, orderRes] = await Promise.all([
          psProducts(),
          psOrders({ status: "all", limit: 100 }),
        ]);
        // Already-owned product names (any status) — used to hide
        // single-purchase residential tiers from the buy list.
        const owned = new Set<string>((orderRes.orders ?? []).map((o: PsOrder) => o.product_name));
        // Collapse the per-location product rows into one option per name,
        // keeping the set of locations (DC/ISP country picker). Drop mobile,
        // and drop residential tiers already owned.
        const byName = new Map<string, PsBuyOption>();
        for (const p of (prodRes.products ?? []) as PsProduct[]) {
          if (/mobile/i.test(p.name)) continue;
          if (!isDcIsp(p.name) && owned.has(p.name)) continue;
          const o = byName.get(p.name) ?? { name: p.name, cycles: p.cycles ?? [], locations: [] };
          if (p.location && !o.locations.includes(p.location)) o.locations.push(p.location);
          byName.set(p.name, o);
        }
        const list = [...byName.values()];
        setOptions(list);
        if (list[0]) {
          setProductName(list[0].name);
          setCycle(list[0].cycles?.[0] ?? "");
          setCountry(isDcIsp(list[0].name) ? (list[0].locations[0] ?? "") : "");
        }
      } catch (e) { setLoadError(String(e)); }
      // available-count is best-effort (badge only).
      try {
        const arr = await psAvailableCount();
        const m: Record<string, number> = {};
        for (const a of (arr ?? []) as { country: string; product: string; amount: number }[]) {
          m[`${String(a.product).toLowerCase()}|${String(a.country).toUpperCase()}`] = a.amount;
        }
        setAvail(m);
      } catch { /* ignore */ }
      setReady(true);
    })();
  }, [attempt]);

  const product = useMemo(() => options.find((p) => p.name === productName) ?? null, [options, productName]);
  const needLocation = isDcIsp(productName);

  // The cycle and the location belong to the product: a new product starts on its first.
  const pickProduct = (name: string) => {
    const next = options.find((p) => p.name === name) ?? null;
    setProductName(name);
    setCycle(next?.cycles?.[0] ?? "");
    setCountry(next && isDcIsp(next.name) ? (next.locations[0] ?? "") : "");
  };

  const availForCountry = needLocation && country ? avail[`${availCode(productName)}|${country.toUpperCase()}`] : undefined;

  const buildBody = () => {
    const body: any = { product: productName };
    if (cycle) body.cycle = cycle;
    if (needLocation && country) body.location = country;
    if (quantity) body.quantity = quantity;
    if (promo.trim()) body.promo_code = promo.trim();
    if (autoRenew) body.auto_renewal = true;
    const addons = p0fAddons();
    if (addons) body.addons = addons;
    return body;
  };

  // p0f slots — one per proxy, only meaningful for DC/ISP. null when off.
  const p0fAddons = () => (needLocation && buyP0f ? [{ addon_key: "p0f_slots", qty: quantity }] : null);

  const fetchCalc = async (withPromo: boolean): Promise<PsCalc> => {
    const addons = p0fAddons();
    const r = await psCalculate({
      product: productName,
      location: needLocation ? country || null : null,
      cycle: cycle || null,
      quantity,
      promoCode: withPromo ? promo.trim() || null : null,
      addonsJson: addons ? JSON.stringify(addons) : null,
    });
    return {
      original_price: r.original_price ?? 0,
      final_price: r.final_price ?? 0,
      discount_percent: r.discount_percent ?? 0,
      addons_price: r.addons_price ?? 0,
      total_with_addons: r.total_with_addons,
    };
  };

  const showForm = ready && !loadError && options.length > 0;
  const needsPick = needLocation && !country;
  // Everything the price and the order depend on, as the form is now.
  const formKey = JSON.stringify([productName, cycle, country, quantity, promo.trim(), autoRenew, buyP0f]);
  // No price shows for a quantity the field does not show.
  const calc = qtyBad ? null : priced?.calc ?? null;
  const pricedHere = priced !== null && priced.key === formKey;
  const promoRejected = pricedHere ? priced.promoRejected : undefined;
  // The price is the form's: it answered for this very form, promo code and all.
  const fresh = pricedHere && !promoRejected && !qtyBad;
  const failedHere = failed !== null && failed.key === formKey ? failed : null;
  // Only a form that can be priced waits for a price (not while the shop loads, failed to load or is empty).
  const updating = showForm && !!productName && !needsPick && !qtyBad && !pricedHere && !failedHere;

  // Any field changing asks for the price again. Each asking has a number and
  // only the newest answer is used: a slow answer for an older form never
  // replaces the newer one.
  const asked = useRef(0);
  const before = useRef({ quantity, promo });
  useEffect(() => {
    if (!showForm || !productName) return;
    const mine = ++asked.current;
    const typed = before.current.quantity !== quantity || before.current.promo !== promo;
    before.current = { quantity, promo };
    if (needsPick) { setPriced(null); setFailed(null); return; }
    const key = formKey;
    const withPromo = promo.trim() !== "";
    const timer = setTimeout(async () => {
      try {
        const c = await fetchCalc(true);
        if (mine !== asked.current) return;
        setPriced({ key, calc: c });
        setFailed(null);
      } catch (e) {
        if (mine !== asked.current) return;
        const reason = shopReason(e);
        if (withPromo) {
          // Refused with a promo code: the same form once without it tells whether
          // the code is the reason. If it prices, the code is marked and the price
          // shown is the form's without it; if not, it is the form.
          try {
            const c = await fetchCalc(false);
            if (mine !== asked.current) return;
            setPriced({ key, calc: c, promoRejected: { reason } });
            setFailed(null);
          } catch (e2) {
            if (mine !== asked.current) return;
            setPriced(null);
            setFailed({ key, reason: shopReason(e2) ?? reason });
          }
          return;
        }
        // No price for this form: Pay has nothing to charge.
        setPriced(null);
        setFailed({ key, reason });
      }
    }, typed ? PRICE_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [showForm, productName, cycle, country, quantity, promo, autoRenew, buyP0f, priceTry]); // eslint-disable-line react-hooks/exhaustive-deps

  const buy = async () => {
    if (needLocation && !country) { toast.err(t("psBuyCard.pickLocationFirst")); return; }
    // Pay waits for the form's own price: never an amount the form does not show.
    if (!priced || !fresh || qtyBad || buying) return;
    // The question names the price and where it comes from (WRITE-21).
    const price = fmtMoney(priced.calc.total_with_addons ?? priced.calc.final_price);
    const ok = await confirmModal({
      title: t("psBuyCard.confirmTitle", { n: quantity, product: productName }),
      message: t("psBuyCard.confirmBody", { price }),
      confirmLabel: t("psBuyCard.payAction", { price }),
      alert: true,
    });
    if (ok !== true) return;
    setBuying(true);
    setBuyFailed(false);
    try {
      const r = await psPurchase(buildBody());
      toast.ok(r.message ? `${r.message}${r.order_id ? ` (#${r.order_id})` : ""}` : t("psBuyCard.orderPlaced"));
      // The balance, the orders, the plans and the usage read again, in place.
      void refreshAfterPurchase();
      onClose();
    } catch (e) {
      // An error or a timeout can come after the shop took the money: the
      // dialog stays, says so, and Pay waits until the account is read again.
      toast.fail({ title: t("psBuyCard.buyFailed"), detail: e });
      setBuyFailed(true);
      await refreshAfterPurchase();
    }
    finally { setBuying(false); }
  };

  const price = calc ? fmtMoney(calc.total_with_addons ?? calc.final_price) : null;
  const payLabel = price ? t("psBuyCard.payAction", { price }) : t("psBuyCard.buyAction");
  // Pay waits for the form's own price: not while it is asked for, and not without one.
  const payOff = buying || !productName || !ready || !!loadError || qtyBad || (!needsPick && !fresh);
  const state = !ready ? (
    <p className="m-0 text-secondary text-text-soft-400">{t("psBuyCard.loading")}</p>
  ) : loadError ? (
    <LoadError className="py-0" headingLevel={3} what={t("psStates.shop")} error={loadError} onRetry={() => { setReady(false); setAttempt((n) => n + 1); }} />
  ) : (
    <p className="m-0 text-secondary text-text-soft-400">{t("psBuyCard.emptyState")}</p>
  );

  return (
    <DialogModal
      open={open}
      onClose={onClose}
      size="md"
      title={t("psBuyCard.title")}
      dirty={promo.trim() !== ""}
      // Enter in a field buys too, with the value the field shows (C20a).
      onConfirm={() => void buy()}
      confirmLabel={payLabel}
      isDisabled={payOff}
      isLoading={buying}
      footer={
        <div className="flex w-full items-center gap-3">
          {/* The price slot is always there, so nothing moves when it fills (LAYOUT-18). */}
          <span data-ps-buy-price aria-live="polite" aria-busy={updating || undefined} className="me-auto inline-flex min-h-[30px] min-w-0 items-center gap-2 tabular-nums">
            {calc && (
              <>
                {calc.discount_percent > 0 && <span className="text-secondary text-text-soft-400 line-through">{fmtMoney(calc.original_price)}</span>}
                {/* The old price stays while the new is asked for, softer, with the word; one asked for again without a refused promo code is strong, with Pay held. */}
                <span className={cn("text-panel-title", pricedHere ? "text-text-strong-950" : "text-text-soft-400")}>{price}</span>
                {calc.discount_percent > 0 && <Badge color="success" size="small">-{calc.discount_percent}%</Badge>}
                {!!calc.addons_price && calc.addons_price > 0 && <span className="text-secondary text-text-soft-400">{t("psBuyCard.inclAddons", { price: fmtMoney(calc.addons_price) })}</span>}
              </>
            )}
            {updating && <span data-ps-buy-updating className="text-secondary text-text-soft-400">{t("psBuyCard.updating")}</span>}
            {failedHere && (
              <>
                {/* The shop's reason stays on screen, in the two lines the slot has room for. */}
                <span data-ps-buy-calc-failed className="line-clamp-2 min-w-0 text-secondary leading-[14px] text-text-soft-400">
                  {failedHere.reason ? t("psBuyCard.calcFailedWhy", { reason: failedHere.reason }) : t("psBuyCard.calcFailed")}
                </span>
                <Button variant="neutral" mode="ghost" size="2xsmall" className="shrink-0" onClick={() => { setFailed(null); setPriceTry((n) => n + 1); }}>{t("psBuyCard.calcRetry")}</Button>
              </>
            )}
          </span>
          {/* Last in the row: its trailing edge is the footer's from the first frame. */}
          <Button type="submit" variant="primary" mode="filled" size="xsmall" disabled={payOff} isLoading={buying}>
            {payLabel}
          </Button>
        </div>
      }
    >
      {/* The form keeps its room while a state stands in for it, so the
          dialog, and Pay, never move (LAYOUT-18). */}
      <div className="grid py-4">
        <div className={cn("col-start-1 row-start-1 flex flex-col gap-3", !showForm && "invisible")}>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label={t("psBuyCard.productLabel")}
              value={productName}
              onChange={pickProduct}
              options={options.map((p) => ({ value: p.name, label: p.name }))}
            />
            <SelectField
              label={t("psBuyCard.cycleLabel")}
              value={cycle}
              onChange={setCycle}
              placeholder="—"
              options={(product?.cycles?.length ? product.cycles : []).map((c) => ({ value: c, label: c }))}
            />
            {needLocation && (
              <SelectField
                label={availForCountry != null ? t("psBuyCard.locationAvailable", { n: availForCountry }) : t("psBuyCard.locationLabel")}
                value={country}
                onChange={setCountry}
                placeholder={t("psBuyCard.countryPlaceholder")}
                isSearchable
                searchPlaceholder={t("psBuyCard.searchLocations")}
                options={(product?.locations ?? []).map((l) => ({ value: l, label: l }))}
              />
            )}
            <NumField label={t("psBuyCard.quantityLabel")} value={quantity} min={1} onChange={setQuantity} onInvalid={setQtyBad} />
            <Field
              label={t("psBuyCard.promoLabel")}
              value={promo}
              onChange={setPromo}
              error={promoRejected ? (promoRejected.reason ? t("psBuyCard.promoFailedWhy", { reason: promoRejected.reason }) : t("psBuyCard.promoFailed")) : undefined}
            />
            <Checkbox
              label={t("psBuyCard.autoRenewLabel")}
              checked={autoRenew}
              onChange={(e) => setAutoRenew(e.target.checked)}
              wrapperClassName="self-end pb-2"
            />
          </div>
          {/* Only for Datacenter and ISP; its room stays for the others, so a
              product change moves nothing. */}
          <div className={cn(!needLocation && "invisible")}>
            <Checkbox
              label={quantity === 1 ? t("psBuyCard.p0fAddonOne") : t("psBuyCard.p0fAddonMany", { n: quantity })}
              checked={buyP0f}
              onChange={(e) => setBuyP0f(e.target.checked)}
            />
          </div>
          {buyFailed && <p role="alert" data-ps-buy-failed className="m-0 text-secondary text-error-text">{t("psBuyCard.checkBalance")}</p>}
        </div>
        {!showForm && <div className="col-start-1 row-start-1 flex items-center justify-center">{state}</div>}
      </div>
    </DialogModal>
  );
}
