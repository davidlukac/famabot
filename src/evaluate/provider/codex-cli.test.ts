import { test } from "node:test";
import assert from "node:assert/strict";
import { findCodexError } from "./codex-cli.js";

test("findCodexError: undefined when the stream has no error/turn.failed event", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hi" },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10 } }),
  ].join("\n");
  assert.equal(findCodexError(stdout), undefined);
});

test("findCodexError: extracts error.message from a 'turn.failed' event", () => {
  const stdout = JSON.stringify({
    type: "turn.failed",
    error: { message: "model unavailable" },
  });
  assert.equal(findCodexError(stdout), "model unavailable");
});

test("findCodexError: falls back to top-level 'message' when error.message is absent", () => {
  const stdout = JSON.stringify({ type: "error", message: "boom" });
  assert.equal(findCodexError(stdout), "boom");
});

test("findCodexError: falls back to the raw line when neither field is present", () => {
  const line = JSON.stringify({ type: "error" });
  assert.equal(findCodexError(line), line);
});

test("findCodexError: ignores non-JSON lines and blank lines", () => {
  const stdout = [
    "not json",
    "",
    JSON.stringify({ type: "turn.failed", message: "x" }),
  ].join("\n");
  assert.equal(findCodexError(stdout), "x");
});
