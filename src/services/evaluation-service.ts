import type { BrowserContext } from "playwright";
import type { DB } from "../db/index.js";
import {
  getByFbId,
  recentUserFeedback,
  setEvaluation,
  updateEvaluation,
} from "../db/listings.js";
import type {
  Evaluation,
  EvaluationResult,
  ListingInput,
} from "../evaluate/evaluator.js";
import { EVAL_MODEL, evaluateListing, toListingInput } from "../evaluate/evaluator.js";
import type { EvalUsage } from "../evaluate/provider/index.js";
import { log } from "../log.js";
import type { Phase, Search } from "../types.js";
import { pushCandidates } from "./notifications.js";

export interface EvaluateStoreResult {
  evaluation: Evaluation;
  usage: EvalUsage | null;
  phase: Phase;
  /** For a re-eval: whether the phase actually changed. Always true otherwise. */
  phaseChanged: boolean;
}

export interface EvaluateStoreOptions {
  /** Re-score an already-evaluated listing rather than a fresh `new` one. */
  reeval?: boolean;
  /** Off-platform links already extracted this poll, if any (skips re-parsing). */
  links?: string[];
  /** Needed only if the `messenger` notify backend is configured. */
  ctx?: BrowserContext;
  /** Injectable for tests — defaults to the real `evaluateListing` (a live AI
   *  call). Lets the persist/notify orchestration below be exercised without
   *  a network round-trip. */
  evaluateFn?: (
    listing: ListingInput,
    search: Search,
    opts: { feedback?: string[] },
  ) => Promise<EvaluationResult | null>;
}

/**
 * Evaluate one stored listing, persist the result, and — if it's now a fresh
 * candidate — notify (idempotent, safe to call more than once for the same
 * row). This is the one place that owns "what happens when a listing gets
 * scored": `pipeline/poll.ts`'s per-row dispatch and `famabot reevaluate` both
 * call it, so a candidate found either way is pushed the same way. Returns
 * null if the listing doesn't exist, or the model's reply couldn't be parsed
 * into a valid evaluation after retrying.
 */
export async function evaluateStoreAndNotify(
  db: DB,
  fbId: string,
  search: Search,
  opts: EvaluateStoreOptions = {},
): Promise<EvaluateStoreResult | null> {
  const row = getByFbId(db, fbId);
  if (!row) return null;

  const tag = opts.reeval ? "re-eval" : "eval";
  const feedback = recentUserFeedback(db, search.key);
  const evaluate = opts.evaluateFn ?? evaluateListing;
  const res = await evaluate(toListingInput(row, { links: opts.links }), search, {
    feedback,
  });
  if (!res) {
    log.warn(`[${tag}] ${fbId}: unparseable response, will retry next poll`);
    return null;
  }
  const { evaluation, usage } = res;

  let phase: Phase;
  let phaseChanged = true;
  if (opts.reeval) {
    const r = updateEvaluation(db, fbId, evaluation, EVAL_MODEL, usage);
    phase = r.phase;
    phaseChanged = r.phaseChanged;
    log.info(
      `[re-eval] ${fbId}: ${evaluation.verdict.toUpperCase()} fit=${evaluation.fit_score.toFixed(2)}` +
        (phaseChanged ? ` -> ${phase}` : ` (kept phase ${phase})`),
    );
  } else {
    phase = setEvaluation(db, fbId, evaluation, EVAL_MODEL, usage);
    log.info(
      `[eval] ${fbId}: ${evaluation.verdict.toUpperCase()} fit=${evaluation.fit_score.toFixed(2)} -> ${phase}`,
    );
  }
  log.debug(`[${tag}] ${fbId} reason: ${evaluation.reasoning}`);
  if (evaluation.red_flags.length) {
    log.debug(`[${tag}] ${fbId} red flags: ${evaluation.red_flags.join("; ")}`);
  }

  if (phase === "candidate") {
    // Re-read so pushCandidates sees the just-written eval_score/notified_at,
    // not the stale pre-evaluation snapshot fetched above.
    const fresh = getByFbId(db, fbId);
    if (fresh) await pushCandidates(db, opts.ctx, [fresh]);
  }

  return { evaluation, usage, phase, phaseChanged };
}
