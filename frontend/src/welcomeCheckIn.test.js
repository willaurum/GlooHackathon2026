import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInChoices, cleanGuestName, enterAction, matchPlannedGuests, nameKey } from './welcomeCheckIn.js';

const planned = [
  { visit_id: 1, name: 'Pat Example' },
  { visit_id: 2, name: 'José López' },
  { visit_id: 3, name: 'Patricia Stone' },
];

test('typed names are cleaned and compared without case, accents or extra spaces', () => {
  assert.equal(cleanGuestName('  Sam   New\tcomer  '), 'Sam New comer');
  assert.equal(cleanGuestName(undefined), '');
  assert.equal(cleanGuestName('x'.repeat(150)).length, 100);
  assert.equal(nameKey('  JOSÉ   López '), 'jose lopez');
});

test('a typed name matches planned guests by every word, in any order', () => {
  assert.deepEqual(matchPlannedGuests(planned, '  pat ').map(v => v.visit_id), [1, 3]);
  assert.deepEqual(matchPlannedGuests(planned, 'example PAT').map(v => v.visit_id), [1]);
  assert.deepEqual(matchPlannedGuests(planned, 'jose lopez').map(v => v.visit_id), [2]);
  assert.deepEqual(matchPlannedGuests(planned, '   '), []);
  assert.deepEqual(matchPlannedGuests([], 'pat'), []);
  assert.deepEqual(matchPlannedGuests(undefined, 'pat'), []);
});

test('any typed name gets a check-in button, even with no sign-ups at all', () => {
  const none = checkInChoices([], 'Sam Newcomer');
  assert.deepEqual(none, { name: 'Sam Newcomer', matches: [], here: [], offerNew: true });
  assert.deepEqual(enterAction(none), { newGuest: true });
  assert.equal(checkInChoices(planned, '').offerNew, false);
});

test('a partial match offers the planned guest and a new guest; an exact match only the planned guest', () => {
  const partial = checkInChoices(planned, 'pat');
  assert.deepEqual(partial.matches.map(v => v.visit_id), [1, 3]);
  assert.equal(partial.offerNew, true);
  assert.equal(enterAction(partial), null);

  const exact = checkInChoices(planned, ' pat  EXAMPLE ');
  assert.deepEqual(exact.matches.map(v => v.visit_id), [1]);
  assert.equal(exact.offerNew, false);
  assert.deepEqual(enterAction(exact), { visit: planned[0] });
});

test('a guest who is already waiting is shown as here, not checked in twice', () => {
  const choices = checkInChoices(planned, 'Sam Newcomer', [{ visit_id: 9, name: 'Sam Newcomer' }]);
  assert.deepEqual(choices.here.map(v => v.visit_id), [9]);
  assert.equal(choices.offerNew, false);
  assert.equal(enterAction(choices), null);
});
