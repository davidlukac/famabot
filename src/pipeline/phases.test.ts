import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedNext, assertTransition, isPhase } from "./phases.js";

test("isPhase: accepts every declared phase, rejects unknown strings", () => {
  for (const p of [
    "new",
    "candidate",
    "rejected",
    "accepted",
    "acquisition_failed",
    "acquisition_rejected",
    "acquired_continue",
    "acquired_stop",
  ]) {
    assert.equal(isPhase(p), true, p);
  }
  assert.equal(isPhase("contacted"), false);
  assert.equal(isPhase("visit_scheduled"), false);
  assert.equal(isPhase("visited"), false);
  assert.equal(isPhase("declined"), false);
  assert.equal(isPhase("bogus"), false);
});

test("allowedNext: new -> candidate | rejected (evaluator-owned)", () => {
  assert.deepEqual(allowedNext("new"), ["candidate", "rejected"]);
});

test("allowedNext: candidate -> rejected | accepted", () => {
  assert.deepEqual(allowedNext("candidate"), ["rejected", "accepted"]);
});

test("allowedNext: accepted -> the four acquisition outcomes", () => {
  assert.deepEqual(allowedNext("accepted"), [
    "acquisition_failed",
    "acquisition_rejected",
    "acquired_continue",
    "acquired_stop",
  ]);
});

test("allowedNext: every acquisition outcome is terminal", () => {
  for (const p of [
    "rejected",
    "acquisition_failed",
    "acquisition_rejected",
    "acquired_continue",
    "acquired_stop",
  ] as const) {
    assert.deepEqual(allowedNext(p), [], p);
  }
});

test("assertTransition: allows a legal move", () => {
  assert.doesNotThrow(() => assertTransition("candidate", "accepted"));
});

test("assertTransition: rejects an illegal move with the allowed list in the message", () => {
  assert.throws(
    () => assertTransition("candidate", "acquired_stop"),
    /Allowed: rejected, accepted/,
  );
});

test("assertTransition: rejects moving out of a terminal phase", () => {
  assert.throws(() => assertTransition("acquired_stop", "candidate"), /terminal phase/);
});

test("assertTransition: rejects a no-op move", () => {
  assert.throws(() => assertTransition("candidate", "candidate"), /already in phase/);
});
