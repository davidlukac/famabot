import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PERSONA, buildSystemPrompt } from "./prompt.js";
import type { Criteria, Search } from "../types.js";

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

function withCriteria(criteria: Partial<Criteria>): Search {
  return search({
    criteria: { mustHaves: [], niceToHaves: [], dealBreakers: [], ...criteria },
  });
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

test("buildSystemPrompt: no hard/soft constraints prints (none) for both", () => {
  const prompt = buildSystemPrompt(search());
  assert.match(prompt, /HARD CONSTRAINTS.*\n\s*\(none\)/s);
  assert.match(prompt, /SOFT PREFERENCES.*\n\s*\(none\)/s);
});

test("buildSystemPrompt: persona resolution — search.persona overrides FAMABOT_PERSONA overrides default", () => {
  delete process.env.FAMABOT_PERSONA;
  assert.ok(buildSystemPrompt(search()).startsWith(DEFAULT_PERSONA));

  process.env.FAMABOT_PERSONA = "an env persona";
  try {
    assert.ok(buildSystemPrompt(search()).startsWith("an env persona"));
    assert.ok(
      buildSystemPrompt(search({ persona: "a search-specific persona" })).startsWith(
        "a search-specific persona",
      ),
    );
  } finally {
    delete process.env.FAMABOT_PERSONA;
  }
});

test("buildSystemPrompt: propertyType — 'any' is not a hard constraint, a real value is", () => {
  assert.ok(
    !buildSystemPrompt(withCriteria({ propertyType: "any" })).includes(
      "Property type must be",
    ),
  );
  assert.ok(
    buildSystemPrompt(withCriteria({ propertyType: "house" })).includes(
      "Property type must be: house.",
    ),
  );
});

test("buildSystemPrompt: price bounds — with propertyType adds the bundled-utilities caveat, without it doesn't", () => {
  const withType = buildSystemPrompt(
    withCriteria({ propertyType: "house", minPrice: 1000 }),
  );
  assert.ok(withType.includes("bundles utilities/deposit"));
  const withoutType = buildSystemPrompt(withCriteria({ maxPrice: 2000 }));
  assert.ok(!withoutType.includes("bundles utilities/deposit"));
  assert.ok(withoutType.includes("Price must be within any–2000"));
});

test("buildSystemPrompt: bedroom bounds — min and max are independent hard constraints", () => {
  assert.ok(
    buildSystemPrompt(withCriteria({ minBedrooms: 2 })).includes(
      "At least 2 bedroom(s)",
    ),
  );
  assert.ok(
    buildSystemPrompt(withCriteria({ maxBedrooms: 4 })).includes(
      "At most 4 bedroom(s)",
    ),
  );
});

test("buildSystemPrompt: year bounds render with 'any' for whichever side is unset", () => {
  assert.ok(
    buildSystemPrompt(withCriteria({ minYear: 2010 })).includes(
      "Model year must be within 2010–any.",
    ),
  );
  assert.ok(
    buildSystemPrompt(withCriteria({ maxYear: 2020 })).includes(
      "Model year must be within any–2020.",
    ),
  );
});

test("buildSystemPrompt: mustHaves/dealBreakers/niceToHaves/notes are all included", () => {
  const prompt = buildSystemPrompt(
    withCriteria({
      mustHaves: ["garage"],
      dealBreakers: ["basement suite"],
      niceToHaves: ["fenced yard"],
      notes: "  prefers quiet streets  ",
    }),
  );
  assert.ok(prompt.includes("- garage"));
  assert.ok(prompt.includes("MUST NOT be / have: basement suite"));
  assert.ok(prompt.includes("- fenced yard"));
  assert.ok(prompt.includes("prefers quiet streets"));
});

test("buildSystemPrompt: location without radiusKm omits the parenthetical", () => {
  const prompt = buildSystemPrompt(withCriteria({ location: "Mission, BC" }));
  assert.ok(prompt.includes("Prefer places in or near Mission, BC."));
  assert.ok(!prompt.includes("within ~"));
});

test("buildSystemPrompt: location with radiusKm includes the parenthetical", () => {
  const prompt = buildSystemPrompt(
    withCriteria({ location: "Mission, BC", radiusKm: 30 }),
  );
  assert.ok(prompt.includes("(within ~30 km)"));
});

test("buildSystemPrompt: commute with maxMinutes is a hard constraint", () => {
  const prompt = buildSystemPrompt(
    withCriteria({ commute: { lat: 1, lng: 2, maxMinutes: 30 } }),
  );
  assert.match(prompt, /HARD CONSTRAINTS[\s\S]*commute_minutes[\s\S]*<= 30/);
});

test("buildSystemPrompt: commute without maxMinutes is a soft preference", () => {
  const prompt = buildSystemPrompt(withCriteria({ commute: { lat: 1, lng: 2 } }));
  assert.match(prompt, /SOFT PREFERENCES[\s\S]*Shorter `commute_minutes`/);
});

test("buildSystemPrompt: commute label falls back to lat,lng; arriveBy adds the timing note with/without dayOfWeek", () => {
  const noLabel = buildSystemPrompt(withCriteria({ commute: { lat: 1.1, lng: 2.2 } }));
  assert.ok(noLabel.includes("1.1,2.2"));

  const withArrive = buildSystemPrompt(
    withCriteria({ commute: { lat: 1, lng: 2, label: "downtown", arriveBy: "09:00" } }),
  );
  assert.ok(withArrive.includes("arriving around 09:00 on a weekday"));

  const withArriveAndDay = buildSystemPrompt(
    withCriteria({
      commute: {
        lat: 1,
        lng: 2,
        label: "downtown",
        arriveBy: "09:00",
        dayOfWeek: "mon",
      },
    }),
  );
  assert.ok(withArriveAndDay.includes("arriving around 09:00 on a mon"));
});
