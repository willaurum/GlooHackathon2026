// Bible versions and passages (api/verse.ts) against a mocked YouVersion and bible-api.com. Run: node --test api/test/
import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from '../churches.ts';
import { DEFAULT_BIBLE_ID, handleVerse, handleVersions } from '../verse.ts';

const ENV = { YOUVERSION_APP_KEY: 'test-key' };
const LISTING = {
  data: [
    { id: 3034, abbreviation: 'BSB', title: 'Berean Standard Bible', language_tag: 'en', copyright: 'BSB copyright line' },
    { id: 111, abbreviation: 'NIV', title: 'New International Version', language_tag: 'en', copyright: 'NIV copyright line' },
  ],
  next_page_token: 'page2',
};
const LISTING_2 = { data: [{ id: 1, abbreviation: 'KJV', title: 'King James Version', language_tag: 'en', copyright: 'Public Domain' }] };
const BIBLES = Object.fromEntries([...LISTING.data, ...LISTING_2.data].map(b => [String(b.id), b]));

/** Fresh Worker cache and fetch mock per test; `fail` names hosts or paths that answer 500. */
function setup({ fail = [] } = {}) {
  const store = new Map();
  globalThis.caches = { default: {
    match: async req => (store.has(req.url) ? new Response(store.get(req.url)) : undefined),
    put: async (req, res) => { store.set(req.url, await res.text()); },
  } };
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: init?.headers });
    if (fail.some(f => url.toString().includes(f))) return new Response('no', { status: 500 });
    if (url.hostname === 'bible-api.com') {
      const t = url.searchParams.get('translation');
      return Response.json({ reference: decodeURIComponent(url.pathname.slice(1)), text: `  ${t} text\n here ` });
    }
    const path = url.pathname.replace('/v1', '');
    if (path === '/bibles') return Response.json(url.searchParams.get('page_token') === 'page2' ? LISTING_2 : LISTING);
    const passage = /^\/bibles\/(\d+)\/passages\/(.+)$/.exec(path);
    if (passage) return Response.json({ reference: passage[2], content: `${BIBLES[passage[1]].abbreviation} text` });
    const bible = /^\/bibles\/(\d+)$/.exec(path);
    if (bible && BIBLES[bible[1]]) return Response.json(BIBLES[bible[1]]);
    return new Response('not found', { status: 404 });
  };
  return { calls, store };
}

const verse = async (query, env = ENV) => {
  const res = await handleVerse(new URL('https://x.test/api/verse?' + query), env);
  return { status: res.status, body: await res.json() };
};
const yvCalls = calls => calls.filter(c => c.url.includes('api.youversion.com'));

test('lists every licensed Bible across pages, then the public-domain ones not already listed', async () => {
  const { calls } = setup();
  const res = await handleVersions(ENV);
  assert.match(res.headers.get('Cache-Control'), /max-age=21600/);
  const body = await res.json();
  assert.equal(body.default, DEFAULT_BIBLE_ID);
  assert.equal(body.listed, true);
  assert.deepEqual(body.versions.map(v => [v.id, v.abbreviation, v.source]), [
    ['3034', 'BSB', 'youversion'], ['111', 'NIV', 'youversion'], ['1', 'KJV', 'youversion'], ['web', 'WEB', 'public-domain'],
  ]);
  assert.deepEqual(Object.keys(body.versions[0]).sort(), ['abbreviation', 'copyright', 'id', 'language', 'source', 'title']);
  // Only the key's own Bibles: never all_available, always the app key header.
  const listing = yvCalls(calls);
  assert.equal(listing.length, 2);
  assert.ok(listing.every(c => !c.url.includes('all_available') && c.url.includes('language_ranges') && c.headers['X-YVP-App-Key'] === 'test-key'));
  // The second call is served from the Worker cache.
  await handleVersions(ENV);
  assert.equal(yvCalls(calls).length, 2);
});

test('a failed listing falls back to the default plus public domain, briefly and uncached', async () => {
  const { store } = setup({ fail: ['/v1/bibles?'] });
  const res = await handleVersions(ENV);
  const body = await res.json();
  assert.equal(body.listed, false);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);
  assert.deepEqual(body.versions.map(v => v.id), ['3034', 'web', 'kjv']);
  assert.equal(store.size, 0);
});

test('without an app key only public-domain versions are offered, defaulting to WEB', async () => {
  const { calls } = setup();
  const body = await (await handleVersions({})).json();
  assert.equal(body.default, 'web');
  assert.deepEqual(body.versions.map(v => v.id), ['web', 'kjv']);
  assert.equal(calls.length, 0);
});

