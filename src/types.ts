import { z } from "zod";

/** A single saved search, as defined in searches.yaml. */
/** A drive-time destination to score each listing against (e.g. a train station). */
export const CommuteSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  label: z.string().optional(),
  /** Target local time, "HH:MM" — used by traffic-aware providers. */
  arriveBy: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  dayOfWeek: z
    .enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
    .optional(),
  /** Reject listings whose drive time exceeds this many minutes. */
  maxMinutes: z.number().positive().optional(),
});
export type Commute = z.infer<typeof CommuteSchema>;

export const CriteriaSchema = z.object({
  location: z.string().optional(),
  commute: CommuteSchema.optional(),
  /** Coordinates of the search centre. When set, the FB URL is scoped by lat/lng
   *  instead of the (unreliable) city slug. Get them from Google Maps etc. */
  lat: z.number().optional(),
  lng: z.number().optional(),
  radiusKm: z.number().positive().optional(),
  /** Only listings posted within this many days (FB supports ~1 / 7 / 30). */
  maxAgeDays: z.number().positive().optional(),
  minPrice: z.number().nonnegative().optional(),
  maxPrice: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  propertyType: z.string().optional(),
  minBedrooms: z.number().int().nonnegative().optional(),
  maxBedrooms: z.number().int().nonnegative().optional(),
  /** Vehicle model-year range — also drives the FB Marketplace year filter. */
  minYear: z.number().int().optional(),
  maxYear: z.number().int().optional(),
  mustHaves: z.array(z.string()).default([]),
  niceToHaves: z.array(z.string()).default([]),
  dealBreakers: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

export const SearchSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9-]+$/, "key must be kebab-case (a-z, 0-9, -)"),
  query: z.string().default(""),
  // Facebook Marketplace category slug. Common ones:
  //   propertyrentals   – rentals (enables price + bedroom filters)
  //   propertyforsale   – homes for sale
  //   search            – everything, driven purely by `query`
  //   vehicles | electronics | furniture | apparel | ... – item categories
  category: z.string().default("propertyrentals"),
  enabled: z.boolean().default(true),
  fetchDetails: z.boolean().default(true),
  /** Override the evaluator's persona for this search only. Falls back to
   *  FAMABOT_PERSONA, then the built-in default, when unset. */
  persona: z.string().optional(),
  criteria: CriteriaSchema,
});
export type Search = z.infer<typeof SearchSchema>;

export const SearchesFileSchema = z.array(SearchSchema).min(1);

/** A listing as scraped, before evaluation. */
export interface RawListing {
  fbId: string;
  url: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  location: string | null;
  imageUrl: string | null;
  /** When the seller posted it, if FB exposed a creation timestamp. */
  postedAt: string | null;
  /** Full free-text description, populated only when fetchDetails is on. */
  description: string | null;
  /** Whatever we scraped, kept verbatim for debugging / re-parsing later. */
  raw: unknown;
}

export type Availability = "active" | "unavailable" | "unknown";

/** Pipeline phases. The first three are set by the evaluator; the rest are manual. */
export const PHASES = [
  "new",
  "candidate",
  "rejected",
  "contacted",
  "visit_scheduled",
  "visited",
  "accepted",
  "declined",
] as const;
export type Phase = (typeof PHASES)[number];

export interface ListingRow {
  fb_id: string;
  search_key: string;
  url: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  location: string | null;
  image_url: string | null;
  description: string | null;
  raw_json: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string | null;
  availability: Availability;
  notified_at: string | null;
  drive_km: number | null;
  drive_min: number | null;
  phase: Phase;
  eval_verdict: "candidate" | "reject" | null;
  eval_score: number | null;
  eval_reasoning: string | null;
  eval_extracted_json: string | null;
  eval_model: string | null;
  eval_tokens_in: number | null;
  eval_tokens_out: number | null;
  eval_tokens_cached: number | null;
  eval_cost_usd: number | null;
  evaluated_at: string | null;
  phase_updated_at: string | null;
  notes: string | null;
}

export interface PhaseHistoryRow {
  id: number;
  fb_id: string;
  from_phase: string | null;
  to_phase: string;
  note: string | null;
  at: string;
}
