import assert from 'node:assert/strict';
import test from 'node:test';
import { getStaffToken, setStaffToken } from './church.js';
import { signOutStaff, staffApi } from './giving.js';

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
