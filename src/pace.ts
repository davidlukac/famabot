/**
 * Scraping pace. Deliberately slow — this is meant to run 24/7 in the background,
 * not to finish fast. Every value is overridable via env var. Times are seconds.
 */
function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const PACE = {
  /** Newest listings looked at per search, per poll. */
  listingCap: num("FAMABOT_LISTING_CAP", 20),

  /** Scroll passes on a results page, and the pause between them. */
  scrollRounds: num("FAMABOT_SCROLL_ROUNDS", 3),
  scrollPauseMin: num("FAMABOT_SCROLL_PAUSE_S", 6),
  scrollPauseSpan: 6,

  /** Wait after loading a page before touching it. */
  settleMin: num("FAMABOT_SETTLE_S", 4),
  settleSpan: 4,

  /** Gap between opening one listing's detail page and the next. */
  detailGapMin: num("FAMABOT_DETAIL_GAP_S", 30),
  detailGapSpan: 30,

  /** Gap between finishing one search and starting the next. */
  searchGapMin: num("FAMABOT_SEARCH_GAP_S", 120),
  searchGapSpan: 120,

  /** Re-check this many already-tracked listings per poll (availability + changes). */
  recheckPerPoll: num("FAMABOT_RECHECK_PER_POLL", 8),

  /** Default minutes between polls in `watch` (‑i/--interval overrides). */
  watchIntervalMin: num("FAMABOT_WATCH_INTERVAL_MIN", 90),
} as const;

/** Sleep a random duration in [minS, minS+spanS] seconds. */
export function pause(minS: number, spanS: number): Promise<void> {
  const ms = (minS + Math.random() * spanS) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

/** Fisher–Yates shuffle (so we don't hit searches in the same order every time). */
export function shuffled<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
