import type { ResiType } from "../../../entities/proxyshard";

/// A residential tier in the UI language. The API's own token ("standart")
/// never reaches the screen (CRAFT-22).
export function tierLabel(t: (key: string) => string, type: ResiType): string {
  return type === "premium" ? t("psResidentialCard.tierPremium") : type === "unmetered" ? t("psResidentialCard.tierUnmetered") : t("psResidentialCard.tierStandard");
}
