# PermaBan (Node.js)

Score-based CrowdSec Web UI watcher with score-gated permanent auto-bans, dynamic web dashboard, zero npm deps;
Docker / TrueNAS Scale app.

Watches your **CrowdSec Web UI** and permanently bans aggressive, recidivist attacker IPs from foreign countries —
with a scored candidate list, one-click Ban/Unban for everything else, and a dynamic web UI fed by live cycles.

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
| `PERMABAN_START_PAUSED` | start with the poll loop parked (tests use it; production never sets it) |

Anything the environment seeds is reported as an activity line: `Settings seeded from environment: …`. Empty or unset
values keep the built-in defaults (`PERMABAN_POLL_SECONDS: ''` does not invent a 5 s cycle), and values saved in the UI
always beat the environment on the next start.

## What it does

Every 60 s (configurable) a cycle: fetches all alerts and ban decisions the Web UI exposes (paged, 200/page, expired
included), stores them locally with **the full raw JSON of every event**, scores every IP over the retained window
(90 days by default), applies the ban policy, reconciles app-ban state, emits a snapshot to every connected browser.

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

## Web UI (dynamic)

Five views fed by a Server-Sent-Events stream (`/events`), so charts, verdicts and rows update without reload:

- **Dashboard** — cards (events stored, candidates, active bans, auto-bans issued this cycle); recidivism donut
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
  Every column header is clickable (numeric columns sort high-first on the first click, stable ties keep insertion order);
  the filter box searches IP, country and reason, live.
- **Banned** — every active decision joined with the IP's stored profile (events, bans, score), best-known country,
  scenario, origin (`crowdsec` / `cscli` / …), created/expires, `by app` tag, one-click **Unban**. Same sortable headers
  and filter box.
- **Per-IP viewer** — clicking any IP cell in Candidates or Banned opens a profile modal: score + events/scenarios/bans,
  ban state, and every stored event for that IP with its **full raw JSON** as received from the Web UI API.
- **Export links** — one-click downloads of exactly what the grids show: `candidates.csv` / `banned.csv`,
  `candidates.json` / `banned.json`, and the whole history as `events.ndjson`. Each export runs a cycle first, so the file
  is current; RFC-4180 CSV with quoted fields.
- **Activity log** — rolling log newest-first, colored by severity: sync muted, auto-ban accent, failure red. Lines are
  the same wording as the classic tray app (`AUTO-BANNED ip — recidivist (3 bans)`, `Marked N decision(s) expired …`).
- **Settings** — connection card (URL / username / password / poll interval / Test connection), auto-ban switches with a
  live one-line summary of how the safe list is treated right now, score weights + formula preview, safe list & gate
  threshold, candidate rules, ban length/prefix/scenario/retention, data folder line. Save applies and persists; the
  header **Auto-ban** toggle and the gate checkbox apply instantly, no Save.

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
| `settings.json` | all settings **except** credentials — camelCase keys: `baseUrl`, `username`(empty), `password`(empty), `pollIntervalSeconds`, `webUiLookbackHours`, `safeCountries`, `autoBanEnabled`, `permanentDuration`, `banScenario`, `banReasonPrefix`, `historyRetentionDays`, `notificationsEnabled`, `notifyWebhookUrl`, `notifyFormat`(`text`/`json`), `startMinimized`, `initialized`, `scoring{…}` |
| `credentials.enc` + `key.bin` | username/password sealed with AES-256-GCM under a per-user random key file — the portable stand-in for DPAPI, which Node cannot reach. A corrupt/foreign side file leaves credentials empty; nothing crashes. |
| `events.ndjson` + `state.json` | append-only event log (full raw JSON per event) plus the compacted overlay: auto-bans, notified IPs, locally-expired decision ids, retention-deleted keys. Full rewrite when either grows past 20 000 lines. ISO-8601 UTC strings, so day buckets and "older than" are plain string ordering |

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
- `store.js` — append-only log + overlay files; aggregates, daily counts, top series, auto-ban/notified/expired state;
  the open-with-fallback chain; read-only no-op semantics.
- `scoring.js` — pure static scoring: per-IP profile with `eventCount`, `scenarioCount`, `banCount`, first/last seen,
  country, `currentlyBanned`, `isRecidivist`, `isAggressive`, `isCandidate`.
