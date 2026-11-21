import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Tooltip } from "@proxyshard/shardx-ui-kit";
import { ShardMini } from "../../../shared/icons";
import { DASHBOARD_URL } from "../../../shared/lib/utils";
import { useT } from "../../../shared/i18n";

export function OpenDashboardButton() {
  const t = useT();
  return (
    <Tooltip content={t("openDashboardButton.tooltip")}>
      <Button
        // The header's one filled or tinted button is a real primary; this
        // page has none there (F3's recipe).
        variant="neutral"
        mode="stroke"
        size="xsmall"
        // The brand mark keeps its 16 px; the kit slot draws plain icons at 14.
        leftIcon={<span className="brand-mark flex"><ShardMini /></span>}
        onClick={() => { openUrl(DASHBOARD_URL).catch(() => {}); }}
      >
        {t("openDashboardButton.label")}
      </Button>
    </Tooltip>
  );
}
