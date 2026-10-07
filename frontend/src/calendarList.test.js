import assert from 'node:assert/strict';
import test from 'node:test';
import { eventsToList, isoDay, listHeading } from './calendarList.js';

const EVENTS = [
  { id: 1, title: 'Sunday worship', category: 'Worship', date: '2026-09-27', description: 'Songs' },
  { id: 2, title: 'Food drive', category: 'Outreach', date: '2026-10-03', description: 'Pack hampers' },
  { id: 3, title: 'Serve Day', category: 'Outreach', date: '2026-10-17', description: 'Yard work' },
  { id: 4, title: 'Worship night', category: 'Worship', date: '2026-11-06', description: 'Music and prayer' },
];
const ids = list => list.map(e => e.id);
const TODAY = '2026-10-07';

test('the list follows the month the grid shows', () => {
  assert.deepEqual(ids(eventsToList(EVENTS, { year: 2026, month: 9, today: TODAY })), [2, 3]);
  assert.deepEqual(ids(eventsToList(EVENTS, { year: 2026, month: 10, today: TODAY })), [4]);
  assert.deepEqual(ids(eventsToList(EVENTS, { year: 2026, month: 11, today: TODAY })), []);
  assert.equal(listHeading({ year: 2026, month: 10 }), 'Events in November 2026');
});

test('upcoming means today or later', () => {
  assert.deepEqual(ids(eventsToList(EVENTS, { view: 'upcoming', year: 2026, month: 8, today: TODAY })), [3, 4]);
  assert.deepEqual(ids(eventsToList(EVENTS, { view: 'upcoming', year: 2026, month: 8, today: '2026-10-17' })), [3, 4]);
  assert.equal(listHeading({ view: 'upcoming', year: 2026, month: 8 }), 'Upcoming events');
});

test('a picked day, a search and a category narrow the list', () => {
  assert.deepEqual(ids(eventsToList(EVENTS, { year: 2026, month: 9, selectedDate: '2026-10-17' })), [3]);
  assert.deepEqual(ids(eventsToList(EVENTS, { year: 2026, month: 9, query: 'music' })), [4]);
  assert.deepEqual(ids(eventsToList(EVENTS, { year: 2026, month: 9, category: 'Outreach' })), [2, 3]);
  assert.equal(listHeading({ year: 2026, month: 9, category: 'Outreach' }), 'Outreach events in October 2026');
  assert.equal(listHeading({ year: 2026, month: 9, query: 'music' }), 'Events matching "music"');
});

test('isoDay uses the local calendar day', () => {
  assert.equal(isoDay(new Date(2026, 9, 7, 23, 30)), '2026-10-07');
});
