// Pipeline tests against a mock source, mirroring PipelineService semantics: baseline on the first run,
// auto-ban issued for foreign recidivists via the executor, banned IPs leaving the candidate list, the store
// guard against double bans, and the reconcile pass clearing app-ban state after an external unban.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../core/store.js';
import { Pipeline } from '../core/pipeline.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perma-pipe-'));
const settings = (over = {}) => ({
  baseUrl: 'http://mock', username: 'u', password: 'p', pollIntervalSeconds: 60, webUiLookbackHours: 168,
  safeCountries: ['FR'], autoBanEnabled: true, permanentDuration: '876000h', banScenario: 'manual/web-ui',
  banReasonPrefix: 'permaban', historyRetentionDays: 90, notificationsEnabled: true, initialized: false,
  blocklists: [],   // dedicated-tab rows are the canonical schema; fixture helpers set arrays below, harness fetcher injects list text offline
  scoring: { recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2,
    eventWeight: 1, scenarioWeight: 100, banWeight: 500, safeCountryBanEnabled: true, safeCountryBanScore: 2500 },
  ...over,
});

const alert = (id, ip, eventsCount, scenario, ts, country) =>
  ({ source: 'crowdsec', kind: 'alert', id, ip, ts, country, scenario, eventsCount });
const banDecision = (id, ip, ts, { expired = false, country = '' } = {}) =>
  ({ source: 'crowdsec', kind: 'decision', id, ip, ts, decisionType: 'ban', decisionAction: 'ban', expired, country });

function mockSource(events) {
  const calls = [];
  return {
    calls,
    setEvents: (e) => { events = e; },
    async fetchEvents() { return events.map((e) => ({ ...e })); },
    async ban(ip, duration, reason, scenario) { calls.push({ ip, duration, reason, scenario }); return { success: true, message: 'Decision added', ids: '1' }; },
    async unban(id) { calls.push({ unban: id }); return { success: true, message: 'Decision removed', deleted: 1 }; },
  };
}

// `fetcher` is the imported-list seam (async url → list text); when it throws, the pipeline logs and keeps its state.
function harness(initialEvents, over = {}, fetcher = async () => '') {
  const dir = tempDir();
  const store = EventStore.open(dir);
  const s = settings(over);
  const logs = [], notices = [];
  const source = mockSource(initialEvents);
  const p = new Pipeline({ getSettings: () => s, store, source, log: (l) => logs.push(l), blockFetcher: fetcher });
  p.notifier = (title, body) => notices.push(`${title}: ${body}`);
  return { dir, store, settings: s, pipeline: p, source, logs, notices };
}

// A foreign recidivist with no active ban: three expired bans + 50 events → candidate, score 1650.
const seeds = (ip = '1.2.3.4', country = 'US') => [
  alert(1, ip, 50, 'ssh-bf', '2026-11-05T09:00:00.000Z', country),
  banDecision(11, ip, '2026-11-03T09:00:00.000Z', { expired: true }),
  banDecision(12, ip, '2026-11-02T09:00:00.000Z', { expired: true }),
  banDecision(13, ip, '2026-11-01T09:00:00.000Z', { expired: true }),
];

