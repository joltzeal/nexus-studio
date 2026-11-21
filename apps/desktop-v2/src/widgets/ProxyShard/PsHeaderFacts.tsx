import { usePsAccount } from "../../entities/proxyshard";
import { useT } from "../../shared/i18n";

/// After the title, while the key is checked: "Checking your key…". Once it
/// works, the account's facts are the stat tiles at the top of the page
/// (owner, "more air, clearer hierarchy"); without a working key the setup
/// card says why.
export function PsHeaderFacts() {
  const t = useT();
  const status = usePsAccount((s) => s.status);
  if (status !== "checking") return null;
  return <span data-ps-facts className="min-w-0 truncate text-secondary text-text-soft-400">{t("psStates.checking")}</span>;
}
