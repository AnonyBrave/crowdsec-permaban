// Settings + credentials persistence, mirroring src/PermaBan.App/Services/SettingsStore.cs.
// Defaults are identical to AppSettings; the JSON is camelCase so it reads like the C# app's settings.json.
// Credentials never sit in plaintext: they go to `credentials.enc`, AES-256-GCM under a per-user random key file
// (the portable stand-in for DPAPI CurrentUser, which Node has no access to).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DEFAULT_SETTINGS = {
  // Placeholder only — set your own Web UI URL in Settings, or seed it on the first run with PERMABAN_BASE_URL.
  baseUrl: 'https://crowdsecwebui.example.com',
  username: '',
  password: '',
  pollIntervalSeconds: 60,
  webUiLookbackHours: 168,        // crowdsec.sync.lookback on the server; not exposed in the UI
  safeCountries: ['FR'],
  autoBanEnabled: true,
  permanentDuration: '876000h',   // Go ParseDuration, 100 years — no d/y allowed
  banScenario: 'manual/web-ui',
  banReasonPrefix: 'permaban',
  historyRetentionDays: 90,
  notificationsEnabled: true,
  notifyWebhookUrl: '',           // ntfy-style POST (topic URL) for auto-ban / candidate alerts
  notifyFormat: 'text',           // text = plain body + Title header; json = {"title","message"}

  // Imported lists: every enabled row permanent-bans its IPs with **its own** duration settings, `banScenario`, and prefix, is refreshed on its
  // own `refreshMinutes` schedule, and drives unban for the IPs it issued. The removal window measures from the first successful refresh that found
  // an IP missing from **every** enabled list ("union rule"); once open, the longest configured grace among the lists currently refreshing wins — so a
  // conservative list never lets a fast one unban an IP it still owns. `capPerCycle` bounds each row's own cycle load (bans + unbans), so a big list lands
  // over several cycles instead of flooding the Web UI at once. Default: borestad/blocklist-abuseipdb, 30-day s100 IPv4; ban scenario `blocklist/permaban`.
  blocklists: [{
    url: 'https://raw.githubusercontent.com/borestad/blocklist-abuseipdb/main/abuseipdb-s100-30d.ipv4',
    enabled: true,
    banScenario: 'blocklist/permaban',   // scenario sent on this row's bans; editable per list in the dedicated tab
    refreshMinutes: 60,      // minutes between list downloads for this URL; 60 = hourly
    unbanMinutes: 1440,      // grace window after the IP is first seen missing from every refreshing list (min 0)
    capPerCycle: 200,        // bans + unbans issued by THIS row in one cycle (min 1)
  }],

  startMinimized: true,
  initialized: false,             // set after the first baseline sync (no notification storm on run 1)
  scoring: {
    recidivistBanThreshold: 3,
    aggressiveEventThreshold: 1000,
    aggressiveScenarioThreshold: 2,
    eventWeight: 1.0,
    scenarioWeight: 100.0,
    banWeight: 500.0,
    safeCountryBanEnabled: true,
    safeCountryBanScore: 2500,
  },
};

/// One canonical row: floors keep a saved value on unparsable numbers, and an empty/missing `banScenario` keeps the shipped default. Same rules as every other settings field.
export function cleanBlockList(raw, fallback = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback ?? {};
  const url = String(src.url ?? fb.url ?? '').trim();
  const str = (key, def) => {
    const v = String(src[key] ?? fb[key] ?? def).trim();
    return v.length > 0 ? v : def;
  };
  const mins = (key, floor, def) => {
    const v = Math.floor(Number(src[key] ?? fb[key]));
    return Number.isFinite(v) && v >= floor ? v : def;
  };
  return {
    url,
    enabled: typeof src.enabled === 'boolean' ? src.enabled : (typeof fb.enabled === 'boolean' ? fb.enabled : true),
    banScenario: str('banScenario', 'blocklist/permaban'),   // editable scenario per list (default: blocklist/permaban)
    refreshMinutes: mins('refreshMinutes', 1, 60),       // 60 = hourly default
    unbanMinutes: mins('unbanMinutes', 0, 1440),         // 0 is meaningful: unban the cycle an IP leaves every list
    capPerCycle: mins('capPerCycle', 1, 200),            // bans + unbans issued by THIS row in one cycle
  };
}

/// A settings body (UI form / env seed target) → canonical rows. Rows without a URL are dropped; the order is preserved.
export function normalizeBlocklists(body) {
  const rows = Array.isArray(body) ? body : [];
  return rows.map((r) => cleanBlockList(r)).filter((r) => r.url);
}

