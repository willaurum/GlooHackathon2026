// The YouTube helper handler (api/ythelper.ts). Run: node --test api/test/
import assert from 'node:assert/strict';
import test from 'node:test';
import { YT_HELPER_HOST, ytHelperBridge, ytHelperEnvVars, ytHelperOrigin } from '../ythelper.ts';

const ON = { YT_HELPER_URL: 'https://helper.example.ts.net:8443/', YT_HELPER_KEY: ' ' + 'k'.repeat(64) + '\n' };
const fetchRequest = (body = '{"url":"https://youtu.be/abcdefghijk"}', path = '/fetch', method = 'POST') =>
  new Request(`http://${YT_HELPER_HOST}${path}`, { method, body: method === 'POST' ? body : undefined });

test('the helper is on only with an https URL and a key; the port is kept', () => {
  assert.equal(ytHelperOrigin(ON), 'https://helper.example.ts.net:8443');
  assert.equal(ytHelperOrigin({ YT_HELPER_URL: ON.YT_HELPER_URL }), null);
  assert.equal(ytHelperOrigin({ ...ON, YT_HELPER_KEY: '  ' }), null);
  assert.equal(ytHelperOrigin({ ...ON, YT_HELPER_URL: 'http://helper.example.ts.net' }), null);
  assert.equal(ytHelperOrigin({ ...ON, YT_HELPER_URL: 'https://user:pw@helper.example.ts.net' }), null);
  assert.equal(ytHelperOrigin({ ...ON, YT_HELPER_URL: 'not a url' }), null);
});

test('the container gets the bridge host, never the key or the real URL', () => {
  assert.deepEqual(ytHelperEnvVars(ON), { YT_HELPER_URL: 'http://youtube-helper' });
  assert.deepEqual(ytHelperEnvVars({}), { YT_HELPER_URL: '' });
  assert.ok(!JSON.stringify(ytHelperEnvVars(ON)).includes('kkkk'));
});

test('forwards POST /fetch to the helper with the trimmed key and passes the audio through', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mp4' } });
  };
  const res = await ytHelperBridge(fetchRequest(), ON, fetcher);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'audio/mp4');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://helper.example.ts.net:8443/fetch');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + 'k'.repeat(64));
  assert.equal(new TextDecoder().decode(calls[0].init.body), '{"url":"https://youtu.be/abcdefghijk"}');
});

test('only POST /fetch is forwarded, and the body is small', async () => {
  let called = false;
  const fetcher = async () => { called = true; return new Response('x'); };
  assert.equal((await ytHelperBridge(fetchRequest(undefined, '/health', 'GET'), ON, fetcher)).status, 404);
  assert.equal((await ytHelperBridge(fetchRequest('{}', '/other'), ON, fetcher)).status, 404);
  assert.equal((await ytHelperBridge(fetchRequest('x'.repeat(5000)), ON, fetcher)).status, 413);
  assert.equal(called, false);
});

test('not set up is 503 and an unreachable helper is 502, so the backend falls back', async () => {
  const off = await ytHelperBridge(fetchRequest(), {}, async () => new Response('x'));
  assert.equal(off.status, 503);
  assert.equal((await off.json()).error, 'helper_not_configured');
  const down = await ytHelperBridge(fetchRequest(), ON, async () => { throw new TypeError('connect failed'); });
  assert.equal(down.status, 502);
  assert.equal((await down.json()).error, 'helper_offline');
});
