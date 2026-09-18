import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_TIMEOUT_MS,
  EvalProviderError,
  type CompleteOptions,
  type CompleteResult,
  type EvalProvider,
  type EvalUsage,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Scratch cwd so the CLI never picks up a project CLAUDE.md or local tooling. */
const CLI_CWD = mkdtempSync(join(tmpdir(), "famabot-claude-"));

const NO_TOOLS =
  "Bash Edit Write Read WebSearch WebFetch Glob Grep Task NotebookEdit MultiEdit";

/**
 * Runs one non-interactive `claude` turn via the local CLI (subscription auth —
 * no ANTHROPIC_API_KEY needed).
 */
export class ClaudeCliProvider implements EvalProvider {
  constructor(readonly model: string) {}

  // Shells out to the real `claude` binary — exercising the success path in
  // a test would mean either a live (slow, billed, non-deterministic) AI call
  // or reimplementing node:child_process's execFile as a mock. The request-
  // building/error-mapping logic is the same shape already validated for the
  // fetch-based providers (claude-api.ts et al.); this is just the transport.
  /* node:coverage disable */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompleteResult> {
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
  /* node:coverage enable */
}