test('FirstRun_BaselineNoNotify_AndAutoBansForeignRecidivist', async () => {
  const h = harness(seeds());

  const r = await h.pipeline.runCycle();

  // Score 50×1 + 1×100 + 3×500 = 1650, recidivist; foreign → auto-ban issued with the settings' duration/prefix.
  assert.equal(r.autoBansIssued, 1);
  assert.deepEqual(h.source.calls[0], { ip: '1.2.3.4', duration: '876000h',
    reason: 'permaban: recidivist (3 bans)', scenario: 'manual/web-ui' });
  assert.ok(h.store.isAutoBanned('1.2.3.4'));
  // The card reads the lifetime counter, not this cycle's number: a page opened after idle cycles shows what has been
  // issued all along (`state.json`), so an indicator can never read 0 on reload.
  assert.equal(r.autoBansIssued, 1);
  assert.equal(r.autoBansTotal, 1);
  assert.equal(r.candidates[0].action, 'auto-ban');

  // First run records the baseline silently (no notification storm).
  assert.equal(h.settings.initialized, true);
  assert.deepEqual(h.notices.filter((n) => n.startsWith('PermaBan — new candidate(s)')), []);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('SecondRun_NoDoubleBan_AndBannedIpLeavesTheCandidateList', async () => {
  const h = harness(seeds());

  await h.pipeline.runCycle();                       // cycle 1 issues the permanent ban
  assert.equal(h.source.calls.length, 1);

  // Cycle 2: the Web UI lists the new active decision → the IP is in the Banned view, not a candidate, and the
  // store guard means no second POST.
  h.source.setEvents([...seeds(), banDecision(100, '1.2.3.4', new Date().toISOString(), { country: 'US' })]);
  const r2 = await h.pipeline.runCycle();
  assert.ok(!r2.candidates.some((c) => c.ip === '1.2.3.4'));
  assert.ok(r2.banned.some((b) => b.ip === '1.2.3.4' && b.autoBannedByApp));
  assert.equal(h.source.calls.length, 1);

  // The ban expires on the Web UI: the liveness sync marks it expired, so the recidivist re-enters the candidate
  // list (already app-banned → no POST this cycle), and the reconcile pass clears the app state.
  h.source.setEvents([...seeds(), banDecision(100, '1.2.3.4', new Date().toISOString(), { expired: true })]);
  const r3 = await h.pipeline.runCycle();
  assert.ok(r3.candidates.some((c) => c.ip === '1.2.3.4'));          // candidate again once the ban is gone
  assert.equal(h.source.calls.length, 1);                            // store guard: still one POST total
  assert.ok(h.logs.some((l) => l.includes('unbanned externally')));

  const r4 = await h.pipeline.runCycle();                            // state cleared → permanent ban issued again
  assert.equal(r4.autoBansIssued, 1);
  assert.equal(h.source.calls.length, 2);

  // The lifetime count is the number the card shows: idle cycles keep it steady, a re-issued ban counts as a fresh
  // issuance, and reopening the store (the next launch) reads exactly the same value from `state.json`.
  assert.equal(r2.autoBansTotal, 1);
  assert.equal(r3.autoBansTotal, 1);
  assert.equal(r4.autoBansTotal, 2);
  const reopened = EventStore.open(h.dir);
  assert.equal(reopened.autoBansTotal(), 2);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('ExternalUnban_ClearsTheAppBanState', async () => {
  const h = harness(seeds('5.6.7.8', 'DE'));

  await h.pipeline.runCycle();                       // app-bans the recidivist and records it
  assert.ok(h.store.isAutoBanned('5.6.7.8'));
  assert.equal(h.source.calls.length, 1);

  // The Web UI lists no decision for that IP any more (unbanned on the server) → reconcile must drop the state.
  h.source.setEvents([alert(1, '5.6.7.8', 10, 's', '2026-11-04T09:00:00.000Z', 'DE')]);
  await h.pipeline.runCycle();
  assert.ok(!h.store.isAutoBanned('5.6.7.8'));
  assert.ok(h.logs.some((l) => l.includes('unbanned externally')));

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('SafeCountryBelowGate_IsSuggestedNotBanned', async () => {
  const h = harness([
    alert(1, '9.9.9.9', 300, 's/one', '2026-11-04T09:00:00.000Z', 'FR'),
    alert(2, '9.9.9.9', 200, 's/two', '2026-11-05T09:00:00.000Z', 'FR'),
    banDecision(30, '9.9.9.9', '2026-11-01T09:00:00.000Z', { expired: true }),
    banDecision(31, '9.9.9.9', '2026-11-02T09:00:00.000Z', { expired: true }),
    banDecision(32, '9.9.9.9', '2026-11-03T09:00:00.000Z', { expired: true }),
  ]);

  const r = await h.pipeline.runCycle();
  const c = r.candidates.find((x) => x.ip === '9.9.9.9');
  assert.ok(c);                                       // recidivist, score 500 + 200 + 1500 = 2200 < gate 2500
  assert.equal(c.action, 'suggest');
  assert.match(c.reason, /safe country \(FR\), score 2,200 < 2,500/);
  assert.equal(h.source.calls.length, 0);             // nothing banned on the server

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('SafeCountryAtGate_IsBannedLikeAnyForeigner', async () => {
  const h = harness([
    alert(1, '6.6.6.6', 2000, 's/a', '2026-11-04T09:00:00.000Z', 'FR'),
    alert(2, '6.6.6.6', 2000, 's/b', '2026-11-05T09:00:00.000Z', 'FR'),   // 4000 events + 2 scenarios
    banDecision(40, '6.6.6.6', '2026-11-03T09:00:00.000Z', { expired: true }),
    banDecision(41, '6.6.6.6', '2026-11-04T09:00:00.000Z', { expired: true }),   // score 4000 + 200 + 1500 = 5700 ≥ gate
    banDecision(42, '6.6.6.6', '2026-11-05T09:00:00.000Z', { expired: true }),
  ]);

  const r = await h.pipeline.runCycle();
  const c = r.candidates.find((x) => x.ip === '6.6.6.6');
  assert.equal(c.action, 'auto-ban');
  assert.match(c.reason, /safe-country threshold 2,500/);
  assert.equal(h.source.calls.length, 1);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('MasterSwitchOff_NoBanIsIssuedEvenAboveTheGate', async () => {
  const h = harness([
    alert(1, '8.7.6.5', 2000, 's/a', '2026-11-04T09:00:00.000Z', 'FR'),
    alert(2, '8.7.6.5', 2000, 's/b', '2026-11-05T09:00:00.000Z', 'FR'),   // clears the safe-country gate with room to spare
    banDecision(40, '8.7.6.5', '2026-11-03T09:00:00.000Z', { expired: true }),
    banDecision(41, '8.7.6.5', '2026-11-04T09:00:00.000Z', { expired: true }),
    banDecision(42, '8.7.6.5', '2026-11-05T09:00:00.000Z', { expired: true }),
  ], { autoBanEnabled: false });

  const r = await h.pipeline.runCycle();
  const c = r.candidates.find((x) => x.ip === '8.7.6.5');
  assert.equal(c.action, 'suggest');
  assert.match(c.reason, /auto-ban disabled/);
  assert.equal(h.source.calls.length, 0);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

// ── imported lists (dedicated tab rows): ban on arrival, per-URL schedules/ownership, union removal windows, unban by the live decision id ───────
const listRow = (rowOver = {}) => ({ url: 'https://example.test/list', enabled: true, banScenario: 'blocklist/permaban', refreshMinutes: 60, unbanMinutes: 1440, capPerCycle: 200, ...rowOver });
// Canonical rows. Tests drive immediate refetches through `state.json` stamps (same URL) — a restart-resumed schedule key is the URL, not the row object.
const listSettings = (rowOver = {}) => settings({ blocklists: [listRow(rowOver)] });

test('BlocklistFirstRun_BansEveryListedIp_AndCountsTheLifetimeTotal', async () => {
  const fetchCalls = [];
  const h = harness([], listSettings(), async (url) => {
    fetchCalls.push(url);
    return `# header comment\n198.51.100.4   # CN AS1234 owner\n5.6.7.8\nbogus line\n172.20.1.5   # private → dropped`;
  });

  const r = await h.pipeline.runCycle();

  // Every public IP in the list gets a permanent ban with the app's duration/prefix/scenario; the comment tail, header
  // lines, and the private address are ignored. Bans share the lifetime counter with rule auto-bans: total 2.
  assert.equal(r.blocklistAdded, 2);
  assert.equal(r.blocklistTracked, 2);
  assert.deepEqual(h.source.calls.map((c) => c.ip), ['198.51.100.4', '5.6.7.8']);
  // The ban uses this row's own scenario, not the global auto-ban `manual/web-ui`.
  assert.equal(h.source.calls[0].scenario, 'blocklist/permaban');
  assert.equal(r.autoBansIssued, 2);
  assert.equal(r.autoBansTotal, 2);
  assert.match(h.source.calls[0].reason, /^permaban: imported blocklist$/);

  // The dedicated Blocklists tab gets its own per-URL detail for this cycle (schedule stamp + added/unbanned), not just the global totals.
  const d = r.blocklists.find((x) => x.url === 'https://example.test/list');
  assert.ok(d && typeof d.syncAt === 'string' && d.syncAt, `per-URL detail has no schedule stamp: ${JSON.stringify(r.blocklists)}`);
  assert.equal(d.skip, null);
  assert.deepEqual([d.added, d.unbanned], [2, 0]);

  // The first cycle is baseline: bans are logged and counted, notifications stay quiet (same rule as every candidate).
  assert.ok(h.logs.some((l) => l.includes('BLOCKLIST-BANNED 198.51.100.4')));
  assert.equal(fetchCalls.length, 1);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('ReadOnlyCycle_ScoresTheFrozenHistory_AndRecordsNothing', async () => {
  const h = harness(seeds());

  const first = await h.pipeline.runCycle();          // read-write cycle: history + auto-ban recorded
  assert.equal(first.newEvents, 4);
  const total = h.store.totalEvents();

  h.store.readOnly = true;                            // simulate the blocked data folder for this launch
  const r2 = await h.pipeline.runCycle();
  assert.equal(r2.newEvents, 0);                      // every store write is a silent no-op
  assert.equal(r2.totalEvents, total);                // the frozen history still scores everything
  assert.ok(r2.connected);                            // read-only mode keeps polling normally

  const c = r2.candidates.find((x) => x.ip === '1.2.3.4');
  assert.ok(c && c.autoBannedByApp);                  // the app-ban state loaded from disk blocks a second POST
  assert.equal(r2.autoBansIssued, 0);
  assert.equal(h.source.calls.length, 1);             // cycle 1 issued exactly one ban

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('BlocklistSchedule_RefreshesOnlyWhenDue_AndUnbansAfterTheConfiguredWindow', async () => {
  const fetchCalls = [];
  const URL_A = 'https://example.test/list';
  const L1 = '# list\n198.51.100.4\n5.6.7.8';
  const h = harness([], listSettings(), async (url) => {
    fetchCalls.push(url);
    return fetchCalls.length === 1 ? L1 : '198.51.100.4';   // cycle 3: the URL is refreshed again and no longer lists 5.6.7.8
  });

  await h.pipeline.runCycle();                                  // cycle 1: both IPs banned, schedule stamped under URL_A
  assert.equal(fetchCalls.length, 1);

  // The live Web UI now lists the two decisions — this is what an unban-by-id lookup reads.
  h.source.setEvents([
    banDecision(100, '198.51.100.4', new Date().toISOString()),
    banDecision(101, '5.6.7.8', new Date().toISOString()),
  ]);

  const r2 = await h.pipeline.runCycle();                       // same URL, window not elapsed → no download
  assert.equal(r2.blocklistSkip, 'not due');
  assert.equal(r2.blocklistAdded, 0);
  assert.equal(r2.blocklistUnbanned, 0);
  assert.equal(fetchCalls.length, 1);

  // Force the URL's own stamp in `state.json` into the past and open its grace window to 0 minutes: a real refreshed listing missing an IP
  // starts (and completes) the global absence pass in the same cycle. Union rule: this is the only refreshing row, so its 0-minute delay applies.
  h.settings.blocklists[0].unbanMinutes = 0;
  h.store.setListSync(URL_A, '2020-01-01T00:00:00.000Z');
  const r3 = await h.pipeline.runCycle();
  assert.equal(fetchCalls.length, 2);
  assert.equal(r3.blocklistAdded, 0);                             // 198.51.100.4 is already banned and tracked → nothing to do
  assert.equal(r3.blocklistUnbanned, 1);                          // window is 0 minutes: immediate unban
  assert.ok(h.source.calls.some((c) => c.unban === 101));         // deleted by the decision id live in the store
  assert.equal(h.store.blockEntry('5.6.7.8'), undefined);         // every refreshing URL's ownership dropped
  assert.ok(!h.store.isAutoBanned('5.6.7.8'));                    // the app-ban flag drops with it
  assert.equal(r3.blocklistTracked, 1);

  const r4 = await h.pipeline.runCycle();                         // same URL again → schedule-gated: no third fetch
  assert.equal(r4.blocklistSkip, 'not due');
  assert.equal(fetchCalls.length, 2);
  assert.ok(h.logs.some((l) => l.includes('BLOCKLIST-UNBANNED 5.6.7.8')));

  fs.rmSync(h.dir, { recursive: true, force: true });
});

// The cap keeps one cycle's API load bounded on a big list; the remainder lands on the next real fetch. Each URL owns its own cap, and entries
// already tracked (and present) are skipped — presence bookkeeping is free, cap gates network bans/unbans. Tests force the immediate refetch by
// moving that URL's schedule stamp in `state.json` into the past, the same mechanism a restart/next-cycle uses for a row whose interval elapsed.
test('BlocklistCap_AppliesTheListOverSeveralCycles', async () => {
  const CONTENT = '1.1.1.1\n2.2.2.2\n3.3.3.3\n4.4.4.4';
  const URL_A = 'https://example.test/list';
  const h = harness([], listSettings({ capPerCycle: 2, unbanMinutes: 0 }), async () => CONTENT);

  const r = await h.pipeline.runCycle();
  assert.equal(r.blocklistAdded, 2);                              // exactly the row's cap: first two in list order
  assert.deepEqual(h.source.calls.map((c) => c.ip), ['1.1.1.1', '2.2.2.2']);

  h.store.setListSync(URL_A, '2020-01-01T00:00:00.000Z');         // same URL, schedule due again: immediate refetch of the same content
  const r2 = await h.pipeline.runCycle();
  assert.equal(r2.blocklistAdded, 2);                             // the rest of the list on this cycle (the first two are tracked + present)
  assert.deepEqual(h.source.calls.map((c) => c.ip), ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

// A decision the list did not issue is never adopted: leaving the lists must not unban someone else's ban.
test('Blocklist_DoesNotAdoptForeignActiveDecisions', async () => {
  const h = harness([banDecision(200, '7.7.7.7', new Date().toISOString())],   // active ban created by the Web UI
    listSettings(), async () => '# only a foreign ban\n7.7.7.7');

  const r = await h.pipeline.runCycle();
  assert.equal(r.blocklistAdded, 0);
  assert.equal(h.store.blockEntry('7.7.7.7'), undefined);          // not tracked → its removal can never unban id 200
  assert.equal(h.source.calls.length, 0);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

// Union rule + the longest configured grace among the lists downloading in this cycle (the user's chosen semantics):
// refreshed presence in ANY row closes/protects the global window; sources are taken back per URL; a *global* absence window opens only
// when every refreshing listing misses an IP, and that long-window is measured from the longest `unbanMinutes` across successful fetches.
test('BlocklistsUnion_PresenceProtects_AndLongestGraceWinsTheGlobalWindow', async () => {
  const A = 'https://example.test/listA';
  const B = 'https://example.test/listB';
  const IP = '203.0.110.178';
  const OLD = '2020-01-01T00:00:00.000Z';
  const contents = new Map([[A, IP], [B, IP]]);   // fetched row texts by URL (offline fixture — no network)

  const h = harness([], settings({ blocklists: [
    { url: A, enabled: true, banScenario: 'blocklist/abuseA', refreshMinutes: 60, unbanMinutes: 0, capPerCycle: 5 },
    { url: B, enabled: true, banScenario: 'blocklist/permaban', refreshMinutes: 60, unbanMinutes: 60, capPerCycle: 5 },
  ] }), async (url) => contents.get(url) ?? '');

  const r1 = await h.pipeline.runCycle();                          // A bans the fresh IP once; B's refreshed listing joins its source set free
  assert.equal(r1.blocklistAdded, 1);
  assert.deepEqual(h.source.calls.map((c) => c.ip), [IP]);          // exactly one permanent ban for two lists claiming it
  assert.equal(h.source.calls[0].scenario, 'blocklist/abuseA');     // row A (the URL that banned the fresh IP) used its own configured scenario
  h.source.setEvents([banDecision(10, IP, new Date().toISOString())]);   // the live Web UI now shows a decision: unban lookups read this

  contents.set(A, '');                                             // cycle 2: row A refreshes WITHOUT the IP; row B presence keeps the entry protected
  h.store.setListSync(A, OLD); h.store.setListSync(B, OLD);        // force both URLs' own schedule stamps into the past (same rows)
  const r2 = await h.pipeline.runCycle();
  assert.equal(r2.blocklistUnbanned, 0);
  let entry = h.store.blockEntry(IP);
  assert.ok(entry && !entry.removedAt);                            // a refreshing list owns it → no global window at all
  assert.deepEqual([entry.sources.includes(A), entry.sources.includes(B)], [false, true]);   // A's claim taken back by its real listing; B still owns it

  contents.set(A, ''); contents.set(B, '');                        // cycle 3: every refreshing listing misses the IP → global absence opens
  h.store.setListSync(A, OLD); h.store.setListSync(B, OLD);
  const r3 = await h.pipeline.runCycle();
  entry = h.store.blockEntry(IP);
  assert.ok(entry && entry.removedAt);                             // first global absence stamped by B letting go
  assert.deepEqual([...entry.sources], []);                        // no refreshing list claims the IP any more
  assert.equal(r3.blocklistUnbanned, 0);                            // longest configured grace (B's 60 min) is measured from this stamp: far from over

  entry.removedAt = OLD;                                           // simulate that long global window as it has fully run out
  h.store.setListSync(A, OLD); h.store.setListSync(B, OLD);        // the same content (no row lists the IP) refreshed again under cap
  const r4 = await h.pipeline.runCycle();
  assert.equal(r4.blocklistUnbanned, 1);                            // eligible: unban fires once, counted against one of these URLs' remaining cap
  assert.ok(h.source.calls.some((c) => c.unban === 10));           // by the decision id live in the store — ownership pass, not a foreign ban
  assert.equal(h.store.blockEntry(IP), undefined);                 // completeBlockUnban drops the entry and the app-ban flag together

  fs.rmSync(h.dir, { recursive: true, force: true });
});
