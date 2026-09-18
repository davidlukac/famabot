import { PHASES, type Phase } from "../types.js";

/**
 * Allowed manual transitions. The evaluator handles new -> candidate/rejected.
 * `accepted` means "pursuing this myself off-platform" — not final — and
 * resolves into exactly one of the four acquisition outcomes below.
 */
const TRANSITIONS: Record<Phase, Phase[]> = {
  new: ["candidate", "rejected"],
  candidate: ["rejected", "accepted"],
  accepted: [
    "acquisition_failed",
    "acquisition_rejected",
    "acquired_continue",
    "acquired_stop",
  ],
  rejected: [],
  acquisition_failed: [],
  acquisition_rejected: [],
  acquired_continue: [],
  acquired_stop: [],
};

export function isPhase(v: string): v is Phase {
  return (PHASES as readonly string[]).includes(v);
}

export function allowedNext(from: Phase): Phase[] {
  return TRANSITIONS[from];
}

/** Throws unless `from -> to` is a legal transition. */
export function assertTransition(from: Phase, to: Phase): void {
  if (from === to) throw new Error(`Listing is already in phase "${to}".`);
  if (!allowedNext(from).includes(to)) {
    const opts = allowedNext(from);
    throw new Error(
      `Cannot move from "${from}" to "${to}". ` +
        (opts.length
          ? `Allowed: ${opts.join(", ")}. Use --force to override.`
          : `"${from}" is a terminal phase. Use --force to override.`),
    );
  }
}
