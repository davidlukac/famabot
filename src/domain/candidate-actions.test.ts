import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_ACTIONS, helpText, isCandidateAction } from "./candidate-actions.js";
import { PHASES } from "../types.js";

test("CANDIDATE_ACTIONS: every action's toPhase (when set) is a real Phase", () => {
  for (const [action, def] of Object.entries(CANDIDATE_ACTIONS)) {
    if (def.toPhase !== null) {
      assert.ok(
        (PHASES as readonly string[]).includes(def.toPhase),
        `${action} -> ${def.toPhase}`,
      );
    }
  }
});

test("CANDIDATE_ACTIONS: hold stays in place (no phase change) and requires a comment", () => {
  assert.equal(CANDIDATE_ACTIONS.hold.toPhase, null);
  assert.equal(CANDIDATE_ACTIONS.hold.commentRequired, true);
});

test("CANDIDATE_ACTIONS: acquisition_failed/acquisition_rejected require a comment", () => {
  assert.equal(CANDIDATE_ACTIONS.acquisition_failed.commentRequired, true);
  assert.equal(CANDIDATE_ACTIONS.acquisition_rejected.commentRequired, true);
});

test("CANDIDATE_ACTIONS: reject/accept/acquired_continue don't require a comment", () => {
  assert.equal(CANDIDATE_ACTIONS.reject.commentRequired, false);
  assert.equal(CANDIDATE_ACTIONS.accept.commentRequired, false);
  assert.equal(CANDIDATE_ACTIONS.acquired_continue.commentRequired, false);
});

test("CANDIDATE_ACTIONS: only acquired_stop pauses the search", () => {
  for (const [action, def] of Object.entries(CANDIDATE_ACTIONS)) {
    assert.equal(Boolean(def.pausesSearch), action === "acquired_stop", action);
  }
});

test("isCandidateAction: recognizes every declared action, rejects unknown strings", () => {
  for (const action of Object.keys(CANDIDATE_ACTIONS)) {
    assert.equal(isCandidateAction(action), true, action);
  }
  assert.equal(isCandidateAction("bogus"), false);
  assert.equal(isCandidateAction("move"), false);
});

test("CANDIDATE_ACTIONS: every action has a hyphenated command name and a description", () => {
  for (const [action, def] of Object.entries(CANDIDATE_ACTIONS)) {
    assert.ok(def.command.length > 0, action);
    assert.equal(def.command, def.command.replace(/_/g, "-"), action);
    assert.ok(def.description.length > 0, action);
  }
});

test("helpText: lists every action's slash-command form, marking required comments", () => {
  const text = helpText();
  for (const def of Object.values(CANDIDATE_ACTIONS)) {
    assert.ok(text.includes(`/${def.command}`), def.command);
  }
  assert.match(text, /acquisition-failed.*comment/i);
});
