// End-to-end smoke test of the web edition: spawn `node server.js` against a mock CrowdSec Web UI, drive real
// cycles through HTTP, and check what a user sees — state endpoint, SSE stream, one-click Ban/Unban, settings
// round-trip through encrypted credentials, static UI files, clean shutdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../core/settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, '..', 'server.js');

const ALERT_IP = '203.0.1.13';                       // foreign recidivist: 50 events + 3 bans → score 1650
const CREDS = { username: 'u', password: 'p' };
const BASIC = Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64');

const FULL_SETTINGS = {
  baseUrl: '', pollIntervalSeconds: 60, webUiLookbackHours: 168, safeCountries: ['FR'], autoBanEnabled: true,
  permanentDuration: '876000h', banScenario: 'manual/web-ui', banReasonPrefix: 'permaban',
  historyRetentionDays: 90, notificationsEnabled: true, startMinimized: true, initialized: false,
  // The server e2e tests keep the imported list off — no real download in a test, and mock bans stay exactly rule-bans.
  blocklistEnabled: false, blocklistUrl: '', blocklistRefreshMinutes: 60, blocklistUnbanMinutes: 1440, blocklistCapPerCycle: 200,
  scoring: { recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2,
    eventWeight: 1, scenarioWeight: 100, banWeight: 500, safeCountryBanEnabled: true, safeCountryBanScore: 2500 },
};

// A stand-in for the nginx-protected CrowdSec Web UI: Basic auth on every request, paged alerts/decisions,
// POST ban (adds a live decision), DELETE unban (removes it). Tracks what PermaBan asked for. The three seed
// bans are all expired, so the IP starts out as a candidate with no active ban.
function mockWebUi() {
  const decisions = [
    { id: 10, value: ALERT_IP, created_at: '2026-11-03T09:00:00.000Z', expired: true,
      detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: '2026-11-04T09:00:00.000Z' } },
    { id: 11, value: ALERT_IP, created_at: '2026-11-02T09:00:00.000Z', expired: true,
      detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: '2026-11-03T09:00:00.000Z' } },
    { id: 12, value: ALERT_IP, created_at: '2026-11-01T09:00:00.000Z', expired: true,
      detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: '2026-11-02T09:00:00.000Z' } },
  ];
  const alerts = [{ id: 1, created_at: '2026-11-05T09:00:00.000Z', scenario: 'ssh:bfs', events_count: 50,
    source: { ip: ALERT_IP, cn: 'US' } }];
  const bans = [];   // POST bodies PermaBan sent, in order
  let nextId = 100;  // ban #1 gets id 100, ban #2 gets 101 — the test asserts on these

  const json = (res, status, doc) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc));
  };
  const paged = (res, data) => json(res, 200, {
    pagination: { page: 1, page_size: 200, total_items: data.length, total_pages: 1 }, data,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== `Basic ${BASIC}`)
      return json(res, 401, { unauthorized: true });   // nginx Basic layer: nothing gets through without creds

    if (url.pathname === '/api/auth/status') return json(res, 200, { connected: true });

    const del = /^\/api\/decisions\/(\d+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      const id = Number(del[1]);
      const before = decisions.length;
      for (let i = decisions.length - 1; i >= 0; i--) if (decisions[i].id === id) decisions.splice(i, 1);
      return json(res, 200, { nbDeleted: before - decisions.length });
    }

    const collect = (handler) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    };

    if (url.pathname === '/api/decisions' && req.method === 'POST') {
      return collect((body) => {
        bans.push(body);
        const id = nextId++;
        decisions.push({ id, value: body.ip, created_at: new Date().toISOString(), expired: false,
          detail: { type: 'ban', action: 'ban', origin: 'local', expiration: null } });
        json(res, 200, { result: [id] });
      });
    }

    if (url.pathname === '/api/alerts') return paged(res, alerts);
    if (url.pathname === '/api/decisions')
      return paged(res, decisions.filter((d) => url.searchParams.get('include_expired') === 'true' || !d.expired));

    json(res, 404, { not_found: true });
  });

  return new Promise((resolve) => server.listen(0, () => resolve({
    port: server.address().port, bans,
    // Drop keep-alive sockets (Node's fetch pool keeps them open), then close with a safety valve.
    close: () => new Promise((res) => {
      server.closeAllConnections?.();
      server.close(() => res());
      setTimeout(() => res(), 1000);
    }),
  })));
}

