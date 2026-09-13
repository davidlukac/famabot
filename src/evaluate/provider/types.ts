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

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Sum a batch of usages (e.g. across retry attempts). null if the batch is empty. */
export function sumUsage(parts: (EvalUsage | null)[]): EvalUsage | null {
  const real = parts.filter((p): p is EvalUsage => p != null);
  if (!real.length) return null;
  const anyPriced = real.some((p) => p.costUsd != null);
  return {
    tokensIn: real.reduce((n, p) => n + p.tokensIn, 0),
    tokensOut: real.reduce((n, p) => n + p.tokensOut, 0),
    tokensCached: real.reduce((n, p) => n + p.tokensCached, 0),
    costUsd: anyPriced ? real.reduce((n, p) => n + (p.costUsd ?? 0), 0) : null,
  };
}

/**
 * USD cost from tiered per-1M-token pricing, or null when no price is
 * configured (all three zero) — shared by every API backend below.
 */
export function tieredCost(
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
