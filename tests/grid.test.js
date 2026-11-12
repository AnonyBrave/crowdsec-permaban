// The grid's sorting + filter box, executed as the page runs it: `public/app.js` under a DOM shim that models `<th data-key>`
// headers (click handlers, `data-numeric`, the ▲/▼ indicator) and the two filter inputs. Header clicks and typed text drive the real
// code once — app.js wires its listeners at module load, so one shared boot serves every test here. Expectations come from the raw
// snapshot fields plus what the page displays (en-US grouped numbers, `dd/mm/yyyy, hh:mm:ss` dates), following the documented sort rules; a column that
// sorts as text, or a filter box that reads only ip/country/scenario/origin, fails here instead of in someone's browser. Zero network:
// snapshots go straight into `renderCycle`, and `/api/state` is stubbed so module init resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = new URL('../public/app.js', import.meta.url);
const HTML = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');

// Header cells with attributes only (`<th `), so `<thead>` is never read as the first column — that is how the IP header was lost.
function headerList(tableId) {
  const block = new RegExp(`<table id="${tableId}"[\\s\\S]*?<\\/thead>`).exec(HTML)[0];
  return [...block.matchAll(/<th\s+([^>]*)>([\s\S]*?)<\/th>/g)].map((m) => ({
    key: (/data-key="([^"]+)"/.exec(m[1]) ?? [])[1], numeric: /data-numeric/.test(m[1]),
    label: m[2].replace(/<[^>]*>/g, '').trim(),
  })).filter((h) => h.key);
}

// Settings shape `/api/state` carries on a fresh page; `cycle: null` keeps module init from painting rows.
const STATE = { settings: { baseUrl: 'https://crowdsecwebui.example.com', username: 'u', password: 'p', pollIntervalSeconds: 60,
  historyRetentionDays: 90, permanentDuration: '876000h', banReasonPrefix: 'permaban', banScenario: 'manual/web-ui',
  autoBanEnabled: true, notificationsEnabled: true, notifyWebhookUrl: '', notifyFormat: 'text', safeCountries: ['FR'],
  scoring: { recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2, eventWeight: 1,
    scenarioWeight: 100, banWeight: 500, safeCountryBanEnabled: true, safeCountryBanScore: 2500 } },
  dataDir: 'X', mode: 'read-write', activity: [], storeWarning: null, cycle: null };

function makeShim() {
  const els = {};
  const mk = (id) => ({
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, className: '', dataset: {},
    attrs: {}, listeners: {}, classList: { add() {}, remove() {} }, namespaceURI: undefined, viewBox: null,
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'viewBox') this.viewBox = v; },
    getAttribute(k) { return this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },   // data-numeric is a valueless attribute
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener(t, f) { this.listeners[t] = f; },
  });

  const headersById = {};
  for (const name of ['candidatesGrid', 'bannedGrid']) {
    headersById[name] = headerList(name).map((h) => ({
      dataset: { key: h.key }, attrs: { 'data-key': h.key, ...(h.numeric ? { 'data-numeric': '' } : {}) },
      textContent: h.label, innerHTML: '', ind: { textContent: '' }, listeners: {},
      hasAttribute(k) { return k in this.attrs; },
      querySelector(sel) { return sel === '.ind' ? this.ind : null; },   // app.js writes the arrow into `.ind`
      addEventListener(t, f) { this.listeners[t] = f; },
    }));
  }

  const document = {
    getElementById: (id) => (els[id] ??= mk(id)),
    querySelectorAll: (sel) => { const m = /^#(\w+) th\[data-key\]$/.exec(sel); return m ? headersById[m[1]] : []; },
    addEventListener: () => {},          // app.js wires the Escape key on the document itself
  };
  class FakeEventSource { constructor(url) {} addEventListener(t, f) {} close() {} }
  return { els, document, headersById, FakeEventSource };
}

