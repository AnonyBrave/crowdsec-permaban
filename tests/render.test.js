// The page's own code, executed in Node under a minimal DOM shim — no browser. `public/app.js` runs as it does for a user:
// its imports resolve, `renderCycle` draws the charts into elements, and everything that gets produced is checked from the
// strings app.js writes (bars, numbers, shortened scenario labels). A name used without importing (ReferenceError) shows up
// here as a crash on module load, and guard() behaviour is proved by injecting failures — so one broken chart can never
// blank out cards + charts + grids at once. Mock Web UI + real `server.js`, no network beyond localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, '..', 'server.js');
const APP_JS = new URL('../public/app.js', import.meta.url);
const HTML = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');

const CREDS = { username: 'u', password: 'p' };
const BASIC = Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64');
const ALERT_IP = '203.0.1.13';   // 3 expired seed bans → recidivist candidate; today's alerts keep the series short

// Mock Web UI: Basic auth on every request, paged alerts (one prefixed vendor scenario + one plain), decisions listing.
// Both alerts land on the same day of the store → positive bar + quiet stubs. POST ban appends a live decision, exactly
// as server.test.js does: the app-ban becomes an ACTIVE decision only when the Web UI lists it again, so a cycle that
// bans shows the tag in Candidates (no row in Banned), and the NEXT cycle renders the Unban row. That two-cycle shape is
// what renderCycle has to survive, and inventing "banned immediately" here would test a state production never sends.
function mockWebUi() {
  const alerts = [
    { id: 1, created_at: '2026-11-06T10:00:00.000Z', scenario: 'crowdsecurity:sshd-max', events_count: 300, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 2, created_at: '2026-11-06T11:00:00.000Z', scenario: 'ssh:bfs', events_count: 50, source: { ip: ALERT_IP, cn: 'US' } },
  ];
  const decisions = [10, 11, 12].map((id, i) => ({ id, value: ALERT_IP, created_at: `2026-11-0${3 - i}T09:00:00.000Z`,
    expired: true, detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: `2026-11-0${4 - i}T09:00:00.000Z` } }));
  let nextId = 100;

  const server = http.createServer((req, res) => {
    const j = (status, doc) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(doc)); };
    if (req.headers.authorization !== `Basic ${BASIC}`) return j(401, {});
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/auth/status') return j(200, { connected: true });

    // POST /api/decisions: record the ban as a live decision and answer like the real Web UI ({ result: [id] }).
    const collect = () => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(JSON.parse(b || '{}'))); });
    if (p === '/api/decisions' && req.method === 'POST') {
      collect().then((body) => {
        const id = nextId++;
        decisions.push({ id, value: body.ip, created_at: new Date().toISOString(), expired: false, scenario: body.scenario,
          detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: '2126-11-06T09:00:00.000Z' } });
        j(200, { result: [id] });
      });
      return;
    }

    const data = p === '/api/alerts' ? alerts : decisions;
    j(200, { pagination: { page: 1, page_size: 200, total_items: data.length, total_pages: 1 }, data });
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

const waitFor = async (fn, ms, msg) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function startServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PERMABAN_DATA_DIR: dataDir, PERMABAN_PORT: '0', PERMABAN_START_PAUSED: '1',
      // No network in these tests (localhost mock only): the imported list stays off, exactly as a compose deployment
      // can keep it off. The pipeline's own blocklist flows are tested offline through its fetcher seam.
      PERMABAN_BLOCKLIST_ENABLED: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (c) => { out += c; });
  const port = await waitFor(() => Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1] ?? null), 8000, 'the server never started listening');
  return { child, port };
}

// ── DOM shim: elements created on demand, innerHTML / viewBox recorded for assertions ──────────────
const SVG_IDS = [...HTML.matchAll(/<svg id="([^"]+)"/g)].map((m) => m[1]);   // <svg> hosts (donut, sparkline) in the real page

function makeShim() {
  const els = {};
  const mk = (id) => ({
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, className: '', dataset: {},
    namespaceURI: SVG_IDS.includes(id) ? 'http://www.w3.org/2000/svg' : undefined,   // guard() picks its hint style on this
    attrs: {}, viewBox: null, listeners: {}, classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'viewBox') this.viewBox = v; },
    getAttribute(k) { return this.attrs[k]; }, hasAttribute() { return false; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener(t, f) { this.listeners[t] = f; },
  });
  const document = {
    getElementById: (id) => (els[id] ??= mk(id)),
    querySelectorAll: () => [],
    addEventListener: (t, f) => {},          // app.js wires profile-modal close on the document itself
  };
  const eventSources = [];
  class FakeEventSource { constructor(url) { this.url = url; eventSources.push(this); } addEventListener(t, f) {} close() {} }
  return { els, document, FakeEventSource };
}

const attrsOf = (raw) => Object.fromEntries([...raw.matchAll(/(\w+)="([\d.]+)"/g)].map((m) => [m[1], Number(m[2])]));
const NUM = new Intl.NumberFormat('en-US');

