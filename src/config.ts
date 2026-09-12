import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SearchesFileSchema, type Search } from "./types.js";

loadDotenv();

export interface AppConfig {
  dbPath: string;
  profileDir: string;
  headless: boolean;
  searchesPath: string;
  logPath: string;
  verbose: boolean;
}

function truthy(v: string | undefined): boolean {
  return v != null && ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(): AppConfig {
  return {
    dbPath: resolve(process.env.FAMABOT_DB ?? "./.data/famabot.db"),
    profileDir: resolve(process.env.FAMABOT_PROFILE_DIR ?? "./.data/chromium-profile"),
    headless: (process.env.FAMABOT_HEADLESS ?? "true").toLowerCase() !== "false",
    searchesPath: resolve(process.env.FAMABOT_SEARCHES ?? "./searches.yaml"),
    logPath: resolve(process.env.FAMABOT_LOG ?? "./.data/famabot.log"),
    verbose: truthy(process.env.FAMABOT_VERBOSE),
  };
}

export function loadSearches(path: string): Search[] {
  if (!existsSync(path)) {
    throw new Error(
      `No searches file at ${path}. Copy searches.example.yaml to searches.yaml and edit it.`,
    );
  }
  const parsed = parseYaml(readFileSync(path, "utf8"));
  const result = SearchesFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid searches file:\n${z.prettifyError(result.error)}`);
  }
  const keys = new Set<string>();
  for (const s of result.data) {
    if (keys.has(s.key)) throw new Error(`Duplicate search key: ${s.key}`);
    keys.add(s.key);
  }
  return result.data;
}
