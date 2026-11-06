// Notifications as webhook POSTs — the web edition has no tray balloons, so auto-ban / candidate alerts go to
// `notifyWebhookUrl` when it is set (ntfy: POST the topic URL with a text body and a `Title:` header).
// Zero dependencies: global fetch. Failures are thrown to the caller, which logs them as an activity line.

export async function postNotification(url, title, body, format = 'text', timeoutMs = 10_000) {
  const target = String(url ?? '').trim();
  if (!target) return null;                       // no webhook configured → nothing to do

  const json = format === 'json';
  const payload = json ? JSON.stringify({ title, message: body }) : `${title}\n${body}`;
  const resp = await fetch(target, {
    method: 'POST',
    headers: { ...(json ? { 'content-type': 'application/json' } : {}), title: asciiHeader(title) },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`webhook ${target} answered HTTP ${resp.status}`);
  return { status: resp.status };
}

/// HTTP header values are latin-1 only, so the em dash in `PermaBan — auto-ban issued` has to be transliterated;
/// the full text always travels in the body, which is what ntfy shows.
const asciiHeader = (s) => String(s ?? '')
  .replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/[^\x20-\x7E]/g, '');
