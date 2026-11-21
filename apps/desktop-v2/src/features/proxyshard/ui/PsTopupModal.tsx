import { useState } from "react";
import { DialogModal } from "@proxyshard/shardx-ui-kit";
import { NumField } from "../../../shared/ui/NumField";
import { Field } from "../../../shared/ui/Field";
import { toast } from "../../../shared/model/toast";
import { useT } from "../../../shared/i18n";
import type { PsOrder } from "../../../entities/proxyshard";
import { psAddBandwidth, refreshAfterPurchase } from "../../../entities/proxyshard";

export function PsTopupModal({ open, order, onClose, onDone }: { open: boolean; order: PsOrder; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [amount, setAmount] = useState(5);
  const [promo, setPromo] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    if (amount < 1) { toast.err(t("psTopupModal.amountTooSmall")); return; }
    setBusy(true);
    setFailed(false);
    try {
      await psAddBandwidth(order.order_id, amount, promo.trim() || null);
      toast.ok(t("psTopupModal.addedToast", { n: amount, id: order.order_id }));
      // The balance, the plans (and the Proxy balance card on Profiles) and the tile's traffic read again.
      void refreshAfterPurchase();
      onDone();
    } catch (e) {
      // An error or a timeout can come after the shop took the money: say so, and
      // the button waits until the account is read again.
      toast.fail({ title: t("psTopupModal.failed", { id: order.order_id }), detail: e });
      setFailed(true);
      await refreshAfterPurchase();
    }
    finally { setBusy(false); }
  };
  return (
    <DialogModal
      open={open}
      onClose={onClose}
      title={t("psTopupModal.title")}
      subtitle={t("psTopupModal.subtitle", { product: order.product_name, id: order.order_id })}
      confirmLabel={busy ? t("psTopupModal.buying") : t("psTopupModal.buyAmount", { n: amount })}
      onConfirm={submit}
      isLoading={busy}
      cancelLabel={t("psTopupModal.cancel")}
      onCancel={onClose}
      footerNote={failed ? t("psTopupModal.checkBalance") : undefined}
    >
      <div className="flex flex-col gap-3 py-4">
        <NumField label={t("psTopupModal.amountLabel")} value={amount} min={1} onChange={setAmount} />
        <Field label={t("psTopupModal.promoLabel")} value={promo} onChange={setPromo} />
      </div>
    </DialogModal>
  );
}
