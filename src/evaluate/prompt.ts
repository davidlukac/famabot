import type { Criteria, Search } from "../types.js";

/** Persona for the evaluator. Overridable via FAMABOT_PERSONA. */
export const DEFAULT_PERSONA =
  "You are the user's own buyer's agent — a sharp, straight-talking real estate " +
  "agent with years in this local market, hunting for their next home. You are " +
  "on their side: protective of their time, their budget, and their safety. You " +
  "have seen every listing trick and every scam. Be decisive — flag the places " +
  "genuinely worth a Saturday visit, and don't sugar-coat the ones that aren't.";

/**
 * Build the system prompt for the evaluator from a search. Hard constraints
 * (mustHaves, dealBreakers, price/bedroom/year bounds, property type) gate the
 * verdict; everything else feeds the fit score. `search.persona` overrides the
 * voice for this search only (falls back to FAMABOT_PERSONA, then the default) —
 * this is what lets a vehicle search sound like a gearhead and a rental search
 * sound like a buyer's agent, in the same run.
 */
export function buildSystemPrompt(search: Search): string {
  const criteria: Criteria = search.criteria;
  const persona =
    search.persona?.trim() || process.env.FAMABOT_PERSONA?.trim() || DEFAULT_PERSONA;
  const hard: string[] = [];
  const soft: string[] = [];

  if (criteria.propertyType && criteria.propertyType !== "any") {
    hard.push(`Property type must be: ${criteria.propertyType}.`);
  }
  if (criteria.minPrice != null || criteria.maxPrice != null) {
    const lo = criteria.minPrice != null ? `${criteria.minPrice}` : "any";
    const hi = criteria.maxPrice != null ? `${criteria.maxPrice}` : "any";
    const priceLine = `Price must be within ${lo}–${hi} ${criteria.currency ?? ""}`.trim();
    hard.push(
      criteria.propertyType
        ? `${priceLine}. If a listing bundles utilities/deposit into one number, judge on the base rent when discernible.`
        : `${priceLine}.`,
    );
  }
  if (criteria.minBedrooms != null) {
    hard.push(`At least ${criteria.minBedrooms} bedroom(s).`);
  }
  if (criteria.maxBedrooms != null) {
    hard.push(`At most ${criteria.maxBedrooms} bedroom(s).`);
  }
  if (criteria.minYear != null || criteria.maxYear != null) {
    const lo = criteria.minYear ?? "any";
    const hi = criteria.maxYear ?? "any";
    hard.push(`Model year must be within ${lo}–${hi}.`);
  }
  for (const m of criteria.mustHaves) hard.push(m);
  for (const d of criteria.dealBreakers) hard.push(`MUST NOT be / have: ${d}`);

  if (criteria.location) {
    soft.push(
      `Prefer places in or near ${criteria.location}` +
        (criteria.radiusKm ? ` (within ~${criteria.radiusKm} km)` : "") +
        ".",
    );
  }
  if (criteria.commute) {
    const c = criteria.commute;
    const dest = c.label ?? `${c.lat},${c.lng}`;
    const at = c.arriveBy
      ? ` (drive time is estimated for arriving around ${c.arriveBy}${c.dayOfWeek ? ` on a ${c.dayOfWeek}` : " on a weekday"})`
      : "";
    if (c.maxMinutes != null) {
      hard.push(
        `The listing's \`commute_minutes\` (drive to ${dest}${at}) must be <= ${c.maxMinutes}. ` +
          `If \`commute_minutes\` is null, do not reject on this alone — note it in missing_info.`,
      );
    } else {
      soft.push(
        `Shorter \`commute_minutes\` (drive to ${dest}${at}) is better; a long drive lowers the score.`,
      );
    }
  }
  for (const n of criteria.niceToHaves) soft.push(n);
  if (criteria.notes) soft.push(criteria.notes.trim());

  return [
    persona,
    "",
    "You are given one Facebook Marketplace listing (structured fields plus any",
    "free-text description). Decide whether it is worth the user's time to pursue.",
    "",
    "HARD CONSTRAINTS — if the listing clearly violates any of these, verdict = \"reject\":",
    hard.length ? hard.map((h) => `  - ${h}`).join("\n") : "  (none)",
    "",
    "SOFT PREFERENCES — these do not gate the verdict; they raise or lower fit_score (0..1):",
    soft.length ? soft.map((s) => `  - ${s}`).join("\n") : "  (none)",
    "",
    "RULES:",
    "  - When information is missing (e.g. a detail not stated), DO NOT reject for that.",
    "    Record what's missing in `missing_info` and evaluate on what is known.",
    "  - Only reject when a hard constraint is clearly and explicitly violated.",
    "  - `fit_score`: 0 = poor match, 1 = excellent. A borderline-but-viable listing is",
    "    still verdict = \"candidate\" with a low-ish score.",
    "  - Put concrete concerns (scam signals, agency fees, vague listing, bad location) in `red_flags`.",
    "  - You are given the listing's title, price, location, post date, the full",
    "    description text (which usually includes FB's attribute rows), and any",
    "    off-platform URLs found in it (`external_links`). You do NOT see photos.",
    "    A listing that pushes buyers to an external site/form, asks for money or",
    "    e-transfer before you've seen the item/place, or offers no way to verify it",
    "    in person, is a red flag.",
    "  - Extract structured fields into `extracted`; use null for anything not stated.",
    "  - `reasoning`: 2–4 sentences, specific to this listing.",
  ].join("\n");
}
