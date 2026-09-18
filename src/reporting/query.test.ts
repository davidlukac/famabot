import { test } from "node:test";
import assert from "node:assert/strict";
import { selectItems } from "./query.js";
import type { ListingRow } from "../types.js";

function row(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    fb_id: "1",
    search_key: "test",
    url: "https://example.com/1",
    title: "3 Beds 2 Baths - House",
    price: 2500,
    currency: "CAD",
    location: "Mission, BC",
    image_url: null,
    description: null,
    raw_json: null,
    posted_at: "2026-01-01T00:00:00.000Z",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    last_changed_at: null,
    availability: "active",
    notified_at: null,
    drive_km: null,
    drive_min: 20,
    phase: "candidate",
    eval_verdict: "candidate",
    eval_score: 0.6,
    eval_reasoning: "Solid match.",
    // Deliberately no monthly_price/currency here — toItem() prefers those
    // from the extracted JSON over row.price/currency, and most fixtures
    // below want row.price to be what actually drives the price filter/sort.
    eval_extracted_json: JSON.stringify({
      extracted: { bedrooms: 3 },
      red_flags: [],
      missing_info: [],
    }),
    eval_model: "glm-5.3-flash",
    eval_tokens_in: 1000,
    eval_tokens_out: 200,
    eval_tokens_cached: 0,
    eval_cost_usd: 0.0005,
    evaluated_at: "2026-01-01T00:00:00.000Z",
    phase_updated_at: null,
    notes: null,
    telegram_message_id: null,
    ...overrides,
  };
}

test("toItem: bedrooms comes from eval_extracted_json", () => {
  const [item] = selectItems([row()], {}, "fresh", true);
  assert.equal(item!.beds, 3);
});

test("toItem: extracted monthly_price/currency take priority over the row's own columns", () => {
  const [item] = selectItems(
    [
      row({
        price: 2500,
        currency: "CAD",
        eval_extracted_json: JSON.stringify({
          extracted: { bedrooms: 3, monthly_price: 1800, currency: "USD" },
        }),
      }),
    ],
    {},
    "fresh",
    true,
  );
  assert.equal(item!.price, 1800);
  assert.equal(item!.currency, "USD");
});

test("toItem: falls back to the row's own price/currency when not in extracted", () => {
  const [item] = selectItems(
    [row({ price: 2500, currency: "CAD" })],
    {},
    "fresh",
    true,
  );
  assert.equal(item!.price, 2500);
  assert.equal(item!.currency, "CAD");
});

test("toItem: red_flags/missing_info default to [] on unparseable extracted json", () => {
  const [item] = selectItems(
    [row({ eval_extracted_json: "not json" })],
    {},
    "fresh",
    true,
  );
  assert.deepEqual(item!.redFlags, []);
  assert.deepEqual(item!.missingInfo, []);
});

test("selectItems: excludes non-active listings by default", () => {
  const rows = [row({ fb_id: "a" }), row({ fb_id: "b", availability: "unavailable" })];
  const items = selectItems(rows, {}, "fresh", true);
  assert.deepEqual(
    items.map((i) => i.fbId),
    ["a"],
  );
});

test("selectItems: includeUnavailable keeps gone listings", () => {
  const rows = [row({ fb_id: "a" }), row({ fb_id: "b", availability: "unavailable" })];
  const items = selectItems(rows, { includeUnavailable: true }, "fresh", true);
  assert.equal(items.length, 2);
});

test("selectItems: filters by phase, search, verdict, min score, price range, beds, flagged", () => {
  const rows = [
    row({ fb_id: "a", phase: "candidate", eval_score: 0.8, price: 2000 }),
    row({ fb_id: "b", phase: "rejected", eval_verdict: "reject", eval_score: 0.1 }),
    row({ fb_id: "c", search_key: "other" }),
    row({
      fb_id: "d",
      eval_extracted_json: JSON.stringify({
        extracted: { bedrooms: 1 },
        red_flags: ["scam-ish"],
      }),
    }),
  ];
  assert.deepEqual(
    selectItems(rows, { phases: ["candidate"] }, "fresh", true).map((i) => i.fbId),
    ["a", "c", "d"],
  );
  assert.deepEqual(
    selectItems(rows, { search: "other" }, "fresh", true).map((i) => i.fbId),
    ["c"],
  );
  assert.deepEqual(
    selectItems(rows, { verdict: "reject" }, "fresh", true).map((i) => i.fbId),
    ["b"],
  );
  assert.deepEqual(
    selectItems(rows, { minScore: 0.5 }, "fresh", true).map((i) => i.fbId),
    ["a", "c", "d"], // c/d inherit the fixture's default eval_score: 0.6
  );
  assert.deepEqual(
    selectItems(rows, { maxPrice: 2000 }, "fresh", true).map((i) => i.fbId),
    ["a"],
  );
  assert.deepEqual(
    selectItems(rows, { minBeds: 3 }, "fresh", true).map((i) => i.fbId),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    selectItems(rows, { flagged: true }, "fresh", true).map((i) => i.fbId),
    ["d"],
  );
});

test("selectItems: --has matches title, reasoning, or location case-insensitively", () => {
  const rows = [
    row({ fb_id: "a", title: "Cozy Cabin", location: "Nowhere, ZZ" }),
    row({
      fb_id: "b",
      eval_reasoning: "Great commute to the station",
      location: "Nowhere, ZZ",
    }),
    row({ fb_id: "c", location: "Mission, BC" }),
    row({ fb_id: "d", title: "Nothing relevant", location: "Nowhere, ZZ" }),
  ];
  const ids = selectItems(rows, { has: "MISSION" }, "fresh", true).map((i) => i.fbId);
  assert.ok(ids.includes("c"));
  assert.ok(!ids.includes("d"));
});

test("selectItems: sorts by price ascending/descending", () => {
  const rows = [row({ fb_id: "hi", price: 3000 }), row({ fb_id: "lo", price: 1000 })];
  assert.deepEqual(
    selectItems(rows, {}, "price", false).map((i) => i.fbId),
    ["lo", "hi"],
  );
  assert.deepEqual(
    selectItems(rows, {}, "price", true).map((i) => i.fbId),
    ["hi", "lo"],
  );
});

test("selectItems: null values sort to the end regardless of direction", () => {
  const rows = [
    row({ fb_id: "known", price: 1000 }),
    row({ fb_id: "unknown", price: null }),
  ];
  assert.deepEqual(
    selectItems(rows, {}, "price", false).map((i) => i.fbId),
    ["known", "unknown"],
  );
  assert.deepEqual(
    selectItems(rows, {}, "price", true).map((i) => i.fbId),
    ["known", "unknown"],
  );
});
