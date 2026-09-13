import pLimit from "p-limit";
import type { BrowserContext, Page } from "playwright";
import type { DB } from "../db/index.js";
import type { Search, ListingRow } from "../types.js";
import {
  applyRecheck,
  getByFbId,
  insertListing,
  isReevalEligible,
  needingReeval,
  queryListings,
  setAvailability,
  setCommute,
  trackedForRecheck,
} from "../db/listings.js";
import { computeCommute, routingEnabled } from "../enrich/commute.js";
import { log } from "../log.js";
import { PACE, pause, shuffled } from "../pace.js";
import { ensureLoggedIn } from "../scrape/browser.js";
import { buildSearchUrl, scrapeDetail, scrapeSearch } from "../scrape/marketplace.js";
import { renderCandidatesTable } from "../notify/cli.js";
import { evaluateStoreAndNotify } from "../services/evaluation-service.js";
import { pushCandidates, pushChanged } from "../services/notifications.js";

export interface PollResult {
  scraped: number;
  inserted: number;
  evaluated: number;
  rechecked: number;
  changed: number;
  gone: number;
  candidates: ListingRow[];
}

const short = (s: string | null, n = 70) =>
  !s ? "—" : s.replace(/\s+/g, " ").trim().slice(0, n);
const secs = (min: number, span: number) => `${min}-${min + span}s`;

/**
 * Evaluate one listing and store the result, dispatched as soon as its data is
 * ready rather than batched at the end of the poll — the eval call is a plain
 * HTTP request to the model provider, independent of the scraping browser page,
 * so it overlaps for free with the pacing gap before the *next* listing's
 * detail-page fetch. Notifies immediately when the result is a fresh candidate
 * (idempotent — safe to also re-check at the end of the poll as a backstop).
 */
async function evalAndStore(
  db: DB,
  ctx: BrowserContext,
  fbId: string,
  search: Search,
  reeval: boolean,
  linksByFb: Map<string, string[]>,
  result: PollResult,
  seq: number,
): Promise<void> {
  const row = getByFbId(db, fbId);
  if (!row) return;
  const tag = reeval ? "re-eval" : "eval";
  log.info(`[${tag} #${seq}] ${fbId} — ${short(row.title, 60)}`);
  try {
    // evaluateStoreAndNotify owns the actual eval/persist/notify + its own
    // logging (verdict, reasoning, red flags, unparseable-reply warnings) —
    // shared with `famabot reevaluate` so a candidate is pushed the same way
    // regardless of which one found it.
    const outcome = await evaluateStoreAndNotify(db, fbId, search, {
      reeval,
      links: linksByFb.get(fbId),
      ctx,
    });
    if (!outcome) return;
    result.evaluated += 1;

    if (outcome.phase === "candidate") {
      // Re-read so the row we keep for the end-of-poll backstop (and for
      // renderCandidatesTable) has the notified_at evaluateStoreAndNotify's
      // own push just set — otherwise the backstop would see a stale null
      // and notify a second time.
      const fresh = getByFbId(db, fbId);
      if (fresh) result.candidates.push(fresh);
    }
  } catch (err) {
    log.error(`[${tag}] ${fbId}: ${(err as Error).message}`);
  }
}