test('a listed version is used, with its own attribution and link', async () => {
  setup();
  const { status, body } = await verse('usfm=JHN.3.16&version=111');
  assert.equal(status, 200);
  assert.equal(body.text, 'NIV text');
  assert.deepEqual(body.version, { id: '111', abbreviation: 'NIV', title: 'New International Version', copyright: 'NIV copyright line' });
  assert.equal(body.link, 'https://www.bible.com/bible/111/JHN.3.16.NIV');
  assert.equal(body.requested, '111');
  assert.equal(body.fallback, false);
});

test('no version, an unlisted id or junk all get the default, and junk never reaches YouVersion', async () => {
  for (const v of ['', '&version=999', '&version=../../bibles', '&version=3034%2Fpassages', '&version=1e3', '&version=__proto__']) {
    const { calls } = setup();
    const { status, body } = await verse('usfm=JHN.3.16' + v);
    assert.equal(status, 200, v);
    assert.equal(body.version.id, DEFAULT_BIBLE_ID, v);
    assert.equal(body.text, 'BSB text', v);
    for (const c of yvCalls(calls)) assert.match(new URL(c.url).pathname, /^\/v1\/bibles(\/3034(\/passages\/JHN\.3\.16)?)?$/, v);
  }
});

test('passages are cached per version and reference', async () => {
  const { calls, store } = setup();
  await verse('usfm=JHN.3.16&version=111');
  await verse('usfm=JHN.3.16&version=3034');
  await verse('usfm=JHN.3.17&version=111');
  const before = yvCalls(calls).length;
  assert.equal((await verse('usfm=JHN.3.16&version=111')).body.text, 'NIV text');
  assert.equal((await verse('usfm=JHN.3.16&version=3034')).body.text, 'BSB text');
  assert.equal(yvCalls(calls).length, before);
  const keys = [...store.keys()].map(k => k.replace('https://verse-cache.internal/', ''));
  for (const k of ['yv/111/JHN.3.16', 'yv/3034/JHN.3.16', 'yv/111/JHN.3.17', 'yv/111/version', 'yv/3034/version']) assert.ok(keys.includes(k), k);
});

test('a public-domain version comes from bible-api.com, labeled as such', async () => {
  const { calls } = setup();
  const { body } = await verse('usfm=JHN.3.16-17&version=KJV');
  assert.equal(body.text, 'kjv text here');
  assert.deepEqual(body.version, { id: 'kjv', abbreviation: 'KJV', title: 'King James Version', copyright: 'Public domain' });
  assert.equal(body.source, 'public-domain');
  assert.equal(body.link, 'https://www.bible.com/bible/1/JHN.3.16-17.KJV');
  assert.equal(yvCalls(calls).length, 0);
  assert.ok(calls.some(c => c.url === 'https://bible-api.com/JHN%203%3A16-17?translation=kjv'));
  // Public-domain text works without a YouVersion key too.
  setup();
  assert.equal((await verse('usfm=PSA.23&version=web', {})).status, 200);
});

test('when YouVersion fails, a public-domain version falls back to itself and others to WEB, and says so', async () => {
  setup({ fail: ['/passages/'] });
  let { body } = await verse('usfm=JHN.3.16&version=1');
  assert.equal(body.fallback, true);
  assert.equal(body.requested, '1');
  assert.equal(body.version.abbreviation, 'KJV');
  assert.equal(body.text, 'kjv text here');
  ({ body } = await verse('usfm=JHN.3.16&version=111'));
  assert.equal(body.fallback, true);
  assert.equal(body.requested, '111');
  assert.deepEqual(body.version, { id: 'web', abbreviation: 'WEB', title: 'World English Bible', copyright: 'Public domain' });
  assert.equal(body.link, 'https://www.bible.com/bible/206/JHN.3.16.WEB');
});

test('KJV from bible-api.com falls back to WEB; when everything fails it is a 502', async () => {
  setup({ fail: ['translation=kjv'] });
  const { body } = await verse('usfm=JHN.3.16&version=kjv');
  assert.equal(body.fallback, true);
  assert.equal(body.version.abbreviation, 'WEB');
  setup({ fail: ['api.youversion.com', 'bible-api.com'] });
  assert.equal((await verse('usfm=JHN.3.16')).status, 502);
});

test('bad references, a missing key and the public route', async () => {
  setup();
  assert.equal((await verse('usfm=JHN.3.16;drop&version=111')).status, 400);
  assert.equal((await verse('usfm=JHN.3.16&version=111', {})).status, 404);
  assert.equal(access('GET', '/api/verse/versions', false), 'public');
  assert.equal(access('GET', '/api/verse', false), 'public');
});
