#!/usr/bin/env node
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadConfig, loadSearches } from "./config.js";
import { PACE, pause } from "./pace.js";
import { openDb } from "./db/index.js";
import {
  appendNote,
  applyRecheck,
  changedSinceNotified,
  getByFbId,
  historyFor,
  markNotified,
  queryListings,
  setAvailability,
  setEvaluation,
  setPhase,
  trackedForRecheck,
} from "./db/listings.js";
import {
  candidateMsg,
  notifyCandidate,
  notifyEnabled,
} from "./notify/push.js";
import { interactiveLogin, launchContext } from "./scrape/browser.js";
import { runPoll } from "./pipeline/poll.js";
import { serve } from "./serve.js";
import { scrapeDetail } from "./scrape/marketplace.js";
import { assertTransition, isPhase } from "./pipeline/phases.js";
import { renderListTable } from "./notify/cli.js";
import {
  renderBrowse,
  selectItems,
  writeHtml,
  type BrowseFilters,
  type SortField,
} from "./notify/browse.js";
import {
  EVAL_MODEL,
  evaluateListing,
  toListingInput,
} from "./evaluate/evaluator.js";
import type { Phase } from "./types.js";
import { initLogger, log, logFilePath } from "./log.js";

const program = new Command();
program
  .name("famabot")
  .description("Watch Facebook Marketplace searches and triage listings with an agent.")
  .version("0.1.0")
  .option("-v, --verbose", "debug-level logging (also writes to the log file)")
  .hook("preAction", (thisCmd, actionCmd) => {
    const cfg = loadConfig();
    initLogger({
      file: cfg.logPath,
      verbose: Boolean(thisCmd.opts().verbose) || cfg.verbose,
    });
    log.debug(`$ famabot ${actionCmd.name()}`, actionCmd.optsWithGlobals());
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openInBrowser(target: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  execFile(opener, [target]);
}

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
  .command("list")
  .description("Show listings in the pipeline.")
  .option("-p, --phase <phase>", "filter by phase")
  .option("-s, --search <key>", "filter by search key")
  .option("--json", "output raw JSON")
  .action((opts: { phase?: string; search?: string; json?: boolean }) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    if (opts.phase && !isPhase(opts.phase)) {
      console.error(`Unknown phase: ${opts.phase}`);
      process.exit(1);
    }
    const rows = queryListings(db, {
      phase: opts.phase as Phase | undefined,
      searchKey: opts.search,
    });
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    renderListTable(rows);
  });

program
  .command("browse")
  .description(
    "Explore evaluated listings with filters + sorts; titles link to Facebook.",
  )
  .option(
    "-p, --phase <list>",
    "comma-separated phases (e.g. candidate,contacted)",
  )
  .option("-s, --search <key>", "only this search key")
  .option("--verdict <v>", "candidate | reject")
  .option("--min-score <n>", "minimum fit score (0-1)", parseFloat)
  .option("--min-price <n>", "minimum price", parseFloat)
  .option("--max-price <n>", "maximum price", parseFloat)
  .option("--min-beds <n>", "minimum bedrooms", parseInt)
  .option("--max-commute <min>", "max drive minutes to the configured destination", parseFloat)
  .option("--since <days>", "freshest signal within N days", parseFloat)
  .option("--has <text>", "substring in title / location / reasoning")
  .option("--flagged", "only listings with red flags")
  .option("--all", "include listings that are gone / unavailable")
  .option(
    "--sort <field>",
    "fresh | score | price | beds | seen | title | phase",
    "fresh",
  )
  .option("--asc", "sort ascending")
  .option("--desc", "sort descending")
  .option("-n, --limit <n>", "cap rows shown", parseInt)
  .option("--json", "output raw JSON")
  .option("--html [path]", "write a sortable/filterable HTML report")
  .option("--open", "open the HTML report in your browser (implies --html)")
  .action(
    (opts: {
      phase?: string;
      search?: string;
      verdict?: string;
      minScore?: number;
      minPrice?: number;
      maxPrice?: number;
      minBeds?: number;
      since?: number;
      maxCommute?: number;
      has?: string;
      flagged?: boolean;
      all?: boolean;
      sort: string;
      asc?: boolean;
      desc?: boolean;
      limit?: number;
      json?: boolean;
      html?: string | boolean;
      open?: boolean;
    }) => {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);

      let phases: Phase[] | undefined;
      if (opts.phase) {
        phases = opts.phase.split(",").map((p) => p.trim()) as Phase[];
        const bad = phases.filter((p) => !isPhase(p));
        if (bad.length) {
          console.error(`Unknown phase(s): ${bad.join(", ")}`);
          process.exit(1);
        }
      }
      if (opts.verdict && opts.verdict !== "candidate" && opts.verdict !== "reject") {
        console.error("--verdict must be 'candidate' or 'reject'");
        process.exit(1);
      }
      const sortFields = [
        "fresh",
        "score",
        "price",
        "beds",
        "seen",
        "title",
        "phase",
      ];
      if (!sortFields.includes(opts.sort)) {
        console.error(`--sort must be one of: ${sortFields.join(", ")}`);
        process.exit(1);
      }
      const sort = opts.sort as SortField;
      const desc = opts.asc
        ? false
        : opts.desc
          ? true
          : !(sort === "price" || sort === "title" || sort === "phase");

      const filters: BrowseFilters = {
        phases,
        search: opts.search,
        verdict: opts.verdict as "candidate" | "reject" | undefined,
        minScore: opts.minScore,
        minPrice: opts.minPrice,
        maxPrice: opts.maxPrice,
        minBeds: opts.minBeds,
        maxCommute: opts.maxCommute,
        sinceDays: opts.since,
        has: opts.has,
        flagged: opts.flagged,
        includeUnavailable: opts.all,
      };

      let items = selectItems(queryListings(db), filters, sort, desc);
      if (opts.limit) items = items.slice(0, opts.limit);

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      const wantHtml = opts.open || opts.html !== undefined;
      if (wantHtml) {
        const path = resolve(
          typeof opts.html === "string" ? opts.html : "./.data/listings.html",
        );
        writeHtml(items, path);
        console.log(`wrote ${items.length} listing(s) to ${path}`);
        if (opts.open) openInBrowser(path);
        if (!opts.open) return;
      }
      renderBrowse(items);
    },
  );