export async function runPoll(
  db: DB,
  ctx: BrowserContext,
  searches: Search[],
): Promise<PollResult> {
  const startedAt = Date.now();
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  log.debug("checking Facebook login state…");
  await ensureLoggedIn(page);
  log.info("logged in ✓");

  const result: PollResult = {
    scraped: 0,
    inserted: 0,
    evaluated: 0,
    rechecked: 0,
    changed: 0,
    gone: 0,
    candidates: [],
  };
  const linksByFb = new Map<string, string[]>();
  const byKey = new Map(searches.map((s) => [s.key, s]));

  const limit = pLimit(3);
  const inFlight: Promise<void>[] = [];
  let evalSeq = 0;
  const dispatchEval = (fbId: string, search: Search, reeval: boolean): void => {
    const seq = ++evalSeq;
    inFlight.push(
      limit(() => evalAndStore(db, ctx, fbId, search, reeval, linksByFb, result, seq)),
    );
  };
  /** Wait for everything dispatched so far, then clear the queue. */
  const drain = async (): Promise<void> => {
    await Promise.all(inFlight);
    inFlight.length = 0;
  };

  const enabled = shuffled(searches.filter((s) => s.enabled));
  log.info(
    `poll start — ${enabled.length} search(es): ${enabled.map((s) => s.key).join(", ")}`,
  );

  for (let s = 0; s < enabled.length; s++) {
    const search = enabled[s]!;
    if (s > 0) {
      log.debug(
        `waiting ${secs(PACE.searchGapMin, PACE.searchGapSpan)} before next search`,
      );
      await pause(PACE.searchGapMin, PACE.searchGapSpan);
    }
    const url = buildSearchUrl(search);
    log.info(`[${search.key}] scraping`, url);
    const listings = await scrapeSearch(page, url);
    result.scraped += listings.length;
    log.info(`[${search.key}] scraped ${listings.length} listing(s)`);
    for (const l of listings) {
      log.debug(
        `[${search.key}]   • ${l.fbId}  ${l.currency ?? ""}${l.price ?? "?"}  ${short(l.location, 24)}  ${short(l.title, 60)}`,
      );
    }

    let fresh = 0;
    for (const raw of listings) {
      const known = getByFbId(db, raw.fbId);
      if (known) {
        // Already indexed — don't re-fetch its page here, just note cheap
        // signals (price, relist date) from the search payload.
        const change = applyRecheck(db, raw.fbId, {
          price: raw.price,
          postedAt: raw.postedAt,
        });
        if (change) {
          result.changed += 1;
          log.info(`[${search.key}] CHANGED ${raw.fbId} — ${change}`);
          const changedRow = getByFbId(db, raw.fbId);
          if (changedRow && isReevalEligible(changedRow)) {
            dispatchEval(raw.fbId, search, true);
          }
        }
        continue;
      }
      if (search.fetchDetails) {
        log.debug(
          `[${search.key}] waiting ${secs(PACE.detailGapMin, PACE.detailGapSpan)} then opening item ${raw.fbId}`,
        );
        await pause(PACE.detailGapMin, PACE.detailGapSpan);
        const detail = await scrapeDetail(page, raw.fbId);
        raw.description = detail.text;
        linksByFb.set(raw.fbId, detail.links);
        log.debug(
          `[${search.key}] detail ${raw.fbId}: ${detail.text ? detail.text.length + " chars" : "none"}` +
            `${detail.links.length ? `, ${detail.links.length} link(s)` : ""}` +
            `${detail.unavailable ? ", UNAVAILABLE" : ""}`,
        );
        if (detail.unavailable) {
          insertListing(db, search.key, raw);
          setAvailability(db, raw.fbId, "unavailable");
          result.inserted += 1;
          result.gone += 1;
          log.info(
            `[${search.key}] ${raw.fbId} already gone — indexed, not evaluating`,
          );
          continue;
        }
      }
      if (insertListing(db, search.key, raw)) {
        result.inserted += 1;
        fresh += 1;
        log.info(
          `[${search.key}] NEW ${raw.fbId} — ${raw.currency ?? ""}${raw.price ?? "?"} — ${short(raw.title, 70)}`,
        );
        if (routingEnabled() && search.criteria.commute && raw.location) {
          const drive = await computeCommute(raw.location, search.criteria.commute);
          if (drive) {
            setCommute(db, raw.fbId, drive);
            log.info(
              `[${search.key}] ${raw.fbId} drive ${drive.minutes} min / ${drive.km} km ` +
                `to ${search.criteria.commute.label ?? "destination"}` +
                `${drive.approx ? " (city-level)" : ""} [${drive.provider}]`,
            );
          }
        }
        // Dispatched now, not batched — runs concurrently (cap 3) with the next
        // listing's detail-page fetch instead of waiting for the whole poll.
        dispatchEval(raw.fbId, search, false);
      }
    }
    log.info(`[${search.key}] ${fresh} new, ${listings.length - fresh} already known`);
  }

  await recheckTracked(db, page, byKey, dispatchEval, result);

  // Drain everything dispatched during scraping/recheck before the safety-net
  // sweep below, so `needingReeval` / the `new`-phase query (which key off
  // evaluated_at / phase) don't re-dispatch rows whose eval is still in flight.
  await drain();

  // Safety net: anything NOT already picked up above — leftovers from an
  // earlier interrupted poll, or a change that predates this poll's recheck.
  // Idempotent by construction: once a row is evaluated, it naturally drops out
  // of both queries (phase leaves 'new'; evaluated_at catches up to last_changed_at).
  let leftovers = 0;
  for (const row of queryListings(db, { phase: "new" })) {
    if (leftovers >= 40) break;
    const search = byKey.get(row.search_key);
    if (!search) continue;
    dispatchEval(row.fb_id, search, false);
    leftovers += 1;
  }
  let reevalCount = 0;
  for (const row of needingReeval(db, 20)) {
    const search = byKey.get(row.search_key);
    if (!search) continue;
    dispatchEval(row.fb_id, search, true);
    reevalCount += 1;
  }
  if (leftovers || reevalCount) {
    log.info(
      `safety-net sweep: ${leftovers} leftover 'new' listing(s), ${reevalCount} re-eval(s)`,
    );
  }
  await drain();

  // Backstop — pushCandidates/pushChanged are idempotent (gated on notified_at),
  // so re-running them here is a no-op for anything the immediate push already
  // caught, and catches anything that wasn't (safety-net-sweep candidates, or a
  // notify failure earlier in the poll).
  await pushCandidates(db, ctx, result.candidates);
  await pushChanged(db, ctx);

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  log.info(
    `poll done in ${mins} min — scraped ${result.scraped}, new ${result.inserted}, ` +
      `evaluated ${result.evaluated}, candidates ${result.candidates.length}, ` +
      `changed ${result.changed}, gone ${result.gone}, rechecked ${result.rechecked}`,
  );
  renderCandidatesTable(result.candidates);
  return result;
}