- `rules.js` — policy: verdict (`auto-ban` / `suggest` / `none`) + the reason string used by UI and notifications.
- `pipeline.js` — fetch → upsert → retention → liveness sync → score → rules → auto-ban → notify → reconcile → snapshot,
  one cycle at a time (joins an in-flight cycle like a semaphore), 30 s backoff on source failure; emits each snapshot to
  SSE clients via `onCycle`.
- `format.js` — en-US grouped numbers (`n0`), reason strings, duration text.
- `public/charts.js` — the dashboard geometry as pure functions: √-scaled bar heights (`∝ √events`, normalized to the series
  max, so big days stay distinguishable), minimum visible stub per event-day, muted zero-day stubs, number positions above
  bar tops (clamped below the top edge), and `shortScenario` for row labels. The page imports it **and** `/api/inspect`
  answers from it, so the chart a browser draws is exactly the chart HTTP can verify.
- `public/app.js` — the render path: each chart section runs inside `guard(hostId, fn)`, so one section that throws draws a
  hint in its own host (`chart unavailable: …` inside an `<svg>`, `failed to render — …` inside a `<div>`) and logs to the
  console while cards, the other charts and both grids keep rendering. Geometry comes from what the file imports plus the
  module's own `viewBox` — using a name it never imports throws `ReferenceError` mid-render and everything after the throw
  silently stops (a blank dashboard). It exports `renderCycle` + `guard` for the offline render test; the page ignores them.

## Tests

```powershell
node --test tests/        # 69 offline tests — no real server, no network beyond localhost
```

rules **11**, scoring **7** (candidate flags included), store **15** (read-only mode, scratch fallback, compaction,
per-IP profile with raw JSON), pipeline **7** (baseline, no double ban, external unban, safe-list gate, master switch,
read-only cycle), server **6** — the E2E spawns the real `server.js` on an ephemeral port (`PERMABAN_PORT=0`) with the poll
loop parked (`PERMABAN_START_PAUSED=1`, production never sets it) against a mock nginx-Basic Web UI and asserts what a
browser sees: static HTML/CSS/JS bytes, SSE frames in order, one-click Ban/Unban round-trip, `/healthz` + profile +
export routes; plus settings persistence with encrypted credentials (webhook fields included), env-seeding on first run —
including that an **empty** env var leaves the default alone (`PERMABAN_POLL_SECONDS: ''` must not invent a 5 s cycle),
clean shutdown, `/api/inspect`: bars inside the box, every bar paired with its own day's number above it, quiet days
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

## Docker & TrueNAS Scale app

```powershell
# Replace `youruser` with your own registry account everywhere it appears (README, compose.yaml, package.json scripts).
docker build -t registry.hub.docker.com/youruser/crowdsec-permaban:latest .   # node:20-alpine, no npm install step
docker push registry.hub.docker.com/youruser/crowdsec-permaban:latest         # your registry (Docker Hub works)
```

The image bakes in the container defaults: unprivileged user `crowdsec-permaban` at fixed uid/gid **998**,
`PERMABAN_DATA_DIR=/data`, `PERMABAN_HOST=0.0.0.0`, port **8780**, and a healthcheck on `/healthz`. `compose.yaml` is
the file to import — standard compose syntax, nothing TrueNAS-specific (it runs with plain `docker compose up -d` too).

### Keeping the image private

Three ways, in order of effort:

1. **Docker Hub, repo set to Private** — same commands as above, nothing else changes: push, then on
   `hub.docker.com` open the `crowdsec-permaban` repository → **Settings → Change Repository Visibility → Private**. The Personal
   plan includes **1 private repository**; authenticated pulls are limited to 200 per 6 hours (plenty for one NAS pulling
   `latest` occasionally). In TrueNAS: **Apps → Configuration → Sign-in to a Docker registry → Add Registry**, URI
   **Docker Hub**, username + password (a Docker Hub *Access Token* from Account Settings → Security is safer than the
   account password), Save. The Custom App then pulls the private image with that credential, and "Check for docker image
   updates" keeps working. `compose.yaml`'s image line stays as it is.
