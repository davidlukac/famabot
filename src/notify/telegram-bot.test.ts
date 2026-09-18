import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, nowIso } from "../db/index.js";
import {
  getByFbId,
  insertListing,
  setPhase,
  setTelegramMessageId,
} from "../db/listings.js";
import {
  isAuthorizedChat,
  processUpdate,
  runTelegramBot,
  sendReply,
  type TelegramUpdate,
} from "./telegram-bot.js";
import type { EvalProvider } from "../evaluate/provider/index.js";
import type { RawListing } from "../types.js";

const db = openDb(":memory:");

function raw(fbId: string): RawListing {
  return {
    fbId,
    url: `https://example.com/${fbId}`,
    title: `listing ${fbId}`,
    price: 100,
    currency: "$",
    location: "here",
    imageUrl: null,
    postedAt: nowIso(),
    description: null,
    raw: null,
  };
}

function candidate(fbId: string): void {
  insertListing(db, "tg-search", raw(fbId));
  setPhase(db, fbId, "candidate", "evaluator", "evaluator");
}

function update(
  text: string,
  opts: { replyToMessageId?: number } = {},
): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      chat: { id: 1 },
      text,
      reply_to_message:
        opts.replyToMessageId != null
          ? { message_id: opts.replyToMessageId }
          : undefined,
    },
  };
}

function stubProvider(classification: unknown): EvalProvider {
  return {
    model: "stub",
    complete: async () => ({ text: JSON.stringify(classification), usage: null }),
  };
}

test("processUpdate: /reject <fbId> <comment> applies the action directly, no AI call needed", async () => {
  candidate("tg1");
  const provider = stubProvider({ action: null, comment: null, confidence: 0 });
  const res = await processUpdate(db, update("/reject tg1 too far away"), provider);
  assert.match(res.reply, /rejected/i);
  assert.equal(getByFbId(db, "tg1")!.phase, "rejected");
});

test("processUpdate: /reject <marketplace URL> <comment> resolves the fbId from the URL", async () => {
  candidate("2052413975478510");
  const provider = stubProvider({});
  const res = await processUpdate(
    db,
    update(
      "/reject https://www.facebook.com/marketplace/item/2052413975478510/ too far",
    ),
    provider,
  );
  assert.match(res.reply, /rejected/i);
  assert.equal(getByFbId(db, "2052413975478510")!.phase, "rejected");
});

test("processUpdate: /hold <fbId> <comment> logs feedback, phase unchanged", async () => {
  candidate("tg2");
  const provider = stubProvider({});
  const res = await processUpdate(db, update("/hold tg2 still deciding"), provider);
  assert.match(res.reply, /noted|hold/i);
  assert.equal(getByFbId(db, "tg2")!.phase, "candidate");
});

test("processUpdate: a slash command missing a required comment asks for one, doesn't touch the DB", async () => {
  candidate("tg3");
  const provider = stubProvider({});
  const res = await processUpdate(db, update("/hold tg3"), provider);
  assert.match(res.reply, /comment/i);
  assert.equal(getByFbId(db, "tg3")!.phase, "candidate");
});

test("processUpdate: a reply to a known candidate message classifies free text via AI", async () => {
  candidate("tg4");
  setTelegramMessageId(db, "tg4", 555);
  const provider = stubProvider({
    action: "accept",
    comment: "great fit",
    confidence: 0.9,
  });
  const res = await processUpdate(
    db,
    update("yeah let's go for this one, great fit", { replyToMessageId: 555 }),
    provider,
  );
  assert.match(res.reply, /accepted/i);
  assert.equal(getByFbId(db, "tg4")!.phase, "accepted");
});

