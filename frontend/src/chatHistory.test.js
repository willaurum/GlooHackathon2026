import assert from 'node:assert/strict';
import test from 'node:test';
import { chatHistory } from './chatHistory.js';

test('long conversations still send a bounded, user-led payload', () => {
  const messages = Array.from({ length: 61 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `Message ${i}`,
  }));
  const payload = chatHistory(messages);
  assert.ok(payload.length <= 20);
  assert.equal(payload[0].role, 'user');
  assert.equal(payload.at(-1).content, 'Message 60');
  assert.equal(messages.length, 61);
});

test('errors and action metadata are excluded and long replies fit API validation', () => {
  const payload = chatHistory([
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Failed', error: true },
    { role: 'assistant', content: 'a'.repeat(3000), actions: [{ request_id: 1 }] },
    { role: 'user', content: 'Continue' },
  ]);
  assert.equal(payload.length, 3);
  assert.equal(payload[1].content.length, 2000);
  assert.deepEqual(Object.keys(payload[1]), ['role', 'content']);
});
