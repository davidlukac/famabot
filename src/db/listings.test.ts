import { test } from "node:test";
import assert from "node:assert/strict";
import { isReevalEligible } from "./listings.js";
import type { ListingRow } from "../types.js";

function row(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    fb_id: "1",
    search_key: "test",
    url: "https://example.com",
    title: null,
    price: null,
    currency: null,
    location: null,
    image_url: null,
    description: null,
    raw_json: null,
    posted_at: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    last_changed_at: null,
    availability: "active",
    notified_at: null,
    drive_km: null,
    drive_min: null,
    phase: "candidate",
    eval_verdict: "candidate",
    eval_score: 0.5,
    eval_reasoning: null,
    eval_extracted_json: null,
    eval_model: null,
    eval_tokens_in: null,
    eval_tokens_out: null,
    eval_tokens_cached: null,
    eval_cost_usd: null,
    evaluated_at: null,
    phase_updated_at: null,
    notes: null,
    telegram_message_id: null,
    ...overrides,
  };
}

test("isReevalEligible: candidate is eligible", () => {
  assert.equal(isReevalEligible(row({ phase: "candidate" })), true);
});

test("isReevalEligible: accepted is still in progress, so it stays eligible", () => {
  assert.equal(isReevalEligible(row({ phase: "accepted" })), true);
});

test("isReevalEligible: every acquisition outcome is the user's final call, never re-evaluated", () => {
  for (const phase of [
    "acquisition_failed",
    "acquisition_rejected",
    "acquired_continue",
    "acquired_stop",
  ] as const) {
    assert.equal(isReevalEligible(row({ phase })), false, phase);
  }
});

test("isReevalEligible: rejected only if it was a near-miss (score >= 0.3)", () => {
  assert.equal(isReevalEligible(row({ phase: "rejected", eval_score: 0.3 })), true);
  assert.equal(isReevalEligible(row({ phase: "rejected", eval_score: 0.29 })), false);
  assert.equal(isReevalEligible(row({ phase: "rejected", eval_score: null })), false);
});

test("isReevalEligible: unavailable listings are skipped regardless of phase", () => {
  assert.equal(
    isReevalEligible(row({ phase: "candidate", availability: "unavailable" })),
    false,
  );
});
