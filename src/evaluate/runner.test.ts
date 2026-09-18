import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "./runner.js";

test("extractJson: plain JSON parses directly", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("extractJson: a fenced ```json block is unwrapped and parsed", () => {
  assert.deepEqual(extractJson('prose\n```json\n{"a":2}\n```\nmore prose'), { a: 2 });
});

test("extractJson: a fenced block without the 'json' tag also works", () => {
  assert.deepEqual(extractJson('```\n{"a":3}\n```'), { a: 3 });
});

test("extractJson: falls back to the first {...} span when there's no valid fence", () => {
  assert.deepEqual(extractJson('here you go: {"a":4} thanks'), { a: 4 });
});

test("extractJson: an invalid fenced block falls through to the brace-span fallback", () => {
  assert.deepEqual(extractJson('```json\nnot valid json\n```\nbut here: {"a":5}'), {
    a: 5,
  });
});

test("extractJson: throws when nothing looks like a JSON object", () => {
  assert.throws(() => extractJson("just some prose, no braces at all"), SyntaxError);
});
