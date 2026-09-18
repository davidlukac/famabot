import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso, type DB } from "./index.js";
import { needingReeval } from "./listings.js";

const db: DB = openDb(":memory:");

function insertRow(overrides: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    fb_id: `id-${Math.random().toString(36).slice(2)}`,
    search_key: "test",
    url: "https://example.com",
    first_seen_at: nowIso(),
    last_seen_at: nowIso(),
    phase: "candidate",
    availability: "active",
    eval_score: null,
    last_changed_at: null,
    evaluated_at: null,
    ...overrides,
  };
  const cols = Object.keys(base);
  db.prepare(
    `INSERT INTO listings (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...Object.values(base));
}

// These characterize the *current* behaviour of needingReeval — a listing is
// only returned when it has a pending change (last_changed_at set and newer
// than evaluated_at) AND passes the same phase/score eligibility rule as
// isReevalEligible. Written before refactoring needingReeval's SQL to reuse
// that predicate instead of re-expressing it, so a regression fails these.

test("needingReeval: candidate with a pending change is returned", () => {
  insertRow({
    fb_id: "a1",
    phase: "candidate",
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 10);
  assert.ok(rows.some((r) => r.fb_id === "a1"));
});

test("needingReeval: rejected below the 0.3 near-miss threshold is excluded", () => {
  insertRow({
    fb_id: "b1",
    phase: "rejected",
    eval_score: 0.2,
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 50);
  assert.ok(!rows.some((r) => r.fb_id === "b1"));
});

test("needingReeval: rejected at/above 0.3 is a near-miss and included", () => {
  insertRow({
    fb_id: "b2",
    phase: "rejected",
    eval_score: 0.3,
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 50);
  assert.ok(rows.some((r) => r.fb_id === "b2"));
});

test("needingReeval: a resolved acquisition outcome is never returned, even with a pending change", () => {
  insertRow({
    fb_id: "c1",
    phase: "acquisition_failed",
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  insertRow({
    fb_id: "c2",
    phase: "acquired_stop",
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 50);
  assert.ok(!rows.some((r) => r.fb_id === "c1" || r.fb_id === "c2"));
});

test("needingReeval: accepted (still in progress) with a pending change is returned", () => {
  insertRow({
    fb_id: "c3",
    phase: "accepted",
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 50);
  assert.ok(rows.some((r) => r.fb_id === "c3"));
});

test("needingReeval: unavailable listings are excluded regardless of phase", () => {
  insertRow({
    fb_id: "d1",
    phase: "candidate",
    availability: "unavailable",
    last_changed_at: "2026-01-02T00:00:00.000Z",
    evaluated_at: "2026-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 50);
  assert.ok(!rows.some((r) => r.fb_id === "d1"));
});

test("needingReeval: no pending change (never changed, or already re-evaluated) is excluded", () => {
  insertRow({ fb_id: "e1", phase: "candidate", last_changed_at: null });
  insertRow({
    fb_id: "e2",
    phase: "candidate",
    last_changed_at: "2026-01-01T00:00:00.000Z",
    evaluated_at: "2026-01-02T00:00:00.000Z", // evaluated AFTER the change
  });
  const rows = needingReeval(db, 50);
  assert.ok(!rows.some((r) => r.fb_id === "e1" || r.fb_id === "e2"));
});

test("needingReeval: oldest pending change first, and respects the limit", () => {
  // Dates far earlier than every other test's fixtures in this shared DB
  // (needingReeval has no per-test isolation — openDb() is a process-wide
  // singleton) so these two are guaranteed the globally-oldest pair and
  // limit=1 deterministically picks between just them.
  insertRow({
    fb_id: "f-new",
    phase: "candidate",
    last_changed_at: "2000-03-01T00:00:00.000Z",
    evaluated_at: "2000-01-01T00:00:00.000Z",
  });
  insertRow({
    fb_id: "f-old",
    phase: "candidate",
    last_changed_at: "2000-02-01T00:00:00.000Z",
    evaluated_at: "2000-01-01T00:00:00.000Z",
  });
  const rows = needingReeval(db, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fb_id, "f-old");
});
