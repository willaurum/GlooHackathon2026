import assert from 'node:assert/strict';
import test from 'node:test';
import { api, apiHeaders, churchCapabilities, gapi, getApiKey, setApiChurch, setApiKey, startApiPreview, stopApiPreview } from './api.js';
import { DEMO_CHURCH } from './church.js';

globalThis.sessionStorage = { getItem: () => null };
const snapshot = {
  info: { name: 'Harborlight Chapel', services: [{ day: 'Sunday', time: '9:00 AM' }] },
  church: { info: { name: 'Harborlight Chapel' }, faqs: [], events: [] },
  ministries: [{ id: 1, name: 'Welcome' }], events: [],
};
const message = 'This is a preview. Create your church to use this.';

test('preview reads use the snapshot and empty sections without fetching church data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('Preview reached the network'); };
  try {
    setApiChurch('a-saved-church');
    startApiPreview(snapshot);
    for (const key of ['info', 'church', 'ministries', 'events'])
      assert.deepEqual(await api('/' + key + '?page=1', { method: 'get' }), snapshot[key]);
    for (const path of ['/notes', '/blog', '/regions', '/news']) assert.deepEqual(await api(path), []);
    assert.deepEqual(await churchCapabilities(), { churches: true });
    await assert.rejects(api('/visits/unknown'), { message });
    await assert.rejects(gapi('/api/churches/' + DEMO_CHURCH), { message });
    const info = await api('/info');
    info.name = 'Changed locally';
    assert.equal((await api('/info')).name, snapshot.info.name);
  } finally { stopApiPreview(); setApiChurch(DEMO_CHURCH); globalThis.fetch = originalFetch; }
});

test('preview writes and raw upload headers throw before any fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('Preview write reached the network'); };
  try {
    startApiPreview(snapshot);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'HEAD']) {
      await assert.rejects(api('/info', { method }), { message });
      await assert.rejects(api('/visits', { method }), { message });
      await assert.rejects(gapi('/api/checkout', { method }), { message });
    }
    await assert.rejects(apiHeaders(), { message });
  } finally { stopApiPreview(); globalThis.fetch = originalFetch; }
});

test('stopping preview restores normal reads and writes for the selected church', async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, options.method || 'GET']);
    return Response.json({ name: 'Normal site' });
  };
  try {
    setApiChurch(DEMO_CHURCH);
    startApiPreview(snapshot);
    assert.deepEqual(await api('/info'), snapshot.info);
    stopApiPreview();
    assert.deepEqual(await api('/info'), { name: 'Normal site' });
    assert.deepEqual(await api('/visits', { method: 'POST', body: '{}' }), { name: 'Normal site' });
    assert.deepEqual(calls, [['/api/info', 'GET'], ['/api/visits', 'POST']]);
  } finally { stopApiPreview(); globalThis.fetch = originalFetch; }
});

test('preview neither reads nor changes the real site key', () => {
  const original = globalThis.sessionStorage, store = new Map([['pastor-notes-api-key', 'real-key']]);
  globalThis.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  try {
    startApiPreview(snapshot);
    assert.equal(getApiKey(), '');
    setApiKey('');
    setApiKey('preview-key');
    stopApiPreview();
    assert.deepEqual([...store], [['pastor-notes-api-key', 'real-key']]);
  } finally { stopApiPreview(); globalThis.sessionStorage = original; }
});
