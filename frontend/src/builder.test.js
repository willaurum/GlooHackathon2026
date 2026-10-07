import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderEvidence, builderPage, builderValue, canReviewBuilder } from './builder.js';

test('review requires resolved fields and no questions, even if the session says review', () => {
  const session = { status: 'review', questions: [], fields: { services: { status: 'conflict', value: [{ day: 'Sunday', time: '09:00' }] } } };
  assert.equal(canReviewBuilder(session), false);
  session.fields.services.status = 'missing';
  assert.equal(canReviewBuilder(session), false);
  session.fields.services.status = 'confirmed';
  assert.equal(canReviewBuilder(session), true);
  session.fields.name = { status: 'prefilled', value: 'Harborlight' };
  assert.equal(canReviewBuilder(session), true);
  session.questions = [{ field: 'phone', kind: 'conflict' }];
  assert.equal(canReviewBuilder(session), false);
  session.questions = [];
  session.status = 'clarifying';
  assert.equal(canReviewBuilder(session), false);
  assert.equal(canReviewBuilder(null), false);
});

test('phone and service values format for display and editable services text', () => {
  assert.equal(builderValue('phone', '5550194433'), '(555) 019-4433');
  const services = [{ day: 'Sunday', time: '09:00' }, { day: 'Sunday', time: '11:00' }];
  assert.equal(builderValue('services', services), 'Sunday 9:00 AM, Sunday 11:00 AM');
  assert.equal(services[0].time, '09:00');
  assert.equal(builderValue('services', [{ day: 'Monday', time: '00:05' }, { day: 'Wednesday', time: '12:00' }, { day: 'Friday', time: '19:30' }]), 'Monday 12:05 AM, Wednesday 12:00 PM, Friday 7:30 PM');
  assert.equal(builderValue('services', [{ day: 'Sunday', time: '9:00 AM' }]), 'Sunday 9:00 AM');
  assert.equal(builderValue('services', []), '');
  assert.equal(builderValue('name', null), '');
});

test('source evidence resolves candidate claim IDs and preserves exact quotes once per page', () => {
  const quote = 'Come worship with us Sundays 9 & 11.\nEveryone is welcome.';
  const session = {
    fields: { services: { candidates: [{ claim_ids: ['c1', 'c2'] }] } },
    sources: [{ id: 's1', url: 'https://church.test/', title: 'Welcome' }, { id: 's2', url: 'https://church.test/news', title: 'News' }],
    claims: [
      { id: 'c1', field: 'services', source_id: 's1', quote },
      { id: 'c2', field: 'services', source_id: 's1', quote },
      { id: 'c3', field: 'services', source_id: 's2', quote: 'An older time' },
      { id: 'c4', field: 'phone', source_id: 's1', quote: '555.019.4433' },
    ],
  };
  const evidence = builderEvidence(session, 'services');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].quote, quote);
  assert.equal(evidence[0].title, 'Welcome');
  assert.equal(evidence[0].url, 'https://church.test/');
  session.fields.services.candidates = [];
  assert.equal(builderEvidence(session, 'services').length, 2);
});

test('embedded evidence works without claims, with title or URL path as the page label', () => {
  const item = { source_id: 's1', url: 'https://church.test/contact.html', quote: 'Email us.' };
  const session = { fields: { email: { candidates: [{ evidence: [item, { ...item }] }] } } };
  assert.deepEqual(builderEvidence(session, 'email'), [item]);
  assert.equal(builderPage(item), '/contact.html');
  assert.equal(builderPage({ ...item, title: 'Contact HLC' }), 'Contact HLC');
  assert.equal(builderPage({ url: 'https://church.test/' }), 'church.test');
  assert.equal(builderPage({}), 'Website page');
});

test('file evidence keeps the filename and quote without a page URL', () => {
  const source = { id: 's1', kind: 'file', url: null, title: 'bulletin.txt' };
  const quote = 'Sunday worship at 9am.';
  const session = {
    fields: { services: { candidates: [{ claim_ids: ['c1'] }] } }, sources: [source],
    claims: [{ id: 'c1', source_id: 's1', field: 'services', quote }],
  };
  const [evidence] = builderEvidence(session, 'services');
  assert.equal(evidence.url, null);
  assert.equal(evidence.quote, quote);
  assert.equal(builderPage(evidence), 'bulletin.txt');
});