// Spawn the app server and learn the port it actually listens on (PERMABAN_PORT=0 → ephemeral,
// PERMABAN_START_PAUSED=1 so this test drives every cycle itself through /api/refresh).
async function startServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PERMABAN_DATA_DIR: dataDir, PERMABAN_PORT: '0', PERMABAN_START_PAUSED: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });

  const port = await waitFor(() => {
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  }, 8000, 'the server never started listening');

  // out() lets a failing test print what the server said before it asserted anything.
  return { child, port, out: () => out };
}

const getJson = async (port, p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
const postJson = async (port, p, body = {}) => (await fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
})).json();

// SSE client that keeps a live list of parsed frames, so the test can poll for cycles as they arrive.
function openSse(port) {
  const frames = [];
  const req = http.request({ host: '127.0.0.1', port, path: '/events', headers: { accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1];
        try { frames.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? '{}') }); } catch { /* ignore */ }
      }
    });
  });
  req.on('error', () => { /* the server closed the stream; polling below times out with a clear message */ });
  req.end();   // without this the request headers are never flushed and no response ever arrives
  return Promise.resolve({ frames, close: () => req.destroy() });
}

async function waitFor(fn, ms, message) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new assert.AssertionError({ message });
    await new Promise((r) => setTimeout(r, 40));
  }
}

