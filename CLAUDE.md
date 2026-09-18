# famabot — project notes for Claude

## Commands

- `npm test` — run the unit tests (`node --test`).
- `npm run test:coverage` — run the same tests with coverage; **fails the
  build if line/branch/function coverage drops below 85%** (see policy below).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — ESLint.
- `npm run format` / `npm run format:check` — Prettier.
- CI (`.github/workflows/ci.yml`) runs all of the above (`test:coverage`, not
  plain `test`) on every push/PR to `main`, on Node 22.x and 24.x.

## Testing & coverage policy

- **Coverage gate: 85% lines, 85% branches, 85% functions**, enforced by
  `npm run test:coverage` (`--experimental-test-coverage` +
  `--test-coverage-lines/branches/functions=85`, Node's built-in test-runner
  coverage — no external tool). Treat a drop below this as a build failure to
  fix, not a number to explain away.
- **Follow TDD for non-trivial logic**: write the failing `node:test` first,
  then the implementation. Every existing `*.test.ts` file is the template —
  match its style (plain `node:test` + `node:assert/strict`, no test
  framework abstractions, descriptive test names that state the behavior and
  often the *why*).
- **When you add or change behavior, add real tests for it in the same
  change** — don't let coverage regress and rely on a later cleanup pass.
  Prefer testing pure logic directly; for I/O-adjacent code, stub the I/O
  boundary (`global.fetch`, an injected function param) rather than skipping
  the test — see patterns below.
- **Use `/* node:coverage disable */` … `/* node:coverage enable */`
  ONLY for code that is genuinely not economical to unit test** — and say why
  in a one-line comment above the `disable`. That means:
  - Real Playwright `Page`/`BrowserContext` automation (`scrape/marketplace.ts`'s
    `scrapeSearch`/`scrapeDetail`, `notify/push.ts`'s `sendMessenger`) —
    testing it would mean reimplementing Playwright's API as a mock.
  - Shelling out to an external CLI binary for a real AI call
    (`evaluate/provider/claude-cli.ts`, `codex-cli.ts`'s `complete()`) —
    exercising the success path needs a live, billed, non-deterministic call.
    Extract any pure parsing logic inside them (see `findCodexError`) into an
    exported function and test *that* directly instead of ignoring the whole
    file.
  - Spawning a real OS process with no meaningful assertion beyond re-testing
    the platform switch (`commands/shared.ts`'s `openInBrowser`).
  - An infinite long-polling network loop (`notify/telegram-bot.ts`'s
    `runTelegramBot` loop body) — pull its per-message logic into a separate,
    directly-testable function (`processUpdate`) and only ignore the
    loop/transport shell around it, not the logic.
  - Do **not** reach for `disable`/`enable` just because a test is fiddly to
    write, and never wrap more than the specific untestable function/block —
    ignoring a whole file hides regressions in the parts of it that *are*
    testable.
- **Prefer these concrete patterns already in the codebase** over inventing
  new ones:
  - Stub `global.fetch` (save/restore the real one in a `finally`) to test
    fetch-based code without a network call — see `notify/push.test.ts`'s
    `withStubbedNotify`, `enrich/commute.test.ts`'s `withFetch`,
    `evaluate/provider/api-providers.test.ts`.
  - For a real shell command with no network dependency (e.g.
    `notify/push.ts`'s `command` backend), just run a real, portable one
    (`echo`, `exit 1`) instead of mocking `child_process` — see
    `push.test.ts`'s `command` backend tests.
  - Inject a fake implementation via an optional options param, defaulting to
    the real one, rather than reaching for module mocking — see
    `services/evaluation-service.ts`'s `evaluateFn` option and its tests.
  - To test something gated behind a process-wide singleton that reads env
    once (`evaluate/provider/factory.ts`'s cached `getEvalProvider()`), set
    the env var and use a **dynamic** `await import(...)` at the top of a
    dedicated test file (imports are hoisted, so a static import would run
    before the env is set) — see `evaluate/evaluator.test.ts`.
  - A DB-backed test opens `openDb(":memory:")` once at module scope and
    shares it across that file's tests (the process-wide `handle` singleton
    in `db/index.ts` makes a second `openDb(path)` call anywhere else in the
    same process silently return the *first* call's handle — keep each test
    file to exactly one `openDb` call; see the comment in
    `db/migration.test.ts`).
