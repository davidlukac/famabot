import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "../db/index.js";
import { getByFbId, insertListing, setPhase } from "../db/listings.js";
import { minNotifyScore, pushCandidates, pushChanged } from "./notifications.js";
import type { RawListing } from "../types.js";

const db = openDb(":memory:");

function raw(fbId: string, price = 100): RawListing {
  return {
    fbId,
    url: `https://example.com/${fbId}`,
    title: `listing ${fbId}`,
    price,
    currency: "$",
    location: "here",
    imageUrl: null,
    postedAt: nowIso(),
    description: null,
    raw: null,
  };
}

/** Run `fn` with FAMABOT_NOTIFY + creds set and global.fetch stubbed, then restore both. */
async function withStubbedNotify<T>(
  env: Record<string, string>,
  fetchImpl: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const prevEnv = { ...process.env };
  const prevFetch = globalThis.fetch;
  Object.assign(process.env, env);
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    globalThis.fetch = prevFetch;
  }
}

const okTelegram = () =>
  Promise.resolve(
    new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
      status: 200,
    }),
  );
const fail = () => Promise.resolve(new Response("nope", { status: 500 }));

test("minNotifyScore: 0 when unset or non-positive", () => {
  delete process.env.FAMABOT_MIN_NOTIFY_SCORE;
  assert.equal(minNotifyScore(), 0);
  process.env.FAMABOT_MIN_NOTIFY_SCORE = "-1";
  assert.equal(minNotifyScore(), 0);
  delete process.env.FAMABOT_MIN_NOTIFY_SCORE;
});

test("minNotifyScore: reads a positive value from the env", () => {
  process.env.FAMABOT_MIN_NOTIFY_SCORE = "0.4";
  assert.equal(minNotifyScore(), 0.4);
  delete process.env.FAMABOT_MIN_NOTIFY_SCORE;
});

test("pushCandidates: no-op when no notify backend is configured", async () => {
  delete process.env.FAMABOT_NOTIFY;
  insertListing(db, "s", raw("n1"));
  const row = getByFbId(db, "n1")!;
  await pushCandidates(db, undefined, [row]);
  assert.equal(getByFbId(db, "n1")!.notified_at, null);
});

test("pushCandidates: skips a candidate already notified", async () => {
  await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "telegram",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    okTelegram as typeof fetch,
    async () => {
      insertListing(db, "s", raw("n2"));
      setPhase(db, "n2", "candidate", "evaluator", "evaluator");
      const row = { ...getByFbId(db, "n2")!, notified_at: "2026-01-01T00:00:00.000Z" };
      await pushCandidates(db, undefined, [row]);
      // untouched: markNotified would bump notified_at to "now", but nothing ran
      assert.equal(getByFbId(db, "n2")!.notified_at, null);
    },
  );
});

test("pushCandidates: skips below the score floor and does not mark notified", async () => {
  await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "telegram",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
      FAMABOT_MIN_NOTIFY_SCORE: "0.5",
    },
    okTelegram as typeof fetch,
    async () => {
      insertListing(db, "s", raw("n3"));
      setPhase(db, "n3", "candidate", "evaluator", "evaluator");
      const row = { ...getByFbId(db, "n3")!, eval_score: 0.2 };
      await pushCandidates(db, undefined, [row]);
      assert.equal(getByFbId(db, "n3")!.notified_at, null);
    },
  );
});

test("pushCandidates: on success, marks notified and captures the telegram message id", async () => {
  await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "telegram",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    okTelegram as typeof fetch,
    async () => {
      insertListing(db, "s", raw("n4"));
      setPhase(db, "n4", "candidate", "evaluator", "evaluator");
      const row = getByFbId(db, "n4")!;
      await pushCandidates(db, undefined, [row]);
      const after = getByFbId(db, "n4")!;
      assert.ok(after.notified_at);
      assert.equal(after.telegram_message_id, 777);
    },
  );
});

test("pushCandidates: when every backend fails, does not mark notified (retries later)", async () => {
  await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "telegram",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    fail as typeof fetch,
    async () => {
      insertListing(db, "s", raw("n5"));
      setPhase(db, "n5", "candidate", "evaluator", "evaluator");
      const row = getByFbId(db, "n5")!;
      await pushCandidates(db, undefined, [row]);
      assert.equal(getByFbId(db, "n5")!.notified_at, null);
    },
  );
});

test("pushChanged: no-op when no notify backend is configured", async () => {
  delete process.env.FAMABOT_NOTIFY;
  await assert.doesNotReject(() => pushChanged(db, undefined));
});

test("pushChanged: skips a listing that was never notified at all", async () => {
  await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "telegram",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    okTelegram as typeof fetch,
    async () => {
      insertListing(db, "s", raw("n6"));
      setPhase(db, "n6", "candidate", "evaluator", "evaluator");
      // last_changed_at set but notified_at never set -> not in "changed since notified" scope
      await pushChanged(db, undefined);
      assert.equal(getByFbId(db, "n6")!.notified_at, null);
    },
  );
});

test("pushChanged: re-notifies a previously-notified listing that changed since, capturing the new message id", async () => {
  await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "telegram",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    okTelegram as typeof fetch,
    async () => {
      const { markNotified, applyRecheck } = await import("../db/listings.js");
      insertListing(db, "s", raw("n7", 100));
      setPhase(db, "n7", "candidate", "evaluator", "evaluator");
      markNotified(db, "n7");
      // last_changed_at must be strictly after notified_at for changedSinceNotified
      // to pick this row up — force that ordering rather than racing two
      // back-to-back nowIso() calls that can land in the same millisecond.
      await new Promise((r) => setTimeout(r, 5));
      applyRecheck(db, "n7", { price: 250 });
      await pushChanged(db, undefined);
      const after = getByFbId(db, "n7")!;
      assert.equal(after.telegram_message_id, 777);
    },
  );
});
