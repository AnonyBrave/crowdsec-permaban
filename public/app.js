// PermaBan web UI: live cycles from SSE, sortable + filterable grids, one-click Ban/Unban, a per-IP raw JSON
// viewer, hand-drawn SVG charts (no chart library), CSV/JSON export links. Zero dependencies, loaded as an ES module.
import { sortRows, filterRows } from './sort.js';
import { sparkBars, barWidthPct, shortScenario } from './charts.js';

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const n0 = (x) => nf.format(Math.round(x));

let lastCycle = null;
let settings = null;

// Dedicated Blocklists tab: multiple imported lists, each with its own URL, schedule, global grace window, and per-cycle cap.
// `uiLists` is the working rows copy painted by fillSettingsForm from `/api/state`; a real browser keeps live row DOM refs in
// `rowRefs`, so Save reads exactly what the user typed. The offline UI tests run under a minimal shim with no createElement —
// there rendering falls back to innerHTML strings, and collectBlocklists sanitizes `uiLists` directly. Same floors as server.js:
// refresh/cap ≥ 1 (fallbacks 60 / 200), unban grace ≥ 0 (fallback 1440); a row without URL drops at save time. Each row carries its own ban scenario
// (`blocklist/permaban` default).
const BL_DEFAULT = { url: '', enabled: true, banScenario: 'blocklist/permaban', refreshMinutes: 60, unbanMinutes: 1440, capPerCycle: 200 };
let uiLists = [];
let rowRefs = [];

const cleanBlockRow = (r) => {
  const floor = (v, min, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min ? n : def; };
  const str = (v, def) => { const s = String(v ?? '').trim(); return s.length > 0 ? s : def; };
  return {
    url: String(r?.url ?? '').trim(),
    enabled: !!r?.enabled,
    banScenario: str(r?.banScenario, 'blocklist/permaban'),   // per-row scenario, editable in the dedicated tab
    refreshMinutes: floor(r?.refreshMinutes, 1, 60),
    unbanMinutes: floor(r?.unbanMinutes, 0, 1440),
    capPerCycle: floor(r?.capPerCycle, 1, 200),
  };
};

function renderBlockRows() {
  const host = $('blockRows');
  if (!host) return;                                  // static pairing keeps blockRows in index.html; this guard is for exotic shims
  rowRefs = [];
  host.innerHTML = '';
  const realDom = typeof document.createElement === 'function' && typeof host.appendChild === 'function';

  uiLists.forEach((obj, i) => {
    if (realDom) {
      const tr = document.createElement('tr');
      const cell = () => { const td = document.createElement('td'); tr.appendChild(td); return td; };

      const cbx = document.createElement('input'); cbx.type = 'checkbox'; cbx.checked = !!obj.enabled;
      cbx.addEventListener('change', () => { obj.enabled = cbx.checked; });
      cell().appendChild(cbx);

      const url = document.createElement('input'); url.value = String(obj.url ?? ''); url.title = obj.url || 'add a URL (one IP per line is read)';
      url.addEventListener('input', () => { obj.url = url.value.trim(); });
      cell().appendChild(url);

      const scen = document.createElement('input'); scen.value = obj.banScenario || 'blocklist/permaban'; scen.title = 'Ban scenario for this list (default: blocklist/permaban)';
      scen.addEventListener('input', () => { obj.banScenario = scen.value.trim(); });
      cell().appendChild(scen);

      const refresh = document.createElement('input'); refresh.type = 'number'; refresh.min = '1'; refresh.value = obj.refreshMinutes ?? 60;
      refresh.addEventListener('input', () => { obj.refreshMinutes = Math.floor(Number(refresh.value)); });
      cell().appendChild(refresh);

      const unban = document.createElement('input'); unban.type = 'number'; unban.min = '0'; unban.value = obj.unbanMinutes ?? 1440;
      unban.addEventListener('input', () => { obj.unbanMinutes = Math.floor(Number(unban.value)); });
      cell().appendChild(unban);

      const cap = document.createElement('input'); cap.type = 'number'; cap.min = '1'; cap.value = obj.capPerCycle ?? 200;
      cap.addEventListener('input', () => { obj.capPerCycle = Math.floor(Number(cap.value)); });
      cell().appendChild(cap);

      const rm = document.createElement('button'); rm.textContent = '×'; rm.title = 'Remove this list row (saves on Save lists)';
      rm.addEventListener('click', () => { uiLists.splice(i, 1); renderBlockRows(); $('blockMsg').textContent = 'List row removed — press Save lists to apply.'; });
      cell().appendChild(rm);

      host.appendChild(tr);
      rowRefs.push({ cb: cbx, urlInp: url, scenInp: scen, refreshInp: refresh, unbanInp: unban, capInp: cap });
    } else {
      // The Node UI shim has no createElement; tests drive `uiLists` through the exported helpers and inspect innerHTML.
      host.innerHTML += `<tr><td class="bl-enabled"><input type="checkbox"${obj.enabled ? ' checked' : ''} /></td>`
        + `<td class="bl-url">${esc(String(obj.url ?? ''))}</td>`
        + `<td class="bl-scenario">${esc(String(obj.banScenario || 'blocklist/permaban'))}</td>`
        + `<td>${String(obj.refreshMinutes ?? 60)}</td><td>${String(obj.unbanMinutes ?? 1440)}</td><td>${String(obj.capPerCycle ?? 200)}</td>`
        + '<td class="bl-remove"><button>×</button></td></tr>';
    }
  });
}

