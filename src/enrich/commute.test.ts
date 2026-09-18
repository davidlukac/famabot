import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCommute,
  nextOccurrence,
  createRoutingProvider,
  routingEnabled,
  RoutingProviderError,
} from "./commute.js";

const orsEnv = { FAMABOT_ROUTING: "ors", FAMABOT_ORS_KEY: "k" };

function stubFetch(
  geocodeBody: unknown,
  routeBody: unknown,
  opts: { geocodeOk?: boolean; routeOk?: boolean } = {},
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/geocode/")) {
      return new Response(JSON.stringify(geocodeBody), {
        status: opts.geocodeOk === false ? 500 : 200,
      });
    }
    return new Response(JSON.stringify(routeBody), {
      status: opts.routeOk === false ? 500 : 200,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("nextOccurrence: no dayOfWeek picks the next weekday at the given time", () => {
  const d = nextOccurrence("08:00");
  assert.ok(d > new Date());
  assert.ok(d.getDay() >= 1 && d.getDay() <= 5);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 0);
});

test("nextOccurrence: a specific dayOfWeek is honoured", () => {
  const d = nextOccurrence("09:30", "sat");
  assert.equal(d.getDay(), 6);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
});

test("nextOccurrence: defaults to 08:00 when arriveBy is omitted", () => {
  const d = nextOccurrence();
  assert.equal(d.getHours(), 8);
});

test("createRoutingProvider: null when FAMABOT_ROUTING is unset", () => {
  assert.equal(createRoutingProvider({}), null);
});

test("createRoutingProvider: null (not a silently-broken non-null) for an unrecognized value", () => {
  assert.equal(createRoutingProvider({ FAMABOT_ROUTING: "bogus" }), null);
});

test("createRoutingProvider: recognizes ors/google/mapbox case-insensitively", () => {
  assert.equal(createRoutingProvider({ FAMABOT_ROUTING: "ors" })?.name, "ors");
  assert.equal(createRoutingProvider({ FAMABOT_ROUTING: "GOOGLE" })?.name, "google");
  assert.equal(createRoutingProvider({ FAMABOT_ROUTING: "Mapbox" })?.name, "mapbox");
});

test("routingEnabled: mirrors createRoutingProvider, including the bogus-value fix", () => {
  assert.equal(routingEnabled({}), false);
  assert.equal(routingEnabled({ FAMABOT_ROUTING: "bogus" }), false);
  assert.equal(routingEnabled({ FAMABOT_ROUTING: "ors" }), true);
});

test("each provider requires its API key before making any network request", async () => {
  const ors = createRoutingProvider({ FAMABOT_ROUTING: "ors" })!;
  await assert.rejects(() => ors.geocode("Mission, BC"), RoutingProviderError);
  await assert.rejects(
    () => ors.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }, new Date()),
    RoutingProviderError,
  );

  const google = createRoutingProvider({ FAMABOT_ROUTING: "google" })!;
  await assert.rejects(() => google.geocode("Mission, BC"), RoutingProviderError);

  const mapbox = createRoutingProvider({ FAMABOT_ROUTING: "mapbox" })!;
  await assert.rejects(() => mapbox.geocode("Mission, BC"), RoutingProviderError);
});

const destination = { lat: 49.28, lng: -123.12 };

test("computeCommute: null when routing isn't configured", async () => {
  assert.equal(await computeCommute("123 Main St", destination, {}), null);
});

test("computeCommute: null for an empty/blank location", async () => {
  assert.equal(await computeCommute("   ", destination, orsEnv), null);
});

test("computeCommute: null when geocoding finds nothing", async () => {
  const { fetch } = stubFetch({ features: [] }, {});
  await withFetch(fetch, async () => {
    assert.equal(
      await computeCommute("nowhere-geocode-test-1", destination, orsEnv),
      null,
    );
  });
});

test("computeCommute: null when routing finds no route", async () => {
  const { fetch } = stubFetch(
    { features: [{ geometry: { coordinates: [-123.1, 49.2] } }] },
    { routes: [] },
  );
  await withFetch(fetch, async () => {
    assert.equal(
      await computeCommute("nowhere-geocode-test-2", destination, orsEnv),
      null,
    );
  });
});

test("computeCommute: success — rounds km/minutes, tags the provider, omits `when` for ors", async () => {
  const { fetch } = stubFetch(
    { features: [{ geometry: { coordinates: [-123.1, 49.2] } }] },
    { routes: [{ summary: { distance: 12345, duration: 962 } }] },
  );
  const result = await withFetch(fetch, () =>
    computeCommute("789 Real St, Mission", destination, orsEnv),
  );
  assert.deepEqual(result, {
    km: 12.3,
    minutes: 16,
    provider: "ors",
    approx: false,
    when: undefined,
  });
});

test("computeCommute: approx is true when the origin has no street number (city-level geocode)", async () => {
  const { fetch } = stubFetch(
    { features: [{ geometry: { coordinates: [-123.1, 49.2] } }] },
    { routes: [{ summary: { distance: 1000, duration: 60 } }] },
  );
  const result = await withFetch(fetch, () =>
    computeCommute("Mission, British Columbia", destination, orsEnv),
  );
  assert.equal(result!.approx, true);
});

test("computeCommute: a thrown/HTTP-error request is caught and returns null", async () => {
  const { fetch } = stubFetch({}, {}, { geocodeOk: false });
  await withFetch(fetch, async () => {
    assert.equal(
      await computeCommute("nowhere-geocode-test-3", destination, orsEnv),
      null,
    );
  });
});

test("computeCommute: geocode results are cached — a second lookup for the same origin doesn't re-fetch it", async () => {
  const { fetch, calls } = stubFetch(
    { features: [{ geometry: { coordinates: [-123.1, 49.2] } }] },
    { routes: [{ summary: { distance: 1000, duration: 60 } }] },
  );
  await withFetch(fetch, async () => {
    await computeCommute("cached-origin-test", destination, orsEnv);
    await computeCommute("cached-origin-test", destination, orsEnv);
  });
  const geocodeCalls = calls.filter((u) => u.includes("/geocode/"));
  assert.equal(geocodeCalls.length, 1);
});
