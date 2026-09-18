import { createServer, type IncomingMessage } from "node:http";
import type { DB } from "./db/index.js";
import { queryListings } from "./db/listings.js";
import { log } from "./log.js";
import { distinctSearches, selectItems, type SortField } from "./reporting/query.js";
import { pageShell, renderRows } from "./reporting/html/index.js";
import { handleCandidateAction } from "./serve-actions.js";

/** Small JSON body reader — one POST route with a tiny `{comment?}` payload
 *  doesn't warrant a body-parsing dependency. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

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
    const actionMatch = path?.match(/^\/listings\/([^/]+)\/actions\/([^/]+)$/);
    if (req.method === "POST" && actionMatch) {
      const [, fbId, action] = actionMatch;
      readJsonBody(req)
        .then((body) => {
          const result = handleCandidateAction(
            db,
            decodeURIComponent(fbId!),
            decodeURIComponent(action!),
            body,
          );
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.body));
        })
        .catch((err) => {
          log.error(`serve action: ${(err as Error).message}`);
          res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
        });
      return;
    }
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
