// Notification seam: the webhook POST (ntfy-style) that replaces the old tray balloons, and the pipeline gate
// around it — `notificationsEnabled` off means no notification at all, and a failing webhook becomes an activity
// line (`NOTIFY FAILED …`) instead of breaking the cycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postNotification } from '../core/notify.js';
import { EventStore } from '../core/store.js';
import { Pipeline } from '../core/pipeline.js';

/// A receiver answering 200 on /ok and 404 everywhere else, recording every POST it sees.
function mockWebhook() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, title: req.headers.title, 'content-type': req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(req.url === '/ok' ? 200 : 404, { 'content-type': 'application/json', connection: 'close' });   // end the socket so nothing keeps the process alive
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, () => resolve({ close: () => { srv.close(); srv.closeAllConnections?.(); }, hits, url: (p) => `http://127.0.0.1:${srv.address().port}${p}` })));
}

const settings = (over = {}) => ({ notificationsEnabled: true, notifyFormat: 'text', ...over });

function pipelineWith(s, log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perma-notify-'));
  return new Pipeline({ getSettings: () => s, store: EventStore.open(dir), source: {}, log });
}

test('PostNotification_TextFormatSendsTitleHeaderAndPlainBody', async () => {
  const w = await mockWebhook();
  await postNotification(w.url('/ok'), 'PermaBan — auto-ban issued', '1.2.3.4 — recidivist (3 bans)', 'text');

  assert.equal(w.hits.length, 1);
  const hit = w.hits[0];
  assert.equal(hit.method, 'POST');
  assert.equal(hit.url, '/ok');
  assert.equal(hit.title, 'PermaBan - auto-ban issued');       // HTTP headers are latin-1: the em dash is transliterated
  assert.ok(hit.body.startsWith('PermaBan — auto-ban issued\n'));   // the full text (with the em dash) travels in the body
  assert.equal(hit['content-type'], 'text/plain;charset=UTF-8');   // plain text body, not JSON (node's fetch sets this itself)
  assert.equal(hit.body, 'PermaBan — auto-ban issued\n1.2.3.4 — recidivist (3 bans)');

  w.close();
});

test('PostNotification_JsonFormatSendsTitleAndMessage', async () => {
  const w = await mockWebhook();
  await postNotification(w.url('/ok'), 'PermaBan — new candidate(s)', '4.5.6.7 — recidivist (3 bans)', 'json');

  assert.equal(w.hits[0]['content-type'], 'application/json');
  // JSON carries UTF-8 freely, so the title keeps its em dash; only the header is transliterated.
  assert.deepEqual(JSON.parse(w.hits[0].body), { title: 'PermaBan — new candidate(s)', message: '4.5.6.7 — recidivist (3 bans)' });

  w.close();
});

test('PostNotification_Non2xxAnswersThrow', async () => {
  const w = await mockWebhook();
  await assert.rejects(() => postNotification(w.url('/missing'), 'T', 'B'), /HTTP 404/);
  w.close();
});

test('PostNotification_NoUrlIsANoOp', async () => {
  assert.equal(await postNotification('', 'T', 'B'), null);
  assert.equal(await postNotification('   ', 'T', 'B'), null);
});

test('Pipeline_NotificationsOffSkipsTheNotifier', async () => {
  const seen = [];
  const p = pipelineWith(settings({ notificationsEnabled: false }), (l) => seen.push(l));
  p.notifier = (title, body) => { seen.push(`NOTIFIED ${title}: ${body}`); };

  await p.notify('PermaBan — auto-ban issued', 'x');
  assert.equal(seen.length, 0);

  const q = pipelineWith(settings(), () => {});
  const got = [];
  q.notifier = (title, body) => got.push(`${title}: ${body}`);
  await q.notify('PermaBan — new candidate(s)', 'y');
  assert.deepEqual(got, ['PermaBan — new candidate(s): y']);   // gate on → the notifier runs
});

test('Pipeline_FailingNotifierBecomesAnActivityLineNotACycleCrash', async () => {
  const logs = [];
  const p = pipelineWith(settings(), (l) => logs.push(l));
  p.notifier = () => { throw new Error('webhook http://127.0.0.1:9 answered HTTP 500'); };

  await p.notify('PermaBan — auto-ban issued', 'x');           // resolves, never throws
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^NOTIFY FAILED PermaBan — auto-ban issued: webhook .* HTTP 500$/);
});