const realFetch = globalThis.fetch;
const { els, document, headersById, FakeEventSource } = makeShim();
globalThis.document = document;
globalThis.EventSource = FakeEventSource;
globalThis.fetch = async () => ({ json: async () => STATE });

const app = await import(APP_JS);      // module init runs loadState() against the stub and wires header + filter listeners here
globalThis.fetch = realFetch;

// ── fixtures: every column has distinguishable values, ties included for the stability rule ──────
const CAND = [
  { ip: '10.0.0.9', country: 'FR', score: 3500, eventCount: 1200, scenarioCount: 4, banCount: 4, firstSeen: '2026-10-30T08:00:00.000Z', lastSeen: '2026-11-05T09:00:00.000Z', action: 'auto-ban', reason: 'recidivist (4 bans)', isRecidivist: true, isAggressive: true, autoBannedByApp: false },
  { ip: '8.8.8.8', country: 'DE', score: 900, eventCount: 800, scenarioCount: 1, banCount: 0, firstSeen: '2026-11-01T05:00:00.000Z', lastSeen: '2026-11-06T10:00:00.000Z', action: 'suggest', reason: 'aggressive (800 events, 1 scenario)', isRecidivist: false, isAggressive: true, autoBannedByApp: false },
  { ip: '198.51.100.7', country: 'US', score: 250, eventCount: 40, scenarioCount: 2, banCount: 0, firstSeen: '2026-11-02T03:00:00.000Z', lastSeen: '2026-11-04T12:00:00.000Z', action: 'auto-ban', reason: 'foreign country (US)', isRecidivist: false, isAggressive: false, autoBannedByApp: true },
  { ip: '203.0.113.5', country: '', score: 250, eventCount: 40, scenarioCount: 2, banCount: 0, firstSeen: '2026-11-03T09:00:00.000Z', lastSeen: '2026-11-06T11:00:00.000Z', action: 'suggest', reason: 'unknown country (score 250)', isRecidivist: false, isAggressive: false, autoBannedByApp: false },
];
const BANNED = [
  { id: 11, ip: '10.0.0.9', scenario: 'crowdsecurity/ssh-bf', country: 'FR', origin: 'coordinator', createdAt: '2026-11-05T10:00:00.000Z', expiresAt: '2126-11-04T10:00:00.000Z', autoBannedByApp: true, events: 3499, bans: 4, score: 5599 },
  { id: 12, ip: '8.8.8.8', scenario: 'crowdsecurity:sshd-max', country: 'DE', origin: 'crowdsec', createdAt: '2026-11-06T09:00:00.000Z', expiresAt: '2126-11-05T09:00:00.000Z', autoBannedByApp: false, events: 800, bans: 1, score: 1000 },
  { id: 13, ip: '198.51.100.7', scenario: 'manual/web-ui', country: 'US', origin: 'cscli', createdAt: '2026-11-04T08:00:00.000Z', expiresAt: '2126-11-03T08:00:00.000Z', autoBannedByApp: false, events: 40, bans: 2, score: 1240 },
];

const snapshot = () => ({ at: '2026-11-06T15:00:00.000Z', totalEvents: 3800, autoBansIssued: 1, connected: true,
  candidates: CAND.slice(), banned: BANNED.slice(),
  dashboard: { bannedIps: 3, recidivistBannedIps: 2, dailyEvents: [], topScenarios: [], topCountries: [] } });

