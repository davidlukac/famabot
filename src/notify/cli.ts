import type { ListingRow } from "../types.js";

function fmtPrice(row: Pick<ListingRow, "price" | "currency">): string {
  if (row.price == null) return "—";
  return `${row.currency ?? ""}${row.price}`.trim();
}

function truncate(s: string | null, n: number): string {
  if (!s) return "—";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/** Print a compact table of candidate listings after a poll. */
export function renderCandidatesTable(rows: ListingRow[]): void {
  if (rows.length === 0) {
    console.log("No new candidates this run.");
    return;
  }
  console.log(`\n${rows.length} new candidate(s):\n`);
  for (const r of rows) {
    const score = r.eval_score != null ? r.eval_score.toFixed(2) : "—";
    console.log(`  ● ${truncate(r.title, 60)}`);
    console.log(
      `    ${fmtPrice(r)}  ·  fit ${score}  ·  ${r.location ?? "location?"}  ·  ${r.fb_id}`,
    );
    console.log(`    ${truncate(r.eval_reasoning, 140)}`);
    console.log(`    ${r.url}\n`);
  }
}

/** Print the pipeline as a table (used by `famabot list`). */
export function renderListTable(rows: ListingRow[]): void {
  if (rows.length === 0) {
    console.log("Nothing matches.");
    return;
  }
  const data = rows.map((r) => ({
    id: r.fb_id,
    phase: r.phase,
    fit: r.eval_score != null ? r.eval_score.toFixed(2) : "",
    price: fmtPrice(r),
    title: truncate(r.title, 44),
    search: r.search_key,
  }));
  console.table(data);
}
