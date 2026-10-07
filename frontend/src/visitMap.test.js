import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geocodeAddress, parkingFaq } from './visitMap.js';

test('visit maps cache address lookups and mark city fallback as approximate', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.sessionStorage, calls = [], stored = new Map();
  globalThis.sessionStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  globalThis.fetch = async url => {
    calls.push(new URL(url).searchParams.get('q'));
    return Response.json(calls.length === 1 ? [] : [{ lat: '37.1', lon: '-78.2' }]);
  };
  try {
    const result = await geocodeAddress('123 Fictional Lane, Millbrook, VA 22000');
    assert.deepEqual(result, { center: [37.1, -78.2], approximate: true });
    assert.deepEqual(calls, ['123 Fictional Lane, Millbrook, VA 22000', 'Millbrook, VA']);
    assert.deepEqual(await geocodeAddress('123 Fictional Lane, Millbrook, VA 22000'), result);
    assert.equal(calls.length, 2);
    stored.set('tekton-map:456 Example Lane', JSON.stringify({ center: [37, -78], approximate: false }));
    assert.deepEqual(await geocodeAddress('456 Example Lane'), { center: [37, -78], approximate: false });
    assert.equal(calls.length, 2);
    globalThis.fetch = async () => Response.json([]);
    assert.equal(await geocodeAddress('789 Unmapped Lane'), null);
  } finally { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; }
});

test('parking and accessibility use only matching imported FAQ items', () => {
  for (const text of ['Where do I park?', 'Parking', 'Wheelchair access', 'Accessible entrance', 'Accessibility',
    'Handicap spaces', 'Main entrance', "Kids’ check-in"])
    assert.equal(parkingFaq({ question: text, answer: '' }), true, text);
  assert.equal(parkingFaq({ question: 'How do we arrive?', answer: 'Park by the entrance.' }), true);
  assert.equal(parkingFaq({ question: 'What should I wear?', answer: 'Come as you are.' }), false);
});
