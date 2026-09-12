import type { DB } from "./index.js";
import { nowIso } from "./index.js";
import type { Evaluation } from "../evaluate/evaluator.js";
import type { EvalUsage } from "../evaluate/provider.js";
import type {
  ListingRow,
  Phase,
  PhaseHistoryRow,
  RawListing,
} from "../types.js";

export function getByFbId(db: DB, fbId: string): ListingRow | undefined {
  return db
    .prepare("SELECT * FROM listings WHERE fb_id = ?")
    .get(fbId) as ListingRow | undefined;
}

/** Insert a freshly scraped listing in phase `new`. Ignores if it already exists. */
export function insertListing(
  db: DB,
  searchKey: string,
  raw: RawListing,
): boolean {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO listings
        (fb_id, search_key, url, title, price, currency, location, image_url,
         description, raw_json, posted_at, first_seen_at, last_seen_at, phase)
       VALUES
        (@fb_id, @search_key, @url, @title, @price, @currency, @location, @image_url,
         @description, @raw_json, @posted_at, @ts, @ts, 'new')`,
    )
    .run({
      fb_id: raw.fbId,
      search_key: searchKey,
      url: raw.url,
      title: raw.title,
      price: raw.price,
      currency: raw.currency,
      location: raw.location,
      image_url: raw.imageUrl,
      description: raw.description,
      raw_json: raw.raw === undefined ? null : JSON.stringify(raw.raw),
      posted_at: raw.postedAt,
      ts,
    });
  return info.changes > 0;
}

export function touchLastSeen(db: DB, fbId: string): void {
  db.prepare("UPDATE listings SET last_seen_at = ? WHERE fb_id = ?").run(
    nowIso(),
    fbId,
  );
}

export function setAvailability(
  db: DB,
  fbId: string,
  availability: "active" | "unavailable" | "unknown",
): void {
  db.prepare(
    "UPDATE listings SET availability = ?, last_seen_at = ? WHERE fb_id = ?",
  ).run(availability, nowIso(), fbId);
}

export function setCommute(
  db: DB,
  fbId: string,
  drive: { km: number; minutes: number },
): void {
  db.prepare(
    "UPDATE listings SET drive_km = ?, drive_min = ? WHERE fb_id = ?",
  ).run(drive.km, drive.minutes, fbId);
}

export function markNotified(db: DB, fbId: string): void {
  db.prepare("UPDATE listings SET notified_at = ? WHERE fb_id = ?").run(
    nowIso(),
    fbId,
  );
}

/**
 * Apply a fresh scrape of an already-known listing. Bumps last_seen_at, and if
 * price or description changed, updates them and sets last_changed_at.
 * Returns a short description of the change, or null if nothing changed.
 */
const CHROME_RE =
  /\b(viewed|views|people|watching|listed|just now|hours?|days?|weeks?|months?|years?|ago|saved?|share|messages?|send seller|is this (still )?available|see (more|less)|report listing|related|sponsored|suggested|you might|log ?in|sign up|details|about this|seller information|joined facebook|response rate|very responsive|marketplace|create new listing|condition|category|approximate|similar)\b/;
const BEDBATH_RE = /^\d+\s*(bed|bath|bd|ba)\b/;

/**
 * Reduce a scraped detail-page blob to just the stable seller prose, so page
 * chrome (view counts, "Listed 3h ago", the rotating related-listings carousel,
 * seller card) doesn't look like an edit on every recheck. We keep only longish
 * sentence-like lines, deduped and sorted, and compare *those*.
 */
function descSignature(s: string | null | undefined): string {
  if (!s) return "";
  const lines = new Set(
    s
      .toLowerCase()
      .split("\n")
      .map((l) => l.trim().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim())
      .filter(
        (l) =>
          l.length >= 25 &&
          !/^[$£€]/.test(l) &&
          !BEDBATH_RE.test(l) &&
          !CHROME_RE.test(l),
      ),
  );
  return [...lines].sort().join(" | ").slice(0, 2000);
}

/** How many words differ between two signatures (symmetric). */
function wordDelta(a: string, b: string): number {
  const wa = new Set(a.split(/\W+/).filter(Boolean));
  const wb = new Set(b.split(/\W+/).filter(Boolean));
  let d = 0;
  for (const w of wa) if (!wb.has(w)) d++;
  for (const w of wb) if (!wa.has(w)) d++;
  return d;
}

export function applyRecheck(
  db: DB,
  fbId: string,
  next: {
    price?: number | null;
    description?: string | null;
    postedAt?: string | null;
  },
): string | null {
  const row = getByFbId(db, fbId);
  if (!row) return null;
  const ts = nowIso();
  const priceChanged = next.price != null && next.price !== row.price;

  // One-time baseline reset: rows captured with the old whole-page scrape carry
  // seller-card / view-count chrome. Silently adopt the new clean capture without
  // flagging a change.
  const staleCapture =
    /seller information|people viewed|response rate|marketplace ›|related listings/i.test(
      row.description ?? "",
    );
  if (staleCapture && next.description && next.description.length > 40) {
    db.prepare(
      "UPDATE listings SET description = ?, last_seen_at = ? WHERE fb_id = ?",
    ).run(next.description, ts, fbId);
    return null;
  }

  const nextSig = descSignature(next.description);
  const prevSig = descSignature(row.description);
  const descChanged =
    next.description != null &&
    nextSig.length > 40 &&
    prevSig.length > 40 &&
    nextSig !== prevSig &&
    wordDelta(nextSig, prevSig) >= 6; // ignore tiny/among-noise differences
  const relisted =
    next.postedAt != null &&
    row.posted_at != null &&
    next.postedAt !== row.posted_at;
  if (!priceChanged && !descChanged && !relisted) {
    db.prepare("UPDATE listings SET last_seen_at = ? WHERE fb_id = ?").run(ts, fbId);
    return null;
  }
  db.prepare(
    `UPDATE listings SET
       price = COALESCE(?, price),
       description = COALESCE(?, description),
       posted_at = COALESCE(?, posted_at),
       last_seen_at = ?, last_changed_at = ? WHERE fb_id = ?`,
  ).run(
    priceChanged ? next.price : null,
    descChanged ? next.description : null,
    relisted ? next.postedAt : null,
    ts,
    ts,
    fbId,
  );
  const bits: string[] = [];
  if (priceChanged) bits.push(`price ${row.price ?? "?"} -> ${next.price}`);
  if (descChanged) bits.push("description edited");
  if (relisted) bits.push("relisted");
  return bits.join(", ");
}

const MANUAL_PHASES = new Set<Phase>([
  "contacted",
  "visit_scheduled",
  "visited",
]);

/**
 * Listings edited since they were last evaluated — worth another look. `accepted`
 * / `declined` are the user's final call and never re-evaluated. `rejected` is
 * re-evaluated only when it was a near-miss (score >= 0.3) — a hard no that
 * changes isn't worth the tokens.
 */
/**
 * Same eligibility rule as `needingReeval`'s WHERE clause, for checking a single
 * row right after a recheck detects a change — so a re-eval can be dispatched
 * immediately instead of waiting for the next `needingReeval` sweep.
 */
export function isReevalEligible(row: ListingRow): boolean {
  if (row.availability !== "active") return false;
  if (row.phase === "accepted" || row.phase === "declined") return false;
  if (row.phase === "rejected" && (row.eval_score ?? 0) < 0.3) return false;
  return true;
}

export function needingReeval(db: DB, limit: number): ListingRow[] {
  return db
    .prepare(
      `SELECT * FROM listings
       WHERE availability = 'active'
         AND phase NOT IN ('accepted','declined')
         AND (phase <> 'rejected' OR COALESCE(eval_score,0) >= 0.3)
         AND last_changed_at IS NOT NULL
         AND (evaluated_at IS NULL OR last_changed_at > evaluated_at)
       ORDER BY last_changed_at ASC
       LIMIT ?`,
    )
    .all(limit) as ListingRow[];
}

/**
 * Re-score a listing after a change. Updates the eval fields + evaluated_at.
 * Only re-sets the phase for evaluator-owned phases (new / candidate / rejected);
 * for a listing you've manually advanced (contacted, …) the phase is left alone
 * so your pipeline progress is never clobbered.
 */
export function updateEvaluation(
  db: DB,
  fbId: string,
  ev: Evaluation,
  model: string,
  usage?: EvalUsage | null,
): { phaseChanged: boolean; phase: Phase } {
  const row = getByFbId(db, fbId);
  const keepPhase = row ? MANUAL_PHASES.has(row.phase) : false;
  const ts = nowIso();
  const newPhase: Phase = ev.verdict === "candidate" ? "candidate" : "rejected";
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE listings SET
         eval_verdict = ?, eval_score = ?, eval_reasoning = ?,
         eval_extracted_json = ?, eval_model = ?, evaluated_at = ?,
         eval_tokens_in = ?, eval_tokens_out = ?, eval_tokens_cached = ?,
         eval_cost_usd = ?
       WHERE fb_id = ?`,
    ).run(
      ev.verdict,
      ev.fit_score,
      ev.reasoning,
      JSON.stringify({
        extracted: ev.extracted,
        red_flags: ev.red_flags,
        missing_info: ev.missing_info,
      }),
      model,
      ts,
      usage?.tokensIn ?? null,
      usage?.tokensOut ?? null,
      usage?.tokensCached ?? null,
      usage?.costUsd ?? null,
      fbId,
    );
    if (!keepPhase && row && row.phase !== newPhase) {
      db.prepare(
        "UPDATE listings SET phase = ?, phase_updated_at = ? WHERE fb_id = ?",
      ).run(newPhase, ts, fbId);
      db.prepare(
        `INSERT INTO phase_history (fb_id, from_phase, to_phase, note, at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(fbId, row.phase, newPhase, "re-eval after change", ts);
    }
  });
  tx();
  return {
    phaseChanged: !keepPhase && row ? row.phase !== newPhase : false,
    phase: keepPhase && row ? row.phase : newPhase,
  };
}

/** Tracked listings whose last change hasn't been pushed yet. */
export function changedSinceNotified(db: DB): ListingRow[] {
  return db
    .prepare(
      `SELECT * FROM listings
       WHERE phase IN ('candidate','contacted','visit_scheduled','visited')
         AND last_changed_at IS NOT NULL
         AND (notified_at IS NULL OR last_changed_at > notified_at)`,
    )
    .all() as ListingRow[];
}

/**
 * Listings worth re-opening to catch closures / edits: the ones you're actually
 * pursuing (candidate + manually advanced), stalest first. `new` is excluded —
 * it was just fetched and gets evaluated the same poll; `rejected` is excluded
 * as not worth the request budget.
 */
export function trackedForRecheck(db: DB, limit: number): ListingRow[] {
  return db
    .prepare(
      `SELECT * FROM listings
       WHERE availability = 'active'
         AND phase IN ('candidate','contacted','visit_scheduled','visited')
       ORDER BY last_seen_at ASC
       LIMIT ?`,
    )
    .all(limit) as ListingRow[];
}

/** Store the agent's evaluation and set the resulting phase (candidate | rejected). */
export function setEvaluation(
  db: DB,
  fbId: string,
  ev: Evaluation,
  model: string,
  usage?: EvalUsage | null,
): Phase {
  const phase: Phase = ev.verdict === "candidate" ? "candidate" : "rejected";
  const ts = nowIso();
  const tx = db.transaction(() => {
    const prev = getByFbId(db, fbId);
    db.prepare(
      `UPDATE listings SET
         eval_verdict = ?, eval_score = ?, eval_reasoning = ?,
         eval_extracted_json = ?, eval_model = ?, evaluated_at = ?,
         eval_tokens_in = ?, eval_tokens_out = ?, eval_tokens_cached = ?,
         eval_cost_usd = ?, phase = ?, phase_updated_at = ?
       WHERE fb_id = ?`,
    ).run(
      ev.verdict,
      ev.fit_score,
      ev.reasoning,
      JSON.stringify({
        extracted: ev.extracted,
        red_flags: ev.red_flags,
        missing_info: ev.missing_info,
      }),
      model,
      ts,
      usage?.tokensIn ?? null,
      usage?.tokensOut ?? null,
      usage?.tokensCached ?? null,
      usage?.costUsd ?? null,
      phase,
      ts,
      fbId,
    );
    db.prepare(
      `INSERT INTO phase_history (fb_id, from_phase, to_phase, note, at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fbId, prev?.phase ?? null, phase, "evaluator", ts);
  });
  tx();
  return phase;
}

