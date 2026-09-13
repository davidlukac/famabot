import type { BrowserContext } from "playwright";
import type { DB } from "../db/index.js";
import { changedSinceNotified, markNotified } from "../db/listings.js";
import type { ListingRow } from "../types.js";
import { log } from "../log.js";
import { candidateMsg, notifyCandidate, notifyEnabled } from "../notify/push.js";

/** Only push candidates at/above this fit score (0 = push all). */
export function minNotifyScore(): number {
  const v = Number(process.env.FAMABOT_MIN_NOTIFY_SCORE);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Notify for brand-new candidates (once each), above the score floor.
 * Idempotent — gated on `notified_at`, so calling it more than once for the
 * same row (e.g. an immediate push plus an end-of-poll backstop sweep) is
 * always safe.
 */
export async function pushCandidates(
  db: DB,
  ctx: BrowserContext | undefined,
  candidates: ListingRow[],
): Promise<void> {
  if (!notifyEnabled()) return;
  const floor = minNotifyScore();
  for (const c of candidates) {
    if (c.notified_at) continue;
    if ((c.eval_score ?? 0) < floor) {
      log.info(
        `[notify] skip ${c.fb_id} — fit ${(c.eval_score ?? 0).toFixed(2)} < ${floor} (in pipeline, not pushed)`,
      );
      continue;
    }
    const sent = await notifyCandidate(candidateMsg(c), ctx);
    if (sent) markNotified(db, c.fb_id);
    else
      log.warn(
        `[notify] all backends failed for ${c.fb_id} — will retry on the next \`famabot notify\` or poll`,
      );
  }
}

/** Ping for tracked listings (candidate / contacted / …) that changed since last notified. */
export async function pushChanged(
  db: DB,
  ctx: BrowserContext | undefined,
): Promise<void> {
  if (!notifyEnabled()) return;
  for (const c of changedSinceNotified(db)) {
    if (!c.notified_at) continue; // never notified at all -> handled elsewhere
    const sent = await notifyCandidate(candidateMsg(c, "↻ updated: "), ctx);
    if (sent) markNotified(db, c.fb_id);
    else
      log.warn(
        `[notify] all backends failed for ${c.fb_id} (changed) — will retry next poll`,
      );
  }
}
