import { ExternalLinkIcon } from "../../../shared/icons";
import { useT } from "../../../shared/i18n";
import { HeaderMenu } from "../../../widgets/PageHeader/HeaderMenu";
import { menuItemsFor } from "../../commands";
import { buyProxies } from "../lib/buyProxies";
import { isNativeRaccoon } from "../../../raccoon/runtime";

/// The Proxies header's `…` menu: the page's commands from the registry
/// (E4), and ProxyShard's shop (owner default: "Buy proxies" lives here and
/// in the empty state, CRAFT-25), a link out rather than a command.
export function ProxiesMoreMenu() {
  const t = useT();
  return (
    <HeaderMenu
      items={[
        ...menuItemsFor("pageMenu", "proxies", { ids: [] }),
        ...(isNativeRaccoon() ? [] : [{ label: t("proxiesMoreMenu.buy"), icon: <ExternalLinkIcon className="size-3.5" />, onSelect: buyProxies }]),
      ]}
    />
  );
}