export function setPhase(
  db: DB,
  fbId: string,
  toPhase: Phase,
  note: string | null,
): void {
  const ts = nowIso();
  const tx = db.transaction(() => {
    const prev = getByFbId(db, fbId);
    db.prepare(
      "UPDATE listings SET phase = ?, phase_updated_at = ? WHERE fb_id = ?",
    ).run(toPhase, ts, fbId);
    db.prepare(
      `INSERT INTO phase_history (fb_id, from_phase, to_phase, note, at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fbId, prev?.phase ?? null, toPhase, note, ts);
  });
  tx();
}

export function appendNote(db: DB, fbId: string, note: string): void {
  const row = getByFbId(db, fbId);
  const stamped = `[${nowIso()}] ${note}`;
  const merged = row?.notes ? `${row.notes}\n${stamped}` : stamped;
  db.prepare("UPDATE listings SET notes = ? WHERE fb_id = ?").run(merged, fbId);
}

export interface QueryOpts {
  phase?: Phase;
  searchKey?: string;
  limit?: number;
}

export function queryListings(db: DB, opts: QueryOpts = {}): ListingRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.phase) {
    where.push("phase = ?");
    params.push(opts.phase);
  }
  if (opts.searchKey) {
    where.push("search_key = ?");
    params.push(opts.searchKey);
  }
  const sql =
    "SELECT * FROM listings" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY COALESCE(evaluated_at, first_seen_at) DESC" +
    (opts.limit ? ` LIMIT ${Number(opts.limit)}` : "");
  return db.prepare(sql).all(...params) as ListingRow[];
}

export function historyFor(db: DB, fbId: string): PhaseHistoryRow[] {
  return db
    .prepare("SELECT * FROM phase_history WHERE fb_id = ? ORDER BY id ASC")
    .all(fbId) as PhaseHistoryRow[];
}
