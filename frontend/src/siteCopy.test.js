import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATALOG, copyText } from './siteCopy.js';

test('the catalog is the same as the backend copy', () => {
  const backend = readFileSync(new URL('../../backend/app/site_copy.json', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('./data/siteCopy.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(frontend), JSON.parse(backend));
  assert.equal(frontend, backend);
});

test('every catalog entry has a page, label, default and max', () => {
  for (const [key, entry] of Object.entries(CATALOG)) {
    assert.equal(typeof entry.page, 'string', key);
    assert.ok(entry.label && entry.default, key);
    assert.ok(entry.max >= entry.default.length, key);
    assert.doesNotMatch(entry.label + entry.default, /—/, key);
  }
});

test('copyText gives the church wording, else the default, with the church name', () => {
  assert.equal(copyText(null, 'home.serve_title', 'Hope'), 'Serve');
  assert.equal(copyText({ copy: { 'home.serve_title': 'Volunteer' } }, 'home.serve_title'), 'Volunteer');
  assert.equal(copyText({ copy: { 'home.serve_title': '' } }, 'home.serve_title'), 'Serve');
  assert.equal(copyText({}, 'header.about.text', 'Hope Chapel'), 'The story, the people and the heart behind Hope Chapel.');
  assert.equal(copyText({ copy: { 'footer.tagline': 'Welcome to {name}.' } }, 'footer.tagline', 'Hope'), 'Welcome to Hope.');
  assert.equal(copyText({ copy: { 'not.a.key': 'x' } }, 'not.a.key'), '');
});
