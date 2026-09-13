import type { Phase } from "../types.js";

/**
 * Map the evaluator's verdict to the listing phase it produces. The single
 * source of truth for that mapping — `setEvaluation`/`updateEvaluation` in
 * `db/listings.ts` both apply it, and previously each had their own copy.
 */
export function phaseForVerdict(verdict: "candidate" | "reject"): Phase {
  return verdict === "candidate" ? "candidate" : "rejected";
}
