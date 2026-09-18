import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "./index.js";
import {
  getByFbId,
  getByTelegramMessageId,
  historyFor,
  insertListing,
  logFeedback,
  recentUserFeedback,
  setPhase,
  setTelegramMessageId,
} from "./listings.js";
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

test("logFeedback: records a self-transition note without changing phase", () => {
  insertListing(db, "feedback-search", raw("fb1"));
  const before = getByFbId(db, "fb1")!;
  logFeedback(db, "fb1", "too expensive for this square footage");
  const after = getByFbId(db, "fb1")!;
  assert.equal(after.phase, before.phase);

  const hist = historyFor(db, "fb1");
  const entry = hist.find((h) => h.note === "too expensive for this square footage");
  assert.ok(entry);
  assert.equal(entry!.from_phase, entry!.to_phase);
  assert.equal(entry!.actor, "user");
});

test("logFeedback: throws for an unknown listing", () => {
  assert.throws(() => logFeedback(db, "no-such-id", "x"));
});

test("recentUserFeedback: only user-actor notes for the given search, newest first", () => {
  insertListing(db, "feedback-search-2", raw("fb2"));
  insertListing(db, "feedback-search-2", raw("fb3"));
  setPhase(db, "fb2", "rejected", "too far from downtown", "user");
  setPhase(db, "fb3", "candidate", "evaluator", "evaluator");
  logFeedback(db, "fb3", "nice but overpriced");
  // Evaluator/system notes must not leak in as "user feedback".
  setPhase(db, "fb3", "rejected", "auto-rejected: missing price", "evaluator");

  const feedback = recentUserFeedback(db, "feedback-search-2", 10);
  assert.deepEqual(feedback, [
    "[candidate] nice but overpriced",
    "[rejected] too far from downtown",
  ]);
});

test("recentUserFeedback: empty for a search with no user notes", () => {
  insertListing(db, "feedback-search-3", raw("fb4"));
  assert.deepEqual(recentUserFeedback(db, "feedback-search-3"), []);
});

test("setTelegramMessageId / getByTelegramMessageId: round-trips", () => {
  insertListing(db, "feedback-search-4", raw("fb5"));
  setTelegramMessageId(db, "fb5", 4242);
  const found = getByTelegramMessageId(db, 4242);
  assert.equal(found?.fb_id, "fb5");
  assert.equal(getByTelegramMessageId(db, 999999), undefined);
});
