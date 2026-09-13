# Contributing

famabot is a personal tool, published as-is in case it's useful to someone
else. Issues and PRs are welcome, but there's no roadmap or support
commitment — treat this more like "open source you can read and fork" than
a maintained product.

## Before opening a PR

```bash
npm install
npx playwright install chromium   # only needed to actually run the scraper

npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

All five run in CI (`.github/workflows/ci.yml`) on every push/PR to `main`,
on Node 22.x and 24.x — a PR that doesn't pass them won't be merged.

## Guidelines

- **Small, focused changes.** One logical change per PR is much easier to
  review than a large mixed one.
- **Tests for new logic.** Pure functions (parsers, filters, provider
  factories, …) should have `node:test` coverage alongside them — see
  `src/**/*.test.ts` for the existing style. Code that needs a live Facebook
  session or a real model API key obviously can't be exercised in CI; a
  clear manual verification note in the PR description is the next best
  thing.
- **Keep the CLI thin.** Business logic belongs in `db/`, `domain/`,
  `services/`, or `evaluate/` — `cli.ts` command actions should mostly be
  "parse args, call one function, print the result."
- **No secrets, ever.** `.env` and `searches.yaml` are gitignored on
  purpose — `.env.example` and `searches.example.yaml` are the templates to
  extend instead.

## Reporting a bug

Include the `famabot` version (`famabot --version`), your OS, the command
you ran, and — if it's not scraping-related — the relevant lines from
`.data/famabot.log` (with `FAMABOT_VERBOSE=1` if you can reproduce it).
Never paste your `.env` or any part of `searches.yaml` you'd rather keep
private; describe the shape of the config instead.
