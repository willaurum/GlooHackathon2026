import assert from 'node:assert/strict';
import test from 'node:test';
import { setApiChurch } from './api.js';
import { createFromDraft, draftApi } from './builderApi.js';
import { getVerifiedStaffToken } from './church.js';

const storage = new Map();
globalThis.sessionStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};

test('public drafts use the bare API without staff credentials or the current church', async () => {
  const originalFetch = globalThis.fetch;
  setApiChurch('missing-church');
  storage.set('belong-staff:missing-church', 'fake-staff-token');
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/builder/drafts/draft-id/preview');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['X-API-Key'], undefined);
      return Response.json({ content: { info: { name: 'Hope Chapel' } } });
    };
    assert.equal((await draftApi('/draft-id/preview', { method: 'POST' })).content.info.name, 'Hope Chapel');
    globalThis.fetch = async () => Response.json({ detail: 'Answer the open questions first.' }, { status: 400 });
    await assert.rejects(draftApi('/draft-id/preview', { method: 'POST' }), error => error.status === 400 && /open questions/.test(error.message));
  } finally { globalThis.fetch = originalFetch; storage.clear(); }
});

test('signup installs staff access; a failed apply retries only into the created church', async () => {
  const originalFetch = globalThis.fetch;
  const account = { name: 'Hope Chapel', city: 'Austin', ownerName: 'Alex Example', ownerEmail: 'alex@example.org', password: 'obviously-fake-password' };
  const token = 'fake_builder_staff_token_12345678';
  let created = null, signups = 0, applies = 0;
  setApiChurch('other-church');
  try {
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/api/health')) return Response.json({ churches: true });
      if (url.endsWith('/api/churches')) {
        signups++;
        assert.deepEqual(JSON.parse(options.body), account);
        return Response.json({ slug: 'hope-chapel', name: 'Hope Chapel', token }, { status: 201 });
      }
      assert.equal(url, '/api/churches/hope-chapel/builder/drafts/draft-id/apply');
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      assert.equal(options.method, 'POST');
      assert.equal(created.slug, 'hope-chapel');
      applies++;
      return applies === 1 ? Response.json({ detail: 'Content service unavailable.' }, { status: 503 })
        : Response.json({ church: 'hope-chapel', content: { info: { name: 'Hope Chapel' } } });
    };
    await assert.rejects(createFromDraft('draft-id', account, null, target => { created = target; }), /Content service unavailable/);
    assert.equal(getVerifiedStaffToken('hope-chapel'), token);
    // Reload recovery stores the slug and draft id; the existing staff storage supplies the token.
    const result = await createFromDraft('draft-id', null, { slug: created.slug, draftId: created.draftId }, () => assert.fail('Must not sign up twice'));
    assert.equal(result.church, 'hope-chapel');
    assert.equal(signups, 1);
    assert.equal(applies, 2);
  } finally { globalThis.fetch = originalFetch; storage.clear(); }
});

test('giving errors are surfaced before any apply or target is recorded', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      assert.ok(url.endsWith('/api/churches'));
      return Response.json({ error: 'Too many new churches. Try later.' }, { status: 429 });
    };
    await assert.rejects(createFromDraft('draft-id', {}, null, () => assert.fail('Signup failed')), /Too many new churches/);
  } finally { globalThis.fetch = originalFetch; }
});
