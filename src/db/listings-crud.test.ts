import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "./index.js";
import {
  applyRecheck,
  changedSinceNotified,
  getByFbId,
  historyFor,
  insertListing,
  markNotified,
  queryListings,
  setAvailability,
  setCommute,
  setEvaluation,
  setPhase,
  touchLastSeen,
  trackedForRecheck,
  updateEvaluation,
} from "./listings.js";
import type { Evaluation } from "../evaluate/evaluator.js";
import type { RawListing } from "../types.js";

const db = openDb(":memory:");

function raw(fbId: string, overrides: Partial<RawListing> = {}): RawListing {
  return {
    fbId,
    url: `https://example.com/${fbId}`,
    title: `listing ${fbId}`,
    price: 100,
    currency: "$",
    location: "here",
    imageUrl: null,
    postedAt: nowIso(),
    description: "a perfectly nice place with a lovely private backyard for the kids",
    raw: null,
    ...overrides,
  };
}

function evaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    verdict: "candidate",
    fit_score: 0.7,
    reasoning: "good fit",
    extracted: {},
    red_flags: [],
    missing_info: [],
    ...overrides,
  };
}

test("touchLastSeen: bumps last_seen_at", () => {
  insertListing(db, "s", raw("t1"));
  const before = getByFbId(db, "t1")!.last_seen_at;
  touchLastSeen(db, "t1");
  const after = getByFbId(db, "t1")!.last_seen_at;
  assert.ok(after >= before);
});

test("setAvailability: updates availability and last_seen_at", () => {
  insertListing(db, "s", raw("t2"));
  setAvailability(db, "t2", "unavailable");
  assert.equal(getByFbId(db, "t2")!.availability, "unavailable");
});

test("setCommute: stores drive_km/drive_min", () => {
  insertListing(db, "s", raw("t3"));
  setCommute(db, "t3", { km: 12.5, minutes: 18 });
  const row = getByFbId(db, "t3")!;
  assert.equal(row.drive_km, 12.5);
  assert.equal(row.drive_min, 18);
});

test("markNotified: sets notified_at", () => {
  insertListing(db, "s", raw("t4"));
  assert.equal(getByFbId(db, "t4")!.notified_at, null);
  markNotified(db, "t4");
  assert.ok(getByFbId(db, "t4")!.notified_at);
});

test("applyRecheck: no change returns null but still bumps last_seen_at", () => {
  insertListing(db, "s", raw("t5", { price: 500 }));
  const before = getByFbId(db, "t5")!.last_seen_at;
  const result = applyRecheck(db, "t5", { price: 500 });
  assert.equal(result, null);
  assert.ok(getByFbId(db, "t5")!.last_seen_at >= before);
});

test("applyRecheck: price change is reported and persisted", () => {
  insertListing(db, "s", raw("t6", { price: 500 }));
  const result = applyRecheck(db, "t6", { price: 600 });
  assert.match(result!, /price 500 -> 600/);
  assert.equal(getByFbId(db, "t6")!.price, 600);
  assert.ok(getByFbId(db, "t6")!.last_changed_at);
});

test("applyRecheck: relisted (posted_at changed) is reported", () => {
  insertListing(db, "s", raw("t7", { postedAt: "2026-01-01T00:00:00.000Z" }));
  const result = applyRecheck(db, "t7", { postedAt: "2026-02-01T00:00:00.000Z" });
  assert.match(result!, /relisted/);
});

test("applyRecheck: a real description edit (long enough, differs by >=6 words) is reported", () => {
  insertListing(
    db,
    "s",
    raw("t8", {
      description:
        "spacious three bedroom unit with private parking and a large sunny balcony",
    }),
  );
  const result = applyRecheck(db, "t8", {
    description:
      "spacious three bedroom unit with private parking and a brand new kitchen renovation",
  });
  assert.match(result!, /description edited/);
});

test("applyRecheck: a tiny description tweak (few words differ) is NOT reported", () => {
  insertListing(
    db,
    "s",
    raw("t9", {
      description: "spacious three bedroom unit with private parking near the school",
    }),
  );
  const result = applyRecheck(db, "t9", {
    description: "spacious three bedroom unit with private parking near the school!",
  });
  assert.equal(result, null);
});

test("applyRecheck: an old whole-page capture (seller-card chrome) is silently rebaselined, not flagged", () => {
  insertListing(
    db,
    "s",
    raw("t10", {
      description: "Seller information\nJoined Facebook in 2019\nResponse rate: 100%",
    }),
  );
  const result = applyRecheck(db, "t10", {
    description:
      "a clean, freshly captured description with plenty of real seller prose in it",
  });
  assert.equal(result, null);
  assert.match(getByFbId(db, "t10")!.description ?? "", /freshly captured/);
});

