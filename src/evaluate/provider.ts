import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../log.js";

const execFileAsync = promisify(execFile);

export class EvalProviderError extends Error {}
/** Back-compat alias — some call sites still catch `ClaudeCliError`. */
export const ClaudeCliError = EvalProviderError;

export interface CompleteOptions {
  systemPrompt?: string;
  timeoutMs?: number;
}

/** Token accounting + approximate USD cost for one `complete()` call. */
export interface EvalUsage {
  tokensIn: number;
  tokensOut: number;
  /** Input tokens served from the provider's prompt cache (subset of tokensIn). */
  tokensCached: number;
  /** USD, from the model's configured per-token price. null if not priced. */
  costUsd: number | null;
}

export interface CompleteResult {
  text: string;
  /** null when the backend does not report usage (e.g. `claude` CLI without it). */
  usage: EvalUsage | null;
}

/**
 * One backend for the evaluator: takes a system + user prompt, returns the
 * assistant's text plus token/cost accounting. Swapped via `FAMABOT_EVALUATOR`.
 */
export interface EvalProvider {
  /** Identifier recorded in the DB `model` column and shown in logs. */
  readonly model: string;
  complete(prompt: string, opts?: CompleteOptions): Promise<CompleteResult>;
}

/** Sum a batch of usages (e.g. across retry attempts). null if the batch is empty. */
export function sumUsage(parts: (EvalUsage | null)[]): EvalUsage | null {
  const real = parts.filter((p): p is EvalUsage => p != null);
  if (!real.length) return null;
  const anyPriced = real.some((p) => p.costUsd != null);
  return {
    tokensIn: real.reduce((n, p) => n + p.tokensIn, 0),
    tokensOut: real.reduce((n, p) => n + p.tokensOut, 0),
    tokensCached: real.reduce((n, p) => n + p.tokensCached, 0),
    costUsd: anyPriced
      ? real.reduce((n, p) => n + (p.costUsd ?? 0), 0)
      : null,
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;

// --- claude-cli backend ------------------------------------------------------

/** Scratch cwd so the CLI never picks up a project CLAUDE.md or local tooling. */
const CLI_CWD = mkdtempSync(join(tmpdir(), "famabot-claude-"));

const NO_TOOLS =
  "Bash Edit Write Read WebSearch WebFetch Glob Grep Task NotebookEdit MultiEdit";

/**
 * Runs one non-interactive `claude` turn via the local CLI (subscription auth —
 * no ANTHROPIC_API_KEY needed).
 */
class ClaudeCliProvider implements EvalProvider {
  constructor(readonly model: string) {}

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--disallowedTools",
      NO_TOOLS,
    ];
    if (this.model) args.push("--model", this.model);
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    args.push(prompt);

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("claude", args, {
        cwd: CLI_CWD,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") {
        throw new EvalProviderError(
          "`claude` CLI not found on PATH. Install Claude Code, or set FAMABOT_EVALUATOR=zai.",
        );
      }
      throw new EvalProviderError(
        `claude CLI failed: ${e.stderr?.trim() || e.message}`,
      );
    }

    let payload: {
      is_error?: boolean;
      subtype?: string;
      result?: unknown;
      total_cost_usd?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new EvalProviderError(
        `Could not parse CLI output as JSON:\n${stdout.slice(0, 500)}`,
      );
    }
    if (payload.is_error || payload.subtype !== "success") {
      throw new EvalProviderError(
        `claude CLI returned an error: ${String(payload.result ?? "unknown")}`,
      );
    }

    // The CLI envelope carries real billed cost + token counts when signed in.
    let usage: EvalUsage | null = null;
    if (payload.usage) {
      const cached = payload.usage.cache_read_input_tokens ?? 0;
      usage = {
        tokensIn: (payload.usage.input_tokens ?? 0) + cached,
        tokensOut: payload.usage.output_tokens ?? 0,
        tokensCached: cached,
        costUsd: payload.total_cost_usd ?? null,
      };
    }
    return { text: String(payload.result ?? ""), usage };
  }
}

// --- z.ai backend ----------------------------------------------------------

const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_DEFAULT_MODEL = "glm-5.3-flash";
const ZAI_DEFAULT_MAX_TOKENS = 4096;
// "high" gives a full summary at ~1.5x the token cost of "low" but ~2x cheaper
// than the unhinted default (which burns 1400-2000 tokens on a hidden reasoning
// trace). "low" is terser and occasionally drops the `verdict` field.
const ZAI_DEFAULT_REASONING_EFFORT = "high";

