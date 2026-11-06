// Download exports for the web UI: the same rows the grids show, as CSV / ndjson files.
// Zero dependencies; quoting follows RFC 4180 so a reason string with commas survives Excel.

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

const CANDIDATE_HEADERS = ['ip', 'country', 'score', 'events', 'scenarios', 'bans',
  'first_seen', 'last_seen', 'action', 'reason', 'by_app'];
const BANNED_HEADERS = ['id', 'ip', 'country', 'scenario', 'origin', 'events', 'bans',
  'score', 'created', 'expires', 'by_app'];

export function candidatesCsv(candidates) {
  return toCsv(CANDIDATE_HEADERS, (candidates ?? []).map((c) => [
    c.ip, c.country, c.score, c.eventCount, c.scenarioCount, c.banCount,
    c.firstSeen, c.lastSeen, c.action, c.reason, c.autoBannedByApp ? 'yes' : 'no',
  ]));
}

export function bannedCsv(banned) {
  return toCsv(BANNED_HEADERS, (banned ?? []).map((b) => [
    b.id, b.ip, b.country, b.scenario, b.origin, b.events, b.bans, b.score,
    b.createdAt, b.expiresAt ?? '', b.autoBannedByApp ? 'yes' : 'no',
  ]));
}

/// Full raw history: one stored event per line, oldest first (the same NDJSON the data folder keeps).
export function eventsNdjson(events) {
  return (events ?? []).map((e) => JSON.stringify(e)).join('\n') + '\n';
}
