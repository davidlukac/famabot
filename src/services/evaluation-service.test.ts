import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/index.js";
import { evaluateStoreAndNotify } from "./evaluation-service.js";
import type { Search } from "../types.js";

const db = openDb(":memory:");

function search(): Search {
  return {
    key: "test",
    query: "",
    category: "propertyrentals",
    enabled: true,
    fetchDetails: true,
    criteria: { mustHaves: [], niceToHaves: [], dealBreakers: [] },
  };
}

test("evaluateStoreAndNotify: returns null for a listing that doesn't exist", async () => {
  const result = await evaluateStoreAndNotify(db, "no-such-id", search());
  assert.equal(result, null);
});
