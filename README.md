# PermaBan (Node.js)

Score-based CrowdSec Web UI watcher with score-gated permanent auto-bans, dynamic web dashboard, zero npm deps;
Docker image + Compose deployment.

Watches your **CrowdSec Web UI** and permanently bans aggressive, recidivist attacker IPs from foreign countries —
with a scored candidate list, one-click Ban/Unban for everything else, and a dynamic web UI fed by live cycles. It also
imports an IP blocklist (the boestad abuseipdb feed by default): every listed public IP is permanent-banned on arrival,
the list re-downloads on the interval you set in minutes/hours, and IPs missing from a refreshed listing are unbanned
after the configured grace window.

> **Warning — vibe-coded project.** This repository is AI-generated/assisted, experimental and continuously evolving. It has not received a formal code review, security audit, production QA cycle, or performance guarantee. Use it at your own risk on trusted networks only.

Built for one self-hosted CrowdSec instance with nginx HTTP Basic auth in front of the Web UI (the Web UI's own auth
disabled — that is the setup `https://crowdsecwebui.example.com` stands for below), and fully configurable to any Web
UI. **Zero npm dependencies** — only `node:http` + the built-in `global fetch`, so it runs on any Node ≥ 18 with no
install step.

## Run

```powershell
node server.js          # from the repository root; prints "PermaBanNode listening on http://127.0.0.1:8780"
```

Open **http://127.0.0.1:8780**. A scheduled task is the right way to start it at logon — there is no tray icon in this edition.

| Environment variable | Effect |
|---|---|
| `PERMABAN_PORT` | listening port (`8780`; `0` = an ephemeral one, used by the tests) |
| `PERMABAN_HOST` | bind address (`127.0.0.1` locally; `0.0.0.0` in a container so the published interface answers) |
| `PERMABAN_DATA_DIR` | data folder (dev/test hook, and `/data` in the container) |
| `PERMABAN_BASE_URL` | Web UI base URL — seeds **only** on the first run (no `settings.json` yet); a saved file wins |
| `PERMABAN_USERNAME` / `PERMABAN_PASSWORD` | seed credentials while no encrypted side file exists; a Save in Settings writes them encrypted and takes over |
| `PERMABAN_WEBHOOK_URL` | ntfy-style topic URL — first run only |
| `PERMABAN_POLL_SECONDS` | cycle interval (min 5) — first run only |
| `PERMABAN_BLOCKLIST_URL`, `PERMABAN_BLOCKLIST_ENABLED` (`1`/`0`), `PERMABAN_BLOCKLIST_REFRESH_MINUTES` (min 1), `PERMABAN_BLOCKLIST_UNBAN_MINUTES` (min 0 = unban the same cycle), `PERMABAN_BLOCKLIST_CAP_PER_CYCLE` (min 1) | imported blocklist: URL, switch, refresh interval in minutes, removal→unban grace, per-cycle ban+unban cap — first run only; see *Imported blocklist* |
| `PERMABAN_START_PAUSED` | start with the poll loop parked (tests use it; production never sets it) |

Anything the environment seeds is reported as an activity line: `Settings seeded from environment: …`. Empty or unset
values keep the built-in defaults (`PERMABAN_POLL_SECONDS: ''` does not invent a 5 s cycle), and values saved in the UI
always beat the environment on the next start.

## What it does

Every 60 s (configurable) a cycle: fetches all alerts and ban decisions the Web UI exposes (paged, 200/page, expired
included), stores them locally with **the full raw JSON of every event**, runs the imported-list refresh when it is due
(see *Imported blocklist*), scores every IP over the retained window (90 days by default), applies the ban policy,
reconciles app-ban state, emits a snapshot to every connected browser.

| Rule | Default condition |
|---|---|
| Recidivist | ≥ 3 ban decisions (active **or** expired) |
| Aggressive | ≥ 1 000 events **and** ≥ 2 distinct scenarios |

Composite score (ranking + the safe-country gate): `events × 1 + scenarios × 100 + bans × 500` — recidivists rank on top.

Ban policy, in order:
- Country known and not in the safe list (`FR` by default) → **auto-banned with no confirmation**, for 100 years
  (`876000h`, a Go `ParseDuration` string; no `d`/`y` allowed).
- Safe-list country, gate on, composite score ≥ `safeCountryBanScore` (default 2500) → auto-banned too: the protection
  is **relative**, a very active attacker from a safe country is banned permanently as well.
- Safe-list country with the gate off, score below the threshold, or **unknown** GeoIP country (`""`) → *suggest only*,
  shown in Candidates with a one-click **Ban**.
- Already banned (any active decision) → left alone: no duplicate ban, and the IP is not in the candidate list; it
  reappears when its ban expires.
