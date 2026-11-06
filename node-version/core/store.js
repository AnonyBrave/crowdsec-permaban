// Event store for the Node port: an append-only NDJSON log (`events.ndjson`) plus a small side file `state.json`
// (auto_bans, notified IPs, and the local deltas: which decisions this app marked expired, which rows retention
// deleted). Same tables/semantics as src/PermaBan.Core/Store/SqliteEventStore.cs:
//   events(source,id) primary key, ip_state.notified, auto_bans(ip).
// Timestamps are ISO-8601 UTC strings, so day ranges and "older than" comparisons are plain string ordering.
//
// Startup resilience mirrors AppOrchestrator.OpenStore in the C# app: a launch that cannot write the data folder
// (restricted token, locked profile) opens the real log READ-ONLY — history, scoring and Web UI bans keep working,
// nothing is recorded — instead of dying on a database error.
import fs from 'node:fs';
import path from 'node:path';
import { scoreProfiles } from './scoring.js';

const ISO = (d) => new Date(d).toISOString();
const KEY = (e) => `${e.source}:${e.id}`;

/// Full rewrite threshold: append-only log + small overlay files, compacted when either grows large.
const COMPACT_LINES = 20000;

export class EventStore {
  /// Opens the store for writing, with the same fallback order as AppOrchestrator.OpenStore:
  /// read-write primary → read-only on the real history (this launch writes nothing) → scratch folder.
  /// `simulateBlockedWrites` forces the blocked-folder path so the fallback chain is unit-testable; production
  /// code never passes it — the real check is `canWrite(dir)`.
  static open(dir, { scratchDir, simulateBlockedWrites = false } = {}) {
    const writable = !simulateBlockedWrites && canWrite(dir);

    if (!writable && dir !== scratchDir) {
      const primaryLog = path.join(dir, 'events.ndjson');
      if (fs.existsSync(primaryLog)) {
        const store = new EventStore(dir, true);   // reads everything, writes nothing
        store.load();
        store.warning = `The data folder is not writable by this launch (${dir}). The history at "${primaryLog}" is opened READ-ONLY: bans are issued, records stay frozen.`;
        return store;
      }
      if (scratchDir) {
        const store = new EventStore(scratchDir, !canWrite(scratchDir));
        store.load();
        store.warning = `The data folder ${dir} is not writable by this launch. PermaBan uses the scratch store "${path.join(scratchDir, 'events.ndjson')}"; nothing is written in "${dir}".`;
        return store;
      }
    }

    const store = new EventStore(dir, !writable);
    store.load();
    if (!writable) store.warning = `The data folder ${dir} is not writable by this launch: history is read-only for now.`;
    return store;
  }

  constructor(dir, readOnly = false) {
    this.dir = dir;
    this.readOnly = readOnly;
    this.warning = null;
    this.events = new Map();            // source:id -> event
    this.autoBans = new Map();          // ip -> {ip, decisionId, country, score, reason, bannedAt}
    this.notified = new Set();          // ips already notified (notification dedup)
    this.expiredOverrides = new Set();  // decision ids this app marked expired locally
    this.deletedKeys = new Set();       // rows retention removed locally
    this.appendedSinceCompact = 0;
  }

  get logPath() { return path.join(this.dir, 'events.ndjson'); }
  get statePath() { return path.join(this.dir, 'state.json'); }

  load() {
    try {
      const text = fs.readFileSync(this.logPath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          this.events.set(KEY(e), e);   // append-only log: the last write wins
        } catch { /* torn trailing line from a killed process → ignore */ }
      }
    } catch { /* no history yet */ }

    try {
      const st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      for (const b of st.autoBans ?? []) this.autoBans.set(b.ip, b);
      for (const ip of st.notified ?? []) this.notified.add(ip);
      for (const k of st.deletedKeys ?? []) { this.deletedKeys.add(k); this.events.delete(k); }
      for (const id of st.expiredOverrides ?? []) this.expiredOverrides.add(Number(id));
    } catch { /* no state yet */ }

