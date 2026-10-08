import assert from 'node:assert/strict';
import test from 'node:test';
import { isEmail, isEmailOrPhone, isPhone } from './contact.js';

test('emails need a name, one @ and a domain with a real ending', () => {
  for (const ok of ['sam@example.com', 'sam.rivera+serve@church.org.uk', ' pat@grace.church '])
    assert.equal(isEmail(ok), true, ok);
  for (const bad of ['', 'sam', 'sam@', '@example.com', 'sam@example', 'sam@example.c', 'sam @example.com', 'sam@@example.com', 'sam@example.com.'])
    assert.equal(isEmail(bad), false, bad);
});

test('phones have 10 to 15 digits, so international numbers work', () => {
  for (const ok of ['(555) 010-0140', '555-010-0140', '555.010.0140', '5550100140', '+1 (555) 010-0140', '1-555-010-0140',
    '+44 20 7946 0958', '+61 2 9374 4000', '+49 30 901820 12345'])
    assert.equal(isPhone(ok), true, ok);
  for (const bad of ['', '555', '555-0100', '555-010-014', '+44 20 7946', '+1 555 010 0140 0000 00',
    'call me', '(555) 010-0140 ext 2', 'sam@example.com', '555-O1O-0140'])
    assert.equal(isPhone(bad), false, bad);
});

test('email or phone accepts either', () => {
  assert.equal(isEmailOrPhone('sam@example.com'), true);
  assert.equal(isEmailOrPhone('(555) 010-0140'), true);
  assert.equal(isEmailOrPhone('next Sunday'), false);
});
