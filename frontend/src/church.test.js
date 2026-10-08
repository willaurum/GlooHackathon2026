import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_CHURCH, churchAddress, hashFor, isLanding, needsChurchInHash, resolveChurch, shareLink, slugFromHost, splitHash } from './church.js';

test('the bare address is the builder landing page; church links and subdomains are not', () => {
  for (const hash of ['', '#', '#/']) assert.equal(isLanding({ hash }), true, JSON.stringify(hash));
  for (const hash of ['#/serve', '#/c/grace-community/', '#/c/hope-chapel/serve', '#/new', '#/platform'])
    assert.equal(isLanding({ hash }), false, hash);
  // A church's own subdomain opens that church, not the builder.
  assert.equal(isLanding({ host: 'hope-chapel.tekton.example.org', hash: '', base: 'tekton.example.org' }), false);
  assert.equal(isLanding({ host: 'tekton.example.org', hash: '', base: 'tekton.example.org' }), true);
  // The landing route rewrites the address bar to the builder.
  assert.equal(hashFor(DEMO_CHURCH, 'new'), '#/new');
});

test('a subdomain wins when a base domain is set', () => {
  const r = resolveChurch({ host: 'hope-chapel.tekton.example.org', hash: '#/c/other-church/serve', saved: 'third', base: 'tekton.example.org' });
  assert.deepEqual(r, { slug: 'hope-chapel', source: 'subdomain', route: 'serve' });
  assert.equal(slugFromHost('tekton.example.org', 'tekton.example.org'), null);
  assert.equal(slugFromHost('a.b.tekton.example.org', 'tekton.example.org'), null);
  assert.equal(slugFromHost('hope-chapel.tekton.example.org:443', 'tekton.example.org'), 'hope-chapel');
  assert.equal(slugFromHost('hope-chapel.tekton.example.org', ''), null);
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

test('links name every church, the demo church too, except on a church subdomain', () => {
  assert.equal(hashFor(DEMO_CHURCH, 'serve'), '#/c/grace-community/serve');
  assert.equal(hashFor(DEMO_CHURCH, ''), '#/c/grace-community/');
  assert.equal(shareLink(DEMO_CHURCH, '', { origin: 'https://tekton.workers.dev', base: '' }), 'https://tekton.workers.dev/#/c/grace-community/');
  assert.equal(shareLink(DEMO_CHURCH, 'give', { origin: 'https://tekton.workers.dev', base: '' }), 'https://tekton.workers.dev/#/c/grace-community/give');
  assert.equal(hashFor('hope-chapel', 'serve'), '#/c/hope-chapel/serve');
  assert.equal(hashFor('hope-chapel', ''), '#/c/hope-chapel/');
  assert.equal(hashFor('hope-chapel', 'serve', 'subdomain'), '#/serve');
  assert.equal(shareLink('hope-chapel', 'give', { origin: 'https://site.test', base: '' }), 'https://site.test/#/c/hope-chapel/give');
  assert.equal(shareLink('hope-chapel', 'give', { base: 'tekton.example.org' }), 'https://hope-chapel.tekton.example.org/#/give');
});

test('a plain address gains its church, so copying the address bar keeps it', () => {
  assert.equal(needsChurchInHash('', 'demo'), true);
  assert.equal(needsChurchInHash('#/serve', 'saved'), true);
  assert.equal(needsChurchInHash('#/give/c/hope-chapel', 'link'), true);
  assert.equal(needsChurchInHash('#/c/hope-chapel/serve', 'link'), false);
  assert.equal(needsChurchInHash('#/serve', 'subdomain'), false);
  assert.equal(needsChurchInHash('#/platform', 'saved'), false);
  // The site builder and its preview belong to no church.
  assert.equal(needsChurchInHash('#/new', 'saved'), false);
  assert.equal(needsChurchInHash('#/new', 'demo'), false);
  assert.equal(needsChurchInHash('#/new/preview', 'preview'), false);
  assert.equal(needsChurchInHash('#/new/preview/serve', 'preview'), false);
  assert.equal(needsChurchInHash('#/new/preview/p/about', 'preview'), false);
  assert.equal(needsChurchInHash('#/c/grace-community/new', 'link'), true);
  assert.equal(hashFor(DEMO_CHURCH, 'new'), '#/new');
  // A checkout return (/give?session_id=…) keeps its address until the Give page has read it.
  assert.equal(needsChurchInHash('', 'link', true), false);
});

test('church addresses: the subdomain when on it or when a base domain is set, else the named link', () => {
  const at = { host: 'tekton.workers.dev', origin: 'https://tekton.workers.dev' };
  assert.equal(churchAddress(DEMO_CHURCH, { ...at, base: '' }), 'https://tekton.workers.dev/#/c/grace-community/');
  assert.equal(churchAddress('hope-chapel', { ...at, base: 'tekton.example.org' }), 'https://hope-chapel.tekton.example.org/#/');
  assert.equal(churchAddress('hope-chapel', { host: 'hope-chapel.tekton.example.org', origin: 'https://hope-chapel.tekton.example.org', base: 'tekton.example.org' }),
    'https://hope-chapel.tekton.example.org/');
});
