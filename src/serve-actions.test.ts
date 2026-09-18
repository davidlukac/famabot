import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "./db/index.js";
import { insertListing, setPhase } from "./db/listings.js";
import { handleCandidateAction } from "./serve-actions.js";
import type { RawListing } from "./types.js";

const db = openDb(":memory:");

function raw(fbId: string): RawListing {
  return {
    fbId,
    url: `https://example.com/${fbId}`,
    title: `listing ${fbId}`,
    price: 100,
    currency: "$",
    location: "here",
    imageUrl: null,
    postedAt: nowIso(),
    description: null,
    raw: null,
  };
}

test("handleCandidateAction: applies a valid action and returns the transition", () => {
  insertListing(db, "s1", raw("sv1"));
  setPhase(db, "sv1", "candidate", "evaluator", "evaluator");
  const res = handleCandidateAction(db, "sv1", "reject", { comment: "nope" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { fromPhase: "candidate", toPhase: "rejected" });
});

test("handleCandidateAction: 404 for an unknown listing", () => {
  const res = handleCandidateAction(db, "no-such-id", "reject", {});
  assert.equal(res.status, 404);
});

test("handleCandidateAction: 400 for an unknown action", () => {
  insertListing(db, "s1", raw("sv2"));
  const res = handleCandidateAction(db, "sv2", "not-a-real-action", {});
  assert.equal(res.status, 400);
});

test("handleCandidateAction: 400 when a required comment is missing", () => {
  insertListing(db, "s1", raw("sv3"));
  setPhase(db, "sv3", "candidate", "evaluator", "evaluator");
  const res = handleCandidateAction(db, "sv3", "hold", {});
  assert.equal(res.status, 400);
});

test("handleCandidateAction: 400 for an illegal transition", () => {
  insertListing(db, "s1", raw("sv4"));
  const res = handleCandidateAction(db, "sv4", "acquisition_failed", {
    comment: "x",
  });
  assert.equal(res.status, 400);
});
