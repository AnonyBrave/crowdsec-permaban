// PermaBanNode — the Node port of PermaBan: same pipeline, same rules, a dynamic web UI in place of WPF.
// Zero npm dependencies (node:http + global fetch), so it runs on any Node ≥ 18 with no install step.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SettingsStore, resolveDataDirectory, scratchDataDirectory, seedFromEnv, normalizeBlocklists } from './core/settings.js';
import { EventStore } from './core/store.js';
import { CrowdSecSource, SourceAuthException, SourceException } from './core/source.js';
import { Pipeline } from './core/pipeline.js';
import { postNotification } from './core/notify.js';
import { candidatesCsv, bannedCsv, eventsNdjson } from './core/export.js';
// The dashboard geometry lives in public/charts.js (the UI's own module) — /api/inspect answers from it, so the
// chart served to a browser is exactly the chart that can be verified over HTTP.
import { sparkBars, shortScenario } from './public/charts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PERMABAN_PORT ?? 8780);
// In a container the UI has to answer on the published interface: `PERMABAN_HOST=0.0.0.0` in the Dockerfile,
// 127.0.0.1 by default for local runs (tests read the printed address).
const HOST = process.env.PERMABAN_HOST ?? '127.0.0.1';

// ── startup, in the same resilience order as AppOrchestrator: settings, store (with fallback), source.
const primaryDir = resolveDataDirectory();
let dir = primaryDir;
let settingsStore = new SettingsStore(primaryDir);
let settings = settingsStore.load();

// Container seed: env vars configure the first run (no settings.json yet) and the credentials while no
// encrypted side file exists. Settings saved in the UI always win.
const seeded = seedFromEnv(settings, process.env, {
  firstRun: !settingsStore.fileExisted,
  seedCreds: !settingsStore.credsLoaded,
});

const store = EventStore.open(primaryDir, { scratchDir: scratchDataDirectory() });
if (store.dir !== primaryDir) { dir = store.dir; }

const activity = [];          // rolling log, newest first, same colours by severity in the UI
const addActivity = (line, kind = 'info') => {
  activity.unshift({ at: new Date().toISOString(), line, kind });
  if (activity.length > 300) activity.pop();
};

const storeWarning = store.warning ?? settingsStore.warning ?? null;
if (storeWarning) addActivity(storeWarning, 'warn');
if (seeded.length > 0) addActivity(`Settings seeded from environment: ${seeded.join(', ')} — values saved in Settings win.`, 'info');

let source = new CrowdSecSource(settings.baseUrl, settings.username, settings.password);

const classify = (line) => {
  if (line.startsWith('AUTO-BANNED')) return 'ban';
  if (line.includes('FAILED')) return 'error';
  if (line.startsWith('Sync:')) return 'sync';
  return 'info';
};

const pipeline = new Pipeline({
  getSettings: () => settings,
  store,
  source,
  log: (line) => addActivity(line, classify(line)),
});
// The web edition has no tray balloons: notifications are activity-log lines plus a webhook POST
// (`notifyWebhookUrl`, ntfy-style, text or json body). A failing webhook is reported by the pipeline as `NOTIFY FAILED …`.
pipeline.notifier = async (title, body) => {
  addActivity(`${title}: ${body}`, title.includes('failed') ? 'error' : 'ban');
  if (!settings.notifyWebhookUrl) return;
  await postNotification(settings.notifyWebhookUrl, title, body, settings.notifyFormat);
};

