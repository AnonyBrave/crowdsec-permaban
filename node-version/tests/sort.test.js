// Grid sorting + filtering helpers (public/sort.js), the code behind the clickable headers and filter boxes:
// numeric columns sort numerically, ISO timestamps sort as strings, empties go to one end, ties keep the
// server's own ranking order, and the filter box matches any of its keys case-insensitively.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortRows, compare, filterRows } from '../public/sort.js';

const rows = [
  { ip: 'b', score: 100, ts: '2026-11-01T00:00:00.000Z', country: '' },
  { ip: 'a', score: 500, ts: '2026-11-03T00:00:00.000Z', country: 'US' },
  { ip: 'c', score: 300, ts: null, country: 'FR' },
];

test('SortRows_NumericDescendingThenAscending', () => {
  assert.deepEqual(sortRows(rows, 'score', -1).map((r) => r.ip), ['a', 'c', 'b']);
  assert.deepEqual(sortRows(rows, 'score', 1).map((r) => r.ip), ['b', 'c', 'a']);
});

test('SortRows_StringsAndIsoTimestamps', () => {
  assert.deepEqual(sortRows(rows, 'ip', 1).map((r) => r.ip), ['a', 'b', 'c']);
  // Empty timestamps sit at the low end: ascending first, descending last.
  assert.deepEqual(sortRows(rows, 'ts', 1).map((r) => r.ts), [null, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z']);
  assert.deepEqual(sortRows(rows, 'ts', -1).map((r) => r.ts), ['2026-11-03T00:00:00.000Z', '2026-11-01T00:00:00.000Z', null]);
});

test('SortRows_IsStableOnTies_AndDoesNotMutateInput', () => {
  const tied = [{ ip: 'x', score: 7 }, { ip: 'y', score: 7 }, { ip: 'z', score: 7 }];
  assert.deepEqual(sortRows(tied, 'score', -1).map((r) => r.ip), ['x', 'y', 'z']);

  const input = [{ ip: 'q', score: 2 }, { ip: 'w', score: 9 }];
  sortRows(input, 'score', -1);
  assert.deepEqual(input.map((r) => r.ip), ['q', 'w']);   // the incoming rows are untouched
});

test('SortRows_NoKeyKeepsTheServerOrder', () => {
  assert.deepEqual(sortRows(rows, null, -1).map((r) => r.ip), ['b', 'a', 'c']);
});

test('Compare_KnowsNumbersAndText', () => {
  assert.equal(compare(2, 10), -1);           // numeric: 2 < 10
  assert.equal(compare('2', '10'), -1);       // digit strings are read as numbers too (scores stored as text stay ordered)
  assert.equal(compare('ab', 'ba'), -1);      // plain text compares as text
  assert.equal(compare(null, null), 0);
  assert.equal(compare('', 'FR'), -1);
});

test('FilterRows_MatchesAnyListedKeyCaseInsensitively', () => {
  const keep = ['ip', 'country'];
  assert.deepEqual(filterRows(rows, 'A', keep).map((r) => r.ip), ['a']);
  assert.deepEqual(filterRows(rows, 'fr', keep).map((r) => r.ip), ['c']);
  assert.equal(filterRows(rows, '', keep).length, 3);          // empty box shows everything
  assert.equal(filterRows(rows, 'zz', keep).length, 0);
});
