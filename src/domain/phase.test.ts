import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseForVerdict } from "./phase.js";

test("phaseForVerdict: candidate verdict -> candidate phase", () => {
  assert.equal(phaseForVerdict("candidate"), "candidate");
});

test("phaseForVerdict: reject verdict -> rejected phase", () => {
  assert.equal(phaseForVerdict("reject"), "rejected");
});
