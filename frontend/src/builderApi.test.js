import assert from 'node:assert/strict';
import test from 'node:test';
import { setApiChurch } from './api.js';
import { createBlank, createFromDraft, createFromFiles, draftApi, itemApi, pollDraft } from './builderApi.js';
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

test('blank drafts and file uploads use public routes and preserve multipart boundaries', async () => {
  const originalFetch = globalThis.fetch;
  setApiChurch('missing-church');
  const file = new File(['Sunday worship at 9am'], 'bulletin.txt', { type: 'text/plain' });
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, 'POST');
      if (url.endsWith('/blank')) {
        assert.equal(url, '/api/builder/drafts/blank');
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({ id: 'blank-draft', sources: [], claims: [] }, { status: 201 });
      }
      assert.equal(url, '/api/builder/drafts/upload');
      assert.equal(options.headers, undefined);
      assert.ok(options.body instanceof FormData);
      const uploaded = options.body.getAll('files');
      assert.equal(uploaded.length, 2);
      assert.equal(uploaded[0].name, file.name);
      assert.equal(await uploaded[0].text(), await file.text());
      assert.equal(uploaded[1].name, 'welcome.html');
      return Response.json({ id: 'file-draft' }, { status: 201 });
    };
    assert.equal((await createBlank()).id, 'blank-draft');
    assert.equal((await createFromFiles([file, new File(['<p>Welcome</p>'], 'welcome.html')])).id, 'file-draft');
    globalThis.fetch = async () => Response.json({ detail: 'Each file must be 5 MB or smaller.' }, { status: 400 });
    await assert.rejects(createFromFiles([file]), error => error.status === 400 && /5 MB/.test(error.message));
    await assert.rejects(createBlank(), error => error.status === 400);
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

test('only a signup 403 is marked as closed registration', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: 'Public church registration is not available on this site.' }, { status: 403 });
    await assert.rejects(createFromDraft('draft-id', {}, null, () => assert.fail('Signup failed')),
      error => error.status === 403 && error.registrationClosed === true);
    globalThis.fetch = async url => url.endsWith('/api/health') ? Response.json({ churches: true })
      : Response.json({ detail: 'Apply was refused.' }, { status: 403 });
    await assert.rejects(createFromDraft('draft-id', null, { slug: 'harborlight', token: 'test-token' }, () => {}),
      error => error.status === 403 && !error.registrationClosed && error.message === 'Apply was refused.');
  } finally { globalThis.fetch = originalFetch; }
});

test('a background import is polled until it is ready, retrying a dropped connection', async () => {
  const originalFetch = globalThis.fetch;
  const answers = [{ status: 'importing', progress: { pages_read: 1 } }, 'drop', { status: 'importing', progress: { pages_read: 5 } }, { status: 'review', id: 'd' }];
  const seen = [];
  try {
    globalThis.fetch = async url => {
      assert.equal(url, '/api/builder/drafts/draft-id');
      const next = answers.shift();
      if (next === 'drop') return Response.json({ detail: 'Bad gateway' }, { status: 502 });
      return Response.json(next);
    };
    const done = await pollDraft('draft-id', draft => seen.push(draft.status), { interval: 1 });
    assert.equal(done.status, 'review');
    assert.deepEqual(seen, ['importing', 'importing', 'review']);
    globalThis.fetch = async () => Response.json({ detail: 'Builder draft not found' }, { status: 404 });
    await assert.rejects(pollDraft('draft-id', () => {}, { interval: 1 }), error => error.status === 404);
    globalThis.fetch = async () => Response.json({ detail: 'down' }, { status: 502 });
    await assert.rejects(pollDraft('draft-id', () => {}, { interval: 1, retries: 1 }), error => error.status === 502);
    const controller = new AbortController();
    const stopped = pollDraft('draft-id', () => {}, { interval: 50, signal: controller.signal });
    controller.abort();
    await assert.rejects(stopped, error => error.name === 'AbortError');
  } finally { globalThis.fetch = originalFetch; }
});

test('list edits go to the public items route', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/builder/drafts/draft-id/items');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { collection: 'staff', id: 'staff-1', include: true });
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({ id: 'draft-id', collections: {} });
    };
    assert.equal((await itemApi('draft-id', { collection: 'staff', id: 'staff-1', include: true })).id, 'draft-id');
  } finally { globalThis.fetch = originalFetch; }
});
