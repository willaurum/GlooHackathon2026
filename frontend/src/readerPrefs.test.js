import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PREFS, PREFS_KEY, TEXT_SIZES, canStep, clampSize, formatNoteDate, pickCurrent, readPrefs, statusLabel, stepSize, textSizePx, writePrefs } from './readerPrefs.js';

const memory = (init = {}) => {
  const data = { ...init };
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
};

test('text size steps stop at both ends', () => {
  assert.equal(stepSize(DEFAULT_PREFS.size, 1), DEFAULT_PREFS.size + 1);
  assert.equal(stepSize(0, -1), 0);
  assert.equal(stepSize(TEXT_SIZES.length - 1, 1), TEXT_SIZES.length - 1);
  assert.equal(stepSize(1, 2), 3);
  assert.equal(canStep(0, -1), false);
  assert.equal(canStep(0, 1), true);
  assert.equal(canStep(TEXT_SIZES.length - 1, 1), false);
});

test('bad size indexes fall back or clamp', () => {
  assert.equal(clampSize('3'), DEFAULT_PREFS.size);
  assert.equal(clampSize(1.5), DEFAULT_PREFS.size);
  assert.equal(clampSize(-4), 0);
  assert.equal(clampSize(99), TEXT_SIZES.length - 1);
  assert.equal(textSizePx(DEFAULT_PREFS.size), TEXT_SIZES[DEFAULT_PREFS.size]);
});

test('the default transcript size is bigger than the old 15px', () => {
  assert.ok(textSizePx(DEFAULT_PREFS.size) > 15);
});

test('prefs round-trip through storage', () => {
  const s = memory();
  assert.deepEqual(readPrefs(s), DEFAULT_PREFS);
  assert.equal(writePrefs(s, { size: 3, timestamps: false }), true);
  assert.deepEqual(JSON.parse(s.data[PREFS_KEY]), { size: 3, timestamps: false });
  assert.deepEqual(readPrefs(s), { size: 3, timestamps: false });
});

test('junk or missing storage gives the defaults', () => {
  assert.deepEqual(readPrefs(memory({ [PREFS_KEY]: '{not json' })), DEFAULT_PREFS);
  assert.deepEqual(readPrefs(memory({ [PREFS_KEY]: '42' })), DEFAULT_PREFS);
  assert.deepEqual(readPrefs(memory({ [PREFS_KEY]: '{"size":"big","timestamps":"no"}' })), DEFAULT_PREFS);
  assert.deepEqual(readPrefs(memory({ [PREFS_KEY]: '{"size":40}' })), { size: TEXT_SIZES.length - 1, timestamps: true });
  assert.deepEqual(readPrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(readPrefs({ getItem() { throw new Error('denied'); } }), DEFAULT_PREFS);
  assert.equal(writePrefs({ setItem() { throw new Error('quota'); } }, DEFAULT_PREFS), false);
});

test('note dates', () => {
  assert.equal(formatNoteDate('2026-10-05'), 'Oct 5, 2026');
  assert.equal(formatNoteDate('2026-10-05 14:30:00', 'UTC'), 'Oct 5, 2026');
  assert.equal(formatNoteDate('2026-10-05T23:30:00Z', 'UTC'), 'Oct 5, 2026');
  assert.equal(formatNoteDate(Date.UTC(2026, 0, 2), 'UTC'), 'Jan 2, 2026');
  assert.equal(formatNoteDate(''), '');
  assert.equal(formatNoteDate(null), '');
  assert.equal(formatNoteDate('soon'), '');
});

test('status labels', () => {
  assert.equal(statusLabel('processing'), 'Transcribing');
  assert.equal(statusLabel('queued'), 'Queued');
  assert.equal(statusLabel('failed'), 'Failed');
  assert.equal(statusLabel('odd'), 'odd');
});

test('the open sermon: route first, then newest ready', () => {
  const notes = [{ id: 'a', status: 'processing' }, { id: 'b', status: 'ready' }, { id: 'c', status: 'ready' }];
  assert.equal(pickCurrent(notes, null).id, 'b');
  assert.equal(pickCurrent(notes, 'a').id, 'a');
  assert.equal(pickCurrent(notes, 'zzz'), null);
  assert.equal(pickCurrent([{ id: 'a', status: 'failed' }], null).id, 'a');
  assert.equal(pickCurrent([], null), null);
});
