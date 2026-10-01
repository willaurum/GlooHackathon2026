import assert from 'node:assert/strict';
import test from 'node:test';
import { navigationPage, followSuggestion } from './chatNavigation.js';

test('suggestions navigate to existing pages only when followed', () => {
  const navigated = [];
  const action = { tool: 'suggest_page', page: 'find-place', title: 'Untrusted title' };
  assert.equal(navigationPage(action), 'Find a place');
  assert.deepEqual(navigated, []);
  assert.equal(followSuggestion(action, page => navigated.push(page)), true);
  assert.deepEqual(navigated, ['Find a place']);
});

test('unknown pages, external URLs, and request actions cannot navigate', () => {
  const navigated = [];
  for (const action of [null, { tool: 'request_connection', page: 'find-place' },
    ...['events', 'https://example.com', '__proto__', 'constructor'].map(page => ({ tool: 'suggest_page', page }))]) {
    assert.equal(navigationPage(action), null);
    assert.equal(followSuggestion(action, page => navigated.push(page)), false);
  }
  assert.deepEqual(navigated, []);
});
