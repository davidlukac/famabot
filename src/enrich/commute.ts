import { log } from "../log.js";
import type { Commute } from "../types.js";

export interface CommuteResult {
  km: number;
  minutes: number;
  provider: string;
  /** true when we could only geocode to city level, not a street address. */
  approx: boolean;
  /** the departure/target time used, if the provider is traffic-aware. */
  when?: string;
}

type LatLng = { lat: number; lng: number };
type Route = { km: number; minutes: number };

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Next future Date matching `HH:MM` on `dayOfWeek` (default: next weekday). */
export function nextOccurrence(arriveBy?: string, dayOfWeek?: string): Date {
  const now = new Date();
  const [h, m] = (arriveBy ?? "08:00").split(":").map(Number);
  const target = new Date(now);
  target.setHours(h ?? 8, m ?? 0, 0, 0);
  const wantDow = dayOfWeek ? DOW.indexOf(dayOfWeek) : -1;
  for (let i = 0; i < 8; i++) {
    if (target > now) {
      if (wantDow < 0 && target.getDay() >= 1 && target.getDay() <= 5) return target;
      if (wantDow >= 0 && target.getDay() === wantDow) return target;
    }
    target.setDate(target.getDate() + 1);
  }
  return target;
}

export class RoutingProviderError extends Error {}

/**
 * One drive-time backend: geocode a free-text address, then route between two
 * points. Swapped via `FAMABOT_ROUTING` — mirrors the same interface+factory
 * shape as the evaluator backends in `evaluate/provider.ts`, rather than the
 * inline string-switch this module used to have.
 */
interface RoutingProvider {
  readonly name: string;
  geocode(query: string): Promise<LatLng | null>;
  route(from: LatLng, to: LatLng, when: Date): Promise<Route | null>;
}

/** Throws unless `apiKey` is set — the API-key check every provider needs first. */
function requireKey(apiKey: string | undefined, envVar: string): string {
  if (!apiKey) throw new RoutingProviderError(`${envVar} not set`);
  return apiKey;
}

/* ---------------- OpenRouteService (open, free key, no traffic) --------------- */

const ORS_BASE = "https://api.openrouteservice.org";

class OrsProvider implements RoutingProvider {
  readonly name = "ors";
  constructor(private readonly apiKey: string | undefined) {}

  async geocode(q: string): Promise<LatLng | null> {
    const key = requireKey(this.apiKey, "FAMABOT_ORS_KEY");
    const u = `${ORS_BASE}/geocode/search?api_key=${key}&size=1&boundary.country=CA&text=${encodeURIComponent(q)}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`ORS geocode HTTP ${r.status}`);
    const j = (await r.json()) as {
      features?: { geometry: { coordinates: [number, number] } }[];
    };
    const c = j.features?.[0]?.geometry.coordinates;
    return c ? { lat: c[1], lng: c[0] } : null;
  }

  async route(from: LatLng, to: LatLng): Promise<Route | null> {
    const key = requireKey(this.apiKey, "FAMABOT_ORS_KEY");
    const r = await fetch(`${ORS_BASE}/v2/directions/driving-car`, {
      method: "POST",
      headers: { Authorization: key, "content-type": "application/json" },
      body: JSON.stringify({
        coordinates: [
          [from.lng, from.lat],
          [to.lng, to.lat],
        ],
      }),
    });
    if (!r.ok) throw new Error(`ORS route HTTP ${r.status}`);
    const j = (await r.json()) as {
      routes?: { summary: { distance: number; duration: number } }[];
    };
    const s = j.routes?.[0]?.summary;
    return s ? { km: s.distance / 1000, minutes: s.duration / 60 } : null;
  }
}

/* ---------------- Google Routes API (traffic-aware, free credit) ------------- */

class GoogleProvider implements RoutingProvider {
  readonly name = "google";
  constructor(private readonly apiKey: string | undefined) {}

  async geocode(q: string): Promise<LatLng | null> {
    const key = requireKey(this.apiKey, "FAMABOT_GOOGLE_KEY");
    const u = `https://maps.googleapis.com/maps/api/geocode/json?key=${key}&address=${encodeURIComponent(q)}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Google geocode HTTP ${r.status}`);
    const j = (await r.json()) as {
      results?: { geometry: { location: { lat: number; lng: number } } }[];
    };
    return j.results?.[0]?.geometry.location ?? null;
  }

