#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { initLogger, log } from "./log.js";
import { registerScrapingCommands } from "./commands/scraping.js";
import { registerPipelineCommands } from "./commands/pipeline.js";
import { registerReportingCommands } from "./commands/reporting.js";
import { registerNotifyCommands } from "./commands/notify.js";

// Single source of truth for the version string — was a second hardcoded
// copy here that had already drifted from package.json once.
const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const program = new Command();
program
  .name("famabot")
  .description("Watch Facebook Marketplace searches and triage listings with an agent.")
  .version(pkgVersion)
  .option("-v, --verbose", "debug-level logging (also writes to the log file)")
  .hook("preAction", (thisCmd, actionCmd) => {
    const cfg = loadConfig();
    initLogger({
      file: cfg.logPath,
      verbose: Boolean(thisCmd.opts().verbose) || cfg.verbose,
    });
    log.debug(`$ famabot ${actionCmd.name()}`, actionCmd.optsWithGlobals());
  });

registerScrapingCommands(program);
registerPipelineCommands(program);
registerReportingCommands(program);
registerNotifyCommands(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
