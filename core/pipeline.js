// The poll engine, mirroring src/PermaBan.App/Services/PipelineService.cs:
// fetch → upsert → retention → liveness sync → score → rules → auto-ban → notify → reconcile → snapshot.
import { scoreProfiles } from './scoring.js';
import { evaluate, describeCandidate, Action } from './rules.js';
import { SourceAuthException, SourceException } from './source.js';

const DASHBOARD_DAYS = 14;
const DASHBOARD_TOP = 5;

export class Pipeline {
  /// getSettings: () => settings (live), store, source (ISource+IBanExecutor), notifier(message,title)
  constructor({ getSettings, store, source, log }) {
    this.getSettings = getSettings;
    this.store = store;
    this.source = source;
    this.log = log ?? (() => {});
    this.notifier = () => {};
    this.running = false;
    this.timer = null;
    this.busy = null;   // one cycle at a time, like the C# SemaphoreSlim(1,1)
  }

  setSource(source) { this.source = source; }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      let connected = true;
      try {
        await this.pollOnce();
      } catch (e) {
        connected = false;
        this.emit({ at: new Date().toISOString(), error: e.message });
      }
      if (!this.running) return;
      const s = this.getSettings();
      const backoff = Math.max(5, s.pollIntervalSeconds ?? 60);   // error → retry sooner (same idea as the C# loop)
      this.timer = setTimeout(tick, connected ? backoff * 1000 : 30_000);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /// Notification seam: the injectable `notifier(title, body)` (webhook POST in the server, a plain function
  /// in tests). Gated by `notificationsEnabled`, and a failing webhook is reported as an activity line
  /// (`NOTIFY FAILED …`) instead of breaking the cycle.
  async notify(title, body) {
    const s = this.getSettings();
    if (s.notificationsEnabled === false) return;   // balloons never existed here: off means no notification at all
    try {
      await this.notifier(title, body);
    } catch (e) {
      this.log(`NOTIFY FAILED ${title}: ${e.message}`);
    }
  }

  async pollOnce() {
    if (this.busy) return this.busy;         // manual refresh while a cycle runs → join it, never two at once
    this.busy = this.runCycle();
    try { return await this.busy; } finally { this.busy = null; }
  }

