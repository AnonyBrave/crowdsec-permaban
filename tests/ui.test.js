// Static cross-checks between the page and its scripts: every element app.js touches exists in index.html,
// every sortable column is a field the server actually sends in its snapshot, and every export link points at
// a route the server implements. All three break silently when one side of the pair is renamed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const read = (p) => fs.readFileSync(p, 'utf8');

const html = read(path.join(PUBLIC, 'index.html'));
const appjs = read(path.join(PUBLIC, 'app.js'));
const serverjs = read(path.join(HERE, '..', 'server.js'));

// The row fields of a cycle snapshot, straight from core/pipeline.js (`result.candidates` / `result.banned`).
const CANDIDATE_KEYS = ['ip', 'country', 'score', 'eventCount', 'scenarioCount', 'banCount',
  'firstSeen', 'lastSeen', 'action', 'reason', 'isRecidivist', 'isAggressive', 'autoBannedByApp'];
const BANNED_KEYS = ['id', 'ip', 'scenario', 'country', 'createdAt', 'expiresAt', 'origin',
  'autoBannedByApp', 'events', 'bans', 'score'];

test('Ui_EveryElementThePageTouchesExistsInTheHtml', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // The page looks elements up with `$('id')`; dynamic names built by template literals are views, checked next.
  const used = [...appjs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(used.length > 30, 'the page reads far fewer ids than it should — is app.js the right file?');
  for (const id of new Set(used)) assert.ok(ids.has(id), `app.js uses #${id}, index.html has no such element`);

  // Sidebar buttons → the view section they show (`data-view="x"` ↔ `#view-x`).
  const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(views, ['dashboard', 'candidates', 'banned', 'activity', 'blocklists', 'settings']);
  for (const v of views) {
    assert.ok(ids.has(`view-${v}`), `no #view-${v} section for the sidebar button`);
    assert.ok(appjs.includes('`view-${b.dataset.view}`'), 'the page does not switch sections by data-view');
  }
});

test('Ui_SortableColumnsAreFieldsTheServerSends', () => {
  const keysOf = (gridId) => {
    // Pick exactly this table: from its opening tag to the next `</table>`; a lazy match on both grids'
    // names would always return the first one in the page.
    const open = html.indexOf(`<table id="${gridId}"`);
    assert.ok(open >= 0, `${gridId} is not in the page`);
    const table = html.slice(open, html.indexOf('</table>', open));
    return [...table.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  };

  const candKeys = keysOf('candidatesGrid');
  for (const k of candKeys) assert.ok(CANDIDATE_KEYS.includes(k), `candidate column "${k}" is not a snapshot field`);
  // The score column and the numeric ones are marked so clicking them starts high-first.
  for (const k of ['score', 'eventCount', 'scenarioCount', 'banCount'])
    assert.ok(candKeys.includes(k) && new RegExp(`data-key="${k}" data-numeric`).test(html), `${k} must sort as a number`);

  const banKeys = keysOf('bannedGrid');
  for (const k of banKeys) assert.ok(BANNED_KEYS.includes(k), `banned column "${k}" is not a snapshot field`);
  assert.deepEqual(
    ['ip', 'country', 'scenario', 'origin', 'events', 'bans', 'score', 'createdAt', 'expiresAt'],
    banKeys.slice(0, 9));

  // The filter boxes search one derived field per row (`_s`), the whole row as displayed — so every column above, numbers
  // grouped and dates in the page's `dd/mm/yyyy, hh:mm:ss` form included, is matchable. `tests/grid.test.js` drives real typing; here we keep the static pair:
  // the builder must mention every sortable column of its grid, or a renamed field silently stops being filterable.
  const filters = [...appjs.matchAll(/keys:\s*\[([^\]]+)\]/g)].map((m) => m[1].split(',').map((s) => s.trim().replace(/'/g, '')));
  assert.deepEqual(filters, [['_s'], ['_s']]);

  const builder = (name) => new RegExp(`function ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(appjs)[1];
  for (const k of candKeys) assert.ok(new RegExp(`c\\.${k}\\b`).test(builder('searchCandidate')), `Candidates filter misses column "${k}"`);
  for (const k of banKeys) assert.ok(new RegExp(`b\\.${k}\\b`).test(builder('searchBanned')), `Banned filter misses column "${k}"`);

  // Grid bodies and filter inputs referenced by the grid state exist in the page.
  const grids = [...appjs.matchAll(/(candidatesGrid|bannedGrid):\s*\{([\s\S]*?)\}/g)].map((m) => m[2]);
  assert.equal(grids.length, 2);
  for (const g of grids) {
    for (const key of ['filter', 'body']) {
      // `\\s` because the pattern is built inside a template literal: one backslash there disappears from the regex.
      const id = new RegExp(`${key}:\\s*'([^']+)'`).exec(g)[1];
      assert.ok(html.includes(`id="${id}"`), `grid state references #${id}, the page has no such element`);
    }
  }
});

