import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../../log.js";
import {
  DEFAULT_TIMEOUT_MS,
  EvalProviderError,
  type CompleteOptions,
  type CompleteResult,
  type EvalProvider,
  type EvalUsage,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Scratch cwd — same reasoning as CLI_CWD above: no project context leaks in. */
const CODEX_CLI_CWD = mkdtempSync(join(tmpdir(), "famabot-codex-"));

// The only model confirmed to work under ChatGPT-account auth at
// implementation time (this machine, codex-cli 0.151.0) — OpenAI's API-only
// model names (gpt-5-mini, gpt-5-codex, o4-mini, the account's own configured
// default...) were all rejected with "not supported when using Codex with a
// ChatGPT account." Override via FAMABOT_CODEX_CLI_MODEL if your account/CLI
// version allows something lighter; there was no smaller option available to
// pick here as a default.
export const CODEX_CLI_DEFAULT_MODEL = "gpt-5.5";

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
export class CodexCliProvider implements EvalProvider {
  constructor(readonly model: string) {}

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompleteResult> {
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