const nf = new Intl.NumberFormat('en-US');
const n0 = (x) => nf.format(Math.round(x));
// Mirror of app.js's fixed display form: `dd/mm/yyyy, hh:mm:ss` built from local Date fields. Built by hand, not
// `toLocaleString('en-GB', …)`, because locale output varies with ICU version and time zone — a needle typed here must be
// the exact text the page prints on any runner.
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTs = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}, ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// The page's `<td>` for one column, rebuilt here from the raw fields: rows ordered correctly in a cell that renders them in a
// different format is caught too. Verdict cell = shortReason + action tag; Banned's last column is the by-app tag.
const candCell = (r, key) => ({ ip: `<span class="ip" data-profile="${r.ip}" title="Show the stored events and raw JSON for ${r.ip}">${r.ip}</span>`,
  country: r.country || '', score: n0(r.score), eventCount: n0(r.eventCount), scenarioCount: String(r.scenarioCount),
  banCount: String(r.banCount), firstSeen: fmtTs(r.firstSeen), lastSeen: fmtTs(r.lastSeen) })[key]
  ?? `${r.reason.length > 70 ? r.reason.slice(0, 69) + '…' : r.reason} ${r.action === 'auto-ban'
    ? (r.autoBannedByApp ? '<span class="tag">banned by app</span>' : '<span class="tag ban">will auto-ban</span>')
    : r.action === 'suggest' ? '<span class="tag sug">suggested</span>' : ''}`;

const bannedCell = (r, key) => ({ ip: `<span class="ip" data-profile="${r.ip}" title="Show the stored events and raw JSON for ${r.ip}">${r.ip}</span>`,
  country: r.country || '', scenario: r.scenario, origin: r.origin, events: n0(r.events), bans: String(r.bans),
  score: n0(r.score), createdAt: fmtTs(r.createdAt), expiresAt: fmtTs(r.expiresAt) })[key]
  ?? (r.autoBannedByApp ? '<span class="tag">by app</span>' : '');

const cellOf = { candidatesGrid: candCell, bannedGrid: bannedCell };

// A whole-row searchable string per grid: every column in its stored **and** displayed form. Written from the raw fields here, so a
// column missing in app.js's builder is a failure — that is exactly what made events/bans/score/created/expires answer empty.
const rowText = (g, r) => ({
  candidatesGrid: [r.ip, r.country, r.score, n0(r.score), r.eventCount, n0(r.eventCount), r.scenarioCount, n0(r.scenarioCount),
    r.banCount, n0(r.banCount), r.firstSeen, fmtTs(r.firstSeen), r.lastSeen, fmtTs(r.lastSeen), r.reason,
    r.action === 'auto-ban' ? (r.autoBannedByApp ? 'banned by app' : 'will auto-ban') : r.action === 'suggest' ? 'suggested' : ''],
  bannedGrid: [r.ip, r.country, r.scenario, r.origin, r.events, n0(r.events), r.bans, n0(r.bans), r.score, n0(r.score),
    r.createdAt, fmtTs(r.createdAt), r.expiresAt, fmtTs(r.expiresAt), r.autoBannedByApp ? 'by app' : ''],
})[g].join(' ').toLowerCase();

// Documented sort semantics: numbers numerically, strings (ISO dates included) as text, empties first ascending and last descending,
// ties keep the incoming order (= the server's ranking). `dir` flips the whole comparison.
const expectOrder = (rows, key, dir) => rows.slice().sort((a, b) => {
  const va = a[key], vb = b[key];
  const emptyA = va === '' || va === null || va === undefined, emptyB = vb === '' || vb === null || vb === undefined;
  let cmp;
  if (emptyA && emptyB) cmp = 0;
  else if (emptyA) cmp = -1;
  else if (emptyB) cmp = 1;
  else {
    const na = Number(va), nb = Number(vb);
    cmp = (Number.isFinite(na) && Number.isFinite(nb)) ? na - nb : String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
  }
  return cmp * dir || rows.indexOf(a) - rows.indexOf(b);   // stable: equal values keep their incoming order
}).map((r) => r.ip);

const GRID = { candidatesGrid: { body: 'candidateRows', input: 'filterCandidates', raw: CAND, headers: headerList('candidatesGrid') },
               bannedGrid: { body: 'bannedRows', input: 'filterBanned', raw: BANNED, headers: headerList('bannedGrid') } };