- The header **Auto-ban** master switch wins over everything: OFF = suggest-only for every candidate, applied instantly
  with no Save (`POST /api/autoban`).

The local store is the recidivism memory (the Web UI keeps ~7 days). App-issued bans are tracked so they survive the
Web UI's cache window; a decision deleted on the server disappears from the listing, the absence is detected inside
the lookback window and marked expired locally, keeping the Banned view accurate — which also makes an externally
unbanned IP a candidate again on the next cycle.

## Imported blocklist

Settings → **Imported blocklist** card: enabled switch, list URL, refresh interval in minutes, unban grace in minutes,
per-cycle action cap. The shipped default is [boestad/blocklist-abuseipdb](https://github.com/borestad/blocklist-abuseipdb)
at ~100 % confidence, 30-day window:

```
https://raw.githubusercontent.com/borestad/blocklist-abuseipdb/main/abuseipdb-s100-30d.ipv4
```

Use one of the sibling files for a shorter/longer window (`…-7d.ipv4`, `…-14d.ipv4` …); do not point at `-all`. Any
text list works as long as each line starts with an IP — comment tails after `#`, header lines, CSV rows, CIDR prefixes
(the base address is what gets banned), CRLF and BOM all parse. IPv4 **and** canonical IPv6 are read.

How it runs in a cycle:

- **Refresh:** the list is downloaded when its interval (minutes; 60 = hourly) has elapsed since the last successful
  fetch, and immediately on the next cycle after you change the URL. The stamp of the last real download lives in
  `state.json`, so the schedule survives a restart.
- **Bans:** every public IP on the list is permanent-banned with the app's own duration/prefix/scenario (reason
  `permaban: imported blocklist`), counted on the lifetime "auto-bans issued" card and tagged `by app`. An IP the app
  already rule-banned is *adopted* by the list — no second POST. A ban issued by someone else with an active decision
  is **not** adopted, so removing it from your list can never unban a foreign decision. The per-cycle cap counts bans
  **and** unbans together (default 200), spreading a big list over several cycles — a flood of new arrivals lands in
  bounded batches.
- **Unbans:** an IP missing from the refreshed listing has its absence stamped the first time it is seen gone; once the
  grace window (`Blocklist unban delay`, minutes measured from that stamp) runs out, the app's own ban on it is deleted
  by decision id and list ownership ends. `0` unbans in the same cycle the IP was first found missing. If its ban has
  already vanished server-side, ownership is just dropped; if it reappears later on the list, it is banned anew.
- **Private addresses are dropped by the parser** (RFC1918, loopback, link-local, CGNAT `100.64/10`, multicast and the
  IPv6 equivalents): one malformed public list can never freeze a LAN host or your gateway.
- **Failures degrade gracefully:** a failed fetch logs an activity line and keeps tracked state, bans, counters and the
  old schedule untouched — no cycle ever unbans in bulk because a download broke. The dashboard card keeps showing the
  number of IPs the list owns, even between refreshes; it never goes blank on reload (`blocklistTracked`, added/unbanned
  this cycle come with every snapshot).

Env seeds are first-run only, like all settings: `PERMABAN_BLOCKLIST_URL` / `_ENABLED` (1/0) / `_REFRESH_MINUTES` (≥ 1)
/ `_UNBAN_MINUTES` (≥ 0) / `_CAP_PER_CYCLE` (≥ 1); saved UI values win from then on.

## Web UI (dynamic)

Five views fed by a Server-Sent-Events stream (`/events`), so charts, verdicts and rows update without reload:

