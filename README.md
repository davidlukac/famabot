# famabot

Watch Facebook Marketplace searches on an interval, run every **new** listing through a
Claude agent that judges it against your criteria, and track the ones worth pursuing through a
manual pipeline (`candidate → contacted → visit_scheduled → visited → accepted / declined`).

Built for a rental hunt, but any Marketplace search works — the criteria are free-form.

## How it works

```
searches.yaml ──▶ scrape (Playwright, logged-in Chromium)
                     │  newest listings per search
                     ▼
                  dedupe against SQLite  ──▶ new listings
                     │
                     ▼
                  evaluate each (claude CLI / z.ai — see FAMABOT_EVALUATOR)
                     │  verdict: candidate | reject  + fit score + reasoning
                     ▼
                  store + set phase  ──▶  candidate table printed
```

Your manual phase changes are never overwritten by the evaluator — it only ever acts on
listings still in `new`.

## Setup

By default the evaluator shells out to the local **`claude` CLI**, so it runs on your existing
Claude subscription — no API key. Make sure `claude` is on your `PATH` and you're signed in.
To use the **z.ai API** instead, set `FAMABOT_EVALUATOR=zai` and `FAMABOT_ZAI_API_KEY` in
`.env` (model defaults to `glm-5.3-flash`, override with `FAMABOT_ZAI_MODEL`). Other z.ai
knobs — `FAMABOT_ZAI_REASONING_EFFORT` (default `high`), `FAMABOT_ZAI_MAX_TOKENS`, and
`FAMABOT_ZAI_PRICE_IN` / `_CACHED` / `_OUT` (default to z.ai's GLM-5.3-Flash list price) — are
in `.env.example`. Each eval stores its token counts and an **approximate cost** (z.ai's API
returns tokens, not dollars), shown in the `browse` / `serve` detail modal and the
`reevaluate` output. Note GLM-5.3-Flash isn't fully deterministic; borderline fit scores move
±~0.05 between runs.

```bash
npm install
npx playwright install chromium

cp .env.example .env
cp searches.example.yaml searches.yaml   # then edit for your search

npm run dev -- login          # opens a browser; log in to Facebook once
```

The login session is stored in `./.data/chromium-profile/` and reused headlessly. Re-run
`login` if it expires or Facebook shows a checkpoint.

## Commands

| Command | What it does |
|---|---|
| `famabot login` | Headed browser to log in to Facebook; session is saved. |
| `famabot poll` | One scrape + evaluate + recheck pass over all enabled searches. |
| `famabot watch [-i 90]` | `poll` on a loop, every ~90 min (± jitter). Ctrl-C stops after the current pass. |
| `famabot serve [-P 8787] [--interval 30]` | Live auto-refreshing HTML report on `localhost`. |
| `famabot browse [filters] [--sort fresh] [--html [path]] [--open] [--all]` | Explore listings in the terminal (clickable titles) or as an HTML file. |
| `famabot list [-p <phase>] [-s <search>] [--json]` | Compact pipeline table. |
| `famabot show <fbId>` | One listing in full: fields, availability, links, reasoning, history. |
| `famabot move <fbId> <phase> [-n "note"] [-f]` | Advance a phase. Illegal transitions are rejected unless `-f`. |
| `famabot note <fbId> "text"` | Append a timestamped note. |
| `famabot reevaluate [-p new] [-s <search>]` | Re-run the agent on stored listings. |
| `famabot recheck [-n 20]` | Re-open tracked listings to catch closed / edited ones (also runs inside every poll). |
| `famabot open <fbId>` | Open the listing URL in your browser. |

**`famabot serve`** — the live report. Every column is named and click-to-sort (▲/▼ on the
active one). Filter panel: **text search**, **min score**, **Status** (per-phase checkboxes +
quick buttons *all / active pipeline / candidates* + *show gone*), **Date** (pick the field —
listing created / listing updated / indexed — then a preset *any / 24h / 3d / week / month* or
an explicit from–to range), and **Search** (one checkbox per saved search — matters once you
add a second search alongside `mission-bc-house`). Columns: Score, Price, Bd, Drive, Phase,
**Indexed** (`first_seen_at`), **Posted** (`posted_at` — the seller's listing date; falls back
to Indexed for sorting), **Updated** (`last_changed_at`), Search, Location, Title (hover = the
agent's reasoning), Flags (hover = the red-flag list), Why. The server hands the browser every
active + gone listing; all filtering/sorting is client-side, so toggles are instant. Rows for
gone listings show struck-through; `✎` = changed, `↗` = has an off-platform link.

**`famabot browse`** (terminal / `--html`) filters: `--phase a,b` `--search <key>`
`--verdict candidate|reject` `--min-score` `--min-price` `--max-price` `--min-beds`
`--max-commute <min>` `--since <days>` `--has <text>` `--flagged` `--all`. Sort: `fresh`
(default), `score`, `price`, `beds`, `seen`, `title`, `phase`.

### Candidate notifications

Off by default. Set `FAMABOT_NOTIFY` to a comma-list of backends (see `.env.example`):
- **`telegram`** — sends via a Telegram bot. Create one with [@BotFather](https://t.me/BotFather)
  for `FAMABOT_TELEGRAM_BOT_TOKEN`, message it once, then read
  `api.telegram.org/bot<token>/getUpdates` for your `FAMABOT_TELEGRAM_CHAT_ID` (a negative id
  for a group/channel — add the bot first). Rich formatting + listing-photo preview.
- **`ntfy`** — POSTs to `FAMABOT_NTFY_URL` (install the [ntfy](https://ntfy.sh) app, subscribe
  to an unguessable topic). Zero-account, reliable.
- **`command`** — runs `FAMABOT_NOTIFY_CMD` with `FAMABOT_TITLE`, `FAMABOT_PRICE`,
  `FAMABOT_URL`, `FAMABOT_SCORE`, `FAMABOT_REASON`, `FAMABOT_LOCATION` in the environment. Use
  this to wire anything — a WhatsApp CLI, `osascript`, Slack webhook, `mail`.
- **`messenger`** — posts into `FAMABOT_MESSENGER_THREAD` (e.g. a self-note group) via the
  logged-in browser. No extra auth, but Messenger's DOM is unstable — treat as best-effort.

Each candidate is notified once (`notified_at` guards re-sends).

During development, prefix with `npm run dev --` (e.g. `npm run dev -- list`). After
`npm run build`, run `node dist/cli.js …` or link the `famabot` bin.

## searches.yaml — defining what you're looking for

One entry per saved search, at the repo root. The file is re-read on every `poll` / `watch`
pass, so edits take effect on the next poll.

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

**Feeds the `claude` evaluator** (everything else under `criteria` — not sent to FB, applied
per listing):

| Field | Effect |
|---|---|
| `criteria.mustHaves` | Hard constraint — a clear violation ⇒ `reject`. |
| `criteria.dealBreakers` | Hard constraint — if present ⇒ `reject`. |
| `criteria.niceToHaves` | Soft — nudges the 0–1 `fit_score`. |
| `criteria.notes` | Free-form guidance — soft. |
| `criteria.propertyType`, `criteria.currency` | Context for the model. |

Other per-search keys: `key` (unique slug, shown in `list`/`show`, used by `reevaluate`),
`enabled`, `fetchDetails` (open each new listing for its full description — slower, better
evals). See `searches.example.yaml` for a filled-in rental plus a commented second search for
a used desk.

## Configuration (env / `.env`)

| Var | Default | Meaning |
|---|---|---|
| `FAMABOT_DB` | `./.data/famabot.db` | SQLite file. |
| `FAMABOT_PROFILE_DIR` | `./.data/chromium-profile` | Persistent browser profile. |
| `FAMABOT_HEADLESS` | `true` | `poll`/`watch` browser visibility (`login` is always headed). |
| `FAMABOT_SEARCHES` | `./searches.yaml` | Searches file path. |

## Notes & limitations

- Scraping Marketplace is against Facebook's Terms of Service and its page/GraphQL structure
  changes without notice. The scraper tries GraphQL-response capture first and falls back to
  DOM parsing; the raw payload is stored in `listings.raw_json` for re-parsing.
- **Pace is deliberately slow** and built for 24/7 background use: searches run in random
  order, ~20 listings each, 30 s (± random) between detail-page opens, 2 min between searches,
  90 min between polls. All tunable via `FAMABOT_*` env vars (see `.env.example`); the first
  poll is the slow one, steady-state polls have little to do. Run it with
  `npm run dev -- watch` (or the built `node dist/cli.js watch`) under `nohup`, `pm2`, `tmux`,
  or a launchd/systemd unit.
- **Location:** set `criteria.lat` / `criteria.lng` (with `radiusKm`). Facebook only reliably
  scopes a Marketplace search by coordinates — a `/marketplace/<city>/` slug it doesn't
  recognise gets silently redirected to a generic, IP-based page with **all filters dropped**
  (famabot logs a `WARN` when it detects this). If a location still won't stick, open
  `famabot login` and set your Marketplace location + radius by hand once; the account
  remembers it.
- If `better-sqlite3` ever fails to build, `src/db/index.ts` can be switched to the Node 24
  built-in `node:sqlite` with no other code changes.

### What the evaluator sees

It runs as **your own local buyer's agent** (persona set in `src/evaluate/prompt.ts`,
overridable via `FAMABOT_PERSONA`). Per listing the `claude` call gets a JSON object: `title`,
`price`, `currency`, `location`, `posted_at`, `commute_minutes` / `commute_km` (if drive-time
enrichment is on), the full **description text** from the detail page (includes FB's attribute
rows — bedrooms, property type — as text, ≤6 000 chars), `external_links` (non-Facebook URLs
found in that text), and the listing `url`. It does **not** get photos, the seller's profile,
the map, or the contents of external links. The prompt treats "pushes you to an external form /
asks for money before a viewing / no local showing offer" as a red flag. Adding **image
analysis** is possible but needs an API-based provider (headless `claude -p` has no image input).

### Drive time to a fixed point (e.g. a train station)

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

### Freshness — the Facebook query

The search URL always sends `sortBy=creation_time_descend`, and after scraping, the results
are re-sorted by `posted_at` and only the newest `FAMABOT_LISTING_CAP` (20) are kept — so a
poll always looks at the genuinely-newest listings even when FB's own ordering is "recommended"
rather than chronological. Set `criteria.maxAgeDays` (snaps to FB's 1 / 7 / 30-day "Date
listed" buckets) to drop everything older. The real lever for beating other renters is **poll
frequency** — 90 min is conservative; drop `FAMABOT_WATCH_INTERVAL_MIN` (or `watch -i`) to
20–30 for a hot market, accepting a bit more ban risk. (`browse --sort fresh` is the
report-side equivalent and is the default there.)

### Re-indexing: dedup, and re-evaluate on change

- **Dedup** is by `fb_id`. A listing already in the DB is never re-inserted or re-rendered; a
  scrape just refreshes `last_seen_at` and cheap fields (price, relist date) from the search
  payload.
- **Change detection.** Price / relist-date changes are caught on every scrape. Description
  edits are caught on the recheck pass, compared on a *normalised signature* (page chrome like
  "12 people viewed" / "Listed 3h ago" is stripped) so only real edits count. Any change sets
  `last_changed_at`.
- **Re-evaluation.** When `last_changed_at` is newer than `evaluated_at`, the next poll
  re-runs the agent (up to 20/poll). For evaluator-owned phases (`new` / `candidate` /
  `rejected`) the verdict and phase are updated. For a listing **you've** advanced
  (`contacted` …) the score/reasoning are refreshed but the phase is left alone, and — if
  notifications are on — you get a `↻ updated` ping.

### Listings that disappear

Every poll re-opens up to `FAMABOT_RECHECK_PER_POLL` (default 8) of the stalest listings
you're pursuing (`candidate` + manually-advanced phases; `new`/`rejected` are skipped).
`famabot recheck -n 20` does a bigger batch on demand. If the page says
sold/removed/unavailable (or redirects to the Marketplace home) the listing is marked
`availability = unavailable` and hidden from `browse`/`serve` unless you pass `--all`.

- The evaluator asks its backend for a JSON object per new listing (~10–15 s each) and
  validates it with zod, retrying once. The `claude-cli` backend runs
  `claude -p --output-format json --model claude-sonnet-5` with all tools disabled and a
  scratch cwd so it doesn't pick up any project context; the `zai` backend POSTs to z.ai's
  OpenAI-compatible `/chat/completions`. Both live behind the `EvalProvider` interface in
  `src/evaluate/provider.ts` — add another provider there and a case in `createEvalProvider`.
