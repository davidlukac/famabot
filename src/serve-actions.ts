import type { DB } from "./db/index.js";
import { isCandidateAction } from "./domain/candidate-actions.js";
import { applyCandidateAction } from "./services/candidate-workflow-service.js";

export interface CandidateActionResponse {
  status: number;
  body: { error: string } | { fromPhase: string; toPhase: string | null };
}

/**
 * The web UI's `POST /listings/:fbId/actions/:action` handler, factored out
 * of `serve.ts` so it's testable without spinning up a real HTTP server.
 * Thin wrapper over `applyCandidateAction` — same validation (unknown action,
 * missing required comment, illegal transition) surfaces as a 400 instead of
 * a thrown error, a missing listing as 404.
 */
export function handleCandidateAction(
  db: DB,
  fbId: string,
  action: string,
  body: { comment?: string | null },
): CandidateActionResponse {
  if (!isCandidateAction(action)) {
    return { status: 400, body: { error: `Unknown action: ${action}` } };
  }
  try {
    const result = applyCandidateAction(db, fbId, action, body.comment ?? null);
    return { status: 200, body: result };
  } catch (err) {
    const message = (err as Error).message;
    return {
      status: /^No listing /.test(message) ? 404 : 400,
      body: { error: message },
    };
  }
}
