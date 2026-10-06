import assert from 'node:assert/strict';
import test from 'node:test';
import { navigationPage, followSuggestion } from './chatNavigation.js';

test('suggestions navigate to existing pages only when followed', () => {
  const navigated = [];
  const action = { tool: 'suggest_page', page: 'find-place', title: 'Untrusted title' };
  assert.equal(navigationPage(action), 'Find a place');
  assert.deepEqual(navigated, []);
  assert.equal(followSuggestion(action, page => navigated.push(page)), true);
  assert.deepEqual(navigated, ['serve/find']);
});

test('page keys map to app routes, including the home page', () => {
  const navigated = [];
  for (const page of ['home', 'plan-visit', 'saved-connections', 'prayer-map'])
    followSuggestion({ tool: 'suggest_page', page }, route => navigated.push(route));
  assert.deepEqual(navigated, ['', 'guests/plan', 'serve/saved', 'prayer/map']);
});

test('unknown pages, external URLs, and request actions cannot navigate', () => {
  const navigated = [];
  for (const action of [null, { tool: 'request_connection', page: 'find-place' },
    ...['events', 'our-vision', 'serve/find', 'https://example.com', '__proto__', 'constructor'].map(page => ({ tool: 'suggest_page', page }))]) {
    assert.equal(navigationPage(action), null);
    assert.equal(followSuggestion(action, page => navigated.push(page)), false);
  }
  assert.deepEqual(navigated, []);
});

test('sections scroll to an allowlisted element and unknown sections fall back to the page top', () => {
  const calls = [];
  const go = (route, id) => calls.push([route, id]);
  const map = { tool: 'suggest_page', page: 'plan-visit', section: 'map' };
  assert.equal(navigationPage(map), 'Plan your visit · Map & directions');
  followSuggestion(map, go);
  for (const section of ['map', 'constructor', '__proto__', 'visit-map', '#top'])
    followSuggestion({ tool: 'suggest_page', page: 'home', section }, go);
  assert.equal(navigationPage({ tool: 'suggest_page', page: 'give', section: 'map' }), 'Give');
  assert.deepEqual(calls, [['guests/plan', 'visit-map'], ...Array(5).fill(['', undefined])]);
});
