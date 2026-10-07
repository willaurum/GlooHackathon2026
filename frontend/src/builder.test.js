import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDER_LISTS, builderEvidence, builderImportProgress, builderItem, builderListCounts, builderPage, builderValue, canReviewBuilder } from './builder.js';

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

test('imported list entries show a title and a one-line detail', () => {
  assert.deepEqual(builderItem('events', { name: 'Coat Drive', date: '2030-01-18', time: '10:00 AM', location: 'Fellowship Hall' }),
    { title: 'Coat Drive', detail: 'Jan 18, 2030 · 10:00 AM · Fellowship Hall' });
  assert.deepEqual(builderItem('events', { name: 'Bible Study', when: 'Weekly on Wednesday' }), { title: 'Bible Study', detail: 'Weekly on Wednesday' });
  assert.deepEqual(builderItem('staff', { name: 'Ruth', role: 'Lead Pastor', email: 'ruth@example.org' }), { title: 'Ruth', detail: 'Lead Pastor · ruth@example.org' });
  assert.deepEqual(builderItem('sermons', { title: 'Neighbors', date: '2029-12-22', speaker: 'Ruth' }), { title: 'Neighbors', detail: 'Dec 22, 2029 · Ruth' });
  assert.equal(builderItem('groups', {}).title, 'Untitled');
});

test('list counts follow the review order and skip empty lists', () => {
  const session = { collections: { staff: [{ include: true }, { include: false }], events: [{ include: true }], sermons: [] } };
  assert.deepEqual(builderListCounts(session).map(l => [l.key, l.included, l.total]), [['events', 1, 1], ['staff', 1, 2]]);
  assert.deepEqual(builderListCounts(null), []);
  assert.deepEqual(BUILDER_LISTS.map(l => l.key), ['events', 'ministries', 'groups', 'staff', 'locations', 'sermons']);
});

test('import progress reads the job stage', () => {
  assert.equal(builderImportProgress({ progress: { stage: 'starting', pages_read: 0 } }), 'Reading your website…');
  assert.equal(builderImportProgress({ progress: { stage: 'reading', pages_read: 4, pages_found: 30 } }), 'Reading your website… 4 of 30 pages read so far.');
  assert.match(builderImportProgress({ progress: { stage: 'extracting', pages_read: 12 } }), /^Read 12 pages/);
});

test('imported website parts read as one line each, and the menu as indented lines', async () => {
  const { SITE_PARTS, sitePartItem, siteMenuLines } = await import('./builder.js');
  assert.deepEqual(SITE_PARTS.map(p => p.key), ['pages', 'links', 'forms', 'media', 'assets']);
  assert.deepEqual(sitePartItem('pages', { title: 'Our Team - Harvest Point Church', path: '/team', section_count: 4, in_menu: true }),
    { title: 'Our Team - Harvest Point Church', detail: '/team · 4 sections · in the menu' });
  assert.deepEqual(sitePartItem('links', { text: 'RSVP', kind: 'form', provider: 'Evite', context: 'Fall Festival' }),
    { title: 'RSVP', detail: 'Sign-up · Evite · under “Fall Festival”' });
  assert.deepEqual(sitePartItem('forms', { fields: [{ label: 'Your name' }, { label: 'Email' }], submit: 'Send' }),
    { title: 'Form', detail: 'Your name, Email · button “Send”' });
  assert.deepEqual(sitePartItem('assets', { role: 'logo', alt: 'Harvest Point' }), { title: 'Logo', detail: 'Harvest Point' });
  assert.deepEqual(siteMenuLines({ main: [{ label: 'About', url: '', page_id: '', children: [{ label: 'Team', url: 'https://c.test/team', page_id: 's2', children: [] }] },
    { label: 'Groups', url: 'https://x.churchcenter.com/groups', page_id: '', children: [] }] }),
  [{ label: 'About', depth: 0, external: false }, { label: 'Team', depth: 1, external: false }, { label: 'Groups', depth: 0, external: true }]);
});
