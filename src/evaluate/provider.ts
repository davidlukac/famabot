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

/**
 * USD cost from tiered per-1M-token pricing, or null when no price is
 * configured (all three zero) — shared by every API backend below.
 */
function tieredCost(
  tokensIn: number,
  tokensCached: number,
  tokensOut: number,
  priceInPerM: number,
  priceCachedPerM: number,
  priceOutPerM: number,
): number | null {
  if (priceInPerM <= 0 && priceCachedPerM <= 0 && priceOutPerM <= 0) return null;
  return (
    ((tokensIn - tokensCached) / 1e6) * priceInPerM +
    (tokensCached / 1e6) * priceCachedPerM +
    (tokensOut / 1e6) * priceOutPerM
  );
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

// --- claude-api backend ------------------------------------------------------

const CLAUDE_API_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const CLAUDE_API_VERSION = "2023-06-01";
// Deliberately the small/fast tier, not the CLI's old Sonnet default — a
// per-listing yes/no classification doesn't need a flagship model.
const CLAUDE_API_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_DEFAULT_MAX_TOKENS = 4096;

// Anthropic published list price for Claude Haiku 4.5, USD per 1M tokens (2026):
//   input $1.00 · cached input (read) $0.10 (90% off) · output $5.00
const CLAUDE_API_DEFAULT_PRICE_IN = 1.0;
const CLAUDE_API_DEFAULT_PRICE_CACHED = 0.1;
const CLAUDE_API_DEFAULT_PRICE_OUT = 5.0;

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
class ClaudeApiProvider implements EvalProvider {
  private readonly o: ClaudeApiOptions;

  constructor(
    readonly model: string,
    options: ClaudeApiOptions,
  ) {
    this.o = options;
  }

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
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

// --- codex-cli backend -----------------------------------------------------

/** Scratch cwd — same reasoning as CLI_CWD above: no project context leaks in. */
const CODEX_CLI_CWD = mkdtempSync(join(tmpdir(), "famabot-codex-"));

// The only model confirmed to work under ChatGPT-account auth at
// implementation time (this machine, codex-cli 0.151.0) — OpenAI's API-only
// model names (gpt-5-mini, gpt-5-codex, o4-mini, the account's own configured
// default...) were all rejected with "not supported when using Codex with a
// ChatGPT account." Override via FAMABOT_CODEX_CLI_MODEL if your account/CLI
// version allows something lighter; there was no smaller option available to
// pick here as a default.
const CODEX_CLI_DEFAULT_MODEL = "gpt-5.5";

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
}

/** Pull the first error-ish event out of a `codex exec --json` stream, if any. */
function findCodexError(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const evt = JSON.parse(t) as CodexEvent;
      if (evt.type === "error" || evt.type === "turn.failed") {
        return evt.error?.message ?? evt.message ?? t;
      }
    } catch {
      /* not JSON, skip */
    }
  }
  return undefined;
}

/**
 * Runs one non-interactive `codex exec` turn via the local Codex CLI
 * (ChatGPT-subscription auth — no OPENAI_API_KEY needed). `--json` streams
 * newline-delimited events; we take the final `agent_message` as the reply
 * and `turn.completed.usage` for token accounting (no cost estimate — this is
 * subscription usage, not metered per-token billing, same as `claude-cli`).
 *
 * Reasoning effort is forced to `low`: Codex's own harness/tool-definition
 * overhead runs ~15-17k input tokens per call (mostly cache hits) regardless
 * of prompt content, which dwarfs anything reasoning-effort tuning saves —
 * unlike z.ai's GLM backend, there's no cheap way around that fixed cost here.
 */
