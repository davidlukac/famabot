import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./index.js";
import { isPaused, pauseSearch, pausedSearches, resumeSearch } from "./searches.js";

const db = openDb(":memory:");

test("isPaused: false for a search that was never paused", () => {
  assert.equal(isPaused(db, "never-paused"), false);
});

test("pauseSearch / isPaused: pausing takes effect immediately", () => {
  pauseSearch(db, "vehicle-hunt", "bought one, stop searching");
  assert.equal(isPaused(db, "vehicle-hunt"), true);
});

test("resumeSearch: un-pauses", () => {
  pauseSearch(db, "couch-hunt", "acquired");
  resumeSearch(db, "couch-hunt");
  assert.equal(isPaused(db, "couch-hunt"), false);
});

test("resumeSearch: a no-op on a search that isn't paused", () => {
  assert.doesNotThrow(() => resumeSearch(db, "not-paused"));
});

test("pauseSearch: pausing an already-paused search updates the reason, not a duplicate row", () => {
  pauseSearch(db, "dup-key", "first reason");
  pauseSearch(db, "dup-key", "second reason");
  const all = pausedSearches(db);
  assert.equal(all.filter((s) => s.search_key === "dup-key").length, 1);
  assert.equal(all.find((s) => s.search_key === "dup-key")?.reason, "second reason");
});

test("pausedSearches: lists every currently-paused key", () => {
  pauseSearch(db, "list-me-1", "a");
  pauseSearch(db, "list-me-2", "b");
  const keys = pausedSearches(db).map((s) => s.search_key);
  assert.ok(keys.includes("list-me-1"));
  assert.ok(keys.includes("list-me-2"));
});
