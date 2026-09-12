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

function provider(): string {
  return (process.env.FAMABOT_ROUTING ?? "").trim().toLowerCase();
}

export function routingEnabled(): boolean {
  return provider() !== "";
}

/* ---------------- OpenRouteService (open, free key, no traffic) --------------- */

const ORS = "https://api.openrouteservice.org";

async function orsGeocode(q: string, key: string): Promise<LatLng | null> {
  const u = `${ORS}/geocode/search?api_key=${key}&size=1&boundary.country=CA&text=${encodeURIComponent(q)}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`ORS geocode HTTP ${r.status}`);
  const j = (await r.json()) as {
    features?: { geometry: { coordinates: [number, number] } }[];
  };
  const c = j.features?.[0]?.geometry.coordinates;
  return c ? { lat: c[1], lng: c[0] } : null;
}

async function orsRoute(from: LatLng, to: LatLng, key: string) {
  const r = await fetch(`${ORS}/v2/directions/driving-car`, {
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

/* ---------------- Google Routes API (traffic-aware, free credit) ------------- */

async function googleGeocode(q: string, key: string): Promise<LatLng | null> {
  const u = `https://maps.googleapis.com/maps/api/geocode/json?key=${key}&address=${encodeURIComponent(q)}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Google geocode HTTP ${r.status}`);
  const j = (await r.json()) as {
    results?: { geometry: { location: { lat: number; lng: number } } }[];
  };
  return j.results?.[0]?.geometry.location ?? null;
}

async function googleRoute(from: LatLng, to: LatLng, key: string, when: Date) {
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

/* ---------------- Mapbox (traffic-aware, generous free tier) ----------------- */

async function mapboxGeocode(q: string, tok: string): Promise<LatLng | null> {
  const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${tok}&limit=1&country=ca`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Mapbox geocode HTTP ${r.status}`);
  const j = (await r.json()) as { features?: { center: [number, number] }[] };
  const c = j.features?.[0]?.center;
  return c ? { lat: c[1], lng: c[0] } : null;
}

async function mapboxRoute(from: LatLng, to: LatLng, tok: string, when: Date) {
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

/* -------------------------------- dispatch ---------------------------------- */

const geocodeCache = new Map<string, LatLng | null>();

async function geocode(q: string): Promise<LatLng | null> {
  if (geocodeCache.has(q)) return geocodeCache.get(q)!;
  const p = provider();
  let out: LatLng | null = null;
  if (p === "ors") out = await orsGeocode(q, need("FAMABOT_ORS_KEY"));
  else if (p === "google") out = await googleGeocode(q, need("FAMABOT_GOOGLE_KEY"));
  else if (p === "mapbox") out = await mapboxGeocode(q, need("FAMABOT_MAPBOX_TOKEN"));
  geocodeCache.set(q, out);
  return out;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(`${name} not set (required for FAMABOT_ROUTING=${provider()})`);
  return v;
}

/**
 * Drive distance + time from a listing's location string to `commute` (the
 * configured destination, e.g. the train station). Returns null on any failure.
 */
export async function computeCommute(
  locationQuery: string,
  commute: Commute,
): Promise<CommuteResult | null> {
  const p = provider();
  if (!p) return null;
  const origin = (locationQuery || "").trim();
  if (!origin) return null;
  try {
    const from = await geocode(origin);
    if (!from) {
      log.debug(`commute: could not geocode "${origin}"`);
      return null;
    }
    const to: LatLng = { lat: commute.lat, lng: commute.lng };
    const when = nextOccurrence(commute.arriveBy, commute.dayOfWeek);
    let r: { km: number; minutes: number } | null = null;
    if (p === "ors") r = await orsRoute(from, to, need("FAMABOT_ORS_KEY"));
    else if (p === "google")
      r = await googleRoute(from, to, need("FAMABOT_GOOGLE_KEY"), when);
    else if (p === "mapbox")
      r = await mapboxRoute(from, to, need("FAMABOT_MAPBOX_TOKEN"), when);
    if (!r) return null;
    return {
      km: Math.round(r.km * 10) / 10,
      minutes: Math.round(r.minutes),
      provider: p,
      approx: !/\d/.test(origin), // no street number -> city-level geocode
      when: p === "ors" ? undefined : when.toISOString(),
    };
  } catch (err) {
    log.warn(`commute lookup failed: ${(err as Error).message}`);
    return null;
  }
}
