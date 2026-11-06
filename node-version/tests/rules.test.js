// Rule tests, mirroring tests/PermaBan.Tests/AutoBanRuleTests.cs (same reason strings, same check order).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, isSafeCountry, isUnknownCountry, describeCandidate, Action } from '../core/rules.js';

const baseScoring = {
  recidivistBanThreshold: 3, aggressiveEventThreshold: 1000, aggressiveScenarioThreshold: 2,
  eventWeight: 1, scenarioWeight: 100, banWeight: 500, safeCountryBanEnabled: true, safeCountryBanScore: 2500,
};

const settings = (over = {}) => ({ autoBanEnabled: true, safeCountries: ['FR'], scoring: { ...baseScoring, ...over.scoring } });

const profile = (ip, { bans = 0, events = 0, scenarios = 0, country = 'US', score = null }) => ({
  ip, banCount: bans, eventCount: events, scenarioCount: scenarios, country,
  isRecidivist: bans >= baseScoring.recidivistBanThreshold && baseScoring.recidivistBanThreshold > 0,
  isAggressive: events >= baseScoring.aggressiveEventThreshold && scenarios >= baseScoring.aggressiveScenarioThreshold,
});

test('ForeignCandidate_IsAutoBanned', () => {
  const p = profile('1.2.3.4', { bans: 3 });          // score 1500
  p.score = 1500;
  const d = evaluate(p, settings());
  assert.equal(d.action, Action.AutoBan);
  assert.match(d.reason, /recidivist \(3 bans\)/);
});

test('SafeCountry_IsSuggestOnly (case-insensitive safe list)', () => {
  for (const country of ['FR', 'fr']) {
    const p = profile('1.2.3.4', { bans: 4, country });   // score 2000 < default threshold 2500
    p.score = 2000;
    const d = evaluate(p, settings());
    assert.equal(d.action, Action.Suggest);
    assert.match(d.reason, /safe country/);
  }
});

test('SafeCountry_BelowThreshold_IsSuggestOnly', () => {
  const p = profile('1.2.3.4', { bans: 3, events: 700, scenarios: 1, country: 'FR' });   // 700 + 100 + 1500 = 2300 < 2500
  p.score = 2300;
  const d = evaluate(p, settings({ scoring: { safeCountryBanScore: 2500 } }));
  assert.equal(d.action, Action.Suggest);
  assert.match(d.reason, /safe country \(FR\), score 2,300 < 2,500/);
});

test('SafeCountry_AtThreshold_IsAutoBanned (boundary is inclusive)', () => {
  const p = profile('1.2.3.4', { bans: 5, country: 'FR' });   // score exactly 2500
  p.score = 2500;
  const d = evaluate(p, settings({ scoring: { safeCountryBanScore: 2500 } }));
  assert.equal(d.action, Action.AutoBan);
  assert.match(d.reason, /safe-country threshold 2,500/);
});

test('SafeCountry_AboveThreshold_IsAutoBanned', () => {
  const p = profile('1.2.3.4', { bans: 3, events: 1200, scenarios: 2, country: 'FR' });   // 1200 + 200 + 1500 = 2900 ≥ 2500
  p.score = 2900;
  const d = evaluate(p, settings({ scoring: { safeCountryBanScore: 2500 } }));
  assert.equal(d.action, Action.AutoBan);
});

test('SafeCountry_ScoreGateOff_IsSuggestOnly (threshold ignored)', () => {
  const p = profile('1.2.3.4', { bans: 20, country: 'FR' });   // score way above any threshold
  p.score = 10000;
  const d = evaluate(p, settings({ scoring: { safeCountryBanEnabled: false } }));
  assert.equal(d.action, Action.Suggest);
  assert.match(d.reason, /score gate off/);
});

test('MasterSwitchOff_WinsOverSafeCountryScore', () => {
  const p = profile('1.2.3.4', { bans: 5, country: 'FR' });   // clears the threshold
  p.score = 2500;
  const s = settings();
  s.autoBanEnabled = false;
  const d = evaluate(p, s);
  assert.equal(d.action, Action.Suggest);
  assert.match(d.reason, /auto-ban disabled/);
});

test('UnknownCountry_IsSuggestOnly', () => {
  for (const country of ['', '   ', 'Unknown', 'unknown']) {
    const p = profile('1.2.3.4', { bans: 5, country });       // score clears every threshold
    p.score = 9000;
    const d = evaluate(p, settings());
    assert.equal(d.action, Action.Suggest);
    assert.match(d.reason, /unknown country/);
  }
});

test('NotCandidate_IsNone', () => {
  const p = profile('1.2.3.4', { bans: 1, events: 50, scenarios: 1, country: 'US' });
  p.score = 600; p.isRecidivist = false; p.isAggressive = false;
  const d = evaluate(p, settings());
  assert.equal(d.action, Action.None);
});

test('DescribeCandidate_CombinesBothRules', () => {
  const p = profile('1.2.3.4', { bans: 4, events: 1500, scenarios: 3, country: 'DE' });
  assert.equal(describeCandidate({ ...p, isRecidivist: true, isAggressive: true }),
    'recidivist (4 bans) + aggressive (1,500 events / 3 scenarios)');
});

test('IsSafeCountry_TrimsAndUpperCases', () => {
  const s = settings({ safeCountries: [' fr ', 'FR'] });
  assert.ok(isSafeCountry('FR', s));
  assert.ok(!isSafeCountry('DE', s));
  assert.ok(isUnknownCountry(null) && isUnknownCountry(undefined));
});
