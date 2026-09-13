import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyCandidate, type CandidateMsg } from "./push.js";

function msg(overrides: Partial<CandidateMsg> = {}): CandidateMsg {
  return {
    fbId: "123",
    title: "3 Beds 2 Baths - House",
    price: "CA$3000",
    location: "Mission, BC",
    score: 0.65,
    reason: "looks good",
    url: "https://www.facebook.com/marketplace/item/123/",
    search: "mission-bc-house",
    ...overrides,
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

const ok = () => Promise.resolve(new Response("ok", { status: 200 }));
const fail = () => Promise.resolve(new Response("nope", { status: 500 }));

test("notifyCandidate: true when the only configured backend succeeds", async () => {
  const sent = await withStubbedNotify(
    { FAMABOT_NOTIFY: "ntfy", FAMABOT_NTFY_URL: "https://ntfy.example/topic" },
    ok as typeof fetch,
    () => notifyCandidate(msg()),
  );
  assert.equal(sent, true);
});

test("notifyCandidate: false when the only configured backend fails", async () => {
  const sent = await withStubbedNotify(
    { FAMABOT_NOTIFY: "ntfy", FAMABOT_NTFY_URL: "https://ntfy.example/topic" },
    fail as typeof fetch,
    () => notifyCandidate(msg()),
  );
  assert.equal(sent, false);
});

test("notifyCandidate: true if at least one of several backends succeeds", async () => {
  let calls = 0;
  const mixed = ((..._args: Parameters<typeof fetch>) => {
    calls += 1;
    return calls === 1 ? fail() : ok();
  }) as typeof fetch;
  const sent = await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "ntfy,telegram",
      FAMABOT_NTFY_URL: "https://ntfy.example/topic",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    mixed,
    () => notifyCandidate(msg()),
  );
  assert.equal(sent, true);
  assert.equal(calls, 2);
});

test("notifyCandidate: false when every backend fails, even with several configured", async () => {
  const sent = await withStubbedNotify(
    {
      FAMABOT_NOTIFY: "ntfy,telegram",
      FAMABOT_NTFY_URL: "https://ntfy.example/topic",
      FAMABOT_TELEGRAM_BOT_TOKEN: "t",
      FAMABOT_TELEGRAM_CHAT_ID: "1",
    },
    fail as typeof fetch,
    () => notifyCandidate(msg()),
  );
  assert.equal(sent, false);
});
