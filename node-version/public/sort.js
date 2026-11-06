// Grid sorting + filtering, shared by the page (a module script) and the test suite. Plain ESM, no DOM.
// Sorting is stable: equal values keep their incoming order, which is the server's own ranking.

export function sortRows(rows, key, dir = -1) {
  const list = rows.map((r, i) => [r, i]);
  if (!key || dir === 0) return list.map(([r]) => r);
  list.sort((a, b) => compare(a[0][key], b[0][key]) * dir || a[1] - b[1]);
  return list.map(([r]) => r);
}

export function compare(a, b) {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA && emptyB) return 0;
  if (emptyA) return -1;                       // empties come first when ascending, last when descending
  if (emptyB) return 1;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = String(a), sb = String(b);        // ISO-8601 timestamps compare as plain strings
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/// Case-insensitive substring filter over the listed keys — the grid's filter box.
export function filterRows(rows, text, keys) {
  const q = String(text ?? '').trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter((r) => keys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
}
