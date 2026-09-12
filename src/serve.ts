import { createServer } from "node:http";
import type { DB } from "./db/index.js";
import { queryListings } from "./db/listings.js";
import { log } from "./log.js";
import {
  distinctSearches,
  pageShell,
  renderRows,
  selectItems,
  type SortField,
} from "./notify/browse.js";

export interface ServeOpts {
  port: number;
  intervalS: number;
  sort: SortField;
  desc: boolean;
  includeUnavailable: boolean;
}

/** Serve a live, auto-refreshing listings report on localhost. Blocks until killed. */
export function serve(db: DB, o: ServeOpts): void {
  // Always hand the browser everything (incl. gone listings); the page's filter
  // panel decides what to show, so toggles work without a server round-trip.
  const current = () =>
    selectItems(queryListings(db), { includeUnavailable: true }, o.sort, o.desc);

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/rows") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderRows(current()));
        return;
      }
      if (path === "/" || path === "/index.html") {
        const items = current();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          pageShell({
            rows: renderRows(items),
            count: items.length,
            searchKeys: distinctSearches(items),
            live: { url: "/rows", intervalS: o.intervalS },
          }),
        );
        return;
      }
      res.writeHead(404).end("not found");
    } catch (err) {
      log.error(`serve: ${(err as Error).message}`);
      res.writeHead(500).end("error");
    }
  });

  server.listen(o.port, "127.0.0.1", () => {
    log.info(
      `report live at http://localhost:${o.port}  (refreshes every ${o.intervalS}s)`,
    );
  });

  const bye = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
