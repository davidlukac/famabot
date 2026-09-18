import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { getByFbId } from "../db/listings.js";
import { applyCandidateAction } from "../services/candidate-workflow-service.js";
import { CANDIDATE_ACTIONS } from "../domain/candidate-actions.js";

/** reject, hold, accept, acquisition-failed/-rejected, acquired-continue/-stop —
 *  the acquisition workflow actions, each a thin wrapper over
 *  `applyCandidateAction`, driven by the single `CANDIDATE_ACTIONS` table so
 *  the command list/descriptions/comment-requiredness can't drift from what
 *  the web UI and Telegram bot enforce. See `move`/`note` in pipeline.ts for
 *  the raw escape hatch (arbitrary phase, --force). */
export function registerCandidateCommands(program: Command): void {
  for (const [action, def] of Object.entries(CANDIDATE_ACTIONS)) {
    const cmd = program
      .command(def.command)
      .description(def.description)
      .argument("<fbId>");
    if (def.commentRequired) {
      cmd.argument("<comment>");
    } else {
      cmd.option("-n, --note <text>", "comment to attach to the transition");
    }
    cmd.option("-f, --force", "skip transition validation");
    cmd.action((...args: unknown[]) => {
      // Commander always calls action(...positionalArgs, options, command) —
      // options is second-to-last regardless of how many positional args this
      // particular command declares (fbId alone, or fbId + a required comment).
      const opts = args.at(-2) as { note?: string; force?: boolean };
      const fbId = args[0] as string;
      const comment = def.commentRequired ? (args[1] as string) : (opts.note ?? null);

      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const row = getByFbId(db, fbId);
      if (!row) {
        console.error(`No listing ${fbId}`);
        process.exit(1);
      }
      try {
        const result = applyCandidateAction(
          db,
          fbId,
          action as keyof typeof CANDIDATE_ACTIONS,
          comment,
          { force: opts.force },
        );
        console.log(
          result.toPhase
            ? `${fbId}: ${result.fromPhase} -> ${result.toPhase}`
            : `${fbId}: noted (still ${result.fromPhase})`,
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
  }
}