/// Settings.json written by older builds: a single list as scalar keys (`blocklistEnabled`/`blocklistUrl`/…). One row,
/// same floors as the canonical schema. Returns null when no legacy URL is recorded — so defaults stay untouched.
function legacyBlocklists(loaded) {
  const url = typeof loaded.blocklistUrl === 'string' ? loaded.blocklistUrl.trim() : '';
  if (!url) return null;
  const v = (k, floor, def) => { const n = Math.floor(Number(loaded[k])); return Number.isFinite(n) && n >= floor ? n : def; };
  return [{
    url,
    enabled: loaded.blocklistEnabled !== false,
    banScenario: 'blocklist/permaban',   // the old scalar schema had no per-list scenario; migration uses the shipped default
    refreshMinutes: v('blocklistRefreshMinutes', 1, 60),
    unbanMinutes: v('blocklistUnbanMinutes', 0, 1440),
    capPerCycle: v('blocklistCapPerCycle', 1, 200),
  }];
}

function appDataBase() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

/// The data folder. `PERMABAN_DATA_DIR` overrides it (the same dev/test hook the C# app uses), and a relative
/// value is resolved to an absolute path so settings, credentials and event log stay together.
export function resolveDataDirectory(env = process.env) {
  const overlay = (env.PERMABAN_DATA_DIR ?? '').trim();
  if (overlay.length > 0) return path.resolve(overlay);
  return path.join(appDataBase(), 'PermaBanNode');
}

/// A writable folder to fall back to when the primary one is blocked (restricted token, locked profile).
export function scratchDataDirectory(env = process.env) {
  return path.join(env.TMPDIR ?? os.tmpdir(), 'PermaBanNode');
}