// ── live cycles → SSE clients
const sseClients = new Set();
let lastCycleResult = null;      // /healthz and the export links answer from the most recent cycle snapshot
pipeline.onCycle = (result) => {
  lastCycleResult = result;
  const payload = `event: cycle\ndata: ${JSON.stringify(result)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
};

// ── HTTP ────────────────────────────────────────────────────────────────────

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  if (Buffer.isBuffer(body)) res.end(body);   // static files must go out as raw bytes, not JSON
  else res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

/// A file the browser downloads (the export links), same no-store policy as the API.
const download = (res, body, type, filename) => {
  res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
  res.end(body);
};

const parseRaw = (s) => { try { return JSON.parse(s ?? '{}'); } catch { return { raw: s }; } };

async function applySettings(newSettings) {
  const connectionChanged =
    newSettings.baseUrl !== settings.baseUrl
    || newSettings.username !== settings.username
    || newSettings.password !== settings.password;

  settings = newSettings;

  const saved = settingsStore.save(settings);
  if (!saved.ok) {
    storeWarningLive = `Settings NOT written to disk (${saved.warning}); they apply for this launch only.`;
    addActivity(storeWarningLive, 'warn');
  }

  if (connectionChanged) {
    source = new CrowdSecSource(settings.baseUrl, settings.username, settings.password);
    pipeline.setSource(source);
    addActivity(`Reconnected to ${settings.baseUrl} as '${settings.username}'.`, 'info');
  } else {
    addActivity('Settings applied.', 'info');
  }
  return { ok: true, storeWarning: saved.warning ?? null };
}

let storeWarningLive = storeWarning;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      sseClients.add(res);
      // `hello` carries the last snapshot too: a page opened between two cycles paints charts + numbers immediately
      // instead of waiting for the next poll (and reconnecting browsers recover the same way).
      res.write(`event: hello\ndata: ${JSON.stringify({ storeWarning: storeWarningLive, cycle: lastCycleResult })}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (p === '/api/state') {
      return send(res, 200, {
        settings, activity, storeWarning: storeWarningLive,
        dataDir: dir, primaryDataDir: primaryDir, mode: store.readOnly ? 'read-only' : 'read-write',
        cycle: lastCycleResult,   // the snapshot a fresh page needs to draw charts/cards/grids on load
      });
    }

    // Container healthcheck (`HEALTHCHECK` in the Dockerfile / compose health check): the process is alive and
    // serving. `connected` reports what the last cycle saw on the Web UI side.
    if (p === '/healthz') {
      return send(res, 200, {
        ok: true, mode: store.readOnly ? 'read-only' : 'read-write', dataDir: dir,
        totalEvents: store.totalEvents(), connected: lastCycleResult?.connected ?? null,
        activeBans: lastCycleResult?.banned?.length ?? 0, at: new Date().toISOString(),
      });
    }

    // Per-IP profile: the stored score/events plus the full raw JSON we kept for that IP.
    if (p === '/api/profile') {
      const ip = (url.searchParams.get('ip') ?? '').trim();
      if (!ip) return send(res, 400, { ok: false, message: 'ip is required' });

      const events = store.eventsForIp(ip, 120).map((e) => ({ ...e, raw: parseRaw(e.rawJson) }));
      return send(res, 200, {
        ok: true, ip, profile: store.profileFor(ip, settings.scoring),
        autoBannedByApp: store.isAutoBanned(ip), events,
      });
    }

    // Chart inspection: the exact geometry the dashboard draws (bars, labels, axis) and the shortened scenario
    // row names, computed by public/charts.js — so chart visibility can be verified over HTTP, not by eye.
    if (p === '/api/inspect') {
      const cyc = lastCycleResult;
      if (!cyc?.dashboard) return send(res, 200, { ok: false, message: 'no cycle has run yet' });

      const daily = cyc.dashboard.dailyEvents.map((d) => ({ ...d, eventsLabel: String(d.events) }));
      const chart = sparkBars(daily);   // en-US grouping is a display detail of app.js — geometry in pure numbers
      return send(res, 200, {
        ok: true, viewBox: chart.viewBox, axisBaseline: chart.axisBaseline, bars: chart.bars, labels: chart.labels,
        topScenarios: cyc.dashboard.topScenarios.map((s) => ({ ...shortScenario(s.name), events: s.events })),
      });
    }

    // Export links: the same rows the grids show, as downloadable CSV / JSON files.
    if (p === '/export/events.ndjson') {
      return download(res, eventsNdjson(store.allEvents()), 'application/x-ndjson', 'permaban-events.ndjson');
    }

    if (p === '/export/candidates.csv' || p === '/export/banned.csv' || p === '/export/candidates.json' || p === '/export/banned.json') {
      const cycle = await pipeline.pollOnce();
      if (!cycle.candidates) return send(res, 200, { ok: false, message: cycle.error ?? 'no snapshot to export' });

      const json = p.endsWith('.json');
      const rows = p.includes('candidates') ? cycle.candidates : cycle.banned;
      const name = p.split('/').pop().replace('.', '-');
      if (json) return download(res, JSON.stringify(rows, null, 2), 'application/json', `${name}`);

      const csv = p.includes('candidates') ? candidatesCsv(cycle.candidates) : bannedCsv(cycle.banned);
      return download(res, csv, 'text/csv', `${name}`);
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const r = await pipeline.pollOnce();
      return send(res, 200, r);
    }

    if (p === '/api/ban' && req.method === 'POST') {
      const body = await readJson(req);
      const ip = String(body.ip ?? '').trim();
      if (!ip) return send(res, 400, { ok: false, message: 'ip is required' });

      const reason = `${settings.banReasonPrefix}: manual ban from the web UI`;
      const r = await source.ban(ip, settings.permanentDuration, reason, settings.banScenario);
      if (!r.success) addActivity(`BAN FAILED ${ip}: ${r.message}`, 'error');
      else { store.recordAutoBan(ip, null, body.country ?? '', Number(body.score ?? 0), reason); addActivity(`BANNED ${ip} (${settings.permanentDuration})`, 'ban'); }

      const cycle = await pipeline.pollOnce();   // refresh so the Banned view shows the new decision right away
      return send(res, 200, { ok: r.success, message: r.message, ids: r.ids, cycle });
    }

    if (p === '/api/unban' && req.method === 'POST') {
      const body = await readJson(req);
      const id = Number(body.decisionId ?? 0);
      const r = await source.unban(id);
      addActivity(r.success ? `Unbanned decision ${id} (${r.deleted} removed)` : `UNBAN FAILED ${id}: ${r.message}`,
        r.success ? 'info' : 'error');
      const cycle = await pipeline.pollOnce();
      return send(res, 200, { ok: r.success, message: r.message, deleted: r.deleted, cycle });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await applySettings(normalizeSettings(body));
      return send(res, 200, result);
    }

    // Master auto-ban switch applies instantly, with no Save (same as the header toggle in WPF).
    if (p === '/api/autoban' && req.method === 'POST') {
      const body = await readJson(req);
      settings.autoBanEnabled = !!body.enabled;
      const saved = settingsStore.save(settings);
      addActivity(`Auto-ban ${settings.autoBanEnabled ? 'ON' : 'OFF'} (applied instantly, no Save).`, 'info');
      return send(res, 200, { ok: true, autoBanEnabled: settings.autoBanEnabled, storeWarning: saved.warning ?? null });
    }

    if (p === '/api/test' && req.method === 'POST') {
      try { await source.testConnection(); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 200, { ok: false, message: e.message }); }
    }

    // static UI
    const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const full = path.join(HERE, 'public', file);
    if (!full.startsWith(path.join(HERE, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      const type = full.endsWith('.html') ? 'text/html' : full.endsWith('.js') ? 'text/javascript'
        : full.endsWith('.css') ? 'text/css' : full.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      send(res, 200, data, type);
    });
  } catch (e) {
    if (e instanceof SourceAuthException || e instanceof SourceException)
      return send(res, 200, { ok: false, message: e.message, cycle: null });
    addActivity(`Error: ${e.message}`, 'error');
    return send(res, 500, { ok: false, message: e.message });
  }
});

