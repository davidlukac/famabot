import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionClassificationSchema, classifyReply } from "./action-classifier.js";
import { EvalProviderError, type EvalProvider } from "./provider/index.js";

function stubProvider(reply: string): EvalProvider {
  return {
    model: "stub",
    complete: async () => ({ text: reply, usage: null }),
  };
}

test("ActionClassificationSchema: parses a well-formed reply", () => {
  const parsed = ActionClassificationSchema.parse({
    action: "reject",
    comment: "too far",
    confidence: 0.9,
  });
  assert.equal(parsed.action, "reject");
});

test("ActionClassificationSchema: accepts a null action for unparseable free text", () => {
  const parsed = ActionClassificationSchema.parse({
    action: null,
    comment: null,
    confidence: 0.1,
  });
  assert.equal(parsed.action, null);
});

test("ActionClassificationSchema: rejects an action outside the known set", () => {
  assert.throws(() =>
    ActionClassificationSchema.parse({
      action: "delete_everything",
      comment: null,
      confidence: 0.9,
    }),
  );
});

test("classifyReply: returns the parsed classification on a well-formed model reply", async () => {
  const provider = stubProvider(
    JSON.stringify({ action: "accept", comment: "looks great", confidence: 0.95 }),
  );
  const result = await classifyReply("yeah let's go for it, looks great", provider);
  assert.deepEqual(result, {
    action: "accept",
    comment: "looks great",
    confidence: 0.95,
  });
});

test("classifyReply: null for a reply the model returns as unparseable JSON", async () => {
  const provider = stubProvider("not json at all");
  const result = await classifyReply("gibberish", provider);
  assert.equal(result, null);
});

test("classifyReply: propagates a provider error (e.g. missing API key)", async () => {
  const failing: EvalProvider = {
    model: "stub",
    complete: async () => {
      throw new EvalProviderError("boom");
    },
  };
  await assert.rejects(() => classifyReply("hi", failing), EvalProviderError);
});