/// Container hook: environment variables seed settings on **first run** (no `settings.json` in the data folder
/// yet), so a container app can be configured entirely from its compose file. Once settings have been saved in
/// the UI, the file wins and PERMABAN_BASE_URL / PERMABAN_WEBHOOK_URL / PERMABAN_POLL_SECONDS are ignored.
/// Credentials are the exception: they never sit in `settings.json`, so PERMABAN_USERNAME/PASSWORD keep seeding
/// them while no encrypted side file exists (they land in credentials.enc on the first Save).
export function seedFromEnv(settings, env = process.env, { firstRun = true, seedCreds = true } = {}) {
  const applied = [];
  const setStr = (key, value) => {
    if (!value) return;                                 // empty env → nothing to do
    settings[key] = String(value);
    applied.push(key);
  };

  // Credentials: no place in settings.json, so env keeps seeding them until Save writes the encrypted side file.
  if (seedCreds && !settings.username) setStr('username', (env.PERMABAN_USERNAME ?? '').trim());
  if (seedCreds && !settings.password) setStr('password', (env.PERMABAN_PASSWORD ?? '').trim());

  // Everything else: first run only — there is no settings.json, so the compose file wins over defaults.
  if (firstRun) {
    setStr('baseUrl', (env.PERMABAN_BASE_URL ?? '').trim());
    setStr('notifyWebhookUrl', (env.PERMABAN_WEBHOOK_URL ?? '').trim());
    const raw = (env.PERMABAN_POLL_SECONDS ?? '').trim();          // unset/empty env leaves the default 60 alone
    if (raw) {
      const poll = Math.max(5, Math.floor(Number(raw)));
      if (Number.isFinite(poll)) { settings.pollIntervalSeconds = poll; applied.push('pollIntervalSeconds'); }
    }

    // Blocklist seeds map onto the **first** row of the lists array — the compose file picks a URL, its enabled switch,
    // schedule, grace window and cap. Saved rows always win: these env vars seed the first run only.
    if (!Array.isArray(settings.blocklists) || settings.blocklists.length === 0) {
      settings.blocklists = [{ url: '', enabled: true, banScenario: 'blocklist/permaban', refreshMinutes: 60, unbanMinutes: 1440, capPerCycle: 200 }];
    }
    const row = settings.blocklists[0];
    const seedRow = (envName, key, floor) => {
      const raw = (env[envName] ?? '').trim();   // empty env leaves the first row alone, exactly like every other seed
      if (!raw && key !== 'enabled') return;
      let v;
      if (key === 'url' || key === 'banScenario') { v = String(raw).trim(); }
      else if (key === 'enabled') { v = raw.toLowerCase() === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'; }
      else { const n = Math.floor(Number(raw)); if (!Number.isFinite(n) || n < floor) return; v = Math.max(floor, n); }
      row[key] = v; applied.push(`blocklists[0].${key}`);
    };
    seedRow('PERMABAN_BLOCKLIST_URL', 'url', 0);
    seedRow('PERMABAN_BLOCKLIST_SCENARIO', 'banScenario', 0);   // first-run scenario for this row (default blocklist/permaban when env is empty)
    const enRaw = (env.PERMABAN_BLOCKLIST_ENABLED ?? '').trim().toLowerCase();
    if (enRaw) { row.enabled = enRaw === '1' || enRaw === 'true' || enRaw === 'yes'; applied.push('blocklists[0].enabled'); }
    seedRow('PERMABAN_BLOCKLIST_REFRESH_MINUTES', 'refreshMinutes', 1);
    seedRow('PERMABAN_BLOCKLIST_UNBAN_MINUTES', 'unbanMinutes', 0);   // 0 is a valid value: unban the cycle an IP leaves every list
    seedRow('PERMABAN_BLOCKLIST_CAP_PER_CYCLE', 'capPerCycle', 1);
  }

  return applied;
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function mergeDefaults(loaded) {
  const s = deepClone(DEFAULT_SETTINGS);
  for (const k of Object.keys(s)) {
    if (loaded[k] === undefined) continue;
    if (k === 'scoring') s.scoring = { ...s.scoring, ...loaded.scoring };
    else s[k] = loaded[k];
  }
  if (Array.isArray(loaded.blocklists)) s.blocklists = normalizeBlocklists(loaded.blocklists);   // canonical rows, floors applied on reload too
  else { const legacy = legacyBlocklists(loaded); if (legacy) s.blocklists = legacy; }           // settings.json from an older single-list build
  return s;
}

export class SettingsStore {
  constructor(dir = resolveDataDirectory()) {
    this.dir = dir;
    this.warning = null;
    this.fileExisted = false;     // set by load(): `false` on the first run, so env seeding applies only then
    this.credsLoaded = false;     // true when credentials.enc + key.bin decrypted OK → env vars must not override
  }

  get settingsPath() { return path.join(this.dir, 'settings.json'); }
  get credentialsPath() { return path.join(this.dir, 'credentials.enc'); }
  get keyPath() { return path.join(this.dir, 'key.bin'); }

  load() {
    this.fileExisted = fs.existsSync(this.settingsPath);
    let settings = deepClone(DEFAULT_SETTINGS);   // must be `let`: the merge below reassigns it
    try {
      if (this.fileExisted) settings = mergeDefaults(JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')));
    } catch { /* corrupt settings → defaults, keep the file for inspection */ }

    this.credsLoaded = false;
    try {
      if (fs.existsSync(this.credentialsPath) && fs.existsSync(this.keyPath)) {
        const blob = JSON.parse(decrypt(this.credentialsPath, this.keyPath));
        settings.username = blob.username ?? '';
        settings.password = blob.password ?? '';
        this.credsLoaded = true;
      }
    } catch { /* unreadable credentials (different user/key/machine) → leave empty */ }

    return settings;
  }

  /// Persist non-credential settings, then encrypted credentials. A launch that cannot write the folder reports
  /// the failure and keeps running (the settings apply for this session), exactly like AppOrchestrator.ApplySettings.
  save(settings) {
    const problems = [];
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { problems.push(`mkdir ${this.dir}: ${e.message}`); }

    const withoutCreds = { ...settings, username: '', password: '' };
    try { fs.writeFileSync(this.settingsPath, JSON.stringify(withoutCreds, null, 2)); }
    catch (e) { problems.push(`settings.json: ${e.message}`); }

    try {
      const key = this._key();
      encrypt(this.credentialsPath, key, JSON.stringify({ username: settings.username, password: settings.password }));
    } catch (e) { problems.push(`credentials.enc: ${e.message}`); }

    this.warning = problems.length ? problems.join('; ') : null;
    return { ok: problems.length === 0, warning: this.warning };
  }

  _key() {
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });   // best effort on Windows
    return key;
  }
}

function encrypt(file, key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(file, Buffer.concat([iv, tag, data]).toString('base64'));
}

function decrypt(file, keyPath) {
  const key = fs.readFileSync(keyPath);
  const raw = Buffer.from(fs.readFileSync(file, 'utf8'), 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
