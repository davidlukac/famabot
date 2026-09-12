import type { RawListing } from "../types.js";

const ITEM_URL = (id: string) =>
  `https://www.facebook.com/marketplace/item/${id}/`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Pull a price + currency out of the many shapes FB uses:
 *   { amount: "1450", currency: "EUR" }
 *   { formatted_amount: "€1,450" }
 *   "€1,450/mo"
 */
function extractPrice(node: Record<string, unknown>): {
  price: number | null;
  currency: string | null;
} {
  const lp = node.listing_price ?? node.price ?? node.formatted_price;
  if (isRecord(lp)) {
    const price =
      asNumber(lp.amount) ??
      asNumber(lp.amount_with_offset) ??
      asNumber(lp.formatted_amount) ??
      asNumber(lp.text);
    const currency =
      (typeof lp.currency === "string" && lp.currency) ||
      (typeof lp.currency_code === "string" && lp.currency_code) ||
      null;
    return { price, currency };
  }
  if (typeof lp === "string") return { price: asNumber(lp), currency: null };
  return { price: null, currency: null };
}

function extractPhoto(node: Record<string, unknown>): string | null {
  const p = node.primary_listing_photo ?? node.listing_photo ?? node.photo;
  if (isRecord(p)) {
    const img = p.image ?? p.photo_image_url ?? p.uri;
    if (isRecord(img) && typeof img.uri === "string") return img.uri;
    if (typeof img === "string") return img;
  }
  return null;
}

function looksLikeListing(node: Record<string, unknown>): boolean {
  const tn = node.__typename;
  if (
    typeof tn === "string" &&
    /GroupCommerceProductItem|MarketplaceListing|Listing/.test(tn)
  ) {
    return typeof node.id === "string" || typeof node.id === "number";
  }
  // Heuristic fallback: has an id and a price-shaped field.
  return (
    (typeof node.id === "string" || typeof node.id === "number") &&
    (isRecord(node.listing_price) || "marketplace_listing_title" in node)
  );
}

function toRawListing(node: Record<string, unknown>): RawListing | null {
  const id = node.id;
  if (id == null) return null;
  const fbId = String(id);
  if (!/^\d{5,}$/.test(fbId)) return null;

  const title =
    (typeof node.marketplace_listing_title === "string" &&
      node.marketplace_listing_title) ||
    (typeof node.custom_title === "string" && node.custom_title) ||
    (typeof node.title === "string" && node.title) ||
    null;

  const { price, currency } = extractPrice(node);

  let location: string | null = null;
  const loc = node.location ?? node.location_text;
  if (isRecord(loc)) {
    if (typeof loc.reverse_geocode === "object" && loc.reverse_geocode) {
      const rg = loc.reverse_geocode as Record<string, unknown>;
      location =
        (typeof rg.city_page === "object" &&
          rg.city_page &&
          typeof (rg.city_page as Record<string, unknown>).display_name ===
            "string" &&
          ((rg.city_page as Record<string, unknown>).display_name as string)) ||
        (typeof rg.city === "string" ? rg.city : null);
    }
  } else if (typeof loc === "string") {
    location = loc;
  }

  const ct =
    node.creation_time ??
    node.listing_creation_time ??
    node.creationTime ??
    (isRecord(node.story) ? node.story.creation_time : undefined);
  const postedAt =
    typeof ct === "number" && ct > 1_000_000_000
      ? new Date((ct < 1e12 ? ct * 1000 : ct)).toISOString()
      : null;

  return {
    fbId,
    url: ITEM_URL(fbId),
    title,
    price,
    currency,
    location,
    imageUrl: extractPhoto(node),
    postedAt,
    description: null,
    raw: node,
  };
}

/** Recursively walk an arbitrary GraphQL payload collecting listing-shaped nodes. */
export function collectListings(payload: unknown): RawListing[] {
  const out = new Map<string, RawListing>();
  const seen = new Set<unknown>();

  const walk = (v: unknown): void => {
    if (!isRecord(v) || seen.has(v)) return;
    seen.add(v);
    if (looksLikeListing(v)) {
      const rl = toRawListing(v);
      if (rl && !out.has(rl.fbId)) out.set(rl.fbId, rl);
    }
    for (const key of Object.keys(v)) walk(v[key]);
    if (Array.isArray(v)) for (const item of v) walk(item);
  };

  walk(payload);
  return [...out.values()];
}

/** Parse a marketplace item id out of an href like /marketplace/item/12345/ */
export function idFromHref(href: string): string | null {
  const m = href.match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1]! : null;
}