/** Re-open a handful of already-tracked listings to catch closures / edits. */
async function recheckTracked(
  db: DB,
  page: Page,
  byKey: Map<string, Search>,
  dispatchEval: (fbId: string, search: Search, reeval: boolean) => void,
  result: PollResult,
): Promise<void> {
  const rows = trackedForRecheck(db, PACE.recheckPerPoll);
  if (rows.length === 0) return;
  log.info(`rechecking ${rows.length} tracked listing(s)`);
  for (const row of rows) {
    await pause(PACE.detailGapMin, PACE.detailGapSpan);
    const detail = await scrapeDetail(page, row.fb_id);
    result.rechecked += 1;
    if (detail.unavailable) {
      setAvailability(db, row.fb_id, "unavailable");
      result.gone += 1;
      log.info(`recheck ${row.fb_id}: GONE — ${short(row.title, 50)}`);
      continue;
    }
    const change = applyRecheck(db, row.fb_id, {
      price: null,
      description: detail.text,
    });
    if (change) {
      result.changed += 1;
      log.info(`recheck ${row.fb_id}: CHANGED — ${change}`);
      const changedRow = getByFbId(db, row.fb_id);
      const search = byKey.get(row.search_key);
      if (changedRow && search && isReevalEligible(changedRow)) {
        dispatchEval(row.fb_id, search, true);
      }
    } else {
      log.debug(`recheck ${row.fb_id}: unchanged`);
    }
  }
}