    // Re-apply the local deltas recorded by earlier launches.
    for (const e of this.events.values())
      if (e.kind === 'decision' && this.expiredOverrides.has(Number(e.id))) e.expired = true;
  }

  // ------------------------------------------------------------------ writes

  /// Upsert events (deduped by source+id, fields refreshed). Returns the number of NEW rows.
  upsertEvents(events) {
    if (this.readOnly) return 0;   // history frozen: reads keep working, nothing is half-written
    const now = ISO(Date.now());
    const fresh = [];
    for (const raw of events) {
      const e = normalizeEvent(raw, now);
      const k = KEY(e);
      if (!this.events.has(k)) fresh.push(e);
      this.events.set(k, e);
      this.deletedKeys.delete(k);   // re-ingested row is alive again
    }
    if (fresh.length > 0) {
      const lines = fresh.map((e) => JSON.stringify(e)).join('\n') + '\n';
      try { fs.appendFileSync(this.logPath, lines); this.appendedSinceCompact += fresh.length; }
      catch (err) { this._degrade(`append ${this.logPath}: ${err.message}`); }
    }
    return fresh.length;
  }

  /// Delete events older than the cutoff. Returns rows removed (the log is rewritten by the next compact).
  purgeOlderThan(cutoff) {
    if (this.readOnly) return 0;   // retention is skipped while the store cannot write
    const cut = ISO(cutoff);
    let removed = 0;
    for (const [k, e] of [...this.events]) {
      if (e.ts < cut) {
        this.events.delete(k);
        this.deletedKeys.add(k);
        removed++;
      }
    }
    return removed;
  }

  /// Decisions deleted on the server vanish from the live listing → mark them expired locally.
  markInvisibleDecisionsExpired(liveDecisionIds, lookbackStart) {
    if (this.readOnly) return 0;   // the liveness sync is skipped while the store cannot write
    const start = ISO(lookbackStart);
    const live = new Set(liveDecisionIds.map((id) => Number(id)));
    let marked = 0;
    for (const e of this.events.values()) {
      if (e.kind === 'decision' && e.decisionType === 'ban'
        && (e.decisionAction ?? '') !== 'unban' && !e.expired
        && e.ts >= start && !live.has(Number(e.id))) {
        e.expired = true;
        this.expiredOverrides.add(Number(e.id));
        marked++;
      }
    }
    return marked;
  }

  recordAutoBan(ip, decisionId, country, score, reason) {
    if (this.readOnly) return;   // the ban is issued on the server, only the local record is skipped
    this.autoBans.set(ip, { ip, decisionId: decisionId ?? null, country, score, reason, bannedAt: ISO(Date.now()) });
  }

  removeAutoBan(ip) {
    if (this.readOnly) return;   // the unban runs on the server, only the local record is skipped
    this.autoBans.delete(ip);
  }

  markNotified(ips) { for (const ip of ips) this.notified.add(ip); }

  /// Persist one cycle: state.json (auto-bans, notified IPs, deltas) and — when the log grew enough — a full rewrite.
  persist() {
    if (this.readOnly) return false;
    const compact = this.appendedSinceCompact > COMPACT_LINES
      || this.expiredOverrides.size + this.deletedKeys.size > COMPACT_LINES;
    try {
      fs.writeFileSync(this.statePath, JSON.stringify({
        autoBans: [...this.autoBans.values()],
        notified: [...this.notified],
        expiredOverrides: [...this.expiredOverrides],
        deletedKeys: [...this.deletedKeys],
      }, null, 2));

      if (compact) {
        // Materialize the deltas into the log rows and start fresh.
        for (const e of this.events.values())
          if (e.kind === 'decision' && this.expiredOverrides.has(Number(e.id))) e.expired = true;
        fs.writeFileSync(this.logPath, [...this.events.values()].map((e) => JSON.stringify(e)).join('\n') + '\n');
        this.appendedSinceCompact = 0;
        this.expiredOverrides.clear();
        this.deletedKeys.clear();
      }
      return true;
    } catch (err) {
      this._degrade(`persist ${this.dir}: ${err.message}`);   // keep running in memory, say it out loud
      return false;
    }
  }

  _degrade(message) {
    if (this.warning === null)
      this.warning = `Store writes are blocked (${message}). PermaBan keeps running from memory for this launch.`;
  }

  // ------------------------------------------------------------------ reads

  totalEvents() { return this.events.size; }

  /// Per-IP aggregates, same semantics as GetIpAggregates().
  aggregates() {
    const byIp = new Map();
    const mutate = (ip, fn) => {
      let a = byIp.get(ip);
      if (!a) { a = { ip, eventCount: 0, alertCount: 0, banCount: 0, scenarioCount: 0, firstSeen: null, lastSeen: null, country: '', currentlyBanned: false }; byIp.set(ip, a); }
      fn(a);
    };

    const scenariosByIp = new Map();   // ip -> Set(scenario)
    for (const e of this.events.values()) {
      if (!e.ip) continue;
      mutate(e.ip, (a) => {
        if (e.kind === 'alert') { a.eventCount += e.eventsCount ?? 0; a.alertCount++; }
        if (e.kind === 'decision' && e.decisionType === 'ban' && (e.decisionAction ?? '') !== 'unban') a.banCount++;
        if (e.ts < a.firstSeen || a.firstSeen === null) a.firstSeen = e.ts;
        if (e.ts > a.lastSeen || a.lastSeen === null) a.lastSeen = e.ts;
        if (e.kind === 'decision' && e.decisionType === 'ban' && (e.decisionAction ?? '') !== 'unban' && !e.expired) a.currentlyBanned = true;
      });
      if (e.kind === 'alert' && e.scenario) {
        if (!scenariosByIp.has(e.ip)) scenariosByIp.set(e.ip, new Set());
        scenariosByIp.get(e.ip).add(e.scenario);
      }
    }

    // Most recent known country per IP (ts desc, id desc — same tie-break as the SQL window function).
    const latestCountry = new Map();
    for (const e of this.events.values()) {
      if (!e.ip || !e.country) continue;
      const prev = latestCountry.get(e.ip);
      if (prev === undefined || e.ts > prev.ts || (e.ts === prev.ts && Number(e.id) > Number(prev.id)))
        latestCountry.set(e.ip, { ts: e.ts, id: Number(e.id), country: e.country });
    }

    const out = [];
    for (const a of byIp.values()) {
      a.scenarioCount = scenariosByIp.get(a.ip)?.size ?? 0;
      a.country = latestCountry.get(a.ip)?.country ?? '';
      out.push(a);
    }
    return out;
  }

  /// Active ban decisions, most recent first, joined with the auto-ban marker.
  activeDecisions() {
    const list = [];
    for (const e of this.events.values()) {
      if (e.kind !== 'decision' || e.decisionType !== 'ban') continue;
      if ((e.decisionAction ?? '') === 'unban') continue;
      if (e.expired) continue;
      list.push({
        id: Number(e.id), ip: e.ip, scenario: e.scenario ?? '', country: e.country ?? '',
        createdAt: e.ts, expiresAt: e.expiresAt ?? null, origin: e.origin ?? '',
        autoBannedByApp: this.autoBans.has(e.ip),
      });
    }
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return list;
  }

  dailyEventCounts(days, until) {
    const span = Math.max(1, days);
    const lastDay = new Date(until); lastDay.setUTCHours(0, 0, 0, 0);
    const firstDay = new Date(lastDay); firstDay.setUTCDate(lastDay.getUTCDate() - (span - 1));
    const from = ISO(firstDay), to = ISO(new Date(lastDay.getTime() + 86400000));

    const counts = new Map();
    for (const e of this.events.values()) {
      if (e.ts < from || e.ts >= to) continue;
      const day = e.ts.slice(0, 10);   // ts is ISO-8601 UTC → substr(ts,1,10) is the day
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }

    const list = [];
    for (let i = 0; i < span; i++) {
      const d = new Date(firstDay.getTime() + i * 86400000);
      const day = d.toISOString().slice(0, 10);
      list.push({ date: day, events: counts.get(day) ?? 0 });   // every day of the window present, gaps included
    }
    return list;
  }

  topScenarios(n) {
    const by = new Map();
    for (const e of this.events.values()) {
      if (e.kind !== 'alert' || !e.scenario) continue;
      by.set(e.scenario, (by.get(e.scenario) ?? 0) + (e.eventsCount ?? 0));
    }
    return [...by.entries()].map(([name, events]) => ({ name, events, bans: 0 }))
      .sort((a, b) => b.events - a.events).slice(0, Math.max(1, n));
  }

  topCountries(n) {
    const by = new Map();   // country -> {events, bannedIps:Set}
    for (const e of this.events.values()) {
      if (!e.country) continue;
      const cur = by.get(e.country) ?? { events: 0, bans: new Set() };
      if (e.kind === 'alert') cur.events += e.eventsCount ?? 0;
      if (e.kind === 'decision' && e.decisionType === 'ban' && (e.decisionAction ?? '') !== 'unban' && !e.expired) cur.bans.add(e.ip);
      by.set(e.country, cur);
    }
    return [...by.entries()].map(([name, v]) => ({ name, events: v.events, bans: v.bans.size }))
      .sort((a, b) => b.events - a.events).slice(0, Math.max(1, n));
  }

  /// One IP's stored events, newest first, with the full raw JSON — this is what the profile view and
  /// `/api/profile?ip=` show: every alert/decision we kept for that attacker.
  eventsForIp(ip, limit = 500) {
    const list = [];
    for (const e of this.events.values()) if (e.ip === ip) list.push(e);
    list.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : Number(b.id) - Number(a.id)));
    return list.slice(0, Math.max(1, limit));
  }

  /// The stored profile of one IP (aggregates joined with its score), or null when nothing is known.
  profileFor(ip, scoring) {
    const agg = this.aggregates().find((a) => a.ip === ip);
    if (!agg) return null;
    return scoreProfiles([agg], scoring)[0];
  }

  /// Every stored event, oldest first — the raw-history export (`/export/events.ndjson`).
  allEvents() {
    return [...this.events.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : Number(a.id) - Number(b.id)));
  }

  isAutoBanned(ip) { return this.autoBannedIps().has(ip); }
  autoBannedIps() { return new Set(this.autoBans.keys()); }
  notifiedIps() { return new Set(this.notified); }
}

function normalizeEvent(e, now) {
  const raw = typeof e.rawJson === 'string' ? e.rawJson : JSON.stringify(e.raw ?? {});
  delete e.raw;   // the fetched item is kept as rawJson text only
  return {
    source: e.source ?? 'crowdsec',
    id: Number(e.id),
    ts: ISO(e.ts),
    ip: (e.ip ?? '').trim(),
    kind: e.kind,
    country: e.country ?? '',
    scenario: e.scenario ?? '',
    eventsCount: e.eventsCount ?? 0,
    decisionType: e.decisionType ?? '',
    decisionAction: e.decisionAction ?? '',
    expired: !!e.expired,
    expiresAt: e.expiresAt ? ISO(e.expiresAt) : null,
    origin: e.origin ?? '',
    rawJson: raw,
    ingestedAt: e.ingestedAt ?? now,
  };
}

function canWrite(dir) {
  const probe = path.join(dir, '.perma-write-test');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}
