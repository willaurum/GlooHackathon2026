// Which church a request is for, and who may call what. Run: node --test api/test/
// (Node 22.18+ loads the TypeScript directly.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { STAFF_SESSION_INVALID, access, churchHeaders, churchPath, findChurch, isStaff, requireStaff, sentStaffToken, onBaseDomain } from '../churches.ts';

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
    if (m) return Response.json({ error: 'no' }, { status: 401 });
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};

// The giving Worker as deployed before this change: no /api/directory and no admin/session route.
const OLDER = { 'hope-church': { slug: 'hope-church', name: 'Hope Church', city: 'Austin' } };
const olderGiving = {
  async fetch(url, init = {}) {
    const path = new URL(url).pathname;
    let m = /^\/api\/churches\/([^/]+)$/.exec(path);
    if (m) return m[1] in OLDER ? Response.json({ ...OLDER[m[1]], funds: [] }) : Response.json({ error: 'Church not found' }, { status: 404 });
    m = /^\/api\/churches\/([^/]+)\/admin$/.exec(path);
    const token = (new Headers(init.headers).get('Authorization') || '').replace('Bearer ', '');
    if (m && m[1] === 'hope-church' && token === 'c'.repeat(32)) return Response.json({ church: { slug: 'hope-church' } });
    if (m) return Response.json({ error: 'no' }, { status: 401 });
    return Response.json({ error: 'Not found' }, { status: 404 });
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

test('an older giving service without /api/directory still finds its churches', async () => {
  const older = { GIVING: olderGiving };
  assert.deepEqual(await findChurch(older, 'hope-church'), { slug: 'hope-church', name: 'Hope Church', city: 'Austin', demo: false });
  assert.equal(await findChurch(older, 'not-a-church-here'), null);
  assert.equal(await isStaff(asStaff('c'.repeat(32)), older, 'hope-church'), true);
  assert.equal(await isStaff(asStaff('d'.repeat(32)), older, 'hope-church'), false);
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
  // Staff work requires a session, including on the demo church.
  for (const [m, p] of [['GET', '/api/visits'], ['POST', '/api/visits/3/claim'], ['POST', '/api/visits/3/met'], ['GET', '/api/requests'], ['PATCH', '/api/requests/2'], ['GET', '/api/connections'], ['DELETE', '/api/connections/4'], ['DELETE', '/api/requests/5'], ['POST', '/api/events']]) {
    assert.equal(access(m, p, true), 'staff', m + ' ' + p);
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


test('visitors can read posts and summaries but cannot publish, approve or regenerate them', () => {
  for (const demo of [true, false]) {
    for (const path of ['/api/blog', '/api/blog/categories', '/api/blog/12', '/api/events', '/api/events/12']) {
      assert.equal(access('GET', path, demo), 'public', path);
    }
    for (const [method, path] of [
      ['POST', '/api/blog'], ['POST', '/api/blog/categorize'], ['POST', '/api/blog/12/summarize'],
      ['POST', '/api/blog/12/approve'], ['PATCH', '/api/blog/12'], ['PUT', '/api/blog/12'],
      ['DELETE', '/api/blog/12'], ['POST', '/api/events/12/summarize'],
      ['POST', '/api/events/summarize-all'], ['POST', '/api/regions/12/prayer-angles'],
    ]) assert.equal(access(method, path, demo), 'staff', method + ' ' + path);
    assert.equal(access('POST', '/api/ai/model', demo), 'key');
    assert.equal(access('POST', '/api/ollama/model', demo), 'key');
  }
});

test('revoked sessions lose access immediately and directory failures deny access', async () => {
  let valid = true;
  const service = { GIVING: { fetch: async () => valid
    ? Response.json({ slug: 'revocation-test' })
    : Response.json({ error: 'Signed out' }, { status: 401 }) } };
  const request = asStaff('r'.repeat(32));
  assert.equal(await isStaff(request, service, 'revocation-test'), true);
  valid = false;
  assert.equal(await isStaff(request, service, 'revocation-test'), false);
  assert.equal(await isStaff(request, { GIVING: { fetch: async () => { throw new Error('Offline'); } } }, 'revocation-test'), 'unavailable');
  assert.equal(await isStaff(request, {}, 'revocation-test'), 'unavailable');
});


test('staff endpoints return 503 on service failure and 401 only for rejected credentials', async () => {
  const request = asStaff('s'.repeat(32));
  for (const fetch of [
    async () => { throw new Error('Offline'); },
    async () => Response.json({ error: 'Unavailable' }, { status: 503 }),
    async () => new Response('bad gateway', { status: 502 }),
    async () => new Response('not json', { status: 200 }),
  ]) {
    const response = await requireStaff(request, { GIVING: { fetch } }, 'hope-chapel');
    assert.equal(response.status, 503);
    assert.match((await response.json()).detail, /unavailable/);
  }
  assert.equal((await requireStaff(request, {}, 'hope-chapel')).status, 503);
  assert.equal((await requireStaff(new Request('https://api.test'), {}, 'hope-chapel')).status, 401);
  const rejected = await requireStaff(request, { GIVING: { fetch: async () => Response.json({}, { status: 401 }) } }, 'hope-chapel');
  assert.equal(rejected.status, 401);
  const wrongChurch = await requireStaff(request, { GIVING: { fetch: async () => Response.json({ slug: 'other-church' }) } }, 'hope-chapel');
  assert.equal(wrongChurch.status, 401);
  assert.equal(await requireStaff(request, { GIVING: { fetch: async () => Response.json({ slug: 'hope-chapel' }) } }, 'hope-chapel'), null);
});

test('a rejected staff session is flagged so the browser drops it; no session sent, no flag', async () => {
  const rejected = { GIVING: { fetch: async () => Response.json({}, { status: 401 }) } };
  const withToken = await requireStaff(asStaff('s'.repeat(32)), rejected, 'hope-chapel');
  assert.equal(withToken.status, 401);
  assert.equal((await withToken.json()).code, STAFF_SESSION_INVALID);
  const without = await requireStaff(new Request('https://api.test'), rejected, 'hope-chapel');
  assert.equal(without.status, 401);
  assert.equal((await without.json()).code, undefined);
  // An outage is never reported as a rejected session.
  const outage = await requireStaff(asStaff('s'.repeat(32)), {}, 'hope-chapel');
  assert.equal((await outage.json()).code, undefined);
  assert.equal(sentStaffToken(asStaff('short')), true);
  assert.equal(sentStaffToken(new Request('https://api.test', { headers: { 'X-API-Key': 'k' } })), false);
});
