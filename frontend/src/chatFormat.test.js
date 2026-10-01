import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReply, inline } from './chatFormat.js';

test('bold and italic become segments instead of literal asterisks', () => {
  assert.deepEqual(inline('**Serve Day** is *fun*'), [
    { text: 'Serve Day', bold: true }, { text: ' is ' }, { text: 'fun', italic: true }]);
  assert.deepEqual(inline('2 * 3 and a*b'), [{ text: '2 * 3 and a*b' }]);
});

test('bulleted replies become a paragraph and one list', () => {
  const reply = 'Here are the next big things:\n\n- **Discover Grace class** – First Sunday\n\n- **Serve Day** – Saturday\n---\nSee you there!';
  assert.deepEqual(formatReply(reply), [
    { type: 'p', segments: [{ text: 'Here are the next big things:' }] },
    { type: 'ul', items: [
      [{ text: 'Discover Grace class', bold: true }, { text: ' – First Sunday' }],
      [{ text: 'Serve Day', bold: true }, { text: ' – Saturday' }]] },
    { type: 'p', segments: [{ text: 'See you there!' }] },
  ]);
});

test('numbered lists, headings, and plain lines', () => {
  assert.deepEqual(formatReply('## Times\n1. 9:00am\n2) 11:00am'), [
    { type: 'p', segments: [{ text: 'Times', bold: true }] },
    { type: 'ol', items: [[{ text: '9:00am' }], [{ text: '11:00am' }]] },
  ]);
  assert.deepEqual(formatReply('Line one\nLine two'), [{ type: 'p', segments: [{ text: 'Line one\nLine two' }] }]);
  assert.deepEqual(formatReply(''), []);
});
