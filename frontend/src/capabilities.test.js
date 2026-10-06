// Its own file so the capability cache starts empty (node --test runs each file in a fresh process).
import assert from 'node:assert/strict';
import test from 'node:test';
import { churchCapabilities } from './api.js';

globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

test('church API health: an error response is reported unavailable, not cached as "no church support"', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ detail: 'Temporarily unavailable' }, { status: 503 });
    assert.deepEqual(await churchCapabilities(), { churches: false, unavailable: true });
    globalThis.fetch = async () => { throw new TypeError('Offline'); };
    assert.deepEqual(await churchCapabilities(), { churches: false, unavailable: true });
    globalThis.fetch = async () => Response.json({ churches: true });
    assert.deepEqual(await churchCapabilities(), { churches: true });
  } finally { globalThis.fetch = originalFetch; }
});
