import type { Page, Response } from "playwright";
import type { Criteria, RawListing, Search } from "../types.js";
import { log } from "../log.js";
import {
  PACE,
  pause,
  pickScrollRounds,
  nextStaleStreak,
  shouldKeepScrolling,
} from "../pace.js";
import { collectListings, idFromHref } from "./parse.js";
import { extractExternalLinks } from "../shared/links.js";

/** Turn "Berlin, Germany" into the slug FB uses in /marketplace/<slug>/... */
function citySlug(location: string | undefined): string {
  if (!location) return "nearby";
  return (
    location
      .split(",")[0]!
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "") || "nearby"
  );
}

/**
 * Build a Marketplace search URL.
 *
 * Facebook only reliably scopes a search by location when given coordinates
 * (`latitude`/`longitude`/`radius`) — the `/marketplace/<city-slug>/` path is
 * frequently redirected to a generic, IP-based category page that silently drops
 * every filter. So: if `criteria.lat`/`lng` are set we use the coordinate form;
 * otherwise we fall back to the slug form and warn at scrape time if FB redirects
 * us. The surest fix for a stubborn location is to set it once by hand in the
 * browser during `famabot login` — the account remembers it.
 */
export function buildSearchUrl(search: Search): string {
  const c: Criteria = search.criteria;
  const category = search.category || "propertyrentals";
  const params = new URLSearchParams();

  if (c.minPrice != null) params.set("minPrice", String(c.minPrice));
  if (c.maxPrice != null) params.set("maxPrice", String(c.maxPrice));
  if (category.startsWith("property")) {
    if (c.minBedrooms != null) params.set("minBedrooms", String(c.minBedrooms));
    if (c.maxBedrooms != null) params.set("maxBedrooms", String(c.maxBedrooms));
  }
  if (category === "vehicles") {
    // NB: param names taken from FB's vehicle filter UI, not exhaustively
    // verified live — if a poll log shows these being dropped, re-check
    // against a manually filtered vehicle search URL.
    if (c.minYear != null) params.set("minYear", String(c.minYear));
    if (c.maxYear != null) params.set("maxYear", String(c.maxYear));
  }
  // Newest-listed first, and (if asked) only recently posted ones. FB's
  // "Date listed" filter only has 1 / 7 / 30-day buckets, so snap to those.
  params.set("sortBy", "creation_time_descend");
  if (c.maxAgeDays != null) {
    const bucket = c.maxAgeDays <= 1 ? 1 : c.maxAgeDays <= 7 ? 7 : 30;
    params.set("daysSinceListed", String(bucket));
  }
  params.set("exact", "false");
  if (search.query) params.set("query", search.query);

  let base: string;
  if (c.lat != null && c.lng != null) {
    base = `https://www.facebook.com/marketplace/category/${category}`;
    params.set("latitude", c.lat.toFixed(4));
    params.set("longitude", c.lng.toFixed(4));
    params.set("radius", String(Math.round(c.radiusKm ?? 40)));
  } else {
    base = `https://www.facebook.com/marketplace/${citySlug(c.location)}/${category}`;
    if (c.radiusKm != null) params.set("radiusKM", String(c.radiusKm));
  }
  return `${base}?${params.toString()}`;
}

/** Did FB honour the location/params we asked for, or bounce us to a generic page? */
export function looksRedirected(requested: string, landed: string): boolean {
  try {
    const a = new URL(requested);
    const b = new URL(landed);
    const askedCoords = a.searchParams.has("latitude");
    const keptCoords = b.searchParams.has("latitude");
    if (askedCoords && !keptCoords) return true;
    // slug form: /marketplace/<slug>/<cat> -> /marketplace/category/<cat>
    const askedSlug = a.pathname.match(/^\/marketplace\/(?!category\/)([^/]+)\//);
    if (askedSlug && b.pathname.startsWith("/marketplace/category/")) return true;
    return false;
  } catch {
    return false;
  }
}

const jitter = (minMs: number, maxMs: number) =>
  new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));

/**
 * Scrape one search results page. Primary strategy: capture GraphQL responses
 * as they stream in. Fallback: parse anchor tags from the DOM.
 */
