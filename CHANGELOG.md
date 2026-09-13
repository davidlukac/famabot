# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0]

### Added
- Two more evaluator backends alongside `claude-cli` and `zai`: **`claude-api`**
  (Anthropic Messages API) and **`codex-cli`** / **`codex-api`** (OpenAI, via the
  local Codex CLI or its Chat Completions API). `FAMABOT_EVALUATOR` now picks
  from five backends behind one `EvalProvider` interface.
- Per-evaluation token and cost accounting, stored per listing and shown in the
  `browse`/`serve` detail modal and `reevaluate` output.
- Description cleaning: strips Facebook's page furniture (Walk Score widget, ad
  slot, seller card, "Today's picks" carousel) from what the evaluator sees,
  while keeping the seller's own text, attribute rows, and the walkability
  summary — typically 40-60% smaller, and category-agnostic.
- Per-listing evaluation is now dispatched as soon as its data is ready and
  overlapped with the pacing delay before the next listing, instead of being
  batched until the whole poll finishes — candidates get pushed within seconds
  of being found.
- Multi-category, multi-search support: any number of searches across any
  Facebook Marketplace category, each with its own criteria and an optional
  per-search `persona` overriding the evaluator's voice.
- `watch` re-reads `searches.yaml` on every poll — enabling/disabling a search
  or editing its criteria takes effect on the next pass, no restart needed.
- Telegram as a notification backend, alongside ntfy/command/messenger.
- ESLint + Prettier, a `node --test` suite (6 → 87 tests over the course of
  this release), and a GitHub Actions CI pipeline (typecheck, lint, format,
  build, test) on Node 22.x and 24.x.
- MIT license; README rewritten for public consumption.

### Changed
- Default evaluator models moved to the small/fast tier (Haiku 4.5 / GLM-5.3-Flash
  / gpt-5-mini, depending on backend) instead of a flagship model — a
  per-listing yes/no classification doesn't need one.
- Internal architecture cleanup: extracted a shared `evaluateStoreAndNotify()`
  service used by both the poll loop and `famabot reevaluate` (previously
  duplicated, which had silently dropped notifications and manual-phase
  protection from the CLI path — both fixed); split the 900-line, five-job
  `notify/browse.ts` into focused `reporting/{query,html,terminal}.ts` modules;
  unified `enrich/commute.ts` onto the same provider-interface pattern as the
  evaluator backends; removed several small pieces of duplicated logic
  (external-link extraction, verdict→phase mapping, re-eval eligibility rules).

### Fixed
- `famabot reevaluate` now notifies on new candidates and preserves
  manually-advanced phases (`contacted`, …) instead of silently resetting them.
- An unrecognized `FAMABOT_ROUTING` value used to leave drive-time lookups
  silently broken with `routingEnabled()` still reporting true; now it's a
  clear warning and correctly reports disabled.
- The CLI's `--version` output was a second hardcoded copy that had already
  drifted from `package.json`; now reads from `package.json` directly.

## [0.1.0]

Initial public release. Watches one or more Facebook Marketplace searches on
an interval, scrapes new listings, evaluates each against per-search criteria
via a local `claude` CLI or the z.ai API, and tracks the ones worth pursuing
through a manual pipeline (`candidate → contacted → visit_scheduled → visited
→ accepted / declined`). Includes `browse`/`serve` reporting views, ntfy/
command/messenger notifications, optional drive-time enrichment (ORS/Google/
Mapbox), and dedup/change-detection/re-evaluation on the underlying SQLite store.