test('Server_EndToEnd_Refresh_Ban_Unban_AndSse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-server-'));
  const mock = await mockWebUi();
  // The settings file the server loads: credentials go through the encrypted side file (the DPAPI stand-in).
  new SettingsStore(dir).save({ ...FULL_SETTINGS, baseUrl: `http://127.0.0.1:${mock.port}`, ...CREDS });

  const { child, port, out } = await startServer(dir);
  const sse = await openSse(port);

  try {
    const hello = await waitFor(() => sse.frames.find((f) => f.event === 'hello'), 8000, 'no SSE hello frame');
    assert.equal(hello.data.storeWarning, null);

    const state = await getJson(port, '/api/state');
    assert.equal(state.mode, 'read-write');
    assert.equal(path.resolve(state.dataDir), dir);
    // Credentials came back from the encrypted file: a missing password would make every mock request answer 401.
    assert.equal(state.settings.username, CREDS.username);

    // Static UI files are served.
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /<title>PermaBan — web<\/title>/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`).then((r) => r.status)), 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/style.css`).then((r) => r.status)), 200);

    // Cycle 1 is the baseline: the foreign recidivist gets an immediate permanent ban, with no notification storm.
    const r1 = await postJson(port, '/api/refresh');
    assert.equal(r1.connected, true);                        // Basic auth accepted by the mock
    assert.equal(r1.newEvents, 4);                           // 1 alert + 3 decisions ingested
    assert.equal(r1.candidates.length, 1);
    assert.equal(r1.candidates[0].ip, ALERT_IP);
    assert.equal(r1.candidates[0].country, 'US');
    assert.equal(r1.candidates[0].score, 1650);              // 50×1 + 1×100 + 3×500
    assert.equal(r1.candidates[0].action, 'auto-ban');
    assert.match(r1.candidates[0].reason, /recidivist \(3 bans\)/);

    const ban = mock.bans[0];
    assert.deepEqual(ban, { ip: ALERT_IP, duration: '876000h', type: 'ban',
      reason: 'permaban: recidivist (3 bans)', scenario: 'manual/web-ui' });
    assert.ok(r1.autoBansIssued === 1);
    // The card shows the persisted lifetime count, not just this cycle: the server sends it in every cycle result.
    assert.equal(r1.autoBansTotal, 1);

    // Cycle 2: the ban is a live decision now → the IP moves to the Banned view and is never banned twice.
    const r2 = await postJson(port, '/api/refresh');
    assert.ok(!r2.candidates.some((c) => c.ip === ALERT_IP));
    assert.equal(r2.banned.length, 1);
    assert.equal(r2.banned[0].ip, ALERT_IP);
    assert.equal(r2.banned[0].autoBannedByApp, true);
    assert.equal(mock.bans.length, 1);

    // Cycles stream live to the browser over SSE: frames carry their payload under `data`.
    const cycles = await waitFor(() => sse.frames.filter((f) => f.event === 'cycle').length >= 2 &&
      sse.frames.filter((f) => f.event === 'cycle'), 8000, 'cycles did not reach the SSE stream');
    assert.equal(cycles.length, 2);                                  // one frame per refresh, in order
    assert.equal(cycles[0].data.candidates[0].ip, ALERT_IP);         // cycle 1: recidivist candidate + ban
    assert.equal(cycles[0].data.autoBansIssued, 1);
    assert.equal(cycles[0].data.autoBansTotal, 1);                   // the lifetime count rides in every SSE frame too
    assert.equal(r2.autoBansTotal, 1);                               // an idle cycle keeps the card number steady
    assert.equal(cycles[1].data.banned[0].ip, ALERT_IP);            // cycle 2: it is in the Banned view

    // One-click Unban on the Banned row: the decision disappears server-side, so the liveness sync marks it expired.
    const unb = await postJson(port, '/api/unban', { decisionId: r2.banned[0].id });
    assert.equal(r2.banned[0].id, 100);                      // the mock assigned id 100 to ban #1
    assert.equal(unb.ok, true);
    assert.equal(unb.deleted, 1);

    const r3 = await postJson(port, '/api/refresh');
    assert.equal(r3.banned.filter((b) => b.id === 100).length, 0);   // expired locally, gone from the Banned view
    assert.ok(r3.candidates.some((c) => c.ip === ALERT_IP));         // unbanned → candidate again
    assert.equal(mock.bans.length, 2);                               // and the rule bans it once more

    // Master auto-ban switch applies instantly, without Save: unban ban #2 (id 101), then a cycle must suggest only.
    const off = await postJson(port, '/api/autoban', { enabled: false });
    assert.equal(off.autoBanEnabled, false);
    const unb2 = await postJson(port, '/api/unban', { decisionId: 101 });
    assert.equal(unb2.ok, true);

    const r4 = await postJson(port, '/api/refresh');
    assert.equal(r4.candidates[0].ip, ALERT_IP);
    assert.equal(r4.candidates[0].action, 'suggest');
    assert.match(r4.candidates[0].reason, /auto-ban disabled/);
    assert.equal(mock.bans.length, 2);                                // nothing new hits the Web UI

    // The activity log carries the same lines the WPF tray app writes, newest first.
    const after = await getJson(port, '/api/state');
    const lines = after.activity.map((a) => a.line);
    assert.ok(lines.some((l) => l.startsWith(`AUTO-BANNED ${ALERT_IP} — recidivist (3 bans)`)));
    assert.ok(lines.includes('Unbanned decision 100 (1 removed)'));
    assert.ok(lines.includes(`Auto-ban state cleared for ${ALERT_IP} (no active decision — unbanned externally).`));

    // /healthz — what a container healthcheck sees: alive, the data folder it is using, and last cycle's verdict.
    const health = await getJson(port, '/healthz');
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'read-write');
    assert.equal(health.connected, true);            // the mock Web UI answered the most recent cycle
    assert.ok(health.totalEvents >= 5);              // alert + 3 seed bans + ban #1 fetched as a live decision (ban #2 was unbanned before any cycle ingested it)
    assert.ok(Date.parse(health.at) > 0);            // a real timestamp

    // The per-IP profile viewer: score from history plus every stored event with its full raw JSON.
    const prof = await getJson(port, `/api/profile?ip=${ALERT_IP}`);
    assert.equal(prof.ok, true);
    assert.equal(prof.profile.ip, ALERT_IP);
    assert.equal(prof.profile.eventCount, 50);       // the alert's events_count, summed per IP
    assert.equal(prof.profile.banCount, 4);          // 3 seed bans + ban #1 ingested as a live decision; ban #2 was unbanned before any cycle fetched it
    assert.equal(prof.autoBannedByApp, false);       // ban #2 was unbanned → the app-ban state is cleared
    const alertRaw = prof.events.find((e) => e.kind === 'alert');
    assert.equal(alertRaw.raw.events_count, 50);     // the JSON as the Web UI API sent it
    assert.equal(prof.profile.country, 'US');

    // A profile for an IP nothing is stored about answers empty, not a crash; no ip → 400.
    assert.equal((await getJson(port, '/api/profile?ip=198.51.100.7')).profile, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/profile`)).status, 400);

    // Export links: the same rows as the grids, downloadable as CSV / JSON. The master switch is off at this
    // point, so candidates has the row and there are no active bans left.
    const csv = await (await fetch(`http://127.0.0.1:${port}/export/candidates.csv`)).text();
    assert.match(csv, /^ip,country,score,events,scenarios,bans,first_seen,last_seen,action,reason,by_app\r\n/);
    assert.ok(csv.includes(ALERT_IP));
    const csvRows = csv.trim().split('\r\n').length;
    assert.equal(csvRows, 2);                        // header + the one candidate

    const bcsv = await (await fetch(`http://127.0.0.1:${port}/export/banned.csv`)).text();
    assert.match(bcsv.split('\r\n')[0], /^id,ip,country,scenario,origin,events,bans,score,created,expires,by_app$/);
    assert.equal(bcsv.trim().split('\r\n').length, 1);   // header only: both app bans were unbanned

    const cjson = await (await fetch(`http://127.0.0.1:${port}/export/candidates.json`)).json();
    assert.ok(Array.isArray(cjson) && cjson.length >= 1);
    assert.equal(cjson[0].ip, ALERT_IP);
    assert.equal(typeof cjson[0].score, 'number');

    // The raw history export: one stored event per line, oldest first, full JSON on every row.
    const nd = await (await fetch(`http://127.0.0.1:${port}/export/events.ndjson`)).text();
    const ndLines = nd.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(ndLines.length >= 5);               // the same history /healthz counted, oldest first
    for (const l of ndLines) assert.ok(l.rawJson && l.ip);

    // The shared grid helper is served as a real file the page imports.
    const sortjs = await (await fetch(`http://127.0.0.1:${port}/sort.js`)).text();
    assert.match(sortjs, /export function sortRows/);

  } finally {
    // Kill in `finally` so a failed assertion never leaves the server running (an open child keeps the
    // test runner alive and makes the whole suite hang).
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, 'the server did not exit on kill');
    console.log(`server said: ${out()}`);
    sse.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The settings form round-trips: POST /api/settings persists them (credentials never in the JSON file).
