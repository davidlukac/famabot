import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, looksRedirected } from "./marketplace.js";
import type { Search } from "../types.js";

function search(overrides: Partial<Search> = {}): Search {
  return {
    key: "test",
    query: "",
    category: "propertyrentals",
    enabled: true,
    fetchDetails: true,
    criteria: {
      mustHaves: [],
      niceToHaves: [],
      dealBreakers: [],
    },
    ...overrides,
  } as Search;
}

test("buildSearchUrl: coordinate form when lat/lng are set", () => {
  const url = new URL(
    buildSearchUrl(
      search({
        criteria: { ...search().criteria, lat: 49.13, lng: -122.31, radiusKm: 30 },
      }),
    ),
  );
  assert.equal(url.pathname, "/marketplace/category/propertyrentals");
  assert.equal(url.searchParams.get("latitude"), "49.1300");
  assert.equal(url.searchParams.get("longitude"), "-122.3100");
  assert.equal(url.searchParams.get("radius"), "30");
});

test("buildSearchUrl: falls back to a city-slug path without lat/lng", () => {
  const url = new URL(
    buildSearchUrl(
      search({ criteria: { ...search().criteria, location: "Berlin, Germany" } }),
    ),
  );
  assert.equal(url.pathname, "/marketplace/berlin/propertyrentals");
  assert.equal(url.searchParams.has("latitude"), false);
});

test("buildSearchUrl: bedroom filters only apply to property* categories", () => {
  const withBeds = { ...search().criteria, minBedrooms: 2, maxBedrooms: 3 };
  const rentals = new URL(buildSearchUrl(search({ criteria: withBeds })));
  assert.equal(rentals.searchParams.get("minBedrooms"), "2");
  assert.equal(rentals.searchParams.get("maxBedrooms"), "3");

  const vehicles = new URL(
    buildSearchUrl(search({ category: "vehicles", criteria: withBeds })),
  );
  assert.equal(vehicles.searchParams.has("minBedrooms"), false);
});

test("buildSearchUrl: year filters only apply to the vehicles category", () => {
  const withYears = { ...search().criteria, minYear: 2005, maxYear: 2015 };
  const vehicles = new URL(
    buildSearchUrl(search({ category: "vehicles", criteria: withYears })),
  );
  assert.equal(vehicles.searchParams.get("minYear"), "2005");
  assert.equal(vehicles.searchParams.get("maxYear"), "2015");

  const rentals = new URL(buildSearchUrl(search({ criteria: withYears })));
  assert.equal(rentals.searchParams.has("minYear"), false);
});

test("buildSearchUrl: always sorts newest-first and carries the free-text query", () => {
  const url = new URL(buildSearchUrl(search({ query: "house for rent" })));
  assert.equal(url.searchParams.get("sortBy"), "creation_time_descend");
  assert.equal(url.searchParams.get("query"), "house for rent");
});

test("buildSearchUrl: maxAgeDays snaps to FB's 1/7/30-day buckets", () => {
  const cases: [number, string][] = [
    [1, "1"],
    [3, "7"],
    [7, "7"],
    [20, "30"],
    [90, "30"],
  ];
  for (const [days, bucket] of cases) {
    const url = new URL(
      buildSearchUrl(search({ criteria: { ...search().criteria, maxAgeDays: days } })),
    );
    assert.equal(url.searchParams.get("daysSinceListed"), bucket, `days=${days}`);
  }
});

test("looksRedirected: coordinate search silently downgraded to a generic page", () => {
  const requested =
    "https://www.facebook.com/marketplace/category/propertyrentals?latitude=49.13&longitude=-122.31";
  const landed = "https://www.facebook.com/marketplace/category/propertyrentals";
  assert.equal(looksRedirected(requested, landed), true);
});

test("looksRedirected: slug search bounced to /marketplace/category/", () => {
  const requested =
    "https://www.facebook.com/marketplace/berlin/propertyrentals?query=x";
  const landed = "https://www.facebook.com/marketplace/category/propertyrentals";
  assert.equal(looksRedirected(requested, landed), true);
});

test("looksRedirected: false when FB honoured the request", () => {
  const requested =
    "https://www.facebook.com/marketplace/category/propertyrentals?latitude=49.13&longitude=-122.31";
  const landed = requested;
  assert.equal(looksRedirected(requested, landed), false);
});
