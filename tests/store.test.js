// Store tests, mirroring tests/PermaBan.Tests/EventStoreTests.cs semantics plus the startup fallback chain
// (read-write → read-only on real history → scratch), which is what keeps a launch that cannot write the data
// folder alive instead of dying on a database error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../core/store.js';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'perma-store-')); }

const alert = (id, ip, eventsCount, scenario, ts, country = 'US') =>
  ({ source: 'crowdsec', kind: 'alert', id, ip, ts, country, scenario, eventsCount });
const ban = (id, ip, ts, { expired = false, country = '', action = 'ban', origin = 'cs' } = {}) =>
  ({ source: 'crowdsec', kind: 'decision', id, ip, ts, decisionType: 'ban', decisionAction: action, expired, country, origin });

test('UpsertDedupesByIdAndRefreshesFields', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  const now = '2026-11-05T12:00:00.000Z';

  assert.equal(s.upsertEvents([alert(1, '1.1.1.1', 10, 's/one', '2026-11-05T10:00:00.000Z'),
    alert(2, '1.1.1.1', 5, 's/two', '2026-11-05T11:00:00.000Z'), ban(100, '1.1.1.1', now)]), 3);

  // Same ids again (decision now expired) → no new rows, but the expired flag is refreshed.
  assert.equal(s.upsertEvents([alert(1, '1.1.1.1', 10, 's/one', '2026-11-05T10:00:00.000Z'),
    alert(2, '1.1.1.1', 5, 's/two', '2026-11-05T11:00:00.000Z'), ban(100, '1.1.1.1', now, { expired: true })]), 0);
  assert.equal(s.totalEvents(), 3);
  assert.equal(s.activeDecisions().length, 0);   // decision is expired → not active

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Aggregates_ComputePerIpTotals', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  s.upsertEvents([
    alert(1, '2.2.2.2', 100, 's/one', '2026-11-01T10:00:00.000Z', 'NL'),
    alert(2, '2.2.2.2', 300, 's/two', '2026-11-02T10:00:00.000Z', 'NL'),
    alert(3, '2.2.2.2', 200, 'three', '2026-11-03T10:00:00.000Z', 'NL'),
    alert(4, '3.3.3.3', 10, 's/one', '2026-11-04T10:00:00.000Z', 'FR'),
    ban(10, '2.2.2.2', '2026-11-02T12:00:00.000Z', { country: 'NL' }),
    ban(11, '2.2.2.2', '2026-11-04T12:00:00.000Z', { country: 'NL' }),
  ]);

  const a = s.aggregates().find((x) => x.ip === '2.2.2.2');
  assert.equal(a.eventCount, 600);
  assert.equal(a.alertCount, 3);
  assert.equal(a.scenarioCount, 3);   // distinct alert scenarios
  assert.equal(a.banCount, 2);
  assert.equal(a.country, 'NL');      // most recent known country
  assert.ok(a.currentlyBanned);       // an unexpired ban decision exists
  assert.equal(a.firstSeen, '2026-11-01T10:00:00.000Z');
  assert.equal(a.lastSeen, '2026-11-04T12:00:00.000Z');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Aggregates_ExcludeUnbanDecisionsFromBanCounts', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  s.upsertEvents([ban(1, '4.4.4.4', '2026-11-01T10:00:00.000Z'), ban(2, '4.4.4.4', '2026-11-02T10:00:00.000Z', { action: 'unban' })]);
  assert.equal(s.aggregates().find((x) => x.ip === '4.4.4.4').banCount, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ActiveDecisions_ListsOnlyUnexpiredBansNewestFirst', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  s.upsertEvents([ban(1, '4.4.4.4', '2026-11-03T10:00:00.000Z'), ban(2, '5.5.5.5', '2026-11-02T10:00:00.000Z', { expired: true })]);
  const active = s.activeDecisions();
  assert.deepEqual(active.map((d) => d.ip), ['4.4.4.4']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AutoBans_TrackAndRemove', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  s.recordAutoBan('6.6.6.6', 12345, 'US', 500, 'recidivist (3 bans)');
  assert.ok(s.isAutoBanned('6.6.6.6'));
  assert.ok(s.autoBannedIps().has('6.6.6.6'));
  s.removeAutoBan('6.6.6.6');
  assert.ok(!s.isAutoBanned('6.6.6.6'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Purge_RemovesOldEventsAndSurvivesAReload', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  s.upsertEvents([alert(1, '7.7.7.7', 5, 's/one', '2026-01-01T10:00:00.000Z'), alert(2, '7.7.7.7', 5, 's/two', '2026-11-01T10:00:00.000Z')]);
  assert.equal(s.purgeOlderThan(new Date('2026-09-01T00:00:00.000Z')), 1);
  s.persist();

  const again = new EventStore(dir); again.load();
  assert.equal(again.totalEvents(), 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('MarkInvisibleDecisionsExpired_OnlyInsideTheLookbackWindow', () => {
  const dir = tempDir();
  const s = new EventStore(dir);
  s.upsertEvents([
    ban(10, '8.8.8.8', '2026-11-04T10:00:00.000Z'),   // inside the window, missing from live listing → marked
    ban(11, '9.9.9.9', '2026-10-01T10:00:00.000Z'),   // outside the window → untouched
    ban(12, '2.2.2.2', '2026-11-04T11:00:00.000Z'),   // listed live → stays active
  ]);
  const marked = s.markInvisibleDecisionsExpired([12], new Date('2026-11-01T00:00:00.000Z'));
  assert.equal(marked, 1);
  assert.deepEqual(s.activeDecisions().map((d) => d.id).sort((a, b) => a - b), [11, 12]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ReadOnly_StoreReadsHistoryAndIgnoresEveryWrite', () => {
  const dir = tempDir();
  const rw = new EventStore(dir);
  rw.upsertEvents([alert(1, '8.8.8.8', 100, 's/one', '2026-11-04T10:00:00.000Z', 'NL')]);
  rw.persist();

  const ro = EventStore.open(dir, { simulateBlockedWrites: true });
  assert.ok(ro.readOnly);
  assert.match(ro.warning, /READ-ONLY/);
  assert.equal(ro.totalEvents(), 1);                    // history readable
  assert.equal(ro.upsertEvents([alert(2, '8.8.8.8', 5, 's/two', '2026-11-05T10:00:00.000Z')]), 0);
  ro.recordAutoBan('8.8.8.8', 9, 'NL', 900, 'probe');    // no throw, nothing recorded
  assert.ok(!ro.isAutoBanned('8.8.8.8'));
  assert.equal(ro.purgeOlderThan(new Date('2030-01-01T00:00:00.000Z')), 0);

  const sizeBefore = fs.statSync(path.join(dir, 'events.ndjson')).size;
  ro.persist();                                          // writes nothing
  assert.equal(fs.statSync(path.join(dir, 'events.ndjson')).size, sizeBefore);

  const check = new EventStore(dir); check.load();      // the real history is untouched
  assert.equal(check.totalEvents(), 1);
  assert.ok(!check.isAutoBanned('8.8.8.8'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Open_FallsBackToScratchStoreWhenTheDataFolderIsNotWritable', () => {
  const primary = tempDir(); fs.rmSync(primary, { recursive: true, force: true });   // no history there
  const scratch = tempDir();
  const store = EventStore.open(primary, { scratchDir: scratch, simulateBlockedWrites: true });

  assert.match(store.warning, /scratch store/);
  assert.equal(store.dir, scratch);
  store.upsertEvents([alert(1, '1.2.3.4', 7, 's/one', '2026-11-05T10:00:00.000Z')]);
  store.persist();

  const inScratch = new EventStore(scratch); inScratch.load();
  assert.equal(inScratch.totalEvents(), 1);
  assert.equal(fs.existsSync(path.join(primary, 'events.ndjson')), false);   // primary folder untouched

  fs.rmSync(primary, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('Open_ReadsTheRealHistoryReadOnlyWhenTheFolderIsBlocked', () => {
  const dir = tempDir();
  const first = EventStore.open(dir);                 // writable folder: normal read-write store
  first.upsertEvents([alert(1, '4.5.6.7', 20, 's/one', '2026-11-05T09:00:00.000Z')]);
  first.persist();

  const blocked = EventStore.open(dir, { simulateBlockedWrites: true });   // the same folder, writes blocked
  assert.ok(blocked.readOnly);
  assert.equal(blocked.totalEvents(), 1);             // reads what earlier launches recorded
  assert.match(blocked.warning, /READ-ONLY/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('StateRoundTrips_AutoBansAndNotifiedIpsSurviveAReload', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  s.recordAutoBan('3.3.3.3', null, 'US', 1500, 'recidivist (3 bans)');
  s.markNotified(['2.2.2.2']);
  assert.ok(s.persist());

  const again = EventStore.open(dir);
  assert.ok(again.isAutoBanned('3.3.3.3'));
  assert.ok(again.notifiedIps().has('2.2.2.2'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Compaction_RewritesTheLogAndKeepsEverythingReadable', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  const events = [];
  for (let i = 1; i <= 20001; i++) events.push(alert(i, `10.0.${(i % 250) | 0}.${i % 251}`, 1, 's', '2026-11-05T10:00:00.000Z'));
  s.upsertEvents(events);
  s.persist();     // appended > 20000 → full rewrite

  const lines = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 20001);
  const again = EventStore.open(dir);
  assert.equal(again.totalEvents(), 20001);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventsForIp_ReturnsOnlyThatIpNewestFirstWithRawJson', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  s.upsertEvents([
    // `raw` is what source.js hands over: the item as it came from the Web UI API. The store keeps its JSON text.
    { ...alert(1, '9.9.9.9', 10, 'ssh-bf', '2026-11-01T10:00:00.000Z'), raw: { id: 1, ip: '9.9.9.9', scenario: 'ssh-bf', events_count: 10 } },
    { ...alert(2, '9.9.9.9', 20, 'http-ddos', '2026-11-03T10:00:00.000Z'), raw: { id: 2, ip: '9.9.9.9', scenario: 'http-ddos', events_count: 20 } },
    ban(7, '9.9.9.9', '2026-11-02T12:00:00.000Z', { country: 'DE' }),
    alert(3, '8.8.8.8', 5, 'ssh-bf', '2026-11-04T10:00:00.000Z'),
  ]);

  const list = s.eventsForIp('9.9.9.9');
  assert.equal(list.length, 3);                                   // the neighbour IP is not in this profile
  assert.deepEqual(list.map((e) => e.id), [2, 7, 1]);             // ts desc: 11-03 alert, 11-02 ban, 11-01 alert
  assert.equal(JSON.parse(list[0].rawJson).scenario, 'http-ddos');   // the full raw JSON we stored
  assert.equal(JSON.parse(list[0].rawJson).events_count, 20);    // fields the normalizer does not model survive here

  assert.equal(s.eventsForIp('8.8.8.8').length, 1);
  assert.equal(s.eventsForIp('7.7.7.7').length, 0);              // unknown IP → empty, not a crash
  const capped = s.eventsForIp('9.9.9.9', 2).map((e) => e.id);
  assert.deepEqual(capped, [2, 7]);                              // the limit caps the newest rows

  fs.rmSync(dir, { recursive: true, force: true });
});

test('ProfileFor_ScoresOneIpAndSaysNothingAboutUnknownOnes', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  s.upsertEvents([
    alert(1, '9.9.9.9', 300, 'ssh-bf', '2026-11-01T10:00:00.000Z'),
    alert(2, '9.9.9.9', 100, 'http-ddos', '2026-11-03T10:00:00.000Z'),
    ban(7, '9.9.9.9', '2026-11-04T12:00:00.000Z', { country: 'DE' }),
  ]);

  const scoring = { recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2,
    eventWeight: 1, scenarioWeight: 100, banWeight: 500 };
  const p = s.profileFor('9.9.9.9', scoring);
  assert.equal(p.eventCount, 400);
  assert.equal(p.scenarioCount, 2);
  assert.equal(p.banCount, 1);
  assert.equal(p.score, 400 * 1 + 2 * 100 + 1 * 500);           // events×1 + scenarios×100 + bans×500
  assert.ok(p.currentlyBanned);                                  // the ban on 11-04 is unexpired
  assert.equal(s.profileFor('7.7.7.7', scoring), null);         // nothing stored → no profile, not a crash

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AllEvents_SortsOldestFirstForTheRawHistoryExport', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  s.upsertEvents([ban(10, '1.1.1.1', '2026-11-05T08:00:00.000Z'), alert(1, '1.1.1.1', 3, 's/one', '2026-11-01T09:00:00.000Z')]);
  const all = s.allEvents();
  assert.equal(all.length, 2);
  assert.ok(all[0].ts <= all[1].ts);                             // oldest first — a log you can read top-down
  assert.ok(JSON.parse(all[0].rawJson));                         // every row keeps its raw JSON

  fs.rmSync(dir, { recursive: true, force: true });
});
