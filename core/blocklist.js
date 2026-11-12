// Imported blocklist: download a plain-text IP list and read the IPs out of it, zero dependencies (global fetch).
// The format this app ships for is borestad/blocklist-abuseipdb (`abuseipdb-s100-30d.ipv4` and its siblings): one IP
// per line, metadata after a `#`, header comments starting with `#`. It accepts anything that has one IP at the start
// of each line — plain IPs, CSV rows, CIDR prefixes (the base address is used), CRLF, BOM, blank lines.
// IPv4 and IPv6 both parse. Addresses nobody should ban from a public list (private, loopback, link-local,
// multicast, and the 0.0.0.0/64.0.0.0-ish junk ranges) are dropped so one malformed list cannot freeze a LAN host
// — that choice is documented in the README as well.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;
const IPV6_FULL = /^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/i;
const IPV6_COMPRESSED = /^([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){0,5}$/i;   // includes the "::" forms

function isIpv4(s) {
  if (!IPV4.test(s)) return false;
  return s.split('.').every((p) => Number(p) <= 255);
}

// Deliberately conservative: no IPv6 parser, only recognising the canonical textual shapes. A token like
// `fe80::1%eth0` (zone id) is not an address anyone wants banned as a literal string.
function isIpv6(s) {
  if (!IPV6_RE.test(s) || !s.includes(':')) return false;
  const t = s.toLowerCase();
  if (t.includes('%') || t.startsWith('[')) return false;
  if (IPV6_FULL.test(t) && t.split(':').filter(Boolean).length === 8) return true;
  // A single `::` collapse is the common form in these lists.
  const parts = t.split('::');
  if (parts.length !== 2) return false;   // more than one compression marker → malformed token
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  return left.length + right.length <= 7 && [...left, ...right].every((g) => /^[0-9a-f]{1,4}$/.test(g));
}

function isPrivateV4(ip) {
  const a = ip.split('.').map(Number);
  if (a[0] === 10 || a[0] === 127) return true;                     // 10/8, loopback
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;        // 172.16/12
  if (a[0] === 192 && a[1] === 168) return true;                    // 192.168/16
  if (a[0] === 169 && a[1] === 254) return true;                    // link-local
  if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return true;       // CGNAT 100.64/10
  if (a[0] >= 224) return true;                                     // multicast + reserved
  return false;
}

function isPrivateV6(ip) {
  const t = ip.toLowerCase();
  if (t === '::' || t === '::1') return true;                       // unspecified / loopback
  if (/^fe80/.test(t)) return true;                                 // link-local
  if (/^ff[0-9a-f]/.test(t)) return true;                           // multicast
  if (/^f[0-9a-f][0-9a-f][0-9a-f]/.test(t)) return true;           // unique local fc00::/7 (fc/fd)
  return false;
}

/// Parse one downloaded list body into the set of addresses to manage. Comments, headers, and everything after `#`
/// are stripped; only exact IP tokens survive.
export function parseBlocklist(text) {
  const ips = new Set();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/^\uFEFF/, '');   // strip CRLF tail + byte-order mark
    if (!line || line.startsWith('#')) continue;
    let token = line.split(/\s+/)[0].split(',')[0];           // first field of CSV rows too
    const hash = token.indexOf('#');                          // `IP # CN AS…` comment tail
    if (hash >= 0) token = token.slice(0, hash);
    const slash = token.indexOf('/');                        // CIDR row: the base address is what gets banned
    if (slash >= 0) token = token.slice(0, slash);
    token = token.trim();
    if (!token) continue;
    if (token.includes(':')) {
      if (isIpv6(token) && !isPrivateV6(token)) ips.add(token.toLowerCase());   // v6 tokens are normalized to lowercase
      continue;
    }
    if (isIpv4(token) && !isPrivateV4(token)) ips.add(token);
  }
  return ips;
}

/// Download the list body. Same global fetch + AbortSignal.timeout as the Web UI client; a slow/big list gets its
/// time, one that fails is reported by the caller (the pipeline logs it and keeps its previous state).
export async function fetchBlocklist(url, timeoutMs = 90_000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return await resp.text();
}
