import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchesFileSchema, CriteriaSchema, SearchSchema } from "./types.js";

test("CriteriaSchema: mustHaves/niceToHaves/dealBreakers default to []", () => {
  const parsed = CriteriaSchema.parse({});
  assert.deepEqual(parsed.mustHaves, []);
  assert.deepEqual(parsed.niceToHaves, []);
  assert.deepEqual(parsed.dealBreakers, []);
});

test("CriteriaSchema: accepts a full rental config, including minYear/maxYear", () => {
  const parsed = CriteriaSchema.parse({
    location: "Mission, BC",
    lat: 49.131,
    lng: -122.314,
    radiusKm: 30,
    minPrice: 1000,
    maxPrice: 3000,
    minBedrooms: 3,
    minYear: 2005,
    maxYear: 2015,
    mustHaves: ["a"],
    dealBreakers: ["b"],
    niceToHaves: ["c"],
    notes: "note",
  });
  assert.equal(parsed.minYear, 2005);
  assert.equal(parsed.maxYear, 2015);
});

test("SearchSchema: key must be kebab-case", () => {
  const base = { key: "ok-key", criteria: {} };
  assert.doesNotThrow(() => SearchSchema.parse(base));
  assert.throws(() => SearchSchema.parse({ ...base, key: "Not Kebab" }));
  assert.throws(() => SearchSchema.parse({ ...base, key: "not_kebab" }));
});

test("SearchSchema: category/enabled/fetchDetails/persona defaults and overrides", () => {
  const defaulted = SearchSchema.parse({ key: "a", criteria: {} });
  assert.equal(defaulted.category, "propertyrentals");
  assert.equal(defaulted.enabled, true);
  assert.equal(defaulted.fetchDetails, true);
  assert.equal(defaulted.persona, undefined);

  const overridden = SearchSchema.parse({
    key: "b",
    category: "vehicles",
    enabled: false,
    persona: "a gearhead buddy",
    criteria: {},
  });
  assert.equal(overridden.category, "vehicles");
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.persona, "a gearhead buddy");
});

test("SearchesFileSchema: requires at least one search", () => {
  assert.throws(() => SearchesFileSchema.parse([]));
  assert.doesNotThrow(() => SearchesFileSchema.parse([{ key: "a", criteria: {} }]));
});
