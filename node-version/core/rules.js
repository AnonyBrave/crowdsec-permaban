// The policy rule, mirroring src/PermaBan.Core/Rules/AutoBanRule.cs. Check order matters:
//   - candidate + country unknown / empty            -> suggest ("… — unknown country")
//   - master auto-ban switch off                     -> suggest (wins over a safe-country score above the gate)
//   - candidate in safe list, gate off               -> suggest ("score gate off")
//   - candidate in safe list, score < threshold      -> suggest ("safe country (FR), score 2 300 < 2 500")
//   - candidate in safe list, score >= threshold     -> auto-ban (protection lifted)
//   - foreign candidate                              -> auto-ban
//   - not a candidate                                -> none

import { n0 } from './format.js';

export const Action = Object.freeze({ None: 'none', Suggest: 'suggest', AutoBan: 'auto-ban' });

export function isUnknownCountry(country) {
  if (country === null || country === undefined) return true;
  const c = String(country).trim();
  return c === '' || c.toLowerCase() === 'unknown';
}

export function isSafeCountry(country, settings) {
  if (country === null || country === undefined) return false;
  const c = String(country).trim().toUpperCase();
  if (c === '') return false;
  return (settings.safeCountries ?? []).some((x) => (x ?? '').trim().toUpperCase() === c);
}

/// The C# IpProfile carries IsCandidate = isRecidivist || isAggressive. Mirror it so raw profiles work everywhere.
export function withCandidateFlag(profile, config) {
  const recidivist = config.recidivistBanThreshold > 0 && profile.banCount >= config.recidivistBanThreshold;
  const aggressive = config.aggressiveEventThreshold > 0
    && profile.eventCount >= config.aggressiveEventThreshold
    && profile.scenarioCount >= config.aggressiveScenarioThreshold;
  return { ...profile, isCandidate: recidivist || aggressive };
}

export function describeCandidate(profile) {
  const parts = [];
  if (profile.isRecidivist) parts.push(`recidivist (${n0(profile.banCount)} bans)`);
  if (profile.isAggressive) parts.push(`aggressive (${n0(profile.eventCount)} events / ${profile.scenarioCount} scenarios)`);
  return parts.length > 0 ? parts.join(' + ') : 'candidate';
}

export function evaluate(profile, settings) {
  profile = withCandidateFlag(profile, settings.scoring);

  if (!profile.isCandidate) return { action: Action.None, reason: '' };

  const reason = describeCandidate(profile);

  if (isUnknownCountry(profile.country))
    return { action: Action.Suggest, reason: `${reason} — unknown country` };

  // The master switch wins first: when auto-ban is off nothing is ever banned.
  if (!settings.autoBanEnabled)
    return { action: Action.Suggest, reason: `${reason} — auto-ban disabled` };

  const score = settings.scoring;
  const safe = isSafeCountry(profile.country, settings);

  // Safe countries are suggest-only while the score gate is off, and until their score reaches the threshold.
  if (safe && !score.safeCountryBanEnabled)
    return { action: Action.Suggest, reason: `${reason} — safe country (${profile.country}), score gate off` };

  if (safe && profile.score < score.safeCountryBanScore)
    return {
      action: Action.Suggest,
      reason: `${reason} — safe country (${profile.country}), score ${n0(profile.score)} < ${n0(score.safeCountryBanScore)}`,
    };

  // Above the threshold a safe-country candidate is banned like any foreign one.
  return safe
    ? { action: Action.AutoBan, reason: `${reason} + score ${n0(profile.score)} ≥ safe-country threshold ${n0(score.safeCountryBanScore)}` }
    : { action: Action.AutoBan, reason };
}
