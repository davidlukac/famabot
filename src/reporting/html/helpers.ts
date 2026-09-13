export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON safe to drop into a single-quoted HTML attribute. */
export function attrJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;");
}

/** Column definitions: label + whether its data-sort is numeric. */
export const COLUMNS: { key: string; label: string; num: boolean }[] = [
  { key: "score", label: "Score", num: true },
  { key: "price", label: "Price", num: true },
  { key: "beds", label: "Bd", num: true },
  { key: "drive", label: "Drive", num: true },
  { key: "phase", label: "Phase", num: true },
  { key: "indexed", label: "Indexed", num: true },
  { key: "posted", label: "Posted", num: true },
  { key: "updated", label: "Updated", num: true },
  { key: "search", label: "Search", num: false },
  { key: "location", label: "Location", num: false },
  { key: "title", label: "Title", num: false },
  { key: "flags", label: "Flags", num: true },
  { key: "why", label: "Why", num: false },
];
/** Default sort column index ("Posted") and direction (desc). */
export const DEFAULT_SORT = 6;

export const PHASE_ORDER = [
  "new",
  "candidate",
  "contacted",
  "visit_scheduled",
  "visited",
  "accepted",
  "rejected",
  "declined",
];

export function relAge(msVal: number): string {
  if (!msVal) return "";
  const s = (Date.now() - msVal) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 14) return Math.round(s / 86400) + "d";
  if (s < 86400 * 60) return Math.round(s / (86400 * 7)) + "w";
  return Math.round(s / (86400 * 30)) + "mo";
}

export function dateCell(msVal: number, iso: string | null): string {
  const title = iso ? esc(new Date(iso).toLocaleString()) : "";
  const v = relAge(msVal);
  return `<td data-sort="${msVal}" class="num t" title="${title}">${v || "·"}</td>`;
}

export function scoreCell(s: number | null): string {
  if (s == null)
    return `<td data-sort="-1" class="num"><span class="muted">·</span></td>`;
  const cls = s >= 0.6 ? "sc-g" : s >= 0.35 ? "sc-o" : "sc-w";
  return `<td data-sort="${s}" class="num"><span class="sc ${cls}">${s.toFixed(2)}</span></td>`;
}
