import type { ListingRow, Phase } from "../types.js";
import { extractExternalLinks } from "../shared/links.js";

export interface BrowseFilters {
  phases?: Phase[];
  search?: string;
  verdict?: "candidate" | "reject";
  minScore?: number;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  sinceDays?: number;
  has?: string;
  flagged?: boolean;
  /** Max drive minutes to the configured destination. */
  maxCommute?: number;
  /** Include listings marked unavailable/unknown (hidden by default). */
  includeUnavailable?: boolean;
}

export type SortField =
  "fresh" | "score" | "price" | "beds" | "seen" | "title" | "phase";

export interface BrowseItem {
  fbId: string;
  url: string;
  title: string;
  phase: Phase;
  verdict: string;
  score: number | null;
  price: number | null;
  currency: string;
  beds: number | null;
  driveMin: number | null;
  location: string;
  availability: string;
  /** Days since first indexed. */
  ageDays: number;
  /** Days since the freshest signal (posted / edited / first seen). */
  freshDays: number;
  /** Epoch ms of the freshest signal — bigger = fresher. */
  freshMs: number;
  changed: boolean;
  links: string[];
  redFlags: string[];
  missingInfo: string[];
  reasoning: string;
  /** Evaluator model id + token/cost accounting for the eval (zai backend only). */
  evalModel: string;
  evalCostUsd: number | null;
  evalTokensIn: number | null;
  evalTokensOut: number | null;
  evalTokensCached: number | null;
  /** Structured fields the agent pulled out of the listing. */
  extracted: Record<string, unknown>;
  /** Full seller description text (may be long). */
  description: string;
  search: string;
  /** ISO timestamps + epoch ms for the three date columns. */
  indexedAt: string;
  indexedMs: number;
  postedAt: string | null;
  postedMs: number;
  updatedAt: string | null;
  updatedMs: number;
}

interface Extracted {
  extracted?: Record<string, unknown> & {
    bedrooms?: number | null;
    monthly_price?: number | null;
    currency?: string | null;
    neighborhood?: string | null;
  };
  red_flags?: string[];
  missing_info?: string[];
}

function parseExtracted(row: ListingRow): Extracted {
  if (!row.eval_extracted_json) return {};
  try {
    return JSON.parse(row.eval_extracted_json) as Extracted;
  } catch {
    return {};
  }
}

const ms = (s: string | null): number => (s ? new Date(s).getTime() : 0);

function toItem(row: ListingRow): BrowseItem {
  const ex = parseExtracted(row);
  const price = ex.extracted?.monthly_price ?? row.price ?? null;
  const freshMs = Math.max(
    ms(row.posted_at),
    ms(row.last_changed_at),
    ms(row.first_seen_at),
  );
  const links = extractExternalLinks(row.description);
  return {
    fbId: row.fb_id,
    url: row.url,
    title: (row.title ?? "(untitled)").replace(/\s+/g, " ").trim(),
    phase: row.phase,
    verdict: row.eval_verdict ?? "",
    score: row.eval_score,
    price,
    currency: ex.extracted?.currency ?? row.currency ?? "",
    beds: ex.extracted?.bedrooms ?? null,
    driveMin: row.drive_min,
    location: (row.location ?? ex.extracted?.neighborhood ?? "").trim(),
    availability: row.availability ?? "active",
    ageDays: (Date.now() - ms(row.first_seen_at)) / 86_400_000,
    freshDays: (Date.now() - freshMs) / 86_400_000,
    freshMs,
    changed: Boolean(row.last_changed_at),
    links,
    redFlags: ex.red_flags ?? [],
    missingInfo: ex.missing_info ?? [],
    reasoning: (row.eval_reasoning ?? "").replace(/\s+/g, " ").trim(),
    evalModel: row.eval_model ?? "",
    evalCostUsd: row.eval_cost_usd,
    evalTokensIn: row.eval_tokens_in,
    evalTokensOut: row.eval_tokens_out,
    evalTokensCached: row.eval_tokens_cached,
    extracted: ex.extracted ?? {},
    description: (row.description ?? "").slice(0, 4000),
    search: row.search_key,
    indexedAt: row.first_seen_at,
    indexedMs: ms(row.first_seen_at),
    postedAt: row.posted_at,
    postedMs: ms(row.posted_at),
    updatedAt: row.last_changed_at,
    updatedMs: ms(row.last_changed_at),
  };
}

export function selectItems(
  rows: ListingRow[],
  f: BrowseFilters,
  sort: SortField,
  desc: boolean,
): BrowseItem[] {
  let items = rows.map(toItem);

  if (!f.includeUnavailable) items = items.filter((i) => i.availability === "active");
  if (f.phases?.length) items = items.filter((i) => f.phases!.includes(i.phase));
  if (f.search) items = items.filter((i) => i.search === f.search);
  if (f.verdict) items = items.filter((i) => i.verdict === f.verdict);
  if (f.minScore != null) items = items.filter((i) => (i.score ?? -1) >= f.minScore!);
  if (f.minPrice != null)
    items = items.filter((i) => i.price != null && i.price >= f.minPrice!);
  if (f.maxPrice != null)
    items = items.filter((i) => i.price != null && i.price <= f.maxPrice!);
  if (f.minBeds != null)
    items = items.filter((i) => i.beds != null && i.beds >= f.minBeds!);
  if (f.maxCommute != null)
    items = items.filter((i) => i.driveMin != null && i.driveMin <= f.maxCommute!);
  if (f.sinceDays != null) items = items.filter((i) => i.freshDays <= f.sinceDays!);
  if (f.flagged) items = items.filter((i) => i.redFlags.length > 0);
  if (f.has) {
    const q = f.has.toLowerCase();
    items = items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.reasoning.toLowerCase().includes(q) ||
        i.location.toLowerCase().includes(q),
    );
  }

  const dir = desc ? -1 : 1;
  const nl = (v: number | null) => (v == null ? (desc ? -Infinity : Infinity) : v);
  items.sort((a, b) => {
    switch (sort) {
      case "price":
        return dir * (nl(a.price) - nl(b.price));
      case "beds":
        return dir * (nl(a.beds) - nl(b.beds));
      case "seen":
        return dir * (a.ageDays - b.ageDays);
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "phase":
        return dir * a.phase.localeCompare(b.phase);
      case "score":
        return dir * (nl(a.score) - nl(b.score));
      case "fresh":
      default:
        return dir * (a.freshMs - b.freshMs);
    }
  });
  return items;
}

export function distinctSearches(items: BrowseItem[]): string[] {
  return [...new Set(items.map((i) => i.search))].sort();
}
