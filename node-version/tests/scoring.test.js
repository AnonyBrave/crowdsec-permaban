// Scoring tests, mirroring the composite-score rules of PerIpProfileAnalytics: score = events×EventWeight +
// scenarios×ScenarioWeight + bans×BanWeight, candidate flags from the two threshold rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreProfiles, compositeScore, isCandidate } from '../core/scoring.js';

const cfg = {
  recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2,
  eventWeight: 1, scenarioWeight: 100, banWeight: 500, safeCountryBanEnabled: true, safeCountryBanScore: 2500,
};

const agg = (o) => ({ ip: '1.1.1.1', eventCount: 0, alertCount: 0, banCount: 0, scenarioCount: 0, country: '', ...o });

test('CompositeScore_IsTheWeightedSum', () => {
  const a = agg({ eventCount: 700, scenarioCount: 1, banCount: 3 });
  assert.equal(compositeScore(a, cfg), 700 * 1 + 1 * 100 + 3 * 500);   // 2300
});

test('ZeroWeight_DropsThatTermFromTheScore', () => {
  const a = agg({ eventCount: 1000, scenarioCount: 4, banCount: 6 });
  assert.equal(compositeScore(a, { ...cfg, banWeight: 0 }), 1000 + 400);
  assert.equal(compositeScore(a, { ...cfg, eventWeight: 0, scenarioWeight: 0 }), 6 * 500);
});

test('FractionalWeights_RoundToTheNearestInt', () => {
  const a = agg({ eventCount: 10, scenarioCount: 3, banCount: 1 });
  assert.equal(compositeScore(a, { ...cfg, eventWeight: 2.5, scenarioWeight: 100.4, banWeight: 500 }),
    Math.round(25 + 301.2 + 500));   // 826
});

test('RecidivistFlag_DoesNotNeedEvents', () => {
  const p = scoreProfiles([agg({ banCount: 3 })], cfg)[0];
  assert.ok(p.isRecidivist && !p.isAggressive);
  assert.ok(p.isCandidate, 'the profiles carry the candidate verdict the pipeline filters on');
  assert.ok(isCandidate(agg({ banCount: 3 }), cfg));
});

test('AggressiveFlag_NeedsBothEventsAndScenarios', () => {
  const onlyEvents = scoreProfiles([agg({ eventCount: 2000, scenarioCount: 1 })], cfg)[0];
  const both = scoreProfiles([agg({ eventCount: 1000, scenarioCount: 2 })], cfg)[0];
  assert.ok(!onlyEvents.isAggressive);
  assert.ok(both.isAggressive);
});

test('ZeroThresholds_MakeEveryIpNonCandidate', () => {
  const p = scoreProfiles([agg({ banCount: 9, eventCount: 5000, scenarioCount: 9 })],
    { ...cfg, recidivistBanThreshold: 0, aggressiveEventThreshold: 0 })[0];
  assert.ok(!p.isRecidivist && !p.isAggressive);
  assert.ok(!p.isCandidate);   // no rule fires → nothing to act on
});

test('Profiles_CarryTheAggregateFields', () => {
  const a = agg({ ip: '9.9.9.9', eventCount: 12, alertCount: 3, banCount: 2, scenarioCount: 4, country: 'DE', currentlyBanned: true, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z' });
  const p = scoreProfiles([a], cfg)[0];
  assert.equal(p.ip, '9.9.9.9');
  assert.equal(p.eventCount, 12); assert.equal(p.scenarioCount, 4); assert.equal(p.banCount, 2);
  assert.equal(p.country, 'DE'); assert.ok(p.currentlyBanned);
  assert.equal(p.firstSeen, '2026-01-01T00:00:00.000Z'); assert.equal(p.lastSeen, '2026-02-01T00:00:00.000Z');
});
