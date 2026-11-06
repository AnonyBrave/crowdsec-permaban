// Chart geometry for the dashboard, pure functions with no DOM so they can be unit-tested in Node and served
// through /api/inspect: the events-per-day sparkline (bars + labels as numbers) and bar-row track widths (CSS %).
// Heights are sqrt-compressed: one huge day must not flatten every other day into an invisible line,
// and a small non-zero day always keeps a visible stub. The exact number is printed above each bar, inside the
// viewBox, so the compression only affects perception of proportions — never the numbers shown.

export const SPARK_VIEW_W = 560;
export const SPARK_VIEW_H = 92;
const BARS_TOP = 20;          // bars grow up from AXIS_BASELINE to here at full scale: the max bar (50 units)
                              // stays below the number band, so a clamped label never buries inside its own bar
const AXIS_BASELINE = 70;     // the axis line: every bar stands on it, hairlines for zero days included
const ZERO_MARK_H = 2;        // a day with no events is a muted stub — visible, never a bar
const MIN_POS_BAR_H = 6;      // any day with events ≥ 1 keeps this minimum height
const TEXT_GAP = 4;           // gap between the number and the top of its bar
const TOP_PAD = 2;            // numbers never touch the top edge
const AXIS_TEXT_Y = 84;       // date labels under the baseline
const SLOT_GAP = 3;           // empty space between neighbouring bars

const BAR_FILL = '#4ac1ff';   // days with events
const ZERO_FILL = '#6a7078';  // quiet days, muted

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num2 = (v) => Number(v.toFixed(2));   // coordinates stay serializable numbers, not strings

/// Scenario labels: CrowdSec names come as `crowdsecurity:sshd-max` / `crowdsecurity/…`; the vendor prefix is
/// noise in a chart. Returns { name, full } — the short label goes on the row, the untouched name stays in its tooltip.
export function shortScenario(name) {
  const full = String(name ?? '');
  for (const p of ['crowdsecurity/', 'crowdsecurity:'])   // both vendor-prefix spellings
    if (full.startsWith(p)) return { name: full.slice(p.length), full };
  return { name: full, full };
}

/// Bar-row track width as % of the row, relative to `max` (the biggest value shown). Zero → a thin nothing.
export function barWidthPct(value, max) {
  const m = Math.max(1, Number(max));
  return Math.max(0, Math.min(100, (Number(value) / m) * 100));
}

/// The events-per-day chart as numbers. `daily` is [{date:'YYYY-MM-DD',events}] for a fixed window — gaps
/// included, every day answers with zero when nothing happened. Bars: x,y,width,height,fill (the geometry the
/// page draws); labels: y,x,label of each printed number. The app joins them to SVG strings, `parts` is the same.
export function sparkBars(daily, opts = {}) {
  const viewW = opts.viewW ?? SPARK_VIEW_W;
  const viewH = opts.viewH ?? SPARK_VIEW_H;
  const axisBaseline = opts.axisBaselineY ?? AXIS_BASELINE;
  const barsTop = opts.barsTop ?? BARS_TOP;
  const zeroMarkH = opts.zeroMarkH ?? ZERO_MARK_H;
  const minPosBarH = Math.max(opts.minPositiveBarH ?? MIN_POS_BAR_H, zeroMarkH);
  const textGap = opts.textGap ?? TEXT_GAP;
  const topPad = opts.topPad ?? TOP_PAD;

  const days = Array.isArray(daily) ? daily : [];
  const max = Math.max(1, ...days.map((d) => Number(d.events)));
  const scale = (axisBaseline - barsTop) / Math.sqrt(max);   // height = √events · scale: the top day fills the band,
                                                            // and every other big day keeps its own height (√ of a
                                                            // ratio compresses — multiplying events by this scale would
                                                            // saturate everything above ~√max at the same bar)
  const slotW = (viewW - 8) / Math.max(1, days.length);      // 4 px padding on each edge

  const bars = [];
  const labels = [];
  days.forEach((d, i) => {
    const events = Number(d.events);
    const x = num2(4 + i * slotW), w = Math.max(2, num2(slotW - SLOT_GAP));
    let h;
    if (events > 0) h = Math.min(axisBaseline - barsTop, Math.max(minPosBarH, Math.sqrt(events) * scale));
    else h = zeroMarkH;   // a muted stub above the baseline, not a hairline under the numbers
    const top = num2(axisBaseline - h);
    bars.push({ x, y: top, width: w, height: num2(h), fill: events > 0 ? BAR_FILL : ZERO_FILL, zero: events <= 0, day: d });
    labels.push({ x: num2(x + 1), y: Math.max(topPad + 9.5, num2(axisBaseline - h - textGap)), label: d.eventsLabel ?? String(events), date: d.date });
  });

  const dateLabels = days.map((d, i) => ({ x: num2(4 + i * slotW + 1), y: AXIS_TEXT_Y, label: esc(String(d.date ?? '').slice(5)) }));

  return {
    viewBox: `0 0 ${viewW} ${viewH}`,
    axisBaseline,
    bars, labels, dateLabels,
    parts: [
      `<line x1="4" y1="${axisBaseline}" x2="${viewW - 4}" y2="${axisBaseline}" class="base"/>`,
      ...bars.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${b.fill}" rx="1.5"/>`),
      ...labels.map((t) => `<text x="${t.x}" y="${t.y}" class="val">${esc(t.label)}</text>`),
      ...dateLabels.map((t) => `<text x="${t.x}" y="${t.y}" class="ax">${t.label}</text>`),
    ],
  };
}
