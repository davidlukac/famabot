import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextOccurrence,
  createRoutingProvider,
  routingEnabled,
  RoutingProviderError,
} from "./commute.js";

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