function addBlockList() {
  uiLists.push(JSON.parse(JSON.stringify(BL_DEFAULT)));   // "+" appends a working row; URL empty drops from the saved settings
  renderBlockRows();
}

// Reads the rows exactly as they stand now: live DOM inputs when there are any, otherwise the working `uiLists` copy.
function collectBlocklists() {
  if (rowRefs.length === 0) return uiLists.map(cleanBlockRow).filter((r) => r.url);
  const live = rowRefs.map((r) => ({ url: r.urlInp.value, enabled: r.cb.checked, banScenario: r.scenInp.value, refreshMinutes: r.refreshInp.value, unbanMinutes: r.unbanInp.value, capPerCycle: r.capInp.value }));
  return live.map(cleanBlockRow).filter((r) => r.url);
}

// ── views ────────────────────────────────────────────────────────────
for (const b of document.querySelectorAll('#sidebar button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#sidebar button')) x.classList.remove('active');
    b.classList.add('active');
    for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
    $(`view-${b.dataset.view}`).classList.add('active');
  });
}

// ── state + stream ───────────────────────────────────────────────────
async function loadState() {
  let s;
  try { s = await fetch('/api/state').then((r) => r.json()); }
  catch (e) { setStatus(false); banner(`Cannot reach the server: ${e.message}`, 'error'); return; }

  settings = s.settings;
  fillSettingsForm(settings);
  $('dataDirLine').textContent = `${s.dataDir} — mode ${s.mode}`;
  renderActivity(s.activity);
  banner(s.storeWarning, 'warn');

  // /api/state answers with the last cycle snapshot, so a page opened between two polls paints cards, charts and grids
  // straight away. Before this, load drew only settings + activity: numbers/sparkline/scenarios stayed empty until the
  // next poll (or a manual "Refresh now") pushed a frame.
  if (s.cycle) renderCycle(s.cycle); else setStatus(undefined);   // no cycle yet → status stays "starting…"
}

const es = new EventSource('/events');
// `hello` carries the same snapshot: a reconnect, or a page that loads after /api/state answered empty, paints on connect.
es.addEventListener('hello', (e) => {
  const d = JSON.parse(e.data);
  if (d.storeWarning) banner(d.storeWarning, 'warn');
  if (d.cycle) renderCycle(d.cycle);   // idempotent: drawing the same snapshot twice changes nothing
});
es.addEventListener('cycle', (e) => { lastCycle = JSON.parse(e.data); renderCycle(lastCycle); });

$('refreshBtn').addEventListener('click', async () => {
  $('refreshBtn').disabled = true;
  const r = await fetch('/api/refresh', { method: 'POST' }).then((x) => x.json());
  $('refreshBtn').disabled = false;
  if (r.candidates) renderCycle(r); else banner(r.error ?? 'cycle failed', 'error');
});

// ── master auto-ban switch: applies instantly, no Save ───────────────
$('autoBanToggle').addEventListener('change', async () => {
  const r = await fetch('/api/autoban', { method: 'POST', body: JSON.stringify({ enabled: $('autoBanToggle').checked }) }).then((x) => x.json());
  settings.autoBanEnabled = r.autoBanEnabled;
  $('fAutoBan').checked = r.autoBanEnabled;
  if (r.storeWarning) banner(r.storeWarning, 'warn');
});

