import assert from 'node:assert/strict';
import test from 'node:test';
import { STAFF_SESSION_INVALID, api, setApiChurch } from './api.js';
import { getStaffToken, getVerifiedStaffToken, setStaffToken } from './church.js';
import { signOutStaff, staffApi, verifyStaffSession } from './giving.js';

const storage = new Map();
globalThis.sessionStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};

test('sign-out revokes the correct church session and keeps other church sessions', async () => {
  setStaffToken('hope-chapel', 'a'.repeat(32));
  setStaffToken('other-church', 'b'.repeat(32));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/api/churches/hope-chapel/admin/logout'));
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(32));
      assert.equal(getStaffToken('hope-chapel'), 'a'.repeat(32));
      return Response.json({ ok: true });
    };
    await signOutStaff('hope-chapel');
    assert.equal(getStaffToken('hope-chapel'), '');
    assert.equal(getStaffToken('other-church'), 'b'.repeat(32));
  } finally { globalThis.fetch = originalFetch; storage.clear(); }
});

test('failed revocation can be retried; an already expired session clears locally', async () => {
  const originalFetch = globalThis.fetch;
  try {
    setStaffToken('hope-chapel', 'a'.repeat(32));
    globalThis.fetch = async () => { throw new TypeError('Offline'); };
    await assert.rejects(signOutStaff('hope-chapel'), /Offline/);
    assert.equal(getStaffToken('hope-chapel'), 'a'.repeat(32));
    globalThis.fetch = async () => Response.json({ error: 'Expired' }, { status: 401 });
    await signOutStaff('hope-chapel');
    assert.equal(getStaffToken('hope-chapel'), '');
  } finally { globalThis.fetch = originalFetch; storage.clear(); }
});


test('a delayed rejection of an old token does not clear a newer sign-in', async () => {
  const originalFetch = globalThis.fetch;
  try {
    setStaffToken('hope-chapel', 'a'.repeat(32));
    globalThis.fetch = async () => {
      setStaffToken('hope-chapel', 'b'.repeat(32));
      return Response.json({ error: 'Old session expired' }, { status: 401 });
    };
    await assert.rejects(staffApi('hope-chapel', '/session'), /Old session expired/);
    assert.equal(getStaffToken('hope-chapel'), 'b'.repeat(32));
  } finally { globalThis.fetch = originalFetch; storage.clear(); }
});


test('server-issued tokens retain verified access during rotation; restored tokens require validation', () => {
  setStaffToken('hope-chapel', 'a'.repeat(32), { verified: true });
  assert.equal(getVerifiedStaffToken('hope-chapel'), 'a'.repeat(32));
  setStaffToken('hope-chapel', 'b'.repeat(32), { verified: true });
  assert.equal(getVerifiedStaffToken('hope-chapel'), 'b'.repeat(32));
  setStaffToken('hope-chapel', 'c'.repeat(32));
  assert.equal(getVerifiedStaffToken('hope-chapel'), '');
  setStaffToken('hope-chapel', 'd'.repeat(32), { verified: true });
  setStaffToken('hope-chapel', '');
  assert.equal(getVerifiedStaffToken('hope-chapel'), '');
});

test('church API: only the explicit rejected-session code drops the token, not any 401', async () => {
  const originalFetch = globalThis.fetch;
  let reply;
  try {
    setApiChurch('hope-chapel');
    setStaffToken('hope-chapel', 'a'.repeat(32));
    globalThis.fetch = async url => url.endsWith('/api/health') ? Response.json({ churches: true }) : reply();
    // A missing API key (Sermon Notes, the AI model setting) is a 401 that must keep valid staff signed in.
    reply = () => Response.json({ detail: 'Missing or invalid API key' }, { status: 401 });
    await assert.rejects(api('/ai/model', { method: 'POST' }), err => err.status === 401);
    assert.equal(getStaffToken('hope-chapel'), 'a'.repeat(32));
    // Sermon Notes rejecting a revoked session keeps its own message but carries the code.
    reply = () => Response.json({ detail: 'Missing or invalid API key', code: STAFF_SESSION_INVALID }, { status: 401 });
    await assert.rejects(api('/notes'), /Missing or invalid API key/);
    assert.equal(getStaffToken('hope-chapel'), '');
  } finally { globalThis.fetch = originalFetch; setApiChurch('grace-community'); storage.clear(); }
});

test('old giving services validate via the overview; outage keeps the token', async () => {
  const originalFetch = globalThis.fetch;
  try {
    setStaffToken('hope-chapel', 'a'.repeat(32));
    globalThis.fetch = async url => url.endsWith('/session')
      ? Response.json({}, { status: 404 }) : Response.json({ church: { slug: 'hope-chapel' } });
    assert.equal(await verifyStaffSession('hope-chapel'), true);
    globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 });
    await assert.rejects(verifyStaffSession('hope-chapel'), /Unavailable/);
    assert.equal(getStaffToken('hope-chapel'), 'a'.repeat(32));
  } finally { globalThis.fetch = originalFetch; setStaffToken('hope-chapel', ''); storage.clear(); }
});
