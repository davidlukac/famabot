import { PHASES, type Phase } from "../types.js";

/** Allowed manual transitions. The evaluator handles new -> candidate/rejected. */
const TRANSITIONS: Record<Phase, Phase[]> = {
  new: ["candidate", "rejected"],
  candidate: ["contacted", "rejected"],
  contacted: ["visit_scheduled", "rejected"],
  visit_scheduled: ["visited", "rejected"],
  visited: ["accepted", "declined"],
  rejected: [],
  accepted: [],
  declined: [],
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
