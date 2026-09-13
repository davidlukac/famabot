import type { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { queryListings } from "../db/listings.js";
import { isPhase } from "../pipeline/phases.js";
import { selectItems, type BrowseFilters, type SortField } from "../reporting/query.js";
import { writeHtml } from "../reporting/html/index.js";
import { renderBrowse } from "../reporting/terminal.js";
import { serve } from "../serve.js";
import type { Phase } from "../types.js";
import { openInBrowser } from "./shared.js";

/** browse, serve — the two ways to look at evaluated listings. */
export function registerReportingCommands(program: Command): void {
  program
    .command("browse")
    .description(
      "Explore evaluated listings with filters + sorts; titles link to Facebook.",
    )
    .option("-p, --phase <list>", "comma-separated phases (e.g. candidate,contacted)")
    .option("-s, --search <key>", "only this search key")
    .option("--verdict <v>", "candidate | reject")
    .option("--min-score <n>", "minimum fit score (0-1)", parseFloat)
    .option("--min-price <n>", "minimum price", parseFloat)
    .option("--max-price <n>", "maximum price", parseFloat)
    .option("--min-beds <n>", "minimum bedrooms", parseInt)
    .option(
      "--max-commute <min>",
      "max drive minutes to the configured destination",
      parseFloat,
    )
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
    .option(
      "--interval <seconds>",
      "browser refresh interval",
      (v) => parseInt(v, 10),
      30,
    )
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
}
