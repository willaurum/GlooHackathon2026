// Which church a request is for, and who may call what. Run: node --test api/test/
// (Node 22.18+ loads the TypeScript directly.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, churchHeaders, churchPath, findChurch, isStaff, onBaseDomain } from '../churches.ts';

// A stand-in for the giving Worker: two churches, one staff token each.
const TOKENS = { ['a'.repeat(32)]: 'hope-chapel', ['b'.repeat(32)]: 'other-church' };
const giving = {
  async fetch(url, init = {}) {
    const path = new URL(url).pathname;
    let m = /^\/api\/directory\/(.+)/.exec(path);
    if (m) return m[1] in { 'hope-chapel': 1, 'other-church': 1 } ? Response.json({ slug: m[1], name: m[1] === 'hope-chapel' ? 'Hope Chapel' : 'Other Church', city: 'Austin' }) : Response.json({}, { status: 404 });
    m = /^\/api\/churches\/([^/]+)\/admin\/session/.exec(path);
    const token = (new Headers(init.headers).get('Authorization') || '').replace('Bearer ', '');
    if (m && TOKENS[token] === m[1]) return Response.json({ ok: true, slug: m[1] });
    return Response.json({ error: 'no' }, { status: 401 });
  },
};
const env = { GIVING: giving };
const asStaff = (token) => new Request('https://api.test/', { headers: { Authorization: 'Bearer ' + token } });

test('a bare /api path is the demo church; a prefix names the church', () => {
  assert.deepEqual(churchPath('/api/ministries'), { slug: 'grace-community', path: '/api/ministries' });
  assert.deepEqual(churchPath('/api/churches/hope-chapel/ministries'), { slug: 'hope-chapel', path: '/api/ministries' });
  assert.deepEqual(churchPath('/api/churches/hope-chapel/notes/x/ask'), { slug: 'hope-chapel', path: '/api/notes/x/ask' });
  assert.deepEqual(churchPath('/api/churches/hope-chapel'), { slug: 'hope-chapel', path: '/api/church' });
  assert.equal(churchPath('/api/churches/..%2Fmain/info'), null);
  assert.equal(churchPath('/api/churches/Bad_Slug/info'), null);
});

test('the registry decides which churches exist', async () => {
  assert.equal((await findChurch(env, 'grace-community')).demo, true);
  assert.deepEqual(await findChurch(env, 'hope-chapel'), { slug: 'hope-chapel', name: 'Hope Chapel', city: 'Austin', demo: false });
  assert.equal(await findChurch(env, 'no-such-church'), null);
  assert.equal(await findChurch({}, 'some-church'), 'unavailable');
});

test('a staff session only counts for its own church', async () => {
  assert.equal(await isStaff(asStaff('a'.repeat(32)), env, 'hope-chapel'), true);
  assert.equal(await isStaff(asStaff('a'.repeat(32)), env, 'other-church'), false);
  assert.equal(await isStaff(asStaff('b'.repeat(32)), env, 'hope-chapel'), false);
  assert.equal(await isStaff(asStaff('a'.repeat(32)), env, 'grace-community'), false);
  assert.equal(await isStaff(new Request('https://api.test/'), env, 'hope-chapel'), false);
  assert.equal(await isStaff(asStaff('short'), env, 'hope-chapel'), false);
});

test('who may call what', () => {
  // Public on every church.
  for (const [m, p] of [['GET', '/api/info'], ['GET', '/api/church'], ['GET', '/api/ministries'], ['POST', '/api/chat'], ['POST', '/api/visits'], ['GET', '/api/visits/abcDEF_123'], ['POST', '/api/visits/abcDEF_123/arrive']]) {
    assert.equal(access(m, p, false), 'public', m + ' ' + p);
    assert.equal(access(m, p, true), 'public', m + ' ' + p);
  }
  // Staff work: open on the demo church (as before), staff on every other church.
  for (const [m, p] of [['GET', '/api/visits'], ['POST', '/api/visits/3/claim'], ['POST', '/api/visits/3/met'], ['GET', '/api/requests'], ['PATCH', '/api/requests/2'], ['GET', '/api/connections'], ['DELETE', '/api/connections/4'], ['DELETE', '/api/requests/5'], ['POST', '/api/events']]) {
    assert.equal(access(m, p, true), 'public', m + ' ' + p);
    assert.equal(access(m, p, false), 'staff', m + ' ' + p);
  }
  // Church setup is staff only, the demo church included.
  assert.equal(access('PUT', '/api/church/content', true), 'staff');
  assert.equal(access('GET', '/api/church/content', false), 'staff');
  // Sermon Notes and the chat log: the API key or that church staff.
  assert.equal(access('GET', '/api/notes', false), 'key-or-staff');
  assert.equal(access('GET', '/api/chat/log/abc', true), 'key-or-staff');
  // The shared AI model setting is not something one church may change for all.
  assert.equal(access('POST', '/api/ai/model', false), 'key');
});

test('the container gets the church from the Worker, never from the browser', () => {
  const spoofed = new Headers({ 'X-Church': 'grace-community', 'X-Church-Name': 'Evil', Authorization: 'Bearer ' + 'a'.repeat(32), 'Content-Type': 'application/json' });
  const out = churchHeaders(spoofed, { slug: 'hope-chapel', name: 'Hope Chapel & Friends', city: 'Austin', demo: false });
  assert.equal(out.get('X-Church'), 'hope-chapel');
  assert.equal(decodeURIComponent(out.get('X-Church-Name')), 'Hope Chapel & Friends');
  assert.equal(out.get('Authorization'), null);
  assert.equal(out.get('Content-Type'), 'application/json');
});

test('church subdomains of BASE_DOMAIN are allowed origins', () => {
  assert.equal(onBaseDomain('https://grace.belong.example.org', 'belong.example.org'), true);
  assert.equal(onBaseDomain('https://belong.example.org', 'belong.example.org'), true);
  assert.equal(onBaseDomain('http://grace.belong.example.org', 'belong.example.org'), false);
  assert.equal(onBaseDomain('https://a.b.belong.example.org', 'belong.example.org'), false);
  assert.equal(onBaseDomain('https://evilbelong.example.org', 'belong.example.org'), false);
  assert.equal(onBaseDomain('https://grace.belong.example.org.evil.test', 'belong.example.org'), false);
  assert.equal(onBaseDomain('https://grace.belong.example.org', ''), false);
});
