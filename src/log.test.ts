import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLogger, log, logFilePath } from "./log.js";

// initLogger/minLevel are process-wide singletons (see log.ts) — this file's
// tests are written to be order-independent of that mutation by always
// re-initializing before asserting.

test("initLogger + logFilePath: round-trips the configured file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-log-"));
  const file = join(dir, "sub", "famabot.log");
  try {
    initLogger({ file });
    assert.equal(logFilePath(), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log.info: writes a line to the configured file", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-log-"));
  const file = join(dir, "famabot.log");
  try {
    initLogger({ file });
    log.info("hello from the test");
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /INFO\s+hello from the test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log.debug: suppressed by default, shown once verbose is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-log-"));
  const file = join(dir, "famabot.log");
  try {
    initLogger({ file, verbose: false });
    log.info("baseline"); // ensures the file exists even though debug below is suppressed
    log.debug("should not appear");
    assert.ok(!readFileSync(file, "utf8").includes("should not appear"));

    initLogger({ file, verbose: true });
    log.debug("should appear now");
    assert.ok(readFileSync(file, "utf8").includes("should appear now"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log.warn: includes a JSON-stringified extra argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-log-"));
  const file = join(dir, "famabot.log");
  try {
    initLogger({ file });
    log.warn("careful", { code: 42 });
    assert.ok(readFileSync(file, "utf8").includes('{"code":42}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log.error: a non-JSON-serializable extra falls back to String(v)", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-log-"));
  const file = join(dir, "famabot.log");
  try {
    initLogger({ file });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.error("boom", circular);
    assert.ok(readFileSync(file, "utf8").includes("[object Object]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initLogger: without a `file` option, logFilePath keeps whatever was set before", () => {
  const dir = mkdtempSync(join(tmpdir(), "famabot-log-"));
  const file = join(dir, "famabot.log");
  try {
    initLogger({ file });
    initLogger({ verbose: true });
    assert.equal(logFilePath(), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
