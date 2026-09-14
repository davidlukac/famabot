# famabot

![CI](https://github.com/davidlukac/famabot/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

**famabot** watches Facebook Marketplace for you. Point it at one or more saved searches —
rentals, a specific used car, furniture, anything Marketplace sells — and it scrapes new
listings on an interval, has an LLM judge each one against *your* criteria in *your* own words,
and pushes the ones worth your time to Telegram or ntfy. Everything else it quietly files away,
browsable later, so you never have to re-scan a feed by hand again.

Built for a rental hunt, but genuinely general-purpose: each search gets its own Facebook
category, its own criteria, and its own evaluator persona, all running side by side.

```
🏠 0.90 · CA$3,000 · 3 Beds 2 Baths - House
📍 Mission, British Columbia

Whole detached house, ~3 km from Mission City Station — well under the 30-minute
commute limit. Dog/cat friendly, garage + driveway, dishwasher. Worth booking a
Saturday viewing promptly, houses like this move fast.

https://www.facebook.com/marketplace/item/.../
```
*(an actual notification, sent to Telegram by famabot mid-poll — see [Candidate notifications](#candidate-notifications))*

> **⚠️ Educational/personal use only, at your own risk.** Scraping Facebook Marketplace
> violates Facebook's Terms of Service — this can get your account checkpoint-restricted or
> disabled, with no warning and no recourse. famabot is not affiliated with Meta/Facebook.
> The evaluator is an LLM and can be wrong — treat every candidate as "worth a human look,"
> not a verified recommendation. Read [`DISCLAIMER.md`](DISCLAIMER.md) before running this
> against your own account.

## Contents

- [Disclaimer](#disclaimer)
- [Why](#why)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Candidate notifications](#candidate-notifications)
- [Defining searches (searches.yaml)](#defining-searches-searchesyaml)
- [The evaluator](#the-evaluator)
- [Configuration](#configuration)
- [Drive time to a fixed point](#drive-time-to-a-fixed-point)
- [Freshness and poll frequency](#freshness-and-poll-frequency)
- [Dedup and re-evaluation](#dedup-and-re-evaluation)
- [Notes and limitations](#notes-and-limitations)
- [Contributing](#contributing)

## Disclaimer

Scraping Facebook Marketplace violates
[Facebook's Terms of Service](https://www.facebook.com/terms.php) — realistic consequences
include your account being checkpoint-restricted or permanently disabled, at Facebook's
discretion and without warning. This is an independent, unofficial project, not affiliated
with or endorsed by Meta/Facebook, built and published for **educational, experimental, and
personal use only** — one person, on their own account, for their own search. It comes with
no warranty ([MIT license](LICENSE)) and no accuracy guarantee: the evaluator is an LLM and
can be wrong, so treat every `candidate` as "worth a human look," never as a verified
recommendation, and verify anything yourself before acting on it. See
[`DISCLAIMER.md`](DISCLAIMER.md) for the full terms — read it before pointing this at a
Facebook account you care about.

## Why

Marketplace is a firehose, and the good stuff gets buried in duplicate listings, dealer spam,
and things that technically match your search terms but obviously aren't what you want (a
sailboat is not a truck, no matter how loosely Facebook's search interprets "Toyota Tacoma").
famabot doesn't just filter by price and keywords — it reads the full listing text the way you
would, checks it against hard constraints you define in plain English, and tells you *why* it
did or didn't make the cut.

## How it works

```
searches.yaml ──▶ scrape (Playwright, your logged-in Chromium session)
                     │  newest listings per search, one search at a time
                     ▼
                  dedupe against SQLite  ──▶ new listings
                     │
                     ▼
                  evaluate each (Claude / Codex / z.ai — CLI or API key, your choice)
                     │  verdict: candidate | reject  +  fit score (0–1)  +  reasoning
                     ▼
                  store + set phase  ──▶  candidate?  push to Telegram/ntfy
```

Evaluation is dispatched the moment a listing's data is ready, overlapped with the pacing delay
before the *next* listing is scraped — so a strong match gets pushed to you within seconds of
being found, not held until the whole poll finishes.

Your manual phase changes are never overwritten by the evaluator — it only ever acts on
listings still in `new`, or ones that changed since their last evaluation.

## Quickstart

```bash
npm install
npx playwright install chromium

cp .env.example .env
cp searches.example.yaml searches.yaml   # then edit for your own search(es)

npm run dev -- login          # opens a browser; log in to Facebook once
npm run dev -- watch          # or: npm run build && node dist/cli.js watch
```

By default the evaluator shells out to your local **`claude` CLI** (existing Claude
subscription, no API key needed — just make sure `claude` is on `PATH` and signed in). Claude
API, Codex CLI, Codex API, and z.ai/GLM are all available too — set `FAMABOT_EVALUATOR` in
`.env` — see [The evaluator](#the-evaluator) for the full list and what each one costs.

The Facebook login session lives in `./.data/chromium-profile/` and is reused headlessly from
then on. Re-run `login` if it expires or Facebook throws a checkpoint at it.

## Commands

| Command | What it does |
|---|---|
| `famabot login` | Headed browser to log in to Facebook; session is saved. |
| `famabot poll` | One scrape + evaluate + recheck pass over all enabled searches. |
| `famabot watch [-i 90]` | `poll` on a loop, every ~90 min (± jitter). Re-reads `searches.yaml` every pass — enable/disable a search or tweak criteria without restarting. Ctrl-C stops after the current pass. |
| `famabot serve [-P 8787] [--interval 30]` | Live auto-refreshing HTML report on `localhost`. |
| `famabot browse [filters] [--sort fresh] [--html [path]] [--open] [--all]` | Explore listings in the terminal (clickable titles) or as an HTML file. |
| `famabot list [-p <phase>] [-s <search>] [--json]` | Compact pipeline table. |
| `famabot show <fbId>` | One listing in full: fields, availability, links, reasoning, history. |
| `famabot move <fbId> <phase> [-n "note"] [-f]` | Advance a phase. Illegal transitions are rejected unless `-f`. |
| `famabot note <fbId> "text"` | Append a timestamped note. |
| `famabot reevaluate [-p new] [-s <search>]` | Re-run the evaluator on stored listings. |
| `famabot recheck [-n 20]` | Re-open tracked listings to catch closed / edited ones (also runs inside every poll). |
| `famabot open <fbId>` | Open the listing URL in your browser. |

**`famabot serve`** — the live report. Every column is named and click-to-sort (▲/▼ on the
active one). Filter panel: **text search**, **min score**, **Status** (per-phase checkboxes +
quick buttons *all / active pipeline / candidates* + *show gone*), **Date** (pick the field —
listing created / listing updated / indexed — then a preset *any / 24h / 3d / week / month* or
an explicit from–to range), and **Search** (one checkbox per saved search, once you have more
than one). Columns: Score, Price, Bd, Drive, Phase, **Indexed** (`first_seen_at`), **Posted**
(`posted_at` — the seller's listing date; falls back to Indexed for sorting), **Updated**
(`last_changed_at`), Search, Location, Title (hover = the agent's reasoning), Flags (hover = the
red-flag list), Why. The server hands the browser every active + gone listing; all
filtering/sorting is client-side, so toggles are instant. Rows for gone listings show
struck-through; `✎` = changed, `↗` = has an off-platform link. Click a row for the full detail
modal — reasoning, extracted fields, red flags, and the evaluator's token/cost accounting for
that listing.

**`famabot browse`** (terminal / `--html`) filters: `--phase a,b` `--search <key>`
`--verdict candidate|reject` `--min-score` `--min-price` `--max-price` `--min-beds`
`--max-commute <min>` `--since <days>` `--has <text>` `--flagged` `--all`. Sort: `fresh`
(default), `score`, `price`, `beds`, `seen`, `title`, `phase`.

During development, prefix with `npm run dev --` (e.g. `npm run dev -- list`). After
`npm run build`, run `node dist/cli.js …` or link the `famabot` bin.

`npm test` runs the unit tests (`node --test`), `npm run typecheck` runs `tsc --noEmit`,
`npm run lint` runs ESLint, and `npm run format` / `format:check` run Prettier. All four run
in CI on every push/PR to `main` (`.github/workflows/ci.yml`, Node 22.x and 24.x).

## Candidate notifications

Off by default. Set `FAMABOT_NOTIFY` to a comma-list of backends (see `.env.example`) — e.g.
`telegram`, or `telegram,ntfy` to fire both:

- **`telegram`** — sends via a Telegram bot. Create one with [@BotFather](https://t.me/BotFather)
  for `FAMABOT_TELEGRAM_BOT_TOKEN`, message it once, then read
  `api.telegram.org/bot<token>/getUpdates` for your `FAMABOT_TELEGRAM_CHAT_ID` (a negative id
  for a group/channel — add the bot first). Rich formatting + a listing-photo preview.
- **`ntfy`** — POSTs to `FAMABOT_NTFY_URL` (install the [ntfy](https://ntfy.sh) app, subscribe
  to an unguessable topic). Zero-account, reliable.
- **`command`** — runs `FAMABOT_NOTIFY_CMD` with `FAMABOT_TITLE`, `FAMABOT_PRICE`,
  `FAMABOT_URL`, `FAMABOT_SCORE`, `FAMABOT_REASON`, `FAMABOT_LOCATION` in the environment. Use
  this to wire anything — a WhatsApp CLI, `osascript`, Slack webhook, `mail`.
- **`messenger`** — posts into `FAMABOT_MESSENGER_THREAD` (e.g. a self-note group) via the
  logged-in browser. No extra auth, but Messenger's DOM is unstable — treat as best-effort.

Each candidate is notified once (`notified_at` guards re-sends), dispatched as soon as its own
evaluation completes — not batched until the whole poll finishes.

## Defining searches (searches.yaml)

One entry per saved search, at the repo root (gitignored — copy `searches.example.yaml` to
start). `watch` re-reads it every poll, so edits — including enabling/disabling a search — take
effect on the next pass with no restart.

Every field does one of two jobs:

**Shapes the Facebook search URL** (the only things FB actually filters on):

| Field | Effect |
|---|---|
| `query` | Free text typed into the Marketplace search box. |
| `category` | Marketplace category slug — `propertyrentals` (default), `propertyforsale`, `search` (everything, query-driven), `vehicles`, `furniture`, `electronics`, … |
| `criteria.location` | First word becomes the `/marketplace/<city>/` slug. |
| `criteria.radiusKm` | Search radius. |
| `criteria.minPrice` / `maxPrice` | Price bounds. |
| `criteria.minBedrooms` / `maxBedrooms` | Only applied on `property*` categories. |
| `criteria.minYear` / `maxYear` | Only applied on the `vehicles` category. |

**Feeds the evaluator** (everything else under `criteria`, plus the top-level `persona` —
applied per listing, not sent to Facebook):

| Field | Effect |
|---|---|
| `criteria.mustHaves` | Hard constraint — a clear violation ⇒ `reject`. |
| `criteria.dealBreakers` | Hard constraint — if present ⇒ `reject`. |
| `criteria.niceToHaves` | Soft — nudges the 0–1 `fit_score`. |
| `criteria.notes` | Free-form guidance — soft. |
| `criteria.propertyType`, `criteria.currency` | Extra context for the model. |
| `persona` | Overrides the evaluator's voice for *this search only* — falls back to `FAMABOT_PERSONA`, then a generic default. |

Other per-search keys: `key` (unique slug, shown in `list`/`show`, used by `reevaluate`),
`enabled`, `fetchDetails` (open each new listing for its full description — slower, better
evals). See `searches.example.yaml` for a filled-in rental, a commented used-furniture search,
and a vehicle search with its own gearhead persona and a year-range filter.

Multiple searches run every poll, one after another with a paced gap between them (not
concurrently) — so adding a second or third search doesn't multiply how aggressively your
account hits Facebook, it just covers more ground per poll.

## The evaluator

Five interchangeable backends, chosen with `FAMABOT_EVALUATOR` — a subscription-CLI and an
API-key option for both Claude and Codex, plus z.ai/GLM:

| `FAMABOT_EVALUATOR` | Auth | Default model | Notes |
|---|---|---|---|
| `claude-cli` *(default)* | your Claude subscription, no key | `claude-haiku-4-5-20251001` | shells out to the local `claude` CLI |
| `claude-api` | `FAMABOT_CLAUDE_API_KEY` | `claude-haiku-4-5-20251001` | Anthropic Messages API directly |
| `codex-cli` | your ChatGPT subscription, no key | `gpt-5.5` | shells out to the local `codex` CLI |
| `codex-api` | `FAMABOT_CODEX_API_KEY` | `gpt-5-mini` | OpenAI Chat Completions API directly |
| `zai` | `FAMABOT_ZAI_API_KEY` | `glm-5.3-flash` | z.ai's OpenAI-compatible API |

All five live behind the `EvalProvider` interface in `src/evaluate/provider.ts` — adding
another one is a small, self-contained change. Defaults deliberately favor small/fast models
(Haiku, not Sonnet; a mini tier, not a flagship) since scoring one listing against a rubric
doesn't need a frontier model — override any of them (`.env.example` has the full list of
`_MODEL` / `_API_KEY` / `_BASE_URL` vars per backend).

**`codex-cli` caveat:** ChatGPT-subscription auth only allows a specific set of models — every
plain OpenAI API model name (`gpt-5-mini`, `gpt-5-codex`, `o4-mini`, …) was rejected with "not
supported when using Codex with a ChatGPT account" during testing. `gpt-5.5` was the one
confirmed to work; there was no lighter option available to fall back to. It also carries a
large, mostly-cached fixed overhead from Codex's own agent harness (~15k input tokens/call
regardless of prompt size) that reasoning-effort tuning can't get around — `codex-api` avoids
that overhead entirely if per-call cost matters more than avoiding a second API key.

**Untested paths:** `claude-api` and `codex-api` were built strictly to their providers'
documented request/response shapes and verified against the real endpoints (auth, error
handling, request format all confirmed live — up to the point of a valid key, which wasn't
available at implementation time). `claude-cli`, `codex-cli`, and `zai` are exercised in
production. If you hit a rough edge on the API-key paths, it's likely a response-parsing detail
— please file an issue.

z.ai-specific knobs (see `.env.example` for the full list and current defaults):

- **`FAMABOT_ZAI_REASONING_EFFORT`** (`low` / `high` / `max` / `default`) — GLM's reasoning
  depth. `high` is the sweet spot: a full-quality summary at roughly the token cost of `low`,
  because the unhinted default burns 1,400–2,000 tokens on a hidden reasoning trace for no
  extra output quality.
- **`FAMABOT_ZAI_PRICE_IN`/`_CACHED`/`_OUT`** — USD per 1M tokens, defaulting to z.ai's
  published GLM-5.3-Flash list price. Every evaluation stores its token counts and an
  approximate cost (z.ai's API returns tokens, not dollars) — visible in the `browse`/`serve`
  detail modal and the `reevaluate` output. `claude-api` and `codex-api` store the same
  token/cost accounting from their own published list prices; `claude-cli` reports its
  subscription-billed cost when the CLI provides one; `codex-cli` reports tokens only (no
  dollar figure — subscription usage, not metered billing).

Note GLM-5.3-Flash isn't fully deterministic; borderline fit scores can move ±~0.05 between
identical runs.

**What it sees.** Per listing, the model gets a JSON object: `title`, `price`, `currency`,
`location`, `posted_at`, `commute_minutes`/`commute_km` (if drive-time enrichment is on), the
listing's **description text**, `external_links` (non-Facebook URLs found in it), and the
listing `url`. It does **not** get photos, the seller's profile, or the contents of external
links.

The description is cleaned before the model ever sees it — Facebook's detail page appends a
Walk Score widget, an ad slot, the seller card, and a "Today's picks" carousel of unrelated
items after the actual listing content, and none of that is useful signal. famabot trims
everything from the ad/seller-card boundary onward while keeping the seller's own text, the
attribute rows (bed/bath counts, vehicle year/mileage, whatever the category has), and the
walkability/transit summary — typically cutting description size by ~40–60% and removing every
trace of the unrelated-listings carousel. This works the same for any category, not just
rentals.

The prompt treats "pushes you to an external site/form, asks for money before you've seen the
item, or offers no way to verify it in person" as a red flag regardless of category. Adding
**image analysis** is possible but needs an API-based provider (the headless `claude -p` CLI
has no image input).

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `FAMABOT_DB` | `./.data/famabot.db` | SQLite file. |
| `FAMABOT_PROFILE_DIR` | `./.data/chromium-profile` | Persistent browser profile. |
| `FAMABOT_HEADLESS` | `true` | `poll`/`watch` browser visibility (`login` is always headed). |
| `FAMABOT_SEARCHES` | `./searches.yaml` | Searches file path. |

Scraping pace, evaluator backend, notifications, and drive-time routing each have their own
block of `FAMABOT_*` vars — all documented with defaults in `.env.example`, which is the
source of truth; nothing here duplicates it.

## Drive time to a fixed point

Set `criteria.commute` (`lat`/`lng`, optional `label`, `arriveBy` "HH:MM", `dayOfWeek`,
`maxMinutes`) and `FAMABOT_ROUTING` to a provider:

| `FAMABOT_ROUTING` | Provider | Traffic / time-of-day | Cost |
|---|---|---|---|
| `ors` | OpenRouteService (OSM) | ❌ free-flow only | free key |
| `mapbox` | Mapbox Directions (`driving-traffic`) | ✅ `depart_at` | free tier ~100k/mo |
| `google` | Google Routes API | ✅ traffic-aware, best model | billing, monthly credit |

For **"drive time at 8am on a weekday with traffic"** you need `mapbox` or `google` — the
fully-open OSM engines (`ors`, OSRM, OpenRouteService) only give free-flow estimates. Drive
time is computed once per new listing (geocoding the listing's `location` string — usually
city-level, so treat the number as approximate unless the listing names a street), stored in
`drive_km` / `drive_min`, fed to the evaluator, shown in `browse`/`serve`, and filterable with
`browse --max-commute <min>`. With `commute.maxMinutes` set it becomes a hard reject once a
provider is configured; until then it's ignored.

## Freshness and poll frequency

The search URL always sends `sortBy=creation_time_descend`, and after scraping, the results
are re-sorted by `posted_at` and only the newest `FAMABOT_LISTING_CAP` (20) are kept — so a
poll always looks at the genuinely-newest listings even when FB's own ordering is "recommended"
rather than chronological. If a search regularly has more active matches than the cap, raise
`FAMABOT_LISTING_CAP`, and likely `FAMABOT_SCROLL_ROUNDS_MAX` too (see below) — otherwise the
scroll pass may never surface enough unique listings to fill the higher cap. Set
`criteria.maxAgeDays` (snaps to FB's 1 / 7 / 30-day "Date listed" buckets) to drop everything
older. The real lever for beating other buyers is **poll frequency** — 90 min is conservative;
drop `FAMABOT_WATCH_INTERVAL_MIN` (or `watch -i`) to 30–40 for a hot market, accepting a bit
more ban risk, or 20–25 for a short intense push (not recommended as a permanent setting).
(`browse --sort fresh` is the report-side equivalent and is the default there.)

Each poll scrolls the results page a random number of times in
`[FAMABOT_SCROLL_ROUNDS_MIN, FAMABOT_SCROLL_ROUNDS_MAX]` (default 3-7) rather than a fixed
count every time, and gives up early once `FAMABOT_SCROLL_STALE_LIMIT` (default 2) consecutive
scrolls surface no new listing — closer to how a real user scrolls a variable amount and stops
once they recognize the same old listings, rather than a bot doing an identical scroll pattern
on every visit forever.

## Dedup and re-evaluation

- **Dedup** is by `fb_id`. A listing already in the DB is never re-inserted or re-rendered; a
  scrape just refreshes `last_seen_at` and cheap fields (price, relist date) from the search
  payload.
- **Change detection.** Price / relist-date changes are caught on every scrape. Description
  edits are caught on the recheck pass, compared on a *normalised signature* (page chrome like
  "12 people viewed" / "Listed 3h ago" is stripped) so only real edits count. Any change sets
  `last_changed_at`, and a re-evaluation is dispatched immediately.
- **Re-evaluation.** For evaluator-owned phases (`new` / `candidate` / `rejected`) the verdict
  and phase are updated. For a listing **you've** advanced (`contacted` …) the score/reasoning
  are refreshed but the phase is left alone, and — if notifications are on — you get a
  `↻ updated` ping.
- **Listings that disappear.** Every poll re-opens up to `FAMABOT_RECHECK_PER_POLL` (default 8)
  of the stalest listings you're pursuing (`candidate` + manually-advanced phases; `new`/
  `rejected` are skipped). `famabot recheck -n 20` does a bigger batch on demand. If the page
  says sold/removed/unavailable (or redirects to the Marketplace home) the listing is marked
  `availability = unavailable` and hidden from `browse`/`serve` unless you pass `--all`.

## Notes and limitations

- Scraping Marketplace is against Facebook's Terms of Service — see
  [`DISCLAIMER.md`](DISCLAIMER.md) for what that actually risks. Separately, Facebook's page/
  GraphQL structure changes without notice: the scraper tries GraphQL-response capture first
  and falls back to DOM parsing; the raw search payload is stored in `listings.raw_json` for
  re-parsing if the format shifts.
- **Pace is deliberately slow** and built for 24/7 background use: searches run in random
  order, ~20 listings each, a randomized ~30s gap between detail-page opens, a ~2 min gap
  between searches, tens of minutes between polls. All tunable via `FAMABOT_*` env vars (see
  `.env.example`); the first poll is the slow one, steady-state polls have little to do. Run it
  with `npm run dev -- watch` (or the built `node dist/cli.js watch`) under `nohup`, `pm2`,
  `tmux`, or a launchd/systemd unit.
- **Location:** set `criteria.lat` / `criteria.lng` (with `radiusKm`). Facebook only reliably
  scopes a Marketplace search by coordinates — a `/marketplace/<city>/` slug it doesn't
  recognise gets silently redirected to a generic, IP-based page with **all filters dropped**
  (famabot logs a `WARN` when it detects this). If a location still won't stick, open
  `famabot login` and set your Marketplace location + radius by hand once; the account
  remembers it.
- If `better-sqlite3` ever fails to build, `src/db/index.ts` can be switched to the Node 24
  built-in `node:sqlite` with no other code changes.
- This is a personal tool, published as-is under the MIT license (see [`LICENSE`](LICENSE)).
  It scrapes a platform that actively tries to prevent scraping — expect to tune the pacing for
  your own account's risk tolerance, and don't be surprised if Facebook's DOM/GraphQL shape
  drifts and needs a selector fix.

## Contributing

Issues and PRs are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for how
to run the checks locally before opening one. See [`CHANGELOG.md`](CHANGELOG.md)
for what's changed release to release.

## License

[MIT](LICENSE) © David Lukac
