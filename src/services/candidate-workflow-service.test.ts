import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "../db/index.js";
import { getByFbId, historyFor, insertListing, setPhase } from "../db/listings.js";
import { isPaused } from "../db/searches.js";
import { applyCandidateAction } from "./candidate-workflow-service.js";
import type { RawListing } from "../types.js";

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

function candidate(fbId: string, searchKey = "wf-search"): void {
  insertListing(db, searchKey, raw(fbId));
  setPhase(db, fbId, "candidate", "evaluator", "evaluator");
}

test("applyCandidateAction: reject moves candidate -> rejected", () => {
  candidate("wf1");
  const r = applyCandidateAction(db, "wf1", "reject", "not a fit");
  assert.equal(r.fromPhase, "candidate");
  assert.equal(r.toPhase, "rejected");
  assert.equal(getByFbId(db, "wf1")!.phase, "rejected");
  const entry = historyFor(db, "wf1").at(-1)!;
  assert.equal(entry.note, "not a fit");
  assert.equal(entry.actor, "user");
});

test("applyCandidateAction: hold logs feedback but does not change phase", () => {
  candidate("wf2");
  const r = applyCandidateAction(db, "wf2", "hold", "still deciding, price seems high");
  assert.equal(r.fromPhase, "candidate");
  assert.equal(r.toPhase, null);
  assert.equal(getByFbId(db, "wf2")!.phase, "candidate");
});

test("applyCandidateAction: hold without a comment throws (comment required)", () => {
  candidate("wf3");
  assert.throws(() => applyCandidateAction(db, "wf3", "hold", null), /comment/i);
});

test("applyCandidateAction: acquisition_failed requires a comment", () => {
  candidate("wf4");
  applyCandidateAction(db, "wf4", "accept", null);
  assert.throws(
    () => applyCandidateAction(db, "wf4", "acquisition_failed", null),
    /comment/i,
  );
  applyCandidateAction(db, "wf4", "acquisition_failed", "seller stopped responding");
  assert.equal(getByFbId(db, "wf4")!.phase, "acquisition_failed");
});

test("applyCandidateAction: illegal transition throws without --force", () => {
  candidate("wf5");
  assert.throws(() =>
    applyCandidateAction(db, "wf5", "acquisition_failed", "whatever"),
  );
});

test("applyCandidateAction: force skips transition validation", () => {
  candidate("wf6");
  const r = applyCandidateAction(db, "wf6", "acquisition_failed", "forced", {
    force: true,
  });
  assert.equal(r.toPhase, "acquisition_failed");
});

test("applyCandidateAction: acquired_stop pauses the listing's search", () => {
  candidate("wf7", "pause-me");
  applyCandidateAction(db, "wf7", "accept", null);
  assert.equal(isPaused(db, "pause-me"), false);
  applyCandidateAction(db, "wf7", "acquired_stop", "got it, done hunting");
  assert.equal(isPaused(db, "pause-me"), true);
});

test("applyCandidateAction: acquired_continue does not pause the search", () => {
  candidate("wf8", "keep-going");
  applyCandidateAction(db, "wf8", "accept", null);
  applyCandidateAction(db, "wf8", "acquired_continue", null);
  assert.equal(isPaused(db, "keep-going"), false);
});

test("applyCandidateAction: throws for an unknown listing", () => {
  assert.throws(() => applyCandidateAction(db, "no-such-id", "reject", null));
});
