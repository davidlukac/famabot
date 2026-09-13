import type { Command } from "commander";
import { loadConfig, loadSearches } from "../config.js";
import { PACE, pause } from "../pace.js";
import { openDb } from "../db/index.js";
import { setAvailability, trackedForRecheck, applyRecheck } from "../db/listings.js";
import { interactiveLogin, launchContext } from "../scrape/browser.js";
import { scrapeDetail } from "../scrape/marketplace.js";
import { runPoll } from "../pipeline/poll.js";
import { log, logFilePath } from "../log.js";
import { sleep } from "./shared.js";

/** login, poll, watch, recheck — everything that drives the headless browser. */
export function registerScrapingCommands(program: Command): void {
  program
    .command("login")
    .description("Open a browser to log in to Facebook; the session is saved.")
    .action(async () => {
      const cfg = loadConfig();
      await interactiveLogin(cfg.profileDir);
    });

  program
    .command("poll")
    .description("Run one scrape + evaluate pass over all enabled searches.")
    .action(async () => {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const searches = loadSearches(cfg.searchesPath);
      log.info(`logging to ${logFilePath()}`);
      const ctx = await launchContext(cfg.profileDir, cfg.headless);
      try {
        await runPoll(db, ctx, searches);
      } finally {
        await ctx.close();
      }
    });

  program
    .command("watch")
    .description("Poll on a loop until interrupted. Safe to leave running 24/7.")
    .option(
      "-i, --interval <minutes>",
      "minutes between polls",
      String(PACE.watchIntervalMin),
    )
    .action(async (opts: { interval: string }) => {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      let searches = loadSearches(cfg.searchesPath);
      const baseMin = Math.max(15, Number(opts.interval) || PACE.watchIntervalMin);
      log.info(
        `watch started — poll every ~${baseMin} min (± jitter); logging to ${logFilePath()}`,
      );

      let stop = false;
      process.on("SIGINT", () => {
        log.warn("SIGINT — stopping after the current pass…");
        stop = true;
      });

      let n = 0;
      while (!stop) {
        log.info(`──── poll #${++n} ────`);
        // Re-read searches.yaml every pass — edits (enable/disable a search, tweak
        // criteria) take effect on the next poll without restarting `watch`. A
        // syntax error mid-edit just keeps the last known-good config for this pass.
        try {
          searches = loadSearches(cfg.searchesPath);
        } catch (err) {
          log.error(
            `searches.yaml reload failed, keeping previous config: ${(err as Error).message}`,
          );
        }
        const ctx = await launchContext(cfg.profileDir, cfg.headless);
        try {
          await runPoll(db, ctx, searches);
        } catch (err) {
          log.error(`poll failed: ${(err as Error).message}`);
        } finally {
          await ctx.close();
        }
        if (stop) break;
        const jitterMin = baseMin * (0.8 + Math.random() * 0.4);
        log.info(`next poll in ~${jitterMin.toFixed(0)} min`);
        const until = Date.now() + jitterMin * 60_000;
        while (!stop && Date.now() < until) await sleep(1000);
      }
      process.exit(0);
    });

  program
    .command("recheck")
    .description(
      "Re-open tracked listings to catch closed/edited ones (also runs inside each poll).",
    )
    .option("-n, --limit <n>", "how many to re-check", (v) => parseInt(v, 10), 20)
    .action(async (opts: { limit: number }) => {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      log.info(`logging to ${logFilePath()}`);
      const rows = trackedForRecheck(db, opts.limit);
      if (rows.length === 0) {
        log.info("nothing to recheck.");
        return;
      }
      log.info(`rechecking ${rows.length} listing(s)…`);
      const ctx = await launchContext(cfg.profileDir, cfg.headless);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      let gone = 0;
      let changed = 0;
      try {
        for (const row of rows) {
          await pause(PACE.detailGapMin, PACE.detailGapSpan);
          const detail = await scrapeDetail(page, row.fb_id);
          if (detail.unavailable) {
            setAvailability(db, row.fb_id, "unavailable");
            gone += 1;
            log.info(`recheck ${row.fb_id}: GONE — ${row.title ?? ""}`);
            continue;
          }
          const change = applyRecheck(db, row.fb_id, {
            price: null,
            description: detail.text,
          });
          if (change) {
            changed += 1;
            log.info(`recheck ${row.fb_id}: CHANGED — ${change}`);
          }
        }
      } finally {
        await ctx.close();
      }
      log.info(`recheck done — ${changed} changed, ${gone} gone`);
    });
}
