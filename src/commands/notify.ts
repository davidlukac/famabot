import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import {
  changedSinceNotified,
  markNotified,
  queryListings,
  setTelegramMessageId,
} from "../db/listings.js";
import { candidateMsg, notifyCandidate, notifyEnabled } from "../notify/push.js";
import { runTelegramBot } from "../notify/telegram-bot.js";
import { initLogger, log, logFilePath } from "../log.js";

/** notify, telegram-listen — push candidates, and listen for Telegram replies. */
export function registerNotifyCommands(program: Command): void {
  program
    .command("notify")
    .description(
      "Push any candidate that hasn't been notified yet (e.g. found before ntfy was set up).",
    )
    .option(
      "--changed",
      "also re-push tracked listings that changed since last notified",
    )
    .option(
      "--min-score <n>",
      "only push candidates at/above this fit score",
      parseFloat,
    )
    .option("--dry-run", "list what would be sent without sending")
    .action(
      async (opts: { changed?: boolean; minScore?: number; dryRun?: boolean }) => {
        const cfg = loadConfig();
        const db = openDb(cfg.dbPath);
        initLogger({ file: cfg.logPath, verbose: true });

        const envFloor = Number(process.env.FAMABOT_MIN_NOTIFY_SCORE);
        const floor =
          opts.minScore ?? (Number.isFinite(envFloor) && envFloor > 0 ? envFloor : 0);
        const rows = queryListings(db, { phase: "candidate" });
        const pending: { row: (typeof rows)[number]; prefix: string }[] = [];
        for (const r of rows)
          if (!r.notified_at && (r.eval_score ?? 0) >= floor)
            pending.push({ row: r, prefix: "" });
        if (opts.changed)
          for (const r of changedSinceNotified(db))
            if (r.notified_at) pending.push({ row: r, prefix: "↻ updated: " });

        if (pending.length === 0) {
          console.log("Nothing pending — all candidates already notified.");
          return;
        }
        if (!notifyEnabled() && !opts.dryRun) {
          console.error("No notification backend configured (set FAMABOT_NOTIFY).");
          process.exit(1);
        }
        console.log(`${pending.length} to ${opts.dryRun ? "send (dry run)" : "send"}:`);
        for (const { row, prefix } of pending) {
          const score = row.eval_score != null ? row.eval_score.toFixed(2) : "—";
          console.log(
            `  ${score}  ${row.currency ?? ""}${row.price ?? "?"}  ${row.title ?? ""}  ${row.url}`,
          );
          if (opts.dryRun) continue;
          const result = await notifyCandidate(candidateMsg(row, prefix));
          if (result.sent) {
            markNotified(db, row.fb_id);
            if (result.telegramMessageId != null) {
              setTelegramMessageId(db, row.fb_id, result.telegramMessageId);
            }
          } else console.warn(`  ↳ all backends failed for ${row.fb_id} — will retry`);
        }
        if (!opts.dryRun) console.log("sent.");
      },
    );

  program
    .command("telegram-listen")
    .description(
      "Long-poll Telegram for replies (accept/reject/hold/…) and apply them. " +
        "Safe to leave running 24/7 alongside `watch`.",
    )
    .action(async () => {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      initLogger({ file: cfg.logPath, verbose: cfg.verbose });
      log.info(`telegram-listen started; logging to ${logFilePath()}`);
      await runTelegramBot(db);
    });
}