// ── grids: one sort key + filter text each. Defaults match the server's own order.
// `keys` is one field per row: `_s`, the searchable text built by searchRow() below — every column the grid shows,
// exactly as the page renders it (grouped numbers and `dd/mm/yyyy, hh:mm:ss` dates included), so typing what you can see matches.
const grids = {
  candidatesGrid: { rows: [], key: 'score', dir: -1, text: '', filter: 'filterCandidates', body: 'candidateRows', keys: ['_s'] },
  bannedGrid: { rows: [], key: 'createdAt', dir: -1, text: '', filter: 'filterBanned', body: 'bannedRows', keys: ['_s'] },
};

// Filter first (cheap), then sort the surviving rows — `sortRows` is stable, so ties keep the server's ranking.
function renderGrid(name) {
  const g = grids[name];
  const visible = sortRows(filterRows(g.rows, g.text, g.keys), g.key, g.dir);
  $(g.body).innerHTML = visible.map((x) => name === 'candidatesGrid' ? rowCandidate(x) : rowBanned(x)).join('');
  for (const th of document.querySelectorAll(`#${name} th[data-key]`))
    th.querySelector('.ind').textContent = th.dataset.key === g.key ? (g.dir < 0 ? ' ▼' : ' ▲') : '';
  wireButtons();
}

for (const name of Object.keys(grids)) {
  for (const th of document.querySelectorAll(`#${name} th[data-key]`)) {
    const label = th.textContent;   // headers are static: wrap once, then listen
    th.innerHTML = `<span>${label}</span><span class="ind"></span>`;
    th.addEventListener('click', () => {
      const g = grids[name];
      if (g.key === th.dataset.key) g.dir = -g.dir;
      else { g.key = th.dataset.key; g.dir = th.hasAttribute('data-numeric') ? -1 : 1; }   // numbers start high-first, text low-first
      renderGrid(name);
    });
  }

  $(grids[name].filter).addEventListener('input', () => {
    grids[name].text = $(grids[name].filter).value;
    renderGrid(name);
  });
}

// ── rendering ────────────────────────────────────────────────────────
// A crashing section must not take the rest of the page down with it: an unimported name, a shape change in a snapshot —
// everything after the throw silently stops rendering (blank chart + empty rows). Each card gets its own guard.
function guard(hostId, fn) {
  try { fn(); }
  catch (e) {
    console.error(`UI: ${hostId} failed to render`, e);
    const host = $(hostId);
    const svgish = (host.namespaceURI ?? '').includes('svg');   // donut + sparkline are <svg>, the rows are <div>s
    host.innerHTML = svgish
      ? `<text x="8" y="16" class="val">chart unavailable: ${esc(e.message)}</text>`
      : `<div class="hint muted">failed to render — ${esc(e.message)}</div>`;
  }
}

function renderCycle(c) {
  setStatus(c.connected);
  if (!c.candidates) { if (c.error) banner(c.error, 'error'); return; }

  $('statTotal').textContent = n0(c.totalEvents);
  $('statCandidates').textContent = c.candidates.length;
  $('statBanned').textContent = c.banned.length;
  // Lifetime count (persisted in `state.json`, restored on load) as the card's number, this cycle underneath: a page
  // opened after quiet cycles shows what the app has issued over time, and reloads never wipe it.
  $('statIssuedTotal').textContent = c.autoBansTotal ?? c.autoBansIssued;
  $('statIssued').textContent = c.autoBansIssued;
  // The imported list keeps its own counters: what it owns right now, and what this cycle added / unbanned. A cycle
  // that skipped the fetch reports the tracked number from the store, so the card never goes blank between refreshes.
  $('statBlockTotal').textContent = c.blocklistTracked ?? 0;
  $('statBlockAdded').textContent = c.blocklistAdded ?? 0;
  $('statBlockUnbanned').textContent = c.blocklistUnbanned ?? 0;

  guard('donut', () => renderDonut(c.dashboard.bannedIps, c.dashboard.recidivistBannedIps));
  guard('sparkline', () => renderSparkline(c.dashboard.dailyEvents));
  guard('topScenarios', () => renderBars($('topScenarios'), c.dashboard.topScenarios.map((s) => { const t = shortScenario(s.name); return [t.name, s.events, null, t.full]; })));
  guard('topCountries', () => renderBars($('topCountries'), c.dashboard.topCountries.map((s) => [s.name, s.events, s.bans])));

  grids.candidatesGrid.rows = c.candidates.map((c) => ({ ...c, _s: searchCandidate(c) }));
  grids.bannedGrid.rows = c.banned.map((b) => ({ ...b, _s: searchBanned(b) }));
  renderGrid('candidatesGrid');
  renderGrid('bannedGrid');
  $('bannedBanner').textContent = `${c.banned.length} active ban decision(s); ${new Set(c.banned.map((b) => b.ip)).size} unique IP(s).`;

  renderActivity(lastActivity);
}

