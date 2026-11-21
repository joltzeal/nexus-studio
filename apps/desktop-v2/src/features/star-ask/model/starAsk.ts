/// When to ask for a GitHub star (EMIL-19, 6.2 default): after the 10th
/// confirmed Start, on at least 2 different days; "Maybe later" waits 30
/// days; "Star" or "Don't ask again" ends it. Kept on this computer.
const KEY = "shardx.starAsk";
const LEGACY = "shardx-star-prompt";
const STARTS = 10;
const DAYS = 2;
const LATER_MS = 30 * 86_400_000;

export type StarAsk = { v: 1; starts: number; days: string[]; state: "counting" | "done"; laterUntil?: number };

const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function loadStarAsk(): StarAsk {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as StarAsk | null;
    if (raw?.v === 1) return raw;
    // Someone who answered the old prompt was asked already.
    if (localStorage.getItem(LEGACY) === "done") return { v: 1, starts: 0, days: [], state: "done" };
  } catch { /* broken or private: start counting */ }
  return { v: 1, starts: 0, days: [], state: "counting" };
}

function save(s: StarAsk): StarAsk {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: ask never */ }
  return s;
}

export function recordStart(now: Date): StarAsk {
  const s = loadStarAsk();
  if (s.state === "done") return s;
  const day = dayOf(now);
  // Only whether there are two different days matters; keep at most two.
  const days = s.days.includes(day) ? s.days : [...s.days, day].slice(-DAYS);
  return save({ ...s, starts: s.starts + 1, days });
}

export function shouldAsk(s: StarAsk, now: number): boolean {
  return s.state === "counting" && s.starts >= STARTS && s.days.length >= DAYS && (s.laterUntil ?? 0) <= now;
}

export const askLater = (now: number) => save({ ...loadStarAsk(), laterUntil: now + LATER_MS });
export const askDone = () => save({ ...loadStarAsk(), state: "done" });
