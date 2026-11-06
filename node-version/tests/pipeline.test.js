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

function harness(initialEvents, over = {}) {
  const dir = tempDir();
  const store = EventStore.open(dir);
  const s = settings(over);
  const logs = [], notices = [];
  const source = mockSource(initialEvents);
  const p = new Pipeline({ getSettings: () => s, store, source, log: (l) => logs.push(l) });
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
