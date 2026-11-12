// Parser tests for the imported blocklist format: borestad/blocklist-abuseipdb lines (`IP   # CN AS… owner`), plus
// CSV rows, CIDR prefixes, header comments, CRLF, BOM. Private/loopback/link-local/multicast addresses are dropped on
// purpose — a public list must never freeze a LAN host (documented in the README). No download is tested here; the
// pipeline owns that seam offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocklist } from '../core/blocklist.js';

test('Parse_ReadsIpPerLineAndStripsCommentTails', () => {
  const text = [
    '# abuseipdb-s100-30d generated header',
    '# Confidence ~100%, updated several times a day.',
    '1.0.164.165      # TH  AS23969   TOT Public Company Limited',
    '185.222.173.19  # RU',
    '',
    '   ',
    '# commented out: 8.8.8.8',
    '203.0.113.42#no space before the comment marker',
  ].join('\n');

  const ips = parseBlocklist(text);
  assert.deepEqual([...ips].sort(), ['1.0.164.165', '185.222.173.19', '203.0.113.42']);
});

test('Parse_AcceptsCsvCidrCrlfBomAndDedupes', () => {
  const text = '\uFEFF' + [
    '5.6.7.8,first-of-a-csv-row,more fields',
    '192.0.2.0/24   # CIDR row → the base address is what gets banned',
    '5.6.7.8   # duplicate of the CSV line above',
    '198.51.100.7',
  ].join('\r\n');

  const ips = parseBlocklist(text);
  assert.deepEqual([...ips].sort(), ['192.0.2.0', '198.51.100.7', '5.6.7.8']);   // Set: the duplicate counts once
});

test('Parse_DropsJunkAndPrivateRangesFromAPublicList', () => {
  const text = [
    '256.1.1.1',       // not an address at all → ignored
    'not-an-ip',       // garbage token
    '10.20.30.40',     // 10/8 private
    '172.20.1.5',      // 172.16/12 private
    '192.168.9.9',     // 192.168/16 private
    '127.0.0.1',       // loopback
    '169.254.1.1',     // link-local
    '100.64.0.1',      // CGNAT 100.64/10 — carriers use it, blocking a host here breaks connectivity for the wrong reason
    '224.0.0.5',       // multicast
    '8.8.8.8',         // public → kept
  ].join('\n');

  assert.deepEqual([...parseBlocklist(text)], ['8.8.8.8']);
});

test('Parse_Ipv6CanonicalFormsAreLowercasedAndPrivateOnesDropped', () => {
  const text = [
    '2001:DB8::1   # canonical compression → stored lowercase',
    '2001:db8:0:0:0:0:0:99   # full eight groups',
    'fe80::1   # link-local, dropped',
    'ff02::1   # multicast, dropped',
    'fd12:3456::   # unique local fc/fd range, dropped',
    '::   # unspecified, dropped',
    '::1   # loopback, dropped',
    'fe80::1%eth0   # zone id is not a ban target',
    '[2001:db8::5]   # bracketed URL form: the token does not parse as an address',
    '2001::2::3   # more than one compression marker, malformed → ignored',
  ].join('\n');

  const ips = parseBlocklist(text);
  assert.deepEqual([...ips].sort(), ['2001:db8:0:0:0:0:0:99', '2001:db8::1']);
});

test('Parse_EmptyAndNullInputYieldNothing', () => {
  assert.equal(parseBlocklist('').size, 0);
  assert.equal(parseBlocklist(null).size, 0);
  assert.equal(parseBlocklist('# only header comments\n# nothing else').size, 0);
});
