import { ClaudeCliProvider } from "./claude-cli.js";
import {
  ClaudeApiProvider,
  CLAUDE_API_DEFAULT_BASE_URL,
  CLAUDE_API_DEFAULT_MODEL,
  CLAUDE_API_DEFAULT_MAX_TOKENS,
  CLAUDE_API_DEFAULT_PRICE_IN,
  CLAUDE_API_DEFAULT_PRICE_CACHED,
  CLAUDE_API_DEFAULT_PRICE_OUT,
} from "./claude-api.js";
import {
  ZaiProvider,
  ZAI_DEFAULT_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_DEFAULT_MAX_TOKENS,
  ZAI_DEFAULT_REASONING_EFFORT,
  ZAI_DEFAULT_PRICE_IN,
  ZAI_DEFAULT_PRICE_CACHED,
  ZAI_DEFAULT_PRICE_OUT,
  ZAI_REASONING_EFFORTS,
} from "./zai.js";
import { CodexCliProvider, CODEX_CLI_DEFAULT_MODEL } from "./codex-cli.js";
import {
  CodexApiProvider,
  CODEX_API_DEFAULT_BASE_URL,
  CODEX_API_DEFAULT_MODEL,
  CODEX_API_DEFAULT_MAX_TOKENS,
  CODEX_API_DEFAULT_PRICE_IN,
  CODEX_API_DEFAULT_PRICE_CACHED,
  CODEX_API_DEFAULT_PRICE_OUT,
} from "./codex-api.js";
import { EvalProviderError, type EvalProvider } from "./types.js";

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

export function createEvalProvider(env: NodeJS.ProcessEnv = process.env): EvalProvider {
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
          env.FAMABOT_ZAI_BASE_URL?.trim().replace(/\/+$/, "") || ZAI_DEFAULT_BASE_URL,
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
