export type ResiType = "standart" | "premium" | "unmetered";

export type PsMe = { email: string; active_orders: number; wallet_balance: number };
export type PsOrder = {
  order_id: number;
  product_name: string;
  cycle_name: string;
  expires_at: string | null;
  auto_renewal: boolean | null;
  tag: string | null;
};
export type PsProduct = { name: string; description?: string | null; location?: string | null; cycles: string[] };
export type PsCalc = { original_price: number; final_price: number; discount_percent: number; addons_price?: number; total_with_addons?: number };
export type PsLoc = { code: string; name: string };
export type PsActiveProxy = { ip: string; username: string; password: string; http_port: number; socks_port: number; until: string; status: string; signature?: string | null };
export type PsBuyOption = { name: string; cycles: string[]; locations: string[] };

/** The ProxyShard page's Usage range; the choice persists. */
export type PsUsageRange = "24h" | "7d" | "30d";
/** One measure over the range: a value per bucket, and the total of the
 *  same-length period before it (null when the backend has none). */
export type PsUsageSeries = { points: number[]; previous: number | null };
/** `ps_usage` (backend B40): traffic, requests and failed requests over the
 *  range, in buckets of `step` ms from `from`. Traffic is in bytes, per
 *  residential tier and per datacenter or ISP order id; a tier or order with
 *  no entry has no history, and the card shows the No data ghost. */
export type PsUsage = {
  from: number;
  step: number;
  traffic: Partial<Record<ResiType, PsUsageSeries>>;
  requests: PsUsageSeries | null;
  failed: PsUsageSeries | null;
};