test("applyRecheck: unknown fbId returns null", () => {
  assert.equal(applyRecheck(db, "no-such-id", { price: 1 }), null);
});

test("queryListings: filters by phase, searchKey, and limit", () => {
  insertListing(db, "query-a", raw("q1"));
  insertListing(db, "query-a", raw("q2"));
  insertListing(db, "query-b", raw("q3"));
  setPhase(db, "q1", "candidate", "evaluator", "evaluator");
  setPhase(db, "q2", "candidate", "evaluator", "evaluator");

  assert.equal(queryListings(db, { searchKey: "query-a" }).length, 2);
  assert.equal(queryListings(db, { searchKey: "query-b" }).length, 1);
  assert.equal(
    queryListings(db, { searchKey: "query-a", phase: "candidate" }).length,
    2,
  );
  assert.equal(queryListings(db, { searchKey: "query-a", limit: 1 }).length, 1);
});

test("historyFor: returns phase_history rows oldest-first", () => {
  insertListing(db, "s", raw("t11"));
  setPhase(db, "t11", "candidate", "evaluator", "evaluator");
  setPhase(db, "t11", "rejected", "not a fit", "user");
  const hist = historyFor(db, "t11");
  assert.equal(hist.length, 2);
  assert.equal(hist[0]!.to_phase, "candidate");
  assert.equal(hist[1]!.to_phase, "rejected");
});

test("changedSinceNotified: only candidate/accepted rows with an un-notified change", () => {
  insertListing(db, "s", raw("t12"));
  setPhase(db, "t12", "candidate", "evaluator", "evaluator");
  applyRecheck(db, "t12", { price: 999 });
  const changed = changedSinceNotified(db);
  assert.ok(changed.some((r) => r.fb_id === "t12"));
});

test("changedSinceNotified: excludes a row already notified after its last change", () => {
  insertListing(db, "s", raw("t13"));
  setPhase(db, "t13", "candidate", "evaluator", "evaluator");
  applyRecheck(db, "t13", { price: 999 });
  markNotified(db, "t13");
  const changed = changedSinceNotified(db);
  assert.ok(!changed.some((r) => r.fb_id === "t13"));
});

test("trackedForRecheck: only active candidate/accepted rows, stalest first, respects limit", () => {
  insertListing(db, "track", raw("tr1"));
  insertListing(db, "track", raw("tr2"));
  setPhase(db, "tr1", "candidate", "evaluator", "evaluator");
  setPhase(db, "tr2", "candidate", "evaluator", "evaluator");
  const rows = trackedForRecheck(db, 1);
  assert.equal(rows.length, 1);
});

test("trackedForRecheck: excludes unavailable and rejected listings", () => {
  insertListing(db, "track2", raw("tr3"));
  setAvailability(db, "tr3", "unavailable");
  insertListing(db, "track2", raw("tr4"));
  setPhase(db, "tr4", "rejected", "no", "user");
  const rows = trackedForRecheck(db, 50).map((r) => r.fb_id);
  assert.ok(!rows.includes("tr3"));
  assert.ok(!rows.includes("tr4"));
});

test("updateEvaluation: re-scores and moves an evaluator-owned phase", () => {
  insertListing(db, "s", raw("t14"));
  const result = updateEvaluation(db, "t14", evaluation({ verdict: "reject" }), "m1");
  assert.equal(result.phase, "rejected");
  assert.equal(result.phaseChanged, true);
  assert.equal(getByFbId(db, "t14")!.eval_verdict, "reject");
});

test("updateEvaluation: preserves a manually-advanced phase (accepted) without clobbering it", () => {
  insertListing(db, "s", raw("t15"));
  setPhase(db, "t15", "accepted", "pursuing it", "user");
  const result = updateEvaluation(db, "t15", evaluation({ verdict: "reject" }), "m1");
  assert.equal(result.phase, "accepted");
  assert.equal(result.phaseChanged, false);
  assert.equal(getByFbId(db, "t15")!.phase, "accepted");
});

test("updateEvaluation: unknown fbId doesn't throw and reports no phase change", () => {
  const result = updateEvaluation(db, "no-such-id", evaluation(), "m1");
  assert.equal(result.phaseChanged, false);
});

test("setEvaluation: stores eval fields, sets phase, and logs an evaluator history entry", () => {
  insertListing(db, "s", raw("t16"));
  const phase = setEvaluation(
    db,
    "t16",
    evaluation({ verdict: "candidate", fit_score: 0.9 }),
    "m1",
  );
  assert.equal(phase, "candidate");
  const row = getByFbId(db, "t16")!;
  assert.equal(row.eval_score, 0.9);
  assert.equal(row.phase, "candidate");
  const hist = historyFor(db, "t16");
  assert.equal(hist.at(-1)!.actor, "evaluator");
});