class CodexCliProvider implements EvalProvider {
  constructor(readonly model: string) {}

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const fullPrompt = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n---\n\n${prompt}`
      : prompt;
    const args = [
      "exec",
      "-m",
      this.model,
      "-c",
      "model_reasoning_effort=low",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "-C",
      CODEX_CLI_CWD,
      fullPrompt,
    ];

    let stdout: string;
    try {
      const child = execFileAsync("codex", args, {
        cwd: CODEX_CLI_CWD,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      // Close stdin immediately — codex otherwise waits on it even though the
      // prompt is already a positional arg (it appends piped stdin as extra
      // context if the pipe stays open).
      child.child.stdin?.end();
      ({ stdout } = await child);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === "ENOENT") {
        throw new EvalProviderError(
          "`codex` CLI not found on PATH. Install it (npm i -g @openai/codex, or " +
            "brew install codex), or set FAMABOT_EVALUATOR to another backend.",
        );
      }
      const detail = e.stdout ? findCodexError(e.stdout) : undefined;
      throw new EvalProviderError(
        `codex exec failed: ${detail ?? e.stderr?.trim() ?? e.message}`,
      );
    }

    let text: string | undefined;
    let usage: EvalUsage | null = null;
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let evt: CodexEvent;
      try {
        evt = JSON.parse(t);
      } catch {
        continue;
      }
      if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
        text = evt.item.text;
      } else if (evt.type === "turn.completed" && evt.usage) {
        const u = evt.usage;
        usage = {
          tokensIn: (u.input_tokens ?? 0) + (u.cache_write_input_tokens ?? 0),
          tokensOut: u.output_tokens ?? 0,
          tokensCached: u.cached_input_tokens ?? 0,
          costUsd: null,
        };
      } else if (evt.type === "turn.failed" || evt.type === "error") {
        throw new EvalProviderError(
          `codex exec error: ${evt.error?.message ?? evt.message ?? t}`,
        );
      }
    }
    if (!text) {
      throw new EvalProviderError(
        `codex exec produced no agent_message:\n${stdout.slice(0, 500)}`,
      );
    }
    if (usage) {
      log.debug(
        `codex-cli usage: ${usage.tokensIn} in (${usage.tokensCached} cached) + ${usage.tokensOut} out`,
      );
    }
    return { text, usage };
  }
}

// --- codex-api backend -------------------------------------------------------

const CODEX_API_DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Small/fast tier, matching the same "no flagship model for a classifier" call
// as claude-api's Haiku default. OpenAI's cheap-tier naming turns over fast —
// check platform.openai.com/pricing and override FAMABOT_CODEX_API_MODEL /
// _PRICE_* if this has been superseded.
const CODEX_API_DEFAULT_MODEL = "gpt-5-mini";
const CODEX_API_DEFAULT_MAX_TOKENS = 4096;

// OpenAI published list price for GPT-5-mini, USD per 1M tokens (2026):
//   input $0.25 · cached input ~50% off ($0.125, standard OpenAI cache discount) · output $2.00
const CODEX_API_DEFAULT_PRICE_IN = 0.25;
const CODEX_API_DEFAULT_PRICE_CACHED = 0.125;
const CODEX_API_DEFAULT_PRICE_OUT = 2.0;

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
class CodexApiProvider implements EvalProvider {
  private readonly o: CodexApiOptions;

  constructor(
    readonly model: string,
    options: CodexApiOptions,
  ) {
    this.o = options;
  }

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
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
      throw new EvalProviderError(
        `OpenAI request failed: ${(err as Error).message}`,
      );
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
      // Small/fast tier by default — a per-listing yes/no call doesn't need
      // a flagship model. Override with e.g. claude-sonnet-5 if you want more.
      return new ClaudeCliProvider(
        env.FAMABOT_EVAL_MODEL?.trim() || "claude-haiku-4-5-20251001",
      );
    case "claude-api":
      return new ClaudeApiProvider(
        env.FAMABOT_CLAUDE_API_MODEL?.trim() || CLAUDE_API_DEFAULT_MODEL,
        {
          apiKey: env.FAMABOT_CLAUDE_API_KEY?.trim() || undefined,
          baseUrl:
            env.FAMABOT_CLAUDE_API_BASE_URL?.trim().replace(/\/+$/, "") ||
            CLAUDE_API_DEFAULT_BASE_URL,
          maxTokens: envNum(
            env.FAMABOT_CLAUDE_API_MAX_TOKENS,
            CLAUDE_API_DEFAULT_MAX_TOKENS,
          ),
          priceInPerM: envPrice(
            env.FAMABOT_CLAUDE_API_PRICE_IN,
            CLAUDE_API_DEFAULT_PRICE_IN,
          ),
          priceCachedPerM: envPrice(
            env.FAMABOT_CLAUDE_API_PRICE_CACHED,
            CLAUDE_API_DEFAULT_PRICE_CACHED,
          ),
          priceOutPerM: envPrice(
            env.FAMABOT_CLAUDE_API_PRICE_OUT,
            CLAUDE_API_DEFAULT_PRICE_OUT,
          ),
        },
      );
    case "codex-cli":
      return new CodexCliProvider(
        env.FAMABOT_CODEX_CLI_MODEL?.trim() || CODEX_CLI_DEFAULT_MODEL,
      );
    case "codex-api":
      return new CodexApiProvider(
        env.FAMABOT_CODEX_API_MODEL?.trim() || CODEX_API_DEFAULT_MODEL,
        {
          apiKey: env.FAMABOT_CODEX_API_KEY?.trim() || undefined,
          baseUrl:
            env.FAMABOT_CODEX_API_BASE_URL?.trim().replace(/\/+$/, "") ||
            CODEX_API_DEFAULT_BASE_URL,
          maxTokens: envNum(
            env.FAMABOT_CODEX_API_MAX_TOKENS,
            CODEX_API_DEFAULT_MAX_TOKENS,
          ),
          priceInPerM: envPrice(
            env.FAMABOT_CODEX_API_PRICE_IN,
            CODEX_API_DEFAULT_PRICE_IN,
          ),
          priceCachedPerM: envPrice(
            env.FAMABOT_CODEX_API_PRICE_CACHED,
            CODEX_API_DEFAULT_PRICE_CACHED,
          ),
          priceOutPerM: envPrice(
            env.FAMABOT_CODEX_API_PRICE_OUT,
            CODEX_API_DEFAULT_PRICE_OUT,
          ),
        },
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
        `Unknown FAMABOT_EVALUATOR: "${kind}" (expected one of ` +
          `"claude-cli", "claude-api", "codex-cli", "codex-api", "zai").`,
      );
  }
}

let cached: EvalProvider | undefined;

/** The process-wide evaluator backend, built once from the environment. */
export function getEvalProvider(): EvalProvider {
  return (cached ??= createEvalProvider());
}
