import { storeBus } from "../../../shared/lib/storeBus";
import { usePsAccount } from "./usePsAccount";
import { usePsPlans } from "./plans";
import { usePsUsage } from "./usage";

/// Everything an account change makes stale, read again in place: after a
/// buy, a top-up or a renewal. The wallet and the order count (the tiles),
/// the plans (Usage, and the Proxy balance card on Profiles) and the usage
/// history; and a "proxyshard" event, which the lists that read for
/// themselves (the Orders list, the Residential tile's order and traffic)
/// listen to. Each keeps what it shows until its answer is in, and a failed
/// read changes nothing.
export async function refreshAfterPurchase(): Promise<void> {
  storeBus.emit("proxyshard", "ui");
  await Promise.all([
    usePsAccount.getState().reloadMe(),
    usePsPlans.getState().refresh(),
    usePsUsage.getState().load(),
  ]);
}
