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

  /**
   * Scroll passes on a results page. A real user doesn't scroll the same
   * amount every visit, so each poll picks a random count in this range
   * rather than always doing the same fixed number.
   */
  scrollRoundsMin: num("FAMABOT_SCROLL_ROUNDS_MIN", 3),
  scrollRoundsMax: num("FAMABOT_SCROLL_ROUNDS_MAX", 7),
  /** Stop scrolling early after this many consecutive rounds add nothing new
   *  (mimics giving up once the same old listings keep reappearing). */
  scrollStaleLimit: num("FAMABOT_SCROLL_STALE_LIMIT", 2),
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

/** Random scroll-round count in [min, max] (inclusive); collapses to `min` if max <= min. */
export function pickScrollRounds(
  min: number,
  max: number,
  rand: () => number = Math.random,
): number {
  if (max <= min) return min;
  return min + Math.floor(rand() * (max - min + 1));
}

export interface ScrollLoopState {
  /** 0-indexed round about to run. */
  round: number;
  maxRounds: number;
  /** Current count of unique listings collected so far. */
  size: number;
  cap: number;
  /** Consecutive rounds so far that added no new unique listing. */
  staleStreak: number;
  staleLimit: number;
}

/** Whether to run another scroll round, given the loop's current state. */
export function shouldKeepScrolling(s: ScrollLoopState): boolean {
  return s.round < s.maxRounds && s.size < s.cap && s.staleStreak < s.staleLimit;
}

/**
 * Updated stale-streak count after one scroll round. Round 0 is always
 * exempt from counting as "stale": a scroll's GraphQL responses consistently
 * land about one round late (confirmed from real polls — round 1 never
 * shows growth, round 2 always does), so judging round 0 by whether size
 * grew would always say "no" regardless of whether scrolling is actually
 * working, silently eating into the stale budget before it's had a fair
 * chance.
 */
export function nextStaleStreak(
  round: number,
  size: number,
  prevSize: number,
  staleStreak: number,
): number {
  if (round === 0) return 0;
  return size > prevSize ? 0 : staleStreak + 1;
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
