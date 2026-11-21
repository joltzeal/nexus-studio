import { Card } from "@proxyshard/shardx-ui-kit";
import { usePsAccount } from "../../entities/proxyshard";
import { useT } from "../../shared/i18n";
import { fmtCount, fmtMoney } from "../../shared/lib/format";
import { PsResidentialTile } from "../../features/proxyshard";
import { StatValue } from "../../shared/ui/Stat";

/// The account's facts as stat tiles (owner, "more air, clearer hierarchy"):
/// Residential first, then Balance and Active orders. From 920 px Residential
/// takes half the row and the other two share the other half equally (never
/// under 220 px each). Narrower, Residential spans the full row on top and the
/// other two sit below as two equal tiles. Every tile has the same two rows: a
/// 24 px row with the soft label (and controls, on Residential), then the key
/// number.
export function PsStatTiles() {
  const t = useT();
  const me = usePsAccount((s) => s.me);
  if (!me) return null;
  const tiles = [
    { id: "balance", label: t("psTiles.balance"), value: fmtMoney(me.wallet_balance) },
    { id: "orders", label: t("psTiles.activeOrders"), value: fmtCount(me.active_orders) },
  ];
  return (
    <div className="@container">
      <div data-ps-tiles className="grid grid-cols-2 gap-[12px] @min-[920px]:grid-cols-4">
        <div className="col-span-2 grid"><PsResidentialTile /></div>
        {tiles.map((tile) => (
          <Card key={tile.id} data-ps-tile={tile.id} padding="none" className="flex min-w-0 flex-col gap-[4px] p-[16px]">
            <div className="flex h-[24px] items-center truncate text-secondary text-text-soft-400">{tile.label}</div>
            <StatValue size="sm" value={tile.value} />
          </Card>
        ))}
      </div>
    </div>
  );
}
