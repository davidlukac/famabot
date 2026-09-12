import { test } from "node:test";
import assert from "node:assert/strict";
import { shuffled } from "./pace.js";

test("shuffled: same elements, same length, new array", () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffled(input);
  assert.notEqual(out, input);
  assert.equal(out.length, input.length);
  assert.deepEqual(
    [...out].sort((a, b) => a - b),
    input,
  );
  // original untouched
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
});

test("shuffled: empty and single-element arrays are safe", () => {
  assert.deepEqual(shuffled([]), []);
  assert.deepEqual(shuffled(["only"]), ["only"]);
});
