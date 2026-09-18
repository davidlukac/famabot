import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeApiProvider } from "./claude-api.js";
import { CodexApiProvider } from "./codex-api.js";
import { ZaiProvider } from "./zai.js";
import { EvalProviderError, type EvalProvider } from "./types.js";

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

function textFetch(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as typeof fetch;
}

interface Fixture {
  name: string;
  make: (apiKey: string | undefined) => EvalProvider;
  successPayload: unknown;
  successText: string;
  contentlessPayload: unknown;
}

const fixtures: Fixture[] = [
  {
    name: "claude-api",
    make: (apiKey) =>
      new ClaudeApiProvider("claude-haiku-4-5-20251001", {
        apiKey,
        baseUrl: "https://claude-api.test",
        maxTokens: 4096,
        priceInPerM: 1,
        priceCachedPerM: 0.1,
        priceOutPerM: 5,
      }),
    successPayload: {
      content: [{ type: "text", text: '{"verdict":"candidate"}' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
    },
    successText: '{"verdict":"candidate"}',
    contentlessPayload: { content: [], stop_reason: "max_tokens" },
  },
  {
    name: "codex-api",
    make: (apiKey) =>
      new CodexApiProvider("gpt-5-mini", {
        apiKey,
        baseUrl: "https://codex-api.test",
        maxTokens: 4096,
        priceInPerM: 0.25,
        priceCachedPerM: 0.125,
        priceOutPerM: 2,
      }),
    successPayload: {
      choices: [
        { message: { content: '{"verdict":"reject"}' }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    },
    successText: '{"verdict":"reject"}',
    contentlessPayload: { choices: [{ message: {}, finish_reason: "length" }] },
  },
  {
    name: "zai",
    make: (apiKey) =>
      new ZaiProvider("glm-5.3-flash", {
        apiKey,
        baseUrl: "https://zai.test",
        maxTokens: 4096,
        reasoningEffort: "high",
        priceInPerM: 0.15,
        priceCachedPerM: 0.03,
        priceOutPerM: 0.5,
      }),
    successPayload: {
      choices: [
        { message: { content: '{"verdict":"candidate"}' }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 300,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
    successText: '{"verdict":"candidate"}',
    contentlessPayload: { choices: [{ message: {}, finish_reason: "length" }] },
  },
];

for (const f of fixtures) {
  test(`${f.name}: missing API key throws before any request`, async () => {
    await assert.rejects(() => f.make(undefined).complete("x"), EvalProviderError);
  });

  test(`${f.name}: success returns the parsed text and usage`, async () => {
    await withFetch(jsonFetch(200, f.successPayload), async () => {
      const result = await f.make("key").complete("prompt", { systemPrompt: "sys" });
      assert.equal(result.text, f.successText);
      assert.ok(result.usage);
      assert.ok(result.usage!.tokensIn > 0);
    });
  });

  test(`${f.name}: a non-2xx response throws with the status and body`, async () => {
    await withFetch(textFetch(500, "server exploded"), async () => {
      await assert.rejects(
        () => f.make("key").complete("x"),
        (err: unknown) =>
          err instanceof EvalProviderError &&
          /500/.test(err.message) &&
          /server exploded/.test(err.message),
      );
    });
  });

  test(`${f.name}: a network failure is wrapped in EvalProviderError`, async () => {
    await withFetch(throwingFetch("ECONNRESET"), async () => {
      await assert.rejects(
        () => f.make("key").complete("x"),
        (err: unknown) =>
          err instanceof EvalProviderError && /ECONNRESET/.test(err.message),
      );
    });
  });

  test(`${f.name}: unparseable JSON body throws EvalProviderError`, async () => {
    await withFetch(textFetch(200, "not json"), async () => {
      await assert.rejects(() => f.make("key").complete("x"), EvalProviderError);
    });
  });

  test(`${f.name}: a response with no usable content throws EvalProviderError`, async () => {
    await withFetch(jsonFetch(200, f.contentlessPayload), async () => {
      await assert.rejects(() => f.make("key").complete("x"), EvalProviderError);
    });
  });

  test(`${f.name}: no usage field in the response yields null usage, not a crash`, async () => {
    const payload = JSON.parse(JSON.stringify(f.successPayload));
    delete payload.usage;
    await withFetch(jsonFetch(200, payload), async () => {
      const result = await f.make("key").complete("x");
      assert.equal(result.usage, null);
    });
  });
}