program
  .command("serve")
  .description(
    "Serve a live, auto-refreshing HTML report on localhost (sort + filter in the page).",
  )
  .option("-P, --port <n>", "port", (v) => parseInt(v, 10), 8787)
  .option("--interval <seconds>", "browser refresh interval", (v) => parseInt(v, 10), 30)
  .action((opts: { port: number; interval: number }) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    serve(db, {
      port: opts.port,
      intervalS: Math.max(5, opts.interval),
      sort: "fresh",
      desc: true,
      includeUnavailable: true,
    });
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

program
  .command("notify")
  .description(
    "Push any candidate that hasn't been notified yet (e.g. found before ntfy was set up).",
  )
  .option("--changed", "also re-push tracked listings that changed since last notified")
  .option("--min-score <n>", "only push candidates at/above this fit score", parseFloat)
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
      await notifyCandidate(candidateMsg(row, prefix));
      markNotified(db, row.fb_id);
    }
    if (!opts.dryRun) console.log("sent.");
  });

program
  .command("show")
  .description("Show one listing in full, with its phase history.")
  .argument("<fbId>")
  .action((fbId: string) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const row = getByFbId(db, fbId);
    if (!row) {
      console.error(`No listing ${fbId}`);
      process.exit(1);
    }
    const extracted = row.eval_extracted_json
      ? JSON.parse(row.eval_extracted_json)
      : null;
    console.log(`\n${row.title ?? "(untitled)"}  [${row.fb_id}]`);
    console.log(row.url);
    console.log(
      `phase: ${row.phase}   verdict: ${row.eval_verdict ?? "—"}   fit: ${
        row.eval_score ?? "—"
      }`,
    );
    console.log(
      `price: ${row.currency ?? ""}${row.price ?? "—"}   location: ${
        row.location ?? "—"
      }   search: ${row.search_key}`,
    );
    console.log(
      `availability: ${row.availability}   posted: ${row.posted_at ?? "—"}   changed: ${row.last_changed_at ?? "—"}`,
    );
    if (row.drive_min != null)
      console.log(
        `drive to destination: ${Math.round(row.drive_min)} min / ${row.drive_km ?? "?"} km`,
      );
    console.log(
      `first seen: ${row.first_seen_at}   last seen: ${row.last_seen_at}${row.notified_at ? `   notified: ${row.notified_at}` : ""}`,
    );
    const links = [
      ...new Set((row.description ?? "").match(/https?:\/\/[^\s)"']+/gi) ?? []),
    ].filter((u) => !/facebook\.com|fbcdn\.net|fb\.me/i.test(u));
    if (links.length) console.log(`\nexternal links:\n  - ${links.join("\n  - ")}`);
    if (row.eval_reasoning) console.log(`\nreasoning:\n  ${row.eval_reasoning}`);
    if (extracted?.red_flags?.length)
      console.log(`\nred flags:\n  - ${extracted.red_flags.join("\n  - ")}`);
    if (extracted?.missing_info?.length)
      console.log(`\nmissing info:\n  - ${extracted.missing_info.join("\n  - ")}`);
    if (extracted?.extracted)
      console.log(`\nextracted:\n${JSON.stringify(extracted.extracted, null, 2)}`);
    if (row.description)
      console.log(`\ndescription:\n${row.description.slice(0, 2000)}`);
    if (row.notes) console.log(`\nnotes:\n${row.notes}`);
    const hist = historyFor(db, fbId);
    if (hist.length) {
      console.log(`\nhistory:`);
      for (const h of hist)
        console.log(
          `  ${h.at}  ${h.from_phase ?? "∅"} -> ${h.to_phase}${
            h.note ? `  (${h.note})` : ""
          }`,
        );
    }
    console.log();
  });

program
  .command("move")
  .description("Advance a listing to a new phase.")
  .argument("<fbId>")
  .argument("<phase>")
  .option("-n, --note <text>", "note to attach to the transition")
  .option("-f, --force", "skip transition validation")
  .action(
    (
      fbId: string,
      phase: string,
      opts: { note?: string; force?: boolean },
    ) => {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const row = getByFbId(db, fbId);
      if (!row) {
        console.error(`No listing ${fbId}`);
        process.exit(1);
      }
      if (!isPhase(phase)) {
        console.error(`Unknown phase: ${phase}`);
        process.exit(1);
      }
      if (!opts.force) {
        try {
          assertTransition(row.phase, phase);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }
      setPhase(db, fbId, phase, opts.note ?? (opts.force ? "forced" : null));
      console.log(`${fbId}: ${row.phase} -> ${phase}`);
    },
  );

program
  .command("note")
  .description("Append a timestamped note to a listing.")
  .argument("<fbId>")
  .argument("<text>")
  .action((fbId: string, text: string) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    if (!getByFbId(db, fbId)) {
      console.error(`No listing ${fbId}`);
      process.exit(1);
    }
    appendNote(db, fbId, text);
    console.log("noted.");
  });

program
  .command("reevaluate")
  .description("Re-run the agent on stored listings.")
  .option("-p, --phase <phase>", "only listings in this phase", "new")
  .option("-s, --search <key>", "only this search key")
  .action(async (opts: { phase: string; search?: string }) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const searches = loadSearches(cfg.searchesPath);
    if (!isPhase(opts.phase)) {
      console.error(`Unknown phase: ${opts.phase}`);
      process.exit(1);
    }
    const rows = queryListings(db, {
      phase: opts.phase as Phase,
      searchKey: opts.search,
    });
    console.log(`re-evaluating ${rows.length} listing(s) with ${EVAL_MODEL}…`);
    for (const row of rows) {
      const search = searches.find((s) => s.key === row.search_key);
      if (!search) {
        console.warn(`[${row.fb_id}] search "${row.search_key}" not in searches.yaml — skipped`);
        continue;
      }
      const res = await evaluateListing(toListingInput(row), search);
      if (!res) {
        console.warn(`[${row.fb_id}] unparseable response — skipped`);
        continue;
      }
      const { evaluation: ev, usage } = res;
      const phase = setEvaluation(db, row.fb_id, ev, EVAL_MODEL, usage);
      const cost =
        usage?.costUsd != null ? ` ~$${usage.costUsd.toFixed(4)}` : "";
      console.log(
        `[${row.fb_id}] ${ev.verdict} (fit ${ev.fit_score.toFixed(2)}) -> ${phase}${cost}`,
      );
    }
  });

program
  .command("open")
  .description("Open a listing's URL in your default browser.")
  .argument("<fbId>")
  .action((fbId: string) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const row = getByFbId(db, fbId);
    if (!row) {
      console.error(`No listing ${fbId}`);
      process.exit(1);
    }
    openInBrowser(row.url);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
