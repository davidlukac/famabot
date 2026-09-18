import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "../db/index.js";
import { getByFbId, insertListing, setPhase } from "../db/listings.js";
import { evaluateStoreAndNotify } from "./evaluation-service.js";
import type { Evaluation, EvaluationResult } from "../evaluate/evaluator.js";
import type { RawListing, Search } from "../types.js";

const db = openDb(":memory:");

function search(): Search {
  return {
    key: "eval-service-test",
    query: "",
    category: "propertyrentals",
    enabled: true,
    fetchDetails: true,
    criteria: { mustHaves: [], niceToHaves: [], dealBreakers: [] },
  };
}

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

function fakeEvaluate(ev: Evaluation) {
  return async (): Promise<EvaluationResult> => ({ evaluation: ev, usage: null });
}

function evaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    verdict: "candidate",
    fit_score: 0.8,
    reasoning: "good fit",
    extracted: {},
    red_flags: [],
    missing_info: [],
    ...overrides,
  };
}

test("evaluateStoreAndNotify: returns null for a listing that doesn't exist", async () => {
  const result = await evaluateStoreAndNotify(db, "no-such-id", search());
  assert.equal(result, null);
});

test("evaluateStoreAndNotify: returns null and doesn't touch the row when the reply is unparseable", async () => {
  insertListing(db, search().key, raw("es1"));
  const result = await evaluateStoreAndNotify(db, "es1", search(), {
    evaluateFn: async () => null,
  });
  assert.equal(result, null);
  assert.equal(getByFbId(db, "es1")!.phase, "new");
});

test("evaluateStoreAndNotify: a fresh (non-reeval) candidate verdict persists via setEvaluation", async () => {
  insertListing(db, search().key, raw("es2"));
  const result = await evaluateStoreAndNotify(db, "es2", search(), {
    evaluateFn: fakeEvaluate(evaluation({ verdict: "candidate" })),
  });
  assert.equal(result!.phase, "candidate");
  assert.equal(result!.phaseChanged, true);
  assert.equal(getByFbId(db, "es2")!.eval_verdict, "candidate");
});

test("evaluateStoreAndNotify: a fresh reject verdict persists as rejected", async () => {
  insertListing(db, search().key, raw("es3"));
  const result = await evaluateStoreAndNotify(db, "es3", search(), {
    evaluateFn: fakeEvaluate(evaluation({ verdict: "reject" })),
  });
  assert.equal(result!.phase, "rejected");
});

test("evaluateStoreAndNotify: reeval:true routes through updateEvaluation and preserves a manual phase", async () => {
  insertListing(db, search().key, raw("es4"));
  setPhase(db, "es4", "accepted", "pursuing", "user");
  const result = await evaluateStoreAndNotify(db, "es4", search(), {
    reeval: true,
    evaluateFn: fakeEvaluate(evaluation({ verdict: "reject" })),
  });
  assert.equal(result!.phase, "accepted");
  assert.equal(result!.phaseChanged, false);
});

test("evaluateStoreAndNotify: reeval:true on an evaluator-owned phase does change phase", async () => {
  insertListing(db, search().key, raw("es5"));
  const result = await evaluateStoreAndNotify(db, "es5", search(), {
    reeval: true,
    evaluateFn: fakeEvaluate(evaluation({ verdict: "candidate" })),
  });
  assert.equal(result!.phase, "candidate");
  assert.equal(result!.phaseChanged, true);
});

test("evaluateStoreAndNotify: a fresh candidate triggers the notify path without throwing (no backend configured)", async () => {
  const prevNotify = process.env.FAMABOT_NOTIFY;
  delete process.env.FAMABOT_NOTIFY;
  try {
    insertListing(db, search().key, raw("es6"));
    const result = await evaluateStoreAndNotify(db, "es6", search(), {
      evaluateFn: fakeEvaluate(
        evaluation({ verdict: "candidate", red_flags: ["scam-ish"] }),
      ),
    });
    assert.equal(result!.phase, "candidate");
  } finally {
    if (prevNotify === undefined) delete process.env.FAMABOT_NOTIFY;
    else process.env.FAMABOT_NOTIFY = prevNotify;
  }
});