test('Server_SettingsRoundTrip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-settings-'));
  const mock = await mockWebUi();
  new SettingsStore(dir).save({ ...FULL_SETTINGS, baseUrl: `http://127.0.0.1:${mock.port}`, ...CREDS });

  const { child, port } = await startServer(dir);
  try {
    const saved = await postJson(port, '/api/settings', {
      safeCountries: ['FR', 'DE'], scoring: { recidivistBanThreshold: 4, safeCountryBanScore: 3000 },
      pollIntervalSeconds: 120, notifyWebhookUrl: 'https://ntfy.sh/my-topic', notifyFormat: 'json',
      // The imported blocklist round-trips through the same sanitization as every other numeric field.
      blocklistEnabled: true, blocklistUrl: 'https://example.test/abuseipdb-s100-7d.ipv4',
      blocklistRefreshMinutes: 30, blocklistUnbanMinutes: 90, blocklistCapPerCycle: 150,
    });
    assert.equal(saved.ok, true);

    const state = await getJson(port, '/api/state');
    assert.deepEqual(state.settings.safeCountries, ['FR', 'DE']);
    assert.equal(state.settings.scoring.recidivistBanThreshold, 4);
    assert.equal(state.settings.scoring.safeCountryBanScore, 3000);
    assert.equal(state.settings.pollIntervalSeconds, 120);

    // The webhook fields round-trip too — a container app is configured once from Settings (or from env at first run).
    assert.equal(state.settings.notifyWebhookUrl, 'https://ntfy.sh/my-topic');
    assert.equal(state.settings.notifyFormat, 'json');

    // The blocklist settings live in the same saved file as everything else: enabled, URL, minutes, cap.
    assert.equal(state.settings.blocklistEnabled, true);
    assert.equal(state.settings.blocklistUrl, 'https://example.test/abuseipdb-s100-7d.ipv4');
    assert.equal(state.settings.blocklistRefreshMinutes, 30);
    assert.equal(state.settings.blocklistUnbanMinutes, 90);
    assert.equal(state.settings.blocklistCapPerCycle, 150);

    const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.match(raw, /"notifyWebhookUrl": "https:\/\/ntfy\.sh\/my-topic"/);
    assert.match(raw, /"username": ""/);                        // credentials stay in the encrypted side file
    assert.ok(fs.existsSync(path.join(dir, 'credentials.enc')) && fs.existsSync(path.join(dir, 'key.bin')));

    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, 'the server did not exit on kill');
  } finally {
    // Same safety as the end-to-end test: always stop the spawned server.
    child.kill();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Container first run: a compose file can configure the app entirely through env vars (the compose env in README).
// With no settings.json at all, PERMABAN_* seeds everything; a cycle then talks to the mock with those credentials.
test('Server_EnvSeedsTheFirstRunAndNothingElseAfterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-envseed-'));
  const mock = await mockWebUi();

  const seedEnv = {
    PERMABAN_BASE_URL: `http://127.0.0.1:${mock.port}`,
    PERMABAN_USERNAME: CREDS.username,
    PERMABAN_PASSWORD: CREDS.password,
    PERMABAN_WEBHOOK_URL: 'https://ntfy.sh/permaban-test',
    PERMABAN_POLL_SECONDS: '45',
    PERMABAN_BLOCKLIST_ENABLED: '1',
    PERMABAN_BLOCKLIST_URL: 'https://example.test/abuseipdb-s100-3d.ipv4',
    PERMABAN_BLOCKLIST_REFRESH_MINUTES: '90',
    PERMABAN_BLOCKLIST_UNBAN_MINUTES: '0',
    PERMABAN_BLOCKLIST_CAP_PER_CYCLE: '250',
  };

  const { child, port } = await startServer(dir, seedEnv);
  try {
    const state = await getJson(port, '/api/state');
    assert.equal(state.settings.baseUrl, `http://127.0.0.1:${mock.port}`);
    assert.equal(state.settings.username, CREDS.username);       // credentials have no place in settings.json → env keeps seeding them
    assert.equal(state.settings.pollIntervalSeconds, 45);
    assert.equal(state.settings.notifyWebhookUrl, 'https://ntfy.sh/permaban-test');

    // A compose file can pick the imported list, its schedule, and the unban window at first run too.
    assert.equal(state.settings.blocklistEnabled, true);
    assert.equal(state.settings.blocklistUrl, 'https://example.test/abuseipdb-s100-3d.ipv4');
    assert.equal(state.settings.blocklistRefreshMinutes, 90);
    assert.equal(state.settings.blocklistUnbanMinutes, 0);       // 0 is a valid seed: unban the cycle an IP leaves the list
    assert.equal(state.settings.blocklistCapPerCycle, 250);

    const seededLine = state.activity.find((a) => a.line.startsWith('Settings seeded from environment'));
    assert.ok(seededLine, 'the launch did not say what it seeded');
    for (const k of ['baseUrl', 'username', 'password', 'notifyWebhookUrl', 'pollIntervalSeconds',
      'blocklistEnabled', 'blocklistUrl', 'blocklistRefreshMinutes', 'blocklistUnbanMinutes', 'blocklistCapPerCycle'])
      assert.ok(seededLine.line.includes(k), `${k} is missing from the seed line`);

    // The seeded credentials are enough to run a real cycle against the mock.
    const r = await postJson(port, '/api/refresh');
    assert.equal(r.connected, true);
    assert.ok(r.candidates.some((c) => c.ip === ALERT_IP));

    // The seeded list URL is not reachable in this test: the fetch fails, the cycle reports it, and nothing changes —
    // a failed download never bans or unbans anything (the tracked set stays exactly as it was).
    assert.equal(r.blocklistSkip, 'fetch failed');
    assert.equal(r.blocklistTracked, 0);
    assert.equal(mock.bans.length, 1);                            // the one ban this cycle issued is the rule auto-ban

    // Save writes settings.json; after that the env vars are ignored — the UI's own values win on next launch.
    const saved = await postJson(port, '/api/settings', { pollIntervalSeconds: 90, notifyWebhookUrl: '' });
    assert.equal(saved.ok, true);

    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, 'the server did not exit on kill');

    const { child: second, port: p2 } = await startServer(dir, seedEnv);
    try {
      const after = await getJson(p2, '/api/state');
      assert.equal(after.settings.pollIntervalSeconds, 90);       // saved in the UI → env seed ignored
      assert.equal(after.settings.notifyWebhookUrl, '');          // cleared in the UI → env seed ignored
      // The seeded blocklist settings persisted on Save and survive the restart (the store's schedule is their own file).
      assert.equal(after.settings.blocklistEnabled, true);
      assert.equal(after.settings.blocklistUrl, 'https://example.test/abuseipdb-s100-3d.ipv4');
      assert.equal(after.settings.blocklistRefreshMinutes, 90);
      assert.ok(!after.activity.some((a) => a.line.startsWith('Settings seeded from environment')));
    } finally {
      second.kill();
      await waitFor(() => second.exitCode !== null || second.signalCode !== null, 5000, 'the second launch did not exit on kill');
    }

    // Settings saved → the file wins from now on; credentials went to the encrypted side file at that Save.
    const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.match(raw, /"username": ""/);                          // never in settings.json
    assert.ok(fs.existsSync(path.join(dir, 'credentials.enc')));  // and now they live encrypted on the volume
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).pollIntervalSeconds, 90);

  } finally {
    child.kill();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A compose file that sets only the URL must not invent a poll interval: empty env vars leave the defaults alone.
test('Server_EnvSeedIgnoresEmptyValuesAndKeepsDefaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-emptyenv-'));
  const mock = await mockWebUi();

  const { child, port } = await startServer(dir, {
    PERMABAN_BASE_URL: `http://127.0.0.1:${mock.port}`,
    PERMABAN_USERNAME: CREDS.username,
    PERMABAN_PASSWORD: CREDS.password,
    PERMABAN_WEBHOOK_URL: '',      // explicitly empty in the compose file
    PERMABAN_POLL_SECONDS: '',
  });

  try {
    const state = await getJson(port, '/api/state');
    assert.equal(state.settings.baseUrl, `http://127.0.0.1:${mock.port}`);
    assert.equal(state.settings.pollIntervalSeconds, 60);      // the default survives an empty env var
    assert.equal(state.settings.notifyWebhookUrl, '');

    const seededLine = state.activity.find((a) => a.line.startsWith('Settings seeded from environment'));
    assert.ok(seededLine, 'the launch did not say what it seeded');
    for (const k of ['baseUrl', 'username', 'password'])
      assert.ok(seededLine.line.includes(k), `${k} is missing from the seed line`);
    for (const k of ['pollIntervalSeconds', 'notifyWebhookUrl'])
      assert.ok(!seededLine.line.includes(k), `${k} was seeded from an empty env var`);

    // Seeded credentials + default interval: a real cycle runs against the mock.
    const r = await postJson(port, '/api/refresh');
    assert.equal(r.connected, true);
    assert.ok(r.candidates.some((c) => c.ip === ALERT_IP));
  } finally {
    child.kill();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// /api/inspect answers with the chart geometry the dashboard draws and the shortened scenario row names —
// chart visibility is verifiable over HTTP, not by eye.
test('Server_InspectReportsChartGeometryAndShortScenarioNames', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-inspect-'));

  // Mock Web UI with one prefixed vendor scenario (events_count > the E2E alert's 50, so it is the top row).
  const j = (res, status, doc) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(doc)); };
  const mockServer = http.createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${BASIC}`) return j(res, 401, {});
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/auth/status') return j(res, 200, { connected: true });
    if (p === '/api/decisions' && req.method === 'POST') {   // the app's ban POST must answer like the real Web UI
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => j(res, 200, { result: [91] }));
      return;
    }
    const data = p === '/api/alerts'
      ? [{ id: 41, created_at: '2026-11-05T09:00:00.000Z', scenario: 'ssh:bfs', events_count: 50, source: { ip: ALERT_IP, cn: 'US' } },
         { id: 42, created_at: '2026-11-05T10:00:00.000Z', scenario: 'crowdsecurity:sshd-max', events_count: 300, source: { ip: '198.51.100.7', cn: 'US' } }]
      : [];
    j(res, 200, { pagination: { page: 1, page_size: 200, total_items: data.length, total_pages: 1 }, data });
  });
  const portMock = await new Promise((r) => mockServer.listen(0, () => r(mockServer.address().port)));

  const { child, port } = await startServer(dir, {
    PERMABAN_BASE_URL: `http://127.0.0.1:${portMock}`, PERMABAN_USERNAME: CREDS.username, PERMABAN_PASSWORD: CREDS.password,
  });

  try {
    const cyc = await postJson(port, '/api/refresh');
    assert.equal(cyc.connected, true);

    const insp = await getJson(port, '/api/inspect');
    assert.equal(insp.ok, true);
    assert.equal(insp.viewBox, '0 0 560 92', 'the geometry must draw in the page declared viewBox');

    // The gap-filled window is complete, and every day has a printed number of its own.
    const n = insp.bars.length;
    assert.ok(n >= 14, `expected at least ${n} days in the chart`);
    assert.equal(insp.labels.length, n, 'a bar without its number');

    // SVG text y is the baseline: a number's body hangs above it, so `bar top > label y + clearance` means the
    // number sits in the band above its bar. Tall bars clamp at the box's top edge — a 3-unit floor covers both.
    for (let i = 0; i < n; i++) {
      const b = insp.bars[i], t = insp.labels[i];
      assert.equal(t.date, b.day.date, `label ${i} belongs to another day`);
      assert.ok(t.y >= 9 && t.y <= 92 - 8, `label y=${t.y} can clip at any width`);
      assert.ok(b.width >= 2, `bar ${i} is less than 2 units wide`);
      assert.ok(b.y > t.y + 3, `day ${b.day.date}: number baseline (${t.y}) below the bar top (${b.y}) — buried in the bar`);
    }

    // Spike and quiet days: the tall day is the tallest, bars stand on the axis line, zero days keep visible stubs.
    const big = insp.bars.filter((b) => b.fill === '#4ac1ff' && b.height > 30);   // sqrt(350)·6.86 clamps to the band's top
    assert.ok(big.length >= 1, 'the spike day has no tall bar');
    const tallest = Math.max(...insp.bars.map((b) => b.height));
    for (const b of insp.bars.filter((x) => x.zero)) {
      assert.ok(b.y === insp.axisBaseline - b.height && b.height <= 2, 'zero-day stubs must stand on the axis as hairlines');
    }
    assert.ok(tallest <= insp.axisBaseline - 20 && tallest >= big[0].height, 'the max bar must stay below the number band');

    // Every real day keeps a visible stub — no sub-2-unit hairline lines under small numbers.
    for (const b of insp.bars) if (!b.zero) assert.ok(b.height >= 6, `positive bar at height ${b.height} is invisible`);

    // Top-scenario rows: the vendor prefix comes off the label, the full name is kept for its tooltip.
    const top = insp.topScenarios;
    assert.ok(top.length >= 2, 'the mock has two scenarios to show');
    assert.ok(!top.some((s) => s.name.startsWith('crowdsecurity')), 'a row label still carries crowdsecurity/');
    const pref = top.find((s) => s.full.startsWith('crowdsecurity:'));
    assert.ok(pref && pref.name === 'sshd-max', `prefix not stripped from ${JSON.stringify(top[0])}`);

    // The un-prefixed scenario is untouched, and events of both alerts show up in the geometry.
    const plain = top.find((s) => s.name === 'ssh:bfs');
    assert.ok(plain && plain.full === 'ssh:bfs', `shortScenario touched ${JSON.stringify(plain)}`);
  } finally {
    child.kill();
    mockServer.closeAllConnections?.();
    await new Promise((r) => { mockServer.close(() => r()); setTimeout(r, 1000); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The user's report was "the page loads with no graph and no numbers; I have to click Refresh now". A tab opened between
// two polls gets exactly one frame (`hello`) plus whatever `/api/state` answered, so both must carry the last snapshot.
test('Server_FreshPagePaintsFromStateAndSseHello', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-load-'));
  const mock = await mockWebUi();
  new SettingsStore(dir).save({ ...FULL_SETTINGS, baseUrl: `http://127.0.0.1:${mock.port}`, ...CREDS });

  const { child, port, out } = await startServer(dir);
  try {
    // Before any cycle there is nothing to paint: the snapshot slot stays empty (the page says "starting…").
    const pre = await getJson(port, '/api/state');
    assert.ok(!pre.cycle, 'state invented a snapshot before the first cycle ran');

    const r1 = await postJson(port, '/api/refresh');
    const state = await getJson(port, '/api/state');
    assert.ok(state.cycle, '/api/state carries no snapshot — a page loaded now draws nothing until "Refresh now" is clicked');
    assert.equal(state.cycle.connected, true);
    assert.equal(state.cycle.candidates[0].ip, ALERT_IP);
    assert.ok(state.cycle.dashboard.dailyEvents.length >= 1 && state.cycle.dashboard.topScenarios.length >= 1, 'the snapshot has no chart data to draw');

    // A browser connecting now sees `hello` as its only frame before the next poll: it must be enough to paint charts.
    const sse = await openSse(port);
    const hello = await waitFor(() => sse.frames.find((f) => f.event === 'hello'), 8000, 'no SSE hello frame');
    assert.ok(hello.data.cycle, 'the hello frame carries no snapshot for a loading/reconnecting page');
    assert.equal(hello.data.cycle.candidates[0].ip, ALERT_IP);
    assert.equal(hello.data.cycle.at, r1.at, 'hello paints an older cycle than the last one the server ran');

    sse.close();
  } finally {
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, 'the server did not exit on kill');
    console.log(`server said: ${out()}`);
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
