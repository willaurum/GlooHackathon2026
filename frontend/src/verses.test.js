import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_VERSIONS, fetchVerse, fetchVersions, pickVersion, verseCacheKey, versionLabel } from './verses.js';

globalThis.sessionStorage = { getItem: () => null };
const JOHN = { usfm: 'JHN.3.16', human: 'John 3:16' };

/** Runs `fn` with fetch answering from `routes` (path prefix to body, or a status number) and returns the URLs asked for. */
async function withFetch(routes, fn) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async input => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix));
    if (!hit) return new Response('{}', { status: 404 });
    return typeof hit[1] === 'number' ? new Response('{}', { status: hit[1] }) : Response.json(typeof hit[1] === 'function' ? hit[1](url) : hit[1]);
  };
  try { await fn(); } finally { globalThis.fetch = original; }
  return calls;
}

test('verse cache keys include the version', () => {
  assert.equal(verseCacheKey('JHN.3.16'), 'default|JHN.3.16');
  assert.equal(verseCacheKey('JHN.3.16', '111'), '111|JHN.3.16');
  assert.notEqual(verseCacheKey('JHN.3.16', 'kjv'), verseCacheKey('JHN.3.16', 'web'));
});

test('each version is fetched once and kept apart', async () => {
  const calls = await withFetch({
    '/api/verse?': url => {
      const v = new URL(url, 'https://x.test').searchParams.get('version') || '3034';
      return { reference: 'John 3:16', text: 'text in ' + v, version: { id: v, abbreviation: 'V' + v, title: 'T', copyright: 'C' }, link: 'L' };
    },
  }, async () => {
    assert.equal((await fetchVerse(JOHN)).text, 'text in 3034');
    assert.equal((await fetchVerse(JOHN, '111')).text, 'text in 111');
    assert.equal((await fetchVerse(JOHN, '111')).text, 'text in 111');
    assert.equal((await fetchVerse(JOHN)).text, 'text in 3034');
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith('/api/verse?usfm=JHN.3.16'));
  assert.ok(calls[1].endsWith('/api/verse?usfm=JHN.3.16&version=111'));
});

test('when the API fails, KJV falls back to KJV and anything else to WEB, labeled with what came back', async () => {
  const ref = { usfm: 'ROM.8.28', human: 'Romans 8:28' };
  let kjv, other;
  const calls = await withFetch({ '/api/verse': 502, 'bible-api.com': { reference: 'Romans 8:28', text: ' And we know\n ' } }, async () => {
    kjv = await fetchVerse(ref, 'kjv');
    other = await fetchVerse(ref, '111');
  });
  assert.deepEqual(kjv.version, { id: 'kjv', abbreviation: 'KJV', title: 'King James Version', copyright: 'Public domain' });
  assert.equal(kjv.link, 'https://www.bible.com/bible/1/ROM.8.28.KJV');
  assert.equal(kjv.fallback, false);
  assert.equal(kjv.text, 'And we know');
  assert.equal(other.version.abbreviation, 'WEB');
  assert.equal(other.fallback, true);
  assert.equal(other.requested, '111');
  assert.ok(calls.some(u => u.endsWith('translation=kjv')) && calls.some(u => u.endsWith('translation=web')));
});

test('the version list comes from the API, or the public-domain ones when it fails', async () => {
  const listed = { default: '3034', versions: [{ id: '3034', abbreviation: 'BSB', title: 'Berean Standard Bible', source: 'youversion' }] };
  await withFetch({ '/api/verse/versions': 500 }, async () => {
    assert.equal(await fetchVersions(), BUILT_IN_VERSIONS);
  });
  // A failure is not remembered, so the next call asks again.
  await withFetch({ '/api/verse/versions': listed }, async () => {
    assert.deepEqual(await fetchVersions(), listed);
  });
  assert.deepEqual(BUILT_IN_VERSIONS.versions.map(v => v.id), ['web', 'kjv']);
});

test('version labels and picking a saved version', () => {
  assert.equal(versionLabel({ abbreviation: 'BSB', title: 'Berean Standard Bible', source: 'youversion' }), 'Berean Standard Bible (BSB)');
  assert.equal(versionLabel(BUILT_IN_VERSIONS.versions[1]), 'King James Version (KJV, public domain)');
  const list = { default: '3034', versions: [{ id: '3034' }, { id: 'kjv' }] };
  assert.equal(pickVersion(list, 'kjv'), 'kjv');
  assert.equal(pickVersion(list, ''), '3034');
  assert.equal(pickVersion(list, '111'), '3034');
});
