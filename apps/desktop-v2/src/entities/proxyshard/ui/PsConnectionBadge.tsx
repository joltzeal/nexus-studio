import { Badge } from "@proxyshard/shardx-ui-kit";
import { useT } from "../../../shared/i18n";
import type { PsMe } from "../model/types";
import type { PsStatus } from "../lib/usePsAccount";
import { keyRejected } from "../lib/keyError";

/// The key check's result under the key field. A failure says which kind
/// (the key refused, or ProxyShard out of reach: PC-127) as a word, and its
/// reason once, here.
export function PsConnectionBadge({ status, me, err, hasKey }: {
  status: PsStatus;
  me: PsMe | null;
  err: string;
  hasKey: boolean;
}) {
  const t = useT();
  return (
    <div className="min-h-[22px]">
      {status === "checking" && <span className="text-secondary text-text-soft-400">{t("psConnectionBadge.validating")}</span>}
      {status === "ok" && me && (
        <Badge color="success" size="small">{t("psConnectionBadge.connected", { email: me.email })}</Badge>
      )}
      {status === "err" && (
        <div className="flex flex-col items-start gap-0.5">
          <Badge color="error" size="small">{keyRejected(err) ? t("psConnectionBadge.rejected") : t("psConnectionBadge.unreachable")}</Badge>
          <span className="text-help text-text-sub-600">{err}</span>
        </div>
      )}
      {status === "idle" && !hasKey && <span className="text-secondary text-text-soft-400">{t("psConnectionBadge.noKeyYet")}</span>}
    </div>
  );
}
