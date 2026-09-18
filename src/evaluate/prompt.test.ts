import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./prompt.js";
import type { Search } from "../types.js";

function search(overrides: Partial<Search> = {}): Search {
  return {
    key: "test",
    query: "",
    category: "propertyrentals",
    enabled: true,
    fetchDetails: true,
    criteria: { mustHaves: [], niceToHaves: [], dealBreakers: [] },
    ...overrides,
  };
}

test("buildSystemPrompt: no feedback section when none is given", () => {
  const prompt = buildSystemPrompt(search());
  assert.ok(!prompt.includes("Prior user feedback"));
});

test("buildSystemPrompt: no feedback section for an empty feedback list", () => {
  const prompt = buildSystemPrompt(search(), []);
  assert.ok(!prompt.includes("Prior user feedback"));
});

test("buildSystemPrompt: includes prior user feedback when given, so it can shape future verdicts", () => {
  const prompt = buildSystemPrompt(search(), [
    "[rejected] too far from downtown",
    "[accepted] great layout, exactly what they wanted",
  ]);
  assert.ok(prompt.includes("Prior user feedback"));
  assert.ok(prompt.includes("too far from downtown"));
  assert.ok(prompt.includes("great layout, exactly what they wanted"));
});