function setStatus(connected) {
  const s = $('status');
  if (connected === undefined) { s.textContent = 'starting…'; s.className = 'status dim'; }
  else if (connected) { s.textContent = 'Connected'; s.className = 'status ok'; }
  else { s.textContent = 'Disconnected'; s.className = 'status bad'; }
}

const ipCell = (ip) => `<span class="ip" data-profile="${esc(ip)}" title="Show the stored events and raw JSON for ${esc(ip)}">${esc(ip)}</span>`;

function rowCandidate(c) {
  const verdictClass = c.action === 'auto-ban' ? 'ban' : c.action === 'suggest' ? 'sug' : 'none';
  const action = c.action === 'auto-ban'
    ? (c.autoBannedByApp ? '<span class="tag">banned by app</span>' : '<span class="tag ban">will auto-ban</span>')
    : c.action === 'suggest' ? `<span class="tag sug">suggested</span>` : '';
  const ban = c.action !== 'none' && !c.autoBannedByApp
    ? `<button class="mini" data-ban="${esc(c.ip)}" data-score="${c.score}">Ban now</button>` : '';
  return `<tr>
    <td>${ipCell(c.ip)}</td><td>${esc(c.country || '')}</td><td class="num">${n0(c.score)}</td>
    <td class="num">${n0(c.eventCount)}</td><td class="num">${c.scenarioCount}</td><td class="num">${c.banCount}</td>
    <td>${fmtTs(c.firstSeen)}</td><td>${fmtTs(c.lastSeen)}</td>
    <td class="verdict ${verdictClass}" title="${esc(c.reason)}">${esc(shortReason(c.reason))} ${action}</td>
    <td class="actions">${ban}</td></tr>`;
}

function rowBanned(b) {
  return `<tr>
    <td>${ipCell(b.ip)}</td><td>${esc(b.country || '')}</td><td>${esc(b.scenario)}</td><td>${esc(b.origin)}</td>
    <td class="num">${n0(b.events)}</td><td class="num">${b.bans}</td><td class="num">${n0(b.score)}</td>
    <td>${fmtTs(b.createdAt)}</td><td>${fmtTs(b.expiresAt)}</td>
    <td>${b.autoBannedByApp ? '<span class="tag">by app</span>' : ''}</td>
    <td class="actions"><button class="mini" data-unban="${b.id}">Unban</button></td></tr>`;
}

// The filter box matches a row by the text the page actually shows for it: every column's raw value **and** its
// displayed form (grouped numbers, `dd/mm/yyyy, hh:mm:ss` dates), plus the verdict tag words. So `3499`, `3,499`,
// `2026-11-05` and `05/11/2026, 10:00:00` all find their row — that is what made "filter by events/score/created/expires"
// answer empty.
const rowWords = (parts) => parts.flat().map((v) => String(v ?? '')).join(' ');

function searchCandidate(c) {
  const tag = c.action === 'auto-ban' ? (c.autoBannedByApp ? 'banned by app' : 'will auto-ban')
    : c.action === 'suggest' ? 'suggested' : '';
  return rowWords([c.ip, c.country, [c.score, n0(c.score)], [c.eventCount, n0(c.eventCount)],
    [c.scenarioCount, n0(c.scenarioCount)], [c.banCount, n0(c.banCount)],
    [c.firstSeen, fmtTs(c.firstSeen)], [c.lastSeen, fmtTs(c.lastSeen)], c.reason, tag]);
}

function searchBanned(b) {
  return rowWords([b.ip, b.country, b.scenario, b.origin, [b.events, n0(b.events)], [b.bans, n0(b.bans)],
    [b.score, n0(b.score)], [b.createdAt, fmtTs(b.createdAt)], [b.expiresAt, fmtTs(b.expiresAt)],
    b.autoBannedByApp ? 'by app' : '']);
}

function shortReason(r) { return r.length > 70 ? r.slice(0, 69) + '…' : r; }

