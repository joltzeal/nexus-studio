// Dev-only: fetches the real ShardX fingerprint library from the ProxyShard
// CDN, unzips it in the browser (zero dependencies — zip's central directory
// is walked by hand, each file's deflate stream goes through the browser's
// native DecompressionStream), and converts each .json into the FingerprintEntry
// shape the frontend expects.
//
// The library is cached in localStorage (compressed) so a reload never
// re-downloads unless the manifest etag changed. This mirrors what the Rust
// backend does (runtime.rs install_fingerprints) — just in JS, for the dev
// preview.

import type { FingerprintEntry } from "../../entities/fingerprint/model/types";

const CDN = "https://pub-e57a7c60f6934eb09a6600bf2fc59cdc.r2.dev";
const ZIP_KEY = "ShardX-Fingerprints.zip";
const MANIFEST_URL =
  "https://raw.githubusercontent.com/ProxyShard/ShardBrowser/main/runtime.json";
const CACHE_KEY = "shardx-real-fingerprints";
const CACHE_ETAG_KEY = "shardx-real-fingerprints-etag";

type Manifest = {
  archives: Record<string, string>;
  chromium_version?: string;
};
function tagColor(platform: string): string {
  if (/mac/i.test(platform)) return "#8b5cf6";
  if (/win/i.test(platform)) return "#3b82f6";
  if (/linux/i.test(platform)) return "#f59e0b";
  if (/android/i.test(platform)) return "#10b981";
  return "#64748b";
}

/** Reads the navigator.platform value the card's filter uses, from a raw
 *  fingerprint JSON's navigator block (which uses "platform" as OS name). */
function platformOf(payload: any): string {
  const p = payload?.navigator?.platform ?? "";
  if (/Windows/i.test(p)) return "Windows";
  if (/Mac/i.test(p)) return "macOS";
  if (/Linux/i.test(p)) return "Linux";
  // Android UA has "Linux; Android" — the navigator.platform is "Linux armv8l"
  const ua = String(payload?.navigator?.user_agent ?? "");
  if (/Android/i.test(ua)) return "Linux armv8l";
  return p;
}

/** Converts a raw fingerprint JSON file (the CDN shape) into the FingerprintEntry
 *  the frontend's store, card and Peek read. */
function toEntry(id: string, payload: any): FingerprintEntry {
  const ua = String(payload?.navigator?.user_agent ?? "");
  const chromeMatch = /Chrome\/([\d.]+)/.exec(ua);
  const platform = platformOf(payload);
  return {
    id,
    label: String(payload?.name ?? id) || id,
    platform,
    chrome: chromeMatch?.[1] ?? "157.0.0.0",
    gpu: String(payload?.webgl?.renderer ?? "unknown GPU"),
    tag_color: tagColor(platform),
    builtin: true,
    payload,
  };
}

/** Walks a zip file's central directory and returns each .json file as
 *  { name, data: Uint8Array }. Uses the browser's native DecompressionStream
 *  for deflate — zero dependencies. */
async function unzipJsonFiles(zipBytes: Uint8Array): Promise<Map<string, string>> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const files = new Map<string, string>();

  // Find the End of Central Directory record (EOCD) — a 22-byte signature
  // near the end of the file, possibly preceded by a comment.
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: EOCD not found");

  const cdCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const uncompressedSize = view.getUint32(cdOffset + 24, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);
    const nameStart = cdOffset + 46;
    const name = new TextDecoder().decode(zipBytes.subarray(nameStart, nameStart + nameLen));
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith(".json")) continue;

    // Read the local file header to find where the compressed data starts.
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compData = zipBytes.subarray(dataStart, dataStart + compSize);

    let text: string;
    if (compMethod === 0) {
      // Stored (no compression)
      text = new TextDecoder().decode(zipBytes.subarray(dataStart, dataStart + uncompressedSize));
    } else if (compMethod === 8) {
      // Deflate (raw, no zlib header)
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([compData]).stream().pipeThrough(ds);
      const decompressed = await new Response(stream).arrayBuffer();
      text = new TextDecoder().decode(decompressed);
    } else {
      continue;
    }
    // Strip the top directory: "shardx-fingerprints/foo.json" → "foo.json"
    const baseName = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    files.set(baseName.replace(/\.json$/, ""), text);
  }
  return files;
}

/** Fetches the manifest from GitHub, returns the fingerprints etag. */
async function manifestEtag(): Promise<string | null> {
  try {
    const resp = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!resp.ok) return null;
    const manifest = (await resp.json()) as Manifest;
    return manifest.archives?.[ZIP_KEY] ?? null;
  } catch {
    return null;
  }
}

/** Loads the real fingerprint library from the CDN, with localStorage
 *  caching by etag. Returns null if the fetch failed and no cache exists. */
export async function loadRealFingerprints(): Promise<FingerprintEntry[] | null> {
  const remoteEtag = await manifestEtag();

  // Check the cache: if the etag matches, the cached library is current.
  try {
    const cachedEtag = localStorage.getItem(CACHE_ETAG_KEY);
    const cachedRaw = localStorage.getItem(CACHE_KEY);
    if (cachedRaw && cachedEtag && cachedEtag === remoteEtag) {
      const parsed = JSON.parse(cachedRaw) as FingerprintEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* corrupt or unavailable */ }

  // Download the zip from the CDN.
  const zipUrl = `${CDN}/${ZIP_KEY}`;
  const resp = await fetch(zipUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`CDN fetch failed: ${resp.status} ${resp.statusText}`);
  const zipBuffer = await resp.arrayBuffer();
  const zipBytes = new Uint8Array(zipBuffer);

  // Unzip and parse every .json file.
  const files = await unzipJsonFiles(zipBytes);
  const entries: FingerprintEntry[] = [];
  for (const [id, text] of files) {
    try {
      const payload = JSON.parse(text);
      entries.push(toEntry(id, payload));
    } catch { /* skip corrupt JSON */ }
  }

  if (entries.length === 0) return null;

  // Sort: macOS, Windows, Linux, Android — alphabetical within each.
  const osOrder = (p: string) =>
    /mac/i.test(p) ? 0 : /win/i.test(p) ? 1 : /linux/i.test(p) ? 2 : 3;
  entries.sort((a, b) => {
    const d = osOrder(a.platform) - osOrder(b.platform);
    return d !== 0 ? d : a.label.localeCompare(b.label, undefined, { numeric: true });
  });

  // Cache. The entries are large (220 × ~10KB) — localStorage may not hold
  // them all in some browsers (5 MB limit). If the write throws, the library
  // is still returned for this session; the next reload re-downloads.
  if (remoteEtag) {
    try {
      localStorage.setItem(CACHE_ETAG_KEY, remoteEtag);
      localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
    } catch { /* quota exceeded — fine for a dev tool */ }
  }

  return entries;
}

/** Clears the cached fingerprint library. */
export function clearRealFingerprintsCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_ETAG_KEY);
  } catch { /* ignore */ }
}
