import assert from 'node:assert/strict';
import test from 'node:test';
import { compactLabels } from './prayerMapLabels.js';

test('labels hide on a narrow map at low zoom only', () => {
  assert.equal(compactLabels(2, 358), true); // a phone at the default fit
  assert.equal(compactLabels(3, 358), true);
  assert.equal(compactLabels(4, 358), false); // zoomed in on a phone
  assert.equal(compactLabels(2, 1000), false); // a wide desktop map
});