test("processUpdate: low-confidence classification asks for clarification instead of guessing", async () => {
  candidate("tg5");
  setTelegramMessageId(db, "tg5", 556);
  const provider = stubProvider({ action: "reject", comment: null, confidence: 0.2 });
  const res = await processUpdate(
    db,
    update("hmm not sure", { replyToMessageId: 556 }),
    provider,
  );
  assert.match(res.reply, /not sure|clarify|didn't understand/i);
  assert.equal(getByFbId(db, "tg5")!.phase, "candidate");
});

test("processUpdate: free text with no reply-to and no slash command asks how to address a candidate", async () => {
  const provider = stubProvider({ action: null, comment: null, confidence: 0 });
  const res = await processUpdate(db, update("hello bot"), provider);
  assert.match(res.reply, /reply to|fbId|command/i);
});

test("processUpdate: unknown fbId in a slash command reports it clearly", async () => {
  const provider = stubProvider({});
  const res = await processUpdate(db, update("/reject no-such-id whatever"), provider);
  assert.match(res.reply, /no listing|not found/i);
});

test("processUpdate: /help lists every available command", async () => {
  const provider = stubProvider({});
  const res = await processUpdate(db, update("/help"), provider);
  assert.match(res.reply, /\/reject/);
  assert.match(res.reply, /\/hold/);
  assert.match(res.reply, /\/accept/);
  assert.match(res.reply, /\/acquisition-failed/);
  assert.match(res.reply, /\/acquisition-rejected/);
  assert.match(res.reply, /\/acquired-continue/);
  assert.match(res.reply, /\/acquired-stop/);
});

test("processUpdate: an unrecognized slash command lists every available command", async () => {
  const provider = stubProvider({});
  const res = await processUpdate(db, update("/bogus tg1 whatever"), provider);
  assert.match(res.reply, /unknown/i);
  assert.match(res.reply, /\/reject/);
  assert.match(res.reply, /\/acquired-stop/);
});

test("processUpdate: the no-fbId-resolved fallback also lists every available command", async () => {
  const provider = stubProvider({ action: null, comment: null, confidence: 0 });
  const res = await processUpdate(db, update("hello bot"), provider);
  assert.match(res.reply, /\/reject/);
  assert.match(res.reply, /\/acquired-stop/);
});

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("sendReply: posts to Telegram's sendMessage and never throws on success", async () => {
  let body: unknown;
  const fetchImpl = (async (_url, init) => {
    body = JSON.parse((init as RequestInit).body as string);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  await withFetch(fetchImpl, () => sendReply("tok", 42, "hi there"));
  assert.deepEqual(body, { chat_id: 42, text: "hi there" });
});

test("sendReply: an HTTP error is swallowed, not thrown", async () => {
  await withFetch(
    (async () => new Response("nope", { status: 500 })) as typeof fetch,
    async () => {
      await assert.doesNotReject(() => sendReply("tok", 42, "hi"));
    },
  );
});

test("sendReply: a network failure is swallowed, not thrown", async () => {
  await withFetch(
    (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
    async () => {
      await assert.doesNotReject(() => sendReply("tok", 42, "hi"));
    },
  );
});

test("runTelegramBot: rejects immediately if FAMABOT_TELEGRAM_BOT_TOKEN is unset", async () => {
  const prevEnv = { ...process.env };
  delete process.env.FAMABOT_TELEGRAM_BOT_TOKEN;
  delete process.env.FAMABOT_TELEGRAM_CHAT_ID;
  try {
    await assert.rejects(() => runTelegramBot(db), /FAMABOT_TELEGRAM_BOT_TOKEN/);
  } finally {
    process.env = prevEnv;
  }
});

test("runTelegramBot: rejects immediately if FAMABOT_TELEGRAM_CHAT_ID is unset", async () => {
  const prevEnv = { ...process.env };
  process.env.FAMABOT_TELEGRAM_BOT_TOKEN = "tok";
  delete process.env.FAMABOT_TELEGRAM_CHAT_ID;
  try {
    await assert.rejects(() => runTelegramBot(db), /FAMABOT_TELEGRAM_CHAT_ID/);
  } finally {
    process.env = prevEnv;
  }
});

test("isAuthorizedChat: true only when the numeric chat id string-matches the configured one", () => {
  assert.equal(isAuthorizedChat(12345, "12345"), true);
  assert.equal(isAuthorizedChat(12345, "99999"), false);
});

test("isAuthorizedChat: false for a missing chat id (undefined or null)", () => {
  assert.equal(isAuthorizedChat(undefined, "12345"), false);
  assert.equal(isAuthorizedChat(null, "12345"), false);
});

test("isAuthorizedChat: a negative group/channel chat id matches when configured with the same value", () => {
  assert.equal(isAuthorizedChat(-100123456789, "-100123456789"), true);
  assert.equal(isAuthorizedChat(-100123456789, "100123456789"), false);
});
