import type { BrowseItem } from "./query.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function pad(s: string, n: number): string {
  const visible = s
    // eslint-disable-next-line no-control-regex -- stripping ANSI SGR codes
    .replace(/\x1b\[[0-9;]*m/g, "")
    // eslint-disable-next-line no-control-regex -- stripping OSC 8 hyperlinks
    .replace(/\x1b\]8;;.*?\x1b\\/g, "");
  return visible.length >= n ? s : s + " ".repeat(n - visible.length);
}

const age = (d: number) => (d < 1 ? "today" : `${Math.round(d)}d`);

export function renderBrowse(items: BrowseItem[]): void {
  if (items.length === 0) {
    console.log("Nothing matches those filters.");
    return;
  }
  console.log(
    BOLD +
      pad("SCORE", 6) +
      pad("PRICE", 10) +
      pad("BD", 4) +
      pad("DRIVE", 7) +
      pad("PHASE", 16) +
      pad("FRESH", 7) +
      "TITLE" +
      RESET,
  );
  for (const i of items) {
    const score = i.score != null ? i.score.toFixed(2) : " —";
    const price = i.price != null ? `${i.currency}${i.price}`.trim() : "—";
    const beds = i.beds != null ? String(i.beds) : "—";
    const drive = i.driveMin != null ? `${Math.round(i.driveMin)}m` : "—";
    const marks =
      (i.redFlags.length ? " \x1b[33m⚑\x1b[0m" : "") +
      (i.changed ? " \x1b[36m✎\x1b[0m" : "") +
      (i.availability !== "active" ? " \x1b[31m✕\x1b[0m" : "") +
      (i.links.length ? " \x1b[35m↗\x1b[0m" : "");
    console.log(
      pad(score, 6) +
        pad(price, 10) +
        pad(beds, 4) +
        pad(drive, 7) +
        pad(i.phase, 16) +
        pad(age(i.freshDays), 7) +
        link(i.title, i.url) +
        marks,
    );
    if (i.location) console.log(DIM + "      " + i.location + RESET);
  }
  console.log(
    DIM +
      `\n${items.length} listing(s). ⚑ red flags · ✎ changed · ✕ gone · ↗ external link. Titles are links.` +
      RESET,
  );
}