test('Ui_ExportLinksMatchTheServerRoutes', () => {
  const routes = ['/export/events.ndjson', '/export/candidates.csv', '/export/banned.csv',
    '/export/candidates.json', '/export/banned.json'];
  for (const r of routes) assert.ok(serverjs.includes(`'${r}'`), `server.js does not implement ${r}`);

  const links = [...html.matchAll(/href="(\/export\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(links.length, routes.length);
  for (const l of new Set(links)) {
    assert.ok(routes.includes(l), `the page links ${l}, no such route`);
    assert.ok(serverjs.includes(`'${l}'`));
  }

  // The per-IP profile viewer calls the endpoint it is supposed to.
  assert.match(appjs, /fetch\(`\/api\/profile\?ip=\$\{encodeURIComponent\(ip\)\}`\)/);
  assert.ok(html.includes('id="profileModal"') && html.includes('id="closeProfile"'));
});

// app.js loads as an ES module, so every relative import must be a real file the static UI serves.
test('Ui_AppImportsResolveToRealServedFiles', async () => {   // async: it executes the chart module to prove the strip
  const specifiers = [...appjs.matchAll(/from\s*'(\.[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(specifiers, ['./sort.js', './charts.js']);   // the page keeps to its two helper modules
  for (const s of specifiers) assert.ok(fs.existsSync(path.join(PUBLIC, s.slice(2))), `import ${s} is not a file`);

  // The functions app.js calls from charts.js are the ones it exports.
  const chartsSrc = read(path.join(PUBLIC, 'charts.js'));
  for (const fn of ['sparkBars', 'barWidthPct', 'shortScenario']) {
    assert.ok(chartsSrc.includes(`export function ${fn}`), `charts.js does not export ${fn}`);
    assert.ok(appjs.includes(`${fn}(`), `app.js never uses ${fn}`);
  }

  // Every chart name app.js touches must be in its import list. A constant used without importing throws
  // ReferenceError in the browser, and everything after that throw stops rendering — this is exactly how the
  // dashboard went blank ("nothing shows"): `SPARK_VIEW_W` was referenced with only functions imported.
  const importLine = /import\s*\{([^}]*)\}\s*from\s*'\.\/charts\.js'/.exec(appjs)[1].split(',').map((s) => s.trim());
  const exportedNames = [...chartsSrc.matchAll(/^export\s+(?:function|const)\s+(\w+)/gm)].map((m) => m[1]);
  assert.ok(exportedNames.length >= 5, `charts.js exports look wrong: ${exportedNames.join(', ')}`);
  const appBody = appjs.replace(/import\s*\{[^}]*\}\s*from\s*'[^']*'/g, '');   // usage counts, the import line does not
  for (const name of exportedNames) {
    if (!new RegExp(`\\b${name}\\b`).test(appBody)) continue;                  // unused export is fine
    assert.ok(importLine.includes(name), `app.js uses ${name} from charts.js without importing it`);
  }

  // Sections render independently: guard() wraps each chart in renderCycle so one failure shows a hint, not a blank page.
  assert.ok(/function guard\(hostId, fn\)/.test(appjs) &&
    /guard\('sparkline', \(\) => renderSparkline/.test(appjs) &&
    /guard\('topScenarios', \(\) => renderBars/.test(appjs),
    'chart sections must each be guarded — a crash in one must not blank out the others');

  // index.html's sparkline box must match the geometry module, or bars would sit in a resized frame.
  const view = /<svg id="sparkline" viewBox="([^"]+)"/.exec(html)[1];
  assert.match(chartsSrc, new RegExp(`SPARK_VIEW_W = ${view.split(' ')[2]}`));
  assert.match(chartsSrc, new RegExp(`SPARK_VIEW_H = ${view.split(' ')[3]}`));

  // The scenario labels go through shortScenario (crowdsecurity/ prefix stripped for the row).
  assert.ok(appjs.includes('shortScenario(s.name)') && /title="\$\{esc\(full \?\? name\)\}"/.test(appjs),
    'top scenarios must show shortened names with the full name in the tooltip');

  // Top-scenario labels come from `shortScenario` in app.js — proved here on the two spellings CrowdSec
  // delivers, so a vendor prefix can never reach a grid row: strip → label, full name stays for its tooltip.
  const { shortScenario } = await import(chartsP);
  const strip = (n) => { const t = shortScenario(n); return [t.name, t.full]; };   // exactly app.js's mapping of topScenarios
  assert.deepEqual(strip('crowdsecurity:sshd-max'), ['sshd-max', 'crowdsecurity:sshd-max']);
  assert.deepEqual(strip('crowdsecurity/ssh-badlogin'), ['ssh-badlogin', 'crowdsecurity/ssh-badlogin']);
  for (const live of ['http-crawl-non_statics', 'vpatch-CVE-2025-29927'])          // the production rows are untouched
    assert.deepEqual(strip(live), [live, live]);

  // The chart needs its axis line, zero-day stub colour and roomier labels in CSS.
  const css = read(path.join(PUBLIC, 'style.css'));
  assert.ok(/\.base\s*\{/.test(css), 'no .base rule for the axis line class the SVG emits');
});

// The chart geometry module is pure — it can be executed directly from Node here.
const chartsP = new URL('../public/charts.js', import.meta.url);
test('Ui_ShortScenarioStripsTheVendorPrefixForLabels', async () => {
  const { shortScenario } = await import(chartsP);
  assert.deepEqual(shortScenario('crowdsecurity:sshd-max'), { name: 'sshd-max', full: 'crowdsecurity:sshd-max' });
  assert.deepEqual(shortScenario('crowdsecurity/ssh-badlogin'), { name: 'ssh-badlogin', full: 'crowdsecurity/ssh-badlogin' });
  for (const n of ['crowdsec:sshd-max', 'sshpbrute', 'crowdsecx:y'])   // near-misses keep the full name
    assert.equal(shortScenario(n).name, n);
  assert.equal(shortScenario('').name, '');
});

// The window from the user's screen: one spike of 2886 next to days of 5..703 — linear scaling made every
// small day an invisible line. Bars must stay in bounds and every real day keeps a visible stub.
test('Ui_SparkBarsStayInBoundsAndSmallDaysStayVisible', async () => {
  const { sparkBars, SPARK_VIEW_H } = await import(chartsP);
  const window14 = [5, 21, 0, 71, 8, 0, 703, 2886, 1431, 1145, 490, 341, 268, 153].map((events, i) =>
    ({ date: `2026-10-${String(24 + i).padStart(2, '0')}`, events }));

  const chart = sparkBars(window14);
  assert.equal(chart.viewBox, `0 0 560 ${SPARK_VIEW_H}`);
  const bars = chart.parts.filter((s) => s.startsWith('<rect'));
  assert.equal(bars.length, 14);   // gap-filled window: every day answers with a bar

  const numOf = (raw, attr) => Number(new RegExp(`${attr}="([\\d.]+)"`).exec(raw)?.[1]);
  for (const raw of bars) {
    assert.ok(numOf(raw, 'y') >= 0 && numOf(raw, 'y') + numOf(raw, 'height') <= SPARK_VIEW_H, `bar ${raw} runs off the box`);
    assert.ok(numOf(raw, 'width') >= 2, `bar ${raw} is less than 2 units wide`);
    if (raw.includes('fill="#4ac1ff"')) {                       // a day with events: a readable stub at minimum, max bar below the number band
      assert.ok(numOf(raw, 'height') >= 6 && numOf(raw, 'height') <= 50, `positive bar height ${numOf(raw, 'height')} is not visible`);
    } else {
      assert.ok(raw.includes('fill="#6a7078"'));                // zero days are muted, never the accent colour
      assert.ok(numOf(raw, 'height') >= 1 && numOf(raw, 'height') <= 2, 'zero-day stubs must stay hairlines on the baseline');
    }
  }

  // The printed number sits above its bar's top (SVG text y is the baseline: gap = bar top − label y), inside
  // the box; dates sit under the axis line. Tall bars clamp at the top edge — the same pairing rule as /api/inspect.
  const vals = chart.labels.map((t) => t.y);
  assert.equal(vals.length, 14);   // zero days print their '0' too — the visibility is the point
  for (const y of vals) { assert.ok(y >= 9 && y <= SPARK_VIEW_H - 8, `value label at y=${y} can clip`); }

  const tops = chart.bars.map((b) => b.y);
  for (let i = 0; i < 14; i++) {
    assert.ok(chart.labels[i].date === window14[i].date, `label ${i} belongs to another day`);
    assert.ok(tops[i] > vals[i] + 3, `day ${i}: the number sits inside its bar`);
  }

  const axisYs = chart.parts.filter((s) => s.includes('class="ax"')).map((t) => numOf(t, 'y'));
  assert.equal(axisYs.length, 14);
  for (const y of axisYs) assert.ok(y > chart.axisBaseline && y < SPARK_VIEW_H, `date label at y=${y} collides with bars`);

  // The spike must not swallow the small days, and it must not flatten them into one plateau either: heights follow
  // `h = √events · band/√max` exactly (clamped to the band's top and to the visible floor), so neighbouring big days
  // stay distinguishable — multiplying events by a `band/√max` scale saturates every day above ~√max at the same bar.
  const heights = bars.map((r) => numOf(r, 'height'));
  const evs = window14.map((d) => d.events);
  assert.ok(heights[evs.indexOf(Math.max(...evs))] === Math.max(...heights), 'the biggest day is not the tallest bar');
  for (let i = 1; i < 14; i++)
    if (evs[i] > evs[i - 1]) assert.ok(heights[i] >= heights[i - 1], `day ${i} (${evs[i]} events) is shorter than day ${i - 1} (${evs[i - 1]})`);

  const scale = 50 / Math.sqrt(Math.max(...evs));   // band = axisBaseline(70) − barsTop(20)
  for (let i = 0; i < 14; i++) {
    if (evs[i] === 0) continue;
    const want = Math.min(50, Math.max(6, Math.sqrt(evs[i]) * scale));
    assert.ok(Math.abs(heights[i] - want) < 0.02, `day ${i} (${evs[i]} events): bar ${heights[i]} ≠ √-scaled ${want.toFixed(2)} — the scale is applied to raw events again`);
  }

  // Days big enough to leave the visible floor must be distinguishable from each other (no plateau).
  const above = window14.map((d, i) => [i, d.events]).filter(([, e]) => Math.sqrt(e) * scale > 6.02);   // h not clamped at 6
  for (const a of above) for (const b of above)
    if (a[1] !== b[1]) assert.ok(heights[a[0]] !== heights[b[0]],
      `days with ${a[1]} and ${b[1]} events draw the same bar — a spike flattened its neighbours`);

  const linear = (v) => Math.min(50, 50 * v / Math.max(...evs));   // the old geometry: h = band·events/max (band was 58)
  assert.ok(linear(21) < 2 && heights[1] >= 6, 'the 21-events day is a sub-2-unit hairline — invisible');
  const midRatio = heights[8] / Math.max(...heights), linearMid = linear(1431) / 50;   // index 8: the 1431-event day
  assert.ok(midRatio > linearMid + 0.1, `mid-size day keeps ratio ${midRatio.toFixed(2)} (linear ${(linearMid).toFixed(2)}) — not compressed`);

  // The axis line the bars stand on is emitted once.
  const bases = chart.parts.filter((s) => s.startsWith('<line'));
  assert.equal(bases.length, 1);
});

test('Ui_BarTrackWidthsKeepRelativeScale', async () => {
  const { barWidthPct } = await import(chartsP);
  assert.equal(barWidthPct(2886, 2886), 100);
  assert.equal(barWidthPct(1443, 2886), 50);      // top-country rows keep honest proportions
  for (const v of [0, -5]) assert.equal(barWidthPct(v, 2886), 0);
  for (const [v, m] of [[1, 1], [703, 1431], [99, 5]]) {
    const w = barWidthPct(v, m);
    assert.ok(w >= 0 && w <= 100, `width ${w} escapes the track`);
  }
});

// Theme & header chrome, the CrowdSec Web UI pattern the page copies: a sidebar theme radiogroup (light / system / dark)
// applied on load + persisted, an icon pill per view, and the sticky header title following the active view. The pairing test above
// already proves the ids app.js touches exist — these checks prove the wiring itself.
test('Ui_ThemeSwitchAndHeaderTitleWired', () => {
  const radios = [...html.matchAll(/<button id="(themeLight|themeSystem|themeDark)" data-theme-choice="([^"]+)"/g)];
  assert.deepEqual(radios.map((m) => [m[1], m[2]]), [['themeLight', 'light'], ['themeSystem', 'system'], ['themeDark', 'dark']],
    'the sidebar footer must carry the three theme choices, in order');

  // app.js reads localStorage, applies data-theme on load and wires all three buttons — no browser needed to prove it.
  assert.ok(appjs.includes("'permaban.theme'"), 'no persisted key for the stored theme choice');
  assert.ok(/applyTheme\(savedTheme\)/.test(appjs), 'the page never applies the stored theme on load');
  assert.ok(/\['themeLight', 'themeSystem', 'themeDark'\]\)\s*\$\(id\)\.addEventListener/.test(appjs), 'the three theme buttons are not wired to chooseTheme');

  // Each sidebar pill carries its icon (svg) — exactly the reference nav item pattern: icon + label, icons wired to views.
  const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  const pills = [...html.matchAll(/<button data-view="([^"]+)"[^>]*>(?:\s*<span>)?/g)].map((m) => m[1]);
  for (const v of views) {
    const block = html.slice(html.indexOf(`data-view="${v}"`), html.indexOf('</button>', html.indexOf(`data-view="${v}"`)));
    assert.ok(block.includes('<svg'), `nav pill "${v}" has no icon svg`);
  }

  // Header title mapping + the stamping of "last cycle" into the sidebar footer card.
  for (const v of views) assert.ok(appjs.includes(`${v}:`), `VIEW_TITLE has no entry for ${v}`);
  assert.ok(/\$\('viewTitle'\)\.textContent\s*=\s*VIEW_TITLE\[b\.dataset\.view\]/.test(appjs), 'the header title does not follow the active view');
  assert.ok(/const lat = \$\('lastAt'\)[\s\S]{0,45}lat\.textContent\s*=\s*fmtTs\(c\.at\)/.test(appjs), 'the sidebar footer never stamps the cycle time');
});

// The page-load bug the user reported: opening the dashboard showed no graph and no numbers until "Refresh now" was
// clicked. Static proof that a fresh load can paint on its own — `/api/state` answers with the last snapshot, `loadState`
// draws it, and SSE `hello` carries the same snapshot for a tab opened between two polls (or a reconnect).
test('Ui_PagePaintsOnLoadFromStateAndSseHello', () => {
  assert.ok(/if \(s\.cycle\)[^\n]*renderCycle\(s\.cycle\)/.test(appjs), 'loadState does not draw the snapshot it gets from /api/state');
  assert.ok(/addEventListener\('hello'[\s\S]{0,320}?d\.cycle[^\n]*renderCycle\(d\.cycle\)/.test(appjs),
    'the SSE hello frame does not paint the last snapshot for a loading/reconnecting page');
  assert.ok(serverjs.includes('cycle: lastCycleResult'), '/api/state must answer with the last cycle snapshot');
  assert.ok(/function loadState\(\)/.test(appjs) && /export \{[^}]*loadState/.test(appjs),
    'loadState must exist and be exported — tests/render.test.js runs the real load path under a DOM shim');
});
