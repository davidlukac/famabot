import type { Command } from "commander";
import { loadConfig, loadSearches } from "../config.js";
import { openDb } from "../db/index.js";
import {
  appendNote,
  getByFbId,
  historyFor,
  queryListings,
  setPhase,
} from "../db/listings.js";
import { assertTransition, isPhase } from "../pipeline/phases.js";
import { renderListTable } from "../notify/cli.js";
import { EVAL_MODEL } from "../evaluate/evaluator.js";
import { evaluateStoreAndNotify } from "../services/evaluation-service.js";
import type { Phase } from "../types.js";
import { extractExternalLinks } from "../shared/links.js";
import { openInBrowser } from "./shared.js";

/** list, show, move, note, reevaluate, open — day-to-day pipeline management. */
export function registerPipelineCommands(program: Command): void {
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
      const links = extractExternalLinks(row.description);
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
    .action((fbId: string, phase: string, opts: { note?: string; force?: boolean }) => {
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
    });

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
          console.warn(
            `[${row.fb_id}] search "${row.search_key}" not in searches.yaml — skipped`,
          );
          continue;
        }
        // reeval:true so a manually-advanced phase (contacted, …) is preserved,
        // same protection `poll` gives it — and shares the notify-on-candidate
        // behavior with poll instead of silently skipping it.
        const outcome = await evaluateStoreAndNotify(db, row.fb_id, search, {
          reeval: true,
        });
        if (!outcome) {
          console.warn(`[${row.fb_id}] unparseable response — skipped`);
          continue;
        }
        const { evaluation: ev, usage, phase } = outcome;
        const cost = usage?.costUsd != null ? ` ~$${usage.costUsd.toFixed(4)}` : "";
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
}
