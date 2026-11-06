// Client for the CrowdSec Web UI HTTP API (TheDuffman85/crowdsec-web-ui), mirroring
// src/PermaBan.Core/Sources/CrowdSecSource.cs: one nginx HTTP Basic layer on every request, paged reads
// (page_size clamped to 200 by the server), POST /api/decisions for bans, DELETE for unbans.
import { Buffer } from 'node:buffer';

export class SourceAuthException extends Error {}
export class SourceException extends Error {}

const PAGE_SIZE = 200;   // API clamps page_size to 10..200
const MAX_PAGES = 1000;  // safety valve, same as the C# client
const TIMEOUT_MS = 60_000;

const truncate = (s, max) => (!s || s.length <= max ? s : s.slice(0, max) + '…');

function normalizeCountry(code) {
  if (code === null || code === undefined) return '';
  const c = String(code).trim();
  if (c === '' || c.toLowerCase() === 'unknown') return '';
  return c.toUpperCase();
}

export class CrowdSecSource {
  constructor(baseUrl, username, password) {
    if (!baseUrl || !String(baseUrl).trim()) throw new SourceException('BaseUrl is required.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.id = 'crowdsec';
    this.name = 'CrowdSec Web UI';
    this.headers = {
      authorization: `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')}`,
    };
  }

  async request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      method,
      headers: { ...this.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await resp.text();
    return { status: resp.status, url, text };
  }

  async testConnection() {
    const r = await this.request('GET', '/api/auth/status');
    if (r.status === 401) throw new SourceAuthException('Authentication failed (HTTP 401). Check the nginx username/password.');
    if (r.status >= 400) throw new SourceException(`Connection failed: HTTP ${r.status} from ${this.baseUrl}/api/auth/status`);
  }

  async fetchEvents() {
    const alerts = await this.fetchPaged('/api/alerts', mapAlert);
    const decisions = await this.fetchPaged('/api/decisions?include_expired=true', mapDecision);
    return [...alerts, ...decisions];
  }

  async fetchPaged(path, map) {
    const results = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await this.request('GET', `${path}${sep}page=${page}&page_size=${PAGE_SIZE}`);
      if (r.status === 401) throw new SourceAuthException('Authentication failed (HTTP 401). Check the nginx username/password.');
      if (r.status >= 400) throw new SourceException(`HTTP ${r.status} from ${r.url}: ${truncate(r.text, 300)}`);

      let doc;
      try { doc = JSON.parse(r.text); } catch { break; }
      const totalPages = doc?.pagination?.total_pages > 0 ? doc.pagination.total_pages : page;
      if (!Array.isArray(doc?.data)) break;
      for (const item of doc.data) {
        const evt = map(item);
        if (evt) results.push(evt);
      }
      if (page >= totalPages) break;
    }
    return results;
  }

  async ban(ip, duration, reason, scenario) {
    const r = await this.request('POST', '/api/decisions', { ip, duration, type: 'ban', reason, scenario });
    if (r.status >= 400) return { success: false, message: `HTTP ${r.status}: ${truncate(r.text, 300)}`, ids: null };

    let ids = null;
    try {
      const doc = JSON.parse(r.text);
      if (Array.isArray(doc.result)) ids = doc.result.map((x) => String(x)).join(',');
    } catch { /* non-JSON success body; ignore */ }
    return { success: true, message: 'Decision added', ids };
  }

  async unban(decisionId) {
    const r = await this.request('DELETE', `/api/decisions/${decisionId}`);
    if (r.status >= 400) return { success: false, message: `HTTP ${r.status}: ${truncate(r.text, 300)}`, deleted: 0 };

    let deleted = 0;
    try {
      const doc = JSON.parse(r.text);
      const n = doc.nbDeleted;
      if (typeof n === 'number') deleted = n;
      else if (typeof n === 'string' && /^\d+$/.test(n)) deleted = Number(n);
    } catch { /* ignore */ }
    return { success: true, message: 'Decision removed', deleted };
  }
}

function mapAlert(a) {
  const ip = a?.source?.ip ?? a?.source?.value;
  if (!ip || !String(ip).trim()) return null;   // no IP source → nothing to profile
  return {
    source: 'crowdsec', kind: 'alert', id: Number(a.id), ts: a.created_at ?? new Date().toISOString(),
    ip: String(ip).trim(), country: normalizeCountry(a.source?.cn), scenario: a.scenario ?? '',
    eventsCount: a.events_count ?? 0, rawJson: JSON.stringify(a),
  };
}

function mapDecision(d) {
  if (!d?.value || !String(d.value).trim()) return null;
  const detail = d.detail ?? {};
  return {
    source: 'crowdsec', kind: 'decision', id: Number(d.id), ts: d.created_at ?? new Date().toISOString(),
    ip: String(d.value).trim(), country: normalizeCountry(detail.country), scenario: d.scenario ?? '',
    decisionType: detail.type ?? '', decisionAction: detail.action ?? '',
    expired: !!d.expired, expiresAt: detail.expiration ?? null, origin: detail.origin ?? '',
    rawJson: JSON.stringify(d),
  };
}