async function runUi() {   // shim + server: install globals, import the page's module; the test drives the cycles itself
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-render-'));
  const mock = await mockWebUi();
  const { child, port } = await startServer(dir, { PERMABAN_BASE_URL: `http://127.0.0.1:${mock.port}`, PERMABAN_USERNAME: CREDS.username, PERMABAN_PASSWORD: CREDS.password });

  const realFetch = globalThis.fetch;
  const { els, document, FakeEventSource } = makeShim();
  globalThis.document = document;
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = (p, opts) => realFetch(`http://127.0.0.1:${port}${p}`, opts);

  const app = await import(APP_JS);   // module init runs loadState() through the shim — imports must resolve for real
  return {
    els, dir, child, mock, app,
    refresh: () => realFetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' }).then((r) => r.json()),
    render: (snap) => app.renderCycle(snap),
    guard: (hostId, fn) => app.guard(hostId, fn),   // the exported seam, same one a browser page ignores
    cleanup() { globalThis.fetch = realFetch; },
  };
}

const countRows = (html) => (html.match(/<tr/g) ?? []).length;   // rows are <tr> strings app.js joins into the tbody

test('Ui_Render_AppDrawsChartsAndStripsPrefixesInShimDom', async () => {
  const { els, dir, child, mock, refresh, render, cleanup } = await runUi();
  try {
    // Cycle A: ALERT_IP is auto-banned (US is foreign → permanent). The app tag lands in Candidates; the Web UI has not
    // listed the new decision yet, so Banned stays empty — pinning that here keeps both grids honest about cycle order.
    const snapA = await refresh(); render(snapA);
    assert.equal(snapA.connected, true, 'the cycle ran against the mock Web UI');
    assert.ok(els.candidateRows.innerHTML.includes(ALERT_IP) && els.candidateRows.innerHTML.includes('banned by app'),
      `cycle A candidate row is not the auto-banned verdict: ${els.candidateRows.innerHTML.slice(0, 260)}`);
    assert.equal(countRows(els.bannedRows.innerHTML), snapA.banned.length, 'Banned shows rows the snapshot did not send (cycle A)');

    // Cycle B lists that ban back, so this is what a user actually looks at: charts and grids compare with snapB.
    const snapB = await refresh(); render(snapB);

    // The sparkline as app.js writes it: bars standing on the axis, numbers above them, every day present.
    const svg = els.sparkline;
    assert.equal(svg.viewBox, /<svg id="sparkline" viewBox="([^"]+)"/.exec(HTML)[1], 'rendered box ≠ declared box');
    const rects = [...svg.innerHTML.matchAll(/<rect[^>]*>/g)].map((m) => ({ ...attrsOf(m[0]), raw: m[0] }));   // fill stays a string
    assert.equal(rects.length, snapB.dashboard.dailyEvents.length, 'a day of the window has no bar in the DOM');

    const pos = rects.filter((r) => r.raw.includes('fill="#4ac1ff"')), zeros = rects.filter((r) => r.raw.includes('fill="#6a7078"'));
    assert.ok(pos.length >= 1 && zeros.length >= 1, 'the window must show both a real day and quiet days');
    for (const r of pos) assert.ok(r.height >= 6 && r.height <= 50 && r.y + r.height <= Number(svg.viewBox.split(' ')[3]), `positive bar ${JSON.stringify({ y: r.y, height: r.height })} is not visible`);
    for (const r of zeros) assert.ok(r.height <= 2, `zero-day stub ${r.height} draws as a bar`);

    // Every day prints its own number, paired with its bar in the order charts.js emits them (bars, then labels).
    const valYs = [...svg.innerHTML.matchAll(/<text x="[\d.]+" y="([\d.]+)" class="val">/g)].map((m) => Number(m[1]));
    assert.equal(valYs.length, rects.length, 'a day without its printed number');
    for (let i = 0; i < rects.length; i++) {   // SVG text y is a baseline: the number body sits above it
      assert.ok(rects[i].y > valYs[i] + 3, `day ${i}: number baseline inside its bar`);
      assert.ok(valYs[i] >= 9 && valYs[i] <= Number(svg.viewBox.split(' ')[3]) - 8, `number at y=${valYs[i]} can clip at any width`);
    }

    const printed = [...svg.innerHTML.matchAll(/class="val">([^<]*)<\/text>/g)].map((m) => m[1]);
    assert.deepEqual(printed, snapB.dashboard.dailyEvents.map((d) => NUM.format(d.events)), 'printed numbers do not match the store');   // app.js formats en-US grouped, the shim keeps that

    // Top-scenario rows: shortened labels, full name only in the tooltip.
    const rows = els.topScenarios.innerHTML;
    assert.ok(rows.includes('>sshd-max<'), `shortScenario did not reach the DOM: ${rows.slice(0, 200)}`);
    assert.ok(rows.includes('title="crowdsecurity:sshd-max"'), 'the full scenario name is missing from its tooltip');
    assert.ok(!/>crowdsecurity/.test(rows), 'a row label still shows the vendor prefix');

    // Grids after cycle B: rows mirror exactly what the snapshot sends, and the issued ban is now an Unban row.
    assert.equal(countRows(els.candidateRows.innerHTML), snapB.candidates.length, `cycle B candidate rows ≠ snapshot (${snapB.candidates.length} sent)`);
    assert.ok(snapB.banned.some((b) => b.ip === ALERT_IP) && els.bannedRows.innerHTML.includes(ALERT_IP),
      'the ban issued in cycle A never reached the Banned grid');
    assert.ok(els.bannedRows.innerHTML.includes('Unban'), `Banned row has no Unban control: ${els.bannedRows.innerHTML.slice(0, 260)}`);

    assert.ok(SVG_IDS.length >= 2, 'the page declares the svg hosts guard() handles');
  } finally {
    cleanup(); child.kill(); mock.server.closeAllConnections?.(); await new Promise((r) => mock.server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A section that throws shows a hint line in its own host and the rest of the cycle stays rendered —
// this is what turned "chart crashed" into "the whole dashboard went blank".
test('Ui_Render_GuardIsolatesAFailingSection', async () => {
  const { els, dir, child, mock, refresh, render, guard, cleanup } = await runUi();
  try {
    const snapA = await refresh(); render(snapA);             // issue the ban first …
    const snapB = await refresh();                            // … then cycle B is the state with an Unban row

    const broken = JSON.parse(JSON.stringify(snapB));
    broken.dashboard.topScenarios = null;                     // a snapshot shape change is enough to make it throw
    render(broken);

    assert.ok(els.topScenarios.innerHTML.includes('failed to render'), `the failing row section shows nothing: ${els.topScenarios.innerHTML.slice(0, 160)}`);
    const bars = [...els.sparkline.innerHTML.matchAll(/<rect[^>]*>/g)];   // the chart rendered before it keeps its bars
    assert.ok(bars.length === snapB.dashboard.dailyEvents.length, `a crash in top scenarios blanked the sparkline (${bars.length} bars)`);

    // Everything after the crash still renders: cards, countries chart, both grids.
    assert.ok(els.topCountries.innerHTML.includes('<div'), 'the countries grid stopped behind the crashed scenario rows');
    assert.equal(countRows(els.candidateRows.innerHTML), snapB.candidates.length, 'candidate rows stopped rendering behind a crashed chart');
    assert.ok(els.bannedRows.innerHTML.includes(ALERT_IP) && els.bannedRows.innerHTML.includes('Unban'), 'the Banned grid stopped rendering behind a crashed chart');

    // guard() picks an svg-text hint for <svg> hosts (namespaceURI comes from index.html's markup).
    els.sparkline.innerHTML = '';
    guard('sparkline', () => { throw new Error('boom'); });
    assert.ok(els.sparkline.innerHTML.includes('<text') && els.sparkline.innerHTML.includes('chart unavailable: boom'), 'svg hint is not svg text');

    // A div host gets the div hint, and the crash is reported to the console (the user sees a reason, not a blank box).
    els.topScenarios.innerHTML = '';
    guard('topScenarios', () => { throw new Error('boom'); });
    assert.ok(els.topScenarios.innerHTML.includes('<div') && els.topScenarios.innerHTML.includes('failed to render — boom'), 'div hint is not div markup');
  } finally {
    cleanup(); child.kill(); mock.server.closeAllConnections?.(); await new Promise((r) => mock.server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// "Opening the page shows nothing — I have to click Refresh now." The load path is `loadState()` against `/api/state`; if
// that answer carries no snapshot, cards/charts/grids stay empty until the next poll pushes an SSE frame. This runs the
// real function with a wiped DOM: the strings it produces are exactly what a fresh tab paints, no click, no SSE frame.
test('Ui_LoadStatePaintsTheDashboardWithoutARefreshClick', async () => {
  const ui = await runUi();
  const { els, dir, child, mock, app, refresh, cleanup } = ui;
  try {
    const snap = await refresh();                       // the server now has a last-cycle snapshot in `/api/state`
    for (const e of Object.values(els)) {               // wipe the DOM: this load sees what a brand-new page sees
      e.innerHTML = ''; e.textContent = ''; e.viewBox = null;
    }

    await app.loadState();                              // module init + the function a browser runs on load

    const rects = [...els.sparkline.innerHTML.matchAll(/<rect[^>]*>/g)];
    assert.equal(rects.length, snap.dashboard.dailyEvents.length, `load drew ${rects.length} bars, not every day of the window`);
    assert.ok(els.statTotal.textContent !== '' && els.statCandidates.textContent !== '', 'the cards stayed empty on load');
    assert.equal(els.status.textContent, 'Connected', `status after load: "${els.status.textContent}" — a fresh page looked disconnected`);
    assert.ok(els.topScenarios.innerHTML.includes('<div') && els.candidateRows.innerHTML.includes('<tr'),
      'top scenarios / candidates did not render from the state snapshot alone');
    assert.ok(els.activityLog.innerHTML.includes('line'), 'the activity log is part of load and must come back on the page');

    assert.ok(els.dataDirLine.textContent.includes('mode'), `load did not report the data directory/mode: ${els.dataDirLine.textContent}`);
  } finally {
    cleanup(); child.kill(); mock.server.closeAllConnections?.(); await new Promise((r) => mock.server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