2. **GitHub Container Registry** — images are **private by default**: create a Personal Access Token with
   `read:packages` + `write:packages`, then
   ```powershell
   docker login ghcr.io -u youruser                        # paste the PAT (username = your GitHub login)
   docker build -t ghcr.io/youruser/crowdsec-permaban:latest .
   docker push ghcr.io/youruser/crowdsec-permaban:latest
   ```
   Change `compose.yaml` to `image: ghcr.io/youruser/crowdsec-permaban:latest`, and in TrueNAS add a registry with URI
   **Other Registry** = `https://ghcr.io/`, your GitHub username, and the PAT. No pull-rate limit like Docker Hub's.
3. **No registry at all (fully local)** — build on the NAS over SSH (`docker` CLI is available when the Docker plugin /
   Apps service runs): copy this folder to a dataset, `cd` into it and `docker build -t crowdsec-permaban:local .`, then
   `image: crowdsec-permaban:local` in `compose.yaml`. Nothing leaves your network. On some TrueNAS versions a Custom App import
   wants the image present in the local store first — if that happens, transfer from your machine with
   `docker save -o crowdsec-permaban.tar registry.hub.docker.com/youruser/crowdsec-permaban:latest` (scp it over, then
   `docker load -i crowdsec-permaban.tar`).

1. Build + push from any machine with a Docker CLI (not needed on the NAS itself), then create a dataset for the data
   folder — e.g. `tank/apps/crowdsec-permaban`. Give uid 998 write access **once**: add the group to the dataset's ACL, or in a
   TrueNAS shell `chown -R 998:998 /mnt/tank/apps/crowdsec-permaban`.
2. Apps → **Custom App (Docker Compose YAML)** and paste `compose.yaml`; set the volume to your dataset
   (`/mnt/tank/apps/crowdsec-permaban:/data`) and the published port, fill in `PERMABAN_BASE_URL`, `PERMABAN_USERNAME`,
   `PERMABAN_PASSWORD` (+ `PERMABAN_WEBHOOK_URL` for ntfy pushes). Credentials entered as env are seeded on first run;
   a Save in Settings writes them encrypted into the volume (`credentials.enc` + `key.bin`).
3. Open `http://<truenas>:8780`. One instance per port — a second app on 8780 fails to bind, by design.

A read-only or unwritable mount does not crash-loop: the store opens the history read-only, the banner names the mode
and `/healthz` stays green (see *Data & configuration*). `package.json` at the repository root has the matching scripts
(`build-image`, `push-image`, `run-container`).

## Publishing & running your own instance

Layout: everything lives at the repository root — `server.js`, `core/`, `public/`, `tests/`, `Dockerfile`,
`compose.yaml`, `package.json`, `.dockerignore`, plus this `README.md`, `LICENSE`, `.gitignore`, `.gitattributes`.
The Docker build context is the root, and `.dockerignore` keeps `tests/`, markdown, `Dockerfile` and `compose.yaml`
out of the image. Nothing personal ships in the code — no credentials, no real Web UI hostname, no webhook topic,
no registry account:

- `DEFAULT_SETTINGS.baseUrl` is the placeholder `https://crowdsecwebui.example.com`; set your own URL in Settings or
  seed it on the first run with `PERMABAN_BASE_URL`. Same for the compose file's env values.
- `youruser` in `compose.yaml`, `package.json` scripts and the examples above is yours to replace.
- `.gitignore` keeps runtime data out of git: `settings.json`, `credentials.enc`, `key.bin`, `events.ndjson`,
  `state.json`, the scratch folder, transferred image tarballs and temp test output. The tests write their fixtures to
  OS temp dirs (`os.tmpdir()` + a `perma-…-` prefix), never inside the repo.

Publishing hygiene:

- Credentials never enter the repo or `settings.json`: they are entered in Settings (or seeded with
  `PERMABAN_USERNAME`/`PASSWORD`) and land encrypted in `credentials.enc` under a per-user `key.bin` on the volume.
  A compose file you share publicly must keep `PERMABAN_USERNAME` / `PERMABAN_PASSWORD` empty.
- An ntfy topic URL **is** a secret — anyone who knows it can post to it. Keep `notifyWebhookUrl` in Settings only,
  never in a committed `compose.yaml`.
- Registry tokens are write-scoped and minimal: GitHub PAT with `read:packages` + `write:packages` for GHCR, a Docker
  Hub **Access Token** (Account Settings → Security) instead of the account password. Set the repository private if
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