export async function scrapeSearch(
  page: Page,
  url: string,
  cap = PACE.listingCap,
): Promise<RawListing[]> {
  const fromGraphql = new Map<string, RawListing>();
  let gqlResponses = 0;

  const onResponse = async (res: Response) => {
    if (!res.url().includes("/api/graphql")) return;
    gqlResponses += 1;
    try {
      const body = await res.text();
      // A single response can contain several concatenated JSON objects.
      for (const chunk of body.split(/\r?\n(?=\{)/)) {
        const trimmed = chunk.trim();
        if (!trimmed.startsWith("{")) continue;
        let json: unknown;
        try {
          json = JSON.parse(trimmed);
        } catch {
          continue;
        }
        for (const rl of collectListings(json)) {
          if (!fromGraphql.has(rl.fbId)) fromGraphql.set(rl.fbId, rl);
        }
      }
    } catch {
      /* response body not available — ignore */
    }
  };

  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await pause(PACE.settleMin, PACE.settleSpan);
    const landed = page.url();
    log.debug(`landed on ${landed} — ${fromGraphql.size} listing(s) so far`);
    if (looksRedirected(url, landed)) {
      log.warn(
        `Facebook redirected the search and dropped the location/filters — ` +
          `results will NOT be scoped as configured. Set criteria.lat/lng, or ` +
          `set your Marketplace location by hand once via \`famabot login\`.`,
      );
    }
    // Scroll slowly to trigger pagination requests. Round count varies per
    // poll (real users don't scroll the same amount every visit), and the
    // loop gives up early once a few rounds in a row surface nothing new
    // (mimics recognizing the same old listings and stopping).
    const maxRounds = pickScrollRounds(PACE.scrollRoundsMin, PACE.scrollRoundsMax);
    let staleStreak = 0;
    let prevSize = fromGraphql.size;
    for (
      let i = 0;
      shouldKeepScrolling({
        round: i,
        maxRounds,
        size: fromGraphql.size,
        cap,
        staleStreak,
        staleLimit: PACE.scrollStaleLimit,
      });
      i++
    ) {
      await pause(PACE.scrollPauseMin, PACE.scrollPauseSpan);
      await page.mouse.wheel(0, 3000 + Math.random() * 2000);
      const size = fromGraphql.size;
      staleStreak = nextStaleStreak(i, size, prevSize, staleStreak);
      prevSize = size;
      log.debug(
        `scroll ${i + 1}/${maxRounds} — ${size} listing(s)` +
          (staleStreak > 0 ? ` (no new ones x${staleStreak})` : ""),
      );
    }
    await pause(PACE.settleMin, PACE.settleSpan);
  } finally {
    page.off("response", onResponse);
  }

  let listings = [...fromGraphql.values()];
  log.debug(
    `${gqlResponses} graphql response(s) seen; ${listings.length} listing node(s) parsed`,
  );

  if (listings.length === 0) {
    log.warn("no listings from graphql — falling back to DOM scrape");
    listings = await domFallback(page);
    log.debug(`DOM fallback found ${listings.length} listing(s)`);
  }

  // FB's own ordering is unreliable — keep the genuinely newest `cap` by post date.
  listings.sort((a, b) => {
    const at = a.postedAt ? Date.parse(a.postedAt) : 0;
    const bt = b.postedAt ? Date.parse(b.postedAt) : 0;
    return bt - at;
  });
  return listings.slice(0, cap);
}

/** Last-resort DOM scrape when no GraphQL listing data was seen. */
async function domFallback(page: Page): Promise<RawListing[]> {
  const anchors = await page.$$eval('a[href*="/marketplace/item/"]', (els) =>
    els.map((el) => ({
      href: (el as HTMLAnchorElement).href,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
  const out = new Map<string, RawListing>();
  for (const a of anchors) {
    const id = idFromHref(a.href);
    if (!id || out.has(id)) continue;
    const priceMatch = a.text.match(/(?:[€$£]\s?|\bEUR\s?|\bUSD\s?)([\d.,]+)/i);
    out.set(id, {
      fbId: id,
      url: `https://www.facebook.com/marketplace/item/${id}/`,
      title:
        a.text.replace(/(?:[€$£]\s?|\bEUR\s?|\bUSD\s?)[\d.,]+/i, "").trim() || null,
      price: priceMatch ? Number(priceMatch[1]!.replace(/[.,]/g, "")) : null,
      currency: null,
      location: null,
      imageUrl: null,
      postedAt: null,
      description: null,
      raw: { source: "dom-fallback", text: a.text },
    });
  }
  return [...out.values()];
}

const GONE_RE =
  /(no longer available|isn.?t available|content isn.?t available|this listing (has been|was) (sold|removed|deleted)|marketplace listing (isn.?t|is not) available|page isn.?t available)/i;

export interface DetailResult {
  /** Cleaned main-column text, or null if nothing usable. */
  text: string | null;
  /** True when the page says the listing is gone / sold / removed. */
  unavailable: boolean;
  /** http/https URLs found in the listing text (off-platform links). */
  links: string[];
}

/** Open a listing's detail page: description text, availability, embedded links. */
export async function scrapeDetail(page: Page, fbId: string): Promise<DetailResult> {
  const url = `https://www.facebook.com/marketplace/item/${fbId}/`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await jitter(1500, 3000);
    const landed = page.url().replace(/\/+$/, "");
    if (landed === "https://www.facebook.com/marketplace") {
      return { text: null, unavailable: true, links: [] };
    }
    const seeMore = page.getByRole("button", { name: /see more/i }).first();
    if (await seeMore.isVisible().catch(() => false)) {
      await seeMore.click().catch(() => {});
      await jitter(400, 900);
    }

    const fullText = await page
      .locator("main, [role='main']")
      .first()
      .innerText()
      .catch(() => "");

    // The seller's description is the single longest dir="auto" text block on the
    // page — targeting it directly avoids the rotating "related listings" carousel
    // and seller card that made whole-page diffs unstable.
    const autoBlocks = await page
      .locator("main [dir='auto']")
      .allInnerTexts()
      .catch(() => [] as string[]);
    let desc = "";
    for (const b of autoBlocks) {
      const c = b.replace(/\s+/g, " ").trim();
      if (c.length > desc.length && !GONE_RE.test(c)) desc = c;
    }
    if (desc.length < 40) {
      // Fallback: cleaned page text.
      desc = fullText
        .replace(/\s+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const links = extractExternalLinks(desc);
    return {
      text: desc ? desc.slice(0, 6000) : null,
      unavailable: GONE_RE.test(fullText),
      links,
    };
  } catch {
    return { text: null, unavailable: false, links: [] };
  }
}

export { jitter };
