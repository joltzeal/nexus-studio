import { PsOrdersCard } from "../../features/proxyshard";
import { PsStatTiles } from "./PsStatTiles";
import { PsUsage } from "./PsUsage";

/// The connected page: the account's stat tiles (Residential, Balance, Active
/// orders), Usage, then Orders. Buy proxies lives in the page header's
/// actions (owner, 2026-10-02), its button opening the shop in a dialog.
/// Sections sit 32 px apart (owner, "more air").
export function PsManagementPanels() {
  return (
    <div className="flex flex-col gap-[32px]">
      <PsStatTiles />
      <PsUsage />
      <PsOrdersCard />
    </div>
  );
}
