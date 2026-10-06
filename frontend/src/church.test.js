import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_CHURCH, hashFor, resolveChurch, shareLink, slugFromHost, splitHash } from './church.js';

test('a subdomain wins when a base domain is set', () => {
  const r = resolveChurch({ host: 'hope-chapel.belong.example.org', hash: '#/c/other-church/serve', saved: 'third', base: 'belong.example.org' });
  assert.deepEqual(r, { slug: 'hope-chapel', source: 'subdomain', route: 'serve' });
  assert.equal(slugFromHost('belong.example.org', 'belong.example.org'), null);
  assert.equal(slugFromHost('a.b.belong.example.org', 'belong.example.org'), null);
  assert.equal(slugFromHost('hope-chapel.belong.example.org:443', 'belong.example.org'), 'hope-chapel');
  assert.equal(slugFromHost('hope-chapel.belong.example.org', ''), null);
});

test('then a link that names the church', () => {
  assert.deepEqual(resolveChurch({ hash: '#/c/hope-chapel/serve/find', saved: 'other' }), { slug: 'hope-chapel', source: 'link', route: 'serve/find' });
  assert.deepEqual(resolveChurch({ hash: '#/c/hope-chapel' }), { slug: 'hope-chapel', source: 'link', route: '' });
  assert.deepEqual(resolveChurch({ hash: '#/give/c/hope-chapel' }), { slug: 'hope-chapel', source: 'link', route: 'give' });
  assert.deepEqual(splitHash('#/c/Not_A_Slug/serve'), { slug: null, route: '' });
});

test('then the saved church, then the demo church', () => {
  assert.deepEqual(resolveChurch({ hash: '#/serve', saved: 'hope-chapel' }), { slug: 'hope-chapel', source: 'saved', route: 'serve' });
  assert.deepEqual(resolveChurch({ hash: '#/serve' }), { slug: DEMO_CHURCH, source: 'demo', route: 'serve' });
  assert.deepEqual(resolveChurch({ hash: '', saved: '../x' }), { slug: DEMO_CHURCH, source: 'demo', route: '' });
});

test('links keep the demo church short and name every other church', () => {
  assert.equal(hashFor(DEMO_CHURCH, 'serve'), '#/serve');
  assert.equal(hashFor('hope-chapel', 'serve'), '#/c/hope-chapel/serve');
  assert.equal(hashFor('hope-chapel', ''), '#/c/hope-chapel/');
  assert.equal(hashFor('hope-chapel', 'serve', 'subdomain'), '#/serve');
  assert.equal(shareLink('hope-chapel', 'give', { origin: 'https://site.test', base: '' }), 'https://site.test/#/c/hope-chapel/give');
  assert.equal(shareLink('hope-chapel', 'give', { base: 'belong.example.org' }), 'https://hope-chapel.belong.example.org/#/give');
});