function wireButtons() {
  document.querySelectorAll('[data-ban]').forEach((b) => b.addEventListener('click', async () => {
    const r = await fetch('/api/ban', { method: 'POST', body: JSON.stringify({ ip: b.dataset.ban, score: Number(b.dataset.score ?? 0) }) }).then((x) => x.json());
    banner(r.ok ? `Banned ${b.dataset.ban}` : `Ban failed: ${r.message}`, r.ok ? 'ok' : 'error');
    if (r.cycle) renderCycle(r.cycle);
  }));
  document.querySelectorAll('[data-unban]').forEach((b) => b.addEventListener('click', async () => {
    const r = await fetch('/api/unban', { method: 'POST', body: JSON.stringify({ decisionId: Number(b.dataset.unban) }) }).then((x) => x.json());
    banner(r.ok ? `Unbanned decision ${b.dataset.unban} (${r.deleted} removed)` : `Unban failed: ${r.message}`, r.ok ? 'ok' : 'error');
    if (r.cycle) renderCycle(r.cycle);
  }));
  document.querySelectorAll('[data-profile]').forEach((el) => el.addEventListener('click', () => openProfile(el.dataset.profile)));
}

// ── per-IP profile: stored events with the full raw JSON we kept ─────
async function openProfile(ip) {
  const r = await fetch(`/api/profile?ip=${encodeURIComponent(ip)}`).then((x) => x.json());
  $('profileTitle').textContent = ip;
  const p = r.profile;
  $('profileSummary').textContent = p
    ? `${p.country || 'unknown country'} · score ${n0(p.score)} · events ${n0(p.eventCount)} · scenarios ${p.scenarioCount}` +
      ` · bans ${p.banCount} · first ${fmtTs(p.firstSeen)} · last ${fmtTs(p.lastSeen)}` +
      (r.autoBannedByApp ? ' · banned by app' : '') + ` (${r.events.length} stored event(s))`
    : 'nothing stored for this IP';
  $('profileRaw').textContent = r.events.map((e) =>
    `${e.kind === 'alert' ? 'ALERT' : 'DECISION'} #${e.id} ${fmtTs(e.ts)}\n${JSON.stringify(e.raw, null, 2)}`).join('\n\n');
  $('profileModal').classList.remove('hidden');
}

