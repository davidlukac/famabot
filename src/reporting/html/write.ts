import { writeFileSync } from "node:fs";
import { distinctSearches, type BrowseItem } from "../query.js";
import { renderRows } from "./rows.js";
import { pageShell } from "./shell.js";

export function writeHtml(items: BrowseItem[], path: string): void {
  writeFileSync(
    path,
    pageShell({
      rows: renderRows(items),
      count: items.length,
      searchKeys: distinctSearches(items),
    }),
  );
}
