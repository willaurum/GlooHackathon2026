import assert from 'node:assert/strict';
import { test } from 'node:test';
import { churchLink, filterChurches } from './platformChurches.js';

const churches = [
  { slug: 'grace-community', name: 'Grace Community', city: 'Springfield' },
  { slug: 'hope-chapel', name: 'Hope Chapel', city: 'Austin, TX' },
  { slug: 'hope-chapel-2', name: 'Hope Chapel', city: 'Dallas' },
];

test('an empty search shows every church', () => {
  assert.equal(filterChurches(churches, '').length, 3);
  assert.equal(filterChurches(churches, '   ').length, 3);
});

test('search matches name, city or slug, any case, every word', () => {
  assert.deepEqual(filterChurches(churches, 'hope').map(c => c.slug), ['hope-chapel', 'hope-chapel-2']);
  assert.deepEqual(filterChurches(churches, 'HOPE dallas').map(c => c.slug), ['hope-chapel-2']);
  assert.deepEqual(filterChurches(churches, 'chapel-2').map(c => c.slug), ['hope-chapel-2']);
  assert.deepEqual(filterChurches(churches, 'springfield').map(c => c.slug), ['grace-community']);
  assert.deepEqual(filterChurches(churches, 'nowhere'), []);
});

test('church links always name the church, the demo church too', () => {
  assert.equal(churchLink('grace-community'), '#/c/grace-community/');
  assert.equal(churchLink('hope-chapel', 'give'), '#/c/hope-chapel/give');
  assert.equal(churchLink('hope-chapel', 'setup', { base: 'belong.example.org' }), 'https://hope-chapel.belong.example.org/#/setup');
});