$('closeProfile').addEventListener('click', () => $('profileModal').classList.add('hidden'));
$('profileModal').addEventListener('click', (e) => { if (e.target === $('profileModal')) $('profileModal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('profileModal').classList.add('hidden'); });

// ── charts, drawn by hand so numbers never clip at any width ─────────
function renderDonut(total, recidivist) {
  const svg = $('donut');
  const frac = total > 0 ? recidivist / total : 0;
  const R = 62, r = 40, cx = 75, cy = 75, a = frac * 2 * Math.PI;
  const arc = (start, end, fill) => {
    const x1 = cx + R * Math.cos(start), y1 = cy + R * Math.sin(start);
    const x2 = cx + R * Math.cos(end), y2 = cy + R * Math.sin(end);
    const big = end - start > Math.PI ? 1 : 0;
    return `<path d="M ${x1} ${y1} A ${R} ${R} 0 ${big} 1 ${x2} ${y2} L ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} A ${r} ${r} 0 ${big} 0 ${cx + r * Math.cos(start)} ${cy + r * Math.sin(start)} Z" fill="${fill}" />`;
  };
  svg.innerHTML = arc(0, a, '#e8710a') + (frac < 1 ? arc(a, 2 * Math.PI, '#3a3f46') : '')
    + `<text x="75" y="70" class="cx">${Math.round(frac * 100)}%</text>`
    + `<text x="75" y="88" class="cx2">recidivist</text>`;
  $('donutLegend').innerHTML = `<span class="lg sw-rec"></span>${recidivist} of ${total} banned IPs have ≥ 2 stored bans`;
}

// The events-per-day geometry is pure (`public/charts.js`); here we add en-US numbers to it and join SVG strings.
// The axis line spans the box the module itself declares — reading `chart.viewBox` keeps this file dependent only on
// what its import statement actually brings in (a name used without importing throws ReferenceError in the browser).
function renderSparkline(daily) {
  const svg = $('sparkline');
  const chart = sparkBars(daily.map((d) => ({ ...d, eventsLabel: n0(d.events) })));
  svg.setAttribute('viewBox', chart.viewBox);   // same box as index.html — the wrapper is a cross-check
  const viewW = Number(chart.viewBox.split(' ')[2]);   // '0 0 560 92' → width of the drawing band
  svg.innerHTML = [
    `<line x1="4" y1="${chart.axisBaseline}" x2="${viewW - 4}" y2="${chart.axisBaseline}" class="base"/>`,
    ...chart.bars.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${b.fill}" rx="1.5"/>`),
    ...chart.labels.map((t) => `<text x="${t.x}" y="${t.y}" class="val">${esc(t.label)}</text>`),
    ...chart.dateLabels.map((t) => `<text x="${t.x}" y="${t.y}" class="ax">${esc(t.label)}</text>`),
  ].join('');
}

// ── bar rows: labels shortened (crowdsecurity/ prefix stripped, full name in the tooltip), sqrt-compressed
// bar heights live in public/charts.js; `full` is the untouched scenario name for topScenarios.
function renderBars(host, rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  host.innerHTML = rows.length === 0 ? '<div class="hint muted">no data yet</div>' : rows.map(([name, v, bans], i) => {
    const full = rows[i][3];   // topScenarios carries the original name; countries have none to restore
    const width = barWidthPct(v, max).toFixed(1);
    return `<div class="bar"><span class="lbl" title="${esc(full ?? name)}">${esc(name)}</span>
       <span class="track"><span style="width:${width}%"></span></span>
       <b>${n0(v)}</b>${bans !== null && bans !== undefined ? `<span class="bans">${n0(bans)} banned</span>` : ''}</div>`;
  }).join('');
}

// ── activity log ─────────────────────────────────────────────────────
let lastActivity = [];
function renderActivity(list) {
  if (list) lastActivity = list;
  $('activityLog').innerHTML = lastActivity.map((a) =>
    `<div class="line ${a.kind}"><span class="ts">${fmtTs(a.at)}</span>${esc(a.line)}</div>`).join('');
}

function banner(text, kind) {
  const b = $('banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.className = `banner ${kind}`;
  b.textContent = text;
}

// ── settings form ────────────────────────────────────────────────────
function fillSettingsForm(s) {
  $('fBaseUrl').value = s.baseUrl; $('fUser').value = s.username; $('fPass').value = s.password;
  $('fPoll').value = s.pollIntervalSeconds; $('fRet').value = s.historyRetentionDays;
  $('fDur').value = s.permanentDuration; $('fPrefix').value = s.banReasonPrefix; $('fScenario').value = s.banScenario;
  $('fAutoBan').checked = s.autoBanEnabled; $('autoBanToggle').checked = s.autoBanEnabled;
  $('fGate').checked = s.scoring.safeCountryBanEnabled;
  $('fScoreGate').value = s.scoring.safeCountryBanScore;
  $('fSafe').value = (s.safeCountries ?? []).join(', ');
  $('fRecT').value = s.scoring.recidivistBanThreshold;
  $('fAgEvT').value = s.scoring.aggressiveEventThreshold;
  $('fAgScT').value = s.scoring.aggressiveScenarioThreshold;
  $('fEvW').value = s.scoring.eventWeight; $('fScW').value = s.scoring.scenarioWeight; $('fBanW').value = s.scoring.banWeight;
  $('fNotify').checked = s.notificationsEnabled !== false;
  $('fWebhook').value = s.notifyWebhookUrl ?? '';
  $('fNotifyFmt').value = s.notifyFormat === 'json' ? 'json' : 'text';
  // Working rows for the dedicated Blocklists tab, painted from `/api/state` settings — canonical floors/URLs as saved.
  uiLists = (s.blocklists ?? []).map(cleanBlockRow);
  renderBlockRows();
  updateHints();
}

function collectForm() {
  const num = (id, fallback) => { const v = Number($(id).value); return Number.isFinite(v) ? v : fallback; };
  return {
    baseUrl: $('fBaseUrl').value.trim(), username: $('fUser').value, password: $('fPass').value,
    pollIntervalSeconds: num('fPoll', settings.pollIntervalSeconds),
    historyRetentionDays: num('fRet', settings.historyRetentionDays),
    permanentDuration: $('fDur').value.trim() || settings.permanentDuration,
    banReasonPrefix: $('fPrefix').value.trim(), banScenario: $('fScenario').value.trim(),
    autoBanEnabled: $('fAutoBan').checked, notificationsEnabled: $('fNotify').checked,
    notifyWebhookUrl: $('fWebhook').value.trim(), notifyFormat: $('fNotifyFmt').value === 'json' ? 'json' : 'text',
    blocklists: collectBlocklists(),   // dedicated tab rows as collected (canonical floors; URL-empty rows drop server-side too)
    safeCountries: $('fSafe').value.split(',').map((c) => c.trim()).filter(Boolean),
    scoring: {
      recidivistBanThreshold: num('fRecT', settings.scoring.recidivistBanThreshold),
      aggressiveEventThreshold: num('fAgEvT', settings.scoring.aggressiveEventThreshold),
      aggressiveScenarioThreshold: num('fAgScT', settings.scoring.aggressiveScenarioThreshold),
      eventWeight: num('fEvW', settings.scoring.eventWeight),
      scenarioWeight: num('fScW', settings.scoring.scenarioWeight),
      banWeight: num('fBanW', settings.scoring.banWeight),
      safeCountryBanEnabled: $('fGate').checked,
      safeCountryBanScore: num('fScoreGate', settings.scoring.safeCountryBanScore),
    },
  };
}

function updateHints() {
  const gate = $('fGate').checked, score = Number($('fScoreGate').value) || 0;
  $('gateSummary').textContent = !gate
    ? 'Safe list is ABSOLUTELY protected: the threshold is ignored, safe countries are never auto-banned.'
    : `Safe-list protection relative to composite score ${n0(score)} (safe country banned permanently at/above it).`;

  const ev = Number($('fEvW').value), sc = Number($('fScW').value), bn = Number($('fBanW').value);
  $('formulaPreview').textContent = `score = events × ${ev} + scenarios × ${sc} + bans × ${bn}`;
}
['fGate', 'fScoreGate', 'fEvW', 'fScW', 'fBanW'].forEach((id) => $(id).addEventListener('input', updateHints));

$('addBlockListBtn').addEventListener('click', () => { addBlockList(); $('blockMsg').textContent = '+ Add list: fill the URL, set schedule/grace/cap, then Save lists.'; });

async function submitSettings(form) {
  const r = await fetch('/api/settings', { method: 'POST', body: JSON.stringify(form) }).then((x) => x.json());
  if (r.ok) { settings = form; uiLists = form.blocklists.map(cleanBlockRow); renderBlockRows(); }   // working rows reflect the saved canonical floors/URLs
  return r;
}

$('saveBtn').addEventListener('click', async () => {
  const r = await submitSettings(collectForm());
  $('settingsMsg').textContent = r.ok ? 'Settings applied.' : `Save failed: ${r.message}`;
  if (r.storeWarning) banner(r.storeWarning, 'warn');
});

$('blockSaveBtn').addEventListener('click', async () => {
  const r = await submitSettings(collectForm());
  $('blockMsg').textContent = r.ok ? `Saved ${settings.blocklists.length} list row(s).` : `Save failed: ${r.message}`;
  if (r.storeWarning) banner(r.storeWarning, 'warn');
});

$('testBtn').addEventListener('click', async () => {
  const r = await fetch('/api/test', { method: 'POST' }).then((x) => x.json());
  $('settingsMsg').textContent = r.ok ? `Connection to ${settings.baseUrl} is live.` : `Test failed: ${r.message}`;
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Timestamps render in one fixed form: `dd/mm/yyyy, hh:mm:ss` built by hand from the Date's local fields. A locale call
// (`toLocaleString('en-GB', …)`) varies its separator and digits between ICU versions (a Node 20 runner prints U+202F where a
// browser prints a space), so what the page shows — and therefore what the filter box can match — would not be stable.
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTs = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}, ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

loadState();

// Named exports for the offline UI tests (`tests/render.test.js`, `tests/grid.test.js`): they execute this exact file under a minimal DOM shim in
// Node, so the render path a browser runs is verified without a browser — charts, stripped scenario labels, guard hints, grid sorting + filter matching,
// and now the dedicated Blocklists tab rows (+ Add list / collect). `loadState` is exported too: a fresh page must paint from `/api/state` alone (no SSE frame,
// no "Refresh now" click) — including fillSettingsForm painting the working rows from `/api/state` settings.
// The page itself loads app.js as an ES module and ignores these; zero dependencies stay.
export { renderCycle, guard, loadState, searchCandidate, searchBanned, fillSettingsForm, collectBlocklists, addBlockList, renderBlockRows };
