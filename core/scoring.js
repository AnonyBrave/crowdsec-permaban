// Per-IP scoring, mirroring src/PermaBan.Core/Analytics/PerIpProfileAnalytics.cs.
//
// Candidate rules (all thresholds configurable):
//   - Recidivist: banCount >= recidivistBanThreshold (default 3 bans)
//   - Aggressive: eventCount >= aggressiveEventThreshold (1000) AND scenarioCount >= aggressiveScenarioThreshold (2)
// Composite score for ranking: events*eventWeight + scenarios*scenarioWeight + bans*banWeight

export function isCandidate(agg, config) {
  const recidivist = config.recidivistBanThreshold > 0 && agg.banCount >= config.recidivistBanThreshold;
  const aggressive = config.aggressiveEventThreshold > 0
    && agg.eventCount >= config.aggressiveEventThreshold
    && agg.scenarioCount >= config.aggressiveScenarioThreshold;
  return recidivist || aggressive;
}

export function compositeScore(agg, config) {
  // C# uses Math.Round on the double sum (banker-less half-away-from-zero), so mirror that.
  const raw = agg.eventCount * config.eventWeight + agg.scenarioCount * config.scenarioWeight + agg.banCount * config.banWeight;
  return Math.round(raw + Number.EPSILON);
}

/// Scores every IP aggregate into a profile (pure, unit-testable without a store).
export function scoreProfiles(aggregates, config) {
  const profiles = [];
  for (const a of aggregates) {
    const recidivist = config.recidivistBanThreshold > 0 && a.banCount >= config.recidivistBanThreshold;
    const aggressive = config.aggressiveEventThreshold > 0
      && a.eventCount >= config.aggressiveEventThreshold
      && a.scenarioCount >= config.aggressiveScenarioThreshold;

    profiles.push({
      ip: a.ip,
      eventCount: a.eventCount,
      alertCount: a.alertCount,
      scenarioCount: a.scenarioCount,
      banCount: a.banCount,
      firstSeen: a.firstSeen ?? null,
      lastSeen: a.lastSeen ?? null,
      country: a.country ?? '',
      currentlyBanned: !!a.currentlyBanned,
      score: compositeScore(a, config),
      isRecidivist: recidivist,
      isAggressive: aggressive,
      isCandidate: recidivist || aggressive,   // the pipeline filter and the rule both read this flag
    });
  }
  return profiles;
}
