import type { Phase } from "../types.js";

export interface CandidateActionDef {
  /** Phase to move to, or null for `hold` (logs feedback, stays put). */
  toPhase: Phase | null;
  /** Whether the CLI/Web/Telegram caller must supply a comment for this action. */
  commentRequired: boolean;
  /** Whether taking this action pauses the listing's owning search. */
  pausesSearch?: boolean;
  /** Hyphenated form used by the CLI and Telegram slash commands (e.g. "acquisition-failed"). */
  command: string;
  /** One-line, user-facing explanation — shown in `--help` and the Telegram `/help` reply. */
  description: string;
}

/**
 * The user-facing acquisition workflow actions — the single source of truth
 * that the CLI, web UI, and Telegram bot all drive through
 * `services/candidate-workflow-service.ts`. Mirrors the transitions in
 * `pipeline/phases.ts`, plus `hold` which isn't a phase transition at all
 * (it's the "still deciding" comment-only action while a listing sits in
 * `candidate`).
 */
export const CANDIDATE_ACTIONS = {
  reject: {
    toPhase: "rejected",
    commentRequired: false,
    pausesSearch: false,
    command: "reject",
    description: "Reject a candidate. Flow stops here.",
  },
  hold: {
    toPhase: null,
    commentRequired: true,
    pausesSearch: false,
    command: "hold",
    description: "Still deciding — log feedback without changing phase.",
  },
  accept: {
    toPhase: "accepted",
    commentRequired: false,
    pausesSearch: false,
    command: "accept",
    description: "Accept a candidate — you'll pursue it yourself off-platform.",
  },
  acquisition_failed: {
    toPhase: "acquisition_failed",
    commentRequired: true,
    pausesSearch: false,
    command: "acquisition-failed",
    description:
      "The acquisition fell through (unavailable, no price match, couldn't meet).",
  },
  acquisition_rejected: {
    toPhase: "acquisition_rejected",
    commentRequired: true,
    pausesSearch: false,
    command: "acquisition-rejected",
    description: "Saw/met about it and it didn't hold up (faulty, didn't match).",
  },
  acquired_continue: {
    toPhase: "acquired_continue",
    commentRequired: false,
    pausesSearch: false,
    command: "acquired-continue",
    description: "Acquired it — keep searching for more like it.",
  },
  acquired_stop: {
    toPhase: "acquired_stop",
    commentRequired: false,
    pausesSearch: true,
    command: "acquired-stop",
    description: "Acquired it — stop searching (pauses this search).",
  },
} as const satisfies Record<string, CandidateActionDef>;

export type CandidateAction = keyof typeof CANDIDATE_ACTIONS;

export function isCandidateAction(v: string): v is CandidateAction {
  return Object.prototype.hasOwnProperty.call(CANDIDATE_ACTIONS, v);
}

/**
 * One line per action, e.g. `/acquisition-failed <fbId> <comment>  — The
 * acquisition fell through (…)`. Shared by the CLI's own `--help` framing and
 * the Telegram bot's `/help` command and fallback replies, so the full command
 * list only needs to be written once.
 */
export function helpText(): string {
  return Object.values(CANDIDATE_ACTIONS)
    .map((def) => {
      const arg = def.commentRequired ? "<comment>" : "[comment]";
      return `/${def.command} <fbId> ${arg} — ${def.description}`;
    })
    .join("\n");
}
