import { log } from "../../log.js";
import {
  DEFAULT_TIMEOUT_MS,
  EvalProviderError,
  tieredCost,
  type CompleteOptions,
  type CompleteResult,
  type EvalProvider,
  type EvalUsage,
} from "./types.js";

export const CODEX_API_DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Small/fast tier, matching the same "no flagship model for a classifier" call
// as claude-api's Haiku default. OpenAI's cheap-tier naming turns over fast —
// check platform.openai.com/pricing and override FAMABOT_CODEX_API_MODEL /
// _PRICE_* if this has been superseded.
export const CODEX_API_DEFAULT_MODEL = "gpt-5-mini";
export const CODEX_API_DEFAULT_MAX_TOKENS = 4096;

// OpenAI published list price for GPT-5-mini, USD per 1M tokens (2026):
//   input $0.25 · cached input ~50% off ($0.125, standard OpenAI cache discount) · output $2.00
export const CODEX_API_DEFAULT_PRICE_IN = 0.25;
export const CODEX_API_DEFAULT_PRICE_CACHED = 0.125;
export const CODEX_API_DEFAULT_PRICE_OUT = 2.0;

export interface CodexApiOptions {
  apiKey: string | undefined;
  baseUrl: string;
  maxTokens: number;
  priceInPerM: number;
  priceCachedPerM: number;
  priceOutPerM: number;
}

interface CodexApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * OpenAI Chat Completions API directly (needs FAMABOT_CODEX_API_KEY) — the
 * API-key counterpart to `codex-cli`'s ChatGPT-subscription auth, and not
 * subject to that auth's model allowlist.
 *
 * Built strictly to OpenAI's documented Chat Completions shape; not
 * live-tested end-to-end (no API key was available at implementation time —
 * the request/response plumbing mirrors the already-proven z.ai provider,
 * which uses the same OpenAI-compatible wire format).
 */
export class CodexApiProvider implements EvalProvider {
  private readonly o: CodexApiOptions;

  constructor(
    readonly model: string,
    options: CodexApiOptions,
  ) {
    this.o = options;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompleteResult> {
    if (!this.o.apiKey) {
      throw new EvalProviderError(
        "FAMABOT_CODEX_API_KEY is not set (FAMABOT_EVALUATOR=codex-api).",
      );
    }
    const messages: { role: string; content: string }[] = [];
    if (opts.systemPrompt) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_completion_tokens: this.o.maxTokens,
      response_format: { type: "json_object" },
    };

    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.o.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EvalProviderError(`OpenAI request failed: ${(err as Error).message}`);
    }

    const bodyText = await res.text();
    if (!res.ok) {
      throw new EvalProviderError(
        `OpenAI API returned ${res.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    let payload: {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      usage?: CodexApiUsage;
    };
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new EvalProviderError(
        `Could not parse OpenAI response as JSON:\n${bodyText.slice(0, 500)}`,
      );
    }

    const finishReason = payload.choices?.[0]?.finish_reason;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new EvalProviderError(
        `OpenAI response had no message content` +
          (finishReason ? ` (finish_reason: ${finishReason})` : "") +
          `:\n${bodyText.slice(0, 500)}`,
      );
    }

    const usage = this.toUsage(payload.usage);
    if (usage) {
      log.debug(
        `codex-api usage: ${usage.tokensIn} in (${usage.tokensCached} cached) + ${usage.tokensOut} out` +
          (usage.costUsd != null ? `  ~$${usage.costUsd.toFixed(5)}` : ""),
      );
    }
    return { text: content, usage };
  }

  private toUsage(u: CodexApiUsage | undefined): EvalUsage | null {
    if (!u) return null;
    const tokensIn = u.prompt_tokens ?? 0;
    const tokensOut = u.completion_tokens ?? 0;
    const tokensCached = u.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      tokensIn,
      tokensOut,
      tokensCached,
      costUsd: tieredCost(
        tokensIn,
        tokensCached,
        tokensOut,
        this.o.priceInPerM,
        this.o.priceCachedPerM,
        this.o.priceOutPerM,
      ),
    };
  }
}
