// Dev visual harness: a mock Web UI (Basic auth, alerts + decisions) behind the real server.js on one local port.
// Same fixtures as `tests/render.test.js` — one recidivist IP with 3 expired seed bans and today's two alerts — so
// opening http://127.0.0.1:<port> in a browser shows populated cards, charts and grids, no real CrowdSec needed.
// Usage: node scripts/dev-demo.js [dataDir]   (Ctrl+C stops both servers)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CREDS = { username: 'demo', password: 'demo' };
const BASIC = Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64');
const ALERT_IP = '203.0.1.13';

function mockWebUi() {
  const alerts = [   // both land on the same store day: one positive bar + quiet stubs in the sparkline
    { id: 1, created_at: '2026-11-06T10:00:00.000Z', scenario: 'crowdsecurity:sshd-max', events_count: 300, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 2, created_at: '2026-11-06T11:00:00.000Z', scenario: 'ssh:bfs', events_count: 50, source: { ip: ALERT_IP, cn: 'US' } },
    { id: 3, created_at: '2026-11-07T08:15:00.000Z', scenario: 'crowdsecurity/http-probefinding', events_count: 420, source: { ip: '198.51.100.9', cn: 'DE' } },
    { id: 4, created_at: '2026-11-07T09:30:00.000Z', scenario: 'crowdsecurity/phishing-domains', events_count: 88, source: { ip: '203.0.1.13', cn: 'US' } },
    { id: 5, created_at: '2026-11-07T14:05:00.000Z', scenario: 'crowdsecurity:radosmd-rce', events_count: 12, source: { ip: '198.51.100.30', cn: 'JP' } },
    { id: 6, created_at: '2026-11-07T18:40:00.000Z', scenario: 'crowdsecurity:sqli-discovery', events_count: 64, source: { ip: '198.51.100.30', cn: 'JP' } },
    { id: 7, created_at: '2026-11-07T21:00:00.000Z', scenario: 'crowdsecurity:ssh-badlogin', events_count: 512, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 8, created_at: '2026-11-08T03:20:00.000Z', scenario: 'crowdsecurity:cve-cve-2025-29927', events_count: 40, source: { ip: '203.0.1.13', cn: 'US' } },
    { id: 9, created_at: '2026-11-08T05:00:00.000Z', scenario: 'crowdsecurity:jwt-forge', events_count: 7, source: { ip: '198.51.100.30', cn: 'JP' } },
    { id: 10, created_at: '2026-11-08T06:45:00.000Z', scenario: 'crowdsecurity:http-crawl-non_statics', events_count: 190, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 11, created_at: '2026-11-08T10:10:00.000Z', scenario: 'crowdsecurity:scan-directory', events_count: 35, source: { ip: '45.155.20.9', cn: 'RU' } },
    { id: 12, created_at: '2026-11-08T13:55:00.000Z', scenario: 'crowdsecurity:wordpress-bruteforce', events_count: 74, source: { ip: '45.155.20.9', cn: 'RU' } },
    { id: 13, created_at: '2026-11-09T02:30:00.000Z', scenario: 'crowdsecurity:ssh-brute-force', events_count: 260, source: { ip: '45.155.20.9', cn: 'RU' } },
    { id: 14, created_at: '2026-11-09T12:00:00.000Z', scenario: 'crowdsecurity:sql-injection-attempt', events_count: 380, source: { ip: '203.0.1.13', cn: 'US' } },
    { id: 15, created_at: '2026-11-09T23:40:00.000Z', scenario: 'crowdsecurity:xss-attempt', events_count: 60, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 16, created_at: '2026-11-10T07:30:00.000Z', scenario: 'crowdsecurity:sshpbrute', events_count: 900, source: { ip: '45.155.20.9', cn: 'RU' } },
    { id: 17, created_at: '2026-11-10T19:20:00.000Z', scenario: 'crowdsecurity:l_amp_wplogin', events_count: 45, source: { ip: '198.51.100.30', cn: 'JP' } },
    { id: 18, created_at: '2026-11-11T01:05:00.000Z', scenario: 'crowdsecurity:probe-http', events_count: 32, source: { ip: '45.155.20.9', cn: 'RU' } },
    { id: 19, created_at: '2026-11-11T08:30:00.000Z', scenario: 'crowdsecurity:ssh-max-auth-failures', events_count: 44, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 20, created_at: '2026-11-11T15:10:00.000Z', scenario: 'crowdsecurity:phishing-domains', events_count: 330, source: { ip: '203.0.1.13', cn: 'US' } },
    { id: 21, created_at: '2026-11-12T09:45:00.000Z', scenario: 'crowdsecurity:cve-2025-29927', events_count: 2886, source: { ip: '45.155.20.9', cn: 'RU' } },
    { id: 22, created_at: '2026-11-12T20:15:00.000Z', scenario: 'crowdsecurity:http-crawl-non_statics', events_count: 1431, source: { ip: '203.0.1.13', cn: 'US' } },
    { id: 23, created_at: '2026-11-13T05:05:00.000Z', scenario: 'crowdsecurity:sshd-max', events_count: 1145, source: { ip: '198.51.100.7', cn: 'US' } },
    { id: 24, created_at: '2026-11-13T12:35:00.000Z', scenario: 'crowdsecurity:radosmd-rce', events_count: 490, source: { ip: '198.51.100.30', cn: 'JP' } },
  ];
  const decisions = [10, 11, 12].map((id, i) => ({ id, value: ALERT_IP, created_at: `2026-11-0${3 - i}T09:00:00.000Z`,
    expired: true, detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: `2026-11-0${4 - i}T09:00:00.000Z` } }));
  let nextId = 100;

  const server = http.createServer((req, res) => {
    const j = (status, doc) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(doc)); };
    if (req.headers.authorization !== `Basic ${BASIC}`) return j(401, {});
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/auth/status') return j(200, { connected: true });

    // POST ban appends a live decision exactly as render.test does, so the two-cycle shape stays honest.
    if (p === '/api/decisions' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
        const body = JSON.parse(b || '{}');
        decisions.push({ id: nextId++, value: body.ip, created_at: new Date().toISOString(), expired: false, scenario: body.scenario,
          detail: { type: 'ban', action: 'ban', origin: 'crowdsec', expiration: '2126-11-06T09:00:00.000Z' } });
        j(200, { result: [decisions[decisions.length - 1].id] });
      });
      return;
    }

    const data = p === '/api/alerts' ? alerts : decisions;   // one page each: the store day and the ban list stay short
    j(200, { pagination: { page: 1, page_size: 500, total_items: data.length, total_pages: 1 }, data });
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

const mock = await mockWebUi();
const dataDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'perma-demo-'));
const child = spawn(process.execPath, [path.join(HERE, '..', 'server.js')], {
  env: { ...process.env, PERMABAN_DATA_DIR: dataDir, PERMABAN_PORT: process.env.DEMO_PORT || '8790',
    PERMABAN_START_PAUSED: '1', PERMABAN_BLOCKLIST_ENABLED: '0',   // offline demo: the imported list stays off
    PERMABAN_BASE_URL: `http://127.0.0.1:${mock.port}`, PERMABAN_USERNAME: CREDS.username, PERMABAN_PASSWORD: CREDS.password },
  stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
});
child.on('exit', (code) => { mock.server.close(); process.exit(code ?? 0); });