  async runCycle() {
    const s = this.getSettings();
    const result = { at: new Date().toISOString(), eventsFetched: 0, newEvents: 0, totalEvents: 0, autoBansIssued: 0 };

    // 1) Fetch + persist.
    let events = [];
    try {
      events = await this.source.fetchEvents();
      result.eventsFetched = events.length;
      result.newEvents = this.store.upsertEvents(events);
    } catch (e) {
      if (e instanceof SourceException || e instanceof SourceAuthException) {   // source-side failure → report, retry sooner
        result.error = e.message;
        result.connected = false;
        this.emit(result);
        return result;
      }
      throw e;
    }

    this.store.purgeOlderThan(new Date(Date.now() - Math.max(1, s.historyRetentionDays) * 86400000));
    result.totalEvents = this.store.totalEvents();

    // 1.5) Liveness sync: decisions deleted on the server vanish from the live listing, so mark them expired
    // locally (within the lookback window). Keeps the Banned view accurate after an unban.
    const liveDecisionIds = events.filter((e) => e.kind === 'decision').map((e) => Number(e.id));
    const lookbackStart = new Date(Date.now() - Math.max(1, s.webUiLookbackHours ?? 168) * 3600000);
    const marked = this.store.markInvisibleDecisionsExpired(liveDecisionIds, lookbackStart);
    if (marked > 0) this.log(`Marked ${marked} decision(s) expired (no longer listed by the Web UI).`);

    // 2) Score. IPs already banned are not candidates: they belong in the Banned view and re-enter this list
    // when their ban expires.
    const profiles = scoreProfiles(this.store.aggregates(), s.scoring);
    const byIp = new Map(profiles.map((p) => [p.ip, p]));
    const autoBannedByStore = this.store.autoBannedIps();

    const candidates = profiles
      .filter((p) => p.isCandidate && !p.currentlyBanned)
      .sort((a, b) => b.score - a.score
        || (String(b.lastSeen ?? b.firstSeen ?? '')).localeCompare(String(a.lastSeen ?? a.firstSeen ?? '')));

    const firstRun = !s.initialized;
    const notified = new Set(this.store.notifiedIps());
    const newlyNotified = [];
    const autoBannedNow = new Set();
    const autoBanMessages = [];
    const failureMessages = [];

    // 3) Apply rules.
    for (const c of candidates) {
      const decision = evaluate(c, s);

      if (decision.action === Action.AutoBan && !autoBannedByStore.has(c.ip) && !c.currentlyBanned) {
        const reason = `${s.banReasonPrefix}: ${decision.reason}`;
        const ban = await this.source.ban(c.ip, s.permanentDuration, reason, s.banScenario);

        if (ban.success) {
          this.store.recordAutoBan(c.ip, null, c.country, c.score, decision.reason);
          autoBannedNow.add(c.ip);
          autoBanMessages.push(`${c.ip} — ${decision.reason} (${s.permanentDuration})`);
          this.log(`AUTO-BANNED ${c.ip} — ${decision.reason}`);
        } else {
          failureMessages.push(`${c.ip}: ${ban.message}`);
          this.log(`AUTO-BAN FAILED ${c.ip}: ${ban.message}`);
        }
      }

      if (!firstRun && decision.action !== Action.None && !notified.has(c.ip)) {
        newlyNotified.push(c);
        notified.add(c.ip);
      }
    }

    // 4) Notifications.
    if (firstRun) {
      this.store.markNotified(candidates.map((c) => c.ip));
      s.initialized = true;
      this.log(`Baseline established: ${candidates.length} existing candidate(s) recorded (no notifications).`);
    } else {
      if (newlyNotified.length > 0) this.store.markNotified(newlyNotified.map((c) => c.ip));

      if (autoBanMessages.length > 0)
        await this.notify('PermaBan — auto-ban issued', autoBanMessages.join('\n'));

      if (failureMessages.length > 0)
        await this.notify('PermaBan — auto-ban failed', failureMessages.join('\n'));

      const suggestionsOnly = newlyNotified.filter((c) => !autoBannedNow.has(c.ip));
      if (suggestionsOnly.length > 0) {
        const top = suggestionsOnly.slice(0, 3).map((c) => c.ip).join(', ');
        const text = suggestionsOnly.length === 1
          ? `${top} — ${describeCandidate(suggestionsOnly[0])} — open PermaBan to review`
          : `${suggestionsOnly.length} new candidate(s): ${top}` +
            (suggestionsOnly.length > 3 ? ` (+${suggestionsOnly.length - 3} more)` : '') +
            ' — open PermaBan to review';
        await this.notify('PermaBan — new candidate(s)', text);
      }
    }

    // 5) Reconcile: an app-banned IP whose decision no longer exists was unbanned externally.
    const activeIps = new Set(this.store.activeDecisions().map((d) => d.ip));
    for (const ip of [...this.store.autoBannedIps()]) {
      if (!activeIps.has(ip) && !autoBannedNow.has(ip)) {
        this.store.removeAutoBan(ip);
        this.log(`Auto-ban state cleared for ${ip} (no active decision — unbanned externally).`);
      }
    }

    // 6) Build the UI snapshot. Candidates carry their rule verdict, same reason string as the C# app.
    result.candidates = candidates.map((c) => {
      const d = evaluate(c, s);
      return {
        ip: c.ip, country: c.country, score: c.score, eventCount: c.eventCount, scenarioCount: c.scenarioCount,
        banCount: c.banCount, firstSeen: c.firstSeen, lastSeen: c.lastSeen,
        action: d.action, reason: d.reason, isRecidivist: c.isRecidivist, isAggressive: c.isAggressive,
        autoBannedByApp: autoBannedByStore.has(c.ip) || autoBannedNow.has(c.ip),
      };
    });

    // The Banned view joins each active decision with the IP's profile (events, bans, score). Country is
    // best-known: the profile country (from alerts) wins, the decision country is the fallback.
    result.banned = this.store.activeDecisions().map((d) => {
      const p = byIp.get(d.ip);
      return {
        id: d.id, ip: d.ip, scenario: d.scenario, country: (p?.country ? p.country : d.country),
        createdAt: d.createdAt, expiresAt: d.expiresAt, origin: d.origin, autoBannedByApp: d.autoBannedByApp,
        events: p?.eventCount ?? 0, bans: p?.banCount ?? 0, score: p?.score ?? 0,
      };
    });

    // Dashboard: recidivism over the currently-banned IPs, plus the top series.
    const bannedIps = new Set(result.banned.map((b) => b.ip));
    result.dashboard = {
      bannedIps: bannedIps.size,
      recidivistBannedIps: [...bannedIps].filter((ip) => (byIp.get(ip)?.banCount ?? 0) >= 2).length,
      dailyEvents: this.store.dailyEventCounts(DASHBOARD_DAYS, new Date(result.at)),
      topScenarios: this.store.topScenarios(DASHBOARD_TOP),
      topCountries: this.store.topCountries(DASHBOARD_TOP),
    };

    result.autoBansIssued = autoBanMessages.length;
    result.connected = true;

    if (result.newEvents > 0)
      this.log(`Sync: ${result.eventsFetched} fetched (${result.newEvents} new), ${result.totalEvents} stored.`);

    const persisted = this.store.persist();   // one write pass per cycle, never in the middle of scoring
    result.storeWarning = this.store.warning ?? null;

    this.emit(result);
    return result;
  }

  emit(result) {
    if (this.onCycle) this.onCycle(result);
  }
}
