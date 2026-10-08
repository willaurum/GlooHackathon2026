// Edit your site: every editor route is that church's staff only. Run: node --test api/test/
// (The Worker's route() needs the Workers runtime, so this checks the two parts it is made of: access() and
// requireStaff(), and the body size it allows.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_EDITOR_DRAFT_BYTES, MAX_IMPORT_BYTES, access, bodyLimit, churchPath, requireStaff } from '../churches.ts';
import { tooLarge } from '../notes.ts';

const TOKENS = { ['a'.repeat(32)]: 'hope-chapel', ['b'.repeat(32)]: 'other-church' };
const giving = {
  async fetch(url, init = {}) {
    const m = /^\/api\/churches\/([^/]+)\/admin\/session/.exec(new URL(url).pathname);
    const token = (new Headers(init.headers).get('Authorization') || '').replace('Bearer ', '');
    if (m && TOKENS[token] === m[1]) return Response.json({ ok: true, slug: m[1] });
    if (m) return Response.json({ error: 'no' }, { status: 401 });
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
const env = { GIVING: giving };
const request = (token) => new Request('https://api.test/', token ? { headers: { Authorization: 'Bearer ' + token } } : {});

const ROUTES = [
  ['GET', '/api/church/editor'],
  ['PUT', '/api/church/editor/draft'],
  ['DELETE', '/api/church/editor/draft'],
  ['POST', '/api/church/editor/ask'],
  ['POST', '/api/church/editor/publish'],
  ['POST', '/api/church/editor/restore'],
];

test('every editor route is staff only, on every church', () => {
  for (const [method, path] of ROUTES)
    for (const demo of [true, false]) assert.equal(access(method, path, demo), 'staff', `${method} ${path}`);
  // Through a church's own prefix too.
  assert.equal(access('PUT', churchPath('/api/churches/hope-chapel/church/editor/draft').path, false), 'staff');
});

test('other methods and paths under the editor are never public or open to the API key', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    for (const path of ['/api/church/editor', '/api/church/editor/draft', '/api/church/editor/ask', '/api/church/editor/x',
      '/api/church/editor/draft/1', '/api/church/editor/publish/now'])
      for (const demo of [true, false]) assert.equal(access(method, path, demo), 'staff', `${method} ${path}`);
  // The public site and its pages are unchanged.
  assert.equal(access('GET', '/api/church', false), 'public');
  assert.equal(access('GET', '/api/church/pages/editor', false), 'public');
});

test('anonymous callers and other churches are turned away; that church staff get through', async () => {
  for (const [method, path] of ROUTES) {
    assert.equal(access(method, path, false), 'staff');
    const anonymous = await requireStaff(request(), env, 'hope-chapel');
    assert.equal(anonymous.status, 401);
    const otherChurch = await requireStaff(request('b'.repeat(32)), env, 'hope-chapel');
    assert.equal(otherChurch.status, 401);
    const visitor = await requireStaff(request('c'.repeat(32)), env, 'hope-chapel');
    assert.equal(visitor.status, 401);
    assert.equal(await requireStaff(request('a'.repeat(32)), env, 'hope-chapel'), null);
  }
});

test('a draft may be up to 256 KB; the other editor calls keep the usual limit', () => {
  const sized = (method, bytes) => new Request('https://api.test/', { method, headers: { 'Content-Length': String(bytes) } });
  assert.equal(MAX_EDITOR_DRAFT_BYTES, 256 * 1024);
  assert.equal(bodyLimit('PUT', '/api/church/editor/draft'), MAX_EDITOR_DRAFT_BYTES);
  assert.equal(tooLarge(sized('PUT', 200 * 1024), bodyLimit('PUT', '/api/church/editor/draft')), null);
  assert.equal(tooLarge(sized('PUT', 257 * 1024), bodyLimit('PUT', '/api/church/editor/draft')).status, 413);
  for (const [method, path] of [['POST', '/api/church/editor/ask'], ['POST', '/api/church/editor/publish'], ['DELETE', '/api/church/editor/draft']]) {
    assert.equal(bodyLimit(method, path), undefined);
    assert.equal(tooLarge(sized(method, 20 * 1024), bodyLimit(method, path)).status, 413);
  }
  // The content import keeps its own allowance.
  assert.equal(bodyLimit('PUT', '/api/church/content'), MAX_IMPORT_BYTES);
});