- **Dashboard** — five cards: events stored, candidates, active bans, **auto-bans issued by the app over its lifetime**
  (this cycle's number underneath), and **blocklist bans** — how many IPs the imported list owns right now, with added /
  unbanned this cycle under it. Both counters come from what is persisted in `state.json` and carried by `/api/state`,
  every SSE snapshot and `/healthz`, so reloading a page never blanks an indicator; a cycle that skipped the list download
  reports its tracked count as before; recidivism donut
  (share of currently-banned IPs with ≥ 2 stored bans); events-per-day chart (last 14 days, gap-filled): every day
  stands on an axis line, bar heights are **√-compressed** (`height = √events · band/√max`) so one spike of thousands
  cannot flatten a quiet week into invisible hairlines, and neighbouring big days keep distinct bars — a day with events
  always keeps a visible stub (`≥ 6` units), a zero day is a muted stub standing on the axis, and each bar's exact number
  is printed above it inside the `viewBox`, never clipped at any width; top-5 scenarios and top-5 countries bar rows
  (name / track / number, banned count for countries) whose labels are **shortened** — the `crowdsecurity/` prefix comes
  off the row, the untouched name stays in its tooltip. All hand-drawn from `public/charts.js`, no chart library.
  **A page opened between two polls paints immediately**: `/api/state` answers with the last cycle snapshot and `loadState()`
  draws cards, charts and grids straight from it; the SSE `hello` frame carries the same snapshot for a reconnect, so a fresh
  tab never sits blank until someone clicks "Refresh now".
- **Candidates** — IP, country, score, events, scenarios, bans, first/last seen, verdict with the rule's reason string
  (`recidivist (3 bans)`, `aggressive …`), tag (`will auto-ban` / `suggested` / `banned by app`) and **Ban now** button.
  Every column header is clickable (numeric columns sort high-first on the first click, text columns low-first, a second click
  reverses, stable ties keep insertion order); **the filter box searches the whole row as it is displayed** — every column, in both
  its stored and shown form: `3499` *and* `3,499`, `2026-11-05` *and* `05/11/2026, 10:00:00`, verdict words and the tag words. It is a
  substring match over that row text, so typing `4` finds every row whose displayed text contains it (counts *and* date digits).
- **Banned** — every active decision joined with the IP's stored profile (events, bans, score), best-known country,
  scenario, origin (`crowdsec` / `cscli` / …), created/expires, `by app` tag, one-click **Unban**. Same sortable headers
  and filter box: ip, country, scenario, origin, events, bans, score, created, expires, the tag — all matchable.
- **Per-IP viewer** — clicking any IP cell in Candidates or Banned opens a profile modal: score + events/scenarios/bans,
  ban state, and every stored event for that IP with its **full raw JSON** as received from the Web UI API.
- **Export links** — one-click downloads of exactly what the grids show: `candidates.csv` / `banned.csv`,
  `candidates.json` / `banned.json`, and the whole history as `events.ndjson`. Each export runs a cycle first, so the file
  is current; RFC-4180 CSV with quoted fields.
- **Activity log** — rolling log newest-first, colored by severity: sync muted, auto-ban accent, failure red. Lines are
  the same wording as the classic tray app (`AUTO-BANNED ip — recidivist (3 bans)`, `Marked N decision(s) expired …`).
- **Settings** — connection card (URL / username / password / poll interval / Test connection), auto-ban switches with a
  live one-line summary of how the safe list is treated right now, score weights + formula preview, safe list & gate
  threshold, candidate rules, ban length/prefix/scenario/retention, data folder line, and the **Imported blocklist** card
  (enabled switch, URL, refresh interval in minutes, unban grace from the first refreshed absence, per-cycle cap — see
  *Imported blocklist*). Save applies and persists; the header **Auto-ban** toggle and the gate checkbox apply instantly,
  no Save.

| Endpoint | Purpose |
|---|---|
| `GET /events` | SSE: `hello` frame (store warning **and the last cycle snapshot**, so a loading/reconnecting page paints at once), then one full snapshot per cycle |
| `GET /api/state` | settings, activity log, store mode, data folder, live store warning, **the last cycle snapshot** (`cycle`, null before the first cycle) |
| `POST /api/refresh` | run a cycle now, returns its snapshot |
| `POST /api/ban {ip}` | permanent ban on the Web UI, then refresh so it lands in Banned |
| `POST /api/unban {decisionId}` | delete that decision server-side, then refresh |
| `POST /api/settings` | apply + persist settings (credentials never land in `settings.json`) |
| `POST /api/autoban {enabled}` | master switch, instantly |
| `POST /api/test` | test connection; a 401 comes back as a message, not an exception |
| `GET /healthz` | container healthcheck: alive, data folder, store mode, last cycle's verdict (`connected`, totals) |
| `GET /api/profile?ip=` | one IP: profile + every stored event with its raw JSON; unknown IP → `profile:null`, missing ip → 400 |
| `GET /api/inspect` | the events-per-day geometry the dashboard draws (bars, labels, axis baseline, `viewBox`) plus top-scenario rows shortened by `shortScenario` — chart visibility verified over HTTP, not by eye |
| `GET /export/{candidates,banned}.{csv,json}` | the grids as downloadable files (a cycle runs first) |
| `GET /export/events.ndjson` | the whole retained history, one stored event per line, oldest first |

## Data & configuration

Everything lives in `%LOCALAPPDATA%\PermaBanNode\`:

| File | Content |
|---|---|
| `settings.json` | all settings **except** credentials — camelCase keys: `baseUrl`, `username`(empty), `password`(empty), `pollIntervalSeconds`, `webUiLookbackHours`, `safeCountries`, `autoBanEnabled`, `permanentDuration`, `banScenario`, `banReasonPrefix`, `historyRetentionDays`, `notificationsEnabled`, `notifyWebhookUrl`, `notifyFormat`(`text`/`json`), `startMinimized`, `initialized`, `scoring{…}`, `blocklistEnabled`, `blocklistUrl`, `blocklistRefreshMinutes`(≥ 1), `blocklistUnbanMinutes`(≥ 0), `blocklistCapPerCycle`(≥ 1) |
| `credentials.enc` + `key.bin` | username/password sealed with AES-256-GCM under a per-user random key file — the portable stand-in for DPAPI, which Node cannot reach. A corrupt/foreign side file leaves credentials empty; nothing crashes. |
| `events.ndjson` + `state.json` | append-only event log (full raw JSON per event) plus the compacted overlay: auto-bans, notified IPs, locally-expired decision ids, retention-deleted keys, the **lifetime count of app-issued bans** (`autoBansTotal`), and what the imported blocklist owns — each tracked IP's added + first-absence timestamps, plus `blockSyncAt`/`blockSyncUrl`, the URL and stamp of its last successful download. Full rewrite when either grows past 20 000 lines. ISO-8601 UTC strings, so day buckets and "older than" are plain string ordering |

Rows are keyed **source + kind + id**: the Web UI numbers its alert and decision tables independently (both start at 1), so
alert 12 and decision 12 are two different rows arriving in one fetch — keying on `source:id` alone let a later write
overwrite the other silently, and the history export, per-IP counts/scores and the Banned view all lost data. Dates are
normalized at ingest: an unparseable `created_at` becomes the ingest time, a non-ISO `detail.expiration` (duration strings
like `876000h` do appear in that field) becomes `null`. Nothing is dropped and no cycle dies on `Invalid time value`; the
grid shows an empty expiry cell, and the original text stays in `rawJson` for the per-IP viewer. Rows stored by older
builds load unchanged — their entries in `state.json`'s `deletedKeys` just stop matching, and retention re-purges anything
that resurfaces on the next cycle, so there is no migration step.

`scoring` holds `recidivistBanThreshold`, `aggressiveEventThreshold`, `aggressiveScenarioThreshold`,
`eventWeight` / `scenarioWeight` / `banWeight` (global: changing them moves every score **and** who clears the gate),
`safeCountryBanScore`, `safeCountryBanEnabled`. Weights are decimals ≥ 0, invariant `.` parsing — unparsable text keeps
the previous weight.

Startup resilience matches the classic app's store chain: a launch that cannot write the data folder opens the real
history **read-only** (scoring, dashboard and Web UI bans keep working; nothing is recorded) and falls back to a scratch
folder in `%TEMP%\PermaBanNode` when there is nothing readable. Every write method (`append`, purge, mark expired,
record auto-ban, remove auto-ban, mark notified) is a silent no-op in read-only mode, so an app-banned IP recorded
before the folder locked still blocks a second ban POST for that launch; `settings.json` writes are try/catch'd and only
logged. The reason is printed on stdout and shown as banner + activity line naming which store mode engaged.

## Web UI lookback window

The Web UI exposes data going back `crowdsec.sync.lookback` (default **168 h / 7 days**). Consequences, all handled:
local store is the long-term memory; app-issued 100-year bans eventually leave the listing but stay known locally
(marked invisible-but-valid); deleted decisions are detected by their absence *within the lookback window*; dashboard
series come from the retained store, not the 7-day window. **Recommendation:** raise `crowdsec.sync.lookback` (e.g.
`2160h`) on the server and set `webUiLookbackHours` in `settings.json` to match — it is deliberately not in the UI.

## Architecture

```
core/source.js  →  core/store.js  →  core/scoring.js  →  core/rules.js  →  core/pipeline.js  →  server.js / public
 (CrowdSecSource)   (EventStore)      (scoreProfiles)     (evaluate)        (the seam)          HTTP + SSE + UI
```

- `source.js` — Basic-auth paged fetch, ban/unban POSTs, typed auth/source exceptions; pluggable for other sources.
- `store.js` — append-only log + overlay files; aggregates, daily counts, top series, auto-ban/notified/expired state,
  the imported list's ownership (added / first-absence timestamps) and its last-download stamp (`blockSyncAt`,
  `blockSyncUrl`), the lifetime count of app-issued bans shown on the dashboard card; the open-with-fallback chain;
  read-only no-op semantics.
- `scoring.js` — pure static scoring: per-IP profile with `eventCount`, `scenarioCount`, `banCount`, first/last seen,
  country, `currentlyBanned`, `isRecidivist`, `isAggressive`, `isCandidate`.
- `rules.js` — policy: verdict (`auto-ban` / `suggest` / `none`) + the reason string used by UI and notifications.
- `blocklist.js` — parsing a downloaded list (comment/CSV/CIDR lines, IPv4 + canonical IPv6, private ranges dropped)
  and the plain `global fetch` download with its timeout; the pipeline injects the fetcher so the flows are testable
  offline. See *Imported blocklist* for the semantics.
- `pipeline.js` — fetch → upsert → retention → liveness sync → imported-list refresh (when due) → score → rules →
  auto-ban + list bans → notify → reconcile → snapshot, one cycle at a time (joins an in-flight cycle like a semaphore),
  30 s backoff on source failure; emits each snapshot to SSE clients via `onCycle`.
- `format.js` — en-US grouped numbers (`n0`), reason strings, duration text.
- `public/charts.js` — the dashboard geometry as pure functions: √-scaled bar heights (`∝ √events`, normalized to the series
  max, so big days stay distinguishable), minimum visible stub per event-day, muted zero-day stubs, number positions above
  bar tops (clamped below the top edge), and `shortScenario` for row labels. The page imports it **and** `/api/inspect`
  answers from it, so the chart a browser draws is exactly the chart HTTP can verify.
- `public/app.js` — the render path: each chart section runs inside `guard(hostId, fn)`, so one section that throws draws a
  hint in its own host (`chart unavailable: …` inside an `<svg>`, `failed to render — …` inside a `<div>`) and logs to the
  console while cards, the other charts and both grids keep rendering. Geometry comes from what the file imports plus the
  module's own `viewBox` — using a name it never imports throws `ReferenceError` mid-render and everything after the throw
  silently stops (a blank dashboard). It exports `renderCycle`, `guard`, `loadState`, `searchCandidate`, `searchBanned` for the offline
  tests; the page ignores them.

## Tests

```powershell
node --test tests/        # 90 offline tests — no real server, no network beyond localhost; the imported list is fed through an injectable fetcher, never downloaded in a test
```

rules **11**, scoring **7** (candidate flags included), store **22** (read-only mode, scratch fallback, compaction,
per-IP profile with raw JSON, garbage dates from the API normalized, alert and decision rows at the same id kept apart,
the lifetime ban counter counting issuances only + surviving reloads, and the imported list's overlay round-trip —
ownership timestamps, first-absence marking, unban dropping ownership *and* the app-ban flag, URL + schedule stamp
restored on relaunch, all frozen under a read-only launch),
pipeline **11** (baseline, no double ban, external unban, safe-list gate, master switch, read-only cycle, plus four
blocklist flows: every public list IP banned and counted on the lifetime total, the refresh schedule gating + the unban
firing once its grace window runs out via the live decision id, the per-cycle cap spreading a big list over cycles,
and never adopting an active ban somebody else issued), server **6** — the E2E spawns the real `server.js` on an ephemeral port (`PERMABAN_PORT=0`) with the poll
loop parked (`PERMABAN_START_PAUSED=1`, production never sets it) against a mock nginx-Basic Web UI and asserts what a
browser sees: static HTML/CSS/JS bytes, SSE frames in order, one-click Ban/Unban round-trip, `/healthz` + profile +
export routes; plus settings persistence with encrypted credentials (webhook fields included, **and the five blocklist fields in both the Settings round-trip and env-seeding on first run**),
env-seeding on first run —
including that an **empty** env var leaves the default alone (`PERMABAN_POLL_SECONDS: ''` must not invent a 5 s cycle),
clean shutdown (an unreachable list URL degrades the cycle to exactly one `fetch failed` activity line: zero list bans,
tracked 0, saved settings retained across a restart; and the E2E pins that the lifetime counter survives `/api/state`,
an SSE `hello` frame, idle cycles, and reopening the store between launches), `/api/inspect`: bars inside the box, every bar paired with its own day's number above it, quiet days
as stubs on the axis, the spike keeping small days visible, scenario labels prefix-free with `full` intact — and the
**fresh-page test**: `/api/state` carries the last snapshot (`cycle`, null before any cycle), and a browser connecting
between two polls gets that snapshot in its single `hello` frame, so loading a tab needs no "Refresh now" click. **sort** 6
(numeric high-first first click, stable ties, string columns, filter), **notify** 6 (text/json bodies, `asciiHeader`, ntfy
POST shape) and **ui** 8 — the static files are checked against the server: every id used by `app.js` exists in
`index.html`, every `data-key` grid column is a real snapshot field, every export link matches a route, `app.js`'s relative
imports resolve to real served files (`sort.js`, `charts.js`) with the sparkline `viewBox` matching the module's constants;
the chart module itself is executed here — `shortScenario` strips both `crowdsecurity/` and `crowdsecurity:` (near-misses
untouched), bars stay in bounds with every event-day ≥ 6 units and zero days ≤ 2, numbers clear their bar tops (SVG text y
is a baseline) inside the box, dates sit under the axis, track widths keep relative scale. **ui** also asserts that every
`charts.js` export app.js touches is in its import list (an unimported name = browser `ReferenceError`) and that each chart
section sits inside a `guard`. It also pins the load path: `/api/state` includes `cycle`, `loadState()` renders it, and the
SSE `hello` handler renders `d.cycle` — a fresh tab never waits for a poll or a click.

**render** 3 — `public/app.js` runs in Node under a minimal DOM shim (elements created on demand, `innerHTML`/`viewBox`
recorded), so the render path a browser takes is verified without a browser: imports resolve for real, every day of the
window gets its bar **and** its printed number inside the box, numbers clear their bar tops, scenario labels reach the DOM
prefix-free with the full name in the tooltip, and grids render exactly as many rows as the snapshot sends (cycle A
auto-bans ALERT_IP → app tag; cycle B lists that ban back → `Unban` row). Isolation is proved by making top-scenarios throw
(a null list): the section shows its own hint, the sparkline keeps all its bars, both grids keep their rows. This test is
the regression guard for "nothing shows anymore" — an unimported constant (`SPARK_VIEW_W`) once threw mid-render and blanked
chart + scenarios + countries in one go. The third test runs the real `loadState()` with a **wiped** DOM against a live
server: bars, cards, status `Connected` and scenario rows must appear from `/api/state` alone — no SSE frame, no "Refresh
now" click — which is exactly the page-load bug it fixes.

**blocklist** 5 — the parser fixtures for the list format: comment tails + header lines stripped, CSV rows, CIDR prefix
→ base address, CRLF + BOM, duplicate lines counting once; junk and non-addresses dropped; private v4 (10/8, 172.16/12,
192.168/16, loopback, link-local, CGNAT `100.64/10`, multicast) filtered out of a public list; canonical IPv6 accepted in
both full and compressed form (stored lowercase), `fe80`/`ff*`/`fc|fd` ranges dropped, zone ids (`%eth0`) and bracketed
URL forms rejected; empty/comment-only input yields nothing. The download seam is never exercised against the network:
the pipeline tests inject their own fetcher.

**grid** 5 — `public/app.js` under the same shim, this time with `<th data-key>` header cells (click handlers, `data-numeric`, the
▲/▼ indicator) and both filter inputs, so real header clicks and typed text drive the page's own code. Every column of both grids is
sorted on a first click in the right direction (numbers high-first, text low-first, empty values first ascending / last descending),
the displayed cell order follows the sorted rows, a second click reverses it, ties keep the server's ranking, and only the active header
carries an arrow. The filter box is typed per column: **ip, country, scenario, origin, events, bans, score, created, expires**, plus
verdict/tag words — matching the stored value (`3499`, `2026-11-05`) *and* what the cell shows (`3,499`, `05/11/2026, 10:00:00`);
that displayed form is built by hand in the page's local time zone as fixed `dd/mm/yyyy, hh:mm:ss` (`fmtTs`), not via
`toLocaleString('en-GB', …)`, whose separator varies between ICU versions (U+202F on a Node 20 CI runner vs an ASCII space in
the browser), so the text stays byte-stable and typed needles match exactly; a text nothing displays shows 0 rows, clearing it restores every row, and the active sort keeps ordering the narrowed grid. Column coverage is
also proved column-by-column through `searchCandidate` / `searchBanned`: each sortable column gets a distinctive value (a date day,
`9001` + `9,001`, a marker word) that must be findable — this is the regression guard for the filter box that searched only
ip/country/scenario/origin and answered empty for events/bans/score/created/expires, and it pairs with **ui**'s static check that every
`data-key` column is named in its grid's builder. The fifth test drives the dashboard cards and the Settings form from a
state snapshot: both counter cards show what the snapshot carries (the lifetime total, not this cycle's number), the
blocklist card shows tracked/added/unbanned as sent, an older snapshot without `autoBansTotal` falls back to the cycle
count, and every saved blocklist field lands in its input.

## Docker app

GitHub builds the image for you. `.github/workflows/docker.yml` runs on every push to `main` and from
**Actions → Build and publish the image → Run workflow**: it checks out the repo, runs the test suite (a red suite never
publishes), builds with buildx + Actions layer cache, and pushes `:latest` plus a `sha-<short>` tag to your ghcr package
with the **workflow token** (`GITHUB_TOKEN`, `packages: write`) — no Personal Access Token involved. Replace the workflow's
`IMAGE:` line when publishing a fork.

Building by hand is still available on any machine with a Docker CLI (replace `youruser` with your registry account in
README, compose.yaml and package.json scripts):

```powershell
docker build -t ghcr.io/youruser/crowdsec-permaban:latest .   # node:20-alpine, no npm install step
docker push ghcr.io/youruser/crowdsec-permaban:latest         # needs a PAT with write:packages (Docker Hub works too)
```

The image bakes in the container defaults: unprivileged user `crowdsec-permaban` at fixed uid/gid **568** — the app-user
id most container apps run as (`PUID`/`PGID` 568), so shared app folders usually already grant it write access.
`PERMABAN_DATA_DIR=/data`, `PERMABAN_HOST=0.0.0.0`, port **8780**, and a healthcheck on `/healthz`. `compose.yaml` is the
file to deploy — standard compose syntax: `docker compose up -d` on any host, or paste it into a compose UI (Dockge,
Portainer).

`/data` exists **inside the image** owned by uid/gid 568, so Docker copies that ownership into a fresh named volume:
`crowdsec-permaban-data:/data` is writable from the first launch (`mode read-write`, no store warning) and needs no ACL
work. A **bind-mounted folder** does not inherit it — `chown -R 568:568 <folder>` once, and if your app folder's ACL
already grants 568 (the usual case for shared app folders), there is nothing to do at all. If you forget, the app still
runs: the store opens the history read-only, the banner names the mode and `/healthz` stays green, nothing is recorded.

Deploy: merge into `main` (or run the workflow), pull `:latest` on the host, set `image:` in `compose.yaml`, pick the volume
(named volume = nothing to do; bind mount = chown for 568 once), fill in `PERMABAN_BASE_URL`, `PERMABAN_USERNAME`,
`PERMABAN_PASSWORD` (+ `PERMABAN_WEBHOOK_URL` for ntfy pushes) — as env they seed settings on the first run only, and a Save
in Settings writes them encrypted into the volume (`credentials.enc` + `key.bin`). Keep values out of any compose file you
share or commit (`.env` with `${VAR}` references). Open `http://<host>:8780`: one instance per port — a second bind on 8780
fails, by design. A redeploy picks up the new image: `docker compose pull && docker compose up -d` (or pull + redeploy in
the compose UI), and `docker ps` shows `healthy` once `/healthz` answers.

### Keeping the image private

1. **GitHub Container Registry** — images are **private by default**, and a package the workflow publishes is tied to this
   repository, so publishing needs no token at all: `GITHUB_TOKEN` with `packages: write` does it. Pulling is where your
   Personal Access Token comes in — every machine that pulls runs `docker login ghcr.io -u youruser` once with a token
   limited to `read:packages`:
   ```powershell
   docker login ghcr.io -u youruser                        # paste the read:packages PAT (username = your GitHub login)
   docker pull ghcr.io/youruser/crowdsec-permaban:latest   # the deploy host does this before compose up
   ```
   Set `compose.yaml` to that image name and **keep it lowercase** (ghcr lowercases the repo). The token lives in the
   engine's own config (`/root/.docker/config.json`), never in the compose file. No pull-rate limit like Docker Hub's, and
   a personal package is pulled only by tokens for that account (an organization package can have collaborators).
2. **Docker Hub, repo set to Private** — same commands as above, then flip
   **Settings → Change Repository Visibility → Private** on the `crowdsec-permaban` repository. The Personal plan includes
   **1 private repository**; authenticated pulls are limited to 200 per 6 hours (plenty for one host pulling `latest`
   occasionally). Use a Docker Hub *Access Token* (Account Settings → Security) instead of the account password, and log in
   on every machine that pulls.
3. **No registry at all (fully local)** — build where you deploy: copy this folder, `cd` into it and
   `docker build -t crowdsec-permaban:local .`, then use `image: crowdsec-permaban:local`. Nothing leaves your network. If
   the target host cannot build, move the image with `docker save -o crowdsec-permaban.tar <your-image-name>` (copy it over,
   then `docker load -i crowdsec-permaban.tar`).

A read-only or unwritable mount does not crash-loop: the store opens the history read-only, the banner names the mode
and `/healthz` stays green (see *Data & configuration*). `package.json` at the repository root has the matching scripts
(`build-image`, `push-image`, `run-container`).

## Publishing & running your own instance

Layout: everything lives at the repository root — `server.js`, `core/` (source, store, settings, scoring, rules, blocklist, pipeline, format), `public/`, `tests/`, `Dockerfile`,
`compose.yaml`, `package.json`, `.dockerignore`, plus this `README.md`, `LICENSE`, `.gitignore`, `.gitattributes`, and the
publishing workflow under `.github/workflows/`. The Docker build context is the root, and `.dockerignore` keeps `tests/`,
markdown, `Dockerfile` and `compose.yaml` out of the image. Nothing personal ships in the code — no credentials, no real Web
UI hostname, no webhook topic, no registry token. The two exceptions are the image name, by design: `compose.yaml`'s `image:`
line and the workflow's `IMAGE:` line both point at your private ghcr package (replace them before publishing a fork):

- `DEFAULT_SETTINGS.baseUrl` is the placeholder `https://crowdsecwebui.example.com`; set your own URL in Settings or
  seed it on the first run with `PERMABAN_BASE_URL`. Same for the compose file's env values.
- `youruser` in `package.json` scripts and the examples above is a placeholder, yours to replace with your registry
  account; ghcr image names must stay lowercase. The `compose.yaml`/workflow image lines carry the owner's real lowercase
  name as committed.
- `.gitignore` keeps runtime data out of git: `settings.json`, `credentials.enc`, `key.bin`, `events.ndjson`,
  `state.json`, the scratch folder, transferred image tarballs and temp test output. The tests write their fixtures to
  OS temp dirs (`os.tmpdir()` + a `perma-…-` prefix), never inside the repo.

Publishing hygiene:

- Credentials never enter the repo or `settings.json`: they are entered in Settings (or seeded with
  `PERMABAN_USERNAME`/`PASSWORD`) and land encrypted in `credentials.enc` under a per-user `key.bin` on the volume.
  A compose file you share publicly must keep `PERMABAN_USERNAME` / `PERMABAN_PASSWORD` empty.
- An ntfy topic URL **is** a secret — anyone who knows it can post to it. Keep `notifyWebhookUrl` in Settings only,
  never in a committed `compose.yaml`.
- Publishing through the workflow needs no registry token (the job uses `GITHUB_TOKEN` with `packages: write`). A manual
  push needs a GitHub PAT scoped to `read:packages` + `write:packages`, and each deploy host pulls with a `read:packages`
  PAT; on Docker Hub use an **Access Token** (Account Settings → Security) instead of the account password. Set the repository private if
  you want it invisible (`ghcr.io/youruser/crowdsec-permaban` is private by default; on Docker Hub flip
  **Settings → Change Repository Visibility → Private**), and keep your Web UI hostname out of README, compose file
  and commit messages before publishing.
- Env seeding is first-run only: empty/unset `PERMABAN_*` values leave the built-in defaults alone (`PERMABAN_POLL_SECONDS: ''`
  does not invent a 5 s cycle), and any settings you Save in the UI beat the environment on the next start — so an
  accidentally committed env value cannot silently reconfigure a fork.
- The app has **no login of its own**: `username`/`password` are the credentials it uses against your Web UI, not a
  gate in front of port 8780. Bind to `127.0.0.1` locally, keep the container's published port on a trusted network,
  and put nginx HTTP Basic auth (or a reverse-proxy login) in front of it — that is the setup this project runs with.

## Notes & limits

- No tray icon, no balloon notifications: every notification becomes an activity-log line **and** a ntfy-style webhook
  POST when `notifyWebhookUrl` is set (`text` body + Title header, or `json`; gated by `notificationsEnabled`, failures
  land as `NOTIFY FAILED …`). Run exactly one instance — port 8780 gives `EADDRINUSE` on a second bind; there is no
  Run-key startup entry in this edition.
- Credentials are entered once in Settings (or seeded with `PERMABAN_USERNAME`/`PASSWORD`) and live encrypted for
  **this** user/machine key pair (`key.bin`).
- The first cycle establishes a baseline: existing candidates are recorded silently (no notification storm), then
  `initialized` is persisted.
- Heights are √-scaled (`∝ √events`, normalized to the series max) and each bar's exact number is printed above it (no
  axis ticks): one huge day cannot swallow the small ones, neighbouring big days stay distinguishable, quiet days stay
  visible stubs on the axis. Top-scenario row labels drop the `crowdsecurity/` prefix; the tooltip keeps the full name.
  Recidivism counts stored bans, so an IP banned before the first cycle has only what the Web UI window shows.
- The Web UI overwrites displayed `reason` of manual decisions with the scenario name (`manual/web-ui`); the full reason
  stays in `auto_bans`.
- The legacy C# edition (WPF tray app) is gone completely — projects, its archived store (`%LOCALAPPDATA%\PermaBan`)
  and the backup zip have all been deleted. Nothing from it is imported; history starts fresh at
  `%LOCALAPPDATA%\PermaBanNode` (or `/data` in the container).