function normalizeSettings(body) {
  const s = JSON.parse(JSON.stringify(settings));
  for (const k of ['baseUrl', 'username', 'password', 'permanentDuration', 'banScenario', 'banReasonPrefix', 'notifyWebhookUrl'])
    if (typeof body[k] === 'string') s[k] = body[k];
  if (body.notifyFormat === 'text' || body.notifyFormat === 'json') s.notifyFormat = body.notifyFormat;
  if (Number.isFinite(body.pollIntervalSeconds)) s.pollIntervalSeconds = Math.max(5, Math.floor(body.pollIntervalSeconds));
  if (Number.isFinite(body.historyRetentionDays)) s.historyRetentionDays = Math.max(1, Math.floor(body.historyRetentionDays));
  if (typeof body.autoBanEnabled === 'boolean') s.autoBanEnabled = body.autoBanEnabled;
  if (typeof body.notificationsEnabled === 'boolean') s.notificationsEnabled = body.notificationsEnabled;
  if (Array.isArray(body.safeCountries)) s.safeCountries = body.safeCountries.map((c) => String(c).trim()).filter(Boolean);

  // Imported lists: the UI sends `blocklists` as an array of rows (URL + schedule + grace window + cap). URL strings are not a
  // security boundary here — baseUrl is edited in exactly the same way, and credentials never live in `settings.json`. Rows without
  // a URL drop; number floors go through the shared canonical helper (`normalizeBlocklists`), same as every settings field.
  if (Array.isArray(body.blocklists)) s.blocklists = normalizeBlocklists(body.blocklists);

  const sc = { ...s.scoring, ...(body.scoring ?? {}) };
  for (const k of ['recidivistBanThreshold', 'aggressiveEventThreshold', 'aggressiveScenarioThreshold'])
    if (Number.isFinite(sc[k])) sc[k] = Math.max(0, Math.floor(sc[k]));
  for (const k of ['eventWeight', 'scenarioWeight', 'banWeight']) {
    const v = Number(sc[k]);          // invariant parsing: unparsable keeps the previous value
    sc[k] = Number.isFinite(v) ? v : s.scoring[k];
  }
  if (Number.isFinite(sc.safeCountryBanScore)) sc.safeCountryBanScore = Math.floor(sc.safeCountryBanScore);
  if (typeof sc.safeCountryBanEnabled === 'boolean') sc.safeCountryBanEnabled = sc.safeCountryBanEnabled;
  s.scoring = sc;

  return s;
}

if (store.readOnly) addActivity(`Store mode: READ-ONLY on "${dir}" — bans are issued, records stay frozen.`, 'warn');

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;   // PERMABAN_PORT=0 → the OS picks a free port
  console.log(`PermaBanNode listening on http://${HOST}:${port}`);
  console.log(`data folder: ${dir} (primary ${primaryDir}, mode ${store.readOnly ? 'read-only' : 'read-write'})`);
  if (storeWarning) console.log(`WARNING: ${storeWarning}`);
  // `PERMABAN_START_PAUSED=1` keeps the poll loop off so a test can drive cycles explicitly through
  // /api/refresh; production never sets it.
  if (!process.env.PERMABAN_START_PAUSED) pipeline.start();   // like AppOrchestrator.Start() in WPF
});


// Graceful shutdown, same idea as tray → Exit in the C# app.
const stop = () => { pipeline.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
