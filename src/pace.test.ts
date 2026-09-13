import { test } from "node:test";
import assert from "node:assert/strict";
import { pickScrollRounds, shouldKeepScrolling, shuffled } from "./pace.js";

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

test("pickScrollRounds: picks within [min, max], inclusive at both ends", () => {
  assert.equal(
    pickScrollRounds(3, 7, () => 0),
    3,
  );
  assert.equal(
    pickScrollRounds(3, 7, () => 0.999999),
    7,
  );
  assert.equal(
    pickScrollRounds(3, 7, () => 0.5),
    5,
  );
});

test("pickScrollRounds: max <= min collapses to a fixed count", () => {
  assert.equal(
    pickScrollRounds(5, 5, () => 0.9),
    5,
  );
  assert.equal(
    pickScrollRounds(5, 3, () => 0.9),
    5,
  );
});

test("shouldKeepScrolling: stops at maxRounds even with room left", () => {
  assert.equal(
    shouldKeepScrolling({
      round: 5,
      maxRounds: 5,
      size: 1,
      cap: 100,
      staleStreak: 0,
      staleLimit: 2,
    }),
    false,
  );
});

test("shouldKeepScrolling: stops once the listing cap is reached", () => {
  assert.equal(
    shouldKeepScrolling({
      round: 0,
      maxRounds: 10,
      size: 20,
      cap: 20,
      staleStreak: 0,
      staleLimit: 2,
    }),
    false,
  );
});

test("shouldKeepScrolling: stops after staleLimit consecutive no-new-listing rounds", () => {
  assert.equal(
    shouldKeepScrolling({
      round: 1,
      maxRounds: 10,
      size: 5,
      cap: 100,
      staleStreak: 2,
      staleLimit: 2,
    }),
    false,
  );
});

test("shouldKeepScrolling: keeps going when under every limit", () => {
  assert.equal(
    shouldKeepScrolling({
      round: 1,
      maxRounds: 10,
      size: 5,
      cap: 100,
      staleStreak: 1,
      staleLimit: 2,
    }),
    true,
  );
});
