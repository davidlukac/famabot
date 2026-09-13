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

export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";
export const ZAI_DEFAULT_MAX_TOKENS = 4096;
// "high" gives a full summary at ~1.5x the token cost of "low" but ~2x cheaper
// than the unhinted default (which burns 1400-2000 tokens on a hidden reasoning
// trace). "low" is terser and occasionally drops the `verdict` field.
export const ZAI_DEFAULT_REASONING_EFFORT = "high";

// z.ai published list price for GLM-5.3-Flash, USD per 1M tokens (Sept 2026):
//   input $0.15 · cached input $0.03 · output $0.50
// (the $0.075 / $0.015 / $0.25 launch promo ended 2026-09-09.)
// Override per FAMABOT_ZAI_PRICE_* — e.g. if you use a cheaper gateway or a
// different GLM model. Set all three to 0 to disable the cost estimate.
export const ZAI_DEFAULT_PRICE_IN = 0.15;
export const ZAI_DEFAULT_PRICE_CACHED = 0.03;
export const ZAI_DEFAULT_PRICE_OUT = 0.5;

export const ZAI_REASONING_EFFORTS = new Set(["low", "high", "max"]);

export interface ZaiOptions {
  apiKey: string | undefined;
  baseUrl: string;
  /** Completion budget (reasoning + answer). GLM reasoning traces are large. */
  maxTokens: number;
  /** GLM-5.x reasoning depth: "low" | "high" | "max", or "" to leave default. */
  reasoningEffort: string;
  /** Model price, USD per 1M tokens. All-zero disables the cost estimate. */
  priceInPerM: number;
  priceCachedPerM: number;
  priceOutPerM: number;
}

interface ZaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * z.ai chat completions (OpenAI-compatible). Needs FAMABOT_ZAI_API_KEY.
 *
 * Note: GLM-5.3-Flash is *not* fully deterministic — `temperature: 0` / `top_p`
 * narrow but don't eliminate run-to-run variance, and the endpoint accepts but
 * does not honour `seed` / `do_sample`. Expect borderline fit scores to wobble
 * by ~0.05 between runs.
 */
export class ZaiProvider implements EvalProvider {
  private readonly o: ZaiOptions;

  constructor(
    readonly model: string,
    options: ZaiOptions,
  ) {
    this.o = options;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompleteResult> {
    if (!this.o.apiKey) {
      throw new EvalProviderError(
        "FAMABOT_ZAI_API_KEY is not set (FAMABOT_EVALUATOR=zai).",
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
      temperature: 0,
      top_p: 0.01,
      max_tokens: this.o.maxTokens,
      response_format: { type: "json_object" },
      stream: false,
    };
    if (this.o.reasoningEffort) body.reasoning_effort = this.o.reasoningEffort;

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
      throw new EvalProviderError(`z.ai request failed: ${(err as Error).message}`);
    }

    const bodyText = await res.text();
    if (!res.ok) {
      throw new EvalProviderError(
        `z.ai returned ${res.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    let payload: {
      choices?: {
        message?: { content?: unknown };
        finish_reason?: string;
      }[];
      usage?: ZaiUsage;
    };
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new EvalProviderError(
        `Could not parse z.ai response as JSON:\n${bodyText.slice(0, 500)}`,
      );
    }

    const finishReason = payload.choices?.[0]?.finish_reason;
    const usage = this.toUsage(payload.usage);
    this.logUsage(payload.usage, usage, finishReason);

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new EvalProviderError(
        `z.ai response had no message content` +
          (finishReason ? ` (finish_reason: ${finishReason})` : "") +
          `:\n${bodyText.slice(0, 500)}`,
      );
    }
    return { text: content, usage };
  }

  private toUsage(u: ZaiUsage | undefined): EvalUsage | null {
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

  private logUsage(
    raw: ZaiUsage | undefined,
    usage: EvalUsage | null,
    finishReason?: string,
  ): void {
    if (!usage) return;
    const reasoning = raw?.completion_tokens_details?.reasoning_tokens ?? 0;
    let line =
      `z.ai usage: ${usage.tokensIn} in` +
      (usage.tokensCached ? ` (${usage.tokensCached} cached)` : "") +
      ` + ${usage.tokensOut} out (${reasoning} reasoning) = ` +
      `${usage.tokensIn + usage.tokensOut} tok`;
    if (usage.costUsd != null) line += `  ~$${usage.costUsd.toFixed(5)}`;
    if (finishReason && finishReason !== "stop") {
      line += `  [finish_reason: ${finishReason}]`;
    }
    log.debug(line);
  }
}
