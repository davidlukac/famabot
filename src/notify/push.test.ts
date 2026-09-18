import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateMsg,
  fbListingLink,
  fbMobileLink,
  notifyCandidate,
  type CandidateMsg,
} from "./push.js";
import type { ListingRow } from "../types.js";

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
  assert.equal(sent.sent, true);
});

test("notifyCandidate: false when the only configured backend fails", async () => {
  const sent = await withStubbedNotify(
    { FAMABOT_NOTIFY: "ntfy", FAMABOT_NTFY_URL: "https://ntfy.example/topic" },
    fail as typeof fetch,
    () => notifyCandidate(msg()),
  );
  assert.equal(sent.sent, false);
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
  assert.equal(sent.sent, true);
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
  assert.equal(sent.sent, false);
});
function listingRow(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    fb_id: "999",
    search_key: "test-search",
    url: "https://example.com/999",
    title: "A nice place",
    price: 1500,
    currency: "$",
    location: "Downtown",
    image_url: null,
    description: null,
    raw_json: null,
    posted_at: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    last_changed_at: null,
    availability: "active",
    notified_at: null,
    drive_km: null,
    drive_min: null,
    phase: "candidate",
    eval_verdict: "candidate",
    eval_score: 0.75,
    eval_reasoning: "a".repeat(500),
    eval_extracted_json: null,
    eval_model: null,
    eval_tokens_in: null,
    eval_tokens_out: null,
    eval_tokens_cached: null,
    eval_cost_usd: null,
    evaluated_at: null,
    phase_updated_at: null,
    notes: null,
    telegram_message_id: null,
    ...overrides,
  };
}

test("fbListingLink / fbMobileLink: canonical desktop and mobile URLs", () => {
  assert.equal(fbListingLink("123"), "https://www.facebook.com/marketplace/item/123/");
  assert.equal(fbMobileLink("123"), "https://m.facebook.com/marketplace/item/123/");
});

test("candidateMsg: formats price from currency+price, defaults location, truncates reasoning", () => {
  const m = candidateMsg(listingRow());
  assert.equal(m.price, "$1500");
  assert.equal(m.reason.length, 400);
  assert.equal(m.title, "A nice place");
});

test("candidateMsg: 'price?' when price is null, prefix prepended to title, location defaults to ''", () => {
  const m = candidateMsg(listingRow({ price: null, location: null }), "↻ updated: ");
  assert.equal(m.price, "price?");
  assert.equal(m.title, "↻ updated: A nice place");
  assert.equal(m.location, "");
});

test("notifyCandidate: the 'command' backend runs FAMABOT_NOTIFY_CMD with listing env vars", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/famabot-cmd-");
  const outFile = `${dir}/out.txt`;
  const prevEnv = { ...process.env };
  process.env.FAMABOT_NOTIFY = "command";
  process.env.FAMABOT_NOTIFY_CMD = `echo "$FAMABOT_TITLE|$FAMABOT_SCORE" > ${outFile}`;
  try {
    const result = await notifyCandidate(msg({ title: "Test Listing" }));
    assert.equal(result.sent, true);
    const contents = await readFile(outFile, "utf8");
    assert.match(contents, /Test Listing\|0\.65/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    process.env = prevEnv;
  }
});

test("notifyCandidate: the 'command' backend fails cleanly (not sent) when FAMABOT_NOTIFY_CMD is unset", async () => {
  const prevEnv = { ...process.env };
  process.env.FAMABOT_NOTIFY = "command";
  delete process.env.FAMABOT_NOTIFY_CMD;
  try {
    const result = await notifyCandidate(msg());
    assert.equal(result.sent, false);
  } finally {
    process.env = prevEnv;
  }
});

test("notifyCandidate: the 'command' backend fails cleanly when the command exits non-zero", async () => {
  const prevEnv = { ...process.env };
  process.env.FAMABOT_NOTIFY = "command";
  process.env.FAMABOT_NOTIFY_CMD = "exit 1";
  try {
    const result = await notifyCandidate(msg());
    assert.equal(result.sent, false);
  } finally {
    process.env = prevEnv;
  }
});

test("notifyCandidate: an unknown backend name is skipped without marking anything sent", async () => {
  const prevEnv = { ...process.env };
  process.env.FAMABOT_NOTIFY = "not-a-real-backend";
  try {
    const result = await notifyCandidate(msg());
    assert.equal(result.sent, false);
  } finally {
    process.env = prevEnv;
  }
});
