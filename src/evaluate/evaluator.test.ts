import { test } from "node:test";
import assert from "node:assert/strict";

// evaluateListing goes through the process-wide getEvalProvider() cache (see
// provider/factory.ts), which reads FAMABOT_EVALUATOR once on first use — so
// the env must be set, and the module imported, before anything else in this
// file touches it. A dynamic import (rather than a static one, which would
// evaluate before this runs) lets the env be set first in this file's own
// isolated test-runner process.
process.env.FAMABOT_EVALUATOR = "zai";
process.env.FAMABOT_ZAI_API_KEY = "test-key";
const { evaluateListing, toListingInput } = await import("./evaluator.js");
const { insertListing, getByFbId } = await import("../db/listings.js");
const { openDb, nowIso } = await import("../db/index.js");

const db = openDb(":memory:");

function search() {
  return {
    key: "eval-test",
    query: "",
    category: "propertyrentals" as const,
    enabled: true,
    fetchDetails: true,
    criteria: { mustHaves: [], niceToHaves: [], dealBreakers: [] },
  };
}

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

function zaiResponse(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function listingInput() {
  insertListing(db, "eval-test", {
    fbId: "ev1",
    url: "https://example.com/ev1",
    title: "3 bed house",
    price: 2000,
    currency: "$",
    location: "Mission, BC",
    imageUrl: null,
    postedAt: nowIso(),
    description: "a lovely 3 bedroom home",
    raw: null,
  });
  return toListingInput(getByFbId(db, "ev1")!);
}

test("evaluateListing: parses a well-formed reply on the first attempt", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify(
        zaiResponse(
          JSON.stringify({
            verdict: "candidate",
            fit_score: 0.8,
            reasoning: "good fit",
            extracted: { bedrooms: 3 },
            red_flags: [],
            missing_info: [],
          }),
        ),
      ),
      { status: 200 },
    )) as typeof fetch;

  await withFetch(fetchImpl, async () => {
    const result = await evaluateListing(listingInput(), search());
    assert.ok(result);
    assert.equal(result!.evaluation.verdict, "candidate");
    assert.equal(result!.evaluation.fit_score, 0.8);
    assert.ok(result!.usage);
  });
});

test("evaluateListing: retries once on an unparseable reply, then succeeds", async () => {
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    const content =
      call === 1
        ? "not json at all"
        : JSON.stringify({
            verdict: "reject",
            fit_score: 0.1,
            reasoning: "no",
            extracted: {},
            red_flags: [],
            missing_info: [],
          });
    return new Response(JSON.stringify(zaiResponse(content)), { status: 200 });
  }) as typeof fetch;

  await withFetch(fetchImpl, async () => {
    const result = await evaluateListing(listingInput(), search());
    assert.ok(result);
    assert.equal(result!.evaluation.verdict, "reject");
    assert.equal(call, 2);
  });
});

test("evaluateListing: returns null after exhausting all retry attempts on unparseable replies", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(zaiResponse("still not json")), {
      status: 200,
    })) as typeof fetch;

  await withFetch(fetchImpl, async () => {
    const result = await evaluateListing(listingInput(), search(), { attempts: 2 });
    assert.equal(result, null);
  });
});

test("evaluateListing: tolerates a missing/invalid field via the schema's coercion", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify(
        zaiResponse(
          JSON.stringify({
            verdict: "candidate",
            fit_score: "not-a-number",
            extracted: {},
          }),
        ),
      ),
      { status: 200 },
    )) as typeof fetch;

  await withFetch(fetchImpl, async () => {
    const result = await evaluateListing(listingInput(), search());
    assert.ok(result);
    assert.equal(result!.evaluation.fit_score, 0.5); // .catch(0.5) fallback
    assert.equal(result!.evaluation.reasoning, ""); // .catch("") fallback
  });
});
