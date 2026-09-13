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

export const CLAUDE_API_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const CLAUDE_API_VERSION = "2023-06-01";
// Deliberately the small/fast tier, not the CLI's old Sonnet default — a
// per-listing yes/no classification doesn't need a flagship model.
export const CLAUDE_API_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const CLAUDE_API_DEFAULT_MAX_TOKENS = 4096;

// Anthropic published list price for Claude Haiku 4.5, USD per 1M tokens (2026):
//   input $1.00 · cached input (read) $0.10 (90% off) · output $5.00
export const CLAUDE_API_DEFAULT_PRICE_IN = 1.0;
export const CLAUDE_API_DEFAULT_PRICE_CACHED = 0.1;
export const CLAUDE_API_DEFAULT_PRICE_OUT = 5.0;

export interface ClaudeApiOptions {
  apiKey: string | undefined;
  baseUrl: string;
  maxTokens: number;
  priceInPerM: number;
  priceCachedPerM: number;
  priceOutPerM: number;
}

interface ClaudeApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Anthropic Messages API directly (needs FAMABOT_CLAUDE_API_KEY) — the API-key
 * counterpart to `claude-cli`'s subscription auth, for when you'd rather bill
 * per-token than through a Claude subscription.
 *
 * Built strictly to Anthropic's documented Messages API shape; not
 * live-tested end-to-end (no API key was available at implementation time —
 * the request/response plumbing mirrors the already-proven z.ai provider).
 */
export class ClaudeApiProvider implements EvalProvider {
  private readonly o: ClaudeApiOptions;

  constructor(
    readonly model: string,
    options: ClaudeApiOptions,
  ) {
    this.o = options;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompleteResult> {
    if (!this.o.apiKey) {
      throw new EvalProviderError(
        "FAMABOT_CLAUDE_API_KEY is not set (FAMABOT_EVALUATOR=claude-api).",
      );
    }
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.o.maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts.systemPrompt) body.system = opts.systemPrompt;

    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.o.apiKey,
          "anthropic-version": CLAUDE_API_VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EvalProviderError(
        `Claude API request failed: ${(err as Error).message}`,
      );
    }

    const bodyText = await res.text();
    if (!res.ok) {
      throw new EvalProviderError(
        `Claude API returned ${res.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    let payload: {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
      usage?: ClaudeApiUsage;
    };
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new EvalProviderError(
        `Could not parse Claude API response as JSON:\n${bodyText.slice(0, 500)}`,
      );
    }

    const text = payload.content?.find((b) => b.type === "text")?.text;
    if (!text) {
      throw new EvalProviderError(
        `Claude API response had no text content (stop_reason: ${payload.stop_reason ?? "?"}):\n${bodyText.slice(0, 500)}`,
      );
    }

    const usage = this.toUsage(payload.usage);
    if (usage) {
      log.debug(
        `claude-api usage: ${usage.tokensIn} in (${usage.tokensCached} cached) + ${usage.tokensOut} out` +
          (usage.costUsd != null ? `  ~$${usage.costUsd.toFixed(5)}` : ""),
      );
    }
    return { text, usage };
  }

  private toUsage(u: ClaudeApiUsage | undefined): EvalUsage | null {
    if (!u) return null;
    const cached = u.cache_read_input_tokens ?? 0;
    // Cache-creation tokens are billed at (roughly) the normal input rate, not
    // the cheap cache-read rate, so they're folded into the "uncached" side.
    const tokensIn =
      (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
    const tokensOut = u.output_tokens ?? 0;
    return {
      tokensIn,
      tokensOut,
      tokensCached: cached,
      costUsd: tieredCost(
        tokensIn,
        cached,
        tokensOut,
        this.o.priceInPerM,
        this.o.priceCachedPerM,
        this.o.priceOutPerM,
      ),
    };
  }
}