  async route(from: LatLng, to: LatLng, when: Date): Promise<Route | null> {
    const key = requireKey(this.apiKey, "FAMABOT_GOOGLE_KEY");
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: when.toISOString(),
      }),
    });
    if (!r.ok) throw new Error(`Google route HTTP ${r.status}`);
    const j = (await r.json()) as {
      routes?: { duration: string; distanceMeters: number }[];
    };
    const rt = j.routes?.[0];
    if (!rt) return null;
    return {
      km: rt.distanceMeters / 1000,
      minutes: Number(String(rt.duration).replace("s", "")) / 60,
    };
  }
}

/* ---------------- Mapbox (traffic-aware, generous free tier) ----------------- */

class MapboxProvider implements RoutingProvider {
  readonly name = "mapbox";
  constructor(private readonly apiKey: string | undefined) {}

  async geocode(q: string): Promise<LatLng | null> {
    const tok = requireKey(this.apiKey, "FAMABOT_MAPBOX_TOKEN");
    const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${tok}&limit=1&country=ca`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Mapbox geocode HTTP ${r.status}`);
    const j = (await r.json()) as { features?: { center: [number, number] }[] };
    const c = j.features?.[0]?.center;
    return c ? { lat: c[1], lng: c[0] } : null;
  }

  async route(from: LatLng, to: LatLng, when: Date): Promise<Route | null> {
    const tok = requireKey(this.apiKey, "FAMABOT_MAPBOX_TOKEN");
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const u =
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}` +
      `?access_token=${tok}&overview=false&depart_at=${encodeURIComponent(when.toISOString())}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Mapbox route HTTP ${r.status}`);
    const j = (await r.json()) as {
      routes?: { distance: number; duration: number }[];
    };
    const rt = j.routes?.[0];
    return rt ? { km: rt.distance / 1000, minutes: rt.duration / 60 } : null;
  }
}

/* -------------------------------- factory ------------------------------------ */

/**
 * The configured routing backend, or null if drive-time enrichment is off
 * (`FAMABOT_ROUTING` unset) or set to something unrecognized — previously an
 * unrecognized value silently made every lookup a no-op with no explanation;
 * now it's null (so `routingEnabled()` correctly reports disabled) and logs
 * once at construction.
 */
export function createRoutingProvider(
  env: NodeJS.ProcessEnv = process.env,
): RoutingProvider | null {
  const name = (env.FAMABOT_ROUTING ?? "").trim().toLowerCase();
  switch (name) {
    case "":
      return null;
    case "ors":
      return new OrsProvider(env.FAMABOT_ORS_KEY);
    case "google":
      return new GoogleProvider(env.FAMABOT_GOOGLE_KEY);
    case "mapbox":
      return new MapboxProvider(env.FAMABOT_MAPBOX_TOKEN);
    default:
      log.warn(`Unknown FAMABOT_ROUTING: "${name}" — drive-time enrichment disabled.`);
      return null;
  }
}

export function routingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return createRoutingProvider(env) !== null;
}

const geocodeCache = new Map<string, LatLng | null>();

async function geocode(rp: RoutingProvider, q: string): Promise<LatLng | null> {
  const cacheKey = `${rp.name}:${q}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)!;
  const out = await rp.geocode(q);
  geocodeCache.set(cacheKey, out);
  return out;
}

/**
 * Drive distance + time from a listing's location string to `commute` (the
 * configured destination, e.g. the train station). Returns null on any failure.
 */
export async function computeCommute(
  locationQuery: string,
  commute: Commute,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommuteResult | null> {
  const rp = createRoutingProvider(env);
  if (!rp) return null;
  const origin = (locationQuery || "").trim();
  if (!origin) return null;
  try {
    const from = await geocode(rp, origin);
    if (!from) {
      log.debug(`commute: could not geocode "${origin}"`);
      return null;
    }
    const to: LatLng = { lat: commute.lat, lng: commute.lng };
    const when = nextOccurrence(commute.arriveBy, commute.dayOfWeek);
    const r = await rp.route(from, to, when);
    if (!r) return null;
    return {
      km: Math.round(r.km * 10) / 10,
      minutes: Math.round(r.minutes),
      provider: rp.name,
      approx: !/\d/.test(origin), // no street number -> city-level geocode
      when: rp.name === "ors" ? undefined : when.toISOString(),
    };
  } catch (err) {
    log.warn(`commute lookup failed: ${(err as Error).message}`);
    return null;
  }
}