const rowCells = (html) => [...html.matchAll(/<tr>\s*([\s\S]*?)<\/tr>/g)].map((m) =>
  [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
const shownIps = (html) => rowCells(html).map((r) => /data-profile="([^"]+)"/.exec(r[0] ?? '')?.[1] ?? null);

// Mirror of the page's sort state, updated exactly as app.js does on a header click: the same header flips direction, a new
// header starts high-first for numeric columns and low-first for text ones. Expectations below read this mirror.
const sortState = { candidatesGrid: { key: 'score', dir: -1 }, bannedGrid: { key: 'createdAt', dir: -1 } };

function click(g, key) {
  const th = headersById[g].find((t) => t.dataset.key === key), st = sortState[g];
  assert.ok(th && th.listeners.click, `${g} has no clickable header for ${key}`);
  if (st.key === key) st.dir = -st.dir;
  else { st.key = key; st.dir = th.hasAttribute('data-numeric') ? -1 : 1; }
  th.listeners.click();
  return th;
}

const type = (g, text) => { els[GRID[g].input].value = text; els[GRID[g].input].listeners.input(); };
const shown = (g) => shownIps(els[GRID[g].body].innerHTML);
const cells = (g, key) => rowCells(els[GRID[g].body].innerHTML).map((r) => r[GRID[g].headers.findIndex((h) => h.key === key)]);

test('Grid_SortingEveryColumnOfBothGrids', () => {
  for (const g of Object.keys(GRID)) {
    const raw = GRID[g].raw;
    app.renderCycle(snapshot());                                  // back to the server's own row order

    for (const h of GRID[g].headers) {
      const newKey = sortState[g].key !== h.key, wantDir = h.numeric ? -1 : 1;   // numbers high-first, text low-first
      const th = click(g, h.key);
      assert.ok(th.ind.textContent.trim() === (sortState[g].dir < 0 ? '▼' : '▲'), `${g} / ${h.key}: arrow matches the direction`);

      if (newKey) {
        assert.equal(sortState[g].dir, wantDir, `${g} / ${h.key}: a new column must start ${wantDir < 0 ? 'high-first' : 'low-first'}`);
        assert.equal(th.ind.textContent.trim(), wantDir < 0 ? '▼' : '▲', `${g} / ${h.key}: arrow after the first click`);
      }
      const dir = sortState[g].dir;
      assert.equal(JSON.stringify(shown(g)), JSON.stringify(expectOrder(raw, h.key, dir)),
        `${g} / ${h.key}: rows must be sorted (${dir < 0 ? 'high-first' : 'low-first'})`);

      // The column's cells show each sorted row's own displayed value in that order.
      const want = expectOrder(raw, h.key, dir).map((ip) => cellOf[g](raw.find((r) => r.ip === ip), h.key));
      assert.deepEqual(cells(g, h.key), want, `${g} / ${h.key}: displayed cells must follow the sorted rows`);

      // Only the active header carries an arrow.
      for (const other of GRID[g].headers) if (other.key !== h.key)
        assert.equal(headersById[g].find((t) => t.dataset.key === other.key).ind.textContent, '', `${g}: ${other.key} shows no arrow while ${h.key} is active`);

      const flipped = click(g, h.key);                            // same header again: reverse direction, ties stay stable
      assert.equal(JSON.stringify(shown(g)), JSON.stringify(expectOrder(raw, h.key, -dir)), `${g} / ${h.key}: second click reverses`);
      assert.equal(flipped.ind.textContent.trim(), dir < 0 ? '▲' : '▼', `${g} / ${h.key}: arrow flips on the second click`);

      const tied = raw.filter((r) => String(r[h.key]) === String(raw[0][h.key])).map((r) => r.ip);   // ties keep server order
      if (tied.length > 1) assert.equal(JSON.stringify(shown(g).filter((ip) => tied.includes(ip))), JSON.stringify(tied),
        `${g} / ${h.key}: rows tying at ${raw[0][h.key]} must keep the server's order`);

      app.renderCycle(snapshot());                                // repaint the incoming order for the next column
    }
  }
});

test('Grid_FilterBoxCoversEveryColumnOfBothGrids', () => {
  for (const g of Object.keys(GRID)) { app.renderCycle(snapshot()); click(g, 'ip'); }   // ip ascending: one known order per probe

  // [label, typed text, expected rows] — the text is what that column shows in the page, so a filter ignoring a column answers
  // empty (the original bug: events/bans/score/created/expires were never searched). Raw numbers and ISO days are typed too.
  const probes = {
    candidatesGrid: [
      ['ip', '10.0.0.9', ['10.0.0.9']],
      ['country, case-insensitive', 'fr', ['10.0.0.9']],
      ['score as displayed', '3,500', ['10.0.0.9']],
      ['score stored', '900', ['8.8.8.8']],
      ['events as displayed', '1,200', ['10.0.0.9']],
      ['events stored', '1200', ['10.0.0.9']],
      ['scenarios + ban counts, whole-row match', '4', null],  // substring rule: "4" is in that row's counts and in other rows' dates —
                                                                  // per-column coverage for these small counts is proved column-by-column below
      ['ban count, substring rule', 'ban: 4', null],     // the documented whole-row substring match (see README)
      ['first seen ISO day', '2026-10-30', ['10.0.0.9']],
      ['last seen as displayed', fmtTs(CAND.find((r) => r.ip === '203.0.113.5').lastSeen), ['203.0.113.5']],
      ['verdict words', 'recidivist', ['10.0.0.9']],
      ['verdict tag words', 'will auto-ban', ['10.0.0.9']],
    ],
    bannedGrid: [
      ['ip', '8.8.8.8', ['8.8.8.8']],
      ['country, case-insensitive', 'de', ['8.8.8.8']],
      ['scenario tail', 'sshd-max', ['8.8.8.8']],
      ['origin', 'cscli', ['198.51.100.7']],
      ['events stored', '3499', ['10.0.0.9']],
      ['events as displayed', '3,499', ['10.0.0.9']],
      ['ban count via score digits example', '240', null],   // substring rule: "1,240" contains it and the row is picked by text
      ['score as displayed', '5,599', ['10.0.0.9']],
      ['score stored', '1240', ['198.51.100.7']],
      ['created ISO day', '2026-11-05', ['10.0.0.9']],
      ['created as displayed', fmtTs(BANNED.find((r) => r.ip === '8.8.8.8').createdAt), ['8.8.8.8']],
      ['expires ISO day', '2126-11-03', ['198.51.100.7']],
      ['expires as displayed', fmtTs(BANNED.find((r) => r.ip === '10.0.0.9').expiresAt), ['10.0.0.9']],
      ['by-app tag words', 'by app', ['10.0.0.9']],
    ],
  };

  for (const g of Object.keys(GRID)) {
    const raw = GRID[g].raw, dir = sortState[g].dir;
    for (const [label, text, expected] of probes[g]) {
      type(g, text);
      // `expected: null` marks a substring probe — every row whose displayed row text contains the text must survive.
      const want = expected ?? expectOrder(raw.filter((r) => rowText(g, r).includes(text.toLowerCase())), 'ip', dir);
      assert.equal(JSON.stringify(shown(g)), JSON.stringify(want), `${g} filter [${label}] "${text}"`);
    }

    type(g, 'zz-no-match-zz');                         // nothing shows it → empty grid, no crash
    assert.equal(shown(g).length, 0, `${g}: a filter with no match must show 0 rows`);

    type(g, '');                                       // cleared box restores the full grid under the active sort
    assert.equal(JSON.stringify(shown(g)), JSON.stringify(expectOrder(raw, 'ip', dir)), `${g}: clearing the filter restores every row`);
  }
});

// The same coverage proved through the page's own builders: a distinctive value in each column must be findable, in stored and
// displayed form. `tests/ui.test.js` keeps the static cross-check that these columns are real snapshot fields.
test('Grid_EverySortableColumnIsSearchableInThePageBuilders', () => {
  const DATE_KEYS = ['firstSeen', 'lastSeen', 'createdAt', 'expiresAt'];

  for (const g of Object.keys(GRID)) {
    const build = g === 'candidatesGrid' ? app.searchCandidate : app.searchBanned;
    for (const h of GRID[g].headers) {
      const probe = { ...GRID[g].raw[0] };
      let needles;
      if (h.key === 'autoBannedByApp') { probe.autoBannedByApp = true; needles = ['by app']; }
      else if (DATE_KEYS.includes(h.key)) {
        probe[h.key] = '2031-12-21T23:59:00.000Z';
        needles = ['2031-12-21', fmtTs(probe[h.key])];          // the ISO day and the date text in the cell
      }
      else if (h.numeric) { probe[h.key] = 9001; needles = ['9001', n0(9001)]; }   // stored number + displayed form
      else { probe[h.key] = 'zzmarker77'; needles = ['zzmarker77']; }

      const found = build(probe).toLowerCase();
      for (const needle of needles) assert.ok(found.includes(needle), `${g} column ${h.key}: "${needle}" must be searchable`);
    }
  }

  // The two grids' real rows carry the forms users type: grouped numbers, ISO day, `dd/mm/yyyy, hh:mm:ss` date.
  assert.ok(app.searchBanned(BANNED[0]).includes('3499') && app.searchBanned(BANNED[0]).includes(n0(3499)), 'events searchable stored and displayed');
  assert.ok(app.searchBanned(BANNED[0]).includes('2026-11-05') && app.searchBanned(BANNED[0]).includes(fmtTs(BANNED[0].createdAt)), 'created searchable as ISO day and displayed date');
  assert.ok(app.searchCandidate(CAND[0]).includes('2026-10-30') && app.searchCandidate(CAND[0]).includes(n0(3500)), 'first seen + score searchable for a candidate row');
});

// Sorting keeps working while the filter box narrows the grid, in both directions.
test('Grid_FilterAndSortCombine', () => {
  app.renderCycle(snapshot());

  click('bannedGrid', 'score');                          // numeric → high-first (the mirror knows this transition)
  type('bannedGrid', 'crowdsec');                        // ssh-bf row + origin=crowdsec row survive
  const kept = BANNED.filter((r) => rowText('bannedGrid', r).includes('crowdsec'));
  assert.equal(JSON.stringify(shown('bannedGrid')), JSON.stringify(expectOrder(kept, 'score', sortState.bannedGrid.dir)),
    'Banned: filtered rows keep the numeric high-first order');

  type('bannedGrid', '');                                // all rows back under that same sort
  assert.equal(JSON.stringify(shown('bannedGrid')), JSON.stringify(expectOrder(BANNED, 'score', -1)),
    'Banned: clearing the filter restores every row under the active sort');

  click('candidatesGrid', 'eventCount');                 // numeric → high-first, over the filtered subset only
  type('candidatesGrid', 'aggressive');
  const keptC = CAND.filter((r) => rowText('candidatesGrid', r).includes('aggressive'));
  assert.equal(JSON.stringify(shown('candidatesGrid')), JSON.stringify(expectOrder(keptC, 'eventCount', sortState.candidatesGrid.dir)),
    'Candidates: filter + numeric sort combine');

  click('candidatesGrid', 'firstSeen');                  // text column → low-first, filtered rows included
  const kept2 = CAND.filter((r) => rowText('candidatesGrid', r).includes('8.8.8.8'));
  assert.equal(JSON.stringify(shown('candidatesGrid')), JSON.stringify(expectOrder(kept2, 'firstSeen', sortState.candidatesGrid.dir)),
    'Candidates: a text column sorts the filtered rows low-first');
});
