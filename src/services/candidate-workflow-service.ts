import type { DB } from "../db/index.js";
import { getByFbId, logFeedback, setPhase } from "../db/listings.js";
import { pauseSearch } from "../db/searches.js";
import { assertTransition } from "../pipeline/phases.js";
import {
  CANDIDATE_ACTIONS,
  type CandidateAction,
} from "../domain/candidate-actions.js";
import type { Phase } from "../types.js";

export interface CandidateActionResult {
  fromPhase: Phase;
  /** null for `hold` — it logs feedback without changing phase. */
  toPhase: Phase | null;
}

export interface CandidateActionOptions {
  /** Skip transition validation (mirrors `move --force`). */
  force?: boolean;
}

/**
 * The one choke point for the acquisition workflow — CLI commands, the web
 * UI's action routes, and the Telegram bot all call through here rather than
 * touching `setPhase`/`logFeedback` directly, so the comment requirement,
 * transition validation, and "stop search" side effect are enforced exactly
 * once. Mirrors how `evaluation-service.ts` centralizes eval+persist+notify.
 */
export function applyCandidateAction(
  db: DB,
  fbId: string,
  action: CandidateAction,
  comment: string | null,
  opts: CandidateActionOptions = {},
): CandidateActionResult {
  const row = getByFbId(db, fbId);
  if (!row) throw new Error(`No listing ${fbId}`);

  const def = CANDIDATE_ACTIONS[action];
  if (def.commentRequired && !comment?.trim()) {
    throw new Error(`Action "${action}" requires a comment.`);
  }

  if (def.toPhase === null) {
    // `hold`: still deciding — record the feedback, phase stays put.
    logFeedback(db, fbId, comment!.trim());
    return { fromPhase: row.phase, toPhase: null };
  }

  if (!opts.force) assertTransition(row.phase, def.toPhase);
  setPhase(db, fbId, def.toPhase, comment?.trim() || null, "user");
  if (def.pausesSearch) {
    pauseSearch(db, row.search_key, comment?.trim() || `acquired via ${fbId}`);
  }
  return { fromPhase: row.phase, toPhase: def.toPhase };
}