// z.ai published list price for GLM-5.3-Flash, USD per 1M tokens (Sept 2026):
//   input $0.15 · cached input $0.03 · output $0.50
// (the $0.075 / $0.015 / $0.25 launch promo ended 2026-09-09.)
// Override per FAMABOT_ZAI_PRICE_* — e.g. if you use a cheaper gateway or a
// different GLM model. Set all three to 0 to disable the cost estimate.
const ZAI_DEFAULT_PRICE_IN = 0.15;
const ZAI_DEFAULT_PRICE_CACHED = 0.03;
const ZAI_DEFAULT_PRICE_OUT = 0.5;

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
class ZaiProvider implements EvalProvider {
  private readonly o: ZaiOptions;

  constructor(
    readonly model: string,
    options: ZaiOptions,
  ) {
    this.o = options;
  }

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
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
      throw new EvalProviderError(
        `z.ai request failed: ${(err as Error).message}`,
      );
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

  /** True when at least one price is set, so a cost figure is meaningful. */
  private get priced(): boolean {
    return (
      this.o.priceInPerM > 0 ||
      this.o.priceCachedPerM > 0 ||
      this.o.priceOutPerM > 0
    );
  }

  private toUsage(u: ZaiUsage | undefined): EvalUsage | null {
    if (!u) return null;
    const tokensIn = u.prompt_tokens ?? 0;
    const tokensOut = u.completion_tokens ?? 0;
    const tokensCached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const costUsd = this.priced
      ? ((tokensIn - tokensCached) / 1e6) * this.o.priceInPerM +
        (tokensCached / 1e6) * this.o.priceCachedPerM +
        (tokensOut / 1e6) * this.o.priceOutPerM
      : null;
    return { tokensIn, tokensOut, tokensCached, costUsd };
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

// --- factory -------------------------------------------------------------

/** Positive number from env, else the fallback. */
function envNum(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Non-negative number from env (0 allowed, to disable a price), else fallback. */
function envPrice(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const ZAI_REASONING_EFFORTS = new Set(["low", "high", "max"]);

export function createEvalProvider(
  env: NodeJS.ProcessEnv = process.env,
): EvalProvider {
  const kind = (env.FAMABOT_EVALUATOR ?? "claude-cli").trim().toLowerCase();
  switch (kind) {
    case "claude-cli":
      return new ClaudeCliProvider(
        env.FAMABOT_EVAL_MODEL?.trim() || "claude-sonnet-5",
      );
    case "zai": {
      const effortRaw = (
        env.FAMABOT_ZAI_REASONING_EFFORT ?? ZAI_DEFAULT_REASONING_EFFORT
      )
        .trim()
        .toLowerCase();
      const reasoningEffort =
        effortRaw === "" || effortRaw === "default"
          ? ""
          : ZAI_REASONING_EFFORTS.has(effortRaw)
            ? effortRaw
            : (() => {
                throw new EvalProviderError(
                  `FAMABOT_ZAI_REASONING_EFFORT must be low|high|max|default (got "${effortRaw}").`,
                );
              })();
      return new ZaiProvider(env.FAMABOT_ZAI_MODEL?.trim() || ZAI_DEFAULT_MODEL, {
        apiKey: env.FAMABOT_ZAI_API_KEY?.trim() || undefined,
        baseUrl:
          env.FAMABOT_ZAI_BASE_URL?.trim().replace(/\/+$/, "") ||
          ZAI_DEFAULT_BASE_URL,
        maxTokens: envNum(env.FAMABOT_ZAI_MAX_TOKENS, ZAI_DEFAULT_MAX_TOKENS),
        reasoningEffort,
        priceInPerM: envPrice(env.FAMABOT_ZAI_PRICE_IN, ZAI_DEFAULT_PRICE_IN),
        priceCachedPerM: envPrice(
          env.FAMABOT_ZAI_PRICE_CACHED,
          ZAI_DEFAULT_PRICE_CACHED,
        ),
        priceOutPerM: envPrice(env.FAMABOT_ZAI_PRICE_OUT, ZAI_DEFAULT_PRICE_OUT),
      });
    }
    default:
      throw new EvalProviderError(
        `Unknown FAMABOT_EVALUATOR: "${kind}" (expected "claude-cli" or "zai").`,
      );
  }
}

let cached: EvalProvider | undefined;

/** The process-wide evaluator backend, built once from the environment. */
export function getEvalProvider(): EvalProvider {
  return (cached ??= createEvalProvider());
}
