import { z } from "zod";
import type { ListingRow, Search } from "../types.js";
import { log } from "../log.js";
import { cleanListingText } from "../scrape/clean.js";
import { extractExternalLinks } from "../shared/links.js";
import { buildSystemPrompt } from "./prompt.js";
import { getEvalProvider, sumUsage, type EvalUsage } from "./provider/index.js";
import { extractJson } from "./runner.js";

/** Identifier for the active evaluator backend — logged and stored per listing. */
export const EVAL_MODEL = getEvalProvider().model;

// Tolerant: the model sometimes omits a field or sends "" / "unknown" instead of
// null. Coerce all of that to null rather than fail the whole evaluation.
const nstr = z.preprocess(
  (v) => (v === "" || v === "unknown" || v == null ? null : v),
  z.string().nullable(),
);
const nnum = z.preprocess(
  (v) => (typeof v === "number" ? v : v == null || v === "" ? null : Number(v)),
  z.number().nullable().catch(null),
);
const nbool = z.preprocess(
  (v) => (typeof v === "boolean" ? v : v == null ? null : undefined),
  z.boolean().nullable().catch(null),
);

export const EvaluationSchema = z.object({
  verdict: z.enum(["candidate", "reject"]),
  fit_score: z.coerce.number().min(0).max(1).catch(0.5),
  reasoning: z.string().catch(""),
  // Rental fields stay typed/tolerant for backward compat; `.catchall` lets a
  // non-rental search (a vehicle, a couch, ...) add whatever fields fit it
  // (year, mileage, drivetrain, ...) without a schema change per category.
  extracted: z
    .object({
      property_type: nstr,
      bedrooms: nnum,
      monthly_price: nnum,
      currency: nstr,
      furnished: nbool,
      available_from: nstr,
      deposit: nstr,
      neighborhood: nstr,
      pets_allowed: nbool,
    })
    .partial()
    .catchall(z.unknown())
    .catch({}),
  red_flags: z.array(z.string()).catch([]),
  missing_info: z.array(z.string()).catch([]),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export interface ListingInput {
  fbId: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  location: string | null;
  posted_at: string | null;
  /** Driving minutes to the configured destination (null if not computed). */
  commute_minutes: number | null;
  commute_km: number | null;
  description: string | null;
  external_links: string[];
  url: string;
}

export function toListingInput(
  row: ListingRow,
  extra: { links?: string[] } = {},
): ListingInput {
  // Extract links from the RAW blob — an off-platform URL could sit anywhere,
  // including a line we're about to trim.
  const links = extra.links ?? extractExternalLinks(row.description);
  return {
    fbId: row.fb_id,
    title: row.title,
    price: row.price,
    currency: row.currency,
    location: row.location,
    posted_at: row.posted_at,
    commute_minutes: row.drive_min,
    commute_km: row.drive_km,
    // Strip FB page furniture (seller card, "Today's picks" carousel, …) so the
    // evaluator sees the seller's text + attribute rows + walkability, not ads.
    description: cleanListingText(row.description),
    external_links: links,
    url: row.url,
  };
}

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object (no markdown, no prose) of exactly this shape:
{
  "verdict": "candidate" | "reject",
  "fit_score": number between 0 and 1,
  "reasoning": string (2-4 sentences, specific to this listing),
  "extracted": {
    // Pull out whatever structured facts are relevant to THIS kind of listing.
    // For a rental: property_type, bedrooms, monthly_price, currency, furnished,
    // available_from, deposit, neighborhood, pets_allowed.
    // For a vehicle: year, mileage, drivetrain, transmission, condition_notes.
    // Use null (or omit) for anything not stated. Use whichever field names
    // make sense for this listing type.
  },
  "red_flags": string[],
  "missing_info": string[]
}`;

/** An evaluation plus the token/cost accounting for the call(s) that produced it. */
export interface EvaluationResult {
  evaluation: Evaluation;
  /** Summed across retry attempts; null if the backend reported no usage. */
  usage: EvalUsage | null;
}

/**
 * Evaluate one listing against a search (criteria + persona) using the active
 * evaluator backend (`FAMABOT_EVALUATOR`: local `claude` CLI or the z.ai API).
 * Returns null when the reply could not be parsed into a valid Evaluation after
 * retrying (caller should leave the listing in `new` and try again next poll).
 */
export async function evaluateListing(
  listing: ListingInput,
  search: Search,
  opts: { attempts?: number } = {},
): Promise<EvaluationResult | null> {
  const attempts = opts.attempts ?? 2;
  const systemPrompt = buildSystemPrompt(search);
  const basePrompt = `Listing under review:\n${JSON.stringify(listing, null, 2)}\n\n${OUTPUT_CONTRACT}`;

  const usages: (EvalUsage | null)[] = [];
  let prompt = basePrompt;
  for (let i = 0; i < attempts; i++) {
    const t0 = Date.now();
    log.debug(
      `eval call ${listing.fbId} (attempt ${i + 1}/${attempts}, ${prompt.length} prompt chars)`,
    );
    const reply = await getEvalProvider().complete(prompt, { systemPrompt });
    usages.push(reply.usage);
    log.debug(
      `eval reply ${listing.fbId}: ${reply.text.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    try {
      const evaluation = EvaluationSchema.parse(extractJson(reply.text));
      return { evaluation, usage: sumUsage(usages) };
    } catch (err) {
      const why =
        err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
      log.warn(`eval ${listing.fbId}: reply not usable (${why}); retrying`);
      prompt = `${basePrompt}\n\nYour previous reply could not be used (${why}). Return ONLY the JSON object.`;
    }
  }
  return null;
}
