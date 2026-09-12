import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const COLOR: Record<Level, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let filePath: string | null = null;
let minLevel: Level = "info";
const useColor = process.stdout.isTTY === true;

export function initLogger(opts: { file?: string; verbose?: boolean }): void {
  if (opts.file) {
    filePath = opts.file;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      /* ignore */
    }
  }
  if (opts.verbose) minLevel = "debug";
}

export function logFilePath(): string | null {
  return filePath;
}

function fmt(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + fmt(extra);
  const plain = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;

  if (filePath) {
    try {
      appendFileSync(filePath, plain + "\n");
    } catch {
      /* ignore file errors */
    }
  }

  const pretty = useColor
    ? `${DIM}${ts}${RESET} ${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET} ${msg}${DIM}${tail}${RESET}`
    : plain;
  (level === "warn" || level === "error" ? console.error : console.log)(pretty);
}

export const log = {
  debug: (m: string, x?: unknown) => emit("debug", m, x),
  info: (m: string, x?: unknown) => emit("info", m, x),
  warn: (m: string, x?: unknown) => emit("warn", m, x),
  error: (m: string, x?: unknown) => emit("error", m, x),
};
