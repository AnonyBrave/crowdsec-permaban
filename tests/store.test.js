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

// The dashboard card's number is this lifetime counter, persisted in `state.json` — that is what keeps a page opened after
// idle cycles from showing 0. Re-recording one IP (its decision id refreshed on the Web UI) must not double-count an issuance.
test('BansIssuedTotal_CountsIssuancesAndSurvivesAReload', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  assert.equal(s.autoBansTotal(), 0);

  s.recordAutoBan('3.3.3.3', 1, 'US', 1500, 'recidivist (3 bans)');    // pipeline auto-ban → +1
  s.recordAutoBan('4.4.4.4', null, 'DE', 900, 'foreign first ban');     // the UI Ban button path (no decision id yet)
  s.recordAutoBan('3.3.3.3', 2, 'US', 1500, 'decision id refreshed');   // same IP tracked → not a new issuance
  assert.equal(s.autoBansTotal(), 2);

  s.removeAutoBan('4.4.4.4');                                          // unbanned externally: the ban stays counted
  assert.equal(s.autoBansTotal(), 2);
  s.persist();

  const again = EventStore.open(dir);
  assert.equal(again.autoBansTotal(), 2);                             // restored from state.json
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BansIssuedTotal_ReadOnlyLaunchKeepsItInMemory', () => {
  const dir = tempDir();
  const first = EventStore.open(dir);
  first.recordAutoBan('3.3.3.3', 1, 'US', 1500, 'recidivist');        // launch 1 writes the record
  first.persist();

  const ro = EventStore.open(dir, { simulateBlockedWrites: true });    // same folder, writes blocked this time
  assert.equal(ro.autoBansTotal(), 1);                                // reads the persisted count like everything else
  ro.recordAutoBan('5.5.5.5', null, 'NL', 400, 'ui ban');            // a read-only launch records nothing: no record,
  assert.equal(ro.autoBansTotal(), 1);                               // so the counter shown this launch stays as it was on disk
  ro.persist();                                                       // writes nothing, as for any read-only launch

  const after = EventStore.open(dir);
  assert.equal(after.autoBansTotal(), 1);                             // the blocked launch did not move the counter

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

test('Normalize_SurvivesGarbageDatesFromTheWebUiApi', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);

  // The API sent a duration string where the expiry date belongs, and a created_at that is not a date at all. Before
  // this guard both threw "Invalid time value" inside upsertEvents — the cycle died and every UI route answered 500.
  s.upsertEvents([
    { ...ban(201, '4.4.4.4', 'not-a-date', { country: 'NL' }), expiresAt: '876000h' },
    alert(5, '4.4.4.4', 40, 'ssh-bf', '2026-11-05T09:00:00.000Z'),
  ]);

  const row = s.allEvents().find((e) => e.id === 201);
  assert.ok(row, 'the row is stored, not dropped');
  assert.equal(row.expiresAt, null, 'a non-ISO expiry becomes null (grid shows an empty cell), never a thrown Date');
  assert.match(row.ts, /^\d{4}-\d{2}-\d\dT\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'unparseable created_at falls back to the ingest time');

  // The row behaves like normal data everywhere: an active ban, a day on the charts, raw JSON for the per-IP viewer.
  assert.deepEqual(s.activeDecisions().map((d) => d.id), [201], 'the ban is active despite the garbage expiry');
  const day = row.ts.slice(0, 10);
  assert.ok(s.dailyEventCounts(7, new Date().toISOString()).find((d) => d.date === day).events >= 1,
    'the junk-dated event counts on the day it arrived, so the charts keep working');

  const again = EventStore.open(dir);   // persisted: the reload sees null expiry too, no re-throw from disk
  assert.equal(again.allEvents().find((e) => e.id === 201).expiresAt, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

const SCORING = { recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2,
  eventWeight: 1, scenarioWeight: 100, banWeight: 500 };

test('Events_TheSameIdForAnAlertAndADecisionDoNotCollide', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);

  // Real Web UI behaviour: alerts and decisions are separate tables, both numbering from 1, so alert 9 and decision 9
  // arrive in the same fetch. Keying on source+id alone let the later write erase the other row — history export,
  // per-IP counts/scores and the Banned view all lost data silently.
  s.upsertEvents([alert(9, '203.0.113.15', 600, 'ssh-bf', '2026-11-04T10:00:00.000Z'),
    ban(9, '198.51.100.4', '2026-11-05T08:00:00.000Z', { country: 'US' })]);

  assert.equal(s.totalEvents(), 2, 'both rows survive the fetch');
  assert.equal(s.profileFor('203.0.113.15', SCORING).eventCount, 600, 'the alert is still counted in its own IP profile');
  assert.deepEqual(s.activeDecisions().map((d) => d.ip), ['198.51.100.4'], 'and the ban is listed as active');

  const kinds = new Set(s.allEvents().filter((e) => e.id === 9).map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ['alert', 'decision'], 'the raw history export carries both rows at id 9');

  const again = EventStore.open(dir);   // reload from disk: the same ids key apart there too
  assert.equal(again.totalEvents(), 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('MarkInvisibleDecisionsExpired_LeavesTheAlertSharingThatIdAlone', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  const recent = new Date().toISOString();   // inside the lookback window, so the liveness sync sees it

  s.upsertEvents([alert(9, '203.0.113.15', 600, 'ssh-bf', recent), ban(9, '198.51.100.4', recent)]);

  // Decision 9 is no longer listed by the Web UI (unbanned server-side) → marked expired locally, one row only.
  assert.equal(s.markInvisibleDecisionsExpired([], new Date(Date.now() - 3600000)), 1);
  assert.equal(s.activeDecisions().length, 0);

  const alertRow = s.allEvents().find((e) => e.kind === 'alert' && e.id === 9);
  assert.ok(alertRow && !alertRow.expired, 'the alert with that id is untouched by the decision-side liveness sync');
  assert.equal(s.profileFor('203.0.113.15', SCORING).eventCount, 600, 'its events still count for the score');

  const again = EventStore.open(dir);   // the persisted override applies to decisions only
  assert.equal(again.allEvents().find((e) => e.kind === 'alert' && e.id === 9).expired, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

// The imported list keeps its own small overlay in `state.json`: what it owns, when an IP was first seen missing, and
// the URL + timestamp of the last real download — the schedule survives a restart exactly like every other state.
test('BlockBans_ScheduleAndOwnershipRoundTripThroughState', () => {
  const dir = tempDir();
  const s = EventStore.open(dir);
  assert.equal(s.blocklistSnapshot().tracked, 0);
  assert.equal(s.listSyncAt('https://example.test/listA'), null);

  s.recordAutoBan('5.1.1.1', null, '', 0, 'permaban: imported blocklist');   // list bans share the lifetime counter
  s.recordBlockBan('5.1.1.1', 'https://example.test/listA');                 // A owns it; B does not claim it yet
  s.recordBlockBan('5.2.2.2', 'https://example.test/listA');

  assert.equal(s.removeBlockSource('5.1.1.1', 'https://example.test/listB'), false);   // B never claimed it: nothing to take back from B
  assert.equal(s.removeBlockSource('5.1.1.1', 'https://example.test/listA'), true);     // the last refreshing URL lets go → GLOBAL absence, window stamped
  s.recordBlockBan('5.1.1.1', 'https://example.test/listB');                  // B's refreshed listing claims it again: sources = [B], global window closed
  assert.ok(!s.blockEntry('5.1.1.1').removedAt);                              // presence in one refreshing row closes the global window immediately
  assert.equal(s.removeBlockSource('5.1.1.1', 'https://example.test/listA'), false);   // A no longer owns it, so B's claim keeps the entry protected
  s.setListSync('https://example.test/listB', '2026-11-12T10:30:00.000Z');     // each URL keeps its own stamp in `state.json`
  assert.ok(s.persist());

  const again = EventStore.open(dir);
  assert.equal(again.listSyncAt('https://example.test/listA'), null);          // only B was recorded as fetched
  assert.equal(again.listSyncAt('https://example.test/listB'), '2026-11-12T10:30:00.000Z');
  assert.deepEqual([...again.blockBans.keys()].sort(), ['5.1.1.1', '5.2.2.2']);
  assert.ok(again.isAutoBanned('5.1.1.1'));                                    // list bans share the "by app" flag & lifetime counter
  assert.equal(again.autoBansTotal(), 1);
  assert.deepEqual([...again.blockEntry('5.1.1.1').sources], ['https://example.test/listB']);   // persisted sources survive the round trip
  assert.ok(!again.blockEntry('5.2.2.2').removedAt);

  // The unban is complete: every URL's ownership drops AND the "by app" flag drops with it, so a later re-add bans anew.
  again.completeBlockUnban('5.2.2.2');
  assert.equal(again.blockEntry('5.2.2.2'), undefined);
  assert.ok(!again.isAutoBanned('5.2.2.2'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('BlockState_ReadOnlyLaunchFreezesRecordsAndSchedule', () => {
  const dir = tempDir();
  const first = EventStore.open(dir);
  first.recordBlockBan('5.1.1.1', 'https://example.test/listA');
  first.setListSync('https://example.test/listA', '2026-11-12T10:00:00.000Z');
  first.persist();

  const ro = EventStore.open(dir, { simulateBlockedWrites: true });
  assert.ok(ro.readOnly);
  assert.equal(ro.listSyncAt('https://example.test/listA'), '2026-11-12T10:00:00.000Z');   // reads what earlier launches recorded
  ro.setListSync('https://example.test/listB', '2026-11-12T11:00:00.000Z');                // frozen: the stamp stays as it was (list B absent)
  assert.equal(ro.listSyncAt('https://example.test/listB'), null);
  ro.recordBlockBan('9.9.9.9', 'https://example.test/listA');                              // no record on a read-only store
  assert.equal(ro.blockEntry('9.9.9.9'), undefined);
  assert.equal(ro.removeBlockSource('5.1.1.1', 'https://example.test/listA'), false);

  const after = EventStore.open(dir);   // disk unchanged: the blocked launch never wrote
  assert.equal(after.listSyncAt('https://example.test/listA'), '2026-11-12T10:00:00.000Z');
  assert.deepEqual([...after.blockBans.keys()], ['5.1.1.1']);

  fs.rmSync(dir, { recursive: true, force: true });
});
