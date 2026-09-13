import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEvalProvider,
  sumUsage,
  tieredCost,
  EvalProviderError,
} from "./index.js";

test("createEvalProvider defaults to claude-cli with a small/fast model", () => {
  const p = createEvalProvider({});
  assert.equal(p.model, "claude-haiku-4-5-20251001");
});

test("createEvalProvider: claude-cli respects FAMABOT_EVAL_MODEL override", () => {
  const p = createEvalProvider({ FAMABOT_EVAL_MODEL: "claude-opus-5" });
  assert.equal(p.model, "claude-opus-5");
});

test("createEvalProvider: claude-api defaults and key requirement", () => {
  const p = createEvalProvider({ FAMABOT_EVALUATOR: "claude-api" });
  assert.equal(p.model, "claude-haiku-4-5-20251001");
});

test("createEvalProvider: codex-cli defaults to gpt-5.5", () => {
  const p = createEvalProvider({ FAMABOT_EVALUATOR: "codex-cli" });
  assert.equal(p.model, "gpt-5.5");
});

test("createEvalProvider: codex-cli model override", () => {
  const p = createEvalProvider({
    FAMABOT_EVALUATOR: "codex-cli",
    FAMABOT_CODEX_CLI_MODEL: "o3",
  });
  assert.equal(p.model, "o3");
});

test("createEvalProvider: codex-api defaults to gpt-5-mini", () => {
  const p = createEvalProvider({ FAMABOT_EVALUATOR: "codex-api" });
  assert.equal(p.model, "gpt-5-mini");
});

test("createEvalProvider: zai defaults to glm-5.3-flash", () => {
  const p = createEvalProvider({ FAMABOT_EVALUATOR: "zai" });
  assert.equal(p.model, "glm-5.3-flash");
});

test("createEvalProvider: unknown backend throws a clear error", () => {
  assert.throws(
    () => createEvalProvider({ FAMABOT_EVALUATOR: "bogus" }),
    (err: unknown) =>
      err instanceof EvalProviderError && /bogus/.test((err as Error).message),
  );
});

test("createEvalProvider: bad zai reasoning effort throws", () => {
  assert.throws(
    () =>
      createEvalProvider({
        FAMABOT_EVALUATOR: "zai",
        FAMABOT_ZAI_REASONING_EFFORT: "extreme",
      }),
    EvalProviderError,
  );
});

test("missing API key surfaces as a clear error, not a crash, for both API backends", async () => {
  await assert.rejects(
    () => createEvalProvider({ FAMABOT_EVALUATOR: "claude-api" }).complete("x"),
    (err: unknown) =>
      err instanceof EvalProviderError && /FAMABOT_CLAUDE_API_KEY/.test(err.message),
  );
  await assert.rejects(
    () => createEvalProvider({ FAMABOT_EVALUATOR: "codex-api" }).complete("x"),
    (err: unknown) =>
      err instanceof EvalProviderError && /FAMABOT_CODEX_API_KEY/.test(err.message),
  );
});

test("tieredCost: null when no price is configured", () => {
  assert.equal(tieredCost(1000, 100, 200, 0, 0, 0), null);
});

test("tieredCost: charges uncached input, cached input, and output at their own rates", () => {
  // 1000 in (200 cached) @ $1/M uncached, $0.1/M cached, 500 out @ $5/M
  const cost = tieredCost(1000, 200, 500, 1, 0.1, 5);
  const expected = (800 / 1e6) * 1 + (200 / 1e6) * 0.1 + (500 / 1e6) * 5;
  assert.ok(Math.abs(cost! - expected) < 1e-12);
});

test("sumUsage: null for an empty or all-null batch", () => {
  assert.equal(sumUsage([]), null);
  assert.equal(sumUsage([null, null]), null);
});

test("sumUsage: sums tokens; cost is null unless at least one part was priced", () => {
  const unpriced = sumUsage([
    { tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: null },
    { tokensIn: 20, tokensOut: 15, tokensCached: 2, costUsd: null },
  ]);
  assert.deepEqual(unpriced, {
    tokensIn: 30,
    tokensOut: 20,
    tokensCached: 2,
    costUsd: null,
  });

  const mixed = sumUsage([
    { tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: null },
    { tokensIn: 20, tokensOut: 15, tokensCached: 2, costUsd: 0.001 },
  ]);
  assert.equal(mixed!.costUsd, 0.001);
});
